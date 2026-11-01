import type { SpeechProfile, SpeechProvider } from '@/types/speech'

export const SPEECH_PROFILES_KEY = 'ew-speech-profiles'
export const SPEECH_PROVIDERS: Array<{ id: SpeechProvider; label: string; hint: string; docs: string }> = [
  { id: 'tencent', label: '腾讯云', hint: '使用腾讯云语音合成的 SecretId、SecretKey 和音色 ID。', docs: 'https://cloud.tencent.com/document/api/1073/37995' },
  { id: 'aliyun', label: '阿里云百炼', hint: '使用百炼 API Key 和 Qwen-TTS 模型；密钥地域须与服务地域一致。', docs: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api' },
  { id: 'xfyun', label: '科大讯飞', hint: '使用「在线语音合成」服务的 APPID、APIKey、APISecret。', docs: 'https://www.xfyun.cn/doc/tts/online_tts/API.html' },
  { id: 'openai', label: 'OpenAI 兼容服务', hint: '用于支持 /audio/speech 的云端或本地语音服务。', docs: '' },
]

export const defaultSpeechProfile = (provider: SpeechProvider): SpeechProfile => ({
  id: `speech-${provider}`,
  name: SPEECH_PROVIDERS.find(item => item.id === provider)!.label,
  provider,
  apiKey: '', secretId: '', secretKey: '', appId: '',
  baseUrl: provider === 'aliyun' ? 'https://dashscope.aliyuncs.com' : provider === 'openai' ? 'https://api.openai.com/v1' : '',
  model: provider === 'aliyun' ? 'qwen3-tts-flash' : provider === 'openai' ? 'tts-1' : '',
  voice: provider === 'tencent' ? '1001' : provider === 'aliyun' ? 'Cherry' : provider === 'xfyun' ? 'xiaoyan' : 'alloy',
  format: provider === 'aliyun' ? 'wav' : 'mp3',
  enabled: true,
  updatedAt: 0,
  extraParams: '',
  endpoint: '', headers: '', timeoutMs: 60000, signingHost: '',
})

export const speechEndpoint = (profile: SpeechProfile) => {
  if (profile.endpoint.trim()) return profile.endpoint.trim()
  if (profile.provider === 'tencent') return 'https://tts.tencentcloudapi.com/'
  if (profile.provider === 'xfyun') return 'wss://tts-api.xfyun.cn/v2/tts'
  const base = profile.baseUrl.trim().replace(/\/+$/, '')
  if (profile.provider === 'aliyun') return `${base}/api/v1/services/aigc/multimodal-generation/generation`
  return /\/audio\/speech$/.test(base) ? base : `${base}/audio/speech`
}

/** 只接纳明确标为普通话的语言标签；不把粤语、闽南语或所有 zh-* 音色混入。 */
export const isMandarinVoice = (lang: string) => {
  const tag = String(lang || '').replace(/_/g, '-').toLowerCase()
  return /^(zh-cn|zh-hans(?:-cn)?)(?:-|$)/.test(tag) || /^(cmn|cmn-cn|cmn-hans(?:-cn)?)(?:-|$)/.test(tag) && !/-(tw|hk|hant)(?:-|$)/.test(tag)
}
