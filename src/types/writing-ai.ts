/** 划词改写的待确认结果；原始切片保留段落与文字格式，供“废弃”原样恢复。 */
export interface AiRewriteResult {
  original: string
  originalSlice: unknown
  from: number
  to: number
}
