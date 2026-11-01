import type { ChapterAnalysis, BreakdownPart, BreakdownFinding } from '@/types/breakdown-task'
import type { JsonRecord } from '@/types/json'
import { normalizeChapterAnalysis } from '@/utils/local-breakdown-engine'

/** Code-point offsets match Rust chars(), including supplementary Unicode characters. */
export function splitBreakdownText(paragraphs: string[], limit = 12000) {
  const chars = Array.from(paragraphs.join('\n')),
    chunks: Array<{ start: number; end: number; firstPara: number; lastPara: number; text: string }> = []
  let start = 0,
    paragraph = 1
  while (start < chars.length) {
    let end = Math.min(chars.length, start + limit)
    if (end < chars.length) {
      const cut = chars.slice(start + Math.floor(limit / 2), end).lastIndexOf('\n')
      if (cut >= 0) end = start + Math.floor(limit / 2) + cut + 1
    }
    const text = chars.slice(start, end).join(''),
      lines = text.split('\n').length - 1
    chunks.push({
      start,
      end,
      firstPara: paragraph,
      lastPara: paragraph + lines - (text.endsWith('\n') ? 1 : 0),
      text
    })
    paragraph += lines
    start = end
  }
  return chunks
}
export function normalizeBreakdownPart(
  parsed: JsonRecord,
  chunk: ReturnType<typeof splitBreakdownText>[number],
  paragraphs: string[]
): ChapterAnalysis {
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.outline))
    throw new Error('章节分析格式不完整，未计为完成')
  const local = chunk.text.replace(/\n$/, '').split('\n')
  const { analysis } = normalizeChapterAnalysis(parsed, local.length)
  if (!analysis.summary?.trim()) throw new Error('分析没有有效摘要，未计为完成')
  analysis.outline = analysis.outline.map(node => {
    const [start, end] = node.range.match(/\d+/g)!.map(Number)
    return { ...node, range: `${start + chunk.firstPara - 1}-${end + chunk.firstPara - 1}段` }
  })
  // Only attach actual source quotes. A matching quote is evidence location, not proof of the interpretation.
  const findings: BreakdownFinding[] = []
  for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
    const quote = String(raw.quote || '').trim()
    if (!quote || !chunk.text.includes(quote)) continue
    const prefix = chunk.text.slice(0, chunk.text.indexOf(quote))
    const startPara = chunk.firstPara + (prefix.match(/\n/g)?.length || 0)
    findings.push({
      fact: String(raw.fact || ''),
      interpretation: String(raw.interpretation || ''),
      technique: String(raw.technique || ''),
      quote,
      startPara,
      endPara: Math.min(paragraphs.length, startPara + (quote.match(/\n/g)?.length || 0))
    })
  }
  if (!findings.length) throw new Error('分析缺少可核对的原文依据，已保留进度，可继续重试此段')
  analysis.findings = findings
  if (analysis.golden)
    analysis.golden.anchors = analysis.golden.anchors.filter(a => chunk.text.includes(a.quote))
  return analysis
}
export function mergeBreakdownParts(parts: BreakdownPart[], paragraphCount: number) {
  const analysis: ChapterAnalysis = {
    summary: parts
      .map((p, i) => (parts.length > 1 ? `第 ${i + 1} 部分：${p.analysis.summary}` : p.analysis.summary))
      .join('\n\n'),
    outline: [],
    rhythm: [],
    setting: [],
    relations: [],
    findings: []
  }
  const paragraphInsightIds: Array<number | null> = Array.from({ length: paragraphCount }, () => null)
  for (const part of parts) {
    for (const node of part.analysis.outline) {
      const id = analysis.outline.length + 1
      analysis.outline.push({ ...node, id })
      const [start, end] = node.range.match(/\d+/g)!.map(Number)
      for (let i = start - 1; i < Math.min(end, paragraphCount); i++)
        if (paragraphInsightIds[i] === null) paragraphInsightIds[i] = id
    }
    analysis.rhythm.push(...part.analysis.rhythm)
    analysis.setting.push(...part.analysis.setting)
    analysis.relations!.push(...(part.analysis.relations || []))
    analysis.findings!.push(...(part.analysis.findings || []))
    if (!analysis.golden && part.analysis.golden) analysis.golden = part.analysis.golden
  }
  return { analysis, paragraphInsightIds }
}
/** Bounded hierarchical report input; every chapter/part participates, nothing is sliced away. */
export function reportGroups(items: string[], limit = 18000): string[][] {
  const out: string[][] = []
  let current: string[] = [],
    size = 0
  for (const item of items) {
    const chars = Array.from(item)
    for (let offset = 0; offset < chars.length; offset += limit) {
      const segment = chars.slice(offset, offset + limit).join('')
      if (current.length && size + segment.length > limit) {
        out.push(current)
        current = []
        size = 0
      }
      current.push(segment)
      size += segment.length
    }
  }
  if (current.length) out.push(current)
  return out
}
