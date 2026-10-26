import { createTtsEngine } from '@/listening/engine/registry'
import type { ListeningSettings } from '@/types/listening'

const PREVIEW_TEXT = '这是朗读试听，愿你写作顺利。'

/**
 * 音色试听：用独立引擎读一小段，不改变当前播放位置。
 * 正在播放时调用方应禁用按钮，避免两路声音叠加（系统引擎会 cancel 全局合成）。
 */
export const previewListeningVoice = async (
  settings: ListeningSettings,
  signal?: AbortSignal
): Promise<void> => {
  const engine = createTtsEngine(settings)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = window.setTimeout(() => controller.abort(), 20000)
  try {
    await engine.speak({
      text: PREVIEW_TEXT,
      voiceId: settings.voiceId,
      voiceName: settings.voiceName,
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
      signal: controller.signal
    })
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
    engine.stop()
  }
}
