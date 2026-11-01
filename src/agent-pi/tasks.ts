import { computed, ref } from 'vue'
import { hotState } from './hot-state'
import { changeRunControl } from './run-control'
import type { PiHeldTask, PiDraft } from '@/types/agent-pi'

/** 长任务的通用层：拆书、蒸馏、批量写作、封面各自只提供"怎么跑"和"怎么看"，卡片、完成事件、关闭恢复都在这里统一。 */
export type PiTaskKind = 'breakdown' | 'distillation' | 'batch' | 'cover'
export type PiTaskStatus = 'running' | 'pausing' | 'paused' | 'waiting' | 'failed' | 'cancelled' | 'completed'
export type PiTaskAction = 'pause' | 'resume' | 'cancel'
export interface PiTaskResult {
  kind: 'report' | 'skill' | 'cover' | 'drafts'
  id: string
  label: string
}
/** 任务卡要显示的一切；各类任务把自己的记录换算成这个视图。 */
export interface PiTaskView {
  kind: PiTaskKind
  id: string
  sessionId: string
  callId?: string
  anchor?: number
  createdAt: number
  title: string
  scope: string
  status: PiTaskStatus
  statusLabel: string
  /** 进行中或正在暂停：卡片转圈、每秒刷新。 */
  active: boolean
  percent: number
  numbers: string[]
  current: string
  hint: string
  error?: string | null
  summaryTitle: string
  summary: string[]
  autoContinue: boolean
  continuedAt?: number | null
  continueSkipped?: string | null
  actions: {
    pause: boolean
    resume: boolean
    retry: boolean
    cancel: boolean
    autoContinue: boolean
    continueNow: boolean
  }
  cancelTitle: string
  cancelText: string
  result: PiTaskResult | null
}
export interface PiTaskProvider {
  kind: PiTaskKind
  views: () => PiTaskView[]
  control: (id: string, action: PiTaskAction) => Promise<unknown>
  setAutoContinue: (id: string, autoContinue: boolean) => Promise<unknown>
  markContinued: (id: string) => Promise<unknown>
  markContinueSkipped: (id: string, reason: string) => Promise<unknown>
  /** 任务完成后代作者发给模型的那句话；不需要接着说的任务返回 null。 */
  eventMessage: (view: PiTaskView) => string | null
  /** 分步任务（批量写作）：该发下一步时给工作台的那条消息，以及发出去 / 发不出去的回执。 */
  stepMessage?: (view: PiTaskView) => string | null
  stepSent?: (id: string) => Promise<unknown>
  stepBlocked?: (id: string) => Promise<unknown>
  /** 对话里一轮结束、作者采用了候选：分步任务据此推进。 */
  onTurnSettled?: (sessionId: string, drafts: PiDraft[]) => Promise<unknown>
  onDraftApplied?: (draft: PiDraft) => Promise<unknown>
  initialize: () => Promise<unknown>
  stopAll: () => Promise<unknown>
  hasRunning: () => boolean
}
const providers = hotState('tasks:providers', () => new Map<PiTaskKind, PiTaskProvider>())
const registered = hotState('tasks:registered', () => ref(0))
/** 进行中的任务每秒刷新一次已用时间和预计剩余。 */
export const taskClock = hotState('tasks:clock', () => ref(Date.now()))
let ticker = 0
export function registerTaskProvider(provider: PiTaskProvider) {
  providers.set(provider.kind, provider)
  registered.value++
  if (typeof window !== 'undefined' && !ticker)
    ticker = window.setInterval(() => {
      if (piTasks.value.some(view => view.active)) taskClock.value = Date.now()
    }, 1000)
}
export const piTasks = computed<PiTaskView[]>(() => {
  void registered.value
  return [...providers.values()].flatMap(provider => provider.views()).sort((a, b) => a.createdAt - b.createdAt)
})
export const taskView = (kind: PiTaskKind, id: string) =>
  piTasks.value.find(view => view.kind === kind && view.id === id) || null
export const findTaskView = (id: string) => piTasks.value.find(view => view.id === id) || null
function provider(kind: PiTaskKind) {
  const item = providers.get(kind)
  if (!item) throw new Error('未知任务类型')
  return item
}
export async function controlTask(kind: PiTaskKind, id: string, action: PiTaskAction) {
  const view = taskView(kind, id)
  if (action === 'resume' && view?.sessionId && view.sessionId !== 'workbench')
    await changeRunControl(view.sessionId, 'release_task', { task: { kind, id } })
  return provider(kind).control(id, action)
}
export async function pauseHeldTasks(tasks: PiHeldTask[]) {
  for (const task of tasks) if (taskView(task.kind, task.id)?.actions.pause)
    await provider(task.kind).control(task.id, 'pause')
}
export async function resumeHeldTasks(tasks: PiHeldTask[]) {
  for (const task of tasks) if (task.wasRunning && taskView(task.kind, task.id)?.status === 'paused')
    await provider(task.kind).control(task.id, 'resume')
}
export const setTaskAutoContinue = (kind: PiTaskKind, id: string, autoContinue: boolean) =>
  provider(kind).setAutoContinue(id, autoContinue)
export const markTaskContinued = (kind: PiTaskKind, id: string) => provider(kind).markContinued(id)
export const markTaskContinueSkipped = (kind: PiTaskKind, id: string, reason: string) =>
  provider(kind).markContinueSkipped(id, reason)
export const taskEventMessage = (view: PiTaskView) => provider(view.kind).eventMessage(view)
export const hasRunningTasks = () => [...providers.values()].some(item => item.hasRunning())
export async function initializeTasks() {
  for (const item of providers.values()) await item.initialize()
}
export async function stopTasks() {
  await Promise.all([...providers.values()].map(item => item.stopAll()))
}
export const taskStepMessage = (view: PiTaskView) => provider(view.kind).stepMessage?.(view) ?? null
export const taskStepSent = (view: PiTaskView) => provider(view.kind).stepSent?.(view.id)
export const taskStepBlocked = (view: PiTaskView) => provider(view.kind).stepBlocked?.(view.id)
export async function notifyTurnSettled(sessionId: string, drafts: PiDraft[]) {
  for (const item of providers.values()) await item.onTurnSettled?.(sessionId, drafts)
}
export async function notifyDraftApplied(draft: PiDraft) {
  for (const item of providers.values()) await item.onDraftApplied?.(draft)
}
export const TASK_STEP_EVENT = 'ew-task-step'
/** 分步任务要发下一步了；工作台收到后看对话忙不忙，忙就让任务等着。 */
export function announceTaskStep(kind: PiTaskKind, id: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<PiTaskFinished>(TASK_STEP_EVENT, { detail: { kind, id } }))
}
export const TASK_FINISHED_EVENT = 'ew-task-finished'
export interface PiTaskFinished {
  kind: PiTaskKind
  id: string
}
/** 任务完成或失败时发一个窗口事件；工作台据此决定要不要代作者让模型接着说。 */
export function announceTaskFinished(kind: PiTaskKind, id: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<PiTaskFinished>(TASK_FINISHED_EVENT, { detail: { kind, id } }))
}
