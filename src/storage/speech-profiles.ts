import { appSettings, flushAppSettings } from './app-settings'
import { defaultSpeechProfile, SPEECH_PROFILES_KEY, SPEECH_PROVIDERS } from '@/config/speech'
import type { SpeechProfile, SpeechProvider } from '@/types/speech'

interface SpeechProfilesFile { version: 1; profiles: SpeechProfile[] }
const isProvider = (value: unknown): value is SpeechProvider => SPEECH_PROVIDERS.some(item => item.id === value)

export const readSpeechProfiles = (): SpeechProfile[] => {
  const raw = appSettings.getItem(SPEECH_PROFILES_KEY)
  if (!raw) return []
  const file = JSON.parse(raw) as SpeechProfilesFile
  if (file?.version !== 1 || !Array.isArray(file.profiles)) throw new Error('语音服务配置格式不受支持，未覆盖原配置')
  return file.profiles.filter(profile => profile && isProvider(profile.provider) && typeof profile.id === 'string')
    .map(profile => ({ ...defaultSpeechProfile(profile.provider), ...profile }))
}

export const getSpeechProfile = (id: string) => readSpeechProfiles().find(profile => profile.id === id)

export const saveSpeechProfile = async (profile: SpeechProfile): Promise<SpeechProfile> => {
  if (!isProvider(profile.provider) || !profile.id) throw new Error('请选择语音服务')
  const profiles = readSpeechProfiles()
  const index = profiles.findIndex(item => item.id === profile.id)
  const saved = { ...profile, updatedAt: Math.max(Date.now(), Number(profiles[index]?.updatedAt || 0) + 1) }
  if (index >= 0) profiles[index] = saved
  else profiles.push(saved)
  appSettings.setItem(SPEECH_PROFILES_KEY, JSON.stringify({ version: 1, profiles }))
  await flushAppSettings()
  return saved
}

/** 旧版 audio 配置按稳定 ID 迁入，保留原记录供回退；重复启动或恢复备份不会重复迁移。 */
export const migrateLegacySpeechProfiles = () => {
  const profiles = readSpeechProfiles()
  const raw = appSettings.getItem('ew-local-ai-models')
  if (!raw) return profiles
  const legacy = JSON.parse(raw) as { models?: Array<Record<string, unknown>> }
  const listening = JSON.parse(appSettings.getItem('ew-listening-settings') || '{}') as Record<string, unknown>
  let changed = false
  for (const model of legacy.models || []) {
    if (model.scene !== 'audio' || !Number.isFinite(Number(model.id))) continue
    const id = `legacy-audio-${model.id}`
    if (profiles.some(profile => profile.id === id)) continue
    profiles.push({
      ...defaultSpeechProfile('openai'), id,
      name: String(model.name || model.modelCode || '已迁移语音服务'),
      baseUrl: String(model.baseUrl || ''), apiKey: String(model.apiKey || ''),
      model: String(model.modelCode || ''), voice: String((String(listening.cloudModelCode) === String(model.id) && listening.cloudVoice) || model.ttsVoice || 'alloy'),
      format: (String(listening.cloudModelCode) === String(model.id) ? listening.cloudFormat || model.ttsFormat : model.ttsFormat) === 'wav' ? 'wav' : 'mp3', enabled: model.status !== 0,
      extraParams: String(model.extraParams || ''), updatedAt: 1,
    })
    changed = true
  }
  if (changed) appSettings.setItem(SPEECH_PROFILES_KEY, JSON.stringify({ version: 1, profiles }))
  return profiles
}

/** 与模型配置相同：合并备份时保留本机已有配置，并补入其他语音服务。 */
export const mergeSpeechProfiles = (currentRaw: string, backupRaw: string) => {
  const current = JSON.parse(currentRaw) as SpeechProfilesFile
  const backup = JSON.parse(backupRaw) as SpeechProfilesFile
  if (!Array.isArray(current.profiles) || !Array.isArray(backup.profiles)) throw new Error('语音服务备份格式无效')
  const ids = new Set(current.profiles.map(profile => profile.id))
  return JSON.stringify({ version: 1, profiles: [...current.profiles, ...backup.profiles.filter(profile => !ids.has(profile.id))] })
}
