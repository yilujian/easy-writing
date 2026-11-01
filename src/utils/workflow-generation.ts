import { getLiveLocalTask } from './local-workflow-runtime'
import type { JsonRecord } from '@/types/json'
import type {
  GenerationEdit,
  GenerationPath,
  GenerationStep,
  GenerationUnit,
  WorkflowGeneration
} from '@/types/workflow-generation'
import type { LocalChatMessageInput } from './local-ai-client'
import { createLocalEntityId } from '@/storage/local-library-utils'
import {
  completeWorkflowAiDraft,
  listWorkflowGenerations,
  readWorkflowGeneration,
  updateWorkflowGeneration,
  writeWorkflowGeneration,
  type LocalWorkflowRun
} from '@/storage/local-workflow'
import { parseWorkflowJson, readWorkflowAiDrafts, requestWorkflowAi, WorkflowAiError } from './workflow-ai'
import { applyGenerationEdits, diffGenerationEdits, readGenerationPath } from './workflow-generation-document'
import { promptText } from '@/storage/local-prompts'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const isOutline = (step: GenerationStep) => step.startsWith('outline')
const isAdjust = (step: GenerationStep) => step.endsWith('_adjust')
const reject = (message: string): never => {
  throw new WorkflowAiError('INVALID_RESPONSE', message)
}

/**
 * 每一步要生成哪几块由平台定死，不再让模型先出一份"任务清单"。
 * 之前那一步经常失败：模型要么把整份大纲直接写出来，要么清单缺字段、类型名对不上。
 * 现在大纲分三块（总纲、分卷、开篇章纲），设定分四块（世界背景、核心体系、人物、故事线），
 * 逐块生成、逐块落盘，哪块失败就从哪块继续。
 */
interface UnitSpec {
  kind: string
  label: string
  brief: string
  path: GenerationPath
  /** 数组条目的编号前缀；没有前缀的是对象或字符串 */
  idPrefix?: string
  /** 数组里每个条目必须有的字段 */
  required: string[]
  /** 调整时"保留数量"对应的标记 */
  countFlag?: string
}
const overviewKeys = ['titleOptions', 'selectedTitleId', 'intro', 'storyHook', 'worldItems', 'infoItems']
const coreKinds = ['cultivation', 'ability', 'mechanics', 'resources']
const SPECS: Record<string, UnitSpec> = {
  overview: { kind: 'overview', label: '总纲', brief: '候选书名、作品简介、贯穿全书的核心钩子和世界观要点', path: [], required: [] },
  titles: { kind: 'titles', label: '书名', brief: '候选书名', path: ['titleOptions'], idPrefix: 't', required: ['name'] },
  hook: { kind: 'hook', label: '核心钩子', brief: '贯穿全书的核心钩子', path: ['storyHook'], required: [] },
  world: { kind: 'world', label: '世界观要点', brief: '世界观要点', path: ['worldItems'], required: [] },
  volumes: {
    kind: 'volumes', label: '分卷规划', brief: '全书分卷：每卷的主线概述、章数和阶段目标',
    path: ['volumes'], idPrefix: 'v', required: ['title', 'summary'], countFlag: 'volumeCount'
  },
  chapters: { kind: 'chapters', label: '开篇章纲', brief: '第一卷开头各章的章名与章纲', path: ['chapters'], idPrefix: 'c', required: ['title', 'summary'] },
  worldCards: { kind: 'worldCards', label: '世界背景卡', brief: '世界背景卡', path: ['worldCards'], idPrefix: 'w', required: ['title', 'content'] },
  core: { kind: 'core', label: '核心体系', brief: '力量体系、能力体系、世界机制、资源体系', path: ['core'], required: [] },
  characters: {
    kind: 'characters', label: '人物', brief: '主要角色的身份、背景与动机',
    path: ['characters'], idPrefix: 'p', required: ['name', 'background'], countFlag: 'characterCount'
  },
  storylines: {
    kind: 'storylines', label: '故事线', brief: '主线与支线及其关键事件',
    path: ['storylines'], idPrefix: 's', required: ['title', 'desc'], countFlag: 'storylineCount'
  }
}
const scopeUnits = (step: GenerationStep, input: JsonRecord): string[] => {
  const scope = isAdjust(step) ? String(input.request?.scope || 'all') : 'all'
  if (isOutline(step))
    return (
      ({ title: ['titles'], storyHook: ['hook'], world: ['world'], volumes: ['volumes'], all: ['overview', 'volumes', 'chapters'] } as Record<string, string[]>)[scope] || []
    )
  return (
    (
      {
        worldCards: ['worldCards'], core: ['core'], characters: ['characters'], character: ['character'],
        storylines: ['storylines'], storyline: ['storyline'], all: ['worldCards', 'core', 'characters', 'storylines']
      } as Record<string, string[]>
    )[scope] || []
  )
}
/** 单个人物或故事线的调整：只生成作者点的那一条。 */
const singleSpec = (kind: string, g: WorkflowGeneration): UnitSpec => {
  const parent = SPECS[kind === 'character' ? 'characters' : 'storylines']
  const targetId = text(g.input.request?.targetId)
  if (!targetId) reject('没有指定要调整的条目')
  const current = readGenerationPath(g.base, [...parent.path, { id: targetId }]) as JsonRecord | undefined
  const name = text(current?.name) || text(current?.title)
  return { ...parent, kind, label: `${parent.label}·${name || targetId}`, path: [...parent.path, { id: targetId }], countFlag: undefined }
}
const specOf = (unit: GenerationUnit, g: WorkflowGeneration): UnitSpec =>
  unit.kind === 'character' || unit.kind === 'storyline' ? singleSpec(unit.kind, g) : SPECS[unit.kind]
