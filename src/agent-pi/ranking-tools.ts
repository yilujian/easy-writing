import {
  RANK_SOURCES,
  findRankCategory,
  rankCategoryOptions,
  type RankSeedSource
} from '@/config/rank-sources'
import {
  readNewestSnapshot,
  readSnapshot,
  listSourceSnapshotDates,
  listNewestSnapshotDates,
  crawlLocalRankSource,
  filterRankItemsByCategory,
  attachCompare,
  localDate
} from '@/storage/local-rank-store'
import { platformCodes, rankingScopeReady, resolveRankingSources, sourceQuery } from './ranking-scope'
import type { PiRankQuery, PiRankingPolicy, PiRankRefreshSource } from '@/types/pi-rankings'

const platformNames: Record<string, string> = { fanqie: '番茄小说', qidian: '起点中文网', qimao: '七猫小说' }
const genders: Record<string, string> = { 男频: 'male', 女频: 'female', male: 'male', female: 'female' }
const sourceInfo = (source: RankSeedSource) => {
  const category = findRankCategory(source.categoryLegacyId)
  const gender = category?.gender || String(source.meta?.gender || '')
  const channel = gender === 'male' ? '男频' : gender === 'female' ? '女频' : '综合'
  return {
    id: source.legacyId,
    name: `${channel}${source.title}·${category?.name || '全分类'}`,
    siteCode: source.siteCode,
    rankType: source.rankType,
    rankName: source.title,
    gender,
    channel,
    scope: category ? 'category' : 'all',
    categoryId: category?.legacyId ?? null,
    categoryName: category?.name || '全分类',
    categoryCode: category?.code ?? null
  }
}
const enabledSources = () => RANK_SOURCES.filter(source => source.enabled === 1).map(sourceInfo)
const refreshSource = (
  source: RankSeedSource,
  latestDate: string | null,
  query: PiRankQuery
): PiRankRefreshSource => ({
  id: source.legacyId,
  name: platformNames[source.siteCode] + ' · ' + sourceInfo(source).name,
  siteCode: source.siteCode,
  latestDate,
  needsRefresh: !latestDate || latestDate < localDate(),
  query,
  estimatedSeconds:
    source.siteCode === 'fanqie' ? [3, 30] : source.siteCode === 'qidian' ? [60, 300] : [10, 60]
})
function scopeOf(args: Record<string, unknown>) {
  const input = args.platform === '*' ? '' : String(args.platform || '').trim()
  const platform = platformCodes[input] || input
  if (platform && !Object.prototype.hasOwnProperty.call(platformNames, platform))
    throw new Error('请选择番茄、起点或七猫；跨平台比较请分别读取作者指定范围')
  const audience = args.audience === '*' ? '' : String(args.audience || '').trim(),
    gender = genders[audience] || ''
  if (audience && !gender)
    throw new Error('榜单频道为男频或女频，请按已明确的目标读者选择；不确定时先询问作者')
  return {
    platform,
    gender,
    category: args.category === '*' ? '' : String(args.category || '').trim(),
    rankType: args.rankType === '*' ? '' : String(args.rankType || '').trim()
  }
}
function categoryFor(site: string, gender: string, requested: string) {
  return rankCategoryOptions(site, gender).find(
    category => category.name === requested || category.code === requested
  )
}
const categoryNames = (categories: ReturnType<typeof rankCategoryOptions>) => [
  ...new Set(categories.map(category => category.name))
]

