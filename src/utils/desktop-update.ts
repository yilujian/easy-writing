import { appSettings } from '@/storage/app-settings'
import { isTauriRuntime } from '@/storage'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'

const DESKTOP_UPDATE_NOTES_KEY = 'ew-desktop-update-notes'

export type DesktopUpdatePhase = 'checking' | 'available' | 'preparing' | 'downloading' | 'installing' | 'installed' | 'error'

export interface DesktopUpdateInfo {
  currentVersion: string
  version: string
  date?: string
  body?: string
}

export interface DesktopUpdateProgress {
  downloaded: number
  total?: number
  percent?: number
}

export interface DesktopUpdateSnapshot {
  phase: DesktopUpdatePhase
  info?: DesktopUpdateInfo
  progress?: DesktopUpdateProgress
  message: string
  error?: string
}

export type DesktopUpdateResult =
  | { status: 'available'; info: DesktopUpdateInfo }
  | { status: 'latest' | 'unsupported' }
  | { status: 'error'; message: string }

export interface DesktopUpdateOptions {
  onStateChange?: (state: DesktopUpdateSnapshot) => void
}

interface StoredDesktopUpdateNotes extends DesktopUpdateInfo {
  shown: boolean
  installedAt: string
}

// 避免启动自动检查和手动检查同时触发重复下载。
let activeCheckPromise: Promise<DesktopUpdateResult> | null = null
let activeInstallPromise: Promise<void> | null = null
let pendingUpdate: Update | null = null

const errorMessage = (error: unknown) => error instanceof Error
  ? error.message
  : typeof error === 'string' ? error : '无法连接更新服务，请稍后重试'

export const dismissDesktopUpdate = async () => {
  if (activeInstallPromise) return
  const update = pendingUpdate
  pendingUpdate = null
  await update?.close().catch(() => {})
}

const readUpdateString = (value: unknown) => typeof value === 'string' ? value : undefined

const toUpdateInfo = (update: { currentVersion: string; version: string; date?: string; body?: string; rawJson?: Record<string, unknown> }): DesktopUpdateInfo => ({
  currentVersion: update.currentVersion,
  version: update.version,
  // 兼容 Tauri manifest 原始字段，确保发布备注和发布日期可展示。
  date: update.date ?? readUpdateString(update.rawJson?.pub_date),
  body: update.body ?? readUpdateString(update.rawJson?.notes),
})

const savePendingUpdateNotes = (info: DesktopUpdateInfo) => {
  // 先缓存目标版本说明，安装重启后再按当前版本匹配展示。
  appSettings.setItem(
    DESKTOP_UPDATE_NOTES_KEY,
    JSON.stringify({ ...info, shown: false, installedAt: new Date().toISOString() } satisfies StoredDesktopUpdateNotes)
  )
}

const readPendingUpdateNotes = () => {
  try {
    const raw = appSettings.getItem(DESKTOP_UPDATE_NOTES_KEY)
    return raw ? JSON.parse(raw) as StoredDesktopUpdateNotes : null
  } catch {
    appSettings.removeItem(DESKTOP_UPDATE_NOTES_KEY)
    return null
  }
}

const updateDownloadProgress = (
  event: DownloadEvent,
  info: DesktopUpdateInfo,
  progress: DesktopUpdateProgress,
  onStateChange?: DesktopUpdateOptions['onStateChange']
) => {
  if (event.event === 'Started') {
    progress.downloaded = 0
    progress.total = event.data.contentLength
    progress.percent = event.data.contentLength ? 0 : undefined
  } else if (event.event === 'Progress') {
    progress.downloaded += event.data.chunkLength
    progress.percent = progress.total ? Math.min(99, Math.floor((progress.downloaded / progress.total) * 100)) : undefined
  } else {
    progress.percent = 100
    if (progress.total) progress.downloaded = progress.total
  }

  onStateChange?.({
    phase: event.event === 'Finished' ? 'preparing' : 'downloading',
    info,
    progress: { ...progress },
    message: event.event === 'Finished' ? '下载完成，正在保存作品...' : '正在下载更新包...',
  })
}

export const consumePendingDesktopUpdateNotes = async (): Promise<DesktopUpdateInfo | null> => {
  if (!isTauriRuntime()) return null

  const notes = readPendingUpdateNotes()
  if (!notes || notes.shown) return null

  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const currentVersion = await getVersion()
    // 只有应用实际启动到目标版本后，才展示该版本的更新说明。
    if (currentVersion !== notes.version) return null

    appSettings.setItem(
      DESKTOP_UPDATE_NOTES_KEY,
      JSON.stringify({ ...notes, shown: true } satisfies StoredDesktopUpdateNotes)
    )
    return {
      currentVersion: notes.currentVersion,
      version: notes.version,
      date: notes.date,
      body: notes.body,
    }
  } catch {
    return null
  }
}

/** 检查只返回版本信息；自动和手动入口都必须经用户点击后才能安装。 */
export const checkDesktopUpdate = async (options: DesktopUpdateOptions = {}): Promise<DesktopUpdateResult> => {
  if (!isTauriRuntime()) return { status: 'unsupported' }
  if (activeInstallPromise) return { status: 'error', message: '正在更新，请等待完成' }
  if (activeCheckPromise) return activeCheckPromise

  activeCheckPromise = (async (): Promise<DesktopUpdateResult> => {
    await dismissDesktopUpdate()
    options.onStateChange?.({ phase: 'checking', message: '正在检查新版本...' })
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      pendingUpdate = await check({ timeout: 15000 })
      if (!pendingUpdate) return { status: 'latest' }
      const info = toUpdateInfo(pendingUpdate)
      options.onStateChange?.({ phase: 'available', info, message: '新版本已准备好，可选择立即更新。' })
      return { status: 'available', info }
    } catch (error) {
      const message = errorMessage(error)
      options.onStateChange?.({ phase: 'error', message, error: message })
      return { status: 'error', message }
    }
  })()
  try {
    return await activeCheckPromise
  } finally {
    activeCheckPromise = null
  }
}

/** Windows 安装会退出进程，保存必须在 install 之前完成。 */
export const installDesktopUpdate = async (options: DesktopUpdateOptions & {
  beforeInstall: () => Promise<void>
}): Promise<void> => {
  if (activeInstallPromise) return activeInstallPromise
  const update = pendingUpdate
  if (!update) {
    options.onStateChange?.({ phase: 'error', message: '请重新检查更新', error: '更新信息已失效，请重新检查更新。' })
    return
  }
  activeInstallPromise = (async () => {
    const info = toUpdateInfo(update)
    const progress: DesktopUpdateProgress = { downloaded: 0 }
    const emit = (phase: DesktopUpdatePhase, message: string) => options.onStateChange?.({ phase, info, progress: { ...progress }, message })
    try {
      emit('downloading', '正在下载更新包...')
      await update.download(event => updateDownloadProgress(event, info, progress, options.onStateChange), { timeout: 120000 })
      emit('preparing', '正在保存并备份作品，请稍候...')
      await options.beforeInstall()
      savePendingUpdateNotes(info)
      emit('installing', '作品已保存，正在安装更新...')
      await update.install()
      emit('installed', '更新已安装，重启后生效。')
    } catch (error) {
      const message = errorMessage(error)
      appSettings.removeItem(DESKTOP_UPDATE_NOTES_KEY)
      options.onStateChange?.({ phase: 'error', info, message, error: message })
    } finally {
      pendingUpdate = null
      await update.close().catch(() => {})
    }
  })()
  try {
    await activeInstallPromise
  } finally {
    activeInstallPromise = null
  }
}
