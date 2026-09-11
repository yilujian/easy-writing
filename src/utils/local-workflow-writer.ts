import type { JsonRecord } from '@/types/json'
import type { WorkflowTask } from '@/types/workflow'
import {
  buildChapterBeatsMessages,
  buildChapterContentMessages,
  buildChapterPlanMessages,
} from '@/config/workflow-prompts'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { LOCAL_USER_ID, createLocalEntityId } from '@/storage/local-library-utils'
import type { LocalChapter, LocalLibraryVolume } from '@/storage/local-library-types'
import {
  readLocalWorkflowRun,
  writeLocalWorkflowRun,
  writeLocalWorkflowTask,
  type LocalWorkflowRun,
} from '@/storage/local-workflow'
import { getWritingStorage } from '@/storage'
import { useAiModelStore } from '@/stores/ai-model'
import { parseAiJson } from '@/utils/ai-json'
import {
  NO_MODEL_MESSAGE,
  requestLocalChatCompletion,
  streamLocalChatCompletion,
  LONG_COMPLETION_TIMEOUT_MS,
} from '@/utils/local-ai-client'
import { runLocalChapterQualityCheck } from '@/utils/local-quality-check'
import {
  buildLocalWorkflowEvent,
  emitLocalWorkflowEvent,
  registerLiveLocalTask,
  unregisterLiveLocalTask,
} from '@/utils/local-workflow-runtime'
import { parseChineseWordTarget, resolveRunOutlineUi, resolveRunSettingUi } from '@/utils/local-workflow-book'
import { countWords, countTextWords } from '@/utils/word-count'
import { workflowContentVersion } from '@/utils/workflow-local-draft'
import { promptTemperature } from '@/storage/local-prompts'
import { recordAiChapterLanding } from '@/storage/local-write-stats'

/**
 * 逐章自动生文引擎：一次任务写一卷。
 *
 * 循环骨架：取本卷下一章 →（无细纲先扩细纲）→ 流式写正文 → 落库 → 规则质检
 * → 有硬伤停机等确认，没有就下一章；本卷章纲写完但目标章数没到，就再批量规划一批。
 * 暂停/取消随时打旗，流式中直接掐请求；断点（半章正文）存任务 checkpoint，
 * 恢复时带着已写部分续写。事件走本地总线，页面的 SSE 消费逻辑原样工作。
 */

const TOKEN_EVENT_INTERVAL_MS = 300
const CHECKPOINT_PERSIST_INTERVAL_MS = 2000
const PLAN_BATCH_SIZE = 10
const PREV_CHAPTER_TAIL_CHARS = 600
const DEFAULT_CHAPTER_WORDS = 3000

const asText = (value: unknown) => String(value ?? '').trim()

interface WriterFlags {
  pauseRequested: boolean
  cancelRequested: boolean
  abort: AbortController | null
}

/** 每个活任务一份控制旗；registry 里的句柄只是对它的两个开关 */
const writerFlags = new Map<number, WriterFlags>()


const plainTextRows = (value: string) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/^[ \t\u3000]+|[ \t\u3000]+$/g, ''))
    .filter(line => line.trim())

/** 与编辑器 plainTextToTiptapJson 同构：每行一段 */
const plainTextToDocJson = (value: string) => {
  const rows = plainTextRows(value)
  return {
    type: 'doc',
    content: (rows.length ? rows : ['']).map(line =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    ),
  }
}

/** 生成正文落进本地正文库（与编辑器草稿同键同形），并同步目录字数 */
export const saveGeneratedChapterContent = async (params: {
  bookId: string
  chapterId: number
  title: string
  text: string
  contentVersion: number
}) => {
  const contentJson = plainTextToDocJson(params.text)
  await getWritingStorage().saveChapterLocal({
    userId: LOCAL_USER_ID,
    bookId: params.bookId,
    chapterId: params.chapterId,
    title: params.title,
    textContent: plainTextRows(params.text).join('\n'),
    contentJson,
    localVersion: 0,
    remoteVersion: params.contentVersion,
    baseRemoteVersion: params.contentVersion,
    baseTitle: params.title,
    baseTextContent: plainTextRows(params.text).join('\n'),
    baseContentJson: contentJson,
    dirty: true,
    conflict: false,
    localOnly: true,
    workflowPreview: false,
    updatedAt: Date.now(),
  })
  const wordCount = countWords(params.text)
  await getLocalLibraryStorage().updateLocalChapterContentMeta({
    bookId: params.bookId,
    chapterId: params.chapterId,
    title: params.title,
    wordCount,
  })
  // 码字账本：整章 AI 落稿按基线差记 AI，并抬基线防编辑器落盘双记
  recordAiChapterLanding(params.bookId, params.chapterId, wordCount, countTextWords(params.text))
}