function categoryGap(site: string, gender: string, requested: string) {
  return {
    needsCategoryMapping: true,
    requestedCategory: requested,
    categories: categoryNames(rankCategoryOptions(site, gender)),
    note: '此名称不是该平台分类。请结合作者故事在分类表中选择对应类别；这里只匹配检索分类，不改变作者故事定位。无适合分类时说明缺口。'
  }
}
export async function listRankings(args: Record<string, unknown>) {
  const scope = scopeOf(args)
  const policy = args.rankingPolicy as PiRankingPolicy | undefined
  const authorized = rankingScopeReady(policy) ? policy : null
  const dates = await listNewestSnapshotDates(),
    today = localDate()
  const inScope = enabledSources().filter(
    source =>
      (!scope.platform || source.siteCode === scope.platform) &&
      (!scope.gender || source.gender === scope.gender)
  )
  if (scope.category && scope.platform && !categoryFor(scope.platform, scope.gender, scope.category))
    return categoryGap(scope.platform, scope.gender, scope.category)
  const sources = inScope.filter(
    source =>
      (!scope.rankType || source.rankType === scope.rankType || source.rankName === scope.rankType) &&
      (!scope.category ||
        (source.categoryId
          ? source.categoryName === scope.category || source.categoryCode === scope.category
          : !!categoryFor(source.siteCode, source.gender, scope.category)))
  )
  return {
    kind: 'catalog',
    contentsRead: false,
    contentReading: {
      access: authorized
        ? {
            state: 'authorized',
            allowedScopes: authorized.scopes,
            selectsBoard: authorized.intent === 'delegated' ? 'agent' : 'author',
            cacheOnly: authorized.cacheOnly
          }
        : { state: 'awaiting_author_scope' },
      category: '易创按平台分类自动读取或筛选，适用于分类榜和频道总榜，保留来源原名次',
      keyword: '易创对书名和简介做逐字匹配',
      cache: '已有快照可按标注日期使用，联网更新另行确认',
      theme: 'Agent 读取书名和完整简介后分析是否符合作者的细分题材；目录本身不包含作品分析结果'
    },
    groups: Object.entries(platformNames)
      .filter(([site]) => !scope.platform || site === scope.platform)
      .map(([siteCode, platform]) => ({
        siteCode,
        platform,
        sourceCount: sources.filter(source => source.siteCode === siteCode).length,
        channels: ['male', 'female']
          .filter(gender => !scope.gender || gender === scope.gender)
          .map(gender => {
            const selected = sources.filter(s => s.siteCode === siteCode && s.gender === gender),
              cached = selected
                .map(s => dates.get(s.id))
                .filter((date): date is string => !!date)
                .sort()
            return {
              audience: gender === 'male' ? '男频' : '女频',
              sourceCount: selected.length,
              cachedCount: cached.length,
              oldestDate: cached[0] || null,
              latestDate: cached[cached.length - 1] || null,
              categories: categoryNames(
                rankCategoryOptions(siteCode, gender).filter(category =>
                  selected.some(source => !source.categoryId || source.categoryId === category.id)
                )
              )
            }
          }),
        sources: sources
          .filter(s => s.siteCode === siteCode)
          .map(s => ({
            name: s.categoryId ? s.name : `${s.channel}${s.rankName}`,
            query: sourceQuery(
              RANK_SOURCES.find(source => source.legacyId === s.id)!,
              scope.category || undefined
            ),
            siteCode: s.siteCode,
            channel: s.channel,
            rankType: s.rankType,
            reading: {
              sourceType: s.categoryId ? '独立分类榜' : '频道总榜',
              categoryHandling: s.categoryId
                ? '按分类读取对应榜单'
                : '易创按作品分类自动筛选总榜条目，无需作者人工挑选',
              preservesOriginalRank: true
            },
            latestDate: dates.get(s.id) || null,
            cacheStatus: dates.has(s.id)
              ? dates.get(s.id) === today
                ? '当天快照可读'
                : '已有快照可按标注日期读取'
              : '暂无本地快照'
          }))
      })),
    matchingSourceCount: sources.length
  }
}
function selected(args: Record<string, unknown>) {
  if ('sourceId' in args || 'sourceIds' in args || 'overview' in args)
    throw new Error('榜单接口使用查询条件，不接受内部来源编号或旧概览参数')
  return resolveRankingSources(args.rankingPolicy as PiRankingPolicy | null, args.queries)
}
export async function readRankings(args: Record<string, unknown>) {
  const resolved = selected(args)
  if (!resolved.selected) return resolved
  const policy = args.rankingPolicy as PiRankingPolicy
  const cacheOnly = policy.cacheOnly || args.cacheOnly === true
  if (args.prepareRefresh === true) {
    if (cacheOnly) return { blocked: true, reason: '作者要求只使用本地资料，本次不能刷新。' }
    const dates = await listNewestSnapshotDates()
    return {
      sources: [
        ...new Map(
          resolved.selected.map(({ source, query }) => [
            source.legacyId,
            refreshSource(source, dates.get(source.legacyId) || null, query)
          ])
        ).values()
      ]
    }
  }
  const mode = args.mode ?? 'single'
  if (!['single', 'overview'].includes(String(mode))) throw new Error('请明确读取单榜或范围概览')
  if (mode === 'single' && resolved.selected.length !== 1)
    return {
      needsSelection: true,
      reason: '这些条件对应多个真实榜单，请选择具体榜种或分类；未读取内容。',
      candidates: resolved.selected.map(({ source, query }) => ({ name: sourceInfo(source).name, query }))
    }
  const samples = [],
    refreshSources: PiRankRefreshSource[] = []
  const exclude = new Set(Array.isArray(args.excludeKeys) ? args.excludeKeys.map(String) : [])
  for (const { source, query } of resolved.selected) {
    const sample = await readSource(source, {
      ...args,
      ...query,
      category: query.category === '*' ? '' : query.category,
      ...(mode === 'overview' ? { limit: 5, offset: 0 } : {}),
      excludeKeys: [...exclude]
    })
    samples.push(sample)
    if (!cacheOnly && 'refreshSources' in sample) refreshSources.push(...sample.refreshSources)
    if ('snapshot' in sample) for (const item of sample.snapshot?.items || []) exclude.add(item.dedupeKey)
  }
  const uniqueRefresh = [...new Map(refreshSources.map(source => [source.id, source])).values()]
  if (mode === 'single') return { ...samples[0], cacheOnly, refreshSources: uniqueRefresh }
  return {
    mode: 'explore',
    cacheOnly,
    sourceCount: samples.length,
    samples,
    refreshSources: uniqueRefresh,
    scope: resolved.selected.map(({ source, query }) => ({ ...sourceInfo(source), query })),
    note: '仅组合作者本次范围，每榜前五本；保留来源和日期，不跨榜重新排名。'
  }
}
async function readSource(source: RankSeedSource, args: Record<string, unknown>, scope = scopeOf(args)) {
  const info = sourceInfo(source)
  if (
    (scope.platform && scope.platform !== info.siteCode) ||
    (scope.gender && scope.gender !== info.gender) ||
    (scope.rankType && scope.rankType !== info.rankType)
  )
    throw new Error('此榜单与指定的平台、频道或榜单类型不匹配，请使用对应来源')
  const category = scope.category ? categoryFor(info.siteCode, info.gender, scope.category) : undefined
  if (scope.category && !category) return categoryGap(info.siteCode, info.gender, scope.category)
  if (category && info.categoryCode && category.code !== info.categoryCode)
    throw new Error('此来源不属于指定分类，请从来源目录选择对应榜单')
  const snapshot = args.date
    ? await readSnapshot(source.legacyId, String(args.date))
    : await readNewestSnapshot(source.legacyId)
  const dates = await listSourceSnapshotDates(source.legacyId),
    today = localDate()
  const latestDate = snapshot?.statDate || null
  const refreshSources =
    !args.date && (!latestDate || latestDate < today)
      ? [refreshSource(source, latestDate, sourceQuery(source, scope.category || undefined))]
      : []
  const refreshPlan = refreshSource(source, latestDate, sourceQuery(source, scope.category || undefined))
  const freshness = {
    statDate: latestDate,
    stale: !latestDate || latestDate < today,
    historical: !!args.date
  }
  if (!snapshot)
    return {
      source: info,
      dates,
      snapshot: null,
      freshness,
      refreshSources,
      refreshSource: refreshPlan,
      note: '此来源在所选日期没有本地快照。'
    }
  const limit = Number(args.limit ?? 12),
    offset = Number(args.offset ?? 0)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('榜单范围无效：limit 为1—20，offset 为非负整数')
  const fullIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : []
  if (args.itemIds && (!fullIds.length || fullIds.length > 3 || new Set(fullIds).size !== fullIds.length))
    throw new Error('每次选择1—3个不同 itemId')
  const keyed = snapshot.items.map((item, index) => ({
    item,
    itemId: `${source.legacyId}:${snapshot.statDate}:${index + 1}`,
    dedupeKey: item.authorName
      ? `${item.bookTitle.trim()}|${item.authorName.trim()}`
      : `${source.siteCode}:${item.bookId || item.bookUrl || item.bookTitle}`
  }))
  if (fullIds.some(id => !keyed.some(item => item.itemId === id)))
    throw new Error('作品编号不属于所选来源和日期，请使用返回的 itemId')
  const filtered =
    category && !info.categoryId ? new Set(filterRankItemsByCategory(snapshot.items, category.code)) : null
  const keyword = String(args.keyword || '')
    .trim()
    .toLocaleLowerCase()
  const matching = keyed.filter(
    ({ item }) =>
      (!filtered || filtered.has(item)) &&
      (!keyword || `${item.bookTitle}\n${item.intro || ''}`.toLocaleLowerCase().includes(keyword))
  )
  const window = fullIds.length
    ? matching.filter(item => fullIds.includes(item.itemId))
    : matching.slice(offset, offset + limit)
  const exclude = new Set(Array.isArray(args.excludeKeys) ? args.excludeKeys.map(String) : [])
  const omitted: Array<{ dedupeKey: string; itemId: string; rankNo: number }> = []
  const previous = args.compareDate ? await readSnapshot(source.legacyId, String(args.compareDate)) : null
  const compared = attachCompare(snapshot.items, previous)
  const comparisons = new Map(snapshot.items.map((item, index) => [item, compared[index]]))
  const items = window.flatMap(({ item, itemId, dedupeKey }) => {
    if (exclude.has(dedupeKey)) {
      omitted.push({ dedupeKey, itemId, rankNo: item.rankNo })
      return []
    }
    exclude.add(dedupeKey)
    const intro = item.intro || '',
      comparison = comparisons.get(item)!
    return [
      {
        itemId,
        dedupeKey,
        rankNo: item.rankNo,
        bookId: item.bookId || null,
        bookTitle: item.bookTitle,
        authorName: item.authorName || '',
        bookUrl: item.bookUrl,
        categoryName: item.categoryName || info.categoryName,
        categoryMainName: item.categoryMainName,
        categorySubName: item.categorySubName,
        intro,
        introLength: intro.length,
        ...(args.compareDate
          ? { prevRankNo: comparison.prevRankNo ?? null, rankChangeDelta: comparison.rankChangeDelta ?? null }
          : {})
      }
    ]
  })
  const terms = Array.isArray(args.countTerms) ? args.countTerms.map(String) : []
  if (terms.length > 10 || terms.some(t => !t || t.length > 40))
    throw new Error('统计词须为最多10个、每个1—40字的明确文字')
  const statistics = terms.length
    ? {
        rule: '书名或完整简介原文包含任一指定词（逐字匹配，不做语义推断）',
        terms,
        denominator: window.length,
        matches: window
          .filter(({ item }) => terms.some(term => `${item.bookTitle}\n${item.intro || ''}`.includes(term)))
          .map(i => i.itemId)
      }
    : undefined
  return {
    source: info,
    dates,
    freshness,
    refreshSources,
    refreshSource: refreshPlan,
    snapshot: {
      sourceId: source.legacyId,
      statDate: snapshot.statDate,
      fetchedAt: snapshot.fetchedAt,
      total: matching.length,
      sourceTotal: snapshot.items.length,
      items
    },
    range: {
      offset: fullIds.length ? null : offset,
      sampled: window.length,
      returned: items.length,
      omittedDuplicates: omitted,
      nextOffset: !fullIds.length && offset + limit < matching.length ? offset + limit : null,
      mode: fullIds.length ? 'detail' : 'overview'
    },
    citation: `${platformNames[source.siteCode]}·${info.name}·${snapshot.statDate}·实际返回${items.length}本`,
    ...(category && !info.categoryId
      ? {
          categoryFilter: {
            name: category.name,
            scope: 'items_in_total_ranking',
            note: '这是所选总榜中按条目分类筛出的样本，不是一个独立分类榜。其他来源是否存在以来源目录为准。'
          }
        }
      : {}),
    ...(args.compareDate
      ? {
          comparison: {
            requestedDate: String(args.compareDate),
            available: !!previous,
            date: previous?.statDate || null
          }
        }
      : {}),
    ...(statistics ? { statistics: { ...statistics, count: statistics.matches.length } } : {})
  }
}

