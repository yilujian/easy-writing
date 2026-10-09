import { usesUnifiedStorage } from './storage-mode'
import type { LocalBook } from './local-library-types'
import { encodeDesktopValue, decodeDesktopValue, decodeImageDataUrl } from './desktop-records'

/**
 * 封面在库里存的是附件引用，对外暴露的仍是图片地址。
 *
 * 封面文件读不到时（目录被清、校验失败）按"没有封面"返回，不能让整个书架读不出来；
 * 但引用本身要留住：这里记下读不到的引用，书籍重新落库时原样写回，等附件目录修好
 * 封面就会回来。用户主动换封面（传入新的 data URL）时才替换掉这条引用。
 */
const unreadableCovers = new Map<string, unknown>()
const reported = new Set<string>()

const bookKey = (book: { id?: unknown }) => String(book.id ?? '')

export async function encodeBookAssets(book: LocalBook, unified = usesUnifiedStorage()): Promise<LocalBook> {
  if (!unified) return book
  if (typeof book.coverUrl === 'string' && book.coverUrl.startsWith('data:image/')) {
    const stored = await encodeImportedBookAssets(book, unified)
    unreadableCovers.delete(bookKey(book))
    return stored
  }
  if (!book.coverUrl && unreadableCovers.has(bookKey(book))) {
    return { ...book, coverUrl: unreadableCovers.get(bookKey(book)) as string }
  }
  return book
}

/** An import is authoritative; never reinsert a damaged cover from the current UI's read cache. */
export async function encodeImportedBookAssets(book: LocalBook, unified = usesUnifiedStorage()): Promise<LocalBook> {
  return unified && typeof book.coverUrl === 'string' && book.coverUrl.startsWith('data:image/')
    ? { ...book, coverUrl: (await encodeDesktopValue(book.coverUrl, 'book-cover')) as string }
    : book
}

/** Only changes the transfer copy. The original database record or backup archive remains intact. */
export function prepareBackupBook(book: LocalBook, warn: (message: string) => void): LocalBook {
  if (typeof book.coverUrl === 'string' && book.coverUrl.startsWith('data:image/')) {
    try { decodeImageDataUrl(book.coverUrl) }
    catch {
      warn(`《${book.title}》的封面数据无法解析，已跳过该封面；正文和其他资料继续处理`)
      return { ...book, coverUrl: '' }
    }
  }
  return book
}

export async function decodeBookAssets<T>(book: T, onError?: (error: unknown) => void): Promise<T> {
  if (
    !book ||
    typeof book !== 'object' ||
    !('coverUrl' in book) ||
    !book.coverUrl ||
    typeof book.coverUrl !== 'object'
  )
    return book
  const key = bookKey(book as { id?: unknown })
  try {
    const coverUrl = await decodeDesktopValue(book.coverUrl)
    unreadableCovers.delete(key)
    return { ...book, coverUrl }
  } catch (error) {
    unreadableCovers.set(key, book.coverUrl)
    if (!reported.has(key)) {
      reported.add(key)
      console.warn(`封面文件读取失败，按无封面显示，引用已保留：书籍 ${key}`, error)
    }
    onError?.(error)
    return { ...book, coverUrl: '' }
  }
}