export const unitsFor = (g: WorkflowGeneration): GenerationUnit[] => {
  const kinds = scopeUnits(g.step, g.input)
  if (!kinds.length) reject('没有可生成的范围，请重新选择调整范围')
  return kinds.map(kind => {
    const spec = kind === 'character' || kind === 'storyline' ? singleSpec(kind, g) : SPECS[kind]
    const id = kind === 'character' || kind === 'storyline' ? `${kind}:${text(g.input.request?.targetId)}` : kind
    return { id, kind, label: spec.label, brief: spec.brief, path: spec.path, status: 'pending' }
  })
}

const protectedEdits = (g: WorkflowGeneration): GenerationEdit[] => {
  if (!isAdjust(g.step)) return []
  const edits: GenerationEdit[] = []
  const add = (path: GenerationEdit['path']) => {
    const value = readGenerationPath(g.base, path)
    if (value !== undefined) edits.push({ path, op: 'set', value })
  }
  for (const key of g.input.request?.preserve || []) {
    if (key === 'title') {
      add(['titleOptions'])
      add(['selectedTitleId'])
    }
    if (key === 'storyHook') add(['storyHook'])
    if (key === 'worldItems') add(['worldItems'])
    if (key === 'worldRules') {
      add(['worldCards'])
      add(['core', 'mechanics'])
    }
    if (key === 'cultivationRealms') add(['core', 'cultivation', 'realms'])
    if (key === 'protagonist' && g.base.characters?.[0]?.id)
      add(['characters', { id: g.base.characters[0].id }])
  }
  if (g.input.request?.allowVolumeTitleChange === false)
    for (const volume of g.base.volumes || []) add(['volumes', { id: volume.id }, 'title'])
  return edits
}
/** 作者要求整块保留的，不再花钱生成。 */
const fullyProtected = (g: WorkflowGeneration, unit: GenerationUnit) =>
  unit.path.length > 0 &&
  protectedEdits(g).some(
    edit =>
      edit.path.length <= unit.path.length &&
      JSON.stringify(edit.path) === JSON.stringify(unit.path.slice(0, edit.path.length))
  ) &&
  readGenerationPath(g.base, unit.path) !== undefined

const valueShape = (g: WorkflowGeneration, unit: GenerationUnit) => {
  const shape = JSON.parse(promptText('workflow-wizard', isOutline(g.step) ? 'outlineShape' : 'settingShape'))
  if (unit.kind === 'overview')
    return Object.fromEntries(overviewKeys.filter(key => key in shape).map(key => [key, shape[key]]))
  if (unit.kind === 'character' || unit.kind === 'storyline') {
    const sample = shape[unit.kind === 'character' ? 'characters' : 'storylines']?.[0] || {}
    return { ...sample, id: (unit.path[unit.path.length - 1] as { id: string }).id }
  }
  return readGenerationPath(shape, unit.path)
}

