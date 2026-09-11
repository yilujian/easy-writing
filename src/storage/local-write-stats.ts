import dayjs from 'dayjs'
import { readUiPreferences } from '@/stores/ui-preferences'
import type { WordCountMode } from '@/types/ui-preferences'

/**
 * 本地码字统计：替代旧服务端 /writing/statistics 三接口的数据源。
 *
 * 记账方式：写作台每次落盘章节时上报该章最新字数，这里与上一次基线求差，
 * 正向增量记入「当天 × 书」的账本（净增口径：删 100 再写 100 会记 100）。
 * 章节首次见到时只建基线不记账，避免把存量章节的全文算成当天码字。
 *
 * 存储：localStorage 单键 JSON。数据量小（每天每本书一条数字），
 * 桌面端 WebView 的 localStorage 同样跟随应用数据目录持久化。
 *
 * AI 记账：AI 文字进正文的口子各自调 recordAiWordsAdded（编辑器内插字）或
 * recordAiChapterLanding（工作流整章落稿）。两者都会同步抬高该章基线，
 * 编辑器随后的自动落盘按基线求差时就只剩手写部分，不会双记。
 */

export interface LocalStatsDayItem {
  date: string
  words: number | null
  manualWords: number | null
  aiWords: number | null
}

export interface LocalStatsOverview {
  date: string
  targetWords: number
  manualTargetWords: number
  aiTargetWords: number
  todayWords: number | null
  manualWords: number | null
  aiWords: number | null
}

export interface LocalStatsTrend {
  days: number
  startDate: string
  endDate: string
  totalWords: number | null
  totalManualWords: number | null
  totalAiWords: number | null
  list: LocalStatsDayItem[]
}

export interface LocalStatsCalendar {
  month: string
  monthTotalWords: number | null
  monthManualWords: number | null
  monthAiWords: number | null
  monthAvgWords: number | null
  monthManualAvgWords: number | null
  monthAiAvgWords: number | null
  list: LocalStatsDayItem[]
}

interface DayBookRecord {
  manual: number
  ai: number
  // 缺失表示该日有旧口径记录，无法精确回算；不得以新记录补成完整历史。
  textManual?: number
  textAi?: number
}

interface StatsFile {
  version: 1
  targets: { manual: number; ai: number }
  /** days['YYYY-MM-DD'][bookId] = 当天该书的净增字数 */
  days: Record<string, Record<string, DayBookRecord>>
  /** 每章最近一次落盘的字数基线；key = `${bookId}:${chapterId}` */
  chapterBase: Record<string, number>
  chapterTextBase: Record<string, number>
}

const STORAGE_KEY = 'ew-local-write-stats'
const DEFAULT_DAILY_TARGET = 4000
const MAX_DAY_RECORDS = 400

const emptyFile = (): StatsFile => ({
  version: 1,
  targets: { manual: DEFAULT_DAILY_TARGET, ai: DEFAULT_DAILY_TARGET },
  days: {},
  chapterBase: {},
  chapterTextBase: {}
})

const loadFile = (): StatsFile => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyFile()
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 1) return emptyFile()
    return {
      version: 1,
      targets: {
        manual: Number(parsed.targets?.manual) >= 0 ? Number(parsed.targets.manual) : DEFAULT_DAILY_TARGET,
        ai: Number(parsed.targets?.ai) >= 0 ? Number(parsed.targets.ai) : DEFAULT_DAILY_TARGET
      },
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      chapterBase: parsed.chapterBase && typeof parsed.chapterBase === 'object' ? parsed.chapterBase : {},
      chapterTextBase:
        parsed.chapterTextBase && typeof parsed.chapterTextBase === 'object' ? parsed.chapterTextBase : {}
    }
  } catch (error) {
    console.warn('读取本地码字统计失败，重建空账本', error)
    return emptyFile()
  }
}

const saveFile = (file: StatsFile) => {
  // 只保留最近 MAX_DAY_RECORDS 天，账本体积有上界
  const dates = Object.keys(file.days).sort()
  if (dates.length > MAX_DAY_RECORDS) {
    for (const date of dates.slice(0, dates.length - MAX_DAY_RECORDS)) {
      delete file.days[date]
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file))
  } catch (error) {
    console.warn('写入本地码字统计失败', error)
  }
}

const today = () => dayjs().format('YYYY-MM-DD')

