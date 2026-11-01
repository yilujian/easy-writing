export type SpeechProvider = 'tencent' | 'aliyun' | 'xfyun' | 'openai'

/** 独立语音服务配置，仅保存在本机；不进入写作模型与默认模型分组。 */
export interface SpeechProfile {
  id: string
  name: string
  provider: SpeechProvider
  apiKey: string
  secretId: string
  secretKey: string
  appId: string
  baseUrl: string
  model: string
  voice: string
  format: 'mp3' | 'wav'
  enabled: boolean
  updatedAt: number
  /** 已有兼容渠道的附加参数，迁移时保留。 */
  extraParams: string
  /** 完整接口地址覆盖；留空使用厂商预设。 */
  endpoint: string
  headers: string
  timeoutMs: number
  /** 腾讯云代理场景可保留原始签名域名。 */
  signingHost: string
}
