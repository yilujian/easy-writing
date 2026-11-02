import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { flushAppSettings } from '@/storage/app-settings'
import { loadListenBook, loadListenChapterScript } from '@/listening/chapter-source'
import { createTtsEngine, engineSettingsKey } from '@/listening/engine/registry'
import { isAbortError, type TtsEngine, type TtsVoice } from '@/listening/engine/types'
import { readListeningSettings, writeListeningSettings } from '@/storage/listening-settings'
import {
  readListeningPosition,
  resolveResumeSegment,
  saveLastListeningBook,
  saveListeningPosition
} from '@/storage/listening-position'
import { recordListeningDiagnostic } from '@/storage/listening-diagnostics'
import { markChapterFinished, readFinishedChapterIds } from '@/storage/listening-history'
import { setupMediaSessionActions, updateMediaSession } from '@/listening/media-session'
import { clearAudioCache, getAudioCacheStats } from '@/listening/audio-cache'
import { LISTEN_SLEEP_OPTIONS, normalizeListeningSettings } from '@/config/listening'
import type {
  ChapterScript,
  ListenBook,
  ListenChapterRef,
  ListeningPosition,
  ListeningScope,
  ListeningSettings,
  ListenStatus,
  SleepTimerMode
} from '@/types/listening'

const sleepMinutesOf = (mode: SleepTimerMode): number => {
  const option = LISTEN_SLEEP_OPTIONS.find(item => item.value === mode)
  return Number(option?.minutes) || 0
}

