import type { BreakdownChapterDetail } from './breakdown'
import type { JsonRecord } from './json'
export type ChapterAnalysis = BreakdownChapterDetail['analysis']
export interface BreakdownFinding {
  fact: string
  interpretation: string
  technique: string
  quote: string
  startPara: number
  endPara: number
}
export interface BreakdownTarget {
  id: number
  title: string
  sortNo: number
  wordCount: number
  chars: number
  sourceRevision: string
  reusable: boolean
  done?: boolean
  offset?: number
  partsDone?: number
}
export interface BreakdownPlan {
  projectId: number
  title: string
  chapters: BreakdownTarget[]
  scope: string
  wholeBook: boolean
  reanalyze: boolean
  estimatedTokens: number
  estimatedMinutes: number[]
}
export interface BreakdownTask extends BreakdownPlan {
  id: string
  sessionId: string
  callId?: string
  anchor?: number
  modelCode: string
  createdAt: number
  updatedAt: number
  status: 'running' | 'pausing' | 'paused' | 'failed' | 'cancelled' | 'completed'
  phase: 'chapters' | 'report'
  runToken: string | null
  report: JsonRecord | null
  reportSteps: Record<string, JsonRecord>
  error?: string
  /** 拆完后自动让 Agent 接着说结论；continuedAt 已发起，continueSkipped 没发起的原因。 */
  autoContinue?: boolean
  continuedAt?: number | null
  continueSkipped?: string | null
}
export interface BreakdownPart {
  start: number
  end: number
  firstPara: number
  lastPara: number
  analysis: ChapterAnalysis
}
