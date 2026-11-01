/**
 * Agent 拆书的本地导入：读取 TXT（自动识别 UTF-8 / GBK / UTF-16），分章，预估拆解用量。
 *
 * 整本书不进对话：分好章后交给宿主写进拆书库（`breakdown_import`），再按区间建拆书任务逐章提取章节卡。
 * 分章比作品导入宽松：书头信息与目录页不算章节，认“正文 第X章”“楔子 / 番外”“Chapter N”，
 * 每卷重新编号的书不会把后面几卷并进一章；没有章节标题就按字数分段。
 */
import { readLocalTxtContent, stripControlChars } from '@/storage/text-file'

export interface ReferenceChapter {
  title: string
  text: string
  /** 不含空白的字数 */
  chars: number
}

/** 上传后立刻识别出的目录；入库前就能给作者和模型看。 */
export interface BookCatalog {
  title: string
  chapterCount: number
  chars: number
  warnings: string[]
  /** 按章节结构看像一本书（拆书入口的文件一律按书处理）。 */
  book: boolean
  chapters: Array<{ no: number; title: string; chars: number }>
}
export interface ParsedReferenceBook {
  title: string
  chapters: ReferenceChapter[]
  totalChars: number
  /** 识别到的章节标题数；为 0 表示按字数分段 */
  headings: number
  /** 第一个章节标题之前的书名、作者、简介等，不算章节 */
  preface: string
  warnings: string[]
}

/** 与宿主一致：单篇资料上限、整篇交给模型的上限 */
export const MATERIAL_MAX_CHARS = 300_000
/** 参考书文件上限（50MB 的 GBK 文本约 2500 万字） */
export const REFERENCE_MAX_MB = 60
/** 至少识别到这么多章节标题，才按“整本书”处理 */
export const BOOK_MIN_HEADINGS = 3

const SPLIT_ABOVE = 30_000
const SPLIT_SIZE = 20_000
const SEGMENT_SIZE = 5_000
const PREFACE_MAX = 1_500

const NUM = '[零〇一二三四五六七八九十百千万两\\d０-９]+'
const PREFIX = '(?:正文卷\\s*|正文\\s*|VIP\\s*章节\\s*)?'
const chapterPattern = new RegExp(`^${PREFIX}第\\s*(${NUM})\\s*[章节回话](.*)$`, 'i')
const volumePattern = new RegExp(`^${PREFIX}(?:第\\s*${NUM}\\s*[卷部篇]|卷\\s*${NUM})(.*)$`, 'i')
const specialPattern =
  /^(?:正文\s*)?(序章|序言|序幕|楔子|引子|引言|前言|尾声|后记|终章|大结局|番外|外传|完本感言)(.*)$/
const englishPattern = /^chapter\s+(\d+|[ivxlcdm]+)\b(.*)$/i
const prefixPattern = /^(?:正文卷|正文|VIP\s*章节)\s*/i

const countChars = (text: string) => text.replace(/\s+/g, '').length

