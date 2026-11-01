import {
  RANK_SOURCES,
  findRankCategory,
  rankCategoryOptions,
  rankPlatformOptions
} from '../config/rank-sources.js'
import type { RankSeedSource } from '../config/rank-sources.js'
import type { PiRankQuery, PiRankingPolicy } from '../types/pi-rankings.js'

export const platformCodes: Record<string, string> = {
  ...Object.fromEntries(
    rankPlatformOptions().flatMap(site => [
      [site.name, site.code],
      [site.code, site.code]
    ])
  ),
  番茄: 'fanqie',
  番茄小说: 'fanqie',
  起点: 'qidian',
  七猫: 'qimao',
  七猫小说: 'qimao'
}

export const rankingPlatforms = rankPlatformOptions().map(site => site.code)

export const rankingVocabulary = () =>
  rankPlatformOptions().map(site => ({
    platform: site.code,
    name: site.name,
    audiences: ['male', 'female'].map(audience => ({
      audience,
      name: audience === 'male' ? '男频' : '女频',
      ranks: [
        ...new Map(
          RANK_SOURCES.filter(
            source =>
              source.enabled === 1 && source.siteCode === site.code && sourceGender(source) === audience
          ).map(source => [source.rankType, { rankType: source.rankType, name: source.title }])
        ).values()
      ],
      categories: rankCategoryOptions(site.code, audience).map(category => ({
        name: category.name,
        code: category.code
      }))
    }))
  }))
export const sourceGender = (source: RankSeedSource) =>
  findRankCategory(source.categoryLegacyId)?.gender || String(source.meta?.gender || '')
export const sourceQuery = (
  source: RankSeedSource,
  category = findRankCategory(source.categoryLegacyId)?.name || '*'
): PiRankQuery => ({
  platform: source.siteCode,
  audience: sourceGender(source),
  category,
  rankType: source.rankType
})
const fields = ['platform', 'audience', 'category', 'rankType'] as const
export function validRankingPolicy(value: unknown): value is PiRankingPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as PiRankingPolicy
  return (
    ['none', 'specified', 'delegated', 'unresolved'].includes(p.intent) &&
    typeof p.cacheOnly === 'boolean' &&
    typeof p.refreshRequested === 'boolean' &&
    Object.keys(p).every(key => ['intent', 'scopes', 'cacheOnly', 'refreshRequested'].includes(key)) &&
    Array.isArray(p.scopes) &&
    (p.intent === 'none' ? p.scopes.length === 0 : p.intent === 'unresolved' || p.scopes.length > 0) &&
    p.scopes.every(
      scope =>
        !!scope &&
        typeof scope === 'object' &&
        Object.keys(scope).length === fields.length &&
        (scope.platform === '' || rankingPlatforms.includes(scope.platform)) &&
        fields.every(key => typeof scope[key] === 'string' && scope[key].length <= 120)
    ) &&
    [...rankingPlatforms, ''].every(
      platform => p.scopes.filter(scope => scope.platform === platform).length <= 16
    )
  )
}
export const rankingQueryLimit = RANK_SOURCES.filter(source => source.enabled === 1).reduce(
  (count, source) =>
    count +
    (source.categoryLegacyId ? 1 : 1 + rankCategoryOptions(source.siteCode, sourceGender(source)).length),
  0
)
function normalize(query: PiRankQuery, vocabulary: ReturnType<typeof rankingVocabulary>): PiRankQuery {
  const site = vocabulary.find(site => site.platform === query.platform || site.name === query.platform)
  const platform = site?.platform || query.platform
  const audience = query.audience === '男频' ? 'male' : query.audience === '女频' ? 'female' : query.audience
  const channel = site?.audiences.find(channel => channel.audience === audience)
  const rank = channel?.ranks.find(rank => rank.rankType === query.rankType || rank.name === query.rankType)
  const category = channel?.categories.find(
    category => category.name === query.category || category.code === query.category
  )
  return {
    platform,
    audience,
    category: category?.name || query.category,
    rankType: rank?.rankType || query.rankType
  }
}
export const rankingScopeReady = (policy: PiRankingPolicy | null | undefined) =>
  !!policy &&
  validRankingPolicy(policy) &&
  ['specified', 'delegated'].includes(policy.intent) &&
  policy.scopes.every(scope => fields.every(key => !!scope[key].trim()))
export function resolveRankingSources(policy: PiRankingPolicy | null | undefined, queries: unknown) {
  if (!policy || !validRankingPolicy(policy) || policy.intent === 'none')
    return { blocked: true as const, reason: '本次作者要求不涉及榜单内容，请完成当前创作要求。' }
  const vocabulary = rankingVocabulary()
  const scopes = policy.scopes.map(scope => normalize(scope, vocabulary))
  if (!rankingScopeReady(policy))
    return {
      needsScope: true as const,
      scopes,
      reason: '榜单范围尚未确定，请依据作者要求补齐必要范围或取得选择委托；不要自行指定平台。'
    }
  const requested = queries === undefined ? scopes : queries
  if (!Array.isArray(requested) || !requested.length || requested.length > rankingQueryLimit)
    throw new Error('查询条件为空或超出可读目录规模')
  const selected = new Map<string, { source: RankSeedSource; query: PiRankQuery }>()
  for (const raw of requested) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).length !== fields.length ||
      !fields.every(key => typeof raw[key] === 'string' && raw[key].trim())
    )
      throw new Error('查询条件须包含平台、频道、分类和榜种；不接受内部来源编号')
    const query = normalize(raw, vocabulary)
    const platforms = query.platform === '*' ? rankingPlatforms : [query.platform]
    if (
      !platforms.every(platform =>
        scopes.some(
          scope =>
            scope.platform === platform &&
            (['audience', 'category', 'rankType'] as const).every(
              key => scope[key] === '*' || scope[key] === query[key]
            )
        )
      )
    )
      return { blocked: true as const, reason: '查询条件超出作者当前指定或委托的范围，未读取榜单。', scopes }
    const sources = RANK_SOURCES.filter(source => {
      if (!source.enabled) return false
      const own = sourceQuery(source)
      if (
        !(['platform', 'audience', 'rankType'] as const).every(
          key => query[key] === '*' || query[key] === own[key]
        )
      )
        return false
      if (query.category === '*') return true
      return source.categoryLegacyId
        ? own.category === query.category
        : rankCategoryOptions(source.siteCode, sourceGender(source)).some(
            category => category.name === query.category
          )
    })
    if (!sources.length)
      return {
        needsSelection: true as const,
        query,
        available: rankingVocabulary(),
        reason: '没有与条件匹配的真实榜单，请从目录中的名称或分类选择。'
      }
    for (const source of sources) {
      const resolved = sourceQuery(source, query.category === '*' ? undefined : query.category)
      selected.set(JSON.stringify(resolved), { source, query: resolved })
    }
  }
  const matches = [...selected.values()]
  if (queries === undefined && policy.intent === 'delegated' && matches.length > 1)
    return {
      needsSelection: true as const,
      candidates: matches.map(({ query }) => query),
      reason: '作者已委托选择，请从实际匹配的条件中选取本次目标；未读取内容。'
    }
  return { selected: matches }
}
