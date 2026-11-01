import type { DistillationPick, StyleCard, StyleEvidence, StyleSample } from '@/types/distillation-task'

/**
 * 讲法卡与样本的纯函数：
 * - 样本：从章卡标出的连续原文候选里挑 6 到 10 段，覆盖场景类型、优先不同章，不按相似度挑。
 * - 讲法卡：模型给的卡要过程序核对——每条证据的原句去掉空白后必须逐字出现在该章原文里，
 *   对不上的退回一次，仍对不上的卡丢掉；证据来自不足两章的卡丢掉；总数封顶。
 */
export const SAMPLE_MIN = 6
export const SAMPLE_MAX = 10
export const CARD_MAX = 8
/** 一条卡的证据至少来自几章（复现性）。 */
export const CARD_MIN_CHAPTERS = 2
export const normalizeQuote = (text: string) => text.replace(/\s+/g, '')
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const int = (value: unknown) => (Number.isInteger(Number(value)) ? Number(value) : NaN)

/** 挑样本：每种场景类型先各取一段（优先没取过的章），再按类型轮着补到上限。 */
export function pickSamples(picks: DistillationPick[], scenes: string[], min = SAMPLE_MIN, max = SAMPLE_MAX): StyleSample[] {
  const order = [...scenes, ...[...new Set(picks.map(p => p.kind))].filter(k => !scenes.includes(k))]
  const chosen: DistillationPick[] = []
  const usedChapters = new Set<number>()
  const take = (candidates: DistillationPick[]) => {
    const fresh = candidates.find(p => !chosen.includes(p) && !usedChapters.has(p.chapterId))
    const pick = fresh || candidates.find(p => !chosen.includes(p))
    if (!pick) return false
    chosen.push(pick)
    usedChapters.add(pick.chapterId)
    return true
  }
  for (let round = 0; round < max && chosen.length < max; round++) {
    let added = false
    for (const scene of order) {
      if (chosen.length >= max) break
      const same = chosen.filter(c => c.kind === scene).length
      // 第一轮每种类型一段；之后类型之间均衡，不让一种类型占满
      if (round > 0 && same > round) continue
      if (take(picks.filter(p => p.kind === scene))) added = true
    }
    if (!added) break
  }
  if (chosen.length < min) for (const pick of picks) if (chosen.length < min && !chosen.includes(pick)) chosen.push(pick)
  chosen.sort((a, b) => a.chapterNo - b.chapterNo || a.startPara - b.startPara)
  return chosen.map((p, index) => ({
    id: `s${index + 1}`,
    scene: p.kind,
    chapterNo: p.chapterNo,
    chapterTitle: p.chapterTitle,
    startPara: p.startPara,
    endPara: p.endPara,
    text: p.text
  }))
}
/** 在一章原文里找一句话：去空白后逐字匹配，返回段落号（从 1 起）；找不到返回 0。 */
export function locateQuote(paragraphs: string[], quote: string): number {
  const needle = normalizeQuote(quote)
  if (needle.length < 4) return 0
  for (let i = 0; i < paragraphs.length; i++) if (normalizeQuote(paragraphs[i]).includes(needle)) return i + 1
  // 原句跨段时在相邻两段的拼接里找
  for (let i = 0; i + 1 < paragraphs.length; i++) if (normalizeQuote(paragraphs[i] + paragraphs[i + 1]).includes(needle)) return i + 1
  return 0
}
export interface StyleCardCheck {
  cards: StyleCard[]
  /** 证据对不上原文或证据不足两章的卡，退回时告诉模型 */
  rejected: Array<{ dimension: string; observation: string; reason: string }>
}
/**
 * 模型给的讲法卡换成程序认的：维度要在分析目录里；每条证据的原句要能在该章原文里逐字找到；
 * 证据至少来自 CARD_MIN_CHAPTERS 章；总数封顶。
 */