export const readChapterText = async (bookId: string, chapterId: number) => {
  const draft = await getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, bookId, chapterId)
  return { text: draft?.textContent || '', contentVersion: workflowContentVersion(draft), contentJson: draft?.contentJson ?? null, title: draft?.title || '' }
}

export const resolveWorkflowModelCode = async (run: LocalWorkflowRun) => {
  const explicit = asText(run.modelCode || run.config?.modelCode)
  if (explicit) return explicit
  const code = await useAiModelStore().ensureTextModel()
  if (!code) throw new Error(NO_MODEL_MESSAGE)
  return code
}

const resolveChapterTargetWords = (run: LocalWorkflowRun) =>
  parseChineseWordTarget(run.config?.chapterTargetWords) || DEFAULT_CHAPTER_WORDS

// ---------------------------------------------------------------------------
// 提示词素材组装
// ---------------------------------------------------------------------------

const describeRunConfig = (run: LocalWorkflowRun) => {
  const config = (run.config || {}) as JsonRecord
  const lines = [
    ['平台', config.platform],
    ['题材', config.genre],
    ['标签', Array.isArray(config.tags) ? config.tags.join('、') : ''],
    ['叙事人称', config.storyPerspective],
    ['目标读者', config.audience],
    ['核心卖点', config.sellingPoint],
    ['叙事风格', config.narrativeStyle],
    ['文风', config.writingStyle],
    ['核心设定', config.coreSetting],
    ['故事主线', config.storyLine],
  ]
  return lines
    .filter(([, value]) => asText(value))
    .map(([label, value]) => `${label}：${value}`)
    .join('\n')
}

const describeSettingBrief = (run: LocalWorkflowRun) => {
  const setting = resolveRunSettingUi(run)
  const characters = Array.isArray(setting.characters) ? setting.characters : []
  const characterLines = characters
    .filter((item: JsonRecord) => asText(item?.name))
    .slice(0, 8)
    .map((item: JsonRecord) =>
      `${asText(item.name)}（${[asText(item.gender), asText(item.identity)].filter(Boolean).join('，')}）：${[asText(item.background), asText(item.motivation)].filter(Boolean).join('；')}`
    )
  const core = (setting.core || {}) as JsonRecord
  const realms = Array.isArray(core.cultivation?.realms) ? core.cultivation.realms : []
  const powerLine = [asText(core.cultivation?.intro), realms.map((realm: JsonRecord) => asText(realm?.name)).filter(Boolean).join('→')]
    .filter(Boolean)
    .join('；境界：')
  const storylines = Array.isArray(setting.storylines) ? setting.storylines : []
  const storylineLines = storylines
    .filter((line: JsonRecord) => asText(line?.title))
    .map((line: JsonRecord) => `${asText(line.title)}：${asText(line.desc)}`)
  return {
    characters: characterLines.join('\n'),
    power: powerLine,
    storylines: storylineLines.join('\n'),
  }
}

