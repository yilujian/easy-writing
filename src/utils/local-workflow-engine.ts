import { generateWorkflowUnits } from '@/utils/workflow-generation'
import type { WorkflowGeneration } from '@/types/workflow-generation'
import type { JsonRecord } from '@/types/json'
import type { WorkflowStepTask } from '@/types/workflow'
import { useAiModelStore } from '@/stores/ai-model'
import { parseWorkflowJson, requestWorkflowAi, WorkflowAiError } from '@/utils/workflow-ai'
import { buildStructuredJsonMessages } from '@/config/ai-prompts'
import {
  buildOutlineAdjustMessages,
  buildSettingAdjustMessages,
} from '@/config/workflow-prompts'
import { NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { promptText } from '@/storage/local-prompts'
import { createLocalEntityId, nowIso } from '@/storage/local-library-utils'
import {
  applyArtifactToLocalRun,
  completeWorkflowAiDraft,
  updateWorkflowGeneration,
  readLocalWorkflowRun,
  writeLocalWorkflowRun,
  writeLocalWorkflowTask,
  type LocalAdjustCandidate,
  type LocalWorkflowRun,
} from '@/storage/local-workflow'
import {
  registerLiveLocalTask,
  findLiveLocalTaskForRun,
  unregisterLiveLocalTask,
} from '@/utils/local-workflow-runtime'

/**
 * 向导步骤引擎（灵感 / 大纲 / 设定 / 大纲调整 / 设定调整）。
 *
 * 批 P 是"提交即同步执行"；本批改成与服务端同构的后台执行：
 * 提交立刻返回 running 任务，生成在本进程后台跑，页面照常 2.5s 轮询拿终态，
 * "停止生成"按钮通过任务取消真正掐掉在途请求。应用中途关页面，
 * 任务读取时会被孤儿修复成 interrupted（本地引擎随页面存亡，如实呈现）。
 */

type LocalGenerateStep = 'inspiration' | 'outline' | 'setting'
type LocalAdjustStep = 'outline_adjust' | 'setting_adjust'

const asText = (value: unknown) => String(value ?? '').trim()

const resolveWorkflowModel = async (run: { modelCode?: string; config?: JsonRecord | null }) => {
  const aiModelStore = useAiModelStore()
  const explicit = String(run.modelCode || run.config?.modelCode || '').trim()
  if (explicit) return explicit
  return await aiModelStore.ensureWorkflowModel()
}

const describeBaseConfig = (config: JsonRecord | null | undefined) => {
  const base = config || {}
  const lines = [
    ['平台', base.platform],
    ['题材', base.genre],
    ['分类', base.platformCategory],
    ['标签', Array.isArray(base.tags) ? base.tags.join('、') : ''],
    ['书名意向', base.title],
    ['目标字数', base.targetWords],
    ['单章字数', base.chapterTargetWords],
    ['主角', base.protagonist],
    ['叙事人称', base.storyPerspective],
    ['目标读者', base.audience],
    ['核心卖点', base.sellingPoint],
  ]
  return lines
    .filter(([, value]) => String(value ?? '').trim())
    .map(([label, value]) => `${label}：${value}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 三个生成步骤（灵感 / 大纲 / 设定）
// ---------------------------------------------------------------------------

const generateStepContent = async (
  step: LocalGenerateStep,
  run: { id: number; modelCode?: string; config?: JsonRecord | null; summary?: JsonRecord | null },
  input: JsonRecord,
  signal: AbortSignal,
  taskId: number,
  onGeneration: (value: WorkflowGeneration) => Promise<void>
): Promise<JsonRecord> => {
  const modelCode = await resolveWorkflowModel(run)
  if (!modelCode) throw new Error(NO_MODEL_MESSAGE)
  const baseInfo = describeBaseConfig(run.config)

  if (step === 'inspiration') {
    const directions = Array.isArray(input.directions) ? input.directions.filter(Boolean) : []
    const ideaText = String(input.ideaText || '').trim()
    const action = String(input.action || 'random')
    const task = action === 'expand' && ideaText
      ? promptText('workflow-wizard', 'inspirationExpand')
      : promptText('workflow-wizard', 'inspirationRandom')
    const data = await requestWorkflowAi({
      runId: Number(run.id),
      taskId,
      key: `step:${step}`,
      scene: 'workflow_inspiration',
      sceneLabel: '建书·灵感',
      requiredKeys: ['ideaText'],
      modelCode,
      signal,
      messages: buildStructuredJsonMessages({
        task: `${task}${promptText('workflow-wizard', 'inspirationBody')}`,
        materials: {
          '创作方向': directions.join('、'),
          '作者的想法': ideaText,
          '写作参数': baseInfo,
        },
        shape: promptText('workflow-wizard', 'ideaShape'),
      }),
    })
    let parsed: { ideaText?: unknown } | null = null
    try {
      parsed = parseWorkflowJson(data, ['ideaText'])
    } catch {
      throw new Error('灵感生成结果无法解析（多半是输出被截断），请重新生成或换个模型')
    }
    const text = String(parsed?.ideaText || '').trim() || String(data || '').trim()
    if (!text) throw new Error('灵感生成结果为空，请重试')
    return { ideaText: text }
  }

  if (step === 'outline') {
    const ideaText = String(run.summary?.ideaText || '').trim()
    const generation = await generateWorkflowUnits({
      step, run: run as LocalWorkflowRun, input, signal, taskId, modelCode, onProgress: onGeneration,
      messages: buildStructuredJsonMessages({
        task: promptText('workflow-wizard', 'outlineTask'),
        materials: {
          '写作参数': baseInfo,
          '故事灵感': ideaText,
        },
        shape: promptText('workflow-wizard', 'outlineShape'),
      }),
    })
    return generation.document
  }

  // setting：以大纲为底稿生成世界观与人物设定
  const outline = run.summary?.workflowOutlineUi || run.summary?.workflowOutline || {}
  const outlineBrief = [
    outline.intro ? `简介：${outline.intro}` : '',
    outline.storyHook ? `核心钩子：${outline.storyHook}` : '',
    Array.isArray(outline.worldItems) && outline.worldItems.length ? `世界观要点：${outline.worldItems.join('；')}` : '',
    Array.isArray(outline.volumes)
      ? outline.volumes.map((volume: JsonRecord) => `卷「${volume?.title || ''}」：${volume?.summary || ''}`).join('\n')
      : '',
  ].filter(Boolean).join('\n')
  const generation = await generateWorkflowUnits({
    step, run: run as LocalWorkflowRun, input, signal, taskId, modelCode, onProgress: onGeneration,
    messages: buildStructuredJsonMessages({
      task: promptText('workflow-wizard', 'settingTask'),
      materials: {
        '写作参数': baseInfo,
        '作品大纲': outlineBrief,
      },
      shape: promptText('workflow-wizard', 'settingShape'),
    }),
  })
  return generation.document
}

// ---------------------------------------------------------------------------
// 两个调整步骤（先出候选，应用/废弃走 local-workflow 的候选账）
// ---------------------------------------------------------------------------

const OUTLINE_SCOPE_LABELS: Record<string, string> = {
  all: '整份大纲',
  title: '书名',
  storyHook: '核心钩子',
  world: '世界观要点',
  volumes: '分卷规划',
}

const OUTLINE_PRESERVE_LABELS: Record<string, string> = {
  title: '书名',
  storyHook: '核心钩子',
  worldItems: '世界观要点',
  volumeCount: '卷数',
}

const SETTING_SCOPE_LABELS: Record<string, string> = {
  all: '整套设定',
  worldCards: '世界背景卡',
  core: '核心体系',
  characters: '角色',
  storylines: '故事线',
  character: '指定角色',
  storyline: '指定故事线',
}

const SETTING_PRESERVE_LABELS: Record<string, string> = {
  characterCount: '角色数量',
  protagonist: '主角',
  cultivationRealms: '力量境界',
  worldRules: '世界规则',
}

const selectedTitleOf = (outline: JsonRecord) => {
  const options = Array.isArray(outline.titleOptions) ? outline.titleOptions : []
  const selected = options.find((item: JsonRecord) => String(item?.id) === String(outline.selectedTitleId))
  return asText(selected?.name || options[0]?.name)
}

const diffOutlineChanges = (before: JsonRecord, after: JsonRecord) => {
  const changes: Array<{ key: string; label: string; before: string; after: string }> = []
  const push = (key: string, label: string, prev: string, next: string) => {
    if (prev !== next) changes.push({ key, label, before: prev, after: next })
  }
  push('title', '书名', selectedTitleOf(before), selectedTitleOf(after))
  push('intro', '简介', asText(before.intro), asText(after.intro))
  push('storyHook', '核心钩子', asText(before.storyHook), asText(after.storyHook))
  push(
    'worldItems',
    '世界观要点',
    (Array.isArray(before.worldItems) ? before.worldItems : []).map(asText).join('；'),
    (Array.isArray(after.worldItems) ? after.worldItems : []).map(asText).join('；')
  )
  const beforeVolumes: JsonRecord[] = Array.isArray(before.volumes) ? before.volumes : []
  const afterVolumes: JsonRecord[] = Array.isArray(after.volumes) ? after.volumes : []
  const volumeContent = (volume?: JsonRecord) => volume
    ? [asText(volume.title), asText(volume.summary)].filter(Boolean).join('\n\n')
    : ''
  for (let index = 0; index < Math.max(beforeVolumes.length, afterVolumes.length); index += 1) {
    push(`volumes:${index}`, `第${index + 1}卷 · 卷名与卷纲`,
      volumeContent(beforeVolumes[index]), volumeContent(afterVolumes[index]))
  }
  return changes
}

const diffSettingChanges = (before: JsonRecord, after: JsonRecord) => {
  const changes: Array<{ key: string; label: string; before: string; after: string }> = []
  const push = (key: string, label: string, prev: string, next: string) => {
    if (prev !== next) changes.push({ key, label, before: prev, after: next })
  }
  const names = (setting: JsonRecord, field: string, nameField: string) =>
    (Array.isArray(setting[field]) ? setting[field] : [])
      .map((item: JsonRecord) => asText(item?.[nameField]))
      .filter(Boolean)
      .join('、')
  push('worldCards', '世界背景卡', names(before, 'worldCards', 'title'), names(after, 'worldCards', 'title'))
  push('characters', '角色', names(before, 'characters', 'name'), names(after, 'characters', 'name'))
  push('storylines', '故事线', names(before, 'storylines', 'title'), names(after, 'storylines', 'title'))
  push(
    'core',
    '力量体系',
    asText(before.core?.cultivation?.intro),
    asText(after.core?.cultivation?.intro)
  )
  return changes
}

const runAdjustStep = async (
  step: LocalAdjustStep,
  run: LocalWorkflowRun,
  input: JsonRecord,
  signal: AbortSignal,
  reportStage: (stage: 'read' | 'preserve' | 'generate' | 'verify', percent: number) => Promise<void>,
  taskId: number,
  onGeneration: (value: WorkflowGeneration) => Promise<void>
) => {
  const request = (input.request || {}) as JsonRecord
  const scope = asText(request.scope) || 'all'
  const instruction = asText(request.instruction)
  const preserve = Array.isArray(request.preserve) ? request.preserve.map(asText) : []
  const modelCode = await resolveWorkflowModel(run)
  if (!modelCode) throw new Error(NO_MODEL_MESSAGE)

  await reportStage('read', 10)
  const summary = run.summary || {}
  const isOutline = step === 'outline_adjust'
  const current = (isOutline
    ? summary.workflowOutlineUi || summary.workflowOutline
    : summary.workflowSettingUi || summary.workflowSetting) as JsonRecord | undefined
  if (!current || !Object.keys(current).length) {
    throw new Error(isOutline ? '当前还没有大纲内容，先生成大纲再调整' : '当前还没有设定内容，先生成设定再调整')
  }

  await reportStage('generate', 35)
  const scopeLabels = isOutline ? OUTLINE_SCOPE_LABELS : SETTING_SCOPE_LABELS
  const preserveLabels = isOutline ? OUTLINE_PRESERVE_LABELS : SETTING_PRESERVE_LABELS
  const targetId = asText(request.targetId)
  const scopeLabel = `${scopeLabels[scope] || scope}${targetId ? `（条目 ${targetId}）` : ''}`
  const materials: Record<string, string> = {
    '写作参数': describeBaseConfig(run.config),
    [isOutline ? '当前大纲' : '当前设定']: JSON.stringify(current),
  }
  const builder = isOutline ? buildOutlineAdjustMessages : buildSettingAdjustMessages
  const generation = await generateWorkflowUnits({
    step, run, input, signal, taskId, modelCode, onProgress: onGeneration,
    messages: builder({ materials, scopeLabel, instruction,
      preserveLabels: preserve.map(key => preserveLabels[key] || key).filter(Boolean) }),
  })
  await reportStage('verify', 85)
  const parsed = generation.document
  const changes = isOutline
    ? diffOutlineChanges(generation.base, parsed)
    : diffSettingChanges(generation.base, parsed)

  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
  const fresh = await readLocalWorkflowRun(Number(run.id))
  if (!fresh || fresh.draftRevision !== run.draftRevision) throw new Error('工作流内容已变化，本次草稿已保留，请按最新内容重试')
  const candidateId = Object.values(run.adjustCandidates || {}).find(candidate => candidate.generationId === generation.id)?.candidateId || createLocalEntityId()
  const candidate: LocalAdjustCandidate = {
    candidateId,
    generationId: generation.id,
    step,
    content: parsed,
    createTime: nowIso(),
  }
  run.adjustCandidates = { ...(run.adjustCandidates || {}), [String(candidateId)]: candidate }
  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
  await writeLocalWorkflowRun(run)

  const consistency = isOutline
    ? { passed: true, message: '本地规则检查通过' }
    : { passed: true, message: '本地规则检查通过', warnings: [] as string[] }
  return {
    candidateId,
    version: Number(run.draftRevision || 0) + 1,
    request,
    tags: [scopeLabel],
    changes,
    consistency,
    manualEditCount: 0,
    ...(isOutline ? { outline: parsed } : { setting: parsed }),
    content: parsed,
    draftRevision: Number(run.draftRevision || 0),
    outlineRevision: Number(run.outlineRevision || 0),
  }
}

// ---------------------------------------------------------------------------
// 提交入口：立即返回 running 任务，后台执行，页面轮询拿终态
// ---------------------------------------------------------------------------

const submitStepTask = async (payload: {
  runId: number
  step: string
  expectedDraftRevision?: number
  expectedOutlineRevision?: number
  input?: JsonRecord
}) => {
  const run = await readLocalWorkflowRun(payload.runId)
  if (!run) throw new Error('工作流不存在')
  const step = payload.step as LocalGenerateStep | LocalAdjustStep
  if (!['inspiration', 'outline', 'setting', 'outline_adjust', 'setting_adjust'].includes(step)) {
    throw new Error(`未知的生成步骤：${payload.step}`)
  }

  if (payload.expectedDraftRevision != null && payload.expectedDraftRevision !== run.draftRevision) throw new Error('工作流内容已变化，请刷新后重试')
  const taskId = createLocalEntityId()
  const input = payload.input || {}
  const running = {
    id: taskId,
    runId: Number(run.id),
    bizType: 'step_generate',
    status: 'running',
    progress: 0,
    canCancel: true,
    createTime: nowIso(),
    updateTime: nowIso(),
    payload: { step, input },
  } as unknown as WorkflowStepTask
  await writeLocalWorkflowTask(running)
  run.latestStepTaskId = taskId
  await writeLocalWorkflowRun(run)

  const abort = new AbortController()
  let cancelRequested = false
  registerLiveLocalTask({
    taskId,
    runId: Number(run.id),
    kind: 'step',
    requestCancel: () => {
      cancelRequested = true
      abort.abort()
    },
  })

  const onGeneration = async (value: WorkflowGeneration) => {
    input.generationId = value.id
    running.payload = { ...running.payload, step, input, generationId: value.id,
      unitProgress: { completed: value.units.filter(unit => unit.status === 'complete').length,
        total: value.units.length, current: value.units.find(unit => unit.id === value.failedUnit)?.label || '准备中' } }
    await writeLocalWorkflowTask(running)
  }
  void (async () => {
    try {
      let result: JsonRecord
      if (step === 'outline_adjust' || step === 'setting_adjust') {
        const reportStage = async (stage: 'read' | 'preserve' | 'generate' | 'verify', percent: number) => {
          const snapshot = {
            ...running,
            updateTime: nowIso(),
            payload: { ...running.payload, step, input, adjustProgress: { stage, percent } },
          } as unknown as WorkflowStepTask
          await writeLocalWorkflowTask(snapshot)
        }
        result = await runAdjustStep(step, run, input, abort.signal, reportStage, taskId, onGeneration)
      } else {
        const content = await generateStepContent(step, run, input, abort.signal, taskId, onGeneration)
        // 产物落 run：artifact 记录 + 版本推进（大纲产物推进 outlineRevision）
        if (abort.signal.aborted) throw new DOMException('已取消', 'AbortError')
        const fresh = await readLocalWorkflowRun(payload.runId)
        if (!fresh || fresh.draftRevision !== run.draftRevision) throw new Error('工作流内容已变化，本次草稿已保留，请按最新内容重试')
        if (abort.signal.aborted) throw new DOMException('已取消', 'AbortError')
        const artifact = applyArtifactToLocalRun(fresh, step, content)
        await writeLocalWorkflowRun(fresh)
        result = {
          artifact,
          content,
          draftRevision: fresh.draftRevision,
          outlineRevision: fresh.outlineRevision,
        }
      }
      const done = {
        ...running,
        status: 'succeeded',
        progress: 100,
        canCancel: false,
        updateTime: nowIso(),
        payload: { ...running.payload, step, input, result },
      } as unknown as WorkflowStepTask
      await writeLocalWorkflowTask(done)
      await completeWorkflowAiDraft(Number(run.id), `step:${step}`)
      if (input.generationId) await updateWorkflowGeneration(Number(input.generationId), g => { g.status = step.endsWith('_adjust') ? 'candidate' : 'applied' }).catch(error => console.warn('生成状态归档失败，结果仍已保存', error))
    } catch (error) {
      const aborted =
        cancelRequested ||
        (error instanceof DOMException && error.name === 'AbortError')
      const settled = {
        ...running,
        status: aborted ? 'canceled' : 'failed',
        canCancel: false,
        updateTime: nowIso(),
        ...(aborted
          ? {}
          : { errorMessage: error instanceof Error ? error.message : '生成失败，请重试', errorCode: error instanceof WorkflowAiError ? error.code : 'UNKNOWN' }),
        payload: { ...running.payload, step, input },
      } as unknown as WorkflowStepTask
      await writeLocalWorkflowTask(settled).catch(() => undefined)
    } finally {
      unregisterLiveLocalTask(taskId)
    }
  })()

  return { data: running }
}

// 提交与登记活任务之间也互斥，防止连续点击产生两个收费请求。
const pendingSubmissions = new Set<number>()
export const submitLocalWorkflowStepTask = async (payload: Parameters<typeof submitStepTask>[0]) => {
  if (pendingSubmissions.has(payload.runId) || findLiveLocalTaskForRun(payload.runId)) {
    throw new WorkflowAiError('TASK_RUNNING', '这个工作流仍在生成，请等待或先停止生成')
  }
  pendingSubmissions.add(payload.runId)
  try { return await submitStepTask(payload) } finally { pendingSubmissions.delete(payload.runId) }
}