export function normalizeStyleCards(
  parsed: unknown,
  chapters: Map<number, string[]>,
  dimensions: string[],
  options: { max?: number; minChapters?: number; idPrefix?: string } = {}
): StyleCardCheck | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  if (!Array.isArray(raw.cards)) return null
  const list = raw.cards.filter(c => c && typeof c === 'object')
  const max = options.max ?? CARD_MAX
  const minChapters = options.minChapters ?? CARD_MIN_CHAPTERS
  const cards: StyleCard[] = []
  const rejected: StyleCardCheck['rejected'] = []
  for (const item of list as Array<Record<string, unknown>>) {
    const dimension = str(item.dimension, 30).replace(/^【|】$/g, '')
    const observation = str(item.observation, 120)
    const use = str(item.use, 100)
    const boundary = str(item.boundary, 80)
    if (!observation || !use) continue
    if (!dimensions.includes(dimension)) {
      rejected.push({ dimension, observation, reason: `「${dimension}」不在分析目录里` })
      continue
    }
    const evidence: StyleEvidence[] = []
    const bad: string[] = []
    for (const e of Array.isArray(item.evidence) ? item.evidence : []) {
      if (!e || typeof e !== 'object') continue
      const chapterNo = int((e as Record<string, unknown>).chapter)
      const quote = str((e as Record<string, unknown>).quote, 120)
      if (!quote) continue
      const paragraphs = chapters.get(chapterNo)
      const para = paragraphs ? locateQuote(paragraphs, quote) : 0
      if (para) evidence.push({ chapterNo, para, quote })
      else bad.push(`第${chapterNo || '?'}章「${quote.slice(0, 30)}」`)
    }
    const spread = new Set(evidence.map(e => e.chapterNo)).size
    if (bad.length) rejected.push({ dimension, observation, reason: `证据对不上原文：${bad.join('、')}` })
    else if (spread < minChapters) rejected.push({ dimension, observation, reason: `证据只来自 ${spread} 章，至少要 ${minChapters} 章` })
    else cards.push({ id: '', dimension, observation, evidence, use, boundary })
  }
  const prefix = options.idPrefix || 'k'
  const kept = cards.slice(0, max).map((card, index) => ({ ...card, id: `${prefix}${index + 1}` }))
  return { cards: kept, rejected }
}
/** 校准结论套回讲法卡：keep 原样、revise 换观察/用法/边界（证据不动）、drop 去掉；没给结论的照旧保留。 */
export function applyCalibration(
  cards: StyleCard[],
  items: Array<{ id: string; verdict: 'keep' | 'revise' | 'drop'; card?: { observation?: string; use?: string; boundary?: string } }>
): StyleCard[] {
  const byId = new Map(items.map(item => [item.id, item]))
  return cards.flatMap(card => {
    const item = byId.get(card.id)
    if (!item || item.verdict === 'keep') return [card]
    if (item.verdict === 'drop') return []
    const next = {
      ...card,
      observation: item.card?.observation?.trim() || card.observation,
      use: item.card?.use?.trim() || card.use,
      boundary: item.card?.boundary?.trim() ?? card.boundary
    }
    return [next]
  })
}
export function normalizeCalibration(
  parsed: unknown,
  ids: string[]
): Array<{ id: string; verdict: 'keep' | 'revise' | 'drop'; reason: string; card?: { observation: string; use: string; boundary: string } }> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const e = entry as Record<string, unknown>
    const id = str(e.id, 20)
    const verdict = str(e.verdict, 10) as 'keep' | 'revise' | 'drop'
    if (!ids.includes(id) || !['keep', 'revise', 'drop'].includes(verdict)) return []
    const fix = e.card && typeof e.card === 'object' ? (e.card as Record<string, unknown>) : null
    const card = fix ? { observation: str(fix.observation, 120), use: str(fix.use, 100), boundary: str(fix.boundary, 80) } : undefined
    return [{ id, verdict, reason: str(e.reason, 160), ...(card && (card.observation || card.use || card.boundary) ? { card } : {}) }]
  })
  return items.length ? items : null
}
