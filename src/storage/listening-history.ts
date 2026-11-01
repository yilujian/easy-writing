import { appSettings } from '@/storage/app-settings'
import { LISTENING_FINISHED_KEY as KEY } from '@/config/listening'

/**
 * 已听章节：只用于目录里的完成标记，不是权威进度。
 * 按书存一组章节 id，最多保留 2,000 个，随 `ew-` 前缀进入整包备份。
 */
const MAX_CHAPTERS = 2000

type FinishedMap = Record<string, number[]>

const readMap = (): FinishedMap => {
  try {
    const parsed: unknown = JSON.parse(appSettings.getItem(KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FinishedMap) : {}
  } catch {
    return {}
  }
}

const writeMap = (map: FinishedMap) => {
  try {
    appSettings.setItem(KEY, JSON.stringify(map))
  } catch (error) {
    console.warn('保存已听章节失败', error)
  }
}

export const readFinishedChapterIds = (bookId: string | number): number[] => {
  const ids = readMap()[String(bookId)]
  return Array.isArray(ids) ? ids.filter(id => Number.isFinite(Number(id))).map(Number) : []
}

export const markChapterFinished = (bookId: string | number, chapterId: number) => {
  const map = readMap()
  const key = String(bookId)
  const ids = new Set([...(map[key] || []), Number(chapterId)])
  map[key] = [...ids].slice(-MAX_CHAPTERS)
  writeMap(map)
}

export const clearFinishedChapters = (bookId: string | number) => {
  const map = readMap()
  delete map[String(bookId)]
  writeMap(map)
}
