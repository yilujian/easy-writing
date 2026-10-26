import type { ListeningSettings } from '@/types/listening'
import { OpenAiSpeechEngine } from './openai-speech'
import { SystemSpeechEngine } from './system-speech'
import type { TtsEngine } from './types'

export const createTtsEngine = (settings: ListeningSettings): TtsEngine => {
  if (settings.engine === 'openai-speech') {
    if (!settings.cloudModelCode) throw new Error('还没有选择云端朗读模型：请先到「模型管理」添加朗读模型')
    return new OpenAiSpeechEngine({
      modelCode: settings.cloudModelCode,
      voice: settings.cloudVoice,
      format: settings.cloudFormat,
      cacheEnabled: settings.cacheEnabled,
    })
  }
  return new SystemSpeechEngine()
}

export const engineSettingsKey = (settings: ListeningSettings) => {
  // 系统朗读不关心云端模型/音色/缓存，避免在设置页同步默认模型时误重启当前朗读
  if (settings.engine !== 'openai-speech') return 'system'
  return [
    'openai-speech',
    settings.cloudModelCode,
    settings.cloudVoice,
    settings.cloudFormat,
    settings.cacheEnabled ? 'cache' : 'nocache',
  ].join('|')
}
