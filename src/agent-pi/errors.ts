/** 服务端原文仅用于折叠诊断，不直接充当面向作者的错误提示。 */
export function piErrorDetails(raw: string): string {
  return raw
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[已隐藏]')
    .slice(0, 8000)
}
export function piErrorMessage(raw: string): string {
  if (/\b(?:524|504|408)\b|timeout|timed out|超时/i.test(raw)) return '服务响应超时，请稍后重试。'
  if (/\b429\b|rate.?limit|限流/i.test(raw)) return '服务请求较多，请稍后重试。'
  if (/\b(?:401|403)\b|invalid.?api.?key|unauthorized/i.test(raw)) return '服务访问未通过，请检查模型配置或访问权限。'
  if (/context.?length|context.?window|maximum context|上下文.*(?:超|满)/i.test(raw)) return '本次内容超过模型的上下文限制，请缩小范围或更换模型。'
  if (/\b5\d\d\b|overloaded|service unavailable/i.test(raw)) return '模型服务暂时不可用，请稍后重试或更换模型。'
  if (/fetch failed|failed to fetch|network|ECONN|ENOTFOUND|socket/i.test(raw)) return '连接模型服务失败，请检查网络或稍后重试。'
  const text = raw.replace(/^PI_(?:COMMAND|ADOPTION)_(?:REJECTED|UNKNOWN):\s*/, '').trim()
  // 平台已有的简短中文业务错误可直接解释原因；JSON、堆栈及其他服务端原文进入详情。
  if (/[\u4e00-\u9fff]/.test(text) && text.length <= 220 && !/[{}\n]/.test(text) && !/https?:\/\/|\b(?:Error|Exception):|\bat \w/i.test(text)) return piErrorDetails(text)
  return '本次请求未完成，请查看详情或稍后重试。'
}
