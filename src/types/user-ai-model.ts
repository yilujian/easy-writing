/** 思考模式：off=关闭 / default=跟随模型默认 / on=开启；请求层按供应商翻译成各家参数 */
export type AiThinkingMode = 'off' | 'default' | 'on'

/** 模型用途：text=对话/生成 image=生图 embedding=向量 audio=朗读（/audio/speech） */
export type UserAiModelScene = 'text' | 'image' | 'embedding' | 'audio'

export interface UserAiModelSavePayload {
  id?: number
  name: string
  scene: UserAiModelScene
  provider: string
  protocol: 'openai_compatible'
  modelCode: string
  baseUrl: string
  apiKey?: string
  maxContext: number
  maxOutputTokens: number
  status: number
  sort?: number
  thinking?: AiThinkingMode
  /** 额外请求参数（JSON 对象文本），原样合并进 chat/completions 请求体，给自定义渠道填各家思考开关等 */
  extraParams?: string
  /** 音频模型默认音色（模型管理里可改；听书设置里可临时覆盖） */
  ttsVoice?: string
  /** 音频模型返回格式 */
  ttsFormat?: 'mp3' | 'wav'
}

export interface UserAiModelTestResult {
  ok: boolean
  message: string
  latency: number
  url: string
  testedAt: string
}

export interface UserAiRemoteModelListResult {
  models: string[]
  total: number
  url: string
  latency: number
  testedAt: string
}
