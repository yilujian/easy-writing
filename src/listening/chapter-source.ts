import { getLocalLibraryStorage, LOCAL_USER_ID } from '@/storage/local-library'
import { getWritingStorage } from '@/storage'
import { buildChapterScript } from '@/listening/text/chapter-script'
import type { ChapterScript, ListenBook, ListenChapterRef } from '@/types/listening'

export interface ListenBookSource {
  book: ListenBook
  chapters: ListenChapterRef[]
}

/**
 * 听书只读消费本地书库和正文草稿：
 * - 目录来自 local_books / local_volumes / local_chapters；
 * - 正文来自 chapter drafts 的 textContent（与编辑器 getText 的换行口径一致）。
 */
export const loadListenBook = async (bookId: string | number): Promise<ListenBookSource> => {
  const library = getLocalLibraryStorage()
  const detail = await library.getLocalBookDetail(bookId)
  if (!detail) throw new Error('作品不存在或已被删除')
  const tree = await library.getLocalBookTree(bookId)
  const chapters: ListenChapterRef[] = []
  tree.forEach(volume => {
    volume.children.forEach(chapter => {
      chapters.push({
        id: Number(chapter.id),
        title: chapter.title || '未命名章节',
        volumeId: String(volume.id),
        volumeTitle: volume.title || '未分卷',
        wordCount: Number(chapter.wordCount) || 0,
        sortNo: Number(chapter.sortNo) || 0,
      })
    })
  })
  return {
    book: {
      id: Number(detail.id),
      title: detail.title || '未命名作品',
      intro: String(detail.intro || ''),
      coverUrl: String(detail.coverUrl || ''),
      tags: Array.isArray(detail.tags) ? detail.tags.filter(Boolean) : [],
      author: detail.authorId ? String(detail.authorId) : undefined,
    },
    chapters,
  }
}

export const loadChapterText = async (
  bookId: string | number,
  chapterId: number
): Promise<string> => {
  const draft = await getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, bookId, chapterId)
  return String(draft?.textContent || '')
}

export const loadListenChapterScript = async (params: {
  bookId: string | number
  chapterId: number
  title: string
  readTitle: boolean
}): Promise<ChapterScript> => {
  const text = await loadChapterText(params.bookId, params.chapterId)
  return buildChapterScript({
    chapterId: params.chapterId,
    title: params.title,
    text,
    readTitle: params.readTitle,
  })
}
