import type { StyleFingerprint } from '@/types/distillation-task'

/**
 * 语言指纹：15 项纯统计，量句子长短起伏、段落收束、对白与标点比喻密度。
 * 只给作者看、给规划当节奏参数；不进正文提示词，不作关卡。
 */
export const FINGERPRINT_ITEMS: Array<{ key: string; label: string; unit: string }> = [
  { key: 'sentenceMean', label: '平均句长', unit: '字' },
  { key: 'sentenceCv', label: '句长起伏', unit: '' },
  { key: 'shortSentenceRatio', label: '短句占比', unit: '%' },
  { key: 'longSentenceRatio', label: '长句占比', unit: '%' },
  { key: 'paragraphMean', label: '平均段长', unit: '字' },
  { key: 'singleSentenceParagraphRatio', label: '单句段占比', unit: '%' },
  { key: 'paragraphEndShortRatio', label: '段末短句占比', unit: '%' },
  { key: 'dialogueRatio', label: '对白占比', unit: '%' },
  { key: 'commaPer1k', label: '逗号每千字', unit: '' },
  { key: 'exclamationPer1k', label: '叹号每千字', unit: '' },
  { key: 'questionPer1k', label: '问号每千字', unit: '' },
  { key: 'ellipsisPer1k', label: '省略号每千字', unit: '' },
  { key: 'dashPer1k', label: '破折号每千字', unit: '' },
  { key: 'metaphorPer1k', label: '比喻词每千字', unit: '' },
  { key: 'dePer100', label: '"的"每百字', unit: '' }
]
const METAPHOR_MARKERS = ['像', '仿佛', '如同', '宛如', '犹如', '好似', '似的', '一般', '般的']
const SHORT_SENTENCE = 8
const LONG_SENTENCE = 30
const sentences = (text: string) =>
  text
    .split(/(?<=[。！？!?；;…])\s*|\n+/)
    .map(s => s.trim())
    .filter(Boolean)
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
const stdDev = (values: number[]) => {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length)
}
const count = (text: string, needle: string) => text.split(needle).length - 1
const round1 = (n: number) => Math.round(n * 10) / 10
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)
export const DIALOGUE_START = /^["“「『]/
/** 对白段：以引号开头，或前三个字里有引号（"xxx，"他说）。 */
export const isDialogueParagraph = (paragraph: string) => DIALOGUE_START.test(paragraph) || /["“「]/.test(paragraph.slice(0, 3))
export function styleFingerprint(paragraphs: string[]): StyleFingerprint {
  const kept = paragraphs.map(p => p.trim()).filter(Boolean)
  const text = kept.join('\n')
  const chars = text.replace(/\s/g, '').length
  const sents = sentences(text)
  const sentenceLengths = sents.map(s => s.length)
  const sentenceMean = mean(sentenceLengths)
  const per1k = (n: number) => (chars ? round1((n * 1000) / chars) : 0)
  return {
    sentenceMean: round1(sentenceMean),
    sentenceCv: sentenceMean ? Math.round((stdDev(sentenceLengths) / sentenceMean) * 100) / 100 : 0,
    shortSentenceRatio: percent(sents.filter(s => s.length <= SHORT_SENTENCE).length, sents.length),
    longSentenceRatio: percent(sents.filter(s => s.length >= LONG_SENTENCE).length, sents.length),
    paragraphMean: round1(mean(kept.map(p => p.length))),
    singleSentenceParagraphRatio: percent(kept.filter(p => sentences(p).length === 1).length, kept.length),
    paragraphEndShortRatio: percent(kept.filter(p => (sentences(p).slice(-1)[0]?.length || 0) <= SHORT_SENTENCE).length, kept.length),
    dialogueRatio: percent(kept.filter(isDialogueParagraph).reduce((sum, p) => sum + p.length, 0), chars),
    commaPer1k: per1k(count(text, '，')),
    exclamationPer1k: per1k(count(text, '！') + count(text, '!')),
    questionPer1k: per1k(count(text, '？') + count(text, '?')),
    ellipsisPer1k: per1k(count(text, '……') + count(text, '…') - count(text, '……') * 2),
    dashPer1k: per1k(count(text, '——') + (count(text, '—') - count(text, '——') * 2)),
    metaphorPer1k: per1k(METAPHOR_MARKERS.reduce((sum, m) => sum + count(text, m), 0)),
    dePer100: chars ? round1((count(text, '的') * 100) / chars) : 0
  }
}
/** 给人看的一行：平均句长 18 字 · 对白占比 42% … */
/** 文本里出现了哪些参考书人名：按蒸馏时记下的名单核对，只认两个字以上的名字，不猜。 */
export const leakedNames = (text: string, names: string[]) =>
  [...new Set(names.map(n => n.trim()).filter(n => n.length >= 2 && text.includes(n)))]
export const describeFingerprint = (fp: StyleFingerprint) =>
  FINGERPRINT_ITEMS.map(item => `${item.label} ${fp[item.key] ?? 0}${item.unit}`).join(' · ')
