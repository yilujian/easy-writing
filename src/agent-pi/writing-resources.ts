import { withRecordStore, mutateDesktopRecord } from '@/storage/desktop-records'
import { usesUnifiedStorage } from '@/storage/storage-mode'
import { LOCAL_USER_ID, getLocalLibraryStorage } from '@/storage/local-library'
import type { PiToolRequest } from '@/types/agent-pi'
import type { ResourceEvaluation, ResourceUsage, ResourceUse, WritingResource, WritingResourceInput, WritingResourceRecord, WritingResourceStatus } from '@/types/writing-resource'

const DB = 'ew-pi-writing-resources'
const STORE = 'records'
const owner = String(LOCAL_USER_ID)
const kinds = new Set(['technique', 'case', 'style', 'market'])
const statuses = new Set(['pending_review', 'pending_validation', 'recommended', 'not_recommended'])
const queues = new Map<string, Promise<unknown>>()
const store = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB, STORE, undefined, mode, run)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const fail = (message: string): never => { throw new Error(message) }
const str = (value: unknown, label: string, max: number, required = false): string => {
  if (typeof value !== 'string') return fail(`${label}须为文字`)
  const text = value.trim()
  if ((required && !text) || text.length > max) return fail(`${label}${required ? '不能为空且' : ''}不能超过 ${max} 字`)
  return text
}
const list = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length > 40) return fail(`${label}须为不超过 40 项的列表`)
  return [...new Set(value.map(item => str(item, label, 500, true)))]
}
/** 只接受资料字段，不能从导入包带入“人工已验证”状态。 */
export function normalizeResourceInput(raw: unknown): WritingResourceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('资源格式无效')
  const r = raw as WritingResourceInput
  if (!kinds.has(r.kind) || !['public', 'author', 'book'].includes(r.scope)) return fail('资源类别或范围无效')
  if (!r.source || !['original', 'licensed', 'link_only'].includes(r.source.rights)) return fail('请说明材料来源与使用范围')
  const url = str(r.source.url, '来源链接', 2000)
  if (url && !/^https?:\/\//i.test(url)) return fail('来源链接仅支持 http/https')
  const content = str(r.content, '完整样本', 100000)
  if (r.source.rights === 'link_only' && content) return fail('仅链接材料不能导入原文；请保留链接和自行整理的说明')
  const explanation = str(r.explanation, '方法说明', 12000)
  if (!content && !explanation) return fail('请填写样本或自行整理的说明')
  const bookId = r.scope === 'book' ? str(r.bookId, '作品', 80, true) : ''
  return {
    title: str(r.title, '名称', 120, true), kind: r.kind, problem: str(r.problem, '解决的问题', 1000, true),
    conditions: list(r.conditions, '适用条件'), exclusions: list(r.exclusions, '不适用条件'),
    tags: list(r.tags, '标签'), aliases: list(r.aliases, '同义表达'),
    context: str(r.context, '必要前情和后果', 12000), content, explanation,
    source: { title: str(r.source.title, '出处', 300, true), url, locator: str(r.source.locator, '原文位置', 1000),
      version: str(r.source.version, '来源版本', 200), date: str(r.source.date, '来源日期', 80), rights: r.source.rights,
      rightsNote: str(r.source.rightsNote, '使用范围说明', 2000, true) }, scope: r.scope, bookId
  }
}
const keyOf = (id: string) => `resource:${id}`
const recordOf = (value: unknown): WritingResourceRecord | null => {
  const r = value as WritingResourceRecord | null
  return r?.type === 'resource' && r.current?.id === r.id && Array.isArray(r.history) ? r : null
}
const announce = () => window.dispatchEvent(new CustomEvent('ew-pi-resources-changed'))
async function mutate<T>(key: string, change: (value: unknown) => { value: unknown; result: T }): Promise<T> {
  if (usesUnifiedStorage()) return mutateDesktopRecord<T>(`${DB}/${STORE}`, key, change)
  const next = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(() =>
    store<T>('readwrite', async s => { const changed = change(await s.get(key)); await s.put(changed.value, key); return changed.result }))
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}
export async function listWritingResources(): Promise<WritingResource[]> {
  return (await store<unknown[]>('readonly', s => s.getAll())).map(recordOf).filter((r): r is WritingResourceRecord => !!r && r.current.owner === owner)
    .map(r => r.current).sort((a, b) => b.updatedAt - a.updatedAt)
}
export const getWritingResourceRecord = async (id: string) => {
  const r = recordOf(await store<unknown>('readonly', s => s.get(keyOf(id))))
  return r?.current.owner === owner ? r : null
}
export async function saveWritingResource(raw: unknown, id: string = crypto.randomUUID(), expectedVersion = 0): Promise<WritingResource> {
  const input = normalizeResourceInput(raw)
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(id)) return fail('资源编号无效')
  if (input.scope === 'book') {
    const books = await getLocalLibraryStorage().listLocalBooks({ sortBy: 'updateTime', sortOrder: 'DESC' })
    if (!books.some(book => String(book.id) === input.bookId)) return fail('目标作品不存在，请重新选择')
  }
  const result = await mutate(keyOf(id), value => {
    const prior = recordOf(value)
    if (value != null && !prior) return fail('资源存储记录损坏，原数据已保留，请先核查')
    if ((prior?.current.version || 0) !== expectedVersion) return fail('资源已变化，请重新载入；未覆盖已有版本')
    if (prior && prior.current.owner !== owner) return fail('不能修改其他作者的资源')
    const now = Date.now()
    const current: WritingResource = { ...input, id, version: expectedVersion + 1, materialVersion: (prior?.current.materialVersion || 0) + 1,
      owner, enabled: prior?.current.enabled ?? true, status: 'pending_review', review: null, evaluations: [], createdAt: prior?.current.createdAt || now, updatedAt: now }
    const record: WritingResourceRecord = { type: 'resource', id, current, history: prior ? [...prior.history, prior.current] : [] }
    return { value: record, result: current }
  })
  announce(); return result
}
async function changeResource(id: string, version: number, fn: (current: WritingResource) => WritingResource) {
  const result = await mutate(keyOf(id), value => {
    const record = recordOf(value)
    if (!record || record.current.owner !== owner) return fail('资源不存在')
    if (record.current.version !== version) return fail('资源已变化，请重新载入；未覆盖已有版本')
    const current = { ...fn(clone(record.current)), version: version + 1, updatedAt: Date.now() }
    return { value: { ...record, current, history: [...record.history, record.current] }, result: current }
  })
  announce(); return result
}
export const reviewWritingResource = (id: string, version: number, reviewer: string, notes: string) =>
  changeResource(id, version, current => ({ ...current, status: 'pending_validation',
    review: { reviewer: str(reviewer, '核对人', 100, true), notes: str(notes, '核对依据与结论', 4000, true), at: Date.now(), materialVersion: current.materialVersion } }))
