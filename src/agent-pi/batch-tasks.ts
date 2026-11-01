import { computed, shallowRef } from 'vue'
import { piCommand } from './client'
import { hotState } from './hot-state'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import { announceTaskFinished, announceTaskStep, registerTaskProvider, type PiTaskView } from './tasks'
import { platformEventMessage } from './conversation'
import { skillCommand } from './skills'
import type { BatchPlan, BatchTask } from '@/types/batch-task'
import type { PiDraft } from '@/types/agent-pi'

/**
 * 批量写作：一章一轮。平台代作者发"写第 N 章"的事件，模型写完存候选，任务停下来等作者采用；
 * 采用后才发下一章。这里没有模型调用，只有状态推进：谁来发消息由工作台决定（它知道对话忙不忙）。
 */
export const batchTasks = hotState('batch:tasks', () => shallowRef<BatchTask[]>([]))
const command = <T>(op: string, args: Record<string, unknown> = {}) =>
  trackStorageWrite(() => piCommand<T>('batch_task', { op, ...args }))
const asList = (value: unknown) => (Array.isArray(value) ? (value as BatchTask[]) : [])
function update(task: BatchTask) {
  batchTasks.value = [task, ...batchTasks.value.filter(t => t.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt)
  return task
}
export async function loadBatchTasks() {
  batchTasks.value = asList(await command<BatchTask[]>('list'))
  return batchTasks.value
}
export async function initializeBatchTasks() {
  batchTasks.value = asList(await command<BatchTask[]>('recover'))
}
const byId = (id: string) => batchTasks.value.find(t => t.id === id)
/** 推进当前这一章的状态；推进到"该写下一章"时通知工作台去发消息。 */
async function step(id: string, change: 'writing' | 'review' | 'done' | 'skip' | 'chat_busy' | 'no_draft', extra: Record<string, unknown> = {}) {
  const task = update(await command<BatchTask>('step', { id, change, ...extra }))
  if (task.status === 'completed') announceTaskFinished('batch', task.id)
  else if (task.status === 'running' && (change === 'done' || change === 'skip')) announceTaskStep('batch', task.id)
  return task
}
export async function startBatch(
  plan: BatchPlan,
  modelCode: string,
  owner: { sessionId: string; callId?: string; anchor?: number; autoContinue?: boolean },
  id: string = crypto.randomUUID()
) {
  const task = update(await command<BatchTask>('create', { id, plan, modelCode, autoContinue: owner.autoContinue !== false, ...owner }))
  if (task.status === 'running') announceTaskStep('batch', task.id)
  return task
}
export async function controlBatch(id: string, action: 'pause' | 'resume' | 'cancel') {
  const old = byId(id)
  const task = action === 'resume' && old?.status === 'waiting' && old.waitingReason === 'no_draft'
    ? old
    : update(await command<BatchTask>(action, { id }))
  if (action === 'resume') {
    // 采用可能发生在暂停期间或本轮结算之前；先核对持久化候选，不能重发已经完成的章。
    const { listPiDrafts } = await import('./platform-tools')
    const found = await reconcileBatchDraft(task, await listPiDrafts(task.bookId))
    if (!found && task.status === 'running') announceTaskStep('batch', task.id)
    else if (!found && task.waitingReason === 'no_draft') announceTaskStep('batch', task.id)
  }
  return byId(id)!
}
export const setBatchAutoContinue = async (id: string, autoContinue: boolean) =>
  update(await command<BatchTask>('continue_state', { id, autoContinue }))
export const markBatchContinued = async (id: string) =>
  update(await command<BatchTask>('continue_state', { id, continuedAt: Date.now(), continueSkipped: null }))
export const markBatchContinueSkipped = async (id: string, reason: string) =>
  update(await command<BatchTask>('continue_state', { id, continueSkipped: reason }))
/** 工作台把这一章的事件发出去了。 */
export const markBatchStepWriting = (id: string) => step(id, 'writing')
/** 工作台发不出去（对话正忙、没打开）：退回等待，对话空出来再发。 */
export const markBatchStepBlocked = (id: string) => step(id, 'chat_busy')
export const skipBatchStep = (id: string) => step(id, 'skip')
/** 这一章的事件消息：目标、怎么写、写完等作者。 */
export function batchStepMessage(task: BatchTask) {
  const current = task.steps[task.cursor]
  if (!current) return null
  const total = task.steps.length
  const method = task.styleSkill
    ? `本任务沿用「${task.styleSkill}」，在写作简报中列明本章目标和所选技能。`
    : ''
  const message = platformEventMessage(
    `【批量写作 第 ${current.index + 1}/${total} 章】目标：${current.goal}\n` +
      '请按当前作品的目录、大纲和最近两章的正式正文写这一章：先用 read_book 的 chapters 视图确定目标章或分卷，平台在正文请求里取前文和资料。' +
      method +
      '若目录已有本章的空白章节，用 write_prose 指定目标章生成候选；否则用 write_prose 指定目标卷生成新章候选，归属目录里最后一卷的卷末。目标章没有章纲时，把本章目标写成 plan（章纲）一起传；已有章纲就照它。写完用一句话说明结果，等作者在右侧采用；需要作者决定的事用 ask_author。只写这一章，不写下一章。',
    { kind: 'batch_chapter', taskId: task.id, title: task.bookTitle, scope: task.scope, step: current.index + 1, total }
  )
  // 消息以 /skill: 开头时 Pi 会把技能说明展开放在前面，模型每一章都看到档案，不靠它自己记得去读
  return task.styleSkill ? skillCommand(task.styleSkill, message) : message
}
export const batchEventMessage = (task: BatchTask) =>
  platformEventMessage(
    `《${task.bookTitle}》${task.scope}的批量写作已经完成，${task.steps.filter(s => s.status === 'done').length} 章全部采用。请用一两句话收个尾：这几章推进了什么、下一步可以写什么；不要再生成新章节。`,
    { kind: 'batch_completed', taskId: task.id, title: task.bookTitle, scope: task.scope }
  )
// 新作品自带空白首章，填写它与新增一章都算本轮产出；修改已有正文不算新增写作。
const isWrittenChapter = (draft: PiDraft): draft is Extract<PiDraft, { kind: 'new_chapter' | 'chapter' }> =>
  (draft.kind === 'new_chapter' || (draft.kind === 'chapter' && typeof draft.baseText === 'string' && !draft.baseText.trim())) && !!draft.content.trim()
async function reconcileBatchDraft(task: BatchTask, drafts: PiDraft[]) {
  const current = task.steps[task.cursor]
  const reviewable = task.status === 'running' || (task.status === 'waiting' && ['review', 'no_draft'].includes(task.waitingReason || ''))
  if (!current || !reviewable || !['writing', 'review', 'pending'].includes(current.status)) return false
  // 没发过本轮事件时不能把此前候选认作本轮结果。重启会保留已结算轮次的时间和候选。
  if (!current.startedAt && !current.draftId) return false
  const since = Math.max(current.startedAt || 0, task.steps[task.cursor - 1]?.finishedAt || 0)
  const candidates = drafts.filter(isWrittenChapter).filter(d =>
    d.sessionId === task.sessionId && d.bookId === task.bookId && !d.dismissedAt &&
    d.createdAt >= since && !task.steps.some(s => s.status === 'done' &&
      (s.draftId === d.id || (d.chapterId && s.chapterId === d.chapterId)))
  ).sort((a, b) => a.createdAt - b.createdAt)
  const newest = candidates[candidates.length - 1]
  if (newest?.appliedAt && newest.chapterId) {
    await step(task.id, 'done', { chapterId: newest.chapterId, draftId: newest.id })
  } else if (newest) {
    if (newest.id !== current.draftId || task.waitingReason !== 'review')
      await step(task.id, 'review', { draftId: newest.id })
  } else if (current.status === 'writing') await step(task.id, 'no_draft')
  return !!newest
}
/** 一轮结束：正在写的这一章有没有存出候选；重写时换成最新的候选；对话忙时没发出去的章现在发。 */
export async function settleBatchTurn(sessionId: string, drafts: PiDraft[]) {
  for (const task of batchTasks.value.filter(t => t.sessionId === sessionId)) {
    const current = task.steps[task.cursor]
    if (!current) continue
    if (task.status === 'waiting' && task.waitingReason === 'chat_busy') {
      announceTaskStep('batch', task.id)
      continue
    }
    await reconcileBatchDraft(task, drafts)
  }
}
/** 作者采用了一份正文候选：是本轮新增的正文就推进，不重复生成已采用的章。 */
export async function batchDraftApplied(draft: PiDraft) {
  if (!isWrittenChapter(draft) || !draft.chapterId || !draft.appliedAt) return
  for (const task of batchTasks.value.filter(t => t.sessionId === draft.sessionId)) {
    await reconcileBatchDraft(task, [draft])
  }
}

// ---- 通用任务层的视图
function viewOf(task: BatchTask): PiTaskView {
  const total = task.steps.length
  const done = task.steps.filter(s => s.status === 'done').length
  const current = task.steps[task.cursor]
  const no = current ? current.index + 1 : total
  const statusLabel =
    task.status === 'running'
      ? '正在写'
      : task.status === 'waiting'
        ? task.waitingReason === 'review'
          ? '等你采用'
          : task.waitingReason === 'chat_busy'
            ? '等对话空出来'
            : '等你处理'
        : { paused: '已暂停', failed: '未完成', cancelled: '已取消', completed: '已完成' }[task.status]
  const hint =
    task.status === 'waiting'
      ? task.waitingReason === 'review'
        ? `第 ${no} 章已写好，在右侧采用后会自动写下一章；想改就在对话里说。`
        : task.waitingReason === 'chat_busy'
          ? `对话正忙，空出来后自动写第 ${no} 章。`
          : `这一轮 Agent 没有保存候选。在对话里让它写第 ${no} 章，或点"继续"重新发起。`
      : task.status === 'paused'
        ? '已暂停。已采用的章节保留，继续会从当前这一章接着。'
        : task.status === 'cancelled'
          ? '已取消。已采用的章节保留。'
          : task.status === 'completed' && task.continueSkipped && !task.continuedAt
            ? `写完了，没有自动收尾：${task.continueSkipped}。`
            : ''
  const finished = task.status === 'completed' || task.status === 'cancelled'
  return {
    kind: 'batch',
    id: task.id,
    sessionId: task.sessionId,
    callId: task.callId,
    anchor: task.anchor,
    createdAt: task.createdAt,
    title: task.bookTitle,
    scope: task.styleSkill ? `${task.scope} · 按「${task.styleSkill}」写` : task.scope,
    status: task.status,
    statusLabel,
    active: task.status === 'running',
    percent: task.status === 'completed' ? 100 : total ? Math.round((done / total) * 100) : 0,
    numbers: [`已采用 ${done}/${total} 章`],
    current: task.status === 'running' && current ? `正在写第 ${no}/${total} 章：${current.goal}` : '',
    hint,
    error: task.error,
    summaryTitle: '结果',
    summary: task.status === 'completed' ? [`已连写 ${done} 章，全部采用进作品。`] : [],
    autoContinue: task.autoContinue !== false,
    continuedAt: task.continuedAt,
    continueSkipped: task.continueSkipped,
    actions: {
      pause: task.status === 'running' || task.status === 'waiting',
      resume: task.status === 'paused' || task.status === 'failed' || (task.status === 'waiting' && task.waitingReason === 'no_draft'),
      retry: task.status === 'failed',
      cancel: !finished,
      autoContinue: !finished,
      continueNow: task.status === 'completed' && !!task.continueSkipped && !task.continuedAt
    },
    cancelTitle: '取消批量写作',
    cancelText: `还没写的 ${total - done} 章不再写，已采用的 ${done} 章保留。`,
    result: null
  }
}
export const batchTaskViews = computed(() => batchTasks.value.map(viewOf))
registerTaskProvider({
  kind: 'batch',
  views: () => batchTaskViews.value,
  control: controlBatch,
  setAutoContinue: setBatchAutoContinue,
  markContinued: markBatchContinued,
  markContinueSkipped: markBatchContinueSkipped,
  eventMessage: view => {
    const task = byId(view.id)
    return task ? batchEventMessage(task) : null
  },
  stepMessage: view => {
    const task = byId(view.id)
    return task ? batchStepMessage(task) : null
  },
  stepSent: markBatchStepWriting,
  stepBlocked: markBatchStepBlocked,
  onTurnSettled: settleBatchTurn,
  onDraftApplied: batchDraftApplied,
  initialize: initializeBatchTasks,
  stopAll: async () => undefined,
  hasRunning: () => false
})
