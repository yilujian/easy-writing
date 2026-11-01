/** 未经完整性校验的输出只作为恢复草稿，不能直接成为正式大纲或正文。 */
export interface WorkflowAiDraft {
  id: number
  runId: number
  taskId?: number
  key: string
  scene: string
  label: string
  modelName: string
  /** 原始消息用于确认重试仍是同一个任务；不含 Key 或鉴权头。 */
  request: string
  content: string
  /** 不支持流式的接口中断时保留原始响应，不能冒充可采用的正文。 */
  rawResponse?: string
  status: 'running' | 'ready' | 'failed' | 'canceled' | 'applied'
  phase: 'waiting' | 'thinking' | 'receiving' | 'saved'
  startedAt: number
  updatedAt: number
  complete: boolean
  error?: string
  errorCode?: string
  resumedFrom?: number
  persistenceError?: string
}
