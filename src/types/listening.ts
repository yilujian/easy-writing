import type { TtsEngineId } from '@/listening/engine/types'

/** 听书播放状态。empty 单独出来：章节存在但还没有正文，不应该按错误处理。 */
export type ListenStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'empty'
  | 'error'

export type SleepTimerMode = 'off' | '15' | '30' | '45' | '60' | 'chapter'

/** 仅作用于当前会话；写作页校稿不改变整本听书的偏好。 */
export type ListeningScope = 'book' | 'chapter'

export interface ListenChapterRef {
  id: number
  title: string
  volumeId: string
  volumeTitle: string
  wordCount: number
  sortNo: number
}

export interface ListenBook {
  id: number
  title: string
  intro: string
  coverUrl: string
  tags: string[]
  author?: string
}

export interface SpeechSegment {
  index: number
  /** 实际交给 TTS 的文本（以后可叠加朗读词典替换） */
  text: string
  /** 页面展示与高亮用的原文 */
  displayText: string
  /** 在清洗后正文中的起始偏移 */
  start: number
  /** 在清洗后正文中的结束偏移（不含） */
  end: number
  paragraphIndex: number
  kind: 'title' | 'body'
}

export interface ChapterScript {
  chapterId: number
  title: string
  text: string
  segments: SpeechSegment[]
  textLength: number
  /** 轻量签名：正文被 AI 改写/回退后用于判断旧位置是否还可信 */
  signature: string
}

export interface ListeningSettings {
  engine: TtsEngineId
  /** 系统音色 voiceURI；为空时由引擎挑默认中文音色 */
  voiceId: string
  /** voiceURI 失效时按名称回退 */
  voiceName: string
  rate: number
  pitch: number
  volume: number
  autoNextChapter: boolean
  chapterGapMs: 0 | 800 | 2000
  /** 下次进入听书页时的默认定时；不保存正在倒计时的会话 */
  sleepTimerDefault: SleepTimerMode
  readChapterTitle: boolean
  /** 云端朗读使用的模型 code（模型管理里的 audio 模型） */
  cloudModelCode: string
  cloudVoice: string
  cloudFormat: 'mp3' | 'wav'
  /** 是否缓存云端音频，默认开启 */
  cacheEnabled: boolean
}

export interface ListeningPosition {
  bookId: string
  chapterId: number
  chapterTitle: string
  segmentIndex: number
  /** 清洗后正文偏移，作为 snippet 找不到时的次选 */
  charOffset: number
  textLength: number
  signature: string
  /** 当前句前 16 字，用于正文被改写后的重定位 */
  snippet: string
  updatedAt: number
  finished?: boolean
}

export interface ListeningDiagnostic {
  at: number
  engine: TtsEngineId
  chapterId: number
  chars: number
  code: string
  message: string
}

export interface ListenPlaybackSnapshot {
  status: ListenStatus
  chapterIndex: number
  segmentIndex: number
  error: string
}
