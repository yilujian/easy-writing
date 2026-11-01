import type { SpeechProfile } from '@/types/speech'

export type TtsEngineId = 'system' | 'cloud'

export interface TtsVoice {
  /** 引擎内稳定标识；系统引擎用 voiceURI */
  id: string
  name: string
  lang: string
  engine: TtsEngineId
  local: boolean
  /** 仅用于界面展示的额外说明，例如「系统」「OpenAI」 */
  providerLabel?: string
}

export interface SpeakOptions {
  text: string
  voiceId: string
  /** 系统 voiceURI 变化时按已保存名称回退。 */
  voiceName?: string
  rate: number
  pitch: number
  volume: number
  signal: AbortSignal
  /** 真正开始出声时回调（云端先进入缓冲，再切到播放态） */
  onStart?: () => void
}

export interface TtsEngine {
  readonly id: TtsEngineId
  isAvailable(): Promise<boolean>
  listVoices(): Promise<TtsVoice[]>
  /** 朗读一段；正常结束 resolve，取消/失败 reject（AbortError 单独识别） */
  speak(options: SpeakOptions): Promise<void>
  /** 可选：云端引擎在播当前句时预取下一句，系统引擎不实现 */
  prefetch?(options: SpeakOptions): Promise<void>
  /** true=原生暂停；false=调用方应在恢复时重读当前句 */
  pause(): boolean
  resume(): boolean
  /** 尝试立即调整当前语音音量；false 表示下次重读时才能应用。 */
  setVolume?(volume: number): boolean
  stop(): void
}

export interface CloudTtsConfig {
  profile: SpeechProfile
  cacheEnabled: boolean
}

export const isAbortError = (error: unknown): boolean => {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name === 'AbortError'
  return error instanceof Error && error.name === 'AbortError'
}

export const createAbortError = (message = '朗读已取消') => new DOMException(message, 'AbortError')
