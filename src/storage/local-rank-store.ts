import { withRecordStore } from './desktop-records'
import type {
  NovelRankHomePreference,
  NovelRankItem,
  NovelRankSnapshot,
  NovelRankSource,
} from '@/types/novel-rank'
import {
  RANK_SOURCES,
  findRankCategory,
  findRankCategoryByCode,
  findRankSource,
  rankCategoryOptions,
  rankPlatformOptions,
  type RankSeedSource,
} from '@/config/rank-sources'
import { crawlRankSource } from '@/utils/local-rank-crawler'

/**
 * 榜单本机库：快照存 IndexedDB，趋势靠每日快照日积月累。
 *
 * - 三档抓取模式：off（不发任何请求）/ manual（手动点抓）/ auto（每日自动补抓
 *   最近看过的榜单，形成趋势与分析报告的数据底座）；
 * - 频控：每源每日一份快照；手动重抓 30 分钟内走缓存并提示；
 * - 快照保留最近 120 天；分析口径（分布/标签风向/排名变化/竞品/作者/导出）
 *   在 local-rank-analysis.ts，全部从本机快照现算。
 */

const DB_NAME = 'ew-local-rank'
const STORE_NAME = 'kv'
const SETTINGS_KEY = 'settings'
const RETENTION_DAYS = 120
const MANUAL_RECRAWL_MIN_MS = 30 * 60 * 1000
const AUTO_CRAWL_MAX_SOURCES = 6

export type RankCrawlMode = 'off' | 'manual' | 'auto'

export interface LocalRankSettings {
  mode: RankCrawlMode
  /** 最近浏览过的榜单源（自动模式每日补抓的对象，去重保序，上限 12） */
  viewedSourceIds: number[]
  lastAutoDate: string
  lastAutoSummary: string
  homePreference: NovelRankHomePreference | null
}

export interface LocalRankSnapshotDoc {
  sourceId: number
  statDate: string
  fetchedAt: number
  pageTitle?: string
  cutoffText?: string
  items: NovelRankItem[]
}

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

const snapKey = (sourceId: number, date: string) => `snap:${sourceId}:${date}`

const readValue = async <T>(key: string): Promise<T | null> => {
  const stored = await withStore<unknown>('readonly', store => store.get(key))
  return (stored ?? null) as T | null
}

const writeValue = async (key: string, value: unknown) => {
  await withStore('readwrite', store => store.put(JSON.parse(JSON.stringify(value)), key))
}

export const localDate = (offsetDays = 0) => {
  const date = new Date(Date.now() - offsetDays * 86400000)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// 设置（三档模式 + 首页偏好 + 自动补抓记录）
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: LocalRankSettings = {
  mode: 'manual',
  viewedSourceIds: [],
  lastAutoDate: '',
  lastAutoSummary: '',
  homePreference: null,
}

export const getLocalRankSettings = async (): Promise<LocalRankSettings> => {
  const stored = await readValue<Partial<LocalRankSettings>>(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(stored || {}) }
}

export const saveLocalRankSettings = async (patch: Partial<LocalRankSettings>) => {
  const next = { ...(await getLocalRankSettings()), ...patch }
  await writeValue(SETTINGS_KEY, next)
  return next
}

/** 记录用户看过的榜单源：自动模式每天就补抓这些（上限 12，最新在前） */
const markLocalRankSourceViewed = async (sourceId: number) => {
  const settings = await getLocalRankSettings()
  const ids = [Number(sourceId), ...settings.viewedSourceIds.filter(id => id !== Number(sourceId))].slice(0, 12)
  await saveLocalRankSettings({ viewedSourceIds: ids })
}

// ---------------------------------------------------------------------------
// 快照读写与抓取
// ---------------------------------------------------------------------------

export const listSourceSnapshotDates = async (sourceId: number): Promise<string[]> => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  const prefix = `snap:${sourceId}:`
  return keys
    .map(String)
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length))
    .sort()
    .reverse()
}

export const readSnapshot = (sourceId: number, date: string) =>
  readValue<LocalRankSnapshotDoc>(snapKey(sourceId, date))

export const readNewestSnapshot = async (sourceId: number, notAfter?: string) => {
  const dates = await listSourceSnapshotDates(sourceId)
  const date = dates.find(item => !notAfter || item <= notAfter)
  return date ? await readSnapshot(sourceId, date) : null
}

const pruneSnapshots = async (sourceId: number) => {
  const dates = await listSourceSnapshotDates(sourceId)
  const cutoff = localDate(RETENTION_DAYS)
  for (const date of dates) {
    if (date < cutoff) {
      await withStore('readwrite', store => store.delete(snapKey(sourceId, date)))
    }
  }
}

export interface RankCrawlOutcome {
  crawled: boolean
  message: string
  snapshotDate: string | null
}

