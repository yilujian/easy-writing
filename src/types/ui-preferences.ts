export type WordCountMode = 'all' | 'text'

export type MenuId =
  | 'home'
  | 'books'
  | 'agentCreation'
  | 'agentPi'
  | 'workflowBook'
  | 'writeStatistics'
  | 'novelRank'
  | 'breakdown'
  | 'inspiration'
  | 'byokModels'
  | 'prompts'
  | 'feedback'
  | 'updates'

export interface UiPreferences {
  /** 界面基准字号；14 保留原有字号层级，不影响正文。 */
  uiFontSize: number
  hiddenMenus: MenuId[]
  wordCountMode: WordCountMode
  /** 进入作品时自动打开上次编辑的章节并恢复光标、滚动位置 */
  restoreWritingPosition: boolean
}

/** 含标点数保留原字段；缺失的不含标点数使用 null，不能当作 0。 */
export interface TextCounts {
  wordCount: number
  textWordCount: number | null
}
