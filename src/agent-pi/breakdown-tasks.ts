import { computed, shallowRef } from 'vue'
import { announceTaskFinished, registerTaskProvider, taskClock, type PiTaskView } from './tasks'
import { breakdownEventMessage, formatDuration } from './conversation'
import { piCommand } from './client'
import { hotState } from './hot-state'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import {
  getLiveLocalTask,
  registerLiveLocalTask,
  unregisterLiveLocalTask
} from '@/utils/local-workflow-runtime'
import { streamLocalChatCompletion } from '@/utils/local-ai-client'
import { buildChapterBreakdownMessages, buildBookReportMessages } from '@/config/breakdown-prompts'
import { parseAiJson } from '@/utils/ai-json'
import {
  splitBreakdownText,
  normalizeBreakdownPart,
  mergeBreakdownParts,
  reportGroups
} from './breakdown-analysis'
import type { BreakdownPlan, BreakdownTask, BreakdownPart, ChapterAnalysis } from '@/types/breakdown-task'
import type { JsonRecord } from '@/types/json'
import type { LocalBreakdownChapterContent } from '@/storage/local-breakdown'

export const breakdownTasks = hotState('breakdown:tasks', () => shallowRef<BreakdownTask[]>([]))
/** 每 50 章先出一份分段报告，范围报告只总结分段报告，千章级的书不再逐层硬压。 */
export const SEGMENT_SIZE = 50
/** 同一段分析失败后再试的次数；两次都不行才停任务。 */
const CHUNK_ATTEMPTS = 2

/** 运行中的实时进度：只在内存里，给任务卡显示当前在做什么、收到了多少、已用多久。 */
export interface BreakdownLive {
  phase: 'chapter' | 'segment' | 'report'
  chapterId?: number
  chapterTitle?: string
  part?: number
  parts?: number
  segment?: number
  segments?: number
  attempt?: number
  chunkChars: number
  receivedChars: number
  startedAt: number
  taskStartedAt: number
  doneChars: number
  totalChars: number
  /** 本次运行已完成分段的原文字数与耗时，用来估算剩余时间。 */
  measuredChars: number
  measuredMs: number
}
export const breakdownLive = hotState('breakdown:live', () => shallowRef<Record<string, BreakdownLive>>({}))
function setLive(id: string, patch: Partial<BreakdownLive>) {
  const previous = breakdownLive.value[id]
  const base: BreakdownLive = previous || {
    phase: 'chapter',
    chunkChars: 0,
    receivedChars: 0,
    startedAt: Date.now(),
    taskStartedAt: Date.now(),
    doneChars: 0,
    totalChars: 0,
    measuredChars: 0,
    measuredMs: 0
  }
  breakdownLive.value = { ...breakdownLive.value, [id]: { ...base, ...patch } }
}
function clearLive(id: string) {
  if (!breakdownLive.value[id]) return
  const next = { ...breakdownLive.value }
  delete next[id]
  breakdownLive.value = next
}

const running = new Map<string, { controller: AbortController; promise: Promise<void>; pause: boolean }>()
const starting = new Set<Promise<unknown>>()
let recovering: Promise<void> | undefined,
  closing = false
const command = <T>(op: string, args: Record<string, unknown> = {}) =>
  trackStorageWrite(() => piCommand<T>('breakdown_task', { op, ...args }))
function update(t: BreakdownTask) {
  breakdownTasks.value = [t, ...breakdownTasks.value.filter(v => v.id !== t.id)].sort(
    (a, b) => b.createdAt - a.createdAt
  )
  window.dispatchEvent(
    new CustomEvent('ew-breakdown-tasks-changed', { detail: { projectId: t.projectId, taskId: t.id } })
  )
  return t
}
export async function loadBreakdownTasks() {
  breakdownTasks.value = await command<BreakdownTask[]>('list')
  return breakdownTasks.value
}
export async function initializeBreakdownTasks() {
  if (!recovering)
    recovering = command<BreakdownTask[]>('recover')
      .then(t => {
        breakdownTasks.value = t
      })
      .catch(e => {
        recovering = undefined
        throw e
      })
  await recovering
}
export const hasRunningBreakdowns = () => running.size > 0 || starting.size > 0
export const prepareBreakdown = (projectId: number, chapterIds: number[], reanalyze = false) =>
  command<BreakdownPlan>('prepare', { projectId, chapterIds, reanalyze })
