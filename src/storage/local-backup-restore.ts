import { getWritingStorage, normalizeLocalChapterDraft } from '@/storage'
import { getLocalLibraryStorage, LOCAL_USER_ID, purgeLocalBookCompletely } from './local-library'
import { importLocalBookReference } from './local-reference-transfer'
import { createLocalEntityId, parseTxtHeadingNo } from './local-library-utils'
import { countWords } from '@/utils/word-count'
import type { BackupRestoreBook, BackupRestoreChapter, BackupRestorePreview, BackupRestoreResult, BackupScan } from '@/types/backup-restore'

const folder = (name: string, id?: string) => {
  if (id && name.endsWith(`_${id}`)) return name.slice(0, -id.length - 1)
  return name.replace(/_-?\d+$/, '')
}
const folderId = (name: string) => name.match(/_(-?\d+)$/)?.[1]
const fileDate = (filename: string) => {
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime() || 0 : 0
}
/** 备份里记录的目录位置；缺失、非正数一律当作没有 */
const orderOf = (value: unknown) => {
  const numeric = Number(value)
  return value != null && Number.isFinite(numeric) && numeric > 0 ? numeric : null
}
/** 两边都有位置信息才比较；任一缺失就交给后面的标题排序 */
const orderCompare = (a: number | null, b: number | null) => (a != null && b != null ? a - b : 0)
const headingNo = (title: string) => {
  const m = title.match(/^第([零一二三四五六七八九十百千万两\d]+)[卷部篇章节回]/)
  return m ? parseTxtHeadingNo(m[1]) : null
}
const titleOrder = (a: string, b: string) => {
  const x = headingNo(a), y = headingNo(b)
  return x != null && y != null ? x - y : a.localeCompare(b, 'zh-CN', { numeric: true })
}

export function buildBackupRestorePreview(scan: BackupScan): BackupRestorePreview {
  const books = new Map<string, BackupRestoreBook>()
  const warnings = [...scan.warnings]
  const getBook = (id: string, title: string, date: number) => {
    let book = books.get(id)
    if (!book) {
      book = { sourceId: id, title, chapters: [], referenceAt: 0, latestAt: date }
      books.set(id, book)
    } else if (date >= book.latestAt) { book.title = title; book.latestAt = date }
    return book
  }
  for (const file of scan.files) {
    const parts = file.path.replace(/\\/g, '/').split('/')
    const filename = parts[parts.length - 1] || ''
    const parent = parts[parts.length - 2] || ''
    try {
      if (filename.endsWith('.json')) {
        const data = JSON.parse(file.content)
        if (!data || data.bookId == null) throw new Error('缺少作品标识')
        const bookId = String(data.bookId)
        if (data.reference && data.version === 1) {
          const date = Date.parse(data.exportedAt) || fileDate(filename)
          const book = getBook(bookId, String(data.bookTitle || folder(parts[parts.length - 3] || '', bookId) || '未命名作品'), date)
          if (date >= book.referenceAt) { book.reference = data.reference; book.referenceAt = date }
          continue
        }
        if (data.chapterId == null || data.volumeId == null || typeof data.textContent !== 'string' || typeof data.title !== 'string') {
          throw new Error('不是有效的章节备份')
        }
        const date = Number(data.backupAt) || fileDate(filename)
        const book = getBook(bookId, folder(parts[parts.length - 4] || '', bookId) || '未命名作品', date)
        const contentJson = data.contentJson?.type === 'doc' ? data.contentJson : null
        if (data.contentJson && !contentJson) warnings.push(`${file.path}：排版数据无效，仅恢复正文`)
        addChapter(book, {
          sourceId: String(data.chapterId), volumeId: String(data.volumeId),
          volumeTitle: folder(parts[parts.length - 3] || '', String(data.volumeId)) || '默认分卷',
          title: data.title, textContent: data.textContent, contentJson, backupAt: date, sourcePath: file.path,
          orderNo: orderOf(data.orderNo), volumeOrderNo: orderOf(data.volumeOrderNo),
        })
      } else {
        const volumeFolder = parts[parts.length - 3] || '', bookFolder = parts[parts.length - 4] || ''
        const bookId = folderId(bookFolder), volumeId = folderId(volumeFolder), chapterId = folderId(parent)
        if (!bookId || !volumeId || !chapterId) throw new Error('TXT 缺少作品/分卷/章节目录，无法确定归属')
        const date = fileDate(filename)
        const book = getBook(bookId, folder(bookFolder, bookId), date)
        addChapter(book, { sourceId: chapterId, volumeId, volumeTitle: folder(volumeFolder, volumeId),
          title: folder(parent, chapterId), textContent: file.content, contentJson: null, backupAt: date, sourcePath: file.path,
          orderNo: null, volumeOrderNo: null })
        warnings.push(`${file.path}：使用 TXT 恢复正文，原排版无法恢复`)
      }
    } catch (error) {
      warnings.push(`跳过 ${file.path}：${error instanceof Error ? error.message : '格式不正确'}`)
    }
  }
  if ([...books.values()].some(book => book.chapters.some(chapter => chapter.orderNo == null))) {
    warnings.push('部分旧备份未记录章节顺序，只能按标题章号恢复，请核对目录；原备份文件不会被修改。')
  }
  for (const book of books.values()) {
    const volumes = new Map<string, BackupRestoreChapter>()
    for (const chapter of book.chapters) {
      const current = volumes.get(chapter.volumeId)
      if (!current || chapter.backupAt > current.backupAt) volumes.set(chapter.volumeId, chapter)
    }
    for (const chapter of book.chapters) {
      const latest = volumes.get(chapter.volumeId)!
      chapter.volumeTitle = latest.volumeTitle
      chapter.volumeOrderNo = latest.volumeOrderNo
    }
    // 优先用备份里记的目录位置（新备份都有），没有才退回按标题章号排序
    book.chapters.sort((a, b) => orderCompare(a.volumeOrderNo, b.volumeOrderNo)
      || titleOrder(a.volumeTitle, b.volumeTitle) || a.volumeId.localeCompare(b.volumeId)
      || orderCompare(a.orderNo, b.orderNo)
      || titleOrder(a.title, b.title) || a.sourceId.localeCompare(b.sourceId, undefined, { numeric: true }))
  }
  return { books: [...books.values()].filter(book => book.chapters.length || book.reference).sort((a, b) => titleOrder(a.title, b.title)), warnings }
}

