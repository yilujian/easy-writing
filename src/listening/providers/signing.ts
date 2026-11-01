const bytes = (value: string) => new TextEncoder().encode(value)
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
export const encodeBase64 = (value: Uint8Array) => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}
export const decodeBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const nativeDigest = async (data: Uint8Array, key?: Uint8Array): Promise<ArrayBuffer> => {
  const { isTauriRuntime } = await import('@/storage/writing-storage')
  if (!isTauriRuntime()) throw new Error('当前浏览器不支持安全签名，请使用桌面版或 HTTPS 页面')
  const { invoke } = await import('@tauri-apps/api/core')
  return new Uint8Array(await invoke<number[]>('speech_digest', { data: Array.from(data), key: key ? Array.from(key) : null })).buffer
}
const sha256 = async (value: string) => hex(crypto.subtle ? await crypto.subtle.digest('SHA-256', bytes(value)) : await nativeDigest(bytes(value)))
const hmac = async (key: string | ArrayBuffer, value: string) => {
  if (!crypto.subtle) return nativeDigest(bytes(value), typeof key === 'string' ? bytes(key) : new Uint8Array(key))
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? bytes(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', imported, bytes(value))
}

/** 腾讯云 API 3.0 TC3：时间与派生密钥全部使用 UTC。 */
export const tencentSpeechHeaders = async (body: string, secretId: string, secretKey: string, now = Date.now(), endpoint = 'https://tts.tencentcloudapi.com/', signingHost = '') => {
  const url = new URL(endpoint)
  const timestamp = Math.floor(now / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/tts/tc3_request`
  const contentType = 'application/json; charset=utf-8'
  const signedHeaders = 'content-type;host'
  const canonical = ['POST', url.pathname, '', `content-type:${contentType}\nhost:${signingHost || url.host}\n`, signedHeaders, await sha256(body)].join('\n')
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, await sha256(canonical)].join('\n')
  const dateKey = await hmac(`TC3${secretKey}`, date)
  const serviceKey = await hmac(dateKey, 'tts')
  const signingKey = await hmac(serviceKey, 'tc3_request')
  return {
    'Content-Type': contentType,
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hex(await hmac(signingKey, stringToSign))}`,
    'X-TC-Action': 'TextToVoice', 'X-TC-Version': '2019-08-23', 'X-TC-Timestamp': String(timestamp),
  }
}

/** 讯飞在线语音合成：签名只用于本次握手，调用方不得记录返回的带签名地址。 */
export const xfyunSpeechUrl = async (apiKey: string, apiSecret: string, now = Date.now(), endpoint = 'wss://tts-api.xfyun.cn/v2/tts') => {
  const url = new URL(endpoint)
  const host = url.host
  const date = new Date(now).toUTCString()
  const signature = encodeBase64(new Uint8Array(await hmac(apiSecret, `host: ${host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`)))
  const authorization = encodeBase64(bytes(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`))
  for (const [key, value] of Object.entries({ authorization, date, host })) url.searchParams.set(key, value)
  return url.href
}
