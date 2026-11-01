import { beginPetActivity } from '@/desktop-pet/events'
import type {
  AiThinkingMode,
  UserAiModelSavePayload,
  UserAiModelTestResult,
  UserAiRemoteModelListResult,
} from '@/types/user-ai-model'
import { createThinkStreamFilter, stripThinkBlocks } from '@/utils/ai-think-filter'
import { getLocalAiModelSecret, localAiModelCode, type LocalAiModel } from '@/storage/local-ai-models'
import { appendLocalAiRecord, estimateTokens } from '@/storage/local-ai-records'
import { isTauriRuntime } from '@/storage'

/**
 * BYOK 直连请求层（OpenAI 兼容协议）：密钥只在本机内存/存储流转，请求直发供应商。
 *
 * - 桌面端走 @tauri-apps/plugin-http 的 fetch（不受浏览器跨域限制）。
 * - 网页端走浏览器 fetch：部分供应商允许浏览器直连，不允许的会被浏览器拦下，
 *   报错文案会提示改用桌面版。
 */

const REQUEST_TIMEOUT_MS = 20000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const resolveAiFetch = async (): Promise<FetchLike> => {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    // 插件会给每个请求自动补 Origin 头（Windows 是 http://tauri.localhost），
    // Ollama 等本地服务会按来源拒绝（403）。传空串 = 让插件摘掉这个头，
    // 桌面端请求从此与 curl 一样不带来源。需 Cargo 给插件开 unsafe-headers 特性。
    return (input, init) =>
      tauriFetch(input, {
        ...init,
        headers: { Origin: '', ...(init?.headers as Record<string, string> | undefined) },
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
  local: on => (on ? null : { reasoning_effort: 'none' }),
}

/**
 * 各家对 tool_choice 的限制：DeepSeek 开启思考时只认 auto / none，
 * 传 required 服务端直接 400「Thinking mode does not support this tool_choice」。
 * 这是官方限制，这里按供应商降级成 auto，不白打一次失败请求；首轮必须查的约束由提示词与回复核对兜底。
 */
const FORCED_TOOL_CHOICE_UNSUPPORTED: Record<string, ((thinkingOn: boolean) => boolean) | undefined> = {
  deepseek: thinkingOn => thinkingOn,
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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
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
        function: { name: call.name, arguments: call.arguments },
      })),
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
    stream: params.stream,
  }
  if (params.tools?.length) {
    body.tools = params.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    const toolChoice = resolveToolChoice(provider, params.thinking, params.toolChoice)
    if (toolChoice) body.tool_choice = toolChoice
  }
  const maxTokens = params.stream
    ? params.maxTokens
    : params.maxTokens
      ? Math.max(params.maxTokens, NON_STREAM_MIN_TOKENS)
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
const buildAuthHeaders = (apiKey: string | undefined, withJson = true): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (withJson) headers['Content-Type'] = 'application/json'
  const key = String(apiKey || '').trim()
  if (key) headers.Authorization = `Bearer ${key}`
  return headers
}

/** baseUrl 与端点拼接：只负责去重斜杠，版本段（/v1 等）以用户填写为准 */
export const joinAiUrl = (baseUrl: string, path: string) =>
  `${String(baseUrl || '').trim().replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`

/** 把测试/拉取用的载荷补齐配置：字段留空且带 id 时回查本地存储。
 *  覆盖两种调用：编辑表单（密钥留空=不修改）与列表行内测试（只传 id）。 */
const resolveRequestConfig = (payload: Partial<UserAiModelSavePayload>) => {
  let baseUrl = String(payload.baseUrl || '').trim()
  let apiKey = String(payload.apiKey || '').trim()
  let modelCode = String(payload.modelCode || '').trim()
  let provider = String(payload.provider || '').trim()
  let thinking: AiThinkingMode | undefined = payload.thinking
  let extraParams = String(payload.extraParams || '').trim()
  let scene = payload.scene
  if (payload.id != null && (!apiKey || !baseUrl || !modelCode || !scene)) {
    const stored = getLocalAiModelSecret(localAiModelCode(payload.id))
    if (stored) {
      if (!apiKey) apiKey = stored.apiKey || ''
      if (!baseUrl) baseUrl = String(stored.baseUrl || '').trim()
      if (!modelCode) modelCode = String(stored.modelCode || '').trim()
      if (!provider) provider = String(stored.provider || '').trim()
      if (!thinking) thinking = stored.thinking
      if (!extraParams) extraParams = String(stored.extraParams || '').trim()
      if (!scene) scene = stored.scene
    }
  }
  return { baseUrl, apiKey, modelCode, provider, thinking, extraParams, scene }
}