/** 标题后面的部分像正文就不是标题：带句末标点，或没有分隔就接逗号 */
const restLooksLikeProse = (rest: string) => {
  if (/[。]/.test(rest)) return true
  if (!/^[\s:：、.．\-—·（(【[]/.test(rest) && /[！？!?…]/.test(rest)) return true
  return !/^[\s:：、.．\-—·（(【[]/.test(rest) && /[，,；;]/.test(rest)
}
/** 没有序号的标题（卷一、楔子、番外）后面要么为空，要么先接分隔、空格或序号，免得“前言不搭后语”被当成标题 */
const restIsSeparated = (rest: string) =>
  /^(?:$|[\s:：、.．\-—·（(【[\d０-９一二三四五六七八九十])/.test(rest)

type Heading = { kind: 'chapter' | 'volume'; title: string }

export const detectHeading = (rawLine: string): Heading | null => {
  const line = rawLine.trim()
  if (!line || line.length > 50) return null
  const volume = line.match(volumePattern)
  if (volume && line.length <= 40 && restIsSeparated(volume[1] || '') && !restLooksLikeProse(volume[1] || ''))
    return { kind: 'volume', title: line }
  const chapter = line.match(chapterPattern)
  if (chapter && !restLooksLikeProse(chapter[2] || ''))
    return { kind: 'chapter', title: line.replace(prefixPattern, '') }
  const special = line.match(specialPattern)
  if (
    special &&
    line.length <= 30 &&
    restIsSeparated(special[2] || '') &&
    !restLooksLikeProse(special[2] || '')
  )
    return { kind: 'chapter', title: line.replace(prefixPattern, '') }
  const english = line.match(englishPattern)
  if (english && !restLooksLikeProse(english[2] || '')) return { kind: 'chapter', title: line }
  return null
}

/** 没有换行的超长段落（整本书挤在一行的 TXT）按句末标点切开，找不到标点就硬切 */
const splitLongParagraph = (paragraph: string, size: number): string[] => {
  if (countChars(paragraph) <= size) return [paragraph]
  const pieces: string[] = []
  let rest = paragraph
  while (rest.length > size) {
    const window = rest.slice(0, size)
    const cut = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('”')
    )
    const end = cut > size / 2 ? cut + 1 : size
    pieces.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest.trim()) pieces.push(rest)
  return pieces
}

/** 在段落边界把一大段文字切成不超过 size 字的几块 */
const splitByParagraphs = (text: string, size: number): string[] => {
  const parts: string[] = []
  let current: string[] = []
  let length = 0
  for (const paragraph of text.split('\n').flatMap(line => splitLongParagraph(line, size))) {
    const chars = countChars(paragraph)
    if (length > 0 && length + chars > size) {
      parts.push(current.join('\n').trim())
      current = []
      length = 0
    }
    current.push(paragraph)
    length += chars
  }
  if (current.join('').trim()) parts.push(current.join('\n').trim())
  return parts
}

const bookTitle = (filename: string) =>
  filename
    .replace(/\.[^.]+$/, '')
    .replace(/^《(.+)》/, '$1')
    .replace(/[（(【[](?:全本|完本|校对版|精校版|全集|完结|txt)[^）)】\]]*[）)】\]]/gi, '')
    .trim() || '参考书'

export interface ReferenceParseOptions { preserveLongChapters?: boolean; headingStyle?: 'auto' | 'numbered' | 'markdown' }
export const parseReferenceBook = (raw: string, filename: string, options: ReferenceParseOptions = {}): ParsedReferenceBook => {
  const text = stripControlChars(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
  const warnings: string[] = []
  const sections: Array<{ title: string; lines: string[] }> = []
  const prefaceLines: string[] = []
  let current: { title: string; lines: string[] } | null = null
  let headings = 0
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0].replace(/\n$/, '')
    const alternative = options.headingStyle === 'numbered'
      ? line.trim().match(/^\d+[.、．\s]+\S.{0,48}$/)
      : options.headingStyle === 'markdown' ? line.trim().match(/^#{1,6}\s+(.{1,50})$/) : null
    const heading: Heading | null = options.headingStyle && options.headingStyle !== 'auto'
      ? alternative ? { kind: 'chapter', title: line.trim().replace(/^#{1,6}\s+/, '') } : null
      : detectHeading(line)
    if (heading?.kind === 'volume') {
      current = null
      continue
    }
    if (heading) {
      headings += 1
      current = { title: heading.title, lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else prefaceLines.push(line)
  }

  let preface = prefaceLines.join('\n').trim()
  let chapters: ReferenceChapter[] = []
  if (!headings) {
    const parts = splitByParagraphs(text.trim(), SEGMENT_SIZE)
    chapters = parts.map((part, index) => ({
      title: `第 ${index + 1} 段`,
      text: part,
      chars: countChars(part)
    }))
    preface = ''
    if (chapters.length > 1)
      warnings.push(`没有识别到章节标题，已按约 ${SEGMENT_SIZE} 字一段分成 ${chapters.length} 段`)
  } else {
    // 正文前的长文字多半是没有标题的开篇，不是书头信息
    if (countChars(preface) > PREFACE_MAX) {
      chapters.push({ title: '开篇', text: preface, chars: countChars(preface) })
      warnings.push('第一个章节标题之前有一大段正文，已单独作为“开篇”')
      preface = ''
    }
    let empty = 0
    sections.forEach((section, index) => {
      const body = section.lines.join('\n').trim()
      if (countChars(body)) {
        chapters.push({ title: section.title, text: body, chars: countChars(body) })
        return
      }
      // 只有标题没有正文：紧跟着同名标题的是正文里重复的章名（下载站常见），照常跳过不必提示；
      // 其余多半是目录页或空章
      if (sections[index + 1]?.title !== section.title) empty += 1
    })
    if (empty) warnings.push(`跳过了 ${empty} 个没有正文的标题（目录页或空章）`)
  }

  // 超长章节按段落切开，单章交给模型的正文不超过上限
  let split = 0
  chapters = chapters.flatMap(chapter => {
    if (options.preserveLongChapters || chapter.chars <= SPLIT_ABOVE) return [chapter]
    split += 1
    return splitByParagraphs(chapter.text, SPLIT_SIZE).map((part, index) => ({
      title: index ? `${chapter.title}（续${index}）` : chapter.title,
      text: part,
      chars: countChars(part)
    }))
  })
  if (split) warnings.push(`${split} 章超过 ${SPLIT_ABOVE / 10_000} 万字，已按段落拆成几部分`)
  const short = chapters.filter(chapter => chapter.chars < 200).length
  if (headings && short > chapters.length / 3) warnings.push(`有 ${short} 章不到 200 字，请确认分章是否正确`)

  return {
    title: bookTitle(filename),
    chapters,
    totalChars: chapters.reduce((sum, chapter) => sum + chapter.chars, 0),
    headings,
    preface,
    warnings
  }
}

export const readTextFile = (file: File) => readLocalTxtContent(file)

/** 不超过这个字数的文本直接作为资料添加（与宿主整篇交给模型的上限一致） */
export const MATERIAL_INLINE_CHARS = 12_000

/**
 * 拖进输入框的文本怎么存，不弹窗、不问作者，也不拆：怎么用由作者在对话里说，Agent 需要确认时在对话里问。
 * - 像一本书的长文本（或超过单篇资料上限）：按章存进参考书库，Agent 能按章读、检索，需要时再拆；
 * - 其余（短文本、没有章节结构的文本）：作为一份资料，Agent 从头读，长的分段读；
 * - 从“拆解参考书”入口选的文件：作者已经说了要拆，按章存放。
 */
export const decideTextUse = (
  book: ParsedReferenceBook,
  intent: 'breakdown' | null = null
): 'material' | 'reference' => {
  if (intent === 'breakdown' || book.totalChars > MATERIAL_MAX_CHARS) return 'reference'
  return looksLikeBook(book) && book.totalChars > MATERIAL_INLINE_CHARS ? 'reference' : 'material'
}

/** 文本的 SHA-256：同一本书重复拖入时复用已存的参考书，不重复存放 */
export const textFingerprint = async (text: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export const looksLikeBook = (book: ParsedReferenceBook) =>
  (book.headings >= BOOK_MIN_HEADINGS && book.chapters.length >= BOOK_MIN_HEADINGS) ||
  book.totalChars > MATERIAL_MAX_CHARS

export const formatTokens = (tokens: number) =>
  tokens >= 10_000 ? `${Math.ceil(tokens / 10_000)} 万` : `${Math.max(1, Math.round(tokens / 1000))} 千`

/** 与宿主 `minutes_label` 一致：“5–12 分钟”“40 分钟–2 小时”“6–14 小时” */
export const formatMinutes = ([low, high]: [number, number] | number[]) => {
  const lo = Math.max(1, low || 1)
  const hi = Math.max(lo, high || lo)
  const hours = (m: number) => {
    const h = Math.round(m / 30) / 2
    return Number.isInteger(h) ? String(h) : h.toFixed(1)
  }
  if (hi < 90) return lo === hi ? `${lo} 分钟` : `${lo}–${hi} 分钟`
  if (lo < 60) return `${lo} 分钟–${hours(hi)} 小时`
  return `${hours(lo)}–${hours(hi)} 小时`
}
