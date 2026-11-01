import type { SpeechProfile } from '@/types/speech'
import { resolveSpeechFetch } from './transport'
import { speechEndpoint } from '@/config/speech'
import { createAbortError, isAbortError } from '../engine/types'
import { decodeBase64, encodeBase64, tencentSpeechHeaders, xfyunSpeechUrl } from './signing'

export const speechJsonObject = (raw: string, label: string): Record<string, unknown> => {
  if (!raw.trim()) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(`${label}必须是 JSON 对象`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`)
  return parsed as Record<string, unknown>
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const customHeaders = (profile: SpeechProfile) => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(speechJsonObject(profile.headers, '请求头'))) {
    if (typeof value !== 'string') throw new Error('请求头的值必须为字符串')
    if (/^(host|content-type|content-length|x-tc-action|x-tc-version|x-tc-timestamp)$/i.test(key) || (/^authorization$/i.test(key) && (profile.provider !== 'openai' || profile.apiKey.trim()))) throw new Error(`请求头 ${key} 由服务鉴权自动生成，请在对应配置项中填写`)
    out[key] = value
  }
  try { new Headers(out) } catch { throw new Error('附加请求头格式不正确，请检查名称与换行符') }
  return out
}

export const validateSpeechProfile = (profile: SpeechProfile) => {
  if (!profile.enabled) throw new Error('该语音服务已停用，请选择其他配置')
  if (!profile.voice.trim()) throw new Error('请填写音色 ID')
  if (profile.provider === 'tencent') {
    if (!profile.secretId.trim() || !profile.secretKey.trim()) throw new Error('请填写腾讯云 SecretId 和 SecretKey')
    if (!/^\d+$/.test(profile.voice)) throw new Error('腾讯云音色 ID 必须为数字')
  } else if (profile.provider === 'xfyun') {
    if (!profile.appId.trim() || !profile.apiKey.trim() || !profile.secretKey.trim()) throw new Error('请填写讯飞 APPID、APIKey 和 APISecret')
  } else {
    if (!profile.model.trim()) throw new Error('请填写语音模型名称')
    let url: URL
    try { url = new URL(speechEndpoint(profile)) } catch { throw new Error('请填写有效的语音服务地址') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('语音服务地址须使用 HTTP 或 HTTPS，且不能包含账号密码')
    if (profile.provider === 'aliyun' && !profile.apiKey.trim()) throw new Error('请填写阿里云百炼 API Key')
  }
  speechJsonObject(profile.extraParams, '附加参数')
  customHeaders(profile)
  if (profile.provider === 'xfyun' && Object.keys(speechJsonObject(profile.headers, '请求头')).length) throw new Error('讯飞 WebSocket 使用签名鉴权，不支持附加 HTTP 请求头')
  let endpoint: URL
  try { endpoint = new URL(speechEndpoint(profile)) } catch { throw new Error('请填写有效的完整接口地址') }
  const protocols = profile.provider === 'xfyun' ? ['wss:'] : ['http:', 'https:']
  if (!protocols.includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('接口地址格式不正确；讯飞流式服务须使用 WSS')
  if (profile.provider === 'tencent' && endpoint.search) throw new Error('腾讯云签名接口地址不能包含查询参数，请改用附加请求头')
  if (profile.signingHost && !/^[a-z0-9.:-]+$/i.test(profile.signingHost)) throw new Error('签名域名格式不正确')
  if (!Number.isFinite(profile.timeoutMs) || profile.timeoutMs < 5000 || profile.timeoutMs > 300000) throw new Error('超时须设置为 5 至 300 秒')

}

const checkedBlob = async (response: Response) => {
  if (!response.ok) throw new Error(`语音服务请求失败（HTTP ${response.status}），请检查密钥、音色授权与服务额度`)
  const contentType = response.headers.get('content-type') || ''
  if (/json|text\//i.test(contentType)) throw new Error('语音服务没有返回音频，请检查接口与音色配置')
  const buffer = await response.arrayBuffer()
  if (!buffer.byteLength) throw new Error('语音服务返回了空音频')
  return new Blob([buffer], { type: contentType || 'audio/mpeg' })
}

interface SpeechResponse {
  code?: string
  output?: { audio?: { url?: string } }
  Response?: { Audio?: string; Error?: { Code?: string } }
}
const jsonResponse = async (response: Response): Promise<SpeechResponse> => {
  if (!response.ok) throw new Error(`语音服务请求失败（HTTP ${response.status}），请检查密钥、地域与服务额度`)
  return response.json()
}

const base64Audio = (data: string, format: 'mp3' | 'wav') => {
  if (!data) throw new Error('语音服务返回了空音频')
  return new Blob([decodeBase64(data)], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' })
}

const synthesizeXfyun = async (profile: SpeechProfile, text: string, signal: AbortSignal) => {
  const url = await xfyunSpeechUrl(profile.apiKey, profile.secretKey, Date.now(), speechEndpoint(profile))
  if (signal.aborted) throw createAbortError()
  return new Promise<Blob>((resolve, reject) => {
    const socket = new WebSocket(url)
    const chunks: Uint8Array[] = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null
      try { socket.close(1000) } catch { /* 已关闭 */ }
      if (error) reject(error)
      else if (!chunks.some(chunk => chunk.length)) reject(new Error('讯飞没有返回音频'))
      else resolve(new Blob(chunks, { type: 'audio/mpeg' }))
    }
    const onAbort = () => finish(createAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    socket.onopen = () => {
      if (signal.aborted) return onAbort()
      socket.send(JSON.stringify({
        common: { app_id: profile.appId },
        business: { ...speechJsonObject(profile.extraParams, '附加参数'), aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: profile.voice, speed: 50, pitch: 50, volume: 50, tte: 'UTF8' },
        data: { status: 2, text: encodeBase64(new TextEncoder().encode(text)) },
      }))
    }
    socket.onmessage = event => {
      try {
        const frame = JSON.parse(String(event.data))
        if (Number(frame.code) !== 0) return finish(new Error(`讯飞语音合成失败（${Number(frame.code)}），请检查应用、音色授权与额度`))
        if (frame.data?.audio) chunks.push(decodeBase64(frame.data.audio))
        if (frame.data?.status === 2) finish()
      } catch { finish(new Error('讯飞返回的音频数据无法解析')) }
    }
    socket.onerror = () => finish(new Error('讯飞连接失败，请检查网络、应用密钥与电脑时间'))
    socket.onclose = () => finish(new Error('讯飞连接提前结束，请重试'))
  })
}

/** 各厂商按原生协议合成正常语速音频，播放端统一调速，避免协议间语速含义不一致。 */
export const synthesizeSpeech = async (profile: SpeechProfile, text: string, signal?: AbortSignal): Promise<Blob> => {
  validateSpeechProfile(profile)
  if (!text.trim()) throw new Error('没有可朗读的文本')
  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, profile.timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (controller.signal.aborted) throw createAbortError()
    if (profile.provider === 'xfyun') return await synthesizeXfyun(profile, text, controller.signal)
    const fetcher = await resolveSpeechFetch()
    const extra = speechJsonObject(profile.extraParams, '附加参数')
    const endpoint = speechEndpoint(profile)
    if (controller.signal.aborted) throw createAbortError()
    if (profile.provider === 'tencent') {
      const body = JSON.stringify({ ModelType: 1, PrimaryLanguage: 1, SampleRate: 16000, ...extra, Text: text, SessionId: (crypto.randomUUID?.() || `speech-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(2))).join('-')}`), VoiceType: Number(profile.voice), Codec: profile.format, Speed: 0 })
      const headers = { ...customHeaders(profile), ...await tencentSpeechHeaders(body, profile.secretId, profile.secretKey, Date.now(), endpoint, profile.signingHost) }
      const result = await jsonResponse(await fetcher(endpoint, { method: 'POST', headers, body, signal: controller.signal }))
      if (result.Response?.Error) throw new Error(`腾讯云语音合成失败（${String(result.Response.Error.Code).replace(/[^\w.]/g, '')}），请检查密钥、音色授权与额度`)
      return base64Audio(String(result.Response?.Audio || ''), profile.format)
    }
    const headers: Record<string, string> = { ...customHeaders(profile), 'Content-Type': 'application/json' }
    if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`
    if (profile.provider === 'aliyun') {
      const result = await jsonResponse(await fetcher(endpoint, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ ...extra, model: profile.model, input: { language_type: 'Chinese', ...object(extra.input), text, voice: profile.voice } }) }))
      if (result.code) throw new Error(`阿里云语音合成失败（${String(result.code).replace(/[^\w.]/g, '')}），请检查地域、密钥和模型权限`)
      if (!result.output?.audio?.url) throw new Error('阿里云没有返回音频，请检查语音模型和音色配置')
      const audioUrl = new URL(result.output.audio.url)
      if (audioUrl.protocol !== 'https:') throw new Error('阿里云返回了无效的音频地址')
      // 音频下载不携带 API Key；短期文件地址仅在内存中使用。
      return await checkedBlob(await fetcher(audioUrl.href, { signal: controller.signal }))
    }
    return await checkedBlob(await fetcher(endpoint, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ ...extra, model: profile.model, input: text, voice: profile.voice, response_format: profile.format, speed: 1 }),
    }))
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error) || /request cancel+ed/i.test(String(error))) {
      if (timedOut) throw new Error('语音合成超时，请检查网络或稍后重试')
      throw createAbortError()
    }
    // 不把底层 fetch/WebSocket 错误的地址、签名或服务端原文写入诊断日志。
    if (error instanceof TypeError) throw new Error('语音服务连接失败，请检查网络和服务地址；浏览器模式可能受跨域限制')
    let message = error instanceof Error ? error.message : '语音服务请求失败'
    for (const value of [profile.apiKey, profile.secretId, profile.secretKey, ...Object.values(customHeaders(profile))]) {
      if (value) message = message.split(value).join('[已隐藏]')
    }
    throw new Error(message.replace(/(?:https?|wss?):\/\/\S+/g, '[服务地址]').slice(0, 200))
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}
