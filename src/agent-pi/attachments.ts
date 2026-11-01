import { shallowRef } from 'vue'
import { piCommand } from './client'
import { desktopInvoke } from '@/storage/desktop-records'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import { importReferenceFile, previewReferenceFile } from '@/writing-service/reference-import'
import type { ReferenceImportProgress } from '@/writing-service/reference-import'
import type { BookCatalog } from '@/writing-service/reference-book'
import { DOCUMENT_LABEL, isSupportedDocument } from '@/writing-service/document-text'
export type { BookCatalog } from '@/writing-service/reference-book'
export type HeadingStyle = 'auto' | 'numbered' | 'markdown'
export type AttachmentStatus = 'importing' | 'ready' | 'failed'
/** 宿主里的附件记录：上传时就有目录和书名，入库完成后才有 projectId。 */
export interface BookAttachment {
  id: string
  sessionId: string
  filename: string
  title: string
  status: AttachmentStatus
  error?: string | null
  projectId: number | null
  chapterCount: number
  notes: string[] | null
  chunks: number
  chars: number
  revision: number
  headingStyle: HeadingStyle
  catalog?: BookCatalog | null
}
/** 输入框里还没发送的附件：上传后立刻在本地识别目录，入库要等发送。 */
export interface PendingBookAttachment {
  id: string
  file: File
  catalog: BookCatalog | null
  previewing: boolean
  error: string
}
/** 一个正在后台入库的附件；界面和 read_breakdown 都从这里看进度。 */
export interface ImportLive {
  id: string
  sessionId: string
  chatKey: string
  stage: string
  done: number
  total: number
  startedAt: number
}
export const importLive = shallowRef<Record<string, ImportLive>>({})
const running = new Map<
  string,
  { controller: AbortController; promise: Promise<BookAttachment>; listeners: Set<(text: string) => void> }
>()
const PARSE_OPTIONS = { preserveLongChapters: true, headingStyle: 'auto' as const }
const call = <T>(op: string, args: Record<string, unknown>) =>
  trackStorageWrite(() => piCommand<T>('attachment', { op, ...args }))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const attachmentMessage = (
  text: string,
  file: Pick<BookAttachment, 'id' | 'filename' | 'title' | 'chapterCount'>
) =>
  `${text}\n\n<yichuang-attachment>${JSON.stringify({
    id: file.id,
    filename: file.filename,
    title: file.title,
    chapterCount: file.chapterCount
  })}</yichuang-attachment>`
/** The marker is only a display/reference hint. Source ownership is verified by storage. */
export function parseAttachmentMessage(text: string) {
  const match = text.match(/\n\n<yichuang-attachment>([^\n]*)<\/yichuang-attachment>$/)
  if (!match) return { text, file: null }
  try {
    const file = JSON.parse(match[1])
    if (
      typeof file.id !== 'string' ||
      typeof file.filename !== 'string' ||
      (file.projectId != null && !Number.isSafeInteger(file.projectId))
    )
      return { text, file: null }
    return {
      text: text.slice(0, match.index),
      file: file as { id: string; filename: string; title?: string; projectId?: number; chapterCount?: number }
    }
  } catch {
    return { text, file: null }
  }
}
export function validateBookFile(file: File) {
  if (!isSupportedDocument(file.name)) throw new Error(`暂不支持这种文件，请选择 ${DOCUMENT_LABEL}`)
  if (!file.size || file.size > 60 * 1024 * 1024) throw new Error('请选择非空且不超过 60 MB 的文件')
}
export const importProgressText = (live: Pick<ImportLive, 'stage' | 'done' | 'total'>) =>
  live.total ? `${live.stage} · ${Math.min(100, Math.round((live.done / live.total) * 100))}%` : live.stage
function setLive(id: string, patch: Partial<ImportLive>) {
  const previous = importLive.value[id]
  if (!previous && !patch.sessionId) return
  const next = { ...(previous as ImportLive), ...patch }
  importLive.value = { ...importLive.value, [id]: next }
  running.get(id)?.listeners.forEach(listener => listener(importProgressText(next)))
}
function clearLive(id: string) {
  if (!importLive.value[id]) return
  const next = { ...importLive.value }
  delete next[id]
  importLive.value = next
}

