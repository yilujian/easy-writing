/** 封面任务：作者在对话里定好简报，确认后生成一张图，右栏预览，采用后写进作品封面。 */
export interface CoverBrief {
  prompt: string
  negativePrompt: string
  style: string
  size: string
  /** 作者看得懂的简报摘要：题材氛围、主角形象、风格。 */
  summary: string
}
export interface CoverTask extends CoverBrief {
  id: string
  sessionId: string
  callId?: string
  anchor?: number
  bookId: string
  bookTitle: string
  modelCode: string
  modelName: string
  createdAt: number
  updatedAt: number
  status: 'running' | 'failed' | 'cancelled' | 'completed'
  /** 生成好的图在画图历史里的编号和地址；采用后记时间。 */
  imageId: number | null
  imageUrl: string
  appliedAt: number | null
  error?: string
  autoContinue?: boolean
  continuedAt?: number | null
  continueSkipped?: string | null
}