const averageKnown = (value: number | null, divisor: number) =>
  value === null ? null : Math.round(value / divisor)
const addKnown = (left: number | null, right: number | null) =>
  left === null || right === null ? null : left + right
const normalizeCount = (value: number) => Math.max(0, Math.round(Number(value) || 0))

const sumDay = (
  day: Record<string, DayBookRecord> | undefined,
  bookId?: string,
  mode: WordCountMode = 'all'
) => {
  let manual: number | null = 0
  let ai: number | null = 0
  for (const [id, record] of Object.entries(day || {})) {
    if (bookId && id !== bookId) continue
    manual = addKnown(
      manual,
      mode === 'all'
        ? Number(record.manual || 0)
        : typeof record.textManual === 'number'
          ? record.textManual
          : null
    )
    ai = addKnown(
      ai,
      mode === 'all' ? Number(record.ai || 0) : typeof record.textAi === 'number' ? record.textAi : null
    )
  }
  return { manual, ai, total: addKnown(manual, ai) }
}

const dayRecord = (file: StatsFile, bookId: string | number) => {
  const day = (file.days[today()] ||= {})
  return (day[String(bookId)] ||= { manual: 0, ai: 0, textManual: 0, textAi: 0 })
}

/** 两种口径分别维护基线。切换显示口径不会改动基线，也不会制造码字增量。 */
export const primeChapterWords = (
  bookId: string | number,
  chapterId: string | number,
  wordCount: number,
  textWordCount?: number
) => {
  const file = loadFile()
  const key = `${bookId}:${chapterId}`
  file.chapterBase[key] ??= normalizeCount(wordCount)
  if (textWordCount !== undefined) file.chapterTextBase[key] ??= normalizeCount(textWordCount)
  saveFile(file)
}

export const recordChapterWords = (
  bookId: string | number,
  chapterId: string | number,
  wordCount: number,
  textWordCount?: number
) => {
  recordChapterLanding(bookId, chapterId, wordCount, textWordCount, 'manual')
}

function recordChapterLanding(
  bookId: string | number,
  chapterId: string | number,
  wordCount: number,
  textWordCount: number | undefined,
  source: 'manual' | 'ai'
) {
  const file = loadFile()
  const key = `${bookId}:${chapterId}`
  const count = normalizeCount(wordCount)
  const textCount = textWordCount === undefined ? undefined : normalizeCount(textWordCount)
  const delta = Math.max(0, count - (file.chapterBase[key] ?? (source === 'ai' ? 0 : count)))
  const textDelta =
    textCount === undefined
      ? undefined
      : Math.max(0, textCount - (file.chapterTextBase[key] ?? (source === 'ai' ? 0 : textCount)))
  file.chapterBase[key] = count
  if (textCount !== undefined) file.chapterTextBase[key] = textCount
  if (delta || textDelta) {
    const record = dayRecord(file, bookId)
    record[source] += delta
    const field = source === 'manual' ? 'textManual' : 'textAi'
    if (textDelta === undefined) delete record[field]
    else if (record[field] !== undefined) record[field]! += textDelta
  }
  saveFile(file)
}

/** AI 插入或撤销按两种口径分别记账，即使含标点净增为 0 也不能漏掉纯文字增量。 */
export const recordAiWordsAdded = (
  bookId: string | number,
  chapterId: string | number,
  wordDelta: number,
  textWordDelta?: number
) => {
  const delta = Math.round(Number(wordDelta) || 0)
  const textDelta = textWordDelta === undefined ? undefined : Math.round(Number(textWordDelta) || 0)
  if (!delta && !textDelta) return
  const file = loadFile()
  const key = `${bookId}:${chapterId}`
  if (file.chapterBase[key] !== undefined) file.chapterBase[key] = Math.max(0, file.chapterBase[key] + delta)
  if (textDelta !== undefined && file.chapterTextBase[key] !== undefined)
    file.chapterTextBase[key] = Math.max(0, file.chapterTextBase[key] + textDelta)
  const record = dayRecord(file, bookId)
  record.ai = Math.max(0, record.ai + delta)
  if (textDelta === undefined) delete record.textAi
  else if (record.textAi !== undefined) record.textAi = Math.max(0, record.textAi + textDelta)
  saveFile(file)
}