export const evaluateWritingResource = (id: string, version: number, input: Omit<ResourceEvaluation, 'id' | 'materialVersion' | 'at'>) =>
  changeResource(id, version, current => {
    if (!['supports', 'mixed', 'unsupported'].includes(input.conclusion) || typeof input.hasFactIssues !== 'boolean') return fail('验证结论无效')
    if (!current.review) return fail('请先核对原文和解释，再记录效果验证')
    const evaluation: ResourceEvaluation = { id: crypto.randomUUID(), materialVersion: current.materialVersion, at: Date.now(),
      reviewer: str(input.reviewer, '评价人', 100, true), model: str(input.model, '测试模型与设置', 300, true),
      task: str(input.task, '测试任务与输入', 2000, true), scope: str(input.scope, '有效范围', 1000, true),
      conclusion: input.conclusion, hasFactIssues: input.hasFactIssues, notes: str(input.notes, '比较理由', 6000, true), outputRefs: list(input.outputRefs, '原始输出位置') }
    if (!evaluation.outputRefs.length) return fail('请保留原始输出位置，不能仅填写结论')
    return { ...current, evaluations: [...current.evaluations, evaluation], status: 'pending_validation' }
  })
export function canRecommendResource(current: WritingResource) {
  const evaluation = current.evaluations[current.evaluations.length - 1]
  return !!current.review && current.review.materialVersion === current.materialVersion && !!evaluation &&
    evaluation.materialVersion === current.materialVersion && evaluation.conclusion === 'supports' && !evaluation.hasFactIssues
}
export const setWritingResourceStatus = (id: string, version: number, status: WritingResourceStatus) =>
  changeResource(id, version, current => {
    if (!statuses.has(status)) return fail('资源状态无效')
    if (status === 'recommended' && !canRecommendResource(current)) return fail('需先人工核对，并记录支持该用法且无未处理事实问题的效果验证')
    return { ...current, status }
  })
