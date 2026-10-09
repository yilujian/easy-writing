import type { StoredLocalChapterDraft } from './writing-storage'

export class StorageRecordCorruptError extends Error {
  constructor(label: string) {
    super(`${label}读取失败：数据格式损坏，已停止覆盖保存。原记录仍保留，请重试读取，或通过备份恢复。`)
    this.name = 'StorageRecordCorruptError'
  }
}

export function parseStoredRecord<T>(raw: unknown, label: string): T {
  try {
    const value: unknown = JSON.parse(String(raw))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record')
    return value as T
  } catch {
    throw new StorageRecordCorruptError(label)
  }
}

export function validateStoredChapter(value: unknown, key?: string): StoredLocalChapterDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageRecordCorruptError('章节正文')
  const chapter = value as StoredLocalChapterDraft
  const document = chapter.contentJson as { type?: unknown; content?: unknown } | null | undefined
  if (typeof chapter.textContent !== 'string' || (chapter.title !== undefined && typeof chapter.title !== 'string')
    || typeof chapter.userId !== 'string' || !['string', 'number'].includes(typeof chapter.bookId)
    || !Number.isSafeInteger(chapter.chapterId) || chapter.chapterId === 0
    || (key !== undefined && `${chapter.userId}:${chapter.bookId}:${chapter.chapterId}` !== key)
    || (chapter.contentJson != null && (typeof chapter.contentJson !== 'object'
      || document?.type !== 'doc' || (document?.content !== undefined && !Array.isArray(document.content)))))
    throw new StorageRecordCorruptError(`章节 ${key ?? chapter.chapterId ?? ''}`)
  // Some early drafts omit the title; the catalog owns their display title. Never invent missing body text.
  return chapter.title === undefined ? { ...chapter, title: '' } : chapter
}

export const parseStoredChapter = (raw: unknown, key?: string) =>
  validateStoredChapter(parseStoredRecord(raw, '章节正文'), key)

export function parseStoredEntity<T>(raw: unknown, label: string): T {
  const record = parseStoredRecord<Record<string, unknown>>(raw, label)
  if (!Number.isSafeInteger(record.id) || record.id === 0 || typeof record.title !== 'string')
    throw new StorageRecordCorruptError(label)
  return record as T
}