const normalizeArray = (value: unknown, spec: UnitSpec, g: WorkflowGeneration, unit: GenerationUnit) => {
  if (!Array.isArray(value) || !value.length) reject(`${unit.label}内容为空，请重新生成这一项`)
  const items = value as unknown[]
  if (items.some(item => !isRecord(item) || spec.required.some(key => !text(item[key]))))
    reject(`${unit.label}里有条目缺少必要内容，请重新生成这一项`)
  const base = readGenerationPath(g.base, unit.path)
  const keepCount = !!spec.countFlag && (g.input.request?.preserve || []).includes(spec.countFlag) && Array.isArray(base)
  if (keepCount && (base as unknown[]).length !== items.length)
    reject(`${unit.label}的数量和要求保留的不一致（要求 ${(base as unknown[]).length} 项，返回 ${items.length} 项），请重新生成这一项`)
  const used = new Set<string>()
  return (items as JsonRecord[]).map((item, index) => {
    let id = keepCount
      ? String((base as JsonRecord[])[index].id)
      : isAdjust(g.step)
        ? text(item.id)
        : ''
    if (!id || used.has(id)) id = `${spec.idPrefix}${index + 1}`
    while (used.has(id)) id = `${id}-${index + 1}`
    used.add(id)
    return { ...item, id }
  })
}

const unitValue = (raw: string, g: WorkflowGeneration, unit: GenerationUnit): unknown => {
  const value = parseWorkflowJson(raw, ['value']).value
  const spec = specOf(unit, g)
  if (unit.kind === 'overview') {
    if (
      !isRecord(value) ||
      !Array.isArray(value.titleOptions) ||
      !value.titleOptions.length ||
      !text(value.intro) ||
      !text(value.storyHook) ||
      !Array.isArray(value.worldItems)
    )
      reject('总纲缺少书名、简介、核心钩子或世界观要点，请重新生成总纲')
    const titles = normalizeArray(value.titleOptions, SPECS.titles, g, { ...unit, label: '书名', path: ['titleOptions'] })
    return {
      ...Object.fromEntries(overviewKeys.filter(key => key in value).map(key => [key, value[key]])),
      titleOptions: titles,
      selectedTitleId: titles.some(item => item.id === value.selectedTitleId) ? value.selectedTitleId : titles[0].id
    }
  }
  if (unit.kind === 'hook') {
    if (!text(value)) reject('核心钩子内容为空，请重新生成这一项')
    return text(value)
  }
  if (unit.kind === 'world') {
    const items = Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : []
    if (!items.length) reject('世界观要点内容为空，请重新生成这一项')
    return items
  }
  if (unit.kind === 'core') {
    if (!isRecord(value) || coreKinds.some(key => !isRecord(value[key]) || !text((value[key] as JsonRecord).intro)))
      reject('核心体系要同时包含力量、能力、机制、资源四部分的说明，请重新生成这一项')
    return value
  }
  if (unit.kind === 'character' || unit.kind === 'storyline') {
    if (!isRecord(value) || spec.required.some(key => !text(value[key])))
      reject(`${unit.label}缺少必要内容，请重新生成这一项`)
    return { ...value, id: (unit.path[unit.path.length - 1] as { id: string }).id }
  }
  const items = normalizeArray(value, spec, g, unit)
  if (unit.kind === 'chapters') {
    const first = g.document.volumes?.[0]
    if (!first) reject('开篇章纲要先有分卷规划，请先生成分卷')
    return items.map((chapter, index) => ({
      ...chapter,
      chapterNo: index + 1,
      volumeId: first.id,
      stageId: first.stages?.[0]?.id || ''
    }))
  }
  return items
}

const setUnit = (g: WorkflowGeneration, unit: GenerationUnit, value: unknown) => {
  const edits: GenerationEdit[] =
    unit.kind === 'overview'
      ? Object.entries(value as JsonRecord).map(([key, item]) => ({ path: [key], op: 'set', value: item }))
      : [{ path: unit.path, op: 'set', value }]
  g.document = applyGenerationEdits(applyGenerationEdits(g.document, edits), [
    ...protectedEdits(g),
    ...g.edits
  ])
  if (isOutline(g.step)) {
    g.document.selectedTitleId ||= g.document.titleOptions?.[0]?.id
    g.document.selectedVolumeId ||= g.document.volumes?.[0]?.id
  }
}

const compact = (value: unknown): unknown => {
  if (typeof value === 'string') return value.slice(0, 400)
  if (Array.isArray(value)) return value.map(compact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !['chapters', 'records', 'assistActions', 'suggestions', 'infoItems'].includes(key)
        )
        .map(([key, item]) => [key, compact(item)])
    )
  return value
}

