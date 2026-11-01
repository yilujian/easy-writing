import { htmlToText } from '@/writing-service/document-text'

/** 正文请求按阅读顺序组织。章节编号用于溯源，模型只收到需要读的原句。 */
export interface ProsePassage {
  chapterId: string
  chapterNo: number
  title: string
  version: number
  text: string
}
export interface StylePassage {
  id: string
  text: string
  from: string
  external?: boolean
}
export interface AuthorExample {
  id: string
  before: string
  after: string
}
export interface PromptStory {
  book: {
    title: string
    platform?: string
    category?: string
    intro?: string
    instruction?: string
    perspective?: string
    voice?: string
  }
  volume?: { title?: string; summary?: string }
  previous: ProsePassage[]
  /** 目标章之前最近几章里还没整理出章节卡的，原文直接给。 */
  unindexedRecent?: ProsePassage[]
  earlier: ProsePassage[]
  plan: { chapter?: unknown; outline?: unknown[] }
  facts: unknown[]
  history?: {
    people: unknown[]
    openThreads: unknown[]
    authorCorrections: unknown[]
    unindexed: number[][]
    otherOpenCount?: number
    otherFacts?: number
    omittedSearchPassages?: number
  }
  disputed?: { items: unknown[] }
  unresolved: string[]
  characters?: unknown[]
  world?: unknown[]
}
interface Input {
  title: string
  chapterNo?: number
  shortStory: boolean
  original: string
  context?: string
  plan?: { summary: string; beats?: string[] }
  author: string[]
  facts: string[]
  /** 上一章放多少字：不填给全文。 */
  previousLimit?: number
  /** 上上章结尾放多少字：0 不放。 */
  beforeLimit?: number
  instructions?: string
  samples: StylePassage[]
  edits: AuthorExample[]
  story: PromptStory | null
}
const row = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const words = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number'
      ? String(v)
      : Array.isArray(v)
        ? v.map(words).filter(Boolean).join('、')
        : ''