export const setWritingResourceEnabled = (id: string, version: number, enabled: boolean) =>
  changeResource(id, version, current => ({ ...current, enabled }))

export async function importWritingResources(raw: unknown, targetBookId = '') {
  const packet = raw as { format?: string; resources?: unknown[] }
  if (packet?.format !== 'yichuang-writing-resources-v1' || !Array.isArray(packet.resources) || packet.resources.length > 200) return fail('资源包格式无效或超过 200 条')
  // 全部先校验；导入包不具有作者身份或推荐权，作品私有条目须由导入者选择本机目标作品。
  const inputs = packet.resources.map(item => {
    const rawItem = item as WritingResourceInput & { id?: string }
    const input = normalizeResourceInput({ ...rawItem, bookId: rawItem.scope === 'book' ? targetBookId : '' })
    return { input, id: rawItem.id && /^[a-zA-Z0-9._:-]{1,120}$/.test(rawItem.id) ? rawItem.id : crypto.randomUUID() }
  })
  let imported = 0, skipped = 0
  for (const item of inputs) {
    if (await getWritingResourceRecord(item.id)) { skipped++; continue }
    await saveWritingResource(item.input, item.id); imported++
  }
  return { imported, skipped }
}
export const exportWritingResources = async () => ({ format: 'yichuang-writing-resources-v1', resources: await listWritingResources() })

function accessible(resource: WritingResource, bookId: string) {
  return resource.owner === owner && resource.enabled && resource.status !== 'not_recommended' && (resource.scope !== 'book' || (!!bookId && resource.bookId === bookId)) &&
    (resource.scope !== 'public' || (resource.status === 'recommended' && canRecommendResource(resource)))
}
const tokens = (text: string) => {
  const clean = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const words = clean.split(/\s+/).filter(Boolean)
  const grams = words.flatMap(word => /[\p{Script=Han}]/u.test(word) ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word])
  return [...new Set(grams)]
}
function resourceScore(resource: WritingResource, query: string) {
  const terms = tokens(query)
  const main = [resource.title, resource.problem, ...resource.tags, ...resource.aliases].join(' ').toLocaleLowerCase()
  const detail = [...resource.conditions, resource.explanation].join(' ').toLocaleLowerCase()
  return terms.reduce((score, term) => score + (main.includes(term) ? 4 : detail.includes(term) ? 1 : 0), 0)
}
const summary = (resource: WritingResource) => ({ id: resource.id, version: resource.version, title: resource.title, kind: resource.kind,
  problem: resource.problem, conditions: resource.conditions, exclusions: resource.exclusions, source: resource.source,
  scope: resource.scope, validation: resource.scope === 'public' ? resource.evaluations[resource.evaluations.length - 1]?.scope || '' : '作者私有材料，未必经过公共效果验证' })
