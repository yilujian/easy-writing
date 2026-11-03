/** 思考模式：off=关闭 / default=跟随模型默认 / on=开启；请求层按供应商翻译成各家参数 */
export type AiThinkingMode = 'off' | 'default' | 'on'

/** 模型用途：text=对话/生成，image=生图。 */
export type UserAiModelScene = 'text' | 'image'

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
  /** 仅影响连接测试；缺省按云端 2 分钟、本地 5 分钟处理。 */
  testWaitSeconds?: import('./model-test').ModelTestWaitSeconds
}

export interface UserAiModelTestResult {
  ok: boolean
  message: string
  latency: number
  url: string
  testedAt: string
  outcome?: import('./model-test').ModelTestOutcome
  reply?: string
  inputTokens?: number
  outputTokens?: number
}

export interface UserAiRemoteModelListResult {
  models: string[]
  total: number
  url: string
  latency: number
  testedAt: string
}
