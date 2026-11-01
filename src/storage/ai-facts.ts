import { writingCommand } from '@/writing-service/client'
import { onCanonChanged } from '@/writing-service/writing-context'
import { canUseAiIndex } from './ai-index'

/**
 * 故事状态的前端门面：数据只有一份，在宿主的作品状态层（章节卡、线索账本、折叠状态）。
 * 这里把它摊成直接场景与写作台惯用的"事实表"形状，函数名沿用，调用方不改。
 * 事实由宿主的索引器从正文提取；前端不再自己抽取。
 */

export type AiFactKind = 'state' | 'event' | 'foreshadow' | 'payoff' | 'relation'
export type AiFactStatus = 'auto' | 'confirmed' | 'rejected'

export interface AiFact {
  /** 记录在状态层里的稳定标识：state:章:人物:字段:顺序 / event:章:事件 / fact:章:事实 / thread:线索 */
  id: string
  chapterId: string
  /** 章节在全书的阅读顺序（从 1 起）；章节不在目录里为 0 */
  storyOrder: number
  kind: AiFactKind
  subject: string
  predicate: string
  object: string
  text: string
  quote: string
  confidence: number
  status: AiFactStatus
  threadId?: string
}

export interface AiFactQuery {
  subjects?: string[]
  kinds?: AiFactKind[]
  /** 只看该章及之前 */
  untilChapterId?: string | number | null
  fromChapterId?: string | number | null
  /** 只看这一章（忽略范围过滤） */
  chapterId?: string | number | null
  keyword?: string
  includeRejected?: boolean
  /** 取最靠后的 N 条 */
  limit?: number
}

export interface AiFactSummary {
  facts: number
  confirmed: number
  rejected: number
  chaptersExtracted: number
  chaptersTotal: number
}

export interface StoryChapter {
  id: string
  order: number
  title: string
}

export interface StoryIndexProgress {
  indexed: number
  stale: number
  total: number
  pendingEvents: number
  paused: boolean
  lastRunAt?: number | null
  failed?: unknown
}

export interface StoryView {
  records: AiFact[]
  chapters: StoryChapter[]
  summary: AiFactSummary
  progress: StoryIndexProgress
}

const EMPTY_SUMMARY: AiFactSummary = { facts: 0, confirmed: 0, rejected: 0, chaptersExtracted: 0, chaptersTotal: 0 }
const EMPTY_VIEW: StoryView = {
  records: [],
  chapters: [],
  summary: EMPTY_SUMMARY,
  progress: { indexed: 0, stale: 0, total: 0, pendingEvents: 0, paused: false },
}

const CACHE_MS = 3000
const cache = new Map<string, { at: number; value: Promise<StoryView> }>()
let listening = false

const invalidate = (bookId?: string | null) => {
  for (const key of [...cache.keys()]) if (!bookId || key === bookId) cache.delete(key)
}

/** 测试与切换作品时清缓存 */
export const resetStoryViewCache = () => invalidate()

/** 整本书的状态视图；几秒内复用，状态层变化（索引写完、作者标记）即失效 */
export const loadStoryView = (bookId: string | number): Promise<StoryView> => {
  if (!canUseAiIndex() || bookId == null || bookId === '') return Promise.resolve(EMPTY_VIEW)
  if (!listening) {
    listening = true
    onCanonChanged(changed => invalidate(changed))
  }
  const key = String(bookId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = writingCommand<StoryView>('canon_query', { bookId: key, view: 'story' }).catch(error => {
    console.warn('读取故事状态失败', error)
    return EMPTY_VIEW
  })
  cache.set(key, { at: Date.now(), value })
  return value
}

const orderOf = (view: StoryView, chapterId: string | number | null | undefined) => {
  if (chapterId == null || chapterId === '') return null
  const chapter = view.chapters.find(item => item.id === String(chapterId))
  return chapter ? chapter.order : null
}

const factOrder = (view: StoryView, fact: AiFact) => fact.storyOrder || orderOf(view, fact.chapterId) || 0

export const aiFactsQuery = async (bookId: string | number, query: AiFactQuery = {}): Promise<AiFact[]> => {
  const view = await loadStoryView(bookId)
  const until = orderOf(view, query.untilChapterId)
  const from = orderOf(view, query.fromChapterId)
  const only = query.chapterId == null || query.chapterId === '' ? null : String(query.chapterId)
  const keyword = String(query.keyword || '').trim().toLowerCase()
  const subjects = query.subjects?.map(item => item.trim()).filter(Boolean)
  let list = view.records.filter(fact => {
    if (!query.includeRejected && fact.status === 'rejected') return false
    if (query.kinds?.length && !query.kinds.includes(fact.kind)) return false
    if (subjects?.length && !subjects.some(name => fact.subject === name || (!fact.subject && fact.text.includes(name)))) return false
    if (only) {
      if (fact.chapterId !== only) return false
    } else {
      const order = factOrder(view, fact)
      if (until != null && order > until) return false
      if (from != null && order < from) return false
    }
    if (keyword && !`${fact.subject}\n${fact.object}\n${fact.text}`.toLowerCase().includes(keyword)) return false
    return true
  })
  list = [...list].sort((a, b) => factOrder(view, a) - factOrder(view, b))
  if (query.limit && list.length > query.limit) list = list.slice(list.length - query.limit)
  return list
}

/** 截至某章仍未回收的伏笔（作者否决过的不算） */
export const aiFactsOpenForeshadows = async (bookId: string | number, untilChapterId?: string | number | null): Promise<AiFact[]> =>
  aiFactsQuery(bookId, { kinds: ['foreshadow'], untilChapterId })

export const aiFactsSummary = async (bookId: string | number): Promise<AiFactSummary> => (await loadStoryView(bookId)).summary

/** 作者的确认 / 否决 / 恢复：落宿主的作者数据区；否决的状态变化立即退出折叠结果 */
export const aiFactsSetStatus = async (bookId: string | number, id: string, status: AiFactStatus) => {
  await writingCommand('canon_mark', { bookId: String(bookId), recordKey: id, mark: status })
  invalidate(String(bookId))
}

/** 让索引器整理：传章节只整理这几章（已有章节卡的先作废），否则补全书缺的 */
export const aiFactsRebuild = (bookId: string | number, chapterIds?: Array<string | number>) =>
  writingCommand<{ queued: number }>('index_rebuild', {
    bookId: String(bookId),
    onlyMissing: !chapterIds?.length,
    chapterIds: (chapterIds || []).map(String),
  })
