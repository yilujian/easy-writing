// Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md.
import { getWritingStorage, isTauriRuntime } from '@/storage'
import { saveBlobFile } from '@/utils/download'
import { IndexedDbLocalLibraryStorage } from './indexeddb-local-library'
import { SqliteLocalLibraryStorage } from './sqlite-local-library'
import type {
  LocalExportPayload,
  LocalImportPreview,
  LocalImportResult,
  LocalLibraryStorage,
  LocalParsedBook,
} from './local-library-types'
import {
  buildLocalExportPayload,
  buildLocalTxtExport,
  createLocalImportPreview,
  isLocalEntityId,
  LOCAL_USER_ID,
  nowIso,
  parseLocalTxtBook,
} from './local-library-utils'
import {
  exportLocalBookReference,
  importLocalBookReference,
  summarizeBookReference,
} from './local-reference-transfer'
import { deleteLocalReferenceDoc } from './local-reference-store'
import { deleteLocalChatSessions, listLocalChatSessions } from './local-ai-chat'
import { countWords } from '@/utils/word-count'

let localLibraryStorage: LocalLibraryStorage | null = null

export const getLocalLibraryStorage = () => {
  if (!localLibraryStorage) {
    localLibraryStorage = isTauriRuntime()
      ? new SqliteLocalLibraryStorage()
      : new IndexedDbLocalLibraryStorage()
  }
  return localLibraryStorage
}

