import type { AiThinkingMode } from '@/types/user-ai-model'
import type { LocalChatMessageInput, LocalChatToolChoice, LocalChatToolDef } from './local-ai-client'
import { isTauriRuntime } from '@/storage'

export type FetchLike = (input: string, init?: RequestInit & { connectTimeout?: number }) => Promise<Response>

export const resolveAiFetch = async (): Promise<FetchLike> => {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    // 插件会给每个请求自动补 Origin 头（Windows 是 http://tauri.localhost），
    // Ollama 等本地服务会按来源拒绝（403）。传空串 = 让插件摘掉这个头，
    // 桌面端请求从此与 curl 一样不带来源。需 Cargo 给插件开 unsafe-headers 特性。
    return (input, init) =>
      tauriFetch(input, {
        ...init,
        headers: { Origin: '', ...(init?.headers as Record<string, string> | undefined) }
      })
  }
  return window.fetch.bind(window)
}

/** 供应商代码来自模型管理的预设；自定义/未知时按地址猜官方渠道，老配置也能命中翻译表 */
const inferProvider = (provider: string | undefined, baseUrl: string): string => {
  const code = String(provider || '').trim()
  if (code && code !== 'custom') return code
  const url = String(baseUrl || '')
  if (url.includes('api.deepseek.com')) return 'deepseek'
  if (url.includes('aliyuncs.com')) return 'aliyun'
  if (url.includes('siliconflow')) return 'siliconflow'
  if (url.includes('bigmodel.cn')) return 'bigmodel'
  if (url.includes('volces.com')) return 'volcengine'
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('googleapis.com')) return 'gemini_openai'
  return code
}

/**
 * 思考开关翻译表：模型管理里"思考模式"选关闭/开启时，按供应商发它自己的参数。
 * 行业没有统一字段，各家不同（Cherry Studio、LiteLLM 等也都维护这么一张表）：
 * - DeepSeek / 智谱 / 火山方舟：thinking.type
 * - 千问百炼 / 硅基流动：enable_thinking
 * - OpenRouter：reasoning.enabled
 * - Gemini 兼容 / Ollama 兼容：reasoning_effort=none 只能关，开启走各自默认
 * 表里没有的供应商（OpenAI、xAI、MiniMax、Claude、自定义）不下发任何字段，用户在"额外请求参数"里自填。
 * 思考型模型的思考 token 多半计入 max_tokens（真 Key 实测 DeepSeek v4-pro 建书大纲思考吃掉 6092），
 * 所以"开启"必须配合模型配置里足够大的最大输出 Tokens。
 */
type ThinkingParamBuilder = (on: boolean) => Record<string, unknown> | null
const THINKING_PARAMS: Record<string, ThinkingParamBuilder | undefined> = {
  deepseek: on => ({ thinking: { type: on ? 'enabled' : 'disabled' } }),
  bigmodel: on => ({ thinking: { type: on ? 'enabled' : 'disabled' } }),
  volcengine: on => ({ thinking: { type: on ? 'enabled' : 'disabled' } }),
  aliyun: on => ({ enable_thinking: on }),
  siliconflow: on => ({ enable_thinking: on }),
  openrouter: on => ({ reasoning: { enabled: on } }),
  gemini_openai: on => (on ? null : { reasoning_effort: 'none' }),
  local: on => (on ? null : { reasoning_effort: 'none' })
}

/**
 * 各家对 tool_choice 的限制：DeepSeek 开启思考时只认 auto / none，
 * 传 required 服务端直接 400「Thinking mode does not support this tool_choice」。
 * 这是官方限制，这里按供应商降级成 auto，不白打一次失败请求；首轮必须查的约束由提示词与回复核对兜底。
 */
const FORCED_TOOL_CHOICE_UNSUPPORTED: Record<string, ((thinkingOn: boolean) => boolean) | undefined> = {
  deepseek: thinkingOn => thinkingOn
}

/** 按供应商与思考开关决定实际下发的 tool_choice */
export const resolveToolChoice = (
  provider: string,
  thinking: AiThinkingMode | undefined,
  toolChoice: LocalChatToolChoice | undefined
): LocalChatToolChoice | undefined => {
  if (toolChoice !== 'required') return toolChoice
  const unsupported = FORCED_TOOL_CHOICE_UNSUPPORTED[provider]
  return unsupported?.(thinking === 'on') ? 'auto' : toolChoice
}

