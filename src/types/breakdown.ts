import type { JsonRecord } from '@/types/json'
export interface BreakdownProjectSummary {
  id: number
  title: string
  author: string
  tags: string[]
  mood: string
  characterCount: number
  wordCount: number
  chapterCount: number
  /** Agent 章节卡覆盖，与旧版逐段分析分开统计。 */
  agentIndexedChapters?: number
  progress: number
  status: 'wait' | 'done' | 'processing' | 'failed'
  updateTime: string
  createTime: string
}

export interface BreakdownBillingConfig {
  pointRate: number
  tokenUnitChars: number
  tokenUnitSize: number
}

export interface BreakdownProjectDetail extends BreakdownProjectSummary {
  billing: BreakdownBillingConfig
  statusSummary?: {
    wait: number
    processing: number
    done: number
    failed: number
    total: number
  }
  canContinue?: boolean
  lastError?: string
  canGenerateReport?: boolean
  reportPoints?: number
  /** 全书汇总报告（AI 返回的 JSON，结构见拆书提示词），未生成为 null */
  report?: JsonRecord | null
}

export interface BreakdownChapterItem {
  id: number
  title: string
  status: 'done' | 'wait' | 'processing' | 'failed'
  wordCount: number
  sortNo: number
  errorMessage?: string
}

export interface BreakdownChapterDetail {
  id: number
  title: string
  status: 'done' | 'wait' | 'processing' | 'failed'
  wordCount: number
  paragraphs: Array<{ id: number; text: string; insightId?: number }>
  analysis: {
    findings?: import('./breakdown-task').BreakdownFinding[]
    summary?: string
    outline: Array<{ id: number; title: string; range: string; text: string; tags: Array<{ text: string; tone?: string }> }>
    rhythm: Array<{ label: string; value: string; desc: string }>
    setting: Array<{ name: string; type: string; desc: string; tags: string[] }>
    relations?: Array<{ from: string; to: string; relation: string; desc: string }>
    /** 黄金三章深拆产物（前三章才有） */
    golden?: {
      hook300: string
      characterEstablish: string
      coreDilemma: string
      anchors: Array<{ quote: string; comment: string }>
    }
  }
  errorMessage?: string
}

export interface BreakdownEstimateResult {
  chapterIds: number[]
  chapterCount: number
  words: number
  cost: number
  pointRate: number
}

export interface BreakdownContinueResult {
  projectId: number
  chapterIds: number[]
  chapterCount: number
  words: number
  cost: number
  async?: boolean
}
