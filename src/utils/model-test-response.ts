import type { ModelTestProgress, ModelTestResponseState } from '@/types/model-test'
import { createThinkStreamFilter, stripThinkBlocks } from './ai-think-filter'

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const text = (value: unknown) =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(p => (typeof record(p).text === 'string' ? record(p).text : '')).join('')
      : ''

/** SSE 心跳不代表模型开始输出；完整结束与有效正文分别核对。 */
export async function readModelTestResponse(
  response: Response,
  state: ModelTestResponseState,
  output: (phase: ModelTestProgress['phase']) => void,
  signal: AbortSignal
): Promise<void> {
  if (!response.body) throw new Error('接口没有返回响应内容，尚未验证模型回复')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const filter = createThinkStreamFilter()
  let format: 'sse' | 'json' | undefined = response.headers.get('content-type')?.includes('text/event-stream')
    ? 'sse'
    : undefined
  let pending = '',
    json = '',
    eventData = '',
    finish = '',
    ended = false,
    received = 0
  const consume = (data: unknown, stream: boolean) => {
    const body = record(data)
    if (body.error)
      throw new Error(`模型服务返回错误：${String(record(body.error).message || body.error).slice(0, 200)}`)
    const usage = record(body.usage)
    if (
      typeof usage.prompt_tokens === 'number' &&
      Number.isSafeInteger(usage.prompt_tokens) &&
      usage.prompt_tokens >= 0
    )
      state.inputTokens = usage.prompt_tokens
    if (
      typeof usage.completion_tokens === 'number' &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0
    )
      state.outputTokens = usage.completion_tokens
    const choice = record(Array.isArray(body.choices) ? body.choices[0] : undefined)
    const message = record(stream ? choice.delta : choice.message)
    const thinking = text(message.reasoning_content || message.reasoning || message.thinking)
    if (thinking.trim()) {
      state.thinking = true
      output('thinking')
    }
    const content = text(message.content)
    if (content.trim()) {
      const visible = stream ? filter.push(content) : stripThinkBlocks(content)
      state.reply += visible
      if (content.includes('<think>')) state.thinking = true
      output(visible.trim() ? 'receiving' : 'thinking')
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason
  }
  const parse = (payload: string) => {
    let data: unknown
    try {
      data = JSON.parse(payload)
    } catch {
      throw new Error('接口返回的内容不是有效的模型响应，请检查接口地址与协议')
    }
    consume(data, format === 'sse')
  }
  const line = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      if (eventData) {
        parse(eventData)
        eventData = ''
      }
      return
    }
    if (trimmed.startsWith(':') || !trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') {
      if (eventData) parse(eventData)
      ended = true
      return
    }
    if (!payload) return
    eventData += (eventData ? '\n' : '') + payload
    let data: unknown
    try {
      data = JSON.parse(eventData)
    } catch {
      return
    }
    consume(data, true)
    eventData = ''
  }
  const abort = () => {
    void reader.cancel().catch(() => {
      /* 请求中止后的读取清理。 */
    })
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > 1024 * 1024) throw new Error('测试响应超出预期长度，已停止读取')
      pending += decoder.decode(chunk.value, { stream: true })
      if (!format && pending.trim())
        format = /^(?:data:|:)/.test(pending.trimStart())
          ? 'sse'
          : /^[{[]/.test(pending.trimStart())
            ? 'json'
            : undefined
      if (format === 'json') {
        json += pending
        pending = ''
        continue
      }
      if (format !== 'sse') continue
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end))
        pending = pending.slice(end + 1)
      }
      if (ended) break
    }
    pending += decoder.decode()
    if (format === 'sse') {
      if (pending.trim()) line(pending)
      if (eventData) parse(eventData)
      state.reply += filter.finish()
      if (!ended && !finish) throw new Error('模型回复中途结束，尚未验证完整回复，请重试')
    } else {
      json += pending
      parse(json.trim())
    }
    if (finish === 'length') throw new Error('服务已响应，但本次测试的输出额度已用尽，完整回复尚未验证')
    if (finish && finish !== 'stop') throw new Error(`模型没有正常完成测试回复（${finish}）`)
    if (!state.reply.trim())
      throw new Error(
        state.thinking ? '模型只返回了思考内容，尚未验证正文回复' : '接口已响应，但没有返回有效的模型回复'
      )
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {
      /* 已结束或已中止的响应无需再次读取。 */
    })
    reader.releaseLock()
  }
}
