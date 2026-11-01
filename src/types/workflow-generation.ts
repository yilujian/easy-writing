import type { JsonRecord } from './json'

export type GenerationStep = 'outline' | 'setting' | 'outline_adjust' | 'setting_adjust'
export type GenerationPath = Array<string | { id: string }>
export interface GenerationEdit {
  path: GenerationPath
  op: 'set' | 'remove' | 'order'
  value?: unknown
}
export interface GenerationUnit {
  id: string
  kind: string
  label: string
  brief: string
  path: GenerationPath
  status: 'pending' | 'complete'
}
export interface WorkflowGeneration {
  id: number
  runId: number
  taskId: number
  step: GenerationStep
  input: JsonRecord
  status: 'running' | 'incomplete' | 'complete' | 'candidate' | 'applied' | 'discarded'
  createdAt: number
  updatedAt: number
  units: GenerationUnit[]
  document: JsonRecord
  base: JsonRecord
  edits: GenerationEdit[]
  /** 原始创作要求，不包含密钥。恢复时保持这份任务清单，不重新规划已完成内容。 */
  instructions: string
  failedUnit?: string
  error?: string
}
