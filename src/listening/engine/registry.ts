import type { ListeningSettings } from '@/types/listening'
import { CloudSpeechEngine } from './cloud-speech'
import { getSpeechProfile } from '@/storage/speech-profiles'
import { SystemSpeechEngine } from './system-speech'
import type { TtsEngine } from './types'

export const createTtsEngine = (settings: ListeningSettings): TtsEngine => {
  if (settings.engine === 'cloud') {
    const profile = getSpeechProfile(settings.cloudProfileId)
    if (!profile) throw new Error('尚未配置云端语音服务，请在「听书与朗读」中填写并保存')
    return new CloudSpeechEngine({ profile, cacheEnabled: settings.cacheEnabled })
  }
  return new SystemSpeechEngine()
}

export const engineSettingsKey = (settings: ListeningSettings) => {
  // 系统朗读不关心云端模型/音色/缓存，避免在设置页同步默认模型时误重启当前朗读
  if (settings.engine !== 'cloud') return 'system'
  return [
    'cloud',
    settings.cloudProfileId,
    settings.cloudConfigVersion,
    settings.cacheEnabled ? 'cache' : 'nocache',
  ].join('|')
}
