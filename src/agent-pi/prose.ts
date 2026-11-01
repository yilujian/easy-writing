import { bookExamples, chosenPassages, personalPassages } from './prose-samples'
import {
  proseMessages,
  selectStylePassages,
  outlineText,
  type StylePassage,
  type AuthorExample
} from './prose-prompt'
import { appSettings } from '@/storage/app-settings'
import { getLocalAiModelSecret } from '@/storage/local-ai-models'
import { readDoc } from '@/storage/local-reference-store'
import type { PiChapterDraft, PiChapterPlan, PiDraft, PiToolRequest } from '@/types/agent-pi'
import { streamLocalChatCompletion } from '@/utils/local-ai-client'
import { writingCommand } from '@/writing-service/client'
import { findSkill, parseSkillCommand, reloadSkills } from './skills'
import { isStyleSkill, readStyleExamples } from './style-tools'

interface Passage {
  chapterId: string
  chapterNo: number
  title: string
  version: number
  text: string
}
interface Sources {
  appendAnchor: string | null
  coverage?: { indexedChapters: number; eligibleChapters: number }
  suspects?: Array<{ chapterId: string; message: string }>
  facts: Array<{ required?: boolean }>
  chapterPlan?: { summary?: unknown; outline?: unknown } | null
  chapterNo?: number
  book: {
    title: string
    platform?: string
    category?: string
    intro?: string
    instruction?: string
    styleSkillId?: string
    perspective?: string
    voice?: string
  }
  target: Passage | null
  blank: Passage | null
  volumeTitle: string
  volume?: { title?: string; summary?: string }
  /** 全书有没有任何一卷写了卷纲。 */
  volumePlanned?: boolean
  /** 目标之后还有几章写好了章纲没写正文。 */
  plannedAhead?: number
  previous: Passage[]
  unindexedRecent?: Passage[]
  history: {
    people: unknown[]
    openThreads: Array<{ related: boolean; title: string; threadId: string; required?: boolean }>
    otherOpenCount?: number
    otherFacts?: number
    omittedSearchPassages?: number
    authorCorrections: unknown[]
    unindexed: number[][]
  }
  historyAnchor?: { id: string; revision: string }
  evidence: Passage[]
  notFound: string[]
}
/** 原文明指和作者标记的条目始终保留；其余条目按宿主算出的关联度取可容纳的前缀。 */
function fitRanked<T extends { required?: boolean }>(
  items: T[],
  apply: (kept: T[], omitted: number) => void,
  fits: () => boolean
) {
  const pinned = items.filter(item => item.required)
  const optional = items.filter(item => !item.required)
  let low = 0,
    high = optional.length
  const choose = (n: number) => apply([...pinned, ...optional.slice(0, n)], optional.length - n)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    choose(mid)
    if (fits()) low = mid
    else high = mid - 1
  }
  choose(low)
}
/** 目录里的章纲（作者可能改过）优先；没有才用聊天模型本次拟的。 */
export function chapterPlan(
  catalog: Sources['chapterPlan'] | undefined,
  requested: unknown
): PiChapterPlan | undefined {
  const summary = outlineText(catalog?.summary).trim()
  if (summary) {
    const meta = catalog?.outline && typeof catalog.outline === 'object' ? (catalog.outline as Record<string, unknown>) : {}
    const beats = Array.isArray(meta.beats)
      ? meta.beats.map(b => (typeof b === 'string' ? b.trim() : '')).filter(Boolean)
      : outlineText(meta.expandedOutline)
        ? outlineText(meta.expandedOutline).split('\n').filter(Boolean)
        : []
    return { summary, beats, source: 'catalog' }
  }
  const draft = requested && typeof requested === 'object' ? (requested as Record<string, unknown>) : null
  const text = typeof draft?.summary === 'string' ? draft.summary.trim() : ''
  if (!text) return undefined
  const beats = Array.isArray(draft?.beats)
    ? draft.beats.map(b => (typeof b === 'string' ? b.trim() : '')).filter(Boolean)
    : []
  return { summary: text, beats, source: 'chat' }
}
/** 给聊天模型下一步判断用：这本书有没有卷纲、目标之后还有几章章纲没写正文。 */
export interface ProseInfo {
  volumePlanned: boolean
  plannedAhead: number
}
export type ProseDraft = Extract<PiDraft, { kind: 'chapter' | 'new_chapter' | 'short_story' | 'text' }>
export const proseSources = (bookId: string, args: Record<string, unknown>) =>
  writingCommand<Sources>('prose_sources', { ...args, bookId })
