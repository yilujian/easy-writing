/** 查询可使用 * 表示整项。授权的 scopes 则逐平台保存，空串表示平台尚未确定。 */
export interface PiRankQuery {
  platform: string
  audience: string
  category: string
  rankType: string
}
export interface PiRankingPolicy {
  intent: 'none' | 'specified' | 'delegated' | 'unresolved'
  scopes: PiRankQuery[]
  cacheOnly: boolean
  refreshRequested: boolean
}
/** 榜单读取返回的实际来源；刷新确认仅使用平台返回的数据。 */
export interface PiRankRefreshSource {
  id: number
  name: string
  siteCode: string
  latestDate: string | null
  needsRefresh: boolean
  estimatedSeconds: [number, number]
  query: PiRankQuery
}
