import { createAbortError, type SpeakOptions, type TtsEngine, type TtsVoice } from './types'

const getSynth = (): SpeechSynthesis | null => {
  if (typeof window === 'undefined') return null
  const synth = window.speechSynthesis
  return synth && typeof synth.speak === 'function' ? synth : null
}

const getUtteranceCtor = (): typeof SpeechSynthesisUtterance | null => {
  if (typeof window === 'undefined') return null
  return typeof window.SpeechSynthesisUtterance === 'function' ? window.SpeechSynthesisUtterance : null
}

const waitForVoices = async (synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> => {
  const immediate = synth.getVoices()
  if (immediate.length) return immediate
  return await new Promise(resolve => {
    let settled = false
    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (settled) return
      settled = true
      synth.removeEventListener?.('voiceschanged', onChanged)
      window.clearTimeout(timer)
      resolve(voices)
    }
    const onChanged = () => {
      const voices = synth.getVoices()
      if (voices.length) finish(voices)
    }
    const timer = window.setTimeout(() => finish(synth.getVoices()), 2500)
    synth.addEventListener?.('voiceschanged', onChanged)
  })
}

/**
 * 系统朗读：逐句调用 Web Speech，不把整章塞进一个 utterance。
 *
 * 暂停采用「取消当前句 + 恢复时重读本句」：各平台 speechSynthesis.pause()
 * 的实现差异很大，直接依赖它会出现“界面已暂停、声音还在继续”的状态错位。
 * 逐句重读最多损失一句，但行为确定。
 */
export class SystemSpeechEngine implements TtsEngine {
  readonly id = 'system' as const
  private current: SpeechSynthesisUtterance | null = null
  private rejectCurrent: ((reason?: unknown) => void) | null = null
  private generation = 0

  async isAvailable() {
    return Boolean(getSynth() && getUtteranceCtor())
  }