export const saveWorkflowGenerationEdits = (id: number, edits: GenerationEdit[]) => {
  return updateWorkflowGeneration(id, g => {
    if (!['incomplete', 'running', 'complete'].includes(g.status))
      throw new Error('这份草稿已结束，请在当前表单编辑')
    g.document = applyGenerationEdits(g.document, edits)
    for (const edit of edits) {
      g.edits = g.edits.filter(previous => JSON.stringify(previous.path) !== JSON.stringify(edit.path))
      g.edits.push(edit)
    }
  })
}
export const editWorkflowGeneration = (id: number, before: JsonRecord, after: JsonRecord) =>
  saveWorkflowGenerationEdits(id, diffGenerationEdits(before, after))

export const discardWorkflowGeneration = (id: number) =>
  updateWorkflowGeneration(id, g => {
    if (getLiveLocalTask(g.taskId)) throw new Error('请先停止生成再放弃草稿')
    g.status = 'discarded'
  })

/**
 * 读这个工作流的恢复草稿，顺手把"写着运行中、其实没有任务在跑"的记录修正：
 * 应用关闭或页面刷新时生成被打断，记录会停在 running。有过内容的改成未完成，作者可以继续或放弃；
 * 什么都没生成过的直接作废，不再给作者看一张 0/0 的卡。
 */
export const listRecoverableGenerations = async (runId: number): Promise<WorkflowGeneration[]> => {
  const records = await listWorkflowGenerations(runId)
  const result: WorkflowGeneration[] = []
  for (const g of records) {
    if (g.status !== 'running' || getLiveLocalTask(g.taskId)) {
      result.push(g)
      continue
    }
    const resumable = g.units.length > 0
    result.push(
      await updateWorkflowGeneration(g.id, value => {
        if (value.status !== 'running') return
        value.status = resumable ? 'incomplete' : 'discarded'
        value.error = resumable ? '上次生成在应用关闭或页面刷新时中断，已完成的部分保留，可以继续或放弃' : undefined
        value.failedUnit = undefined
      })
    )
  }
  return result
}

/** 内容完整、仅结束分片丢失时保住当前项；仍停在断点，不擅自开始下一项。 */
const requestUnit = async (options: Parameters<typeof requestWorkflowAi>[0]) => {
  try {
    return { raw: await requestWorkflowAi(options), interrupted: undefined as unknown }
  } catch (error) {
    const recoverable =
      (error instanceof WorkflowAiError &&
        ['CONNECTION_INTERRUPTED', 'STREAM_IDLE_TIMEOUT', 'NETWORK_ERROR'].includes(error.code)) ||
      (error instanceof DOMException && error.name === 'AbortError')
    if (recoverable && options.validate) {
      const draft = (await readWorkflowAiDrafts(options.runId).catch(() => [])).find(
        item => item.key === options.key
      )
      if (draft?.content) {
        try {
          options.validate(draft.content)
          return { raw: draft.content, interrupted: error }
        } catch {
          /* 残缺的单元继续保留原始草稿，不能回填表单。 */
        }
      }
    }
    throw error
  }
}