export const useListeningStore = defineStore('listening', () => {
  const book = ref<ListenBook | null>(null)
  const chapters = ref<ListenChapterRef[]>([])
  const chapterIndex = ref(-1)
  const script = ref<ChapterScript | null>(null)
  const segmentIndex = ref(0)
  const status = ref<ListenStatus>('idle')
  const error = ref('')
  const settings = ref<ListeningSettings>(readListeningSettings())
  const voices = ref<TtsVoice[]>([])
  const voicesLoading = ref(false)
  const engineAvailable = ref(true)
  const sleepMode = ref<SleepTimerMode>('off')
  const sleepEndsAt = ref(0)
  const sleepRemainingMs = ref(0)
  const cacheBytes = ref(0)
  const cacheCount = ref(0)
  const finishedChapterIds = ref<number[]>([])

  let engine: TtsEngine | null = null
  let engineKey = ''
  let generation = 0
  let bookRequest = 0
  let voicesRequest = 0
  let abortController: AbortController | null = null
  let gapTimer: number | null = null
  let gapResolve: (() => void) | null = null
  let sleepTicker: number | null = null
  let positionTimer: number | null = null
  let restartOnResume = false
  const chapterFinished = ref(false)
  const scope = ref<ListeningScope>('book')

  const currentChapter = computed(() => chapters.value[chapterIndex.value] || null)
  const currentSegment = computed(() => script.value?.segments[segmentIndex.value] || null)
  const totalSegments = computed(() => script.value?.segments.length || 0)
  const isPlaying = computed(() => status.value === 'playing' || status.value === 'buffering')
  const hasSession = computed(() => Boolean(book.value && chapters.value.length))
  const chapterProgress = computed(() => {
    if (!totalSegments.value) return 0
    if (chapterFinished.value) return 1
    // 只计已经读完的句子；定位到最后一句不等于已经听完。
    return Math.min(1, segmentIndex.value / totalSegments.value)
  })
  const bookProgress = computed(() => {
    if (!chapters.value.length) return 0
    // 空章/未统计字数的章按 1 计权，避免整本书进度恒为 0
    const weightOf = (chapter: ListenChapterRef) => Math.max(1, Number(chapter.wordCount) || 0)
    const before = chapters.value
      .slice(0, Math.max(0, chapterIndex.value))
      .reduce((sum, chapter) => sum + weightOf(chapter), 0)
    const total = chapters.value.reduce((sum, chapter) => sum + weightOf(chapter), 0) || 1
    const activeChapter = chapters.value[chapterIndex.value]
    const current = activeChapter ? weightOf(activeChapter) * chapterProgress.value : 0
    return Math.min(1, Math.max(0, (before + current) / total))
  })
  const currentChapterWords = computed(() => currentChapter.value?.wordCount || 0)
  const canPrevChapter = computed(() => scope.value === 'book' && chapterIndex.value > 0)
  const canNextChapter = computed(
    () => scope.value === 'book' && chapterIndex.value >= 0 && chapterIndex.value + 1 < chapters.value.length
  )
  const canPrevSegment = computed(
    () => Boolean(script.value?.segments.length) && (segmentIndex.value > 0 || canPrevChapter.value)
  )
  const canNextSegment = computed(
    () =>
      Boolean(script.value?.segments.length) &&
      (segmentIndex.value + 1 < totalSegments.value || canNextChapter.value)
  )

  const diagnose = (code: string, message: string) => {
    recordListeningDiagnostic({
      at: Date.now(),
      engine: settings.value.engine,
      chapterId: currentChapter.value?.id || 0,
      chars: currentSegment.value?.text.length || 0,
      code,
      message: message.slice(0, 200)
    })
  }

  const ensureEngine = (): TtsEngine => {
    const key = engineSettingsKey(settings.value)
    if (engine && engineKey === key) return engine
    engine?.stop()
    engine = createTtsEngine(settings.value)
    engineKey = key
    return engine
  }

  const refreshVoices = async () => {
    const request = ++voicesRequest
    const requestedKey = engineSettingsKey(settings.value)
    voicesLoading.value = true
    try {
      const active = ensureEngine()
      const available = await active.isAvailable()
      const nextVoices = await active.listVoices()
      if (request !== voicesRequest || requestedKey !== engineSettingsKey(settings.value)) return
      engineAvailable.value = available
      voices.value = nextVoices
      if (settings.value.engine === 'system' && !nextVoices.length) {
        engineAvailable.value = false
        error.value = '系统里没有可用的普通话音色'
      }
      if (settings.value.engine === 'system' && nextVoices.length) {
        const exists = nextVoices.some(voice => voice.id === settings.value.voiceId)
        if (!exists) {
          const preferred =
            nextVoices.find(voice => voice.name === settings.value.voiceName) ||
            nextVoices.find(voice => /^zh/i.test(voice.lang)) ||
            nextVoices[0]
          settings.value = { ...settings.value, voiceId: preferred.id, voiceName: preferred.name }
          writeListeningSettings(settings.value)
        }
      }
      if (!engineAvailable.value && settings.value.engine === 'system') {
        error.value = '当前系统不支持朗读，或没有可用的普通话音色'
      } else if (!engineAvailable.value && settings.value.engine === 'cloud') {
        error.value = settings.value.cloudProfileId
          ? '当前云端语音服务不可用，请在听书设置中检查配置'
          : '还没有配置云端语音服务'
      } else if (engineAvailable.value && /朗读语音|朗读模型|朗读音色|语音服务|普通话音色/.test(error.value)) {
        error.value = ''
      }
    } catch (cause) {
      if (request !== voicesRequest || requestedKey !== engineSettingsKey(settings.value)) return
      engineAvailable.value = false
      voices.value = []
      error.value = cause instanceof Error ? cause.message : '加载朗读音色失败'
    } finally {
      if (request === voicesRequest) voicesLoading.value = false
    }
  }

  const refreshCacheStats = async () => {
    try {
      const stats = await getAudioCacheStats()
      cacheBytes.value = stats.bytes
      cacheCount.value = stats.count
    } catch {
      cacheBytes.value = 0
      cacheCount.value = 0
    }
  }

  const clearCache = async () => {
    try {
      await clearAudioCache()
      await refreshCacheStats()
      return true
    } catch (error) {
      console.warn('清理朗读缓存失败', error)
      await refreshCacheStats()
      return false
    }
  }

  const clearGapTimer = () => {
    if (gapTimer !== null) {
      window.clearTimeout(gapTimer)
      gapTimer = null
    }
    const resolve = gapResolve
    gapResolve = null
    resolve?.()
  }

  const cancelPlayback = () => {
    generation += 1
    clearGapTimer()
    abortController?.abort()
    abortController = null
    engine?.stop()
  }

  const capturePosition = (finished = chapterFinished.value): ListeningPosition | null => {
    const chapter = currentChapter.value
    const currentScript = script.value
    const segment = currentSegment.value
    if (!book.value || !chapter || !currentScript || !segment) return null
    return {
      bookId: String(book.value.id),
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      segmentIndex: segmentIndex.value,
      charOffset: segment.start,
      textLength: currentScript.textLength,
      signature: currentScript.signature,
      snippet: segment.displayText.slice(0, 16),
      updatedAt: Date.now(),
      finished
    }
  }

  const persistCurrentPosition = (finished = chapterFinished.value) => {
    const position = capturePosition(finished)
    if (!position) return
    saveListeningPosition(position)
    void flushAppSettings().catch(() => undefined)
  }

  const schedulePositionSave = () => {
    if (positionTimer !== null) window.clearTimeout(positionTimer)
    positionTimer = window.setTimeout(() => {
      positionTimer = null
      persistCurrentPosition()
    }, 2000)
  }

  const flushPosition = (finished = chapterFinished.value) => {
    if (positionTimer !== null) {
      window.clearTimeout(positionTimer)
      positionTimer = null
    }
    persistCurrentPosition(finished)
  }

  const loadChapter = async (
    index: number,
    options: {
      resume?: ListeningPosition | null
      startSegment?: number
      autoPlay?: boolean
      autoSkipEmpty?: boolean
      skippedEmptyChapters?: number
    } = {}
  ): Promise<void> => {
    const chapter = chapters.value[index]
    if (!chapter) {
      flushPosition()
      cancelPlayback()
      status.value = 'ended'
      return
    }
    // 先保存旧章并清掉延迟写入，避免切章期间把“新章 id + 旧章正文位置”混在一起。
    flushPosition()
    cancelPlayback()
    const token = ++generation
    chapterIndex.value = index
    script.value = null
    segmentIndex.value = 0
    chapterFinished.value = false
    restartOnResume = false
    status.value = 'loading'
    error.value = ''
    try {
      const nextScript = await loadListenChapterScript({
        bookId: book.value!.id,
        chapterId: chapter.id,
        title: chapter.title,
        readTitle: settings.value.readChapterTitle
      })
      if (token !== generation) return
      script.value = nextScript
      chapterFinished.value = Boolean(options.resume?.finished)
      if (!nextScript.segments.length) {
        segmentIndex.value = 0
        const skipped = options.skippedEmptyChapters || 0
        if (options.autoSkipEmpty && skipped < 3 && index + 1 < chapters.value.length) {
          await loadChapter(index + 1, {
            autoPlay: true,
            autoSkipEmpty: true,
            skippedEmptyChapters: skipped + 1
          })
          return
        }
        status.value = 'empty'
        if (options.autoSkipEmpty && index + 1 < chapters.value.length) {
          error.value = '后面连续多章还没有正文，已暂停自动播放'
        }
        return
      }
      const resumed = options.resume ? resolveResumeSegment(nextScript, options.resume) : 0
      segmentIndex.value = Math.min(
        nextScript.segments.length - 1,
        Math.max(0, options.startSegment ?? resumed)
      )
      status.value = 'paused'
      schedulePositionSave()
      if (options.autoPlay) void speakCurrent()
    } catch (cause) {
      if (token !== generation) return
      const message = cause instanceof Error ? cause.message : '加载章节正文失败'
      error.value = message
      status.value = 'error'
      diagnose('load-chapter', message)
    }
  }

  const finishChapter = async (): Promise<void> => {
    abortController?.abort()
    abortController = null
    engine?.stop()
    chapterFinished.value = true
    flushPosition(true)
    if (currentChapter.value) {
      markChapterFinished(book.value?.id || '', currentChapter.value.id)
      if (!finishedChapterIds.value.includes(currentChapter.value.id)) {
        finishedChapterIds.value = [...finishedChapterIds.value, currentChapter.value.id]
      }
    }
    if (scope.value === 'chapter') {
      status.value = 'ended'
      setSleepTimer('off')
      return
    }
    const hasNextChapter = chapterIndex.value + 1 < chapters.value.length
    if (sleepMode.value === 'chapter') {
      status.value = hasNextChapter ? 'paused' : 'ended'
      setSleepTimer('off')
      return
    }
    if (!hasNextChapter) {
      status.value = 'ended'
      return
    }
    if (!settings.value.autoNextChapter) {
      status.value = 'paused'
      return
    }
    const nextIndex = chapterIndex.value + 1
    const endToken = generation
    status.value = 'buffering'
    const gap = settings.value.chapterGapMs
    await new Promise<void>(resolve => {
      gapResolve = resolve
      gapTimer = window.setTimeout(() => {
        gapTimer = null
        gapResolve = null
        resolve()
      }, gap)
    })
    if (endToken !== generation || (status.value as ListenStatus) === 'paused') return
    await loadChapter(nextIndex, { autoPlay: true, autoSkipEmpty: true })
  }

  const speakCurrent = async (reuseController = false): Promise<void> => {
    const chapter = currentChapter.value
    const currentScript = script.value
    const segment = currentSegment.value
    if (!chapter || !currentScript || !segment) {
      status.value = currentScript ? 'ended' : 'idle'
      return
    }
    const token = ++generation
    clearGapTimer()
    if (!reuseController || !abortController || abortController.signal.aborted) {
      abortController?.abort()
      abortController = new AbortController()
    }
    const controller = abortController
    let active: TtsEngine
    try {
      active = ensureEngine()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '朗读引擎不可用'
      error.value = message
      status.value = 'error'
      diagnose('engine', message)
      return
    }
    chapterFinished.value = false
    status.value = settings.value.engine === 'cloud' ? 'buffering' : 'playing'
    error.value = ''
    schedulePositionSave()
    const nextSegment = currentScript.segments[segmentIndex.value + 1]
    if (nextSegment && active.prefetch) {
      void active.prefetch({
        text: nextSegment.text,
        voiceId: settings.value.voiceId,
        voiceName: settings.value.voiceName,
        rate: settings.value.rate,
        pitch: settings.value.pitch,
        volume: settings.value.volume,
        signal: controller.signal
      })
    }
    try {
      await active.speak({
        text: segment.text,
        voiceId: settings.value.voiceId,
        voiceName: settings.value.voiceName,
        rate: settings.value.rate,
        pitch: settings.value.pitch,
        volume: settings.value.volume,
        signal: controller.signal,
        onStart: () => {
          if (token === generation) status.value = 'playing'
        }
      })
      if (token !== generation || !isPlaying.value) return
      flushPosition()
      if (segmentIndex.value >= currentScript.segments.length - 1) {
        await finishChapter()
        return
      }
      segmentIndex.value += 1
      if ((status.value as ListenStatus) === 'paused') return
      await speakCurrent(true)
    } catch (cause) {
      if (token !== generation) return
      if (isAbortError(cause) || (status.value as ListenStatus) === 'paused') return
      const message = cause instanceof Error ? cause.message : '朗读失败'
      error.value = message
      status.value = 'error'
      diagnose('speak', message)
    }
  }

  const openBook = async (
    bookId: string | number,
    chapterId?: number | string | null,
    options: { scope?: ListeningScope; refresh?: boolean } = {}
  ): Promise<boolean> => {
    const request = ++bookRequest
    const id = Number(bookId)
    if (!Number.isFinite(id) || !id) {
      cancelPlayback()
      error.value = '作品不存在'
      status.value = 'error'
      return false
    }
    scope.value = options.scope || 'book'
    const requested = Number(chapterId)
    const hasRequestedChapter = Number.isFinite(requested) && Boolean(requested)
    // 只有“正文已载入且就是当前章”才算已提交；加载失败时 script 为空，不能当成同一章复用。
    const committedScript = script.value
    const committedChapter = currentChapter.value
    const sameCommittedChapter = Boolean(
      committedScript && committedChapter && committedScript.chapterId === committedChapter.id
    )
    if (
      book.value?.id === id &&
      chapters.value.length &&
      (!hasRequestedChapter || requested === currentChapter.value?.id) &&
      sameCommittedChapter &&
      status.value !== 'loading'
    ) {
      if (options.refresh !== false) {
        // 每次重新进入都核对持久化目录和正文；内容未变时保留句内暂停位置。
        const token = generation
        const previousScript = script.value!
        const position = capturePosition()
        try {
          const source = await loadListenBook(id)
          if (request !== bookRequest || token !== generation) return false
          const index = source.chapters.findIndex(chapter => chapter.id === previousScript.chapterId)
          if (index < 0) {
            if (scope.value === 'chapter' && hasRequestedChapter) {
              throw new Error('当前章节已被删除，请重新选择章节')
            }
            // 听书期间作者可能删除当前章或整卷，不能继续展示旧目录/旧正文。
            const fallbackIndex = Math.min(chapterIndex.value, source.chapters.length - 1)
            flushPosition()
            cancelPlayback()
            book.value = source.book
            chapters.value = source.chapters
            finishedChapterIds.value = readFinishedChapterIds(id)
            chapterIndex.value = -1
            script.value = null
            segmentIndex.value = 0
            chapterFinished.value = false
            restartOnResume = false
            if (!source.chapters.length) {
              status.value = 'empty'
              error.value = '这本书还没有章节'
              return false
            }
            await loadChapter(Math.max(0, fallbackIndex))
            return request === bookRequest && totalSegments.value > 0
          }
          const chapter = source.chapters[index]
          const nextScript = await loadListenChapterScript({
            bookId: id,
            chapterId: chapter.id,
            title: chapter.title,
            readTitle: settings.value.readChapterTitle
          })
          if (request !== bookRequest || token !== generation) return false
          const changed =
            previousScript.text !== nextScript.text ||
            previousScript.title !== nextScript.title ||
            previousScript.segments.length !== nextScript.segments.length
          if (changed) {
            flushPosition()
            cancelPlayback()
          }
          book.value = source.book
          chapters.value = source.chapters
          chapterIndex.value = index
          finishedChapterIds.value = readFinishedChapterIds(id)
          if (changed) {
            script.value = nextScript
            segmentIndex.value = position?.finished ? 0 : resolveResumeSegment(nextScript, position)
            chapterFinished.value = false
            restartOnResume = false
            status.value = nextScript.segments.length ? 'paused' : 'empty'
            error.value = ''
            schedulePositionSave()
          }
        } catch (cause) {
          if (request !== bookRequest || token !== generation) return false
          endSession()
          error.value = cause instanceof Error ? cause.message : '刷新朗读正文失败'
          status.value = 'error'
          diagnose('refresh-chapter', error.value)
          return false
        }
      }
      // 已经在这一本/这一章里：保留当前播放，不因为页面重新挂载而从头开始。
      if (status.value === 'idle') status.value = 'paused'
      if (
        scope.value === 'book' &&
        chapterFinished.value &&
        canNextChapter.value &&
        status.value === 'ended'
      ) {
        status.value = 'paused'
      }
      return Boolean(script.value?.segments.length)
    }
    flushPosition()
    cancelPlayback()
    status.value = 'loading'
    error.value = ''
    script.value = null
    segmentIndex.value = 0
    chapterFinished.value = false
    try {
      const source = await loadListenBook(id)
      if (request !== bookRequest) return false
      book.value = source.book
      chapters.value = source.chapters
      chapterIndex.value = -1
      finishedChapterIds.value = readFinishedChapterIds(id)
      saveLastListeningBook(id)
      if (!source.chapters.length) {
        status.value = 'empty'
        error.value = '这本书还没有章节'
        return false
      }
      const position = readListeningPosition(id)
      let targetIndex = 0
      let resume: ListeningPosition | null = null
      if (hasRequestedChapter) {
        const found = source.chapters.findIndex(chapter => chapter.id === requested)
        if (found < 0 && scope.value === 'chapter') throw new Error('当前章节已被删除，请重新选择章节')
        if (found >= 0) {
          targetIndex = found
          // 显式进入已听完章节时从章首开始，避免只读最后一句又结束。
          if (position?.chapterId === requested && !position.finished) resume = position
        }
      } else if (position) {
        const found = source.chapters.findIndex(chapter => chapter.id === position.chapterId)
        if (found >= 0) {
          targetIndex = found
          resume = position
          if (position.finished && found + 1 < source.chapters.length) {
            targetIndex = found + 1
            resume = null
          }
        }
      }
      await loadChapter(targetIndex, { resume })
      if (request !== bookRequest) return false
      if (resume?.finished && targetIndex === source.chapters.length - 1) {
        chapterFinished.value = true
        status.value = 'ended'
      }
      if (
        status.value !== 'ended' &&
        sleepMode.value === 'off' &&
        settings.value.sleepTimerDefault !== 'off'
      ) {
        setSleepTimer(settings.value.sleepTimerDefault)
      }
      await refreshVoices()
      return request === bookRequest && totalSegments.value > 0
    } catch (cause) {
      if (request !== bookRequest) return false
      const message = cause instanceof Error ? cause.message : '打开作品失败'
      endSession()
      error.value = message
      status.value = 'error'
      diagnose('open-book', message)
      return false
    }
  }

  const reloadCurrent = async () => {
    if (!chapters.value.length) {
      if (book.value) await openBook(book.value.id, null, { scope: scope.value })
      return
    }
    await loadChapter(Math.max(0, chapterIndex.value), {
      startSegment: segmentIndex.value,
      autoPlay: false
    })
  }

  const play = async () => {
    if (!script.value) {
      if (!chapters.value.length) return
      await loadChapter(Math.max(0, chapterIndex.value), { autoPlay: true })
      return
    }
    if (status.value === 'ended') {
      await loadChapter(Math.max(0, chapterIndex.value), { autoPlay: true })
      return
    }
    if (status.value === 'empty') return
    if (status.value === 'error') {
      // 朗读失败时重试当前句；只有正文加载失败（script 为空）才需要重新加载章节。
      cancelPlayback()
      void speakCurrent()
      return
    }
    if (status.value === 'paused') {
      if (chapterFinished.value) {
        if (scope.value === 'chapter') {
          await loadChapter(chapterIndex.value, { autoPlay: true })
        } else if (chapterIndex.value + 1 < chapters.value.length) {
          await loadChapter(chapterIndex.value + 1, { autoPlay: true })
        } else {
          status.value = 'ended'
        }
        return
      }
      let active: TtsEngine
      try {
        active = ensureEngine()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '朗读引擎不可用'
        error.value = message
        status.value = 'error'
        diagnose('engine', message)
        return
      }
      if (restartOnResume || !active.resume()) {
        restartOnResume = false
        void speakCurrent()
      } else {
        status.value = 'playing'
      }
      return
    }
    if (!isPlaying.value) void speakCurrent()
  }

  const pause = () => {
    if (status.value === 'loading') {
      cancelPlayback()
      status.value = script.value?.segments.length ? 'paused' : 'idle'
      flushPosition()
      return
    }
    if (!isPlaying.value) return
    // 云端还在合成、章间等待或 audio 尚未开始时没有可暂停的音频：直接中止，
    // 否则异步结果回来会在“已暂停”的状态下突然出声。
    if (status.value === 'buffering') {
      cancelPlayback()
      restartOnResume = !chapterFinished.value
    } else {
      const native = engine?.pause() ?? false
      restartOnResume = !native
    }
    status.value = 'paused'
    flushPosition()
  }

  const suspend = () => {
    // 路由离开/组件卸载必须连尚未完成的开书请求一起失效。
    bookRequest += 1
    if (status.value === 'loading' || isPlaying.value) pause()
    else flushPosition()
  }

  const toggle = () => {
    if (status.value === 'loading' || isPlaying.value) pause()
    else void play()
  }

  const nextSegment = () => {
    if (!script.value) return
    if (segmentIndex.value + 1 >= script.value.segments.length) {
      void nextChapter()
      return
    }
    const wasPlaying = isPlaying.value
    chapterFinished.value = false
    segmentIndex.value += 1
    schedulePositionSave()
    if (wasPlaying) void speakCurrent()
    else {
      cancelPlayback()
      status.value = 'paused'
    }
  }

  const prevSegment = () => {
    if (!script.value) return
    if (segmentIndex.value <= 0) {
      if (!canPrevChapter.value) return
      void loadChapter(chapterIndex.value - 1, {
        startSegment: Number.MAX_SAFE_INTEGER,
        autoPlay: isPlaying.value
      })
      return
    }
    const wasPlaying = isPlaying.value
    chapterFinished.value = false
    segmentIndex.value -= 1
    schedulePositionSave()
    if (wasPlaying) void speakCurrent()
    else {
      cancelPlayback()
      status.value = 'paused'
    }
  }

  const seekSegment = (index: number) => {
    if (!script.value?.segments.length) return
    const wasPlaying = isPlaying.value
    chapterFinished.value = false
    segmentIndex.value = Math.min(
      script.value.segments.length - 1,
      Math.max(0, Math.round(Number(index) || 0))
    )
    schedulePositionSave()
    if (wasPlaying) void speakCurrent()
    else {
      // 云端暂停时 audio 还停在旧句；先停掉，否则再按播放会续播旧音频
      cancelPlayback()
      status.value = 'paused'
    }
  }

  const nextChapter = async () => {
    if (scope.value === 'chapter' || !chapters.value.length) return
    if (chapterIndex.value + 1 >= chapters.value.length) {
      flushPosition()
      cancelPlayback()
      status.value = 'ended'
      return
    }
    const wasPlaying = isPlaying.value
    await loadChapter(chapterIndex.value + 1, { autoPlay: wasPlaying })
  }

  const prevChapter = async () => {
    if (!canPrevChapter.value) return
    const wasPlaying = isPlaying.value
    await loadChapter(chapterIndex.value - 1, { autoPlay: wasPlaying })
  }

  const selectChapter = async (index: number) => {
    if (!chapters.value.length) return
    const wasPlaying = isPlaying.value
    await loadChapter(Math.min(chapters.value.length - 1, Math.max(0, index)), { autoPlay: wasPlaying })
  }

  const setSleepTimer = (mode: SleepTimerMode) => {
    if (sleepTicker !== null) {
      window.clearInterval(sleepTicker)
      sleepTicker = null
    }
    sleepMode.value = mode
    sleepRemainingMs.value = 0
    sleepEndsAt.value = 0
    if (mode === 'off') return
    if (mode === 'chapter') {
      if (chapterFinished.value && status.value === 'buffering') {
        pause()
        sleepMode.value = 'off'
      }
      return
    }
    const minutes = sleepMinutesOf(mode)
    if (!minutes) return
    sleepEndsAt.value = Date.now() + minutes * 60 * 1000
    sleepRemainingMs.value = sleepEndsAt.value - Date.now()
    const tick = () => {
      sleepRemainingMs.value = Math.max(0, sleepEndsAt.value - Date.now())
      if (sleepRemainingMs.value <= 0) {
        if (sleepTicker !== null) window.clearInterval(sleepTicker)
        sleepTicker = null
        sleepMode.value = 'off'
        sleepEndsAt.value = 0
        if (status.value === 'loading' || isPlaying.value) suspend()
      }
    }
    sleepTicker = window.setInterval(tick, 1000)
  }

  const updateSettings = (patch: Partial<ListeningSettings>) => {
    const previous = settings.value
    const next = normalizeListeningSettings({ ...settings.value, ...patch })
    const engineChanged = engineSettingsKey(previous) !== engineSettingsKey(next)
    settings.value = next
    writeListeningSettings(next)
    if (
      previous.autoNextChapter &&
      !next.autoNextChapter &&
      chapterFinished.value &&
      status.value === 'buffering'
    ) {
      pause()
    }
    if (engineChanged) {
      engine?.stop()
      engine = null
      void refreshVoices()
    }
    const scriptStructureChanged = previous.readChapterTitle !== next.readChapterTitle
    if (scriptStructureChanged && script.value && !chapterFinished.value && book.value) {
      const autoPlay = isPlaying.value
      flushPosition()
      const resume = readListeningPosition(book.value.id)
      void loadChapter(chapterIndex.value, { resume, autoPlay })
      return
    }
    const volumeChanged = previous.volume !== next.volume
    const volumeApplied = !volumeChanged || Boolean(engine?.setVolume?.(next.volume))
    const playbackParametersChanged =
      previous.rate !== next.rate ||
      previous.pitch !== next.pitch ||
      previous.voiceId !== next.voiceId ||
      engineChanged
    const pausedParametersChanged = playbackParametersChanged || (volumeChanged && !volumeApplied)
    if (status.value === 'paused' && pausedParametersChanged) {
      engine?.stop()
      restartOnResume = true
    }
    // 章间等待也使用 buffering 状态，但上一章已经完成，设置变化不能把末句重新读一遍。
    if (isPlaying.value && !chapterFinished.value && playbackParametersChanged) {
      void speakCurrent()
    }
  }

  /** 结束本次朗读：按需落盘后，使所有在途开书、切章和播放请求失效。 */
  const endSession = (flush = true) => {
    if (flush && book.value) flushPosition()
    bookRequest += 1
    voicesRequest += 1
    voicesLoading.value = false
    cancelPlayback()
    if (sleepTicker !== null) {
      window.clearInterval(sleepTicker)
      sleepTicker = null
    }
    if (positionTimer !== null) {
      window.clearTimeout(positionTimer)
      positionTimer = null
    }
    sleepMode.value = 'off'
    sleepEndsAt.value = 0
    sleepRemainingMs.value = 0
    book.value = null
    chapters.value = []
    chapterIndex.value = -1
    script.value = null
    segmentIndex.value = 0
    chapterFinished.value = false
    restartOnResume = false
    scope.value = 'book'
    error.value = ''
    finishedChapterIds.value = []
    status.value = 'idle'
  }

  const onVisibilityChange = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') {
      flushPosition()
      return
    }
    if (!sleepEndsAt.value) return
    sleepRemainingMs.value = Math.max(0, sleepEndsAt.value - Date.now())
    if (sleepRemainingMs.value <= 0) {
      if (sleepTicker !== null) window.clearInterval(sleepTicker)
      sleepTicker = null
      sleepMode.value = 'off'
      sleepEndsAt.value = 0
      if (status.value === 'loading' || isPlaying.value) suspend()
    }
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

  // 系统媒体键/锁屏面板是可选项：不支持时这两个函数内部会直接返回
  setupMediaSessionActions({
    play: () => void play(),
    pause,
    next: () => void nextChapter(),
    previous: () => void prevChapter()
  })
  watch(
    [currentChapter, status, book],
    () => {
      updateMediaSession({
        title: currentChapter.value?.title || book.value?.title || '易创听书',
        artist: book.value?.title || '',
        coverUrl: book.value?.coverUrl || '',
        playing: isPlaying.value
      })
    },
    { immediate: true }
  )

  return {
    book,
    chapters,
    chapterIndex,
    script,
    segmentIndex,
    status,
    error,
    settings,
    voices,
    voicesLoading,
    engineAvailable,
    sleepMode,
    sleepEndsAt,
    sleepRemainingMs,
    cacheBytes,
    cacheCount,
    finishedChapterIds,
    chapterFinished,
    scope,
    currentChapter,
    currentSegment,
    totalSegments,
    isPlaying,
    hasSession,
    chapterProgress,
    bookProgress,
    currentChapterWords,
    canPrevChapter,
    canNextChapter,
    canPrevSegment,
    canNextSegment,
    refreshVoices,
    refreshCacheStats,
    clearCache,
    openBook,
    loadChapter,
    reloadCurrent,
    play,
    pause,
    suspend,
    toggle,
    nextSegment,
    prevSegment,
    seekSegment,
    nextChapter,
    prevChapter,
    selectChapter,
    setSleepTimer,
    updateSettings,
    flushPosition,
    endSession
  }
})
