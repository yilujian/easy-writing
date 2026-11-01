import type { StyleEvidence, StyleSample, TabooEntry } from '@/types/distillation-task'
import { normalizeQuote } from './style-cards'

/**
 * 禁忌对照表是提示词库里的数据表，每行：名称｜检索形式｜数法｜说明。
 * 程序类条目在原文里数频率、取命中样例；读类条目交给模型在样本里看有没有。
 * 写进禁忌卡的是"这本书用不用、用多少、用在什么情境"，不是禁令。
 */
export interface TabooRule {
  id: string
  name: string
  patterns: RegExp[]
  method: 'program' | 'read'
  /** 只数每章最后三段 */
  tail: boolean
  note: string
}
const TAIL_PARAGRAPHS = 3
export const TABOO_EXAMPLES = 20
const CONTEXT_CHARS = 20
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 解析对照表：检索形式是顿号分隔的词，或 re: 开头的正则（多个用分号分隔）；只认全角竖线做列分隔。 */
export function parseTabooCatalog(text: string): TabooRule[] {
  const rules: TabooRule[] = []
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue
    const cells = line.split('｜').map(c => c.trim())
    if (cells.length < 3 || !cells[0]) continue
    const [name, form, methodCell, note = ''] = cells
    const method: TabooRule['method'] = methodCell.startsWith('读') ? 'read' : 'program'
    const patterns: RegExp[] = []
    if (method === 'program') {
      const sources = form.startsWith('re:')
        ? form.split(/[;；]\s*/).map(p => p.replace(/^re:/, '').trim()).filter(Boolean)
        : form.split('、').map(w => w.trim()).filter(Boolean).map(escape)
      for (const source of sources) {
        try {
          patterns.push(new RegExp(source, 'g'))
        } catch {
          // 坏正则跳过这一条形式，不让整张表失效
        }
      }
      if (!patterns.length) continue
    }
    rules.push({ id: `t${rules.length + 1}`, name, patterns, method, tail: methodCell.includes('章尾'), note })
  }
  return rules
}
export interface TabooChapterText {
  chapterNo: number
  paragraphs: string[]
}
const round2 = (n: number) => Math.round(n * 100) / 100
/** 程序类条目逐条数：命中数、命中分布的章数、每千字、最多 TABOO_EXAMPLES 处样例（带前后文）。 */
export function countTaboos(rules: TabooRule[], chapters: TabooChapterText[]): TabooEntry[] {
  const totalChars = chapters.reduce((sum, c) => sum + c.paragraphs.reduce((n, p) => n + p.replace(/\s/g, '').length, 0), 0)
  return rules
    .filter(rule => rule.method === 'program')
    .map(rule => {
      let hits = 0
      const chapterSet = new Set<number>()
      const examples: StyleEvidence[] = []
      for (const chapter of chapters) {
        const start = rule.tail ? Math.max(0, chapter.paragraphs.length - TAIL_PARAGRAPHS) : 0
        for (let i = start; i < chapter.paragraphs.length; i++) {
          const paragraph = chapter.paragraphs[i]
          for (const pattern of rule.patterns) {
            pattern.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = pattern.exec(paragraph))) {
              hits++
              chapterSet.add(chapter.chapterNo)
              if (examples.length < TABOO_EXAMPLES) {
                const from = Math.max(0, match.index - CONTEXT_CHARS)
                const to = Math.min(paragraph.length, match.index + match[0].length + CONTEXT_CHARS)
                examples.push({ chapterNo: chapter.chapterNo, para: i + 1, quote: paragraph.slice(from, to) })
              }
              if (!match[0]) pattern.lastIndex++
            }
          }
        }
      }
      return {
        id: rule.id,
        name: rule.name,
        method: 'program' as const,
        seen: hits > 0,
        hits,
        chapters: chapterSet.size,
        per1k: totalChars ? round2((hits * 1000) / totalChars) : 0,
        contexts: '',
        examples,
        note: rule.note
      }
    })
}
/** 模型没给结论时读类条目的标记。 */
export const UNJUDGED = '模型未给结论'
/** 读类条目：模型在样本里看有没有；引的原句程序核对在样本里逐字存在，对不上就不留样例。模型没给结论（parsed 为空）就标未判断。 */
export function normalizeTabooRead(parsed: unknown, rules: TabooRule[], samples: StyleSample[]): TabooEntry[] {
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const items = new Map<string, Record<string, unknown>>()
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string')
      items.set(String((entry as Record<string, unknown>).id), entry as Record<string, unknown>)
  }
  return rules
    .filter(rule => rule.method === 'read')
    .map(rule => {
      const item = items.get(rule.id)
      const quote = typeof item?.quote === 'string' ? item.quote.trim().slice(0, 80) : ''
      const sample = quote ? samples.find(s => normalizeQuote(s.text).includes(normalizeQuote(quote))) : undefined
      const seen = item?.seen === true
      return {
        id: rule.id,
        name: rule.name,
        method: 'read' as const,
        seen,
        hits: seen && sample ? 1 : 0,
        chapters: seen && sample ? 1 : 0,
        per1k: 0,
        contexts: item ? '模型判断' : UNJUDGED,
        examples: sample ? [{ chapterNo: sample.chapterNo, para: sample.startPara, quote }] : [],
        note: rule.note
      }
    })
}
export function applyTabooContexts(entries: TabooEntry[], parsed: unknown): TabooEntry[] {
  if (!parsed || typeof parsed !== 'object') return entries
  const raw = parsed as Record<string, unknown>
  const contexts = new Map<string, string>()
  for (const entry of Array.isArray(raw.items) ? raw.items : []) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id === 'string' && typeof e.contexts === 'string' && e.contexts.trim()) contexts.set(e.id, e.contexts.trim().slice(0, 60))
  }
  return entries.map(entry => (entry.method === 'program' && contexts.has(entry.id) ? { ...entry, contexts: contexts.get(entry.id)! } : entry))
}
/** 禁忌卡的一行：写频率、情境和不确定性，不写禁令。 */
export function tabooLine(entry: TabooEntry, scopeLabel: string) {
  const sample = entry.examples[0]
  const cite = sample ? `，如第${sample.chapterNo}章「${sample.quote.replace(/\s+/g, ' ').trim()}」` : ''
  if (entry.method === 'read') {
    if (entry.contexts === UNJUDGED) return `${entry.name}（模型判断）：本次没有判断。`
    return entry.seen
      ? `${entry.name}（模型判断）：样本里见到${cite}。`
      : `${entry.name}（模型判断）：样本里没见到，不确定作者是否会用。`
  }
  if (!entry.seen) return `${entry.name}：${scopeLabel}未见，不确定作者是否会用。`
  const where = entry.contexts ? `，用于${entry.contexts}` : ''
  return `${entry.name}：${scopeLabel}共 ${entry.hits} 处（每千字 ${entry.per1k}，分布在 ${entry.chapters} 章）${where}${cite}。`
}
/** 校准集上重算后的差异：范围内未见、校准集出现的，或频率差三倍以上的，记一条说明。 */
export function diffTaboos(range: TabooEntry[], calibration: TabooEntry[]) {
  const byId = new Map(calibration.map(e => [e.id, e]))
  return range
    .filter(e => e.method === 'program')
    .flatMap(entry => {
      const other = byId.get(entry.id)
      if (!other) return []
      let note = ''
      if (!entry.seen && other.seen) note = `范围内未见，校准集出现 ${other.hits} 处`
      else if (entry.seen && other.seen && (other.per1k > entry.per1k * 3 || entry.per1k > other.per1k * 3)) note = '校准集频率与范围内差三倍以上'
      return note ? [{ id: entry.id, name: entry.name, rangePer1k: entry.per1k, calibrationPer1k: other.per1k, note }] : []
    })
}
/** 校准差异套回禁忌卡：范围内没见、校准集见到的，改成"校准集出现过"。 */
export function applyTabooDiff(entries: TabooEntry[], diff: ReturnType<typeof diffTaboos>, calibration: TabooEntry[]) {
  const byId = new Map(calibration.map(e => [e.id, e]))
  const noted = new Map(diff.map(d => [d.id, d.note]))
  return entries.map(entry => {
    const note = noted.get(entry.id)
    if (!note) return entry
    const other = byId.get(entry.id)
    if (!entry.seen && other?.seen) return { ...entry, contexts: `范围内未见，校准集出现 ${other.hits} 处`, examples: other.examples.slice(0, 3) }
    return { ...entry, contexts: `${entry.contexts}${entry.contexts ? '；' : ''}${note}` }
  })
}
