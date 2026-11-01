import { ref, watch } from 'vue'
import { useListeningStore } from '@/stores/listening'

interface InlineListeningTarget {
  bookId: string | number
  chapterId: number
}

interface InlineListeningOptions {
  target: () => InlineListeningTarget | null
  save: () => Promise<boolean>
  onError: (message: string) => void
  onEmpty: () => void
}

/** 写作台的保存、刷新与播放共用一轮请求；切章、结束和卸载会取消整轮意图。 */
export const useInlineListening = (options: InlineListeningOptions) => {
  const store = useListeningStore()
  const pending = ref(false)
  let request = 0
  let disposed = false
  let lastReportedError = ''

  const invalidate = () => {
    request += 1
    pending.value = false
  }

  const suspend = () => {
    invalidate()
    store.suspend()
  }

  const stop = () => {
    invalidate()
    store.endSession()
  }

  const reportFailure = () => {
    if (store.status !== 'error') return
    const message = store.error || '听书启动失败'
    // 同一句失败可能同时来自播放命令返回和状态监听，只提示一次
    if (message === lastReportedError) return
    lastReportedError = message
    options.onError(message)
  }

  /** 只提示本轮就地朗读自己的失败，不打扰听书页里的整本播放 */
  const sessionBelongsToTarget = () => {
    const target = options.target()
    if (!target || store.scope !== 'chapter') return false
    return String(store.book?.id || '') === String(target.bookId)
  }

  // 云端合成和部分系统语音失败发生在 play() 返回之后，靠状态监听补一条提示
  const stopWatching = watch(
    () => [store.status, store.error] as const,
    () => {
      if (disposed || !sessionBelongsToTarget()) return
      reportFailure()
    }
  )

  const toggle = async () => {
    if (disposed) return
    if (pending.value) {
      suspend()
      return
    }
    const target = options.target()
    if (!target) return
    if (store.isPlaying && String(store.book?.id) === String(target.bookId)) {
      suspend()
      return
    }

    const current = ++request
    const isCurrent = () => {
      const latest = options.target()
      return (
        !disposed &&
        current === request &&
        latest?.chapterId === target.chapterId &&
        String(latest?.bookId) === String(target.bookId)
      )
    }
    pending.value = true
    lastReportedError = ''
    try {
      const saved = await options.save()
      if (!isCurrent()) return
      if (!saved) {
        options.onError('当前修改尚未保存，请先完成保存后再朗读')
        return
      }
      const ready = await store.openBook(target.bookId, target.chapterId, { scope: 'chapter', refresh: true })
      if (!isCurrent()) return
      if (!ready) {
        if (store.status === 'empty') options.onEmpty()
        else reportFailure()
        return
      }
      await store.play()
      if (isCurrent()) reportFailure()
    } catch (cause) {
      if (isCurrent()) options.onError(cause instanceof Error ? cause.message : '听书启动失败')
    } finally {
      if (current === request) pending.value = false
    }
  }

  const dispose = () => {
    disposed = true
    stopWatching()
    suspend()
  }

  return { pending, toggle, stop, suspend, dispose }
}
