import { withRecordStore } from './desktop-records'
import type { JsonRecord } from '@/types/json'
import type {
  WorkflowArtifact,
  WorkflowRun,
  WorkflowRuntimeEffectiveScope,
  WorkflowRuntimeSettings,
  WorkflowStepTask,
  WorkflowTask,
} from '@/types/workflow'
import { isLiveLocalTask } from '@/utils/local-workflow-runtime'
import { createLocalEntityId, nowIso } from './local-library-utils'

/**
 * 工作流建书本地库：替代旧服务端 /writing/workflow/* 的 run 与任务存取。
 *
 * - run 采用"保存载荷透传"：saveWorkflowApi 的 payload（config/summary 全量）
 *   原样落库，getInfo 原样返回——前端 workflow-adapter 的双向映射不用改一行。
 * - 版本号语义保留（draftRevision 每次保存 +1）；本地单机无并发，不做冲突拒绝。
 * - 任务由引擎层在本进程后台执行：提交即返回 queued/running 任务，页面照常轮询；
 *   应用中途关闭会把任务留在 running——读取时做"孤儿修复"翻成 interrupted。
 */

export interface LocalWorkflowRun extends WorkflowRun {
  config: JsonRecord | null
  summary: JsonRecord | null
  /** 最近一次逐章生文任务（终态也保留，写作页入口校验用） */
  latestBookTaskId?: number | null
  /** 最近一次向导步骤任务（历史页展示"正在生成灵感/大纲/设定"用） */
  latestStepTaskId?: number | null
  /** 调整候选暂存（candidateId → 候选内容），应用/废弃后移除 */
  adjustCandidates?: Record<string, LocalAdjustCandidate> | null
}

export interface LocalAdjustCandidate {
  candidateId: number
  step: 'outline_adjust' | 'setting_adjust'
  /** 应用时要落为新产物的完整内容（大纲或设定） */
  content: JsonRecord
  createTime: string
}

const DB_NAME = 'ew-local-workflow'
const STORE_NAME = 'kv'

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

const runKey = (id: number | string) => `run:${id}`
const taskKey = (id: number | string) => `task:${id}`

const readValue = async <T>(key: string): Promise<T | null> => {
  const stored = await withStore<unknown>('readonly', store => store.get(key))
  return (stored ?? null) as T | null
}

const writeValue = async (key: string, value: unknown) => {
  await withStore('readwrite', store => store.put(JSON.parse(JSON.stringify(value)), key))
}

export const readLocalWorkflowRun = (id: number | string) => readValue<LocalWorkflowRun>(runKey(id))

export const writeLocalWorkflowRun = (run: LocalWorkflowRun) => writeValue(runKey(run.id), run)

export const listLocalWorkflowRuns = async (): Promise<LocalWorkflowRun[]> => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  const runs: LocalWorkflowRun[] = []
  for (const key of keys) {
    const text = String(key)
    if (!text.startsWith('run:')) continue
    const run = await readValue<LocalWorkflowRun>(text)
    if (run) runs.push(run)
  }
  return runs.sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')))
}

// ---------------------------------------------------------------------------
// run 生命周期（对齐 create/save/info/history/delete 接口形状）
// ---------------------------------------------------------------------------

type WorkflowSavePayload = JsonRecord

const applyPayloadToRun = (run: LocalWorkflowRun, payload: WorkflowSavePayload) => {
  run.title = String(payload.title || run.title || '未命名工作流')
  run.status = String(payload.status || run.status || 'draft')
  run.currentStep = String(payload.currentStep || run.currentStep || 'MODE_SELECT')
  run.modelCode = payload.modelCode ?? run.modelCode
  run.agentId = payload.agentId ?? run.agentId
  run.templateCode = payload.templateCode ?? run.templateCode
  run.templateName = payload.templateName ?? run.templateName
  if (payload.config !== undefined) run.config = payload.config
  if (payload.summary !== undefined) run.summary = payload.summary
  if (payload.bookId !== undefined) run.bookId = payload.bookId
  run.updateTime = nowIso()
}

export const createLocalWorkflow = async (payload?: WorkflowSavePayload) => {
  const run: LocalWorkflowRun = {
    id: createLocalEntityId(),
    title: '未命名工作流',
    status: 'draft',
    currentStep: 'MODE_SELECT',
    draftRevision: 1,
    outlineRevision: 0,
    bookId: null,
    activeTaskId: null,
    config: null,
    summary: null,
    createTime: nowIso(),
    updateTime: nowIso(),
  }
  applyPayloadToRun(run, payload || {})
  await writeLocalWorkflowRun(run)
  return { data: run }
}

