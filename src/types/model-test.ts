export type ModelTestWaitSeconds = 120 | 300 | 600
export type ModelTestOutcome = 'success' | 'reachable' | 'unverified' | 'failed' | 'timeout' | 'cancelled'
export interface ModelTestProgress {
  phase: 'waiting' | 'thinking' | 'receiving'
  elapsedMs: number
}
export interface ModelTestOptions {
  signal?: AbortSignal
  onProgress?: (progress: ModelTestProgress) => void
}
export interface ModelTestResponseState {
  reply: string
  thinking: boolean
  inputTokens?: number
  outputTokens?: number
}
