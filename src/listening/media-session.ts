/**
 * 系统媒体面板/媒体键（Media Session）。
 * WebView 是可选能力：不支持时静默跳过，不影响播放。
 */

interface MediaSessionLike {
  metadata: unknown
  playbackState: string
  setActionHandler: (action: string, handler: (() => void) | null) => void
}

interface MediaMetadataLike {
  new (init: {
    title?: string
    artist?: string
    album?: string
    artwork?: Array<{ src: string; sizes?: string; type?: string }>
  }): unknown
}

const getSession = (): MediaSessionLike | null => {
  if (typeof navigator === 'undefined') return null
  const session = (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession
  return session && typeof session.setActionHandler === 'function' ? session : null
}

const getMetadataCtor = (): MediaMetadataLike | null => {
  if (typeof window === 'undefined') return null
  const ctor = (window as Window & { MediaMetadata?: MediaMetadataLike }).MediaMetadata
  return typeof ctor === 'function' ? ctor : null
}

export const setupMediaSessionActions = (actions: {
  play: () => void
  pause: () => void
  next: () => void
  previous: () => void
}) => {
  const session = getSession()
  if (!session) return
  const handlers: Array<[string, () => void]> = [
    ['play', actions.play],
    ['pause', actions.pause],
    ['nexttrack', actions.next],
    ['previoustrack', actions.previous],
  ]
  for (const [name, handler] of handlers) {
    try {
      session.setActionHandler(name, handler)
    } catch {
      // 某些 WebView 只实现部分 action，忽略即可
    }
  }
}

export const updateMediaSession = (state: {
  title: string
  artist: string
  coverUrl?: string
  playing: boolean
}) => {
  const session = getSession()
  if (!session) return
  const Metadata = getMetadataCtor()
  if (Metadata) {
    try {
      session.metadata = new Metadata({
        title: state.title,
        artist: state.artist,
        album: '易创听书',
        artwork: state.coverUrl ? [{ src: state.coverUrl, sizes: '512x512' }] : undefined,
      })
    } catch {
      // 封面地址无效时仍保留标题
    }
  }
  try {
    session.playbackState = state.playing ? 'playing' : 'paused'
  } catch {
    // 某些 WebView 只读 playbackState
  }
}
