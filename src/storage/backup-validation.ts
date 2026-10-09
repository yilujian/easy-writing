import type { LocalLibraryDump } from './local-library-types'
import type { WritingStorageDump } from './writing-storage'
import type { FullBackupManifest } from './full-backup'
import type { ImportedFont } from '@/types/imported-font'

const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown) =>
  (typeof v === 'number' || typeof v === 'string') &&
  v !== '' &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) !== 0
function requireArray(value: unknown, label: string): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !object(item)))
    throw new Error(`备份数据结构无效：${label}，未修改本机数据`)
}
export function validateBackupData(
  library: LocalLibraryDump,
  writing: WritingStorageDump,
  settings: Record<string, string>,
  fonts: ImportedFont[],
  manifest: FullBackupManifest
) {
  if (!object(library) || !object(writing) || !object(settings))
    throw new Error('备份数据结构无效，未修改本机数据')
  for (const field of ['groups', 'books', 'volumes', 'chapters'] as const) {
    const list = library[field]
    requireArray(list, `library.${field}`)
    const seen = new Set<number>()
    for (const item of list) {
      if (!id(item.id) || seen.has(Number(item.id)) || typeof item.title !== 'string')
        throw new Error(`备份标识或标题无效：library.${field}`)
      seen.add(Number(item.id))
    }
  }
  const books = new Set(library.books.map(v => String(v.id)))
  const volumes = new Map(library.volumes.map(v => [String(v.id), String(v.bookId)]))
  for (const volume of library.volumes)
    if (!books.has(String(volume.bookId))) throw new Error('备份分卷缺少所属书籍')
  for (const chapter of library.chapters)
    if (
      !books.has(String(chapter.bookId)) ||
      volumes.get(String(chapter.volumeId)) !== String(chapter.bookId)
    )
      throw new Error('备份章节的书籍或分卷关联无效')
  for (const field of ['chapters', 'versions', 'settings'] as const)
    requireArray(writing[field], `writing.${field}`)
  for (const chapter of writing.chapters)
    if (
      !id(chapter.chapterId) ||
      !id(chapter.bookId) ||
      typeof chapter.userId !== 'string' ||
      typeof chapter.textContent !== 'string'
    )
      throw new Error('备份正文记录无效')
  for (const version of writing.versions)
    if (typeof version.id !== 'string' || !id(version.chapterId) || !Number.isFinite(version.createdAt))
      throw new Error('备份历史版本无效')
  for (const setting of writing.settings)
    if (typeof setting.key !== 'string' || typeof setting.value !== 'string')
      throw new Error('备份写作设置无效')
  for (const [key, value] of Object.entries(settings))
    if (!key.startsWith('ew-') || typeof value !== 'string') throw new Error('备份本地设置无效')
  requireArray(fonts, 'fonts')
  if (
    fonts.some(font => typeof font.id !== 'string' || !font.id || typeof font.name !== 'string') ||
    new Set(fonts.map(f => f.id)).size !== fonts.length
  )
    throw new Error('备份字体记录无效')
  const actual = {
    groups: library.groups.length,
    books: library.books.filter(v => !v.deletedAt).length,
    volumes: library.volumes.length,
    chapters: library.chapters.filter(v => !v.deletedAt).length,
    drafts: writing.chapters.length,
    versions: writing.versions.length,
    fonts: fonts.length,
    localStorageKeys: Object.keys(settings).length
  }
  for (const key of Object.keys(actual) as Array<keyof typeof actual>)
    if (manifest.counts?.[key] !== actual[key]) throw new Error(`备份数量校验失败：${key}，未修改本机数据`)
}
