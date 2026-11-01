import { isTauriRuntime } from '@/storage/writing-storage'
import { writingCommand } from './client'

/** 太短的插入（起名、补一个词）不记：指纹区分不开，也不影响文风统计 */
const MIN_CHARS = 12
/** 指纹片段长度与间隔：沿文本每隔一段取一小截，长段落跨多个切块时每块都能命中 */
const MARK_CHARS = 16
const MARK_STEP = 120
const MAX_MARKS = 40
const FLUSH_MS = 2000

interface Span {
  marks: string[]
  chars: number
  at: number
}

/** 从去掉空白的文本里等距取片段，首尾各保证一段 */
export function spanMarks(compact: string) {
  const marks: string[] = []
  for (
    let start = 0;
    start + MARK_CHARS <= compact.length && marks.length < MAX_MARKS - 1;
    start += MARK_STEP
  )
    marks.push(compact.slice(start, start + MARK_CHARS))
  const tail = compact.slice(-MARK_CHARS)
  if (tail.length === MARK_CHARS && !marks.includes(tail)) marks.push(tail)
  return marks
}
const pending = new Map<string, { bookId: string; chapterId: string; spans: Span[] }>()
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * 记下 AI 写进正文的片段（幽灵字采纳、快捷续写、划词改写），供状态层把这些段落标为 AI 来源：
 * 文风档案只从作者确认的手写样本里统计，AI 段落即使在确认的章节里也不计入。
 * 只存几小截指纹，不存全文；网页预览或失败时静默跳过，不影响码字。
 */
export function recordAiSpan(
  bookId: string | number | undefined,
  chapterId: number | null | undefined,
  text: string
) {
  if (!isTauriRuntime() || !bookId || !chapterId) return
  const compact = text.replace(/\s+/g, '')
  if (compact.length < MIN_CHARS) return
  const key = `${bookId}:${chapterId}`
  const entry = pending.get(key) || { bookId: String(bookId), chapterId: String(chapterId), spans: [] }
  entry.spans.push({ marks: spanMarks(compact), chars: compact.length, at: Date.now() })
  pending.set(key, entry)
  clearTimeout(timer)
  timer = setTimeout(() => void flushAiSpans(), FLUSH_MS)
}

export async function flushAiSpans() {
  clearTimeout(timer)
  const batch = [...pending.values()]
  pending.clear()
  for (const entry of batch) {
    try {
      await writingCommand('record_ai_spans', entry)
    } catch (error) {
      console.warn('记录 AI 插入片段失败', error)
    }
  }
}