const block = (label: string, lines: (string | undefined)[]) => {
  const contents = lines.filter((s): s is string => !!s?.trim())
  return contents.length ? label + '\n' + contents.join('\n') : ''
}
const cited = (value: unknown) => {
  const src = row(value)
  return [src.chapterNo ? '第' + src.chapterNo + '章' : '', src.quote ? '“' + words(src.quote) + '”' : '']
    .filter(Boolean)
    .join(' ')
}
function person(value: unknown) {
  const p = row(value),
    state = row(p.state)
  const parts = [
    words(p.name),
    words(p.personality),
    words(state.location),
    words(state.realm),
    words(state.items),
    words(state.goals)
  ]
  if (typeof state.alive === 'boolean') parts.push(state.alive ? '在世' : '已故')
  for (const [k, v] of Object.entries(row(state.relations))) parts.push(k + ' ' + words(v))
  for (const [label, d] of [
    ['已知道', p.knows],
    ['明确不知道', p.doesNotKnow]
  ] as const) {
    for (const k of Object.values(row(d)))
      parts.push(label + ' ' + [words(row(k).factAtLearning), cited(k)].filter(Boolean).join(' '))
  }
  return parts.filter(Boolean).join(' · ')
}
export function outlineText(value: unknown): string {
  if (typeof value === 'string')
    return /<\/?(?:p|div|li|br|h[1-6])(?:\s|>|\/)/i.test(value) ? htmlToText(value) : value
  if (Array.isArray(value)) return value.map(outlineText).filter(Boolean).join('\n')
  const parts = Object.entries(row(value)).filter(
    ([k]) => !['id', 'bookId', 'parentId', 'sortNo', 'createdAt', 'updatedAt', 'nodeType'].includes(k)
  )
  return parts
    .map(([, v]) => outlineText(v))
    .filter(Boolean)
    .join('\n')
}
function storyBlocks(s: PromptStory) {
  const h = s.history
  const facts = s.facts.map(f => [words(row(f).text), cited(row(f).source)].filter(Boolean).join(' '))
  const clues = (h?.openThreads || []).map(item => {
    const t = row(item),
      latest = row(t.latest)
    return [
      words(t.title),
      cited(t.origin) || (t.chapterNo ? '始于第' + t.chapterNo + '章' : ''),
      words(latest.text),
      cited(latest.source),
      words(t.authorNote)
    ]
      .filter(Boolean)
      .join(' ')
  })
  const omitted = [
    h?.otherOpenCount ? '另有 ' + h.otherOpenCount + ' 条未展开线索' : '',
    h?.otherFacts ? '另有 ' + h.otherFacts + ' 条未展开事实' : '',
    h?.omittedSearchPassages ? '另有 ' + h.omittedSearchPassages + ' 处未展开原文' : ''
  ].filter(Boolean)
  return [
    block('作品', [
      s.book.title,
      [s.book.platform, s.book.category].filter(Boolean).join(' · '),
      s.book.intro,
      s.book.perspective ? '人称：' + s.book.perspective : '',
      s.book.voice ? '叙述口吻：' + s.book.voice : '',
      s.book.instruction
    ]),
    block('本卷卷纲' + (s.volume?.title ? '《' + s.volume.title + '》' : ''), [s.volume?.summary]),
    block('人物和设定', [
      ...(s.characters || []).map(person),
      ...(s.world || []).map(v => [words(row(v).name), words(row(v).detail)].filter(Boolean).join(' · '))
    ]),
    block('截至本章之前的人物情况', (h?.people || []).map(person)),
    block('已有事实', facts),
    block('未揭晓的线索', clues),
    block(
      '作者已确认的更正',
      (h?.authorCorrections || []).map(v => words(row(v).text))
    ),
    block(
      '有分歧的记述',
      (s.disputed?.items || []).map(v => words(row(v).message))
    ),
    block('资料范围', [
      ...(h?.unindexed || []).map(([a, b]) => '第 ' + a + (b === a ? '' : ' 至 ' + b) + ' 章尚未整理'),
      ...omitted,
      ...s.unresolved.map(q => '前文未查到“' + q + '”')
    ]),
    block(
      '相关原文',
      s.earlier.map(p => '第 ' + p.chapterNo + ' 章《' + p.title + '》\n' + p.text)
    )
  ]
}
export function selectStylePassages(rows: StylePassage[]): StylePassage[] {
  const chosen: StylePassage[] = []
  const seen = new Set<string>()
  let left = 2200
  for (const sample of rows) {
    if (chosen.length === 3 || left < 80) break
    const chars = Array.from(sample.text.trim())
    if (!chars.length) continue
    const cap = Math.min(1000, Math.ceil(left / (3 - chosen.length)))
    let text = chars.slice(0, cap).join('')
    if (chars.length > cap) {
      const end = Math.max(...['。', '！', '？', '\n'].map(c => text.lastIndexOf(c)))
      if (end >= Math.min(600, cap * 0.8)) text = text.slice(0, end + 1)
    }
    if (seen.has(text)) continue
    chosen.push({ ...sample, text })
    seen.add(text)
    left -= Array.from(text).length
  }
  return chosen
}
const tail = (text: string, limit: number) => Array.from(text).slice(-limit).join('')
export function proseMessages(p: Input) {
  const s = p.story,
    previous = s?.previous || [],
    latest = previous[previous.length - 1],
    before = previous[previous.length - 2]
  const target = p.shortStory ? '独立短篇' : p.chapterNo ? '第 ' + p.chapterNo + ' 章' : '本章'
  const system = p.original
    ? '按作者要求修改给定原文，只输出改好的正文。保留原有事件、线索和人物所知，只动指定范围。作者没有要求增写的原因、动作和物件特征保持原样。'
    : [
        [s?.book.platform, s?.book.category, '连载小说'].filter(Boolean).join(' ') +
          [s?.book.perspective, s?.book.voice]
            .filter(Boolean)
            .map(x => '，' + x)
            .join('') +
          '。',
        p.shortStory ? '完成这篇独立短篇。' : '接着本书写' + target + '，默认约 3000 字，篇幅以作者原话为准。',
        p.plan ? '按本章章纲写。' : '',
        '只输出正文。'
      ].join('')
  const sections = s ? storyBlocks(s) : []
  sections.push(
    block(
      '表达参考（人物和事件属于各自原文）',
      p.samples.map(x => x.text)
    ),
    block('本次指定的写作方法', [p.instructions])
  )
  if (p.original) {
    sections.push(
      block(
        '作者过去怎样改过相似的句子',
        p.edits.map(e => '原句　' + e.before + '\n作者改为　' + e.after)
      )
    )
  }
  sections.push(
    block('相关大纲', [outlineText(s?.plan.outline)]),
    block('本章章纲', [
      p.plan?.summary,
      ...(p.plan?.beats || []).map((beat, index) => index + 1 + '. ' + beat)
    ]),
    block('本章要用到的事实', p.facts),
    block('作者原话', p.author)
  )
  if (p.original) {
    if (p.context && p.context !== p.original) sections.push(block('选段所在的正文', [p.context]))
    sections.push(block('本次要改的原文', [p.original]))
  } else {
    sections.push(
      block(
        '尚未整理的前文',
        (s?.unindexedRecent || []).map(x => '第 ' + x.chapterNo + ' 章《' + x.title + '》\n' + x.text)
      )
    )
    const beforeLimit = p.beforeLimit ?? 1000
    if (before && beforeLimit > 0)
      sections.push(block('上上章《' + before.title + '》的结尾', [tail(before.text, beforeLimit)]))
    if (latest)
      sections.push(
        p.previousLimit === undefined
          ? block('上一章《' + latest.title + '》', [latest.text])
          : block('上一章《' + latest.title + '》的结尾', [tail(latest.text, p.previousLimit)])
      )
    sections.push(
      /^第[\d一二三四五六七八九十百千万零〇两]+章/u.test(p.title) ? p.title : target + '　' + p.title
    )
  }
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: sections.filter(Boolean).join('\n\n') }
  ]
}
