export type WordCountMode = 'all' | 'text'

export type MenuId =
  | 'home'
  | 'books'
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
  hiddenMenus: MenuId[]
  wordCountMode: WordCountMode
}

/** 含标点数保留原字段；缺失的不含标点数使用 null，不能当作 0。 */
export interface TextCounts {
  wordCount: number
  textWordCount: number | null
}