/** 中止判定：浏览器 fetch 抛 DOMException(AbortError)；tauri-plugin-http 中止时
 *  JS 侧抛 Error('Request cancelled')、Rust 侧回字符串 'Request canceled'，三种都得认，
 *  否则桌面端的超时和用户取消会被当成普通失败，界面只看到一句"请求失败" */
export const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) return error.name === 'AbortError'
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /request cancel+ed/i.test(text)
}

const readableRequestError = (error: unknown): string => {
  if (isAbortError(error)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应）`
  }
  if (error instanceof TypeError) {
    return isTauriRuntime()
      ? '网络请求失败，请检查接口地址与网络'
      : '网络请求失败：可能是接口地址不对，或该供应商不允许网页端直连（浏览器跨域限制），桌面版不受此限制'
  }
  // tauri-plugin-http 的失败是 Rust 错误序列化成的字符串（连不上、TLS、地址未放行等），原样带出来
  if (typeof error === 'string' && error.trim()) {
    const text = error.trim().slice(0, 200)
    return /not allowed on the configured scope/i.test(text)
      ? `桌面端未放行该接口地址，请检查 BaseURL（${text}）`
      : `网络请求失败：${text}`
  }
  return error instanceof Error ? error.message : '请求失败'
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
    429: '触发限流或额度不足',
  }
  const base = byStatus[response.status] || `请求失败（HTTP ${response.status}）`
  return detail ? `${base}：${detail.slice(0, 200)}` : base
}

const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    window.clearTimeout(timer)
  }
}

/** 连通测试：发一条最小 chat 请求验证 BaseURL/Key/模型名三件事 */
export const testLocalAiModel = async (
  payload: Partial<UserAiModelSavePayload>
): Promise<{ data: UserAiModelTestResult }> => {
  const { baseUrl, apiKey, modelCode, provider, thinking, extraParams, scene } = resolveRequestConfig(payload)
  const url = joinAiUrl(baseUrl, 'chat/completions')
  const startedAt = Date.now()
  const result = (ok: boolean, message: string): { data: UserAiModelTestResult } => ({
    data: { ok, message, latency: Date.now() - startedAt, url, testedAt: new Date().toISOString() },
  })
  if (!baseUrl) return result(false, '请先填写接口地址（BaseURL）')
  if (!modelCode) return result(false, '请先填写模型名称（modelCode）')
  if (scene !== undefined && scene !== 'text' && scene !== 'image') return result(false, '不支持的模型用途，请选择文字或图像生成')

  try {
    const aiFetch = await resolveAiFetch()
    const response = await withTimeout(signal =>
      aiFetch(url, {
        method: 'POST',
        signal,
        headers: buildAuthHeaders(apiKey),
        body: JSON.stringify(
          buildChatBody({
            baseUrl,
            modelCode,
            provider,
            thinking,
            extraBody: parseExtraParams(extraParams),
            messages: [{ role: 'user', content: '连通性测试，请回复"ok"' }],
            maxTokens: 16,
            stream: false,
          })
        ),
      })
    )
    if (!response.ok) return result(false, await readableHttpError(response))
    return result(true, '连接成功，模型可用')
  } catch (error) {
    return result(false, readableRequestError(error))
  }
}

export const NO_MODEL_MESSAGE = '还没有可用模型：请先到「模型管理」添加并启用一个文本模型'

/** 调用方标注的场景（进「AI 调用记录」账本）；不传按类型给通用标签 */
export interface LocalAiSceneTag {
  scene?: string
  sceneLabel?: string
}

const describeToolCalls = (calls: LocalChatToolCall[] | undefined) =>
  calls?.length ? `[工具调用] ${calls.map(call => `${call.name}(${call.arguments})`).join('；')}` : ''

const messagesToText = (messages: LocalChatMessageInput[]) =>
  messages
    .map(message => [message.content, describeToolCalls(message.toolCalls)].filter(Boolean).join('\n'))
    .join('\n')

/** 流式增量里的 tool_calls 片段按 index 聚合：id/name 首片给出，arguments 逐片拼接 */
const mergeToolCallDeltas = (parts: Map<number, LocalChatToolCall>, deltas: unknown[]) => {
  deltas.forEach((item, position) => {
    const part = (item || {}) as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const index = Number.isInteger(part.index) ? Number(part.index) : position
    const current = parts.get(index) || { id: '', name: '', arguments: '' }
    if (typeof part.id === 'string' && part.id) current.id = part.id
    const name = typeof part.function?.name === 'string' ? part.function.name : ''
    // 名字通常只在首片出现；个别渠道每片都重发完整名字，相同就不再拼接
    if (name && name !== current.name) current.name = current.name ? `${current.name}${name}` : name
    if (typeof part.function?.arguments === 'string') current.arguments += part.function.arguments
    parts.set(index, current)
  })
}

const collectToolCalls = (parts: Map<number, LocalChatToolCall>): LocalChatToolCall[] =>
  [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
    .filter(call => call.name)

/** 落账永不影响调用本身：任何记账异常只进控制台 */
const recordAiCall = (entry: {
  recordType: 'text' | 'image'
  tag: LocalAiSceneTag | undefined
  model: LocalAiModel
  status: 0 | 1
  input: string
  output: string
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  errorMsg?: string
}) => {
  void appendLocalAiRecord({
    recordType: entry.recordType,
    scene: entry.tag?.scene || (entry.recordType === 'image' ? 'image_common' : 'text_common'),
    sceneLabel: entry.tag?.sceneLabel || (entry.recordType === 'image' ? '生图' : '文本生成'),
    modelCode: localAiModelCode(entry.model.id),
    modelName: entry.model.name || entry.model.modelCode,
    status: entry.status,
    input: entry.input,
    output: entry.output,
    inputTokens: entry.inputTokens ?? estimateTokens(entry.input),
    outputTokens: entry.outputTokens ?? estimateTokens(entry.output),
    duration: Date.now() - entry.startedAt,
    errorMsg: entry.errorMsg,
  }).catch(error => console.warn('AI 调用记账失败', error))
}

// 非流式生成给足时间：润色/扩写可能一次产出几百字
const COMPLETION_TIMEOUT_MS = 90_000

/** 非流式拿到空正文时按 finish_reason 说人话：空串交给下游只会炸出 "JSON Parse error: Unexpected EOF" 这种天书 */
const describeEmptyCompletion = (finishReason: string, hasReasoning: boolean): string => {
  const byReason: Record<string, string> = {
    length: '模型把输出上限全用在思考上，没有产出正文：请换非思考模型，或在模型管理调大"最大输出 Tokens"',
    content_filter: '模型服务判定内容触发了安全过滤，没有返回正文：请调整涉及的内容后重试',
    insufficient_system_resource: '模型服务当前推理资源不足（服务端主动打断了生成），请稍后重试',
  }
  if (byReason[finishReason]) return byReason[finishReason]
  const tail = [finishReason ? `finish_reason=${finishReason}` : '', hasReasoning ? '只返回了思考内容' : '']
    .filter(Boolean)
    .join('，')
  return `模型没有返回正文${tail ? `（${tail}）` : ''}，请重试或换个模型`
}
/** 一次吐几千 token 的非流式长任务（建书大纲/设定/章纲规划）用的上限：
 *  DeepSeek 非流式写 8000 token 要两三分钟，本地小模型更慢；用户随时可取消，这只是防挂死的护栏 */
export const LONG_COMPLETION_TIMEOUT_MS = 10 * 60_000

/**
 * 非流式补全：一次性返回全文（划词润色/打字补全这类"拿到结果再落格"的场景）。
 * 失败抛出带可读文案的 Error；外部 signal 中止原样抛 AbortError 由调用方静默。
 */
export const requestLocalChatCompletion = async (options: {
  modelCode: string
  messages: LocalChatMessageInput[]
  maxTokens?: number
  /** 采样温度（0-2）：来自提示词库逐场景配置；未传用模型服务默认 */
  temperature?: number
  signal?: AbortSignal
  /** 整次请求的时间上限，不传按 90 秒；大纲这类一次吐几千 token 的非流式调用要给足 */
  timeoutMs?: number
} & LocalAiSceneTag): Promise<string> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) throw new Error(NO_MODEL_MESSAGE)
  if (!model.baseUrl || !model.modelCode) {
    throw new Error(`模型「${model.name}」配置不完整，请到模型管理检查`)
  }
  const petActivity = beginPetActivity(options.sceneLabel ? `正在${options.sceneLabel}…` : 'AI 正在处理…')
  const startedAt = Date.now()
  const recordInput = messagesToText(options.messages)
  const timeoutMs = options.timeoutMs || COMPLETION_TIMEOUT_MS

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const aiFetch = await resolveAiFetch()
    const response = await aiFetch(joinAiUrl(model.baseUrl, 'chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: buildAuthHeaders(model.apiKey),
      body: JSON.stringify(
        buildChatBody({
          baseUrl: model.baseUrl,
          modelCode: model.modelCode,
          provider: model.provider,
          thinking: model.thinking,
          extraBody: parseExtraParams(model.extraParams),
          messages: options.messages,
          // 不传按模型配置的最大输出走：上限是各家各模型自己的数，代码里不写死
          maxTokens: options.maxTokens || model.maxOutputTokens || undefined,
          temperature: options.temperature,
          stream: false,
        })
      ),
    })
    if (!response.ok) throw new Error(await readableHttpError(response))
    const body = await response.json()
    if (body?.error?.message) throw new Error(String(body.error.message))
    const choice = body?.choices?.[0]
    // 剥掉部分渠道内联进 content 的 <think> 思考段，只留真正文
    const content = stripThinkBlocks(String(choice?.message?.content || '')).trim()
    if (!content) {
      throw new Error(
        describeEmptyCompletion(String(choice?.finish_reason || ''), Boolean(String(choice?.message?.reasoning_content || '').trim()))
      )
    }
    recordAiCall({
      recordType: 'text',
      tag: options,
      model,
      status: 1,
      input: recordInput,
      output: content,
      inputTokens: Number(body?.usage?.prompt_tokens) || undefined,
      outputTokens: Number(body?.usage?.completion_tokens) || undefined,
      startedAt,
    })
    petActivity.done()
    return content
  } catch (error) {
    // 用户主动中止统一整形成 AbortError 抛出（桌面端原始值是字符串），调用方按老约定静默
    const readable = isAbortError(error)
      ? timedOut
        ? new Error(`生成超时（${timeoutMs / 1000} 秒无结果），请重试`)
        : new DOMException('The operation was aborted.', 'AbortError')
      : new Error(readableRequestError(error))
    // 用户主动中止不算失败，不落账；其余失败如实记一笔
    if (!(readable instanceof DOMException)) {
      recordAiCall({
        recordType: 'text',
        tag: options,
        model,
        status: 0,
        input: recordInput,
        output: '',
        outputTokens: 0,
        startedAt,
        errorMsg: readable.message,
      })
    }
    if (readable instanceof DOMException && readable.name === 'AbortError') petActivity.cancel()
    else petActivity.error()
    throw readable
  } finally {
    petActivity.cancel()
    window.clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}

// ---------------------------------------------------------------------------
// 流式对话（OpenAI 兼容 SSE：data: {choices:[{delta:{content}}]} … data: [DONE]）
// ---------------------------------------------------------------------------

// 首字节等待与分片间空闲上限：任一超时主动中止，避免连接挂起时界面永远"生成中"
const STREAM_CONNECT_TIMEOUT_MS = 60_000
const STREAM_IDLE_TIMEOUT_MS = 90_000

/** 模型发起的一次工具调用（OpenAI 兼容形状，arguments 为 JSON 文本） */
export interface LocalChatToolCall {
  id: string
  name: string
  arguments: string
}

/** 暴露给模型的工具定义（OpenAI function 形状，parameters 为 JSON Schema） */
export interface LocalChatToolDef {
  name: string
  description: string
  parameters: object
}

export type LocalChatToolChoice = 'auto' | 'none' | 'required'

export interface LocalChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息携带的工具调用；有它时 content 可为空 */
  toolCalls?: LocalChatToolCall[]
  /** role=tool 时对应的调用 id */
  toolCallId?: string
}

/** 流式调用的收尾信息：正文、模型发起的工具调用、结束原因（aborted/error 为本层约定） */
export interface LocalChatStreamResult {
  content: string
  toolCalls: LocalChatToolCall[]
  finishReason: string
}

export interface LocalChatStreamCallbacks {
  onDelta: (text: string) => void
  onDone: () => void
  onError: (message: string) => void
}

/**
 * 流式对话：按本地模型 code 取配置直连供应商。
 * 用户主动中止（signal）按正常收尾（onDone），超时中止报错——与旧流式层同语义。
 */
export const streamLocalChatCompletion = async (
  options: {
    requireComplete?: boolean
    maxTokens?: number
    modelCode: string
    messages: LocalChatMessageInput[]
    /** 采样温度（0-2）：来自提示词库逐场景配置；未传用模型服务默认 */
    temperature?: number
    signal?: AbortSignal
    /** 暴露给模型的工具（原生函数调用）；模型发起的调用在返回值 toolCalls 里 */
    tools?: LocalChatToolDef[]
    toolChoice?: LocalChatToolChoice
  } & LocalAiSceneTag,
  callbacks: LocalChatStreamCallbacks
): Promise<LocalChatStreamResult> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) {
    callbacks.onError(NO_MODEL_MESSAGE)
    return { content: '', toolCalls: [], finishReason: 'error' }
  }
  if (!model.baseUrl || !model.modelCode) {
    callbacks.onError(`模型「${model.name}」配置不完整，请到模型管理检查`)
    return { content: '', toolCalls: [], finishReason: 'error' }
  }
  const petActivity = beginPetActivity(options.sceneLabel ? `正在${options.sceneLabel}…` : 'AI 正在处理…')
  const startedAt = Date.now()
  const recordInput = messagesToText(options.messages)
  let inputTokens:number|undefined, outputTokens:number|undefined
  let collected = ''
  let finishReason = ''
  const toolCallParts = new Map<number, LocalChatToolCall>()
  const result = (reason: string): LocalChatStreamResult => ({
    content: collected,
    toolCalls: collectToolCalls(toolCallParts),
    finishReason: reason,
  })
  let recorded = false
  const recordStream = (status: 0 | 1, errorMsg?: string) => {
    if (status === 0) petActivity.error()
    if (recorded) return
    recorded = true
    recordAiCall({
      recordType: 'text',
      tag: options,
      model,
      status,
      input: recordInput,
      inputTokens,outputTokens,
      output: [collected, describeToolCalls(collectToolCalls(toolCallParts))].filter(Boolean).join('\n'),
      startedAt,
      errorMsg,
    })
  }

  const controller = new AbortController()
  let timedOut = false
  let idleTimer: number | null = null
  const clearIdle = () => {
    if (idleTimer) {
      window.clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdle = (ms: number) => {
    clearIdle()
    idleTimer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const aiFetch = await resolveAiFetch()
    const extraBody = { ...parseExtraParams(model.extraParams) }
    if (options.requireComplete) {
      for (const name of ['messages','model','tools','tool_choice','stream','max_tokens','max_completion_tokens']) delete extraBody[name]
      extraBody.stream_options = { include_usage: true }
    }
    armIdle(STREAM_CONNECT_TIMEOUT_MS)
    const response = await aiFetch(joinAiUrl(model.baseUrl, 'chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: buildAuthHeaders(model.apiKey),
      body: JSON.stringify(
        buildChatBody({
          baseUrl: model.baseUrl,
          modelCode: model.modelCode,
          provider: model.provider,
          thinking: model.thinking,
          extraBody,
          messages: options.messages,
          maxTokens: options.maxTokens || model.maxOutputTokens || undefined,
          temperature: options.temperature,
          stream: true,
          tools: options.tools,
          toolChoice: options.toolChoice,
        })
      ),
    })
    if (!response.ok) {
      const message = await readableHttpError(response)
      recordStream(0, message)
      callbacks.onError(message)
      return result('error')
    }
    if (!response.body) {
      petActivity.error()
      callbacks.onError('当前环境不支持流式读取')
      return result('error')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    // 渠道可能把 <think> 思考段内联进增量正文，跨分片过滤后再吐给调用方
    const thinkFilter = createThinkStreamFilter()
    let buffer = ''
    let finished = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armIdle(STREAM_IDLE_TIMEOUT_MS)
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          finished = true
          break
        }
        try {
          const chunk = JSON.parse(payload)
          if (chunk?.error?.message) {
            const message = String(chunk.error.message)
            recordStream(0, message)
            callbacks.onError(message)
            return result('error')
          }
          if(chunk.usage){inputTokens=Number(chunk.usage.prompt_tokens)||undefined;outputTokens=Number(chunk.usage.completion_tokens)||undefined}
          const choice = chunk?.choices?.[0]
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta) {
            const visible = thinkFilter.push(delta)
            if (visible) {
              collected += visible
              callbacks.onDelta(visible)
            }
          }
          if (Array.isArray(choice?.delta?.tool_calls)) mergeToolCallDeltas(toolCallParts, choice.delta.tool_calls)
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
        } catch {
          // 跨分片被截断的 JSON 行极少见（按 \n 切已规避大半），忽略无法解析的行
        }
      }
      if (finished) break
    }
    const tail = thinkFilter.finish()
    if (tail) {
      collected += tail
      callbacks.onDelta(tail)
    }
    if (options.requireComplete && finishReason !== 'stop') {
      const message=finishReason==='length'?'正文达到输出上限，未交付半稿':'供应商未确认正文完整结束，未交付候选'
      recordStream(0,message);callbacks.onError(message);return result(finishReason||'incomplete')
    }
    recordStream(1)
    petActivity.done()
    callbacks.onDone()
    return result(finishReason || (toolCallParts.size ? 'tool_calls' : 'stop'))
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) {
        petActivity.error()
        recordStream(0, 'AI 响应超时')
        callbacks.onError('AI 响应超时，请重试')
        return result('error')
      }
      petActivity.cancel()
      // 用户主动中止按正常收尾：已产出的部分如实入账
      recordStream(1)
      callbacks.onDone()
      return result('aborted')
    }
    petActivity.error()
    const message = readableRequestError(error)
    recordStream(0, message)
    callbacks.onError(message)
    return result('error')
  } finally {
    petActivity.cancel()
    clearIdle()
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}

/** 拉取供应商可用模型清单（GET {base}/models，OpenAI 兼容形状） */
export const listLocalAiRemoteModels = async (
  payload: Partial<UserAiModelSavePayload>
): Promise<{ data: UserAiRemoteModelListResult }> => {
  const { baseUrl, apiKey } = resolveRequestConfig(payload)
  const url = joinAiUrl(baseUrl, 'models')
  const startedAt = Date.now()
  if (!baseUrl) throw new Error('请先填写接口地址（BaseURL）')

  try {
    const aiFetch = await resolveAiFetch()
    const response = await withTimeout(signal =>
      aiFetch(url, {
        method: 'GET',
        signal,
        headers: buildAuthHeaders(apiKey, false),
      })
    )
    if (!response.ok) throw new Error(await readableHttpError(response))
    const body = await response.json()
    const rawList = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const models = rawList
      .map((item: { id?: unknown }) => String(item?.id || '').trim())
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b))
    return {
      data: {
        models,
        total: models.length,
        url,
        latency: Date.now() - startedAt,
        testedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    const message = readableRequestError(error)
    throw new Error(message === '请求失败' ? '拉取模型清单失败' : message)
  }
}

// ---------------------------------------------------------------------------
// 生图（OpenAI 兼容 images/generations）
// ---------------------------------------------------------------------------

// 生图是长任务：gpt-image 常规 70~120s，给足 5 分钟；超时文案单独给
const IMAGE_TIMEOUT_MS = 300_000

export interface LocalAiImageResult {
  /** 优先：图片二进制（b64 响应或 url 已成功回捞） */
  blob?: Blob
  /** 兜底：仅拿到远程地址且网页端跨域捞不回（地址可能过期，调用方如实入库） */
  remoteUrl?: string
}

const base64ToBlob = (b64: string, type = 'image/png') => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

/**
 * 按本地模型 code 直连供应商生图。请求 b64_json，供应商忽略该参数只回 url 时
 * 尝试把图捞回本地（桌面端不受跨域限制）；捞不回就退回 remoteUrl。
 */
export const generateLocalAiImageRequest = async (options: {
  modelCode: string
  prompt: string
  size?: string
  quality?: string
  signal?: AbortSignal
} & LocalAiSceneTag): Promise<LocalAiImageResult> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) throw new Error(NO_MODEL_MESSAGE)
  if (!model.baseUrl || !model.modelCode) {
    throw new Error(`模型「${model.name}」配置不完整，请到模型管理检查`)
  }
  const petActivity = beginPetActivity(options.sceneLabel ? `正在${options.sceneLabel}…` : 'AI 正在处理…')
  const startedAt = Date.now()
  const recordImage = (status: 0 | 1, errorMsg?: string) =>
    recordAiCall({
      recordType: 'image',
      tag: options,
      model,
      status,
      input: options.prompt,
      output: '',
      inputTokens: 0,
      outputTokens: 0,
      startedAt,
      errorMsg,
    })

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, IMAGE_TIMEOUT_MS)
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const aiFetch = await resolveAiFetch()
    const response = await aiFetch(joinAiUrl(model.baseUrl, 'images/generations'), {
      method: 'POST',
      signal: controller.signal,
      headers: buildAuthHeaders(model.apiKey),
      body: JSON.stringify({
        model: model.modelCode,
        prompt: options.prompt,
        n: 1,
        response_format: 'b64_json',
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
      }),
    })
    if (!response.ok) throw new Error(await readableHttpError(response))
    const body = await response.json()
    if (body?.error?.message) throw new Error(String(body.error.message))
    const item = body?.data?.[0] || {}
    const b64 = String(item.b64_json || '')
    if (b64) {
      const blob = base64ToBlob(b64)
      petActivity.done()
      recordImage(1)
      return { blob }
    }
    const url = String(item.url || '')
    if (!url) throw new Error('生图接口没有返回图片数据')
    recordImage(1)
    try {
      const imageResponse = await aiFetch(url, { method: 'GET', signal: controller.signal })
      if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`)
      const blob = await imageResponse.blob()
      petActivity.done()
      return { blob }
    } catch {
      // 网页端常见：图床跨域取不回二进制——退回远程地址，调用方如实标注可能过期
      if (options.signal?.aborted) petActivity.cancel()
      else petActivity.done()
      return { remoteUrl: url }
    }
  } catch (error) {
    const readable = isAbortError(error)
      ? timedOut
        ? new Error(`生图超时（${IMAGE_TIMEOUT_MS / 1000} 秒无结果），请重试`)
        : new DOMException('The operation was aborted.', 'AbortError')
      : new Error(readableRequestError(error))
    if (!(readable instanceof DOMException)) recordImage(0, readable.message)
    if (readable instanceof DOMException && readable.name === 'AbortError') petActivity.cancel()
    else petActivity.error()
    throw readable
  } finally {
    petActivity.cancel()
    window.clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}
