import { appSettings } from '@/storage/app-settings'
import { LISTENING_DIAGNOSTICS_KEY, LISTENING_DIAGNOSTICS_MAX } from '@/config/listening'
import type { ListeningDiagnostic } from '@/types/listening'

/**
 * 听书诊断：只记引擎、章节、错误码和长度，不记正文、不记 API Key。
 * 用户可在设置页复制给开发者，不做任何自动上传。
 */
export const readListeningDiagnostics = (): ListeningDiagnostic[] => {
  try {
    const parsed: unknown = JSON.parse(appSettings.getItem(LISTENING_DIAGNOSTICS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') as ListeningDiagnostic[] : []
  } catch {
    return []
  }
}

export const recordListeningDiagnostic = (entry: ListeningDiagnostic) => {
  try {
    const next = [entry, ...readListeningDiagnostics()].slice(0, LISTENING_DIAGNOSTICS_MAX)
    appSettings.setItem(LISTENING_DIAGNOSTICS_KEY, JSON.stringify(next))
  } catch (error) {
    console.warn('记录听书诊断失败', error)
  }
}

export const clearListeningDiagnostics = () => {
  try {
    appSettings.removeItem(LISTENING_DIAGNOSTICS_KEY)
  } catch (error) {
    console.warn('清理听书诊断失败', error)
  }
}

export const formatListeningDiagnostics = (): string => {
  const rows = readListeningDiagnostics()
  if (!rows.length) return '暂无听书错误记录'
  return rows
    .map(item => `${new Date(item.at).toLocaleString()} · ${item.engine} · 第 ${item.chapterId} 章 · ${item.code}${item.message ? ` · ${item.message}` : ''}`)
    .join('\n')
}