const describeOutlineBrief = (run: LocalWorkflowRun) => {
  const outline = resolveRunOutlineUi(run)
  return [
    asText(outline.intro) ? `简介：${asText(outline.intro)}` : '',
    asText(outline.storyHook) ? `核心钩子：${asText(outline.storyHook)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const describeVolumeStages = (volume: LocalLibraryVolume) => {
  const stages = Array.isArray(volume.planMeta?.stages) ? volume.planMeta!.stages : []
  return stages
    .map((stage: JsonRecord) =>
      `阶段「${asText(stage?.title)}」：目标 ${asText(stage?.goal)}；从 ${asText(stage?.startState)} 到 ${asText(stage?.endState)}${Array.isArray(stage?.mustHappen) && stage.mustHappen.length ? `；必须发生：${stage.mustHappen.map(asText).join('、')}` : ''}`
    )
    .join('\n')
}

const readBeats = (chapter: LocalChapter) => {
  const expanded = chapter.planMeta?.expandedOutline as Record<string, unknown> | null | undefined
  if (!expanded || typeof expanded !== 'object' || !Array.isArray(expanded.beats)) return null
  const beats: string[] = expanded.beats.map(asText).filter(Boolean)
  if (!beats.length) return null
  return { beats, endHook: asText(expanded.endHook) }
}

/** 正文提示词素材（常规生成 / 断点续写 / 按要求重写共用） */
const buildChapterMaterials = async (params: {
  run: LocalWorkflowRun
  volume: LocalLibraryVolume
  chapter: LocalChapter
  previousChapter: LocalChapter | null
  nextChapterSummary: string
}): Promise<Record<string, string>> => {
  const { run, volume, chapter, previousChapter } = params
  const brief = describeSettingBrief(run)
  let previousTail = ''
  if (previousChapter) {
    const { text } = await readChapterText(chapter.bookId, previousChapter.id)
    previousTail = text ? `《${previousChapter.title}》结尾：\n${text.slice(-PREV_CHAPTER_TAIL_CHARS)}` : ''
  }
  const beats = readBeats(chapter)
  const writingRules = asText(run.config?.writingRules)
  return {
    '写作参数': describeRunConfig(run),
    '写作规则（必须遵守，优先级最高）': writingRules,
    '作品大纲': describeOutlineBrief(run),
    '主要人物': brief.characters,
    '力量体系': brief.power,
    '故事线': brief.storylines,
    '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
    '前情': previousTail,
    '本章章纲': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
    '本章细纲': beats ? [...beats.beats.map((beat, i) => `${i + 1}. ${beat}`), beats.endHook ? `章末钩子：${beats.endHook}` : ''].filter(Boolean).join('\n') : '',
    '下一章章纲（衔接用，不要写进本章）': params.nextChapterSummary,
  }
}

// ---------------------------------------------------------------------------
// 卷内工作清单
// ---------------------------------------------------------------------------

export interface VolumeWorkState {
  volume: LocalLibraryVolume
  /** 全书按序排好的章（跨卷，供前情/衔接查找） */
  orderedChapters: LocalChapter[]
  pendingInVolume: LocalChapter[]
  writtenInVolume: number
  targetCount: number
}

const volumeTargetCount = (volume: LocalLibraryVolume) => {
  const meta = volume.planMeta || {}
  const fixed = Number(meta.chapterCount || 0)
  const rangeMax = Number(meta.chapterRange?.max || 0)
  const materialized = volume.children.length
  return Math.max(fixed || rangeMax || materialized, materialized)
}

/** 找当前该写的卷：第一个还有未写章或未到目标章数的卷；全写完返回 null */
const resolveVolumeWork = async (bookId: string): Promise<VolumeWorkState | null> => {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  const orderedChapters = tree.flatMap(volume => volume.children)
  for (const volume of tree) {
    const pending = volume.children.filter(chapter => chapter.workflowStatus === 'incomplete' || chapter.workflowStatus === 'review_required')
    const written = volume.children.length - pending.length
    const target = volumeTargetCount(volume)
    if (pending.length || volume.children.length < target) {
      return { volume, orderedChapters, pendingInVolume: pending, writtenInVolume: written, targetCount: target }
    }
  }
  return null
}

/** 整本书还欠多少章：各卷"目标章数-已写章数"与"未写占位章"取大者累加。
 *  任务停止/完成时写进 task.remainingChapters，写作台据此决定给不给「继续生成」按钮。 */
export const countRemainingChapters = async (bookId: string) => {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  let remaining = 0
  for (const volume of tree) {
    const pending = volume.children.filter(chapter => chapter.workflowStatus === 'incomplete').length
    remaining += Math.max(volumeTargetCount(volume) - (volume.children.length - pending), pending)
  }
  return remaining
}

/** 后面各卷还欠多少章（done 事件的 remainingChapters 口径） */
const countRemainingAfter = async (bookId: string, currentVolumeId: number) => {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  let remaining = 0
  let passed = false
  for (const volume of tree) {
    if (!passed) {
      if (Number(volume.id) === Number(currentVolumeId)) passed = true
      continue
    }
    const pending = volume.children.filter(chapter => chapter.workflowStatus === 'incomplete').length
    remaining += Math.max(volumeTargetCount(volume) - (volume.children.length - pending), pending)
  }
  return remaining
}

// ---------------------------------------------------------------------------
// 章纲批量规划与细纲展开
// ---------------------------------------------------------------------------

const planNextChapterBatch = async (
  run: LocalWorkflowRun,
  work: VolumeWorkState,
  modelCode: string,
  signal: AbortSignal
) => {
  const storage = getLocalLibraryStorage()
  const { volume, orderedChapters } = work
  const existing = volume.children
  const globalStart = orderedChapters.length ? Number(orderedChapters[orderedChapters.length - 1].sortNo) + 1 : 1
  const count = Math.min(PLAN_BATCH_SIZE, Math.max(1, work.targetCount - existing.length))
  const recentOutlines = orderedChapters
    .slice(-6)
    .map(chapter => `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`)
    .join('\n')
  const isFinalStretch = existing.length + count >= work.targetCount
  const data = await requestLocalChatCompletion({
    scene: 'workflow_chapter_plan',
    sceneLabel: '建书·章纲规划',
    modelCode,
    signal,
    timeoutMs: LONG_COMPLETION_TIMEOUT_MS,
    messages: buildChapterPlanMessages({
      materials: {
        '写作参数': describeRunConfig(run),
        '作品大纲': describeOutlineBrief(run),
        '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
        '已有章纲（最近几章）': recentOutlines,
      },
      count,
      startChapterNo: globalStart,
      isFinalStretch,
    }),
  })
  const parsed = parseAiJson(data, ['chapters'])
  const plans = Array.isArray(parsed?.chapters) ? parsed.chapters : []
  const cleaned = plans
    .map((plan: JsonRecord) => ({ title: asText(plan?.title), summary: asText(plan?.summary) }))
    .filter((plan: { title: string }) => plan.title)
    .slice(0, count)
  if (!cleaned.length) throw new Error('章纲规划结果为空，请重试')

  const planOffset = Array.isArray(volume.planMeta?.chapters) ? volume.planMeta!.chapters.length : 0
  const createdChapters: LocalChapter[] = []
  for (const [index, plan] of cleaned.entries()) {
    const created = await storage.createLocalChapter({
      bookId: volume.bookId,
      volumeId: volume.id,
      title: plan.title,
      summary: plan.summary,
      sortNo: globalStart + index,
      planMeta: {
        workflowPlanIndex: planOffset + index + 1,
        outlineSource: 'volume_ai',
        source: { title: plan.title, summary: plan.summary },
      },
      workflowStatus: 'incomplete',
    })
    createdChapters.push(created)
  }
  await storage.updateLocalVolume({
    id: volume.id,
    planMeta: {
      ...(volume.planMeta || {}),
      chapters: [...(Array.isArray(volume.planMeta?.chapters) ? volume.planMeta!.chapters : []), ...cleaned],
    },
  })
  return createdChapters
}

const ensureChapterBeats = async (
  run: LocalWorkflowRun,
  volume: LocalLibraryVolume,
  chapter: LocalChapter,
  modelCode: string,
  signal: AbortSignal
) => {
  if (readBeats(chapter) || String(chapter.planMeta?.outlineSource || '') === 'user') return chapter
  const data = await requestLocalChatCompletion({
    scene: 'workflow_chapter_beats',
    sceneLabel: '建书·细纲',
    modelCode,
    signal,
    messages: buildChapterBeatsMessages({
      materials: {
        '写作参数': describeRunConfig(run),
        '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
        '本章章纲': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
      },
    }),
  })
  const parsed = parseAiJson(data, ['beats'])
  const beats = Array.isArray(parsed?.beats) ? parsed.beats.map(asText).filter(Boolean) : []
  if (!beats.length) return chapter
  const updated = await getLocalLibraryStorage().updateLocalChapter({
    id: chapter.id,
    planMeta: {
      ...(chapter.planMeta || {}),
      expandedOutline: { beats: beats.slice(0, 10), endHook: asText(parsed?.endHook) },
      outlineSource: 'phase_a',
    },
  })
  return updated || chapter
}

// ---------------------------------------------------------------------------
// 单章流式生成（返回全文；暂停/取消通过旗与 signal 生效）
// ---------------------------------------------------------------------------

export interface ChapterStreamCallbacks {
  onSnapshot: (fullText: string) => void
}

const streamChapterContent = async (params: {
  modelCode: string
  materials: Record<string, string>
  targetWords: number
  partialText?: string
  rewriteInstruction?: string
  signal: AbortSignal
  onSnapshot: (fullText: string) => void
}): Promise<string> => {
  const base = String(params.partialText || '')
  let streamed = ''
  let streamError = ''
  await streamLocalChatCompletion(
    {
      modelCode: params.modelCode,
      scene: 'workflow_content',
      sceneLabel: '建书·正文',
      temperature: promptTemperature('workflow-writer', 'contentSystem'),
      messages: buildChapterContentMessages({
        materials: params.materials,
        targetWords: params.targetWords,
        partialText: params.partialText,
        rewriteInstruction: params.rewriteInstruction,
      }),
      signal: params.signal,
    },
    {
      onDelta: text => {
        streamed += text
        params.onSnapshot(base ? `${base}\n${streamed}` : streamed)
      },
      onDone: () => undefined,
      onError: message => {
        streamError = message
      },
    }
  )
  if (streamError) throw new Error(streamError)
  return base ? `${base}\n${streamed}` : streamed
}

// ---------------------------------------------------------------------------
// 任务快照与断点
// ---------------------------------------------------------------------------

const persistTask = async (task: WorkflowTask) => {
  await writeLocalWorkflowTask(task)
}

const buildCheckpoint = (chapterId: number, contentText: string, seq: number) => ({
  id: createLocalEntityId(),
  chapterId,
  contentText,
  payload: { seq },
})

/** 任务进入终态时同步 run 的活跃指针（canceled/succeeded 摘掉，其余保留可恢复） */
const settleRunActiveTask = async (runId: number, taskId: number, status: string) => {
  const run = await readLocalWorkflowRun(runId)
  if (!run) return
  if (['canceled', 'succeeded'].includes(status) && Number(run.activeTaskId || 0) === Number(taskId)) {
    run.activeTaskId = null
    if (status === 'succeeded') run.status = 'completed'
    if (status === 'canceled') run.status = 'canceled'
    await writeLocalWorkflowRun(run)
  }
}

// ---------------------------------------------------------------------------
// 单章重写腿（写作台重写面板发起；独立于整书循环）
// ---------------------------------------------------------------------------

/**
 * 后台执行单章重写：按要求整章重生成 → 写入章节 → 规则质检 → 停在待确认。
 * 正文只在生成完整后落库，中途取消/失败原稿不动。
 */
export const launchLocalChapterRewrite = (task: WorkflowTask, options: { instruction: string }) => {
  const flags: WriterFlags = { pauseRequested: false, cancelRequested: false, abort: null }
  writerFlags.set(Number(task.id), flags)
  registerLiveLocalTask({
    taskId: Number(task.id),
    runId: Number(task.runId),
    kind: 'rewrite',
    requestCancel: () => {
      flags.cancelRequested = true
      flags.abort?.abort()
    },
  })
  void (async () => {
    const runId = Number(task.runId)
    const taskId = Number(task.id)
    const chapterId = Number(task.currentChapterId || 0)
    let current: WorkflowTask = { ...task, status: 'running' }
    await persistTask(current)
    try {
      const run = await readLocalWorkflowRun(runId)
      if (!run || !run.bookId) throw new Error('工作流或书籍不存在')
      const bookId = String(run.bookId)
      const modelCode = await resolveWorkflowModelCode(run)
      const targetWords = resolveChapterTargetWords(run)
      const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
      const volume = tree.find(item => item.children.some(chapter => chapter.id === chapterId))
      const chapter = volume?.children.find(item => item.id === chapterId)
      if (!volume || !chapter) throw new Error('章节不存在或已删除')
      const orderedChapters = tree.flatMap(item => item.children)
      const orderIndex = orderedChapters.findIndex(item => item.id === chapterId)
      const nextChapter = orderIndex >= 0 ? orderedChapters[orderIndex + 1] || null : null
      const original = await readChapterText(bookId, chapterId)

      flags.abort = new AbortController()
      const materials = await buildChapterMaterials({
        run,
        volume,
        chapter,
        previousChapter: orderIndex > 0 ? orderedChapters[orderIndex - 1] : null,
        nextChapterSummary: nextChapter ? `第${nextChapter.sortNo}章《${nextChapter.title}》：${asText(nextChapter.summary)}` : '',
      })
      if (original.text.trim()) {
        materials['原稿（重写参考，不要照抄）'] = original.text.slice(0, 4000)
      }
      let lastProgressAt = 0
      const fullText = await streamChapterContent({
        modelCode,
        materials,
        targetWords,
        rewriteInstruction: options.instruction,
        signal: flags.abort.signal,
        onSnapshot: text => {
          const now = Date.now()
          if (now - lastProgressAt < 1000) return
          lastProgressAt = now
          current = {
            ...current,
            progress: Math.min(95, Math.round((countWords(text) / Math.max(targetWords, 1)) * 100)),
          }
          void persistTask(current)
        },
      })
      flags.abort = null
      if (flags.cancelRequested) {
        current = { ...current, status: 'canceled', remainingChapters: await countRemainingChapters(String(current.bookId)), requestedAction: null, canCancel: false }
        await persistTask(current)
        return
      }
      if (!fullText.trim()) throw new Error('生成结果为空，请重试')

      const contentVersion = original.contentVersion + 1
      await saveGeneratedChapterContent({ bookId, chapterId, title: chapter.title, text: fullText, contentVersion })
      await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: 'review_required' })
      const notice = runLocalChapterQualityCheck({
        chapterId,
        chapterNo: Number(chapter.sortNo || 0),
        chapterTitle: chapter.title,
        text: fullText,
        targetWords,
        contentVersion,
        modelCode,
      })
      current = {
        ...current,
        status: 'review_required',
        progress: 100,
        generatedWords: countWords(fullText),
        canReview: true,
        canCancel: true,
        payload: { ...(current.payload || {}), qualityReview: { ...notice, requiresAction: true } },
      }
      await persistTask(current)
    } catch (error) {
      if (flags.cancelRequested) {
        current = { ...current, status: 'canceled', remainingChapters: await countRemainingChapters(String(current.bookId)), requestedAction: null, canCancel: false }
      } else {
        current = {
          ...current,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : '重写失败，请重试',
          canCancel: false,
        }
      }
      await persistTask(current).catch(() => undefined)
    } finally {
      writerFlags.delete(taskId)
      unregisterLiveLocalTask(taskId)
    }
  })()
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

const taskFlagHandle = (task: WorkflowTask): WriterFlags => {
  const flags: WriterFlags = { pauseRequested: false, cancelRequested: false, abort: null }
  writerFlags.set(Number(task.id), flags)
  registerLiveLocalTask({
    taskId: Number(task.id),
    runId: Number(task.runId),
    kind: 'book',
    requestPause: () => {
      flags.pauseRequested = true
      flags.abort?.abort()
    },
    requestCancel: () => {
      flags.cancelRequested = true
      flags.abort?.abort()
    },
  })
  return flags
}

const releaseTask = (taskId: number) => {
  writerFlags.delete(Number(taskId))
  unregisterLiveLocalTask(taskId)
}

/**
 * 启动（或从确认/恢复处重启）逐章生成循环。调用方负责先把任务置为
 * queued/running 并落库；本函数在后台运行至任务出循环（终态或停机等确认）。
 */
export const launchLocalBookWriter = (task: WorkflowTask) => {
  const flags = taskFlagHandle(task)
  void runWriterLoop(task, flags)
    .catch(async error => {
      // 循环内部已兜错；这里只兜"兜错逻辑本身炸了"的极端情况
      console.error('逐章生成循环异常退出:', error)
      const failed: WorkflowTask = {
        ...task,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : '生成失败，请重试',
        canPause: false,
        canResume: true,
        canCancel: true,
      }
      await persistTask(failed).catch(() => undefined)
      emitLocalWorkflowEvent(buildLocalWorkflowEvent('error', Number(task.runId), Number(task.id), { message: failed.errorMessage }))
    })
    .finally(() => releaseTask(Number(task.id)))
}

const runWriterLoop = async (initial: WorkflowTask, flags: WriterFlags) => {
  let task: WorkflowTask = { ...initial }
  const runId = Number(task.runId)
  const taskId = Number(task.id)
  const emit = (type: Parameters<typeof buildLocalWorkflowEvent>[0], payload?: JsonRecord) =>
    emitLocalWorkflowEvent(buildLocalWorkflowEvent(type, runId, taskId, payload))

  const run = await readLocalWorkflowRun(runId)
  if (!run || !run.bookId) throw new Error('工作流或书籍不存在')
  const bookId = String(run.bookId)
  const targetWords = resolveChapterTargetWords(run)

  const halt = async (status: string, extra: Partial<WorkflowTask> = {}) => {
    // 停止/完成是终态：把剩余章数记在任务上，写作台才知道要不要给「继续生成」
    const remainingChapters = ['canceled', 'succeeded'].includes(status)
      ? await countRemainingChapters(bookId)
      : task.remainingChapters
    task = {
      ...task,
      ...extra,
      status,
      remainingChapters,
      requestedAction: null,
      canPause: false,
      canResume: ['paused', 'interrupted', 'failed'].includes(status),
      canCancel: ['paused', 'interrupted', 'failed', 'review_required'].includes(status),
    }
    await persistTask(task)
    await settleRunActiveTask(runId, taskId, status)
  }

  while (true) {
    // 每章开写前重读 run：运行时创作设定（含写作规则、换模型）下一章生效
    const freshRun = await readLocalWorkflowRun(runId)
    if (freshRun) Object.assign(run, freshRun)

    if (flags.cancelRequested) {
      await halt('canceled')
      emit('progress', {})
      return
    }
    if (flags.pauseRequested) {
      await halt('paused')
      emit('paused', {})
      return
    }

    const work = await resolveVolumeWork(bookId)
    if (!work) {
      task = { ...task, progress: 100 }
      await halt('succeeded')
      emit('done', { remainingChapters: 0 })
      return
    }

    let modelCode: string
    try {
      modelCode = await resolveWorkflowModelCode(run)
    } catch (error) {
      await halt('failed', { errorMessage: error instanceof Error ? error.message : NO_MODEL_MESSAGE })
      emit('error', { message: task.errorMessage })
      return
    }

    // 本卷材料写完但没到目标章数：先批量规划一批章纲
    if (!work.pendingInVolume.length) {
      if (work.volume.children.length >= work.targetCount) {
        // 本卷齐了，看后面还有没有活；一次任务只写一卷，收在这里
        const remaining = await countRemainingAfter(bookId, work.volume.id)
        task = { ...task, progress: 100, finishedChapters: Number(task.finishedChapters || 0) }
        await halt('succeeded')
        emit('done', { remainingChapters: remaining })
        return
      }
      try {
        flags.abort = new AbortController()
        emit('stage', { message: `正在规划《${work.volume.title}》接下来的章纲` })
        const created = await planNextChapterBatch(run, work, modelCode, flags.abort.signal)
        task = { ...task, totalChapters: Number(task.totalChapters || 0) + created.length }
        await persistTask(task)
        emit('stage', { message: `已规划 ${created.length} 章章纲`, catalogUpdated: true })
        continue
      } catch (error) {
        if (flags.pauseRequested || flags.cancelRequested) continue
        await halt('failed', { errorMessage: error instanceof Error ? error.message : '章纲规划失败' })
        emit('error', { message: task.errorMessage })
        return
      } finally {
        flags.abort = null
      }
    }

    // 待确认章挡在队首：循环不能越过它写后面的章
    let chapter = work.pendingInVolume[0]
    if (chapter.workflowStatus === 'review_required') {
      // 新任务（继续生成）接手旧的待确认章时，任务上还没有质检卡——按存量正文重建
      if (Number(task.payload?.qualityReview?.chapterId || 0) !== chapter.id) {
        const stored = await readChapterText(bookId, chapter.id)
        const notice = runLocalChapterQualityCheck({
          chapterId: chapter.id,
          chapterNo: Number(chapter.sortNo || 0),
          chapterTitle: chapter.title,
          text: stored.text,
          targetWords,
          contentVersion: stored.contentVersion,
          modelCode: asText(run.modelCode),
        })
        task = {
          ...task,
          currentChapterId: chapter.id,
          currentChapterTitle: chapter.title,
          chapterNo: Number(chapter.sortNo || 0),
          canReview: true,
          payload: { ...(task.payload || {}), qualityReview: { ...notice, requiresAction: true }, qualitySuggestions: null },
        }
      }
      await halt('review_required')
      emit('quality-review', { chapterId: chapter.id })
      return
    }

    const orderIndex = work.orderedChapters.findIndex(item => item.id === chapter.id)
    const previousChapter = orderIndex > 0 ? work.orderedChapters[orderIndex - 1] : null
    const nextChapter = work.pendingInVolume[1] || null

    // 质检确认发起的"重写本章"：带用户意见整章重生成，不吃旧断点
    const directive = (task.payload as JsonRecord | undefined)?.rewriteDirective as
      | { chapterId: number; instruction?: string; baseText?: string }
      | null
      | undefined
    const isRewrite = Boolean(directive && Number(directive.chapterId) === chapter.id)

    // 断点续写：checkpoint 停在本章时带上已写部分
    const checkpoint = (task.checkpoint || {}) as JsonRecord
    const partialText =
      !isRewrite && Number(checkpoint.chapterId || 0) === chapter.id
        ? String(checkpoint.contentText || '')
        : ''

    try {
      flags.abort = new AbortController()
      emit('stage', { message: `正在准备第${chapter.sortNo}章《${chapter.title}》` })
      chapter = await ensureChapterBeats(run, work.volume, chapter, modelCode, flags.abort.signal)
    } catch (error) {
      flags.abort = null
      if (!flags.pauseRequested && !flags.cancelRequested) {
        await halt('failed', { errorMessage: error instanceof Error ? error.message : '细纲生成失败' })
        emit('error', { message: task.errorMessage })
        return
      }
      continue
    }
    if (flags.pauseRequested || flags.cancelRequested) {
      flags.abort = null
      continue
    }

    task = {
      ...task,
      status: 'running',
      currentChapterId: chapter.id,
      currentChapterTitle: chapter.title,
      chapterNo: Number(chapter.sortNo || 0),
      generatedWords: countWords(partialText),
      canPause: true,
      canResume: false,
      canCancel: true,
    }
    await persistTask(task)
    emit('stage', { message: `开始写第${chapter.sortNo}章《${chapter.title}》`, catalogUpdated: true })

    let lastTokenAt = 0
    let lastCheckpointAt = 0
    let checkpointSeq = Number(checkpoint?.payload?.seq || 0)
    let latestText = partialText
    const baseTotalWords = Number(task.totalGeneratedWords || 0) - countWords(partialText)

    const emitSnapshot = (fullText: string, force = false) => {
      latestText = fullText
      const now = Date.now()
      if (!force && now - lastTokenAt < TOKEN_EVENT_INTERVAL_MS) return
      lastTokenAt = now
      const words = countWords(fullText)
      emit('token', {
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterNo: Number(chapter.sortNo || 0),
        snapshot: fullText,
        wordCount: words,
        textWordCount: countTextWords(fullText),
        totalGeneratedWords: Math.max(0, baseTotalWords) + words,
        progress: task.progress,
      })
      if (now - lastCheckpointAt >= CHECKPOINT_PERSIST_INTERVAL_MS) {
        lastCheckpointAt = now
        checkpointSeq += 1
        task = {
          ...task,
          generatedWords: words,
          totalGeneratedWords: Math.max(0, baseTotalWords) + words,
          checkpoint: buildCheckpoint(chapter.id, fullText, checkpointSeq),
          checkpointId: Number(task.checkpointId || 0) || createLocalEntityId(),
        }
        void persistTask(task)
      }
    }

    let fullText = ''
    try {
      flags.abort = new AbortController()
      const materials = await buildChapterMaterials({
        run,
        volume: work.volume,
        chapter,
        previousChapter,
        nextChapterSummary: nextChapter ? `第${nextChapter.sortNo}章《${nextChapter.title}》：${asText(nextChapter.summary)}` : '',
      })
      if (isRewrite && asText(directive?.baseText)) {
        materials['原稿（重写参考，不要照抄）'] = asText(directive?.baseText).slice(0, 4000)
      }
      fullText = await streamChapterContent({
        modelCode,
        materials,
        targetWords,
        partialText,
        rewriteInstruction: isRewrite ? asText(directive?.instruction) : '',
        signal: flags.abort.signal,
        onSnapshot: emitSnapshot,
      })
    } catch (error) {
      flags.abort = null
      // 掐流导致的失败按暂停/取消处理；真失败落断点，正文保进章节
      if (!flags.pauseRequested && !flags.cancelRequested) {
        if (latestText.trim()) {
          await saveGeneratedChapterContent({ bookId, chapterId: chapter.id, title: chapter.title, text: latestText, contentVersion: (await readChapterText(bookId, chapter.id)).contentVersion + 1 })
        }
        await halt('failed', {
          errorMessage: error instanceof Error ? error.message : '正文生成失败',
          checkpoint: buildCheckpoint(chapter.id, latestText, checkpointSeq + 1),
        })
        emit('error', { message: task.errorMessage })
        return
      }
      continue
    }
    flags.abort = null

    // 暂停/取消在流式中生效：把已写部分如实保住再停
    if (flags.pauseRequested || flags.cancelRequested) {
      if (latestText.trim()) {
        await saveGeneratedChapterContent({ bookId, chapterId: chapter.id, title: chapter.title, text: latestText, contentVersion: (await readChapterText(bookId, chapter.id)).contentVersion + 1 })
      }
      task = { ...task, checkpoint: buildCheckpoint(chapter.id, latestText, checkpointSeq + 1) }
      continue
    }

    if (!fullText.trim()) {
      await halt('failed', { errorMessage: '生成结果为空，请重试' })
      emit('error', { message: task.errorMessage })
      return
    }

    // 落库 + 质检
    const contentVersion = (await readChapterText(bookId, chapter.id)).contentVersion + 1
    await saveGeneratedChapterContent({ bookId, chapterId: chapter.id, title: chapter.title, text: fullText, contentVersion })
    emitSnapshot(fullText, true)
    const notice = runLocalChapterQualityCheck({
      chapterId: chapter.id,
      chapterNo: Number(chapter.sortNo || 0),
      chapterTitle: chapter.title,
      text: fullText,
      targetWords,
      contentVersion,
      modelCode,
    })
    const words = countWords(fullText)
    const finished = Number(task.finishedChapters || 0)
    const total = Math.max(Number(task.totalChapters || 0), finished + work.pendingInVolume.length)

    if (notice.requiresAction) {
      await getLocalLibraryStorage().updateLocalChapter({ id: chapter.id, workflowStatus: 'review_required' })
      task = {
        ...task,
        totalChapters: total,
        totalGeneratedWords: Math.max(0, baseTotalWords) + words,
        generatedWords: words,
        checkpoint: null,
        canReview: true,
        payload: { ...(task.payload || {}), qualityReview: notice, qualitySuggestions: null, rewriteDirective: null },
      }
      await halt('review_required')
      emit('quality-review', { chapterId: chapter.id })
      return
    }

    await getLocalLibraryStorage().updateLocalChapter({ id: chapter.id, workflowStatus: null })
    const finishedNow = finished + 1
    task = {
      ...task,
      finishedChapters: finishedNow,
      totalChapters: total,
      totalGeneratedWords: Math.max(0, baseTotalWords) + words,
      generatedWords: words,
      progress: Math.min(99, Math.round((finishedNow / Math.max(total, 1)) * 100)),
      checkpoint: null,
      payload: { ...(task.payload || {}), qualitySuggestions: notice.issues.length ? notice : null, qualityReview: null, rewriteDirective: null },
    }
    await persistTask(task)
    emit('scene-done', { sceneNo: 1, progress: task.progress })
    emit('stage', { message: `第${chapter.sortNo}章《${chapter.title}》完成（${words} 字）`, catalogUpdated: true })
    emit('progress', {})
  }
}
