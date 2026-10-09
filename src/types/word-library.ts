export interface CommonWord {
  id: number
  text: string
}

/** 展示条目由自定义词、角色称呼和设定名称合并得到，不另存副本。 */
export interface WordLibraryEntry {
  text: string
  sources: string[]
  customId?: number
}