  async listVoices(): Promise<TtsVoice[]> {
    const synth = getSynth()
    if (!synth) return []
    const voices = await waitForVoices(synth)
    return voices
      .map(voice => ({
        id: voice.voiceURI || `${voice.name}::${voice.lang}`,
        name: voice.name || voice.voiceURI || '系统语音',
        lang: voice.lang || '',
        engine: 'system' as const,
        local: voice.localService !== false,
        providerLabel: '系统'
      }))
      .sort((a, b) => {
        const rank = (lang: string) => {
          if (/^zh-cn/i.test(lang)) return 0
          if (/^zh/i.test(lang)) return 1
          return 2
        }
        const rankDiff = rank(a.lang) - rank(b.lang)
        if (rankDiff) return rankDiff
        if (a.local !== b.local) return a.local ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }

  private resolveVoice(
    synth: SpeechSynthesis,
    voiceId: string,
    voiceName?: string
  ): SpeechSynthesisVoice | undefined {
    const voices = synth.getVoices()
    if (!voices.length) return undefined
    const exact = voices.find(voice => (voice.voiceURI || `${voice.name}::${voice.lang}`) === voiceId)
    if (exact) return exact
    const byName = voiceName ? voices.find(voice => voice.name === voiceName) : undefined
    return byName || voices.find(voice => /^zh/i.test(voice.lang)) || voices[0]
  }

  async speak(options: SpeakOptions): Promise<void> {
    const synth = getSynth()
    const Ctor = getUtteranceCtor()
    if (!synth || !Ctor) throw new Error('当前系统不支持朗读')
    if (!String(options.text || '').trim()) return
    if (options.signal.aborted) throw createAbortError()

    this.stop()
    const token = ++this.generation
    const utterance = new Ctor(options.text)
    const voice = this.resolveVoice(synth, options.voiceId, options.voiceName)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang || 'zh-CN'
    } else {
      utterance.lang = 'zh-CN'
    }
    utterance.rate = Math.min(2, Math.max(0.5, Number(options.rate) || 1))
    utterance.pitch = Math.min(2, Math.max(0.5, Number(options.pitch) || 1))
    const volume = Number(options.volume)
    utterance.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    this.current = utterance

    return await new Promise<void>((resolve, reject) => {
      let settled = false
      let extended = false
      let watchdog: number | null = null
      let abortHandler: (() => void) | null = null
      const clearWatchdog = () => {
        if (watchdog !== null) {
          window.clearTimeout(watchdog)
          watchdog = null
        }
      }
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearWatchdog()
        if (abortHandler) options.signal.removeEventListener('abort', abortHandler)
        abortHandler = null
        if (this.current === utterance) {
          this.current = null
          this.rejectCurrent = null
        }
        if (error) reject(error)
        else resolve()
      }
      const armWatchdog = (delay: number) => {
        clearWatchdog()
        watchdog = window.setTimeout(() => {
          if (token !== this.generation) return finish(createAbortError())
          if (synth.speaking || synth.pending) {
            // 有些音色不回调 onend，但确实还在读：多给一轮时间，避免把正常朗读打断
            if (!extended) {
              extended = true
              armWatchdog(15000)
              return
            }
            // 先收尾成可读错误，再取消系统合成；不能走 stop()，
            // 否则 stop 会把 Promise 以 AbortError 拒绝，调用方会当成用户暂停而静默吞掉
            const timeoutError = new Error('语音长时间没有结束，已停止本句')
            this.current = null
            this.rejectCurrent = null
            finish(timeoutError)
            try {
              synth.cancel()
            } catch {
              // 已经停止
            }
            return
          }
          finish(new Error('系统语音没有返回朗读进度'))
        }, delay)
      }

      abortHandler = () => {
        if (token === this.generation) this.stop()
        finish(createAbortError())
      }
      options.signal.addEventListener('abort', abortHandler, { once: true })

      utterance.onend = () => {
        finish()
      }
      utterance.onerror = event => {
        const code = String((event as SpeechSynthesisErrorEvent).error || '')
        if (code === 'interrupted' || code === 'canceled') {
          finish(createAbortError())
          return
        }
        const byCode: Record<string, string> = {
          'not-allowed': '系统未允许朗读：请直接点击播放按钮后再试',
          'audio-busy': '系统音频设备忙，请关闭其他占用声音的程序后重试',
          'audio-hardware': '没有找到可用的音频输出设备',
          network: '系统语音需要网络，当前网络不可用',
          'language-unavailable': '系统没有安装中文语音包，请安装后再试',
          'voice-unavailable': '所选系统音色不可用，请换一个音色',
          'text-too-long': '这一句太长，系统语音无法朗读',
          'invalid-argument': '系统语音参数无效，请换一个音色'
        }
        finish(new Error(byCode[code] || (code ? `系统语音朗读失败（${code}）` : '系统语音朗读失败')))
      }

      this.rejectCurrent = (reason?: unknown) => {
        finish(reason instanceof Error ? reason : createAbortError())
      }

      const rate = Math.max(0.5, Number(options.rate) || 1)
      const estimate = Math.max(6000, Math.round((String(options.text).length * 420) / rate) + 5000)
      armWatchdog(estimate)
      try {
        options.onStart?.()
        synth.speak(utterance)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('系统语音启动失败'))
      }
    })
  }

  pause() {
    // 见类注释：取消当前句，由调用方在恢复时重读
    this.stop()
    return false
  }

  resume() {
    return false
  }

  setVolume(volume: number) {
    if (!this.current) return false
    const value = Number(volume)
    this.current.volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
    return true
  }

  stop() {
    const synth = getSynth()
    this.generation += 1
    const reject = this.rejectCurrent
    this.rejectCurrent = null
    this.current = null
    try {
      synth?.cancel()
    } catch {
      // 某些平台未初始化时 cancel 会抛，按已停止处理
    }
    if (reject) reject(createAbortError())
  }
}