/** 上传后立刻识别目录：只读文件、不写库，几秒内给出书名、章数和分章提示。 */
export async function previewChatBook(
  pending: PendingBookAttachment,
  signal: AbortSignal,
  onProgress?: (p: ReferenceImportProgress) => void
) {
  validateBookFile(pending.file)
  signal.throwIfAborted()
  const work = previewReferenceFile({ file: pending.file, intent: 'breakdown', parseOptions: PARSE_OPTIONS }, p =>
    onProgress?.(p)
  )
  const cancel = () => {
    void work.cancel()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const catalog = await work.promise
    signal.throwIfAborted()
    return catalog
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
async function parseAndPublish(
  file: File,
  signal: AbortSignal,
  onProgress: (p: ReferenceImportProgress) => void,
  style: HeadingStyle,
  saveSourceChunk?: (index: number, text: string) => Promise<unknown>
) {
  signal.throwIfAborted()
  const work = importReferenceFile(
    {
      file,
      intent: 'breakdown',
      parseOptions: { preserveLongChapters: true, headingStyle: style },
      captureSource: !!saveSourceChunk,
      verifyCandidates: false
    },
    onProgress,
    saveSourceChunk
  )
  const cancel = () => {
    void work.cancel()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await work.promise
    signal.throwIfAborted()
    if (result.material) throw new Error('附件未识别为参考书')
    await trackStorageWrite(() =>
      desktopInvoke('writing_workspace', {
        action: 'reference_publish',
        args: { projectId: result.result.projectId }
      })
    )
    signal.throwIfAborted()
    return Number(result.result.projectId)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
/** 发送时只登记附件（带目录），消息立刻发出；入库由 runChatImport 在后台做。 */
export async function beginChatImport(pending: PendingBookAttachment, sessionId: string) {
  validateBookFile(pending.file)
  if (!pending.catalog) throw new Error(pending.error || '目录还没有识别完成')
  return call<BookAttachment>('begin', {
    id: pending.id,
    sessionId,
    filename: pending.file.name,
    catalog: pending.catalog
  })
}
/** 消息没发出去时撤销登记，附件回到输入框。 */
export const abortChatImport = (id: string, sessionId: string) =>
  call<null>('abort', { id, sessionId }).then(() => undefined)
/** 后台入库：保存原文、识别并发布参考书；失败原因记在附件上，作者和模型都能看到。 */
export function runChatImport(pending: PendingBookAttachment, attachment: BookAttachment, chatKey: string) {
  const { id, sessionId } = attachment
  const existing = running.get(id)
  if (existing) return existing.promise
  const controller = new AbortController()
  const listeners = new Set<(text: string) => void>()
  setLive(id, { id, sessionId, chatKey, stage: '准备入库', done: 0, total: 0, startedAt: Date.now() })
  const promise = (async () => {
    try {
      const projectId = await parseAndPublish(
        pending.file,
        controller.signal,
        p => setLive(id, { stage: p.stage, done: p.done, total: p.total }),
        'auto',
        (index, text) => {
          controller.signal.throwIfAborted()
          return call('append', { id, sessionId, index, text })
        }
      )
      controller.signal.throwIfAborted()
      return await call<BookAttachment>('finish', {
        id,
        sessionId,
        projectId,
        headingStyle: 'auto',
        expectedRevision: attachment.revision
      })
    } catch (error) {
      const reason = controller.signal.aborted ? '应用关闭时导入中断，请重新上传' : message(error)
      const failed = await call<BookAttachment>('fail', { id, sessionId, error: reason }).catch(() => null)
      throw Object.assign(new Error(reason), { attachment: failed })
    } finally {
      running.delete(id)
      clearLive(id)
    }
  })()
  running.set(id, { controller, promise, listeners })
  return promise
}
const abortable = <T>(promise: Promise<T>, signal?: AbortSignal) =>
  !signal
    ? promise
    : new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('已取消', 'AbortError'))
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
/** 等附件入库完成；拆书范围确认前调用。没有在跑的入库就按宿主记录判断。 */
export async function waitForChatImport(
  id: string,
  sessionId: string,
  signal?: AbortSignal,
  onProgress?: (text: string) => void
) {
  const live = running.get(id)
  if (live) {
    if (onProgress) {
      live.listeners.add(onProgress)
      const state = importLive.value[id]
      if (state) onProgress(`等待附件入库 · ${importProgressText(state)}`)
    }
    try {
      return await abortable(live.promise, signal)
    } finally {
      if (onProgress) live.listeners.delete(onProgress)
    }
  }
  const meta = await readBookAttachment(id, sessionId)
  if (meta.status === 'ready') return meta
  if (meta.status === 'failed') throw new Error(`附件入库失败：${meta.error || '原因未知'}。请作者重新上传文件。`)
  throw new Error('附件入库在应用关闭时中断，请作者重新上传文件。')
}
export const readBookAttachment = (id: string, sessionId: string) =>
  call<BookAttachment>('get', { id, sessionId })
export const listChatAttachments = (sessionId: string) => call<BookAttachment[]>('list', { sessionId })
/** 启动时把上次关闭前没做完的入库标为失败；没有 worker 的"入库中"不能让模型一直等。 */
export const recoverChatImports = () => call<BookAttachment[]>('recover', {})
export const hasRunningImports = () => running.size > 0
/** 关闭应用：终止所有后台入库并等它们把失败原因写进记录。 */
export async function cancelChatImports() {
  const items = [...running.values()]
  items.forEach(item => item.controller.abort())
  await Promise.allSettled(items.map(item => item.promise))
}
export async function reparseChatBook(
  id: string,
  sessionId: string,
  style: HeadingStyle,
  signal?: AbortSignal,
  progress?: (text: string) => void
) {
  if (!['auto', 'numbered', 'markdown'].includes(style)) throw new Error('不支持的分章方式')
  const cancellation = signal || new AbortController().signal
  const meta = await readBookAttachment(id, sessionId),
    chunks: string[] = []
  if (meta.status !== 'ready') throw new Error('附件尚未入库完成，暂时不能重新识别目录')
  for (let index = 0; index < meta.chunks; index++) {
    cancellation.throwIfAborted()
    chunks.push(await call<string>('source', { id, sessionId, index }))
  }
  // 宿主里存的已经是转好的纯文本，文件名换成 .txt 让解析器直接按文本读；书名仍取原文件名
  const file = new File(chunks, meta.filename.replace(/\.[^.]+$/, '') + '.txt', { type: 'text/plain;charset=utf-8' })
  const projectId = await parseAndPublish(
    file,
    cancellation,
    p => progress?.(`${p.stage} ${p.done}/${p.total}`),
    style
  )
  cancellation.throwIfAborted()
  return call<BookAttachment>('finish', {
    id,
    sessionId,
    projectId,
    headingStyle: style,
    expectedRevision: meta.revision
  })
}