/** 抓取一个源并落快照；同日快照存在时手动重抓受 30 分钟频控保护 */
export const crawlLocalRankSource = async (
  sourceId: number,
  options: { manual?: boolean } = {}
): Promise<RankCrawlOutcome> => {
  const settings = await getLocalRankSettings()
  if (settings.mode === 'off') {
    return { crawled: false, message: '榜单抓取已关闭，可在页面右上角开启', snapshotDate: null }
  }
  const source = findRankSource(sourceId)
  if (!source || source.enabled !== 1) throw new Error('榜单源不存在或未启用')

  const today = localDate()
  const existing = await readSnapshot(sourceId, today)
  if (existing) {
    const age = Date.now() - Number(existing.fetchedAt || 0)
    if (!options.manual || age < MANUAL_RECRAWL_MIN_MS) {
      return {
        crawled: false,
        message: options.manual ? '半小时内已抓取过，展示当前数据' : '今日已抓取',
        snapshotDate: today,
      }
    }
  }

  const result = await crawlRankSource(source as RankSeedSource)
  const doc: LocalRankSnapshotDoc = {
    sourceId: Number(sourceId),
    statDate: today,
    fetchedAt: Date.now(),
    pageTitle: result.pageTitle,
    cutoffText: result.cutoffText,
    items: result.items,
  }
  await writeValue(snapKey(sourceId, today), doc)
  await pruneSnapshots(sourceId)
  return { crawled: true, message: `已抓取 ${result.items.length} 条`, snapshotDate: today }
}

/** 自动模式：每天补抓一次最近看过的榜单（应用打开期间触发，静默容错） */
export const maybeAutoCrawlLocalRank = async () => {
  const settings = await getLocalRankSettings()
  if (settings.mode !== 'auto') return
  const today = localDate()
  if (settings.lastAutoDate === today) return
  const targets = settings.viewedSourceIds
    .map(id => findRankSource(id))
    .filter((source): source is RankSeedSource => Boolean(source && source.enabled === 1))
    .slice(0, AUTO_CRAWL_MAX_SOURCES)
  if (!targets.length) {
    await saveLocalRankSettings({ lastAutoDate: today, lastAutoSummary: '暂无常看榜单，浏览一次后自动纳入' })
    return
  }
  let ok = 0
  let failed = 0
  for (const source of targets) {
    try {
      await crawlLocalRankSource(source.legacyId)
      ok += 1
    } catch (error) {
      failed += 1
      console.warn(`自动抓取榜单源 ${source.legacyId} 失败`, error)
    }
    await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800))
  }
  await saveLocalRankSettings({
    lastAutoDate: today,
    lastAutoSummary: `今日自动抓取 ${ok} 个榜单${failed ? `，失败 ${failed} 个` : ''}`,
  })
}

// ---------------------------------------------------------------------------
// 接口形状（与老服务端契约一致，页面零改动消费）
// ---------------------------------------------------------------------------

export const toSourceOption = (source: RankSeedSource): NovelRankSource => {
  const category = findRankCategory(source.categoryLegacyId)
  return {
    id: source.legacyId,
    rankType: source.rankType,
    title: source.title,
    url: source.url,
    categoryId: category?.legacyId ?? null,
    categoryName: category?.name ?? null,
    categoryCode: category?.code ?? null,
    gender: category?.gender ?? (source.meta?.gender as string | undefined) ?? null,
    scope: (source.meta?.scope as 'all' | 'category' | undefined) ?? (category ? 'category' : 'all'),
    metricName: (source.meta?.metricName as string | undefined) ?? (source.siteCode === 'fanqie' ? '在读' : null),
    metricMode: (source.meta?.metricMode as 'value' | 'none' | undefined) ?? 'value',
  }
}

export const enabledSources = (siteCode: string, filters: { rankType?: string; gender?: string } = {}) =>
  RANK_SOURCES.filter(source => {
    if (source.siteCode !== siteCode || source.enabled !== 1) return false
    if (filters.rankType && source.rankType !== filters.rankType) return false
    if (filters.gender) {
      const option = toSourceOption(source as RankSeedSource)
      if (option.gender && option.gender !== filters.gender) return false
    }
    return true
  }) as RankSeedSource[]

export const getLocalRankPlatforms = async () => ({ data: rankPlatformOptions() })

export const getLocalRankSources = async (params: { siteCode: string; rankType?: string; gender?: string }) => {
  const site = rankPlatformOptions().find(platform => platform.code === params.siteCode)
  const list = enabledSources(params.siteCode, params).map(toSourceOption)
  return { data: { site: { code: params.siteCode, name: site?.name || params.siteCode }, list } }
}

export const getLocalRankCategories = async (params: { siteCode: string; gender?: string; level?: number }) => {
  return { data: rankCategoryOptions(params.siteCode, params.gender) }
}

const toSnapshotMeta = (doc: LocalRankSnapshotDoc): NovelRankSnapshot => ({
  id: doc.sourceId,
  sourceId: doc.sourceId,
  statDate: doc.statDate,
  cutoffText: doc.cutoffText || null,
  pageTitle: doc.pageTitle || null,
  itemCount: doc.items.length,
})

