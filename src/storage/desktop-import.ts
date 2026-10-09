import type { LocalLibraryDump } from './local-library-types'
import {
  normalizeLocalBook,
  normalizeLocalChapter,
  normalizeLocalGroup,
  normalizeLocalVolume
} from './local-library-utils'
import {
  buildChapterStorageKey,
  normalizeLocalChapterDraft,
  type WritingStorageDump
} from './writing-storage'
import { countWords, countTextWords } from '@/utils/word-count'
export interface SqlStatement {
  sql: string
  params: unknown[]
}
const insert = (table: string, columns: string[], params: unknown[]): SqlStatement => ({
  sql: `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  params
})
export function libraryImportStatements(dump: LocalLibraryDump, replace: boolean): SqlStatement[] {
  const out: SqlStatement[] = replace
    ? ['local_chapters', 'local_volumes', 'local_books', 'local_book_groups'].map(table => ({
        sql: `DELETE FROM ${table}`,
        params: []
      }))
    : []
  for (const item of dump.groups) {
    const v = normalizeLocalGroup(item)
    out.push(
      insert(
        'local_book_groups',
        ['id', 'payload', 'deletedAt', 'sortNo'],
        [v.id, JSON.stringify(v), v.deletedAt ?? null, v.sortNo]
      )
    )
  }
  for (const item of dump.books) {
    const v = normalizeLocalBook(item)
    out.push(
      insert(
        'local_books',
        ['id', 'payload', 'title', 'groupId', 'mergeStatus', 'deletedAt', 'updateTime'],
        [
          v.id,
          JSON.stringify(v),
          v.title,
          v.groupId ?? null,
          v.mergeStatus,
          v.deletedAt ?? null,
          v.updateTime
        ]
      )
    )
  }
  for (const item of dump.volumes) {
    const v = normalizeLocalVolume(item)
    out.push(
      insert(
        'local_volumes',
        ['id', 'bookId', 'payload', 'deletedAt', 'sortNo'],
        [v.id, v.bookId, JSON.stringify(v), v.deletedAt ?? null, v.sortNo]
      )
    )
  }
  for (const item of dump.chapters) {
    const v = normalizeLocalChapter(item)
    out.push(
      insert(
        'local_chapters',
        ['id', 'bookId', 'volumeId', 'payload', 'deletedAt', 'sortNo'],
        [v.id, v.bookId, v.volumeId, JSON.stringify(v), v.deletedAt ?? null, v.sortNo]
      )
    )
  }
  return out
}
export function writingImportStatements(dump: WritingStorageDump, replace: boolean): SqlStatement[] {
  const out: SqlStatement[] = replace
    ? ['chapter_contents', 'chapter_versions', 'sync_settings'].map(table => ({
        sql: `DELETE FROM ${table}`,
        params: []
      }))
    : []
  for (const chapter of dump.chapters) {
    const normalized = normalizeLocalChapterDraft(chapter)
    const v = {
      ...normalized,
      storageKey: buildChapterStorageKey(normalized.userId, normalized.bookId, normalized.chapterId),
      lastBackedUpAt: Number(chapter.lastBackedUpAt || 0)
    }
    out.push(
      insert(
        'chapter_contents',
        [
          'storageKey',
          'userId',
          'bookId',
          'chapterId',
          'payload',
          'dirty',
          'conflict',
          'updatedAt',
          'lastBackedUpAt',
          'wordCount',
          'textWordCount'
        ],
        [
          v.storageKey,
          v.userId,
          v.bookId,
          v.chapterId,
          JSON.stringify(v),
          v.dirty ? 1 : 0,
          v.conflict ? 1 : 0,
          v.updatedAt,
          v.lastBackedUpAt,
          countWords(v.textContent),
          countTextWords(v.textContent)
        ]
      )
    )
  }
  for (const v of dump.versions)
    out.push(
      insert(
        'chapter_versions',
        ['id', 'payload', 'chapterId', 'createdAt'],
        [v.id, JSON.stringify(v), v.chapterId, v.createdAt]
      )
    )
  for (const v of dump.settings) out.push(insert('sync_settings', ['key', 'value'], [v.key, v.value]))
  return out
}
