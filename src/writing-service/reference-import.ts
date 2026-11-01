import { invokeWritingCommand } from './client'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import type { BookCatalog, ReferenceParseOptions } from './reference-book'
export interface ReferenceImport {
  projectId: string
  bookId: string
  title: string
  chapters: number
  words: number
  existing?: boolean
}
export interface ReferenceImportProgress {
  stage: string
  done: number
  total: number
  cancellable: boolean
}
export type ReferenceImportResult =
  | { material?: false; result: ReferenceImport }
  | {
      material: true
      result: { materialId: string; title: string; chars: number }
    }

export interface ReferenceFileSource {
  file: File
  intent: 'breakdown' | null
  parseOptions?: ReferenceParseOptions
  captureSource?: boolean
  /** 聊天附件不等同名旧书逐章核对；重复文件仍按指纹复用。 */
  verifyCandidates?: boolean
}
/** 只读文本、识别目录，不写任何库：上传后立刻给作者看章数和分章提示。 */
export function previewReferenceFile(
  source: Omit<ReferenceFileSource, 'captureSource' | 'verifyCandidates'>,
  onProgress: (progress: ReferenceImportProgress) => void
) {
  const work = runReferenceWorker({ ...source, preview: true }, onProgress)
  return { promise: work.promise.then(result => result.result as BookCatalog), cancel: work.cancel }
}
/** Worker 只持有解析所需的文本；主窗口只接收进度及最多八章的当前保存批次。 */
export function importReferenceFile(
  source: ReferenceFileSource | { projectId: string },
  onProgress: (progress: ReferenceImportProgress) => void,
  saveSourceChunk?: (index: number, text: string) => Promise<unknown>
) {
  const work = runReferenceWorker(source, onProgress, saveSourceChunk)
  return { promise: work.promise as Promise<ReferenceImportResult>, cancel: work.cancel }
}
function runReferenceWorker(
  source: (ReferenceFileSource & { preview?: boolean }) | { projectId: string },
  onProgress: (progress: ReferenceImportProgress) => void,
  saveSourceChunk?: (index: number, text: string) => Promise<unknown>
) {
  const worker = new Worker(new URL('./reference-import.worker.ts', import.meta.url), { type: 'module' })
  let token = ''
  let cancelled = false
  let committing = false
  let settled = false
  let inFlight: Promise<unknown> = Promise.resolve()
  let rejectTask: (error: Error) => void = () => undefined
  const cleanup = async () => {
    await inFlight.catch(() => undefined)
    if (token) await invokeWritingCommand('reference_abort', { token })
  }
  const preview = 'preview' in source && source.preview === true
  const promise = new Promise<{ material?: boolean; preview?: boolean; result: unknown }>((resolve, reject) => {
    rejectTask = reject
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      worker.terminate()
      void cleanup().then(
        () => reject(error),
        cleanupError => reject(new Error(`${error.message}；暂存清理失败：${cleanupError}`))
      )
    }
    worker.onerror = event => fail(new Error(event.message || '文本处理失败'))
    worker.onmessage = async event => {
      const data = event.data
      if (data.kind === 'progress') onProgress({ ...data, cancellable: data.stage !== '完成导入' })
      else if (data.kind === 'command') {
        if (cancelled) return
        committing = data.action === 'reference_commit' || data.action === 'material_put'
        inFlight =
          data.action === 'capture_source_chunk'
            ? saveSourceChunk
              ? saveSourceChunk(data.args.index, data.args.text)
              : Promise.reject(new Error('原文保存通道缺失'))
            : invokeWritingCommand(data.action, data.args)
        try {
          const value = await inFlight
          if (data.action === 'reference_begin') token = (value as { token: string }).token
          if (committing) token = ''
          if (!cancelled) worker.postMessage({ kind: 'reply', request: data.request, value })
        } catch (error) {
          if (!cancelled) worker.postMessage({ kind: 'reply', request: data.request, error: String(error) })
        }
      } else if (data.kind === 'done') {
        settled = true
        worker.terminate()
        resolve({ material: data.material, preview: data.preview, result: data.result })
      } else if (data.kind === 'error') fail(new Error(data.error))
    }
  })
  const start = () => {
    worker.postMessage({ kind: 'start', ...source })
    return promise
  }
  // 预览不写库，不占用存储维护的写入计数。
  const tracked = (preview ? start() : trackStorageWrite(start)).catch(error => {
    worker.terminate()
    throw error
  })
  return {
    promise: tracked,
    cancel: async () => {
      if (committing || settled) return
      cancelled = true
      settled = true
      worker.terminate()
      try {
        await cleanup()
        rejectTask(new DOMException('已取消导入', 'AbortError'))
      } catch (error) {
        rejectTask(new Error(`已停止导入，暂存清理失败：${error}`))
      }
    }
  }
}