/** 对照上一份快照补差值字段（prevRankNo/名次变动/指标变动） */
export const attachCompare = (items: NovelRankItem[], previous: LocalRankSnapshotDoc | null): NovelRankItem[] => {
  if (!previous) return items
  const prevByKey = new Map<string, NovelRankItem>()
  for (const item of previous.items) {
    prevByKey.set(item.bookId || item.bookTitle, item)
  }
  return items.map(item => {
    const prev = prevByKey.get(item.bookId || item.bookTitle)
    if (!prev) return { ...item, prevRankNo: null, rankChangeDelta: null, prevMetricValue: null, metricDelta: null }
    return {
      ...item,
      prevRankNo: prev.rankNo,
      rankChangeDelta: prev.rankNo - item.rankNo,
      prevMetricValue: prev.metricValue ?? null,
      metricDelta:
        item.metricValue != null && prev.metricValue != null ? item.metricValue - prev.metricValue : null,
    }
  })
}

// categoryCode → 分类名：快照条目只存分类名文本，用种子表还原后按名字匹配。
// code 给了但种子表查不到时返回空列表（如实呈现「无数据」，不静默回退成未过滤全量）。
const filterCategory = (items: NovelRankItem[], categoryCode?: string) => {
  const code = String(categoryCode || '').trim()
  if (!code) return items
  const name = findRankCategoryByCode(code)?.name || ''
  if (!name) return []
  return items.filter(item =>
    [item.categoryMainName, item.categoryName, item.categorySubName].some(
      value => String(value || '').trim() === name
    )
  )
}

const filterKeyword = (items: NovelRankItem[], keyword?: string) => {
  const text = String(keyword || '').trim().toLowerCase()
  if (!text) return items
  return items.filter(item =>
    `${item.bookTitle} ${item.authorName || ''} ${item.categoryName || ''}`.toLowerCase().includes(text)
  )
}

const paged = <T>(list: T[], page = 1, size = 20) => ({
  page,
  size,
  total: list.length,
  list: list.slice((page - 1) * size, page * size),
})

export const getLocalRankLatest = async (params: {
  sourceId: number
  statDate?: string
  compareDate?: string
  keyword?: string
  categoryCode?: string
  page?: number
  size?: number
}) => {
  await markLocalRankSourceViewed(params.sourceId)
  const doc = params.statDate
    ? await readSnapshot(params.sourceId, params.statDate)
    : await readNewestSnapshot(params.sourceId)
  if (!doc) {
    return { data: { snapshot: null, page: 1, size: params.size || 20, total: 0, list: [] as NovelRankItem[] } }
  }
  // 对照快照：显式指定日期优先，否则取严格早于当前快照的最近一份
  const dates = await listSourceSnapshotDates(params.sourceId)
  const compareDate = params.compareDate || dates.find(date => date < doc.statDate) || ''
  const compare = compareDate ? await readSnapshot(params.sourceId, compareDate) : null
  const items = filterKeyword(
    filterCategory(attachCompare(doc.items, compare), params.categoryCode),
    params.keyword
  )
  const { page, size, total, list } = paged(items, params.page || 1, params.size || 20)
  return { data: { snapshot: toSnapshotMeta(doc), page, size, total, list } }
}

export const getLocalRankLatestAll = async (params: {
  siteCode: string
  rankType?: string
  gender?: string
  statDate?: string
  compareDate?: string
  keyword?: string
  page?: number
  size?: number
}) => {
  const sources = enabledSources(params.siteCode, params)
  const merged: NovelRankItem[] = []
  const seen = new Set<string>()
  let newest: LocalRankSnapshotDoc | null = null
  for (const source of sources) {
    const doc = params.statDate
      ? await readSnapshot(source.legacyId, params.statDate)
      : await readNewestSnapshot(source.legacyId)
    if (!doc) continue
    if (!newest || doc.statDate > newest.statDate) newest = doc
    const option = toSourceOption(source)
    for (const item of doc.items) {
      const key = item.bookId || `${item.bookTitle}:${item.authorName || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ ...item, categoryName: item.categoryName || option.categoryName || null })
    }
  }
  merged.sort((a, b) => Number(b.metricValue || 0) - Number(a.metricValue || 0))
  const ranked = merged.map((item, index) => ({ ...item, rankNo: index + 1 }))
  const items = filterKeyword(ranked, params.keyword)
  const { page, size, total, list } = paged(items, params.page || 1, params.size || 20)
  return { data: { snapshot: newest ? toSnapshotMeta(newest) : null, page, size, total, list } }
}

// ---------------------------------------------------------------------------
// 首页偏好（本地设置）
// ---------------------------------------------------------------------------

export const getLocalRankHomePreference = async () => {
  return { data: (await getLocalRankSettings()).homePreference }
}

export const saveLocalRankHomePreference = async (data: NovelRankHomePreference) => {
  await saveLocalRankSettings({ homePreference: data })
  return { data }
}

export const cancelLocalRankHomePreference = async () => {
  await saveLocalRankSettings({ homePreference: null })
  return { data: undefined as void }
}
