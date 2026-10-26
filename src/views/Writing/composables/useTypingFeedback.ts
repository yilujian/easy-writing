import type { Ref } from 'vue'
import type { TypingSound } from '@/config/typing-sounds'
import { TypingSoundSamplePlayer } from '@/utils/typing-sound-player'
import { isTauriRuntime, type LocalWritingSettings } from '@/storage'
import { useListeningStore } from '@/stores/listening'

/**
 * 打字反馈：击键音效（合成机械键/打字机 + 采样播放器）与光标处视觉特效。
 * AudioContext 生命周期自管理（桌面 WebKit 需在用户手势内解锁并打通静音链路）。
 */

interface CaretEditorLike {
  state: { selection: { from: number } }
  view: { coordsAtPos: (pos: number) => { left: number; bottom: number } }
}

interface UseTypingFeedbackOptions {
  typingSound: Ref<TypingSound>
  typingEffect: Ref<LocalWritingSettings['typingEffect']>
  editor: Ref<CaretEditorLike | undefined>
  particlesContainerRef: Ref<HTMLElement | null>
}

export const useTypingFeedback = (options: UseTypingFeedbackOptions) => {
  const { typingSound, typingEffect, editor, particlesContainerRef } = options
  const listeningStore = useListeningStore()

  let audioCtx: AudioContext | null = null
  let audioResumePromise: Promise<void> | null = null
  let audioPrimed = false
  const sampleSoundPlayer = new TypingSoundSamplePlayer()
  type DesktopAudioContextState = AudioContextState | 'interrupted'

  const getAudioContextState = (): DesktopAudioContextState | undefined =>
    audioCtx?.state as DesktopAudioContextState | undefined

  const initAudioContext = () => {
    if (!audioCtx && typeof window !== 'undefined') {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AudioContextClass) {
        audioCtx = new AudioContextClass()
        audioCtx.onstatechange = () => {
          if (getAudioContextState() !== 'running') {
            audioPrimed = false
          }
        }
      }
    }
  }

  const disposeAudioContext = () => {
    sampleSoundPlayer.reset()
    if (audioCtx && audioCtx.state !== 'closed') {
      void audioCtx.close().catch(() => undefined)
    }
    audioCtx = null
    audioResumePromise = null
    audioPrimed = false
  }

  const recreateAudioContext = () => {
    disposeAudioContext()
    initAudioContext()
  }

  const primeAudioOutput = () => {
    if (!audioCtx || getAudioContextState() !== 'running' || audioPrimed) return
    const source = audioCtx.createBufferSource()
    const gain = audioCtx.createGain()
    source.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate)
    gain.gain.value = 0.00001
    source.connect(gain)
    gain.connect(audioCtx.destination)
    source.start()
    source.stop(audioCtx.currentTime + 0.01)
    audioPrimed = true
  }

  const ensureAudioContextReady = async () => {
    initAudioContext()
    if (!audioCtx) return false
    if (getAudioContextState() === 'closed') {
      recreateAudioContext()
    }
    if (!audioCtx) return false
    if (getAudioContextState() !== 'running') {
      audioResumePromise ||= audioCtx.resume().finally(() => {
        audioResumePromise = null
      })
      await audioResumePromise.catch(() => undefined)
    }
    const stateAfterResume = getAudioContextState()
    if (stateAfterResume !== 'running' && isTauriRuntime()) {
      recreateAudioContext()
      const recreatedState = getAudioContextState()
      if (audioCtx && recreatedState !== 'running') {
        await audioCtx.resume().catch(() => undefined)
      }
    }
    if (getAudioContextState() === 'running') {
      // WebKit 桌面端需要在用户手势里先打通一次静音输出链路。
      primeAudioOutput()
    }
    return getAudioContextState() === 'running'
  }

  // 击键噪声源：真实键盘声的主体是宽频噪声脉冲而不是纯音，纯振荡器听感尖锐刺耳
  let keyNoiseBuffer: AudioBuffer | null = null
  const getKeyNoiseBuffer = (ctx: AudioContext) => {
    if (keyNoiseBuffer && keyNoiseBuffer.sampleRate === ctx.sampleRate) return keyNoiseBuffer
    const length = Math.floor(ctx.sampleRate * 0.1)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1
    keyNoiseBuffer = buffer
    return buffer
  }

  // 噪声脉冲（键帽敲击面）+ 低频短音（键盘腔体闷响）= 机械键盘质感
  const playKeyStroke = (
    ctx: AudioContext,
    t: number,
    opts: { filterType: BiquadFilterType; filterFreq: number; noiseGain: number; noiseDur: number; thumpFreq: number; thumpGain: number; thumpDur: number }
  ) => {
    // 每次击键 ±8% 随机微调，避免连打时机关枪式的重复感
    const vary = 1 + (Math.random() - 0.5) * 0.16

    const noise = ctx.createBufferSource()
    noise.buffer = getKeyNoiseBuffer(ctx)
    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = opts.filterType
    noiseFilter.frequency.setValueAtTime(opts.filterFreq * vary, t)
    noiseFilter.Q.value = 0.9
    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(opts.noiseGain, t)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + opts.noiseDur)
    noise.connect(noiseFilter)
    noiseFilter.connect(noiseGain)
    noiseGain.connect(ctx.destination)
    noise.start(t)
    noise.stop(t + opts.noiseDur)

    const thump = ctx.createOscillator()
    thump.type = 'sine'
    thump.frequency.setValueAtTime(opts.thumpFreq * vary, t)
    thump.frequency.exponentialRampToValueAtTime(Math.max(60, opts.thumpFreq * 0.65), t + opts.thumpDur)
    const thumpGain = ctx.createGain()
    thumpGain.gain.setValueAtTime(opts.thumpGain, t)
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + opts.thumpDur)
    thump.connect(thumpGain)
    thumpGain.connect(ctx.destination)
    thump.start(t)
    thump.stop(t + opts.thumpDur)
  }

  const playSound = async (type: TypingSound) => {
    // 听书播放时不再叠加打字音效，避免两路声音抢注意力
    if (listeningStore.isPlaying) return
    const ready = await ensureAudioContextReady()
    if (!ready || !audioCtx) return

    if (await sampleSoundPlayer.play(audioCtx, type)) return

    const t = audioCtx.currentTime

    if (type === 'crisp') {
      // 青轴机械键：清脆段落感，噪声中心频率适中不刺耳
      playKeyStroke(audioCtx, t, {
        filterType: 'bandpass',
        filterFreq: 1100,
        noiseGain: 0.22,
        noiseDur: 0.04,
        thumpFreq: 160,
        thumpGain: 0.12,
        thumpDur: 0.05,
      })
      return
    }
    if (type === 'drop') {
      // 茶轴机械键：闷响厚实，低通滤掉高频毛刺
      playKeyStroke(audioCtx, t, {
        filterType: 'lowpass',
        filterFreq: 620,
        noiseGain: 0.3,
        noiseDur: 0.055,
        thumpFreq: 120,
        thumpGain: 0.16,
        thumpDur: 0.06,
      })
      return
    }
    if (type === 'typewriter') {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      const filter = audioCtx.createBiquadFilter()
      osc.connect(filter)
      filter.connect(gain)
      gain.connect(audioCtx.destination)
      osc.type = 'square'
      osc.frequency.setValueAtTime(400, t)
      osc.frequency.exponentialRampToValueAtTime(100, t + 0.08)
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(800, t)
      gain.gain.setValueAtTime(0.25, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
      osc.start(t)
      osc.stop(t + 0.08)
    }
  }

  // 鼓励文案库
  const CHEER_WORDS = [
    '加油',
    '坚持',
    '妙笔',
    '文思',
    '🔥',
    '✨',
    '牛逼',
    '绝绝子',
    '冲鸭',
    '稳住',
    'Excellent',
    'Nice',
    '行云',
    '流水',
    '笔耕',
    '不辍',
    '💪',
    '就是干！',
    '你是最棒的！',
    '迟早成神',
  ]

  const triggerVisual = () => {
    if (
      typingEffect.value === 'none' ||
      !editor.value ||
      !particlesContainerRef.value
    )
      return

    try {
      const { from } = editor.value.state.selection
      const coords = editor.value.view.coordsAtPos(from)
      const x = coords.left
      const y = coords.bottom - 5

      if (typingEffect.value === 'splash') {
        for (let i = 0; i < 4; i++) {
          const el = document.createElement('div')
          el.className = 'effect-splash-drop'
          const size = Math.random() * 6 + 2
          el.style.width = size + 'px'
          el.style.height = size + 'px'
          el.style.left = x + 'px'
          el.style.top = y + 'px'
          particlesContainerRef.value.appendChild(el)
          const angle = Math.random() * Math.PI * 2
          const v = Math.random() * 30 + 10
          el.animate(
            [
              { transform: 'translate(0, 0)', opacity: 0.9 },
              {
                transform: `translate(${Math.cos(angle) * v}px, ${Math.sin(angle) * v}px)`,
                opacity: 0,
              },
            ],
            { duration: 600, easing: 'ease-out', fill: 'forwards' },
          ).onfinish = () => el.remove()
        }
      } else if (typingEffect.value === 'ripple') {
        const el = document.createElement('div')
        el.className = 'effect-ripple'
        el.style.left = x + 'px'
        el.style.top = y + 'px'
        particlesContainerRef.value.appendChild(el)
        setTimeout(() => el.remove(), 800)
      } else if (typingEffect.value === 'mist') {
        const el = document.createElement('div')
        el.className = 'effect-mist'
        el.style.left = x + 'px'
        el.style.top = y + 'px'
        particlesContainerRef.value.appendChild(el)
        setTimeout(() => el.remove(), 1000)
      } else if (typingEffect.value === 'fire') {
        // 烈焰 (Fire Redesigned)
        for (let i = 0; i < 3; i++) {
          const el = document.createElement('div')
          el.className = 'effect-fire-flame'

          // 随机宽度和高度
          const w = Math.random() * 12 + 6
          const h = Math.random() * 20 + 10
          el.style.width = w + 'px'
          el.style.height = h + 'px'

          // 稍微偏移
          const ox = (Math.random() - 0.5) * 15
          const oy = (Math.random() - 0.5) * 5
          el.style.left = x + ox + 'px'
          el.style.top = y + oy + 'px'

          particlesContainerRef.value.appendChild(el)

          // 动画：向上移动 + 左右摇摆 + 缩小 + 变透明
          const sway = (Math.random() - 0.5) * 30
          const rise = Math.random() * 60 + 40

          el.animate(
            [
              {
                transform: 'translate(0, 0) rotate(45deg) scale(0.5)',
                opacity: 0,
              }, // 初始小而透明
              {
                transform: `translate(${sway * 0.2}px, -10px) rotate(45deg) scale(1.2)`,
                opacity: 0.9,
                offset: 0.2,
              }, // 迅速变大变亮
              {
                transform: `translate(${sway}px, -${rise}px) rotate(${45 + sway}deg) scale(0)`,
                opacity: 0,
              }, // 飘散消失
            ],
            {
              duration: 600 + Math.random() * 300,
              easing: 'ease-out',
              fill: 'forwards',
            },
          ).onfinish = () => el.remove()
        }
      } else if (typingEffect.value === 'cheer') {
        // 鼓励 (Cheer)
        const el = document.createElement('div')
        el.className = 'effect-cheer-text'

        // 随机文案
        const text = CHEER_WORDS[Math.floor(Math.random() * CHEER_WORDS.length)]
        el.innerText = text

        // 随机颜色 (金色/橙色/红色)
        const colors = ['var(--state-warning)', 'var(--state-danger)', 'var(--ink-accent)', 'var(--chart-ai)']
        el.style.color = colors[Math.floor(Math.random() * colors.length)]

        el.style.left = x + 'px'
        el.style.top = y + 'px'

        // 随机大小
        el.style.fontSize = Math.random() * 8 + 12 + 'px'

        particlesContainerRef.value.appendChild(el)

        // 动画：向上浮动淡出
        const side = (Math.random() - 0.5) * 40
        el.animate(
          [
            { transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
            {
              transform: 'translate(-50%, -50%) scale(1.2)',
              opacity: 1,
              offset: 0.2,
            },
            {
              transform: `translate(calc(-50% + ${side}px), -80px) scale(1)`,
              opacity: 0,
            },
          ],
          {
            duration: 1000,
            easing: 'ease-out',
            fill: 'forwards',
          },
        ).onfinish = () => el.remove()
      }
    } catch (e) {
      console.error('Visual effect error:', e)
    }
  }

  const triggerTypingSound = () => {
    if (typingSound.value !== 'none') {
      void playSound(typingSound.value)
    }
  }

  const triggerTypingFeedback = () => {
    triggerTypingSound()
    triggerVisual()
  }

  const unlockAudioByUserGesture = () => {
    if (typingSound.value !== 'none') {
      void ensureAudioContextReady()
    }
  }

  const preloadSamples = () => sampleSoundPlayer.preload()

  return {
    triggerTypingSound,
    triggerTypingFeedback,
    unlockAudioByUserGesture,
    ensureAudioContextReady,
    preloadSamples,
    disposeAudioContext,
  }
}