/** 模型的"额外请求参数"是 JSON 对象文本；坏 JSON 在界面保存时就拦下，这里只做兜底 */
export const parseExtraParams = (text: string | undefined): Record<string, unknown> | undefined => {
  const raw = String(text || '').trim()
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// OpenAI 官方接口的两个换代差异（其余兼容渠道仍认老字段）：
// token 上限字段改名 max_completion_tokens；推理系（o*/gpt-5*）只认默认温度
const isOpenAiOfficial = (baseUrl: string) => String(baseUrl || '').includes('api.openai.com')
const isOpenAiReasoningModel = (modelCode: string) => /^(o\d|gpt-5)/i.test(String(modelCode || '').trim())

// 非流式最少给足 2048 token 上限：思考型模型（Gemini flash、DeepSeek flash 等）把
// 思考计入输出上限，预算太小会被思考吃光，拿回空正文或半截 JSON（实测 1024 仍不够）；
// 上限只是护栏，普通模型不会因此多产出
const NON_STREAM_MIN_TOKENS = 2048

/** 内部消息 → OpenAI 兼容线上形状：工具调用与工具结果按 tool_calls / tool_call_id 下发 */
const toWireMessage = (message: LocalChatMessageInput): Record<string, unknown> => {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }))
    }
  }
  return { role: message.role, content: message.content }
}

/** 按供应商差异拼 chat/completions 请求体：各家怪癖集中在这一处 */
export const buildChatBody = (params: {
  baseUrl: string
  modelCode: string
  messages: LocalChatMessageInput[]
  maxTokens?: number
  temperature?: number
  stream: boolean
  /** 测试请求独立设置预算；普通非流式写作保留原有下限。 */
  minimumOutputTokens?: number
  /** 模型管理里的供应商代码；缺省按地址猜 */
  provider?: string
  /** 模型管理里的思考模式；缺省=跟随模型默认，不下发任何字段 */
  thinking?: AiThinkingMode
  /** 用户自填的额外请求参数，最后合并，可覆盖上面任何字段 */
  extraBody?: Record<string, unknown>
  /** 暴露给模型的工具；空则不下发 tools 字段 */
  tools?: LocalChatToolDef[]
  toolChoice?: LocalChatToolChoice
}): Record<string, unknown> => {
  const provider = inferProvider(params.provider, params.baseUrl)
  const body: Record<string, unknown> = {
    model: params.modelCode,
    messages: params.messages.map(toWireMessage),
    stream: params.stream
  }
  if (params.tools?.length) {
    body.tools = params.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))
    const toolChoice = resolveToolChoice(provider, params.thinking, params.toolChoice)
    if (toolChoice) body.tool_choice = toolChoice
  }
  const maxTokens = params.stream
    ? params.maxTokens
    : params.maxTokens
      ? Math.max(params.maxTokens, params.minimumOutputTokens ?? NON_STREAM_MIN_TOKENS)
      : undefined
  if (maxTokens) {
    body[isOpenAiOfficial(params.baseUrl) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
  }
  const dropTemperature = isOpenAiOfficial(params.baseUrl) && isOpenAiReasoningModel(params.modelCode)
  if (params.temperature !== undefined && !dropTemperature) {
    body.temperature = params.temperature
  }
  if (params.thinking === 'off' || params.thinking === 'on') {
    const build = THINKING_PARAMS[provider]
    Object.assign(body, build?.(params.thinking === 'on') || {})
  }
  // 千问百炼：思考型模型走非流式必须 enable_thinking=false，否则服务端直接 400。
  // 这是官方限制，与用户选择无关；开启思考只在流式生效
  if (!params.stream && provider === 'aliyun') {
    body.enable_thinking = false
  }
  if (params.extraBody) Object.assign(body, params.extraBody)
  return body
}

/** 本地部署（Ollama/LM Studio 等）通常没有 API Key：留空则不带鉴权头 */
export const buildAuthHeaders = (apiKey: string | undefined, withJson = true): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (withJson) headers['Content-Type'] = 'application/json'
  const key = String(apiKey || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

/** baseUrl 与端点拼接：只负责去重斜杠，版本段（/v1 等）以用户填写为准 */
export const joinAiUrl = (baseUrl: string, path: string) =>
  `${String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`

export const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) return error.name === 'AbortError'
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /request cancel+ed/i.test(text)
}

export const readableHttpError = async (response: Response): Promise<string> => {
  let detail = ''
  try {
    const body = await response.json()
    detail = String(body?.error?.message || body?.message || '')
  } catch {
    // 响应体不是 JSON 时只按状态码给文案
  }
  const byStatus: Record<number, string> = {
    401: 'API Key 无效或未授权',
    402: '账户余额不足，请到供应商后台充值',
    403: '没有访问权限：云端服务请检查 Key 的可用范围，本地服务请检查它的来源或 IP 访问限制',
    404: '接口路径或模型不存在（检查 BaseURL 与模型名）',
    429: '触发限流或额度不足'
  }
  const base = byStatus[response.status] || `请求失败（HTTP ${response.status}）`
  return detail ? `${base}：${detail.slice(0, 200)}` : base
}