function addChapter(book: BackupRestoreBook, chapter: BackupRestoreChapter) {
  // 同章改名或移动后会留下旧目录，按原章节 ID 合并，并采用较新的版本。
  const index = book.chapters.findIndex(item => item.sourceId === chapter.sourceId)
  if (index < 0) book.chapters.push(chapter)
  else if (chapter.backupAt > book.chapters[index].backupAt || (chapter.backupAt === book.chapters[index].backupAt && chapter.contentJson)) {
    book.chapters[index] = chapter
  }
}

export async function scanBackupDirectory(directory: string): Promise<BackupRestorePreview> {
  const { invoke } = await import('@tauri-apps/api/core')
  return buildBackupRestorePreview(await invoke<BackupScan>('scan_backup_directory', { directory }))
}

export async function restoreBackupBook(source: BackupRestoreBook): Promise<BackupRestoreResult> {
  if (!source.chapters.length && !source.reference) throw new Error('该作品没有可恢复的数据')
  const library = getLocalLibraryStorage()
  const writing = getWritingStorage()
  const bookId = createLocalEntityId()
  const title = `${source.title}（恢复）`
  try {
    const book = await library.createLocalBook({ id: bookId, title })
    const defaults = await library.getLocalBookTree(book.id)
    if (defaults.length) await library.deleteLocalVolume(defaults.map(volume => volume.id))
    const volumes = new Map<string, number>()
    const chapterMap = new Map<string, string>()
    const chapterCounts = new Map<string, number>()
    for (const item of source.chapters) {
      let volumeId = volumes.get(item.volumeId)
      if (volumeId == null) {
        const volume = await library.createLocalVolume({ bookId: book.id, title: item.volumeTitle, sortNo: volumes.size + 1 })
        volumeId = volume.id
        volumes.set(item.volumeId, volumeId)
      }
      const sortNo = (chapterCounts.get(item.volumeId) || 0) + 1
      chapterCounts.set(item.volumeId, sortNo)
      const chapter = await library.createLocalChapter({ bookId: book.id, volumeId, title: item.title, sortNo })
      await writing.saveChapterLocal(normalizeLocalChapterDraft({
        userId: LOCAL_USER_ID, bookId: String(book.id), chapterId: chapter.id, title: item.title,
        textContent: item.textContent, contentJson: item.contentJson,
        localVersion: 1, remoteVersion: 0, baseRemoteVersion: 0, baseTitle: item.title,
        baseTextContent: item.textContent, baseContentJson: item.contentJson,
        dirty: true, conflict: false, localOnly: true, updatedAt: Date.now(),
      }))
      await library.updateLocalChapterContentMeta({ bookId: book.id, chapterId: chapter.id, wordCount: countWords(item.textContent) })
      chapterMap.set(item.sourceId, String(chapter.id))
    }
    if (source.reference) await importLocalBookReference(book.id, source.reference, chapterMap)
    return { bookId: book.id, title: book.title, chapterCount: source.chapters.length }
  } catch (error) {
    // 只清理本次新建作品；原书与磁盘备份从未被写入。
    try { await purgeLocalBookCompletely(bookId) }
    catch { throw new Error(`恢复失败，未完成的《${title}》仍在书架，请检查后重试`) }
    throw new Error(`恢复失败，已撤回本次新建作品：${error instanceof Error ? error.message : String(error)}`)
  }
}
