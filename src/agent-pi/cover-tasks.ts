import { computed, shallowRef } from 'vue'
import { piCommand } from './client'
import { hotState } from './hot-state'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import { generateLocalAiImage } from '@/storage/local-ai-images'
import { composeCoverDataUrl, composeCoverPrompt } from '@/writing-service/cover-image'
import { announceTaskFinished, registerTaskProvider, taskClock, type PiTaskView } from './tasks'
import { formatDuration, platformEventMessage } from './conversation'
import type { CoverBrief, CoverTask } from '@/types/cover-task'

/** 封面：确认简报后调平台画图生成一张，右栏预览；作者点采用才裁成封面比例写进作品。 */
export const coverTasks = hotState('cover:tasks', () => shallowRef<CoverTask[]>([]))
const NEGATIVE_PROMPT = '水印, watermark, logo, 标志, 签名, 文字, frame, lowres, blurry, deformed, bad anatomy, extra fingers'
export const DEFAULT_COVER_SIZE = '768x1024'
const command = <T>(op: string, args: Record<string, unknown> = {}) =>
  trackStorageWrite(() => piCommand<T>('cover_task', { op, ...args }))
const asList = (value: unknown) => (Array.isArray(value) ? (value as CoverTask[]) : [])
const running = new Map<string, { startedAt: number; promise: Promise<void> }>()
function update(task: CoverTask) {
  coverTasks.value = [task, ...coverTasks.value.filter(t => t.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt)
  return task
}
export async function loadCoverTasks() {
  coverTasks.value = asList(await command<CoverTask[]>('list'))
  return coverTasks.value
}
export async function initializeCoverTasks() {
  coverTasks.value = asList(await command<CoverTask[]>('recover'))
}
export const hasRunningCovers = () => running.size > 0
export async function startCover(
  brief: CoverBrief,
  book: { id: string; title: string },
  model: { code: string; name: string },
  owner: { sessionId: string; callId?: string; anchor?: number; autoContinue?: boolean },
  id: string = crypto.randomUUID()
) {
  const task = update(
    await command<CoverTask>('create', {
      id,
      brief,
      bookId: book.id,
      bookTitle: book.title,
      modelCode: model.code,
      modelName: model.name,
      autoContinue: owner.autoContinue !== false,
      ...owner
    })
  )
  if (task.status === 'running' && !running.has(task.id)) {
    const promise = generate(task).finally(() => running.delete(task.id))
    running.set(task.id, { startedAt: Date.now(), promise })
    void promise.catch(() => {})
  }
  return task
}
async function generate(task: CoverTask) {
  try {
    const { data } = await generateLocalAiImage({
      scene: 'cover',
      bookId: Number(task.bookId) || undefined,
      title: task.bookTitle || '封面',
      prompt: composeCoverPrompt(task.prompt, task.style),
      negativePrompt: task.negativePrompt || NEGATIVE_PROMPT,
      style: task.style || undefined,
      size: task.size || DEFAULT_COVER_SIZE,
      model: task.modelCode || undefined
    })
    if (!data?.imageUrl) throw new Error('图片模型没有返回图片')
    update(await command<CoverTask>('complete', { id: task.id, imageId: data.id, imageUrl: data.imageUrl, modelName: data.modelName }))
    announceTaskFinished('cover', task.id)
  } catch (error) {
    const current = await command<CoverTask>('get', { id: task.id })
    update(current)
    if (current.status !== 'running') return
    update(await command<CoverTask>('fail', { id: task.id, error: error instanceof Error ? error.message : String(error) }))
    announceTaskFinished('cover', task.id)
  }
}
export async function controlCover(id: string, action: 'pause' | 'resume' | 'cancel') {
  if (action !== 'cancel') throw new Error('封面生成不能暂停，只能取消')
  return update(await command<CoverTask>('cancel', { id }))
}
/** 采用：裁成封面比例写进作品，再记下采用时间。 */
export async function applyCover(id: string) {
  const task = coverTasks.value.find(t => t.id === id)
  if (!task || task.status !== 'completed') throw new Error('图还没生成好')
  const coverUrl = await composeCoverDataUrl(task.imageUrl)
  const { updateLocalBookData } = await import('@/storage/local-book-bridge')
  await updateLocalBookData({ id: Number(task.bookId), coverUrl })
  return update(await command<CoverTask>('apply', { id }))
}
export const setCoverAutoContinue = async (id: string, autoContinue: boolean) =>
  update(await command<CoverTask>('continue_state', { id, autoContinue }))
export const markCoverContinued = async (id: string) =>
  update(await command<CoverTask>('continue_state', { id, continuedAt: Date.now(), continueSkipped: null }))
export const markCoverContinueSkipped = async (id: string, reason: string) =>
  update(await command<CoverTask>('continue_state', { id, continueSkipped: reason }))
export const coverEventMessage = (task: CoverTask) =>
  platformEventMessage(
    `《${task.bookTitle}》的封面已经生成，作者可以在右侧预览，点"采用为封面"才会写进作品。请用一句话说明画面是什么，并告诉作者想换风格或构图直接说就行；不要再生成新图。`,
    { kind: 'cover_completed', taskId: task.id, title: task.bookTitle, scope: '封面' }
  )
function viewOf(task: CoverTask, now: number): PiTaskView {
  const live = running.get(task.id)
  const active = task.status === 'running'
  const elapsed = live ? now - live.startedAt : 0
  const finished = task.status !== 'running'
  return {
    kind: 'cover',
    id: task.id,
    sessionId: task.sessionId,
    callId: task.callId,
    anchor: task.anchor,
    createdAt: task.createdAt,
    title: task.bookTitle,
    scope: '封面',
    status: task.status,
    statusLabel: { running: '正在生成', failed: '未完成', cancelled: '已取消', completed: task.appliedAt ? '已采用' : '已生成' }[task.status],
    active,
    percent: task.status === 'completed' ? 100 : active ? Math.min(90, Math.round(elapsed / 600)) : 0,
    numbers: [task.summary || task.prompt.slice(0, 40), `模型 ${task.modelName || task.modelCode}`, ...(active && elapsed > 0 ? [`已用 ${formatDuration(elapsed)}`] : [])],
    current: active ? '正在生成封面图，通常需要半分钟到一分钟…' : '',
    hint:
      task.status === 'cancelled'
        ? '已取消。'
        : task.status === 'completed' && task.continueSkipped && !task.continuedAt
          ? `封面已生成，没有自动接着说：${task.continueSkipped}。`
          : '',
    error: task.error,
    summaryTitle: '结果',
    summary: task.status === 'completed' ? [task.appliedAt ? '已采用为作品封面。' : '封面已生成，在右侧预览；满意就采用，想换就在对话里说。'] : [],
    autoContinue: task.autoContinue !== false,
    continuedAt: task.continuedAt,
    continueSkipped: task.continueSkipped,
    actions: {
      pause: false,
      resume: false,
      retry: false,
      cancel: !finished,
      autoContinue: !finished,
      continueNow: task.status === 'completed' && !!task.continueSkipped && !task.continuedAt
    },
    cancelTitle: '取消生成',
    cancelText: '取消这次封面生成；已经发给图片模型的请求不会退费。',
    result: task.status === 'completed' ? { kind: 'cover', id: task.id, label: task.appliedAt ? '查看封面' : '预览并采用' } : null
  }
}
export const coverTaskViews = computed(() => coverTasks.value.map(task => viewOf(task, taskClock.value)))
registerTaskProvider({
  kind: 'cover',
  views: () => coverTaskViews.value,
  control: controlCover,
  setAutoContinue: setCoverAutoContinue,
  markContinued: markCoverContinued,
  markContinueSkipped: markCoverContinueSkipped,
  eventMessage: view => {
    const task = coverTasks.value.find(t => t.id === view.id)
    return task ? coverEventMessage(task) : null
  },
  initialize: initializeCoverTasks,
  stopAll: async () => {
    await Promise.allSettled([...running.values()].map(item => item.promise))
  },
  hasRunning: hasRunningCovers
})