export const generateWorkflowUnits = async (options: {
  step: GenerationStep
  run: LocalWorkflowRun
  input: JsonRecord
  modelCode: string
  taskId: number
  messages: LocalChatMessageInput[]
  signal: AbortSignal
  onProgress: (generation: WorkflowGeneration) => Promise<void>
}): Promise<WorkflowGeneration> => {
  const { run, step, input, modelCode, taskId, signal } = options
  const active = () => {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
  }
  let generation: WorkflowGeneration
  if (input.generationId) {
    const saved = await readWorkflowGeneration(Number(input.generationId))
    if (
      !saved ||
      saved.runId !== Number(run.id) ||
      saved.step !== step ||
      ['applied', 'discarded', 'candidate'].includes(saved.status)
    )
      throw new Error('这份恢复任务不可继续，请检查当前工作流')
    const currentBase = isOutline(step)
      ? run.summary?.workflowOutlineUi || run.summary?.workflowOutline
      : run.summary?.workflowSettingUi || run.summary?.workflowSetting
    if (isAdjust(step) && JSON.stringify(currentBase || {}) !== JSON.stringify(saved.base))
      throw new Error('原稿在其他位置发生了变化，恢复草稿仍保留，请先确认原稿再调整')
    generation = await updateWorkflowGeneration(saved.id, g => {
      g.taskId = taskId
      g.status = 'running'
      g.error = undefined
    })
  } else {
    if (
      (await listRecoverableGenerations(Number(run.id))).some(g =>
        ['running', 'incomplete', 'complete'].includes(g.status)
      )
    )
      throw new Error('还有未完成的恢复草稿，请继续补全或放弃该草稿后再生成')
    const base = clone(
      (isOutline(step)
        ? run.summary?.workflowOutlineUi || run.summary?.workflowOutline
        : run.summary?.workflowSettingUi || run.summary?.workflowSetting) || {}
    )
    generation = {
      id: createLocalEntityId(),
      runId: Number(run.id),
      taskId,
      step,
      input: clone(input),
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      units: [],
      base,
      document: isAdjust(step) ? clone(base) : {},
      edits: [],
      instructions: options.messages
        .filter(message => message.role === 'user')
        .map(message => message.content.slice(Math.max(0, message.content.lastIndexOf('【任务】'))))
        .join('\n')
    }
    generation.units = unitsFor(generation)
    for (const unit of generation.units) if (fullyProtected(generation, unit)) unit.status = 'complete'
    await writeWorkflowGeneration(generation)
  }
  input.generationId = generation.id
  await options.onProgress(generation)
  try {
    if (!generation.units.length) {
      // 旧版记录可能还没有清单（当时清单由模型规划）：按现在的规则补上，已完成内容不动。
      generation = await updateWorkflowGeneration(generation.id, g => {
        g.units = unitsFor(g)
        for (const unit of g.units) if (fullyProtected(g, unit)) unit.status = 'complete'
      })
      await options.onProgress(generation)
    }
    for (const entry of generation.units) {
      active()
      generation = (await readWorkflowGeneration(generation.id))!
      if (generation.status === 'discarded') throw new DOMException('已放弃', 'AbortError')
      const unit = generation.units.find(item => item.id === entry.id)!
      if (unit.status === 'complete') continue
      generation = await updateWorkflowGeneration(generation.id, g => {
        g.failedUnit = unit.id
      })
      await options.onProgress(generation)
      const shape = valueShape(generation, unit)
      const context = {
        参数: run.config,
        灵感: run.summary?.ideaText,
        全书大纲: isOutline(step)
          ? undefined
          : compact(run.summary?.workflowOutlineUi || run.summary?.workflowOutline),
        已完成内容及作者修改: compact(generation.document),
        作者修改原文: generation.edits,
        任务清单: generation.units.map(u => ({ label: u.label, brief: u.brief, status: u.status }))
      }
      const single = unit.kind === 'character' || unit.kind === 'storyline'
      const received = await requestUnit({
        runId: Number(run.id),
        taskId,
        key: `generation:${generation.id}:${unit.id}`,
        modelCode,
        signal,
        scene: `workflow_unit_${unit.kind}`,
        sceneLabel: `建书·${unit.label}`,
        validate: text => {
          unitValue(text, generation, unit)
        },
        messages: [
          {
            role: 'system',
            content: `只完成当前这一项，不输出其他项目，不重写已经完成的内容。只输出完整JSON {"value":${JSON.stringify(shape)}}。${single ? '当前条目id必须保持。' : ''}遵守原始创作要求和作者修改；正文内容使用中文。`
          },
          {
            role: 'user',
            content: `原始要求：${generation.instructions}\n当前任务：${unit.label}\n目标与衔接：${unit.brief}\n参考上下文（已完成内容只作参考）：${JSON.stringify(context)}`
          }
        ]
      })
      if (!received.interrupted) active()
      const value = unitValue(received.raw, generation, unit)
      generation = await updateWorkflowGeneration(generation.id, g => {
        if (g.status === 'discarded') throw new DOMException('已放弃', 'AbortError')
        const current = g.units.find(item => item.id === unit.id)!
        if (current.status !== 'complete') {
          setUnit(g, current, value)
          current.status = 'complete'
        }
        g.failedUnit = undefined
      })
      await completeWorkflowAiDraft(Number(run.id), `generation:${generation.id}:${unit.id}`)
      await options.onProgress(generation)
      if (received.interrupted) throw received.interrupted
    }
    active()
    generation = await updateWorkflowGeneration(generation.id, g => {
      if (g.status === 'discarded') throw new DOMException('已放弃', 'AbortError')
      g.status = 'complete'
      g.error = undefined
    })
    return generation
  } catch (error) {
    await updateWorkflowGeneration(generation.id, g => {
      if (g.status !== 'discarded') {
        g.status = 'incomplete'
        g.error = signal.aborted
          ? '已停止，完成项目和手动修改已保留'
          : error instanceof Error
            ? error.message
            : '生成未完成'
      }
    }).catch(saveError => console.warn('生成状态保存失败，已落盘项目保留', saveError))
    throw error
  }
}
