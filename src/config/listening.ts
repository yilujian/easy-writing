import type { ListeningSettings } from '@/types/listening'

export const LISTENING_SETTINGS_KEY = 'ew-listening-settings'
export const LISTENING_POSITIONS_KEY = 'ew-listening-positions'
export const LISTENING_LAST_BOOK_KEY = 'ew-listening-last-book'
export const LISTENING_FINISHED_KEY = 'ew-listening-finished-chapters'
export const LISTENING_DIAGNOSTICS_KEY = 'ew-listening-diagnostics'

export const LISTENING_MAX_SEGMENT_CHARS = 120
export const LISTENING_POSITION_RETENTION_MS = 180 * 24 * 60 * 60 * 1000
export const LISTENING_POSITION_MAX_BOOKS = 100
export const LISTENING_DIAGNOSTICS_MAX = 50

export const LISTEN_RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export const LISTEN_MIN_RATE = 0.5
export const LISTEN_MAX_RATE = 2

export const LISTEN_SLEEP_OPTIONS: Array<{
  value: ListeningSettings['sleepTimerDefault']
  label: string
  minutes?: number
}> = [
  { value: 'off', label: '关闭' },
  { value: '15', label: '15 分钟', minutes: 15 },
  { value: '30', label: '30 分钟', minutes: 30 },
  { value: '45', label: '45 分钟', minutes: 45 },
  { value: '60', label: '60 分钟', minutes: 60 },
  { value: 'chapter', label: '本章结束后' }
]

export const LISTEN_GAP_OPTIONS: Array<{ value: ListeningSettings['chapterGapMs']; label: string }> = [
  { value: 0, label: '立即' },
  { value: 800, label: '0.8 秒' },
  { value: 2000, label: '2 秒' }
]

export const DEFAULT_LISTENING_SETTINGS: ListeningSettings = {
  engine: 'system',
  voiceId: '',
  voiceName: '',
  rate: 1,
  pitch: 1,
  volume: 1,
  autoNextChapter: true,
  chapterGapMs: 800,
  sleepTimerDefault: 'off',
  readChapterTitle: true,
  cloudProfileId: '',
  cloudConfigVersion: 0,
  cacheEnabled: true
}

export const clampListenRate = (value: unknown) => {
  const rate = Number(value)
  if (!Number.isFinite(rate)) return 1
  return Math.min(LISTEN_MAX_RATE, Math.max(LISTEN_MIN_RATE, Math.round(rate * 100) / 100))
}

export const clampListenVolume = (value: unknown) => {
  const volume = Number(value)
  if (!Number.isFinite(volume)) return 1
  return Math.min(1, Math.max(0, Math.round(volume * 100) / 100))
}

export const normalizeListeningSettings = (value?: Partial<ListeningSettings> | null): ListeningSettings => {
  const merged = { ...DEFAULT_LISTENING_SETTINGS, ...(value || {}) }
  const engine = ['cloud', 'openai-speech'].includes(String(merged.engine)) ? 'cloud' : 'system'
  const gap = [0, 800, 2000].includes(Number(merged.chapterGapMs))
    ? (Number(merged.chapterGapMs) as 0 | 800 | 2000)
    : 800
  const sleep = ['off', '15', '30', '45', '60', 'chapter'].includes(String(merged.sleepTimerDefault))
    ? merged.sleepTimerDefault
    : 'off'
  return {
    engine,
    voiceId: String(merged.voiceId || ''),
    voiceName: String(merged.voiceName || ''),
    rate: clampListenRate(merged.rate),
    pitch: Math.min(2, Math.max(0.5, Number(merged.pitch) || 1)),
    volume: clampListenVolume(merged.volume),
    autoNextChapter: merged.autoNextChapter !== false,
    chapterGapMs: gap,
    sleepTimerDefault: sleep,
    readChapterTitle: merged.readChapterTitle !== false,
    cloudProfileId: String(merged.cloudProfileId || ''),
    cloudConfigVersion: Number(merged.cloudConfigVersion) || 0,
    cacheEnabled: merged.cacheEnabled !== false
  }
}
