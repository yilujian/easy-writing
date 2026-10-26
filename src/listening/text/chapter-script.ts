import { LISTENING_MAX_SEGMENT_CHARS } from '@/config/listening'
import type { ChapterScript, SpeechSegment } from '@/types/listening'

/**
 * 听书正文清洗与分句。
 *
 * 目标是「每一句都能独立朗读、能高亮、能回跳」：
 * - 先保留段落结构，再把每段切成句子，最后合并过短句、拆分超长句；
 * - 引号内的句号不切，避免把“他说：‘走吧。’”拆成半句；
 * - 所有 segment 都保留在清洗后正文里的 start/end，点击/进度恢复不依赖 DOM。
 */

const SCRIPT_SIGNATURE_VERSION = 'v2'
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g
const QUOTE_OPEN = new Set(['“', '「', '『', '‘'])
const QUOTE_CLOSE = new Set(['”', '」', '』', '’'])
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';'])
const SOFT_BREAK = new Set(['，', '、', '；', '：', ',', ';', ':'])

export const normalizeChapterText = (raw: unknown): string => {
  let text = String(raw ?? '')
  text = text.replace(/\r\n?/g, '\n').replace(ZERO_WIDTH, '')
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t\u3000]+$/g, ''))
    .join('\n')
  // 三个以上空行压成两个：听书不需要保留排版留白，但段落边界要留住
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

const isAsciiWord = (char: string | undefined) => Boolean(char && /[a-z0-9]/i.test(char))

const splitParagraph = (paragraph: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = []
  let depth = 0
  let start = 0
  let index = 0
  const push = (end: number) => {
    if (end > start) ranges.push({ start, end })
    start = end
  }

  while (index < paragraph.length) {
    const char = paragraph[index]
    if (QUOTE_OPEN.has(char)) {
      depth += 1
      index += 1
      continue
    }
    if (QUOTE_CLOSE.has(char)) {
      depth = Math.max(0, depth - 1)
      const before = paragraph[index - 1]
      const next = paragraph[index + 1]
      if (depth === 0 && !SOFT_BREAK.has(before || '') && next !== undefined && !SOFT_BREAK.has(next)) {
        push(index + 1)
      } else if (depth === 0 && next === undefined) {
        push(index + 1)
      }
      index += 1
      continue
    }
    if (depth === 0) {
      if (char === '…' && paragraph[index + 1] === '…') {
        index += 2
        push(index)
        continue
      }
      if (SENTENCE_END.has(char)) {
        // 英文缩写/小数不硬切：只在后面是空白/中文/引号/结尾时收句
        const next = paragraph[index + 1]
        if (!isAsciiWord(paragraph[index - 1]) || !isAsciiWord(next)) {
          index += 1
          push(index)
          continue
        }
      }
    }
    index += 1
  }
  push(paragraph.length)
  return ranges
}

const splitLongRange = (
  paragraph: string,
  range: { start: number; end: number },
  max: number
): Array<{ start: number; end: number }> => {
  const result: Array<{ start: number; end: number }> = []
  let start = range.start
  while (range.end - start > max) {
    const limit = start + max
    let cut = -1
    for (let index = limit; index > start + Math.floor(max * 0.5); index -= 1) {
      if (SOFT_BREAK.has(paragraph[index])) {
        cut = index + 1
        break
      }
    }
    if (cut <= start) cut = limit
    result.push({ start, end: cut })
    start = cut
  }
  if (range.end > start) result.push({ start, end: range.end })
  return result
}

const trimRange = (text: string, range: { start: number; end: number }) => {
  let start = range.start
  let end = range.end
  while (start < end && /\s/.test(text[start])) start += 1
  while (end > start && /\s/.test(text[end - 1])) end -= 1
  return { start, end }
}

const speechTextOf = (display: string) =>
  display
    .replace(/^[\s\u3000]+/, '')
    .replace(/[\s\u3000]+$/, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()

export const signatureOf = (text: string) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`
}

export interface BuildChapterScriptInput {
  chapterId: number
  title: string
  text: string
  /** 是否把章节标题作为第一句朗读 */
  readTitle?: boolean
}

export const buildChapterScript = (input: BuildChapterScriptInput): ChapterScript => {
  const text = normalizeChapterText(input.text)
  const title = String(input.title || '').trim()
  const segments: SpeechSegment[] = []
  let paragraphIndex = 0

  if (input.readTitle && title && !text.trimStart().startsWith(title)) {
    const displayText = title
    segments.push({
      index: 0,
      text: speechTextOf(displayText),
      displayText,
      start: 0,
      end: 0,
      paragraphIndex: -1,
      kind: 'title'
    })
  }

  let cursor = 0
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor)
    const paragraphEnd = newline === -1 ? text.length : newline
    const paragraph = text.slice(cursor, paragraphEnd)
    if (paragraph.trim()) {
      const rawRanges = splitParagraph(paragraph)
        .map(range => trimRange(paragraph, range))
        .filter(range => range.end > range.start)
        .flatMap(range => splitLongRange(paragraph, range, LISTENING_MAX_SEGMENT_CHARS))
        .map(range => trimRange(paragraph, range))
        .filter(range => range.end > range.start)

      // 分句结果本身就是完整句；不再按“短句”合并，
      // 否则“第一句。第二句。”会被并成一句，高亮和跳句都会变粗。
      const merged = rawRanges.length ? rawRanges : [{ start: 0, end: paragraph.length }]

      for (const range of merged) {
        const displayText = paragraph.slice(range.start, range.end)
        const speechText = speechTextOf(displayText)
        if (!speechText) continue
        segments.push({
          index: segments.length,
          text: speechText,
          displayText,
          start: cursor + range.start,
          end: cursor + range.end,
          paragraphIndex,
          kind: 'body'
        })
      }
    }
    if (newline === -1) break
    cursor = newline + 1
    paragraphIndex += 1
  }

  // 只有标题、没有正文的章按空章处理：否则播放器会显示 1/1 却没有任何句子可听
  const hasBody = segments.some(segment => segment.kind === 'body')
  return {
    chapterId: input.chapterId,
    title,
    text,
    segments: hasBody ? segments.map((segment, index) => ({ ...segment, index })) : [],
    textLength: text.length,
    signature: signatureOf(
      [SCRIPT_SIGNATURE_VERSION, input.readTitle ? 'title:on' : 'title:off', title, text].join('\u0000')
    )
  }
}

export const segmentIndexAtOffset = (script: ChapterScript, offset: number) => {
  if (!script.segments.length) return 0
  const value = Math.max(0, Number(offset) || 0)
  const found = script.segments.findIndex(segment => value >= segment.start && value < segment.end)
  if (found >= 0) return found
  return value >= script.textLength ? script.segments.length - 1 : 0
}