export const saveLocalWorkflow = async (payload: WorkflowSavePayload) => {
  const run = await readLocalWorkflowRun(payload.id)
  if (!run) throw new Error('工作流不存在')
  applyPayloadToRun(run, payload)
  // 本地单机无并发冲突，保存即推进版本
  run.draftRevision = Number(run.draftRevision || 0) + 1
  await writeLocalWorkflowRun(run)
  return { data: run }
}

export const getLocalWorkflowInfo = async (id: number) => {
  const run = await readLocalWorkflowRun(id)
  if (!run) throw new Error('工作流不存在')
  // 写作页入口校验要看 run 上的活跃任务与最近逐章任务；随读随修孤儿状态
  const activeTask = run.activeTaskId ? await readRepairedLocalTask(Number(run.activeTaskId)) : null
  const latestBookTask = run.latestBookTaskId
    ? await readRepairedLocalTask(Number(run.latestBookTaskId))
    : null
  return { data: { ...run, activeTask, latestBookTask } }
}

export const STEP_TITLES: Record<string, string> = {
  MODE_SELECT: '创作方向与灵感',
  BASE_CONFIG: '写作参数',
  OUTLINE_GENERATE: '生成大纲',
  SETTING_GENERATE: '生成设定',
}

export const deleteLocalWorkflow = async (data: { id: number }) => {
  const run = await readLocalWorkflowRun(data.id)
  if (run?.activeTaskId && isLiveLocalTask(Number(run.activeTaskId))) {
    throw new Error('该工作流还有生成任务在运行，请先停止生成再删除')
  }
  // run 删除时顺带清掉它名下的任务记录，不留读不到的死数据
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  for (const key of keys) {
    const text = String(key)
    if (!text.startsWith('task:')) continue
    const task = await readValue<WorkflowTask>(text)
    if (task && Number(task.runId) === Number(data.id)) {
      await withStore('readwrite', store => store.delete(text))
    }
  }
  await withStore('readwrite', store => store.delete(runKey(data.id)))
  return { data: true }
}

// ---------------------------------------------------------------------------
// 任务存取与孤儿修复
// ---------------------------------------------------------------------------

export const writeLocalWorkflowTask = async (task: WorkflowStepTask | WorkflowTask) => {
  await writeValue(taskKey(task.id), task)
}

/**
 * 读取时修复旧整书任务的停驻能力标记；queued/running 没有活循环时，
 * 视为上次应用关闭中断，转为 interrupted 并保留断点。
 */
export const readRepairedLocalTask = async (taskId: number): Promise<WorkflowTask | null> => {
  const task = await readValue<WorkflowTask>(taskKey(taskId))
  if (!task) return null
  const status = String(task.status || '')
  if (isLiveLocalTask(taskId)) return task
  // 旧整书任务可能残留操作锁或能力标记；停驻状态本身决定是否可恢复。
  if (task.bizType === 'book_generate' && ['paused', 'interrupted', 'failed'].includes(status)) {
    if (
      task.canResume === true && task.canPause === false &&
      task.canCancel === true && task.requestedAction == null
    ) {
      return task
    }
    const repaired: WorkflowTask = {
      ...task,
      requestedAction: null,
      canPause: false,
      canResume: true,
      canCancel: true,
    }
    await writeValue(taskKey(taskId), repaired)
    return repaired
  }
  if (!['queued', 'running'].includes(status)) return task
  const repaired: WorkflowTask = {
    ...task,
    status: 'interrupted',
    requestedAction: null,
    interruptedReason: 'app_closed',
    errorMessage: '生成在应用关闭时中断，已生成内容已保留，可继续生成',
    canPause: false,
    canResume: true,
    canCancel: false,
  }
  await writeValue(taskKey(taskId), repaired)
  return repaired
}

export const getLocalWorkflowTaskStatus = async (taskId: number, _opts?: { signal?: AbortSignal }) => {
  const task = await readRepairedLocalTask(taskId)
  if (!task) throw new Error('生成任务不存在')
  return { data: task }
}

/** 进行中的向导步骤任务（灵感/大纲/设定/调整）；终态或没有则为 null */
export const getLocalActiveStepTask = async (runId: number) => {
  const run = await readLocalWorkflowRun(runId)
  if (!run?.latestStepTaskId) return { data: null as WorkflowStepTask | null }
  const task = await readRepairedLocalTask(Number(run.latestStepTaskId))
  if (!task || !['queued', 'running'].includes(String(task.status || ''))) {
    return { data: null as WorkflowStepTask | null }
  }
  return { data: task as WorkflowStepTask }
}

// ---------------------------------------------------------------------------
// 运行时创作设定（写作台"创作设定/写作规则"面板保存）
// ---------------------------------------------------------------------------