export function locateSelection(base: string, text: string, occurrence?: number) {
  const parts = base.split(text)
  if (!text || parts.length === 1) throw Error('未在目标章节找到这段原文，请核对选段')
  if (parts.length > 2 && !occurrence) throw Error('章内有多处相同原文，请让作者指定第几处')
  if (!Number.isInteger(occurrence ?? 1) || (occurrence ?? 1) < 1 || (occurrence ?? 1) >= parts.length)
    throw Error('选段位置无效')
  return { text, occurrence: occurrence ?? 1 }
}
export async function generateProse(
  request: PiToolRequest,
  modelCode: string,
  prior: ProseDraft | undefined,
  signal?: AbortSignal,
  beforeRequest?: (newChapter: boolean, plan?: PiChapterPlan, info?: ProseInfo) => void | Promise<void>
): Promise<ProseDraft> {
  const { args } = request,
    sessionId = String(args.sessionId),
    mode = String(args.mode)
  const model = getLocalAiModelSecret(modelCode)
  if (!model || model.status !== 1) throw Error('当前会话模型不可用')
  const standalone =
    mode === 'short_story' || mode === 'text' || prior?.kind === 'short_story' || prior?.kind === 'text'
  const bookId = standalone ? '' : request.book?.id
  if (!standalone && !bookId) throw Error('写章节需要先确定作品')
  const sourceArgs =
    prior?.kind === 'chapter'
      ? { ...args, chapterId: String(prior.chapterId) }
      : prior?.kind === 'new_chapter'
        ? { ...args, volumeId: prior.volumeId }
        : args
  const sources = bookId ? await proseSources(bookId, sourceArgs) : null
  const target = sources?.target || sources?.blank
  if ((mode === 'chapter' && !sources?.target) || (mode === 'new_chapter' && !sources?.volumeTitle))
    throw Error('请在正式目录中确定要写的目标')
  const revision = prior ? (prior.revision ?? 0) : target?.version
  if (args.selectionVersion !== undefined && args.selectionVersion !== revision)
    throw Error('选择原文期间章节或候选已变化，请重新选择')
  const selected = String(args.selection || '')
  const basis = prior?.content ?? target?.text
  const selection =
    selected && basis !== undefined
      ? locateSelection(basis, selected, args.occurrence as number | undefined)
      : undefined
  const original = selection?.text ?? prior?.content ?? target?.text ?? String(args.original || '')
  if (mode === 'text' && !original) throw Error('请引用需要润色的粘贴原文')
  const author = args.author as Array<{ id: string; text: string }>
  if (!author?.length) throw Error('找不到本轮作者原话')
  if (mode === 'text' && !prior && !author.some(entry => entry.text.includes(original)))
    throw Error('粘贴底稿与作者原话不一致')
  const named = String(args.skillName || '')
  const latestMethod = parseSkillCommand(author[author.length - 1].text)?.skill
  const explicit = latestMethod || (named && author.some(a => a.text.includes(named)) ? named : '')
  const defaultStyle = bookId ? (appSettings.getItem('ew-pi-default-style:' + bookId) ?? sources?.book.styleSkillId) : ''
  await reloadSkills()
  const base = findSkill('novel-writing')
  const selectedName = explicit || defaultStyle
  const skill = selectedName ? findSkill(selectedName) : base
  if (selectedName && !skill?.enabled) throw Error('指定写作技能不存在或已停用，请作者重新选择')
  const samples =
    skill?.enabled && (await isStyleSkill(skill.id))
      ? await readStyleExamples(
          { ...request, args: { sessionId, skill: skill.id, limit: 3, includeGuidance: false } },
          signal,
          false
        )
      : null
  const selectedSamples: StylePassage[] =
    samples && 'sample' in samples && samples.sample
      ? [samples.sample, ...(samples.additionalSamples || [])].map(s => ({ ...s, external: true }))
      : samples && 'examples' in samples && samples.examples
        ? samples.examples.map(s => ({ ...s, external: true }))
        : []
  const instructions =
    skill?.enabled &&
    !samples &&
    !(skill.name === 'novel-writing' && skill.source === 'builtin' && !skill.overridden)
      ? skill.instructions
      : undefined
  const title =
    prior?.title ||
    (target?.text ? target.title : '') ||
    String(args.title || target?.title || (mode === 'text' ? '独立改稿' : '')).trim()
  if (!title) throw Error('请提供本稿标题')
  const doc = bookId ? await readDoc(bookId) : null
  const requestedOutlines = Array.isArray(args.outlineIds) ? args.outlineIds.map(Number) : []
  const outline = doc?.outlineNodes.filter(n => requestedOutlines.includes(n.id) || n.title === title)
  const authorWords = [...new Set(author.map(a => parseSkillCommand(a.text)?.text || a.text))]
  // 本章章纲：目录里已有的优先，作者在那里改过就以作者的为准；没有时用聊天模型本次拟的，平台存进本章大纲。
  const plan = original ? undefined : chapterPlan(sources?.chapterPlan, args.plan)
  const freshChapter = !original && (mode === 'new_chapter' || (mode === 'chapter' && !(target?.text || '').trim()))
  if (freshChapter && sources && !sources.volumePlanned && !(sources.coverage?.eligibleChapters ?? sources.previous.length))
    throw Error(
      '这本书还没有总纲：没有一卷写了卷纲。完整建书先交总纲候选：每卷一个 entity=volume 候选，summary 写这一卷的目标、起止状态、卷末高潮、必须发生和不许发生的事；主要人物用 entity=character 提交。作者采用后再用 plan_chapters 写章纲，然后写正文。'
    )
  if (freshChapter && !plan)
    throw Error(
      '这章还没有章纲。作者原话已经说清本章要发生什么，就在 plan 里写出章纲再调用；没说清，就按卷纲、未收伏笔和前文拟两三个方向，用 ask_author 问作者，选定后再写。' +
        (sources && !sources.volumePlanned ? '另外这本书没有卷纲，顺便问作者要不要整理一份。' : '')
    )
  const facts = original
    ? []
    : Array.isArray(args.facts)
      ? [...new Set(args.facts.map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean))]
      : []
  const pairs = bookId
    ? await bookExamples(
        bookId,
        sources?.chapterNo,
        original || plan?.summary || authorWords.join('\n'),
        Boolean(original)
      )
    : []
  const authorSamples: StylePassage[] = pairs.map(pair => ({
    id: pair.id,
    text: pair.after,
    from: '本书手改段落'
  }))
  let availableSamples = selectedSamples.length ? selectedSamples : authorSamples
  if (!availableSamples.length && bookId && !original)
    availableSamples = await personalPassages(bookId, sources?.chapterNo, plan?.summary || authorWords.join('\n'))
  if (!availableSamples.length && bookId) availableSamples = await chosenPassages(bookId)
  const data = {
    title,
    chapterNo: sources?.chapterNo,
    shortStory: mode === 'short_story' || prior?.kind === 'short_story',
    original,
    context: selection ? basis : undefined,
    plan: plan ? { summary: plan.summary, beats: plan.beats } : undefined,
    author: authorWords,
    facts,
    previousLimit: undefined as number | undefined,
    beforeLimit: 1000,
    instructions,
    samples: selectStylePassages(availableSamples),
    edits: original
      ? pairs.slice(0, 20).map(({ id, before, after }) => ({ id, before, after }))
      : ([] as AuthorExample[]),
    story: sources
      ? {
          book: sources.book,
          previous: sources.previous,
          plan: { chapter: sources.chapterPlan, outline },
          facts: sources.facts,
          ...(sources.suspects?.length
            ? {
                disputed: {
                  note: '待裁决的原文矛盾，不能当作既定事实；以作者明确的决定为准',
                  items: sources.suspects
                }
              }
            : {}),
          history: sources.history,
          volume: sources.volume,
          unindexedRecent: original ? [] : [...(sources.unindexedRecent || [])],
          earlier: sources.evidence,
          unresolved: sources.notFound,
          characters: doc?.characters.map(c => ({
            name: c.name,
            aliases: c.aliases,
            personality: c.personality
          })),
          world: doc?.worldSettings.map(w => ({ name: w.name, detail: w.detail }))
        }
      : null
  }
  const window = model.maxContext || 32000,
    output = model.maxOutputTokens || 4096
  const fits = () =>
    Math.ceil(proseMessages(data).reduce((sum, m) => sum + m.content.length, 0) / 1.7) + output <= window
  while (!fits() && data.edits.length) data.edits.pop()
  if (data.story) {
    // 上一章全文已经包含的段落可以去重；作者点名的整章、未出现在上一章的早先引文必须保留。
    const last = data.story.previous[data.story.previous.length - 1]
    const shown = !original && last ? last.text : ''
    const named = Array.isArray(args.chapterNos) ? args.chapterNos : []
    data.story.earlier = data.story.earlier.filter(
      p => named.includes(p.chapterNo) || p.chapterId !== last?.chapterId || !shown.includes(p.text)
    )
    // 还没整理出章节卡的近几章原文最先让位；再让上上章结尾；上一章最少保住结尾两千字。
    while (!fits() && data.story.unindexedRecent?.length) data.story.unindexedRecent.shift()
    const history = data.story.history
    if (history && !fits()) {
      const related = history.openThreads.filter(clue => clue.related)
      history.otherOpenCount = history.openThreads.length - related.length
      history.openThreads = related
    }
    if (history && !fits()) {
      const required = Array.isArray(args.chapterNos) ? args.chapterNos : []
      const kept = data.story.earlier.filter(p => required.includes(p.chapterNo))
      history.omittedSearchPassages = data.story.earlier.length - kept.length
      data.story.earlier = kept
    }
    if (history && !fits()) {
      const story = data.story
      fitRanked(
        story.facts,
        (kept, omitted) => {
          story.facts = kept
          history.otherFacts = omitted
        },
        fits
      )
    }
    if (history && !fits()) {
      const alreadyOmitted = history.otherOpenCount ?? 0
      fitRanked(
        history.openThreads,
        (kept, omitted) => {
          history.openThreads = kept
          history.otherOpenCount = alreadyOmitted + omitted
        },
        fits
      )
    }
    if (!fits()) data.beforeLimit = 0
    if (!fits()) data.previousLimit = 2000
  }
  if (!fits()) throw Error('作者要求及必要资料超过当前模型容量，请选择分段或缩小范围')
  signal?.throwIfAborted()
  await beforeRequest?.(mode === 'new_chapter' || (mode === 'chapter' && !original.trim()), plan, {
    volumePlanned: sources?.volumePlanned ?? true,
    plannedAhead: sources?.plannedAhead ?? 0
  })
  signal?.throwIfAborted()
  let failure = ''
  const result = await streamLocalChatCompletion(
    {
      modelCode,
      scene: 'pi_prose',
      sceneLabel: 'Agent 正文',
      signal,
      requireComplete: true,
      maxTokens: output,
      messages: proseMessages(data)
    },
    {
      onDelta: () => {},
      onDone: () => {},
      onError: m => {
        failure = m
      }
    }
  )
  signal?.throwIfAborted()
  if (failure || result.finishReason !== 'stop' || !result.content.trim())
    throw Error(failure || '正文未完整生成，未交付候选')
  const shared = {
    id: prior?.id || sessionId + ':' + String(args.turnId) + ':prose',
    sessionId,
    bookId: bookId || '',
    title,
    content: result.content.trim(),
    createdAt: Date.now(),
    proseSource: {
      historyAnchor: sources?.historyAnchor,
      skill: skill?.enabled ? skill.id : '',
      skillVersion: skill?.enabled ? skill.updatedAt : 0,
      model: model.modelCode,
      ...(samples
        ? {
            sampleVersion: samples.version,
            sampleIds: data.samples.map(s => s.id)
          }
        : {}),
      expressionSamples: data.samples.map(s => ({ id: s.id, from: s.from })),
      editExampleIds: data.edits.map(e => e.id),
      inputIds: author.map(item => item.id),
      chapters: [...(sources?.previous || []), ...(data.story?.earlier || [])].map(
        ({ chapterId, version }) => ({ chapterId, version })
      ),
      callId: request.callId
    }
  }
  const planned = plan ? { plan } : {}
  if (prior) {
    if (selection) {
      const start = prior.content
        .split(selection.text)
        .slice(0, selection.occurrence)
        .join(selection.text).length
      shared.content =
        prior.content.slice(0, start) + shared.content + prior.content.slice(start + selection.text.length)
    }
    return { ...prior, ...shared, ...(prior.kind === 'chapter' || prior.kind === 'new_chapter' ? planned : {}) }
  }
  if (mode === 'short_story' || mode === 'text') return { ...shared, kind: mode }
  if (target)
    return {
      ...shared,
      ...planned,
      kind: 'chapter',
      chapterId: Number(target.chapterId),
      baseVersion: target.version,
      baseText: target.text,
      baseTitle: target.title,
      ...(selection ? { selection } : {})
    } satisfies PiChapterDraft
  if (mode === 'new_chapter' && sources)
    return {
      ...shared,
      ...planned,
      kind: 'new_chapter',
      appendAnchor: sources.appendAnchor,
      volumeId: String(args.volumeId),
      volumeTitle: sources.volumeTitle,
      placement: 'append'
    }
  throw Error('章节目标缺失')
}
