import { withRecordStore } from './desktop-records'
import type {
  AiRecordListItem,
  AiRecordPageQuery,
  AiRecordSummary,
} from '@/types/ai-record'
import type { ResPage } from '@/types'
import { createLocalEntityId, nowIso } from './local-library-utils'

/**
 * AI 调用账本（替代 /ai/record/*）：每次本地 BYOK 调用（文字/生图）都记一笔。
 *
 * - 由请求层（local-ai-client）在完成/失败时自动落账，业务层只负责标注场景；
 * - Token 数：供应商响应带 usage 就记真实值，流式/生图拿不到就按字数估算
 *   （中文 ≈ 1.7 字/token），消耗积分恒 0（开源版无计费，界面已改示 Token）；
 * - 只留最近 1000 条，超出自动清最旧的——账本是透明度工具，不是审计存档。
 */

export interface LocalAiRecordInput {
  recordType: 'text' | 'image'
  scene: string
  sceneLabel: string
  modelCode: string
  modelName: string
  /** 1=成功 0=失败（与服务端状态口径一致；本地没有"生成中"落账） */
  status: 0 | 1
  input: string
  output: string
  inputTokens: number
  outputTokens: number
  duration: number
  errorMsg?: string
}

interface LocalAiRecord extends LocalAiRecordInput {
  id: number
  createTime: string
}

const DB_NAME = 'ew-local-ai-records'
const STORE_NAME = 'records'
const MAX_RECORDS = 1000
const TEXT_KEEP_CHARS = 2000

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, 'id', mode, run)

/** 拿不到真实 usage 时的估算口径：中文 ≈ 1.7 字/token */
export const estimateTokens = (text: string) => Math.round(String(text || '').length / 1.7)

export const appendLocalAiRecord = async (input: LocalAiRecordInput) => {
  const record: LocalAiRecord = {
    ...input,
    input: String(input.input || '').slice(0, TEXT_KEEP_CHARS),
    output: String(input.output || '').slice(0, TEXT_KEEP_CHARS),
    id: createLocalEntityId(),
    createTime: nowIso(),
  }
  await withStore('readwrite', store => store.put(record))
  // 超量清最旧：负数 id 按时间递减，createTime 排序后砍尾
  const all = await withStore<LocalAiRecord[]>('readonly', store => store.getAll())
  if (all.length > MAX_RECORDS) {
    const doomed = all
      .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)))
      .slice(MAX_RECORDS)
    for (const item of doomed) {
      await withStore('readwrite', store => store.delete(item.id))
    }
  }
  return record
}

const matchQuery = (record: LocalAiRecord, query: Omit<AiRecordPageQuery, 'page' | 'size'>) => {
  if (query.recordType && record.recordType !== query.recordType) return false
  if (query.status !== '' && query.status !== undefined && String(record.status) !== String(query.status)) return false
  if (query.scene && record.scene !== query.scene) return false
  const keyword = String(query.keyWord || '').trim().toLowerCase()
  if (keyword) {
    const haystack = `${record.sceneLabel} ${record.modelName} ${record.modelCode} ${record.input} ${record.output}`.toLowerCase()
    if (!haystack.includes(keyword)) return false
  }
  const day = record.createTime.slice(0, 10)
  if (query.startTime && day < query.startTime) return false
  if (query.endTime && day > query.endTime) return false
  return true
}

const listMatched = async (query: Omit<AiRecordPageQuery, 'page' | 'size'>) => {
  const all = await withStore<LocalAiRecord[]>('readonly', store => store.getAll())
  return all
    .filter(record => matchQuery(record, query))
    .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)))
}

const toListItem = (record: LocalAiRecord): AiRecordListItem => ({
  id: record.id,
  recordType: record.recordType,
  scene: record.scene,
  sceneLabel: record.sceneLabel,
  modelName: record.modelName,
  modelCode: record.modelCode,
  status: record.status,
  inputPreview: record.input.slice(0, 80),
  outputPreview: record.output.slice(0, 80),
  inputTokens: record.inputTokens,
  outputTokens: record.outputTokens,
  totalCost: 0,
  duration: record.duration,
  errorMsg: record.errorMsg,
  bookId: null,
  chapterId: null,
  createTime: record.createTime.replace('T', ' ').slice(0, 19),
})

export const getLocalAiRecordPage = async (payload: AiRecordPageQuery) => {
  const matched = await listMatched(payload)
  const page = Math.max(1, Number(payload.page || 1))
  const size = Math.max(1, Number(payload.size || 10))
  const result: ResPage<AiRecordListItem> = {
    list: matched.slice((page - 1) * size, page * size).map(toListItem),
    pagination: { page, size, total: matched.length },
  }
  return { data: result }
}

export const getLocalAiRecordSummary = async (
  query: Omit<AiRecordPageQuery, 'page' | 'size'> = {}
) => {
  const matched = await listMatched(query)
  const summary: AiRecordSummary = {
    total: matched.length,
    successTotal: matched.filter(record => record.status === 1).length,
    failTotal: matched.filter(record => record.status === 0).length,
    runningTotal: 0,
    inputTokens: matched.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: matched.reduce((sum, record) => sum + record.outputTokens, 0),
    totalCost: 0,
  }
  return { data: summary }
}

/** 场景筛选目录：从账本里的真实场景聚合（替代服务端 agent 场景契约） */
export const getLocalAiRecordSceneOptions = async () => {
  const all = await withStore<LocalAiRecord[]>('readonly', store => store.getAll())
  const seen = new Map<string, string>()
  for (const record of all) {
    if (record.scene && !seen.has(record.scene)) {
      seen.set(record.scene, record.sceneLabel || record.scene)
    }
  }
  const items = [...seen.entries()]
    .map(([scene, label]) => ({ scene, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  return { data: items.length ? [{ title: '本地调用', items }] : [] }
}
