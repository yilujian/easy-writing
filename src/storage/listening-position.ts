import { appSettings } from '@/storage/app-settings'
import {
  LISTENING_LAST_BOOK_KEY,
  LISTENING_POSITION_MAX_BOOKS,
  LISTENING_POSITION_RETENTION_MS,
  LISTENING_POSITIONS_KEY
} from '@/config/listening'
import type { ChapterScript, ListeningPosition } from '@/types/listening'

type PositionMap = Record<string, ListeningPosition>

const readMap = (): PositionMap => {
  try {
    const raw = appSettings.getItem(LISTENING_POSITIONS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PositionMap) : {}
  } catch (error) {
    console.warn('读取听书位置失败', error)
    return {}
  }
}

const writeMap = (map: PositionMap) => {
  try {
    appSettings.setItem(LISTENING_POSITIONS_KEY, JSON.stringify(map))
  } catch (error) {
    console.warn('保存听书位置失败', error)
  }
}

const pruneMap = (map: PositionMap, now: number) => {
  const records = Object.entries(map)
    .filter(([, record]) => record && Number.isFinite(Number(record.updatedAt)))
    .sort((a, b) => Number(b[1].updatedAt) - Number(a[1].updatedAt))
  const kept = new Set<string>()
  records.forEach(([bookId, record], index) => {
    const expired = now - Number(record.updatedAt) > LISTENING_POSITION_RETENTION_MS
    if (expired || index >= LISTENING_POSITION_MAX_BOOKS) {
      delete map[bookId]
    } else {
      kept.add(bookId)
    }
  })
  for (const bookId of Object.keys(map)) {
    if (!kept.has(bookId)) delete map[bookId]
  }
}

export const readListeningPosition = (bookId: string | number): ListeningPosition | null => {
  const record = readMap()[String(bookId)]
  if (!record || !Number.isFinite(Number(record.chapterId))) return null
  return {
    ...record,
    bookId: String(record.bookId || bookId),
    chapterId: Number(record.chapterId),
    segmentIndex: Math.max(0, Math.round(Number(record.segmentIndex) || 0)),
    charOffset: Math.max(0, Math.round(Number(record.charOffset) || 0)),
    textLength: Math.max(0, Math.round(Number(record.textLength) || 0)),
    signature: String(record.signature || ''),
    snippet: String(record.snippet || ''),
    updatedAt: Number(record.updatedAt) || 0
  }
}

export const saveListeningPosition = (position: ListeningPosition, now = Date.now()) => {
  const map = readMap()
  map[String(position.bookId)] = { ...position, bookId: String(position.bookId), updatedAt: now }
  pruneMap(map, now)
  writeMap(map)
}

export const forgetListeningPosition = (bookId: string | number) => {
  const map = readMap()
  delete map[String(bookId)]
  writeMap(map)
}

export const readLastListeningBook = (): string => {
  try {
    return String(appSettings.getItem(LISTENING_LAST_BOOK_KEY) || '')
  } catch {
    return ''
  }
}

export const saveLastListeningBook = (bookId: string | number) => {
  try {
    appSettings.setItem(LISTENING_LAST_BOOK_KEY, String(bookId))
  } catch (error) {
    console.warn('保存最近听书记录失败', error)
  }
}

/**
 * 正文变了以后按 snippet 重定位：先找完整句，再按偏移找最近的句子。
 * 找不到就回章首，宁可多听一句，也不要从错误段落开始。
 */
export const resolveResumeSegment = (script: ChapterScript, position: ListeningPosition | null): number => {
  if (!position || !script.segments.length) return 0
  if (position.signature === script.signature) {
    return Math.min(position.segmentIndex, script.segments.length - 1)
  }
  const snippet = String(position.snippet || '').replace(/\s+/g, '')
  if (snippet) {
    const found = script.segments.findIndex(segment => {
      const display = segment.displayText.replace(/\s+/g, '')
      const speech = segment.text.replace(/\s+/g, '')
      return display.includes(snippet) || speech.includes(snippet)
    })
    if (found >= 0) return found
  }
  const offset = Math.max(0, Number(position.charOffset) || 0)
  const byOffset = script.segments.findIndex(segment => offset >= segment.start && offset < segment.end)
  if (byOffset >= 0) return byOffset
  if (offset >= script.textLength) return script.segments.length - 1
  return 0
}
