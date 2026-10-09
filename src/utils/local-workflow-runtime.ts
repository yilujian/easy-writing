import type { JsonRecord } from '@/types/json'
import type { WorkflowRealtimeEvent } from '@/types/workflow'

/**
 * 本地生成任务的运行时枢纽：活任务登记表 + 事件总线。
 *
 * - 登记表：生成循环启动时登记控制句柄（暂停/取消），暂停、取消接口和
 *   "孤儿修复"（应用中途关闭后任务卡在 running）都靠它判断任务是否真的活着。
 * - 事件总线：替代服务端 SSE。生成循环发事件，写作页的 openWorkflowStream
 *   本地版按 runId 订阅——同一进程内直接派发，没有断线重连问题。
 *
 * 独立成小模块是为了斩断依赖环：存储层（local-workflow）要查活任务，
 * 引擎层（写书循环）要登记与发事件，两边都只依赖这里。
 */

export interface LiveLocalTaskHandle {
  taskId: number
  runId: number
  kind: 'book' | 'step' | 'rewrite' | 'breakdown'
  /** 请求暂停：保存断点后停下（仅逐章任务支持） */
  requestPause?: () => void
  /** 请求取消：中止在途请求，保留已生成内容 */
  requestCancel: () => void
}

const liveTasks = new Map<number, LiveLocalTaskHandle>()
export const hasLiveLocalTasks = () => liveTasks.size > 0

export const registerLiveLocalTask = (handle: LiveLocalTaskHandle) => {
  liveTasks.set(Number(handle.taskId), handle)
}

export const unregisterLiveLocalTask = (taskId: number) => {
  liveTasks.delete(Number(taskId))
}

export const getLiveLocalTask = (taskId: number) => liveTasks.get(Number(taskId)) || null

export const isLiveLocalTask = (taskId: number) => liveTasks.has(Number(taskId))

/** 当前是否有指定 run 的活任务（做书级互斥：同一 run 不允许两个生成同时跑） */
export const findLiveLocalTaskForRun = (runId: number, kinds?: Array<LiveLocalTaskHandle['kind']>) => {
  for (const handle of liveTasks.values()) {
    if (Number(handle.runId) !== Number(runId)) continue
    if (kinds && !kinds.includes(handle.kind)) continue
    return handle
  }
  return null
}

// ---------------------------------------------------------------------------
// 事件总线（本地版 SSE）
// ---------------------------------------------------------------------------

type LocalWorkflowEventHandler = (event: WorkflowRealtimeEvent) => void

const eventHandlers = new Set<{ runId: number; handler: LocalWorkflowEventHandler }>()

export const emitLocalWorkflowEvent = (event: WorkflowRealtimeEvent) => {
  for (const entry of eventHandlers) {
    if (Number(entry.runId) !== Number(event.runId)) continue
    try {
      entry.handler(event)
    } catch (error) {
      // 单个订阅方抛错不能打断生成循环，也不能影响其他订阅方
      console.error('工作流事件处理失败:', error)
    }
  }
}

/** 按 runId 订阅生成事件；返回退订函数 */
export const subscribeLocalWorkflowEvents = (
  runId: number,
  handler: LocalWorkflowEventHandler
) => {
  const entry = { runId: Number(runId), handler }
  eventHandlers.add(entry)
  return () => {
    eventHandlers.delete(entry)
  }
}

/**
 * 本地版事件流（替代 openWorkflowStream）。
 * 同进程直连：立即回报 online，永远不会进入 reconnecting。
 */
export const openLocalWorkflowStream = (
  runId: number,
  handlers: {
    onEvent: (event: WorkflowRealtimeEvent) => void
    onError?: (error: Error) => void
    onReconnect?: () => void
    onStateChange?: (state: 'online' | 'reconnecting') => void
  }
) => {
  const unsubscribe = subscribeLocalWorkflowEvents(runId, handlers.onEvent)
  handlers.onStateChange?.('online')
  return unsubscribe
}

/** 生成循环发事件的便捷封装（统一补时间戳） */
export const buildLocalWorkflowEvent = (
  type: WorkflowRealtimeEvent['type'],
  runId: number,
  taskId: number,
  payload?: JsonRecord
): WorkflowRealtimeEvent => ({
  type,
  runId: Number(runId),
  taskId: Number(taskId),
  payload: payload || {},
  at: Date.now(),
})