async function logUsage(request: PiToolRequest, data: Omit<ResourceUsage, 'type' | 'id' | 'sessionId' | 'bookId' | 'turnId' | 'callId' | 'at'>, signal?: AbortSignal) {
  const sessionId = String(request.args.sessionId || '')
  const turnId = String(request.args.turnId || '')
  if (!sessionId) return fail('缺少会话身份，无法记录资源使用')
  const id = `usage:${sessionId}:${turnId}:${request.callId}`
  const usage: ResourceUsage = { ...data, type: 'usage', id, sessionId, bookId: request.book?.id || '', turnId, callId: request.callId, at: performance.timeOrigin + performance.now() }
  signal?.throwIfAborted()
  await store('readwrite', s => s.put(usage, id))
  return usage
}
export async function listResourceUsage(sessionId: string) {
  if (!sessionId) return []
  const keys = await store<IDBValidKey[]>('readonly', s => s.getAllKeys(`usage:${sessionId}:`))
  const rows = await Promise.all(keys.map(key => store<ResourceUsage>('readonly', s => s.get(key))))
  return rows.filter(row => row.type === 'usage' && row.sessionId === sessionId).sort((a, b) => a.at - b.at)
}
export async function resourceEvidenceFor(request: PiToolRequest): Promise<ResourceUse[]> {
  const turn = String(request.args.turnId || '')
  if (!turn) return []
  const rows = (await listResourceUsage(String(request.args.sessionId || ''))).filter(row => row.turnId === turn && (row.bookId === (request.book?.id || '') || !row.bookId) && row.read)
  return rows.map(row => row.read!)
}
export async function searchWritingResources(request: PiToolRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const query = str(request.args.query, '检索问题', 1000, true)
  const context = str(request.args.context ?? '', '场景条件', 2000)
  const constraints = str(request.args.constraints ?? '', '不能改变的要求', 2000)
  const selectedKinds = request.args.kinds === undefined ? [] : list(request.args.kinds, '资源类别')
  if (selectedKinds.some(kind => !kinds.has(kind))) return fail('资源类别无效')
  const limit = Math.max(1, Math.min(5, Number(request.args.limit) || 5))
  const resources = (await listWritingResources()).filter(resource => accessible(resource, request.book?.id || '') && (!selectedKinds.length || selectedKinds.includes(resource.kind)))
    .map(resource => ({ resource, score: resourceScore(resource, `${query} ${context}`) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.resource.id.localeCompare(b.resource.id)).slice(0, limit).map(item => summary(item.resource))
  await logUsage(request, { kind: 'search', query, context, constraints, candidates: resources.map(({ id, version, title }) => ({ id, version, title })), read: null }, signal)
  return { resources, message: resources.length ? '请核对适用与不适用条件，选择零至两条读取；用户 Skill 已覆盖或无合适材料时可以不选。' : '没有匹配的可用资源；可以按已有要求和 Skill 继续，不必强行取用。' }
}
export async function readWritingResource(request: PiToolRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const id = str(request.args.id, '资源编号', 120, true)
  const record = await getWritingResourceRecord(id)
  const resource = record?.current
  if (!resource || !accessible(resource, request.book?.id || '')) return fail('资源不可用、已停用或不在当前可访问范围')
  if (!Number.isInteger(request.args.version) || Number(request.args.version) !== resource.version) return fail(`资源版本已变化，请重新查询；当前版本为 ${resource.version}，未返回替代内容`)
  const reason = str(request.args.reason ?? '', '选择理由', 1000)
  const paragraphs = resource.content.split(/\r?\n/)
  const from = Number(request.args.paragraphFrom ?? 1)
  const count = Number(request.args.paragraphCount ?? 12)
  if (!Number.isInteger(from) || from < 1 || from > paragraphs.length || !Number.isInteger(count) || count < 1 || count > 40) return fail('段落范围无效，每次读取 1—40 段')
  const offset = Number(request.args.characterOffset ?? 0)
  if (!Number.isInteger(offset) || offset < 0 || offset > paragraphs[from - 1].length) return fail('段内偏移无效')
  const chunks: string[] = []
  let end = from, remaining = 16000, nextParagraph: number | null = null, nextCharacterOffset = 0
  for (let i = from - 1; i < paragraphs.length && i < from - 1 + count; i++) {
    const start = i === from - 1 ? offset : 0
    const text = paragraphs[i].slice(start)
    const taken = text.slice(0, remaining)
    chunks.push(taken); remaining -= taken.length + 1; end = i + 1
    if (taken.length < text.length) { nextParagraph = i + 1; nextCharacterOffset = start + taken.length; break }
    nextParagraph = i + 1 < paragraphs.length ? i + 2 : null
    if (remaining <= 0) break
  }
  const includeExplanation = request.args.includeExplanation !== false
  const read: ResourceUse = { id, version: resource.version, title: resource.title, reason, paragraphFrom: from, paragraphTo: end, includeExplanation, characterOffset: offset, nextCharacterOffset }
  await logUsage(request, { kind: 'read', query: '', context: '', constraints: '', candidates: [], read }, signal)
  return { ...summary(resource), context: resource.context, content: chunks.join('\n'), explanation: includeExplanation ? resource.explanation : '',
    paragraphFrom: from, paragraphTo: end, totalParagraphs: paragraphs.length, characterOffset: offset, nextParagraph, nextCharacterOffset,
    note: '这是参考资源，不是本书事实。若场景未读完整，请续读后再判断；不需要时可以不用，也不触发质量评分或重写。' }
}