const safeFilename = (name: string) => String(name || 'book').replace(/[\\/:*?"<>|]/g, '_')

const formatExportDate = (date: Date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

const wordCountOf = (value: string) => countWords(value)

const readJsonPayload = async (file: File): Promise<LocalExportPayload> => {
  let parsed: LocalExportPayload
  try {
    parsed = JSON.parse(await file.text()) as LocalExportPayload
  } catch {
    throw new Error('本地备份文件格式不正确（不是有效的 JSON）')
  }
  if (parsed?.version !== 1 || !parsed.book || !Array.isArray(parsed.volumes) || !Array.isArray(parsed.chapters)) {
    throw new Error('本地备份文件格式不正确')
  }
  return parsed
}

export const previewLocalBookImport = async (file: File): Promise<LocalImportPreview> => {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (ext === 'json') {
    const backup = await readJsonPayload(file)
    const parsed: LocalParsedBook = {
      title: backup.book.title,
      intro: backup.book.intro || '',
      volumes: backup.volumes.map(volume => ({
        title: volume.title,
        summary: volume.summary || '',
        chapters: backup.chapters
          .filter(chapter => String(chapter.volumeId) === String(volume.id))
          .map(chapter => ({
            title: chapter.title,
            summary: chapter.summary || '',
            textContent: chapter.textContent || '',
            sourceChapterId: Number(chapter.id) || undefined,
          })),
      })).filter(volume => volume.chapters.length),
    }
    const preview = createLocalImportPreview(file.name, parsed)
    if (backup.reference) {
      preview.reference = backup.reference
      const summary = summarizeBookReference(backup.reference)
      if (summary) {
        preview.warnings = [...(preview.warnings || []), `备份含参考数据（${summary}），将一并导入写作台参考面板`]
      }
    }
    return preview
  }
  if (ext !== 'txt') {
    throw new Error('本地模式仅支持 TXT 和 JSON 文件')
  }
  return createLocalImportPreview(file.name, await parseLocalTxtBook(file))
}

export const importLocalBookFromPreview = async (
  preview: LocalImportPreview,
  overrides: { title?: string; intro?: string } = {},
): Promise<LocalImportResult> => {
  const library = getLocalLibraryStorage()
  const writingStorage = getWritingStorage()
  const payload = preview.payload
  const book = await library.createLocalBook({
    title: overrides.title?.trim() || payload.title,
    intro: overrides.intro?.trim() || payload.intro || '',
  })
  const defaultTree = await library.getLocalBookTree(book.id)
  if (defaultTree.length) {
    await library.deleteLocalVolume(defaultTree.map(volume => volume.id))
  }

  let chapterCount = 0
  let totalWordCount = 0
  // 旧章节 id → 新章节 id：参考数据块里的章节引用（事件挂章/节点关联章/锚点）靠它落位
  const chapterIdMap = new Map<string, string>()
  for (const [volumeIndex, volumePayload] of payload.volumes.entries()) {
    const volume = await library.createLocalVolume({
      bookId: book.id,
      title: volumePayload.title || `第${volumeIndex + 1}卷`,
      summary: volumePayload.summary || '',
      sortNo: volumeIndex + 1,
    })
    for (const [chapterIndex, chapterPayload] of volumePayload.chapters.entries()) {
      const textContent = chapterPayload.textContent || ''
      const chapter = await library.createLocalChapter({
        bookId: book.id,
        volumeId: volume.id,
        title: chapterPayload.title || `第${chapterIndex + 1}章`,
        summary: chapterPayload.summary || '',
        sortNo: chapterIndex + 1,
      })
      const wordCount = wordCountOf(textContent)
      await writingStorage.saveChapterLocal({
        userId: LOCAL_USER_ID,
        bookId: String(book.id),
        chapterId: chapter.id,
        title: chapter.title,
        textContent,
        contentJson: null,
        localVersion: 0,
        remoteVersion: 0,
        baseRemoteVersion: 0,
        baseTitle: chapter.title,
        baseTextContent: textContent,
        baseContentJson: null,
        dirty: true,
        conflict: false,
        localOnly: true,
        updatedAt: Date.now(),
      })
      await library.updateLocalChapterContentMeta({ bookId: book.id, chapterId: chapter.id, wordCount })
      if (chapterPayload.sourceChapterId) {
        chapterIdMap.set(String(chapterPayload.sourceChapterId), String(chapter.id))
      }
      chapterCount += 1
      totalWordCount += wordCount
    }
  }

  const warnings = [...(preview.warnings || [])]
  if (preview.reference) {
    await importLocalBookReference(book.id, preview.reference, chapterIdMap)
    const summary = summarizeBookReference(preview.reference)
    if (summary) {
      warnings.push(`参考数据已导入（${summary}）`)
    }
  }

  await library.updateLocalBook({ id: book.id, updateTime: nowIso() })
  return {
    bookId: book.id,
    title: book.title,
    volumeCount: payload.volumes.length,
    chapterCount,
    totalWordCount,
    warnings,
  }
}

export const getLocalBookExportPayload = async (bookId: number | string) => {
  const library = getLocalLibraryStorage()
  const book = await library.getLocalBookDetail(bookId)
  if (!book) throw new Error('本地作品不存在')
  const tree = await library.getLocalBookTree(book.id)
  const volumes = tree.map(volume => {
    const { children: _children, open: _open, ...rest } = volume
    return rest
  })
  const chapters = tree.flatMap(volume => volume.children)
  const payload = await buildLocalExportPayload(book, volumes, chapters)
  const reference = await exportLocalBookReference(book.id)
  if (reference) payload.reference = reference
  return payload
}

export const exportLocalBook = async (bookId: number | string, format: 'txt' | 'json') => {
  const payload = await getLocalBookExportPayload(bookId)
  const book = payload.book
  const exportDate = formatExportDate(new Date())
  if (format === 'json') {
    // 参考面板数据（大纲/角色/设定/时间线/故事线）随 JSON 备份走；TXT 是纯文本装不下
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    return await saveBlobFile(blob, `${safeFilename(book.title)}-${exportDate}.json`)
  }
  const blob = new Blob([await buildLocalTxtExport(payload)], { type: 'text/plain;charset=utf-8' })
  return await saveBlobFile(blob, `${safeFilename(book.title)}-${exportDate}.txt`)
}

// ---------------------------------------------------------------------------
// 章节级导入/导出（写作台目录的「导入/导出章节」，替代原服务端 chapterImport/Export）
// ---------------------------------------------------------------------------

/** 解析 TXT 给出章节导入预览（追加到当前书；形状对齐原服务端 ImportChaptersPreview） */
export const previewLocalChaptersImport = async (file: File) => {
  const parsed = await parseLocalTxtBook(file)
  const chapters = parsed.volumes.flatMap(volume => volume.chapters)
  return {
    filename: file.name,
    volumeCount: parsed.volumes.length,
    chapterCount: chapters.length,
    volumes: parsed.volumes.map(volume => ({ title: volume.title, chapterCount: volume.chapters.length })),
    chaptersPreview: chapters.slice(0, 12).map(chapter => ({
      title: chapter.title,
      wordCount: countWords(chapter.textContent),
    })),
    warnings: chapters.length ? [] : ['未识别到章节，导入时会自动创建第1章'],
    payload: parsed,
  }
}

/** 把解析结果追加进当前书：同名分卷续接章节，其余新建分卷；正文进本地写作库 */
export const importLocalChaptersFromPreview = async (
  bookId: number | string,
  parsed: LocalParsedBook
) => {
  const library = getLocalLibraryStorage()
  const writingStorage = getWritingStorage()
  const book = await library.getLocalBookDetail(bookId)
  if (!book) throw new Error('本地作品不存在')
  const tree = await library.getLocalBookTree(book.id)

  let addedVolumes = 0
  let addedChapters = 0
  let addedWordCount = 0
  const createdChapterIds: number[] = []
  const warnings: string[] = []

  for (const volumePayload of parsed.volumes) {
    const title = volumePayload.title || '第一卷'
    let target = tree.find(volume => volume.title === title)
    let nextSortNo = target ? target.children.length : 0
    if (!target) {
      const created = await library.createLocalVolume({
        bookId: book.id,
        title,
        summary: volumePayload.summary || '',
        sortNo: tree.length + addedVolumes + 1,
      })
      addedVolumes += 1
      target = { ...created, children: [] }
      nextSortNo = 0
    }
    for (const chapterPayload of volumePayload.chapters) {
      nextSortNo += 1
      const textContent = chapterPayload.textContent || ''
      const chapter = await library.createLocalChapter({
        bookId: book.id,
        volumeId: target.id,
        title: chapterPayload.title || `第${nextSortNo}章`,
        summary: chapterPayload.summary || '',
        sortNo: nextSortNo,
      })
      const wordCount = countWords(textContent)
      await writingStorage.saveChapterLocal({
        userId: LOCAL_USER_ID,
        bookId: String(book.id),
        chapterId: chapter.id,
        title: chapter.title,
        textContent,
        contentJson: null,
        localVersion: 0,
        remoteVersion: 0,
        baseRemoteVersion: 0,
        baseTitle: chapter.title,
        baseTextContent: textContent,
        baseContentJson: null,
        dirty: true,
        conflict: false,
        localOnly: true,
        updatedAt: Date.now(),
      })
      await library.updateLocalChapterContentMeta({
        bookId: book.id,
        chapterId: chapter.id,
        wordCount,
      })
      addedChapters += 1
      addedWordCount += wordCount
      createdChapterIds.push(chapter.id)
    }
  }

  const updatedBook = await library.getLocalBookDetail(book.id)
  return {
    bookId: Number(book.id),
    addedVolumes,
    addedChapters,
    addedWordCount,
    updatedBookWordCount: Number(updatedBook?.wordCount || 0),
    createdChapterIds,
    warnings,
  }
}

/** 选章导出为 TXT（多章按目录顺序合并为一个文件） */
export const exportLocalChaptersTxt = async (
  bookId: number | string,
  chapterIds: number[]
) => {
  const library = getLocalLibraryStorage()
  const writingStorage = getWritingStorage()
  const book = await library.getLocalBookDetail(bookId)
  if (!book) throw new Error('本地作品不存在')
  const tree = await library.getLocalBookTree(book.id)
  const wanted = new Set(chapterIds.map(Number))
  const lines: string[] = []
  let picked = 0
  for (const volume of tree) {
    const chapters = volume.children.filter(chapter => wanted.has(Number(chapter.id)))
    if (!chapters.length) continue
    lines.push(volume.title, '')
    for (const chapter of chapters) {
      const draft = await writingStorage.getChapterByIdentity(LOCAL_USER_ID, book.id, chapter.id)
      lines.push(chapter.title, '', draft?.textContent || '', '')
      picked += 1
    }
  }
  if (!picked) throw new Error('所选章节不存在')
  const exportDate = formatExportDate(new Date())
  const suffix = picked === 1 ? '' : '-章节合并'
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  return await saveBlobFile(blob, `${safeFilename(book.title)}-${exportDate}${suffix}.txt`)
}

/**
 * 回收站"彻底删除"：书+卷+章、全部正文与历史版本、参考数据、AI 问答记录一并清除，无法恢复。
 * 码字账本（劳动记录）与磁盘备份文件不动。
 */
export const purgeLocalBookCompletely = async (bookId: number | string) => {
  const storage = getLocalLibraryStorage()
  await getWritingStorage().purgeBookDrafts(bookId)
  await deleteLocalReferenceDoc(bookId)
  const { data: sessions } = await listLocalChatSessions({ bookId: String(bookId) })
  if (sessions.length) await deleteLocalChatSessions({ ids: sessions.map(session => session.id) })
  await storage.purgeLocalBook([Number(bookId)])
}

export { isLocalEntityId, LOCAL_USER_ID }
export type * from './local-library-types'