export async function startBreakdown(
  plan: BreakdownPlan,
  modelCode: string,
  owner: { sessionId: string; callId?: string; anchor?: number; autoContinue?: boolean },
  id: string = crypto.randomUUID()
) {
  if (closing) throw new Error('应用正在关闭，未启动拆书')
  if (getLiveLocalTask(plan.projectId)) throw new Error('这本书已有任务在执行，原任务未被替换')
  const pending = command<BreakdownTask>('create', {
    id,
    plan,
    modelCode,
    autoContinue: owner.autoContinue !== false,
    ...owner
  }).then(async value => {
    let task = update(value)
    if (closing && task.status === 'running')
      task = update(await command<BreakdownTask>('paused', { id: task.id, runToken: task.runToken }))
    else if (task.status === 'running') launch(task)
    return task
  })
  starting.add(pending)
  try {
    return await pending
  } finally {
    starting.delete(pending)
  }
}
export async function claimWorkbenchBreakdown(id: string, sessionId: string) {
  return update(await command<BreakdownTask>('claim', { id, sessionId }))
}
export async function controlBreakdown(id: string, action: 'pause' | 'resume' | 'cancel') {
  if (closing && action === 'resume') throw new Error('正在关闭，请稍后继续')
  const live = running.get(id)
  if (action === 'resume') {
    const old = breakdownTasks.value.find(t => t.id === id)
    if (live || (old && getLiveLocalTask(old.projectId))) throw new Error('该书已有任务在执行')
    const pending = command<BreakdownTask>('resume', { id }).then(async value => {
      let task = update(value)
      if (closing) task = update(await command<BreakdownTask>('paused', { id, runToken: task.runToken }))
      else launch(task)
      return task
    })
    starting.add(pending)
    try {
      return await pending
    } finally {
      starting.delete(pending)
    }
  }
  if (action === 'pause' && live) live.pause = true
  const task = update(await command<BreakdownTask>(action, { id }))
  if (action === 'cancel') {
    live?.controller.abort()
    await live?.promise
  }
  return task
}
/** 拆完后要不要自动让 Agent 接着说结论；以及接着说的回执。 */
export async function setBreakdownAutoContinue(id: string, autoContinue: boolean) {
  return update(await command<BreakdownTask>('continue_state', { id, autoContinue }))
}
export async function markBreakdownContinued(id: string) {
  return update(await command<BreakdownTask>('continue_state', { id, continuedAt: Date.now(), continueSkipped: null }))
}
export async function markBreakdownContinueSkipped(id: string, reason: string) {
  return update(await command<BreakdownTask>('continue_state', { id, continueSkipped: reason }))
}
export async function stopBreakdownTasks() {
  closing = true
  await Promise.allSettled([...starting])
  await Promise.all(
    [...running.entries()].map(async ([id, live]) => {
      // Shutdown stops in-flight model calls; only already committed checkpoints survive.
      live.pause = true
      live.controller.abort()
      await live.promise
      const task = breakdownTasks.value.find(t => t.id === id)
      if (task && ['running', 'pausing'].includes(task.status))
        update(await command<BreakdownTask>('paused', { id, runToken: task.runToken }))
    })
  )
}
export function allowBreakdownTasks() {
  closing = false
}
export async function readTaskChapter(id: string, chapterId: number) {
  return command<{
    sourceChanged: boolean
    content: LocalBreakdownChapterContent
    saved: { parts: BreakdownPart[]; result: ChapterAnalysis | null }
  }>('chapter', { id, chapterId })
}
function launch(initial: BreakdownTask) {
  if (running.has(initial.id)) return
  const live = { controller: new AbortController(), promise: Promise.resolve(), pause: false }
  running.set(initial.id, live)
  registerLiveLocalTask({
    taskId: initial.projectId,
    runId: initial.projectId,
    kind: 'breakdown',
    requestPause: () => {
      void controlBreakdown(initial.id, 'pause')
    },
    requestCancel: () => {
      void controlBreakdown(initial.id, 'cancel')
    }
  })
  live.promise = run(initial, live).finally(() => {
    running.delete(initial.id)
    clearLive(initial.id)
    unregisterLiveLocalTask(initial.projectId)
  })
  void live.promise.catch(() => {})
}
/** 流式调用：每收到一段就更新实时进度；作者取消时不把半截结果当成功。 */
async function completeWithProgress(
  id: string,
  options: {
    modelCode: string
    scene: string
    sceneLabel: string
    messages: ReturnType<typeof buildChapterBreakdownMessages>
    signal: AbortSignal
  }
) {
  let text = '',
    failure = ''
  const result = await streamLocalChatCompletion(
    { ...options, temperature: 0.4 },
    {
      onDelta: delta => {
        text += delta
        setLive(id, { receivedChars: text.length })
      },
      onDone: () => {},
      onError: message => {
        failure = message
      }
    }
  )
  options.signal.throwIfAborted()
  if (failure) throw new Error(failure)
  return result.content || text
}
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
async function run(initial: BreakdownTask, live: { controller: AbortController; pause: boolean }) {
  let task = initial
  const signal = live.controller.signal
  const save = async (op: string, args: Record<string, unknown> = {}) => {
    task = update(await command<BreakdownTask>(op, { id: task.id, runToken: initial.runToken, ...args }))
    return task
  }
  const checkpoint = async () => {
    if (live.pause || signal.aborted || task.status === 'pausing') {
      await save('paused')
      return true
    }
    return false
  }
  const totalChars = task.chapters.reduce((sum, c) => sum + c.chars, 0)
  setLive(task.id, {
    phase: 'chapter',
    taskStartedAt: Date.now(),
    startedAt: Date.now(),
    totalChars,
    doneChars: task.chapters.reduce((sum, c) => sum + (c.done ? c.chars : c.offset || 0), 0),
    measuredChars: 0,
    measuredMs: 0
  })
  const ordered = [...task.chapters].sort((a, b) => a.sortNo - b.sortNo)
  /** 分层汇总：输入超过单次上限时逐层压缩，每一层的结果都落盘，继续时不重做。 */
  const buildReport = async (title: string, inputs: string[], prefix: string, label: string) => {
    for (let level = 0; level < 20; level++) {
      const groups = reportGroups(inputs),
        outputs: JsonRecord[] = []
      for (let index = 0; index < groups.length; index++) {
        if (await checkpoint()) return null
        const step = `${prefix}:${level}:${index}`
        let report = task.reportSteps[step]
        if (!report) {
          const messages = buildBookReportMessages({ bookTitle: title, chapterBriefs: groups[index] })
          messages[0].content +=
            '\n只总结提供的材料，不能声称读过范围外正文。材料若为分组摘要，不推断未提供的章节。输出紧凑 JSON，总长度不超过3000字；保留原章节号及有依据的写作方法。'
          setLive(task.id, { receivedChars: 0, startedAt: Date.now(), attempt: 1 })
          const raw = await completeWithProgress(task.id, {
            modelCode: task.modelCode,
            scene: 'breakdown_report',
            sceneLabel: `拆书·${label}`,
            messages,
            signal
          })
          report = parseAiJson(raw, ['editorNotes', 'reusableTechniques']) as JsonRecord
          if (!report || (!report.editorNotes && !Array.isArray(report.reusableTechniques)))
            throw new Error('范围报告无法解析，章节结果已保留')
          if (JSON.stringify(report).length > 12000)
            throw new Error('范围报告过长，章节结果已保留，请继续重试报告')
          await save('report_step', { step, report })
        }
        outputs.push(report)
      }
      if (groups.length === 1) return outputs[0]
      inputs = outputs.map((v, i) => `范围内第${i + 1}组摘要：${JSON.stringify(v)}`)
    }
    throw new Error('报告汇总未收敛，章节结果已保存')
  }
  try {
    for (const target of ordered) {
      if (await checkpoint()) return
      if (target.done) continue
      const data = await readTaskChapter(task.id, target.id)
      if (data.sourceChanged) throw new Error('原文已变化，请重新确认任务范围')
      const parts = data.saved.parts
      const chunks = splitBreakdownText(data.content.paragraphs)
      for (const chunk of chunks) {
        if (chunk.end <= (target.offset || 0)) continue
        if (await checkpoint()) return
        const chunkChars = chunk.end - chunk.start
        let part: BreakdownPart | undefined
        for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !part; attempt++) {
          setLive(task.id, {
            phase: 'chapter',
            chapterId: target.id,
            chapterTitle: target.title,
            part: chunks.indexOf(chunk) + 1,
            parts: chunks.length,
            attempt,
            chunkChars,
            receivedChars: 0,
            startedAt: Date.now()
          })
          const startedAt = Date.now()
          const messages = buildChapterBreakdownMessages({
            bookTitle: task.title,
            chapterTitle: target.title,
            chapterNo: target.sortNo,
            paragraphs: chunk.text.replace(/\n$/, '').split('\n'),
            isGolden: target.sortNo <= 3 && chunk.start === 0
          })
          messages[0].content +=
            '\n这是分段拆书，只分析本段，不把未读内容当作已知。JSON 另增加 findings 数组，每项为 {fact:原文事实, interpretation:分析判断, technique:可借鉴写法, quote:本段中逐字存在的一小段原文}。至少给出一项有依据的分析，不编造引用。'
          messages.push({
            role: 'user',
            content: `本章第 ${chunks.indexOf(chunk) + 1}/${chunks.length} 部分，原文第 ${chunk.firstPara}—${chunk.lastPara} 段。输出节点段落编号按本次输入从1开始。${parts.length ? `前一部分摘要（仅作上下文）：${parts[parts.length - 1].analysis.summary}` : ''}`
          })
          try {
            const raw = await completeWithProgress(task.id, {
              modelCode: task.modelCode,
              scene: 'breakdown_chapter',
              sceneLabel: '拆书·分段分析',
              messages,
              signal
            })
            const parsed = parseAiJson(raw, ['summary', 'outline'])
            if (!parsed) throw new Error('分析格式无效，未计为完成')
            part = {
              start: chunk.start,
              end: chunk.end,
              firstPara: chunk.firstPara,
              lastPara: chunk.lastPara,
              analysis: normalizeBreakdownPart(parsed, chunk, data.content.paragraphs)
            }
            const current = breakdownLive.value[task.id]
            setLive(task.id, {
              measuredChars: (current?.measuredChars || 0) + chunkChars,
              measuredMs: (current?.measuredMs || 0) + (Date.now() - startedAt)
            })
          } catch (error) {
            // 作者取消或停止不重试；格式或引文问题同一段再试一次。
            if (signal.aborted || isAbort(error) || attempt >= CHUNK_ATTEMPTS) throw error
          }
        }
        await save('part', { chapterId: target.id, part: part! })
        parts.push(part!)
        setLive(task.id, { doneChars: (breakdownLive.value[task.id]?.doneChars || 0) + chunkChars })
      }
      // A fully read chapter can be merged locally without another billable request.
      signal.throwIfAborted()
      await save('complete_chapter', {
        chapterId: target.id,
        ...mergeBreakdownParts(parts, data.content.paragraphs.length)
      })
    }
    if (await checkpoint()) return
    const briefs = new Map<number, string>()
    for (const c of ordered) {
      const data = await readTaskChapter(task.id, c.id)
      briefs.set(c.id, `第${c.sortNo}章《${c.title}》\n${JSON.stringify(data.saved.result)}`)
    }
    let inputs: string[]
    if (ordered.length > SEGMENT_SIZE) {
      const segments: Array<typeof ordered> = []
      for (let i = 0; i < ordered.length; i += SEGMENT_SIZE) segments.push(ordered.slice(i, i + SEGMENT_SIZE))
      inputs = []
      for (const [index, segment] of segments.entries()) {
        const range = `第 ${segment[0].sortNo}–${segment[segment.length - 1].sortNo} 章`
        const key = `segment:${index}`
        let report = task.reportSteps[key]
        if (!report) {
          setLive(task.id, { phase: 'segment', segment: index + 1, segments: segments.length, receivedChars: 0, startedAt: Date.now() })
          const built = await buildReport(
            `${task.title} · ${range}（仅限此分段）`,
            segment.map(c => briefs.get(c.id)!),
            `segment-step:${index}`,
            `${range}分段报告`
          )
          if (!built) return
          report = built
          await save('report_step', { step: key, report })
        }
        inputs.push(`${range}分段报告：${JSON.stringify(report)}`)
      }
    } else inputs = ordered.map(c => briefs.get(c.id)!)
    setLive(task.id, { phase: 'report', receivedChars: 0, startedAt: Date.now() })
    const report = await buildReport(`${task.title} · ${task.scope}（仅限此范围）`, inputs, 'final', `${task.scope}总结`)
    if (!report) return
    await save('complete', { report })
    announceTaskFinished('breakdown', task.id)
  } catch (error) {
    const current = await command<BreakdownTask>('get', { id: initial.id })
    update(current)
    if (current.runToken !== initial.runToken || !['running', 'pausing'].includes(current.status)) return
    if (signal.aborted && live.pause) await save('paused')
    else {
      await save('fail', { error: error instanceof Error ? error.message : String(error) })
      announceTaskFinished('breakdown', task.id)
    }
  }
}