export const updateLocalWorkflowRuntimeConfig = async (data: {
  runId: number
  modelCode?: string
  config?: Partial<WorkflowRuntimeSettings>
  effectiveScope: WorkflowRuntimeEffectiveScope
}) => {
  const run = await readLocalWorkflowRun(data.runId)
  if (!run) throw new Error('工作流不存在')
  if (data.modelCode !== undefined) run.modelCode = data.modelCode
  // 运行时设定合并进 config；本地引擎每章开写前重读，所以两种生效范围都是"下一章起"
  run.config = { ...(run.config || {}), ...(data.config || {}) }
  run.draftRevision = Number(run.draftRevision || 0) + 1
  run.updateTime = nowIso()
  await writeLocalWorkflowRun(run)
  return {
    data: {
      run,
      revision: run.draftRevision,
      effectiveScope: data.effectiveScope,
    },
  }
}

// ---------------------------------------------------------------------------
// 调整候选（大纲/设定"按要求调整"）：引擎生成候选暂存在 run 上，这里管应用与废弃
// ---------------------------------------------------------------------------

/** 把候选内容落为该步骤的当前产物并推进版本（引擎生成产物用的同一套账） */
export const applyArtifactToLocalRun = (
  run: LocalWorkflowRun,
  stepType: string,
  content: JsonRecord
): WorkflowArtifact => {
  run.draftRevision = Number(run.draftRevision || 0) + 1
  if (stepType === 'outline') run.outlineRevision = Number(run.outlineRevision || 0) + 1
  const artifact: WorkflowArtifact = {
    id: createLocalEntityId(),
    runId: Number(run.id),
    stepCode: stepType,
    artifactType: stepType,
    version: run.draftRevision,
    content,
    createTime: nowIso(),
    updateTime: nowIso(),
  }
  run.artifacts = [
    ...(run.artifacts || []).filter(item => item.artifactType !== stepType),
    artifact,
  ]
  run.updateTime = nowIso()
  return artifact
}

const consumeAdjustCandidate = async (
  runId: number,
  candidateId: number,
  step: LocalAdjustCandidate['step']
) => {
  const run = await readLocalWorkflowRun(runId)
  if (!run) throw new Error('工作流不存在')
  const key = String(candidateId)
  const candidate = run.adjustCandidates?.[key]
  if (!candidate || candidate.step !== step) throw new Error('调整候选不存在或已处理')
  const rest = { ...(run.adjustCandidates || {}) }
  delete rest[key]
  run.adjustCandidates = rest
  return { run, candidate }
}

export const applyLocalWorkflowOutlineAdjust = async (data: {
  runId: number
  candidateId: number
  expectedDraftRevision?: number
}) => {
  const { run, candidate } = await consumeAdjustCandidate(data.runId, data.candidateId, 'outline_adjust')
  const artifact = applyArtifactToLocalRun(run, 'outline', candidate.content)
  await writeLocalWorkflowRun(run)
  return {
    data: {
      artifact,
      content: candidate.content,
      draftRevision: run.draftRevision,
      outlineRevision: run.outlineRevision,
    },
  }
}

export const discardLocalWorkflowOutlineAdjust = async (data: {
  runId: number
  candidateId: number
}) => {
  const { run } = await consumeAdjustCandidate(data.runId, data.candidateId, 'outline_adjust')
  await writeLocalWorkflowRun(run)
  return { data: { discarded: true } }
}

export const applyLocalWorkflowSettingAdjust = async (data: {
  runId: number
  candidateId: number
  expectedDraftRevision?: number
}) => {
  const { run, candidate } = await consumeAdjustCandidate(data.runId, data.candidateId, 'setting_adjust')
  const artifact = applyArtifactToLocalRun(run, 'setting', candidate.content)
  await writeLocalWorkflowRun(run)
  return {
    data: {
      artifact,
      content: candidate.content,
      draftRevision: run.draftRevision,
      outlineRevision: run.outlineRevision,
    },
  }
}

export const discardLocalWorkflowSettingAdjust = async (data: {
  runId: number
  candidateId: number
}) => {
  const { run } = await consumeAdjustCandidate(data.runId, data.candidateId, 'setting_adjust')
  await writeLocalWorkflowRun(run)
  return { data: { discarded: true } }
}

// ---------------------------------------------------------------------------
// 内置资源（原服务端资产接口，现为本地静态配置）
// ---------------------------------------------------------------------------

export const getLocalWorkflowResources = async () => {
  const { LOCAL_WORKFLOW_RESOURCES } = await import('@/config/workflow-resources')
  return { data: LOCAL_WORKFLOW_RESOURCES }
}
