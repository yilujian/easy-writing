import { appSettings } from '@/storage/app-settings'
import {
  LISTENING_SETTINGS_KEY,
  normalizeListeningSettings,
} from '@/config/listening'
import type { ListeningSettings } from '@/types/listening'

/**
 * 听书偏好（本机）：引擎、音色、语速、音量、自动下一章等。
 * 走 appSettings 而不是新建 SQLite 表：听书是只读消费现有正文，
 * 偏好体积很小，且 `ew-` 前缀会自动进入整包备份。
 */
export const readListeningSettings = (): ListeningSettings => {
  try {
    const raw = appSettings.getItem(LISTENING_SETTINGS_KEY)
    if (!raw) return normalizeListeningSettings()
    const parsed: unknown = JSON.parse(raw)
    return normalizeListeningSettings(parsed && typeof parsed === 'object' ? parsed as Partial<ListeningSettings> : null)
  } catch (error) {
    console.warn('读取听书设置失败，使用默认值', error)
    return normalizeListeningSettings()
  }
}

export const writeListeningSettings = (settings: ListeningSettings) => {
  const normalized = normalizeListeningSettings(settings)
  try {
    appSettings.setItem(LISTENING_SETTINGS_KEY, JSON.stringify(normalized))
  } catch (error) {
    console.warn('保存听书设置失败', error)
  }
  return normalized
}