// ---- 通用任务层的视图：任务卡要显示的进度、当前在做什么、预计剩余都在这里算，卡片本身不认识拆书。
const STATUS_LABELS: Record<BreakdownTask['status'], string> = {
  running: '进行中',
  pausing: '正在暂停',
  paused: '已暂停',
  failed: '未完成',
  cancelled: '已取消',
  completed: '已完成'
}
const wan = (chars: number) => (chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万` : String(chars))
function viewOf(task: BreakdownTask, now: number): PiTaskView {
  const live = breakdownLive.value[task.id]
  const active = task.status === 'running' || task.status === 'pausing'
  const done = task.chapters.filter(c => c.done).length
  const totalChars = task.chapters.reduce((sum, c) => sum + c.chars, 0)
  const savedChars = task.chapters.reduce((sum, c) => sum + (c.done ? c.chars : c.offset || 0), 0)
  /** 本次运行里已完成分段的速度：原文字数 / 耗时。 */
  const speed = live?.measuredMs ? live.measuredChars / live.measuredMs : 0
  /** 正在分析的这一段按时间给部分进度，不超过本段的九成。 */
  const chunkCredit =
    live && live.phase === 'chapter' && active ? Math.min(live.chunkChars * 0.9, speed ? (now - live.startedAt) * speed : 0) : 0
  const doneCharsShown = Math.min(totalChars, savedChars + Math.round(chunkCredit))
  let percent = 0
  if (task.status === 'completed') percent = 100
  else if (totalChars) {
    if (live?.phase === 'segment' && live.segments) percent = Math.round(92 + (((live.segment || 1) - 1) / live.segments) * 6)
    else if (live?.phase === 'report') percent = 98
    else percent = Math.round(Math.min(92, ((savedChars + chunkCredit) / totalChars) * 92))
  }
  const elapsed = live ? now - live.taskStartedAt : 0
  let eta = ''
  if (live && active) {
    if (live.phase !== 'chapter') eta = speed ? '1 分钟左右' : ''
    else if (!speed) {
      const [low, high] = task.estimatedMinutes || []
      eta = low && high ? `${low}–${high} 分钟（粗估）` : ''
    } else {
      const remaining = Math.max(0, totalChars - savedChars - chunkCredit)
      eta = formatDuration(remaining / speed + 45000 * Math.max(1, Math.ceil(task.chapters.length / SEGMENT_SIZE)))
    }
  }
  const numbers = [`已完成 ${done}/${task.chapters.length} 章`, `已分析 ${wan(doneCharsShown)} / ${wan(totalChars)} 字`]
  if (active && elapsed > 0) numbers.push(`已用 ${formatDuration(elapsed)}`)
  if (active && eta) numbers.push(`预计还需约 ${eta}`)
  let current = ''
  if (active) {
    if (!live) current = task.status === 'pausing' ? '正在保存当前片段，保存后暂停…' : '正在准备…'
    else {
      const received = live.receivedChars ? ` · 已收到 ${live.receivedChars} 字分析` : ''
      const spent = ` · 本段 ${formatDuration(now - live.startedAt)}`
      if (live.phase === 'segment') current = `正在汇总第 ${live.segment}/${live.segments} 份分段报告${received}${spent}`
      else if (live.phase === 'report') current = `正在汇总${task.scope}总结${received}${spent}`
      else {
        const chapter = task.chapters.find(c => c.id === live.chapterId)
        const where = chapter ? `第${chapter.sortNo}章《${chapter.title}》` : live.chapterTitle || ''
        const part = (live.parts || 1) > 1 ? ` 第 ${live.part}/${live.parts} 段` : ''
        const retry = (live.attempt || 1) > 1 ? '（重试一次）' : ''
        current = `${task.status === 'pausing' ? '正在保存' : '正在分析'}${where}${part}${retry}${received}${spent}`
      }
    }
  }
  const hint =
    task.status === 'paused'
      ? '已暂停。已完成的章节保留，继续会从断点接着分析。'
      : task.status === 'cancelled'
        ? '已取消。已完成的章节结果保留。'
        : task.status === 'completed' && task.continueSkipped && !task.continuedAt
          ? `拆完了，没有自动接着分析：${task.continueSkipped}。`
          : ''
  const summary =
    task.status === 'completed' && typeof task.report?.editorNotes === 'string'
      ? task.report.editorNotes
          .trim()
          .split(/\n+/)
          .map(line => line.trim())
          .filter(Boolean)
      : []
  const finished = task.status === 'completed' || task.status === 'cancelled'
  return {
    kind: 'breakdown',
    id: task.id,
    sessionId: task.sessionId,
    callId: task.callId,
    anchor: task.anchor,
    createdAt: task.createdAt,
    title: task.title,
    scope: task.scope,
    status: task.status,
    statusLabel: STATUS_LABELS[task.status],
    active,
    percent,
    numbers,
    current,
    hint,
    error: task.error,
    summaryTitle: '范围总结',
    summary,
    autoContinue: task.autoContinue !== false,
    continuedAt: task.continuedAt,
    continueSkipped: task.continueSkipped,
    actions: {
      pause: task.status === 'running',
      resume: task.status === 'paused' || task.status === 'failed',
      retry: task.status === 'failed',
      cancel: !finished,
      autoContinue: !finished,
      continueNow: task.status === 'completed' && !!task.continueSkipped && !task.continuedAt
    },
    cancelTitle: '取消拆书',
    cancelText: `还没拆的 ${task.chapters.length - done} 章不再拆，已拆的 ${done} 章保留，之后可以重新发起。`,
    result: done || task.report ? { kind: 'report', id: task.id, label: '查看报告' } : null
  }
}
export const breakdownTaskViews = computed(() => breakdownTasks.value.map(task => viewOf(task, taskClock.value)))
registerTaskProvider({
  kind: 'breakdown',
  views: () => breakdownTaskViews.value,
  control: controlBreakdown,
  setAutoContinue: setBreakdownAutoContinue,
  markContinued: markBreakdownContinued,
  markContinueSkipped: markBreakdownContinueSkipped,
  eventMessage: view => breakdownEventMessage({ id: view.id, title: view.title, scope: view.scope }),
  initialize: initializeBreakdownTasks,
  stopAll: stopBreakdownTasks,
  hasRunning: hasRunningBreakdowns
})