export async function refreshRankings(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: (text: string) => void
) {
  const resolved = selected(args)
  if (!resolved.selected) return resolved
  if ((args.rankingPolicy as PiRankingPolicy).cacheOnly)
    return { blocked: true, reason: '作者要求只使用本地资料，本次不能刷新。' }
  if (resolved.selected.length !== 1) throw new Error('一次刷新须对应一个已确认的真实榜单')
  const { source, query } = resolved.selected[0]
  signal?.throwIfAborted()
  if (args.onlyOutdated === true) {
    const snapshot = await readNewestSnapshot(source.legacyId)
    if (snapshot && snapshot.statDate >= localDate())
      return {
        crawled: false,
        reason: 'current_date',
        message: '已有当天数据，未重复抓取',
        ...(await readRankings({
          queries: [query],
          mode: 'single',
          cacheOnly: true,
          rankingPolicy: args.rankingPolicy
        }))
      }
  }
  progress?.('正在检查榜单缓存')
  const result = await crawlLocalRankSource(source.legacyId, {
    manual: true,
    signal,
    waitForCancellation: true,
    onFetchStart: () => progress?.('正在抓取指定榜单')
  })
  signal?.throwIfAborted()
  return {
    ...result,
    ...(await readRankings({
      queries: [query],
      mode: 'single',
      cacheOnly: true,
      rankingPolicy: args.rankingPolicy
    }))
  }
}
