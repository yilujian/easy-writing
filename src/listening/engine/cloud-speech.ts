import { synthesizeSpeech, validateSpeechProfile } from '@/listening/providers/synthesize'
import {
  buildAudioCacheKey,
  getAudioCacheEpoch,
  getCachedAudio,
  putCachedAudio
} from '@/listening/audio-cache'
import {
  createAbortError,
  type CloudTtsConfig,
  type SpeakOptions,
  type TtsEngine,
  type TtsVoice
} from './types'

const getAudioCtor = (): typeof Audio | null => {
  if (typeof window === 'undefined') return null
  return typeof window.Audio === 'function' ? window.Audio : null
}

const playErrorMessage = (error: unknown) => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return '浏览器未允许自动播放，请点击播放按钮后再试'
  }
  if (error instanceof Error && error.message) return `云端音频无法播放：${error.message}`
  return '云端音频无法播放'
}

/**
 * 云端朗读：独立配置与多厂商原生适配。
 *
 * 以句为单位请求，播放器负责预取与缓存；音频先落 Blob 再交给 <audio>，
 * 避免 CSP 的 media-src 限制和供应商的 CORS 影响。暂停用原生 audio.pause()，
 * 恢复能精确到句内，不需要像系统引擎那样重读。
 */
export class CloudSpeechEngine implements TtsEngine {
  readonly id = 'cloud' as const
  private config: CloudTtsConfig
  private audio: HTMLAudioElement | null = null
  private objectUrl = ''
  private currentCleanup: (() => void) | null = null
  private currentFail: ((error: Error) => void) | null = null
  private pendingBlobs = new Map<string, { promise: Promise<Blob>; signal: AbortSignal }>()
  private generation = 0

  constructor(config: CloudTtsConfig) {
    this.config = config
  }

  async isAvailable() {
    if (!getAudioCtor()) return false
    try { validateSpeechProfile(this.config.profile); return true } catch { return false }
  }

  async listVoices(): Promise<TtsVoice[]> { return [] }

  private cacheKey(options: SpeakOptions) {
    const profile = this.config.profile
    validateSpeechProfile(profile)
    return buildAudioCacheKey([
      'cloud-speech:v1', profile.id, profile.updatedAt, profile.provider,
      profile.baseUrl, profile.endpoint, profile.model, profile.voice, profile.format, profile.extraParams,
      options.text,
    ])
  }

  private async resolveBlob(options: SpeakOptions): Promise<Blob> {
    const epoch = getAudioCacheEpoch()
    const key = await this.cacheKey(options)
    if (this.config.cacheEnabled) {
      const cached = await getCachedAudio(key).catch(() => null)
      if (cached) return cached
    }
    let entry = this.pendingBlobs.get(key)
    if (entry?.signal.aborted) {
      this.pendingBlobs.delete(key)
      entry = undefined
    }
    let pending = entry?.promise
    if (!pending) {
      pending = synthesizeSpeech(this.config.profile, options.text, options.signal).then(async blob => {
        if (this.config.cacheEnabled) await putCachedAudio(key, blob, epoch).catch(() => undefined)
        return blob
      })
      this.pendingBlobs.set(key, { promise: pending, signal: options.signal })
      void pending
        .finally(() => {
          if (this.pendingBlobs.get(key)?.promise === pending) this.pendingBlobs.delete(key)
        })
        .catch(() => undefined)
    }
    return await pending
  }

  /** 当前句播放时预取下一句；失败静默，不影响正在播放的句子 */
  async prefetch(options: SpeakOptions) {
    if (!this.config.cacheEnabled || options.signal.aborted) return
    try {
      await this.resolveBlob(options)
    } catch {
      // 预取失败只在真正播到该句时再报错
    }
  }

  async speak(options: SpeakOptions): Promise<void> {
    const AudioCtor = getAudioCtor()
    if (!AudioCtor) throw new Error('当前环境不支持音频播放')
    validateSpeechProfile(this.config.profile)
    if (options.signal.aborted) throw createAbortError()

    this.stop()
    const token = ++this.generation
    const blob = await this.resolveBlob(options)
    if (token !== this.generation || options.signal.aborted) throw createAbortError()

    const audio = this.audio || new AudioCtor()
    this.audio = audio
    const url = URL.createObjectURL(blob)
    this.objectUrl = url
    audio.src = url
    const volume = Number(options.volume)
    audio.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    // 厂商统一返回正常语速音频；客户端调速，避免不同接口的 speed 数值含义冲突。
    audio.playbackRate = options.rate
    audio.preservesPitch = true

    return await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => finish(error)
      const cleanup = () => {
        options.signal.removeEventListener('abort', onAbort)
        audio.onended = null
        audio.onerror = null
        this.currentCleanup = null
        if (this.currentFail === fail) this.currentFail = null
      }
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => {
        try {
          audio.pause()
        } catch {
          // 已停止
        }
        finish(createAbortError())
      }
      this.currentCleanup = () => finish(createAbortError())
      this.currentFail = fail
      options.signal.addEventListener('abort', onAbort, { once: true })
      audio.onended = () => finish()
      audio.onerror = () => finish(new Error('云端音频播放失败'))
      try {
        options.onStart?.()
        const playResult = audio.play()
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch((error: unknown) => {
            finish(new Error(playErrorMessage(error)))
          })
        }
      } catch (error) {
        finish(new Error(playErrorMessage(error)))
      }
    })
  }

  pause() {
    if (!this.audio || this.audio.paused) return false
    this.audio.pause()
    return true
  }

  resume() {
    const audio = this.audio
    if (!audio || !audio.paused) return false
    const token = this.generation
    const fail = this.currentFail
    try {
      const result = audio.play()
      if (result && typeof result.catch === 'function') {
        result.catch((error: unknown) => {
          if (token !== this.generation || this.audio !== audio) return
          fail?.(new Error(playErrorMessage(error)))
        })
      }
      return true
    } catch (error) {
      fail?.(new Error(playErrorMessage(error)))
      return false
    }
  }

  setVolume(volume: number) {
    if (!this.audio) return false
    const value = Number(volume)
    this.audio.volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
    return true
  }

  stop() {
    this.generation += 1
    this.currentCleanup?.()
    this.currentCleanup = null
    this.currentFail = null
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio = null
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = ''
    }
  }
}