export const recordAiChapterLanding = (
  bookId: string | number,
  chapterId: string | number,
  wordCount: number,
  textWordCount?: number
) => {
  recordChapterLanding(bookId, chapterId, wordCount, textWordCount, 'ai')
}

export const getStatsTargets = () => {
  const { targets } = loadFile()
  return { manual: targets.manual, ai: targets.ai, total: targets.manual + targets.ai }
}

export const setStatsTargets = (targets: { manual: number; ai: number }) => {
  const file = loadFile()
  file.targets = {
    manual: Math.max(0, Math.round(Number(targets.manual) || 0)),
    ai: Math.max(0, Math.round(Number(targets.ai) || 0))
  }
  saveFile(file)
}

export const getStatsOverview = (
  date?: string,
  bookId?: string | number,
  mode: WordCountMode = readUiPreferences().wordCountMode
): LocalStatsOverview => {
  const file = loadFile()
  const day = file.days[date || today()]
  const { manual, ai, total } = sumDay(day, bookId === undefined ? undefined : String(bookId), mode)
  return {
    date: date || today(),
    targetWords: file.targets.manual + file.targets.ai,
    manualTargetWords: file.targets.manual,
    aiTargetWords: file.targets.ai,
    todayWords: total,
    manualWords: manual,
    aiWords: ai
  }
}

export const getStatsTrend = (
  days: number,
  endDate?: string,
  bookId?: string | number,
  mode: WordCountMode = readUiPreferences().wordCountMode
): LocalStatsTrend => {
  const file = loadFile()
  const span = Math.min(Math.max(Math.round(days) || 7, 1), 90)
  const end = dayjs(endDate || today())
  const filterBook = bookId === undefined ? undefined : String(bookId)
  const list: LocalStatsDayItem[] = []
  let totalManual: number | null = 0
  let totalAi: number | null = 0
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const date = end.subtract(offset, 'day').format('YYYY-MM-DD')
    const { manual, ai, total } = sumDay(file.days[date], filterBook, mode)
    totalManual = addKnown(totalManual, manual)
    totalAi = addKnown(totalAi, ai)
    list.push({ date, words: total, manualWords: manual, aiWords: ai })
  }
  return {
    days: span,
    startDate: end.subtract(span - 1, 'day').format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
    totalWords: addKnown(totalManual, totalAi),
    totalManualWords: totalManual,
    totalAiWords: totalAi,
    list
  }
}

export const getStatsCalendar = (
  month: string,
  bookId?: string | number,
  mode: WordCountMode = readUiPreferences().wordCountMode
): LocalStatsCalendar => {
  const file = loadFile()
  const start = dayjs(`${month}-01`)
  const filterBook = bookId === undefined ? undefined : String(bookId)
  const daysInMonth = start.daysInMonth()
  // 日均分母：当月为已过天数，历史月为整月天数
  const elapsed = start.isSame(dayjs(), 'month') ? dayjs().date() : daysInMonth
  const list: LocalStatsDayItem[] = []
  let totalManual: number | null = 0
  let totalAi: number | null = 0
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = start.date(day).format('YYYY-MM-DD')
    const { manual, ai, total } = sumDay(file.days[date], filterBook, mode)
    totalManual = addKnown(totalManual, manual)
    totalAi = addKnown(totalAi, ai)
    if (total === null || total > 0) {
      list.push({ date, words: total, manualWords: manual, aiWords: ai })
    }
  }
  const divisor = Math.max(1, elapsed)
  return {
    month,
    monthTotalWords: addKnown(totalManual, totalAi),
    monthManualWords: totalManual,
    monthAiWords: totalAi,
    monthAvgWords: averageKnown(addKnown(totalManual, totalAi), divisor),
    monthManualAvgWords: averageKnown(totalManual, divisor),
    monthAiAvgWords: averageKnown(totalAi, divisor),
    list
  }
}

/** 连续创作天数：从今天（今天没写则从昨天）往前数连续有码字的天数 */
export const getStatsStreak = (): number => {
  const file = loadFile()
  let cursor = dayjs()
  if (Number(sumDay(file.days[cursor.format('YYYY-MM-DD')]).total) <= 0) {
    cursor = cursor.subtract(1, 'day')
  }
  let streak = 0
  while (Number(sumDay(file.days[cursor.format('YYYY-MM-DD')]).total) > 0) {
    streak += 1
    cursor = cursor.subtract(1, 'day')
  }
  return streak
}
