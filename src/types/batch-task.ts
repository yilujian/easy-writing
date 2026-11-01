/** 批量写作：作者授权连写几章，一章一轮；每章写完停下来等作者采用，采用后才发下一章。 */
export interface BatchStep {
  index: number
  goal: string
  status: 'pending' | 'writing' | 'review' | 'done' | 'skipped'
  /** 这一步产出的候选（可能被重写成新的候选）；采用后记下创建的章节编号。 */
  draftId: string | null
  chapterId: number | null
  startedAt: number | null
  finishedAt: number | null
}
export interface BatchPlan {
  bookId: string
  bookTitle: string
  scope: string
  steps: Array<Pick<BatchStep, 'index' | 'goal'>>
  /** 历史字段名保留：实际保存本任务选择的 Skill，每章沿用；仅文风样本技能要求读取范例。 */
  styleSkill?: string
}
export interface BatchTask extends Omit<BatchPlan, 'steps'> {
  id: string
  sessionId: string
  callId?: string
  anchor?: number
  modelCode: string
  createdAt: number
  updatedAt: number
  /** running：某一章正在写或马上要发；waiting：等作者采用或等对话空出来；其余同拆书。 */
  status: 'running' | 'waiting' | 'paused' | 'failed' | 'cancelled' | 'completed'
  /** waiting 的原因：review 等采用；chat_busy 对话正忙；no_draft 这一轮没有保存候选。 */
  waitingReason: 'review' | 'chat_busy' | 'no_draft' | null
  steps: BatchStep[]
  cursor: number
  error?: string
  autoContinue?: boolean
  continuedAt?: number | null
  continueSkipped?: string | null
}
