import { appSettings } from '@/storage/app-settings'
/**
 * 写作位置记忆（本机）：每章记住光标位置与滚动偏移，进入章节时恢复。
 *
 * - 只关心本机体验，通过统一设置存储保存一张小表；上次编辑的章节存在书记录里（随备份走）。
 * - 记录同时保存当时的文档长度：正文若被 AI 重写、版本回退或备份覆盖过，
 *   旧坐标就不再可信，恢复时退到章末而不是硬套。
 * - 三十天没碰的记录自动清理，表体积有上界。
 */

export interface WritingPosition {
  pos: number
  scrollTop: number
  /** 记录时的 ProseMirror 文档长度（doc.content.size），用于判断正文是否大幅变动 */
  docSize: number
  updatedAt: string
}

type PositionMap = Record<string, Record<string, WritingPosition>>

const STORAGE_KEY = 'ew-writing-positions'
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const loadMap = (): PositionMap => {
  try {
    const parsed = JSON.parse(appSettings.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as PositionMap) : {}
  } catch {
    return {}
  }
}

const saveMap = (map: PositionMap) => {
  try {
    appSettings.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch (error) {
    console.warn('写入写作位置记录失败', error)
  }
}

const prune = (map: PositionMap, now: number) => {
  for (const [bookId, chapters] of Object.entries(map)) {
    for (const [chapterId, record] of Object.entries(chapters)) {
      if (now - Date.parse(record.updatedAt || '') > RETENTION_MS) delete chapters[chapterId]
    }
    if (!Object.keys(chapters).length) delete map[bookId]
  }
}

const clampInt = (value: unknown) => Math.max(0, Math.round(Number(value) || 0))

export const saveWritingPosition = (
  bookId: string | number,
  chapterId: string | number,
  position: { pos: number; scrollTop: number; docSize: number },
  now = Date.now()
) => {
  const map = loadMap()
  prune(map, now)
  const chapters = (map[String(bookId)] ||= {})
  chapters[String(chapterId)] = {
    pos: clampInt(position.pos),
    scrollTop: clampInt(position.scrollTop),
    docSize: clampInt(position.docSize),
    updatedAt: new Date(now).toISOString(),
  }
  saveMap(map)
}

export const readWritingPosition = (bookId: string | number, chapterId: string | number): WritingPosition | null => {
  const record = loadMap()[String(bookId)]?.[String(chapterId)]
  if (!record || typeof record.pos !== 'number') return null
  return record
}

/** 正文长度变化超过阈值就视为漂移：旧坐标不再可信，恢复时应退到章末 */
export const isWritingPositionDrifted = (record: WritingPosition, currentDocSize: number) =>
  Math.abs(currentDocSize - record.docSize) > Math.max(200, record.docSize * 0.2)

export const forgetWritingPosition = (bookId: string | number, chapterId?: string | number) => {
  const map = loadMap()
  const key = String(bookId)
  if (chapterId === undefined) delete map[key]
  else if (map[key]) {
    delete map[key][String(chapterId)]
    if (!Object.keys(map[key]).length) delete map[key]
  }
  saveMap(map)
}
