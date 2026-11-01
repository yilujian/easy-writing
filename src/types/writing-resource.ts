/** 写作资源与验证记录；公共推荐状态只能由管理界面的人工操作改变。 */
export type WritingResourceKind = 'technique' | 'case' | 'style' | 'market'
export type WritingResourceStatus = 'pending_review' | 'pending_validation' | 'recommended' | 'not_recommended'
export interface WritingResourceInput {
  title: string
  kind: WritingResourceKind
  problem: string
  conditions: string[]
  exclusions: string[]
  tags: string[]
  aliases: string[]
  context: string
  content: string
  explanation: string
  source: { title: string; url: string; locator: string; version: string; date: string; rights: 'original' | 'licensed' | 'link_only'; rightsNote: string }
  scope: 'public' | 'author' | 'book'
  bookId: string
}
export interface ResourceEvaluation {
  id: string
  materialVersion: number
  reviewer: string
  model: string
  task: string
  scope: string
  conclusion: 'supports' | 'mixed' | 'unsupported'
  hasFactIssues: boolean
  notes: string
  outputRefs: string[]
  at: number
}
export interface WritingResource extends WritingResourceInput {
  id: string
  version: number
  /** 内容变更递增；仅修改核对/验证状态不改变材料版本。 */
  materialVersion: number
  owner: string
  enabled: boolean
  status: WritingResourceStatus
  review: { reviewer: string; notes: string; at: number; materialVersion: number } | null
  evaluations: ResourceEvaluation[]
  createdAt: number
  updatedAt: number
}
export interface WritingResourceRecord {
  type: 'resource'
  id: string
  current: WritingResource
  history: WritingResource[]
}
export interface ResourceUse {
  id: string
  version: number
  title: string
  reason: string
  paragraphFrom: number
  paragraphTo: number
  includeExplanation: boolean
  characterOffset: number
  nextCharacterOffset: number
}
export interface ResourceUsage {
  type: 'usage'
  id: string
  sessionId: string
  bookId: string
  turnId: string
  callId: string
  kind: 'search' | 'read'
  query: string
  context: string
  constraints: string
  candidates: Array<{ id: string; version: number; title: string }>
  read: ResourceUse | null
  at: number
}
