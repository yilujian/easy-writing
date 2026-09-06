import { reactive } from 'vue'
import { isTauriRuntime } from '@/storage'
import { getLocalBookExportPayload, getLocalLibraryStorage } from '@/storage/local-library'
import type { LocalExportPayload } from '@/storage/local-library-types'
import { getLocalBackupService } from '@/storage/local-backup-service'

export interface DiskBackup { id: string; createdAt: string; bytes: number }
export interface BookSnapshot { format: 'easy-writing-local-books'; version: 1; createdAt: string; books: LocalExportPayload[] }
interface CompanionStatus { app: string; token: string; backupDir: string; backups: DiskBackup[] }
let session: CompanionStatus | null = null
let check: Promise<boolean> | null = null
export const localBackupState = reactive({ available: false, busy: false, backupDir: '', lastSuccess: '', error: '', backups: [] as DiskBackup[] })
export async function hasLocalCompanion(refresh = false): Promise<boolean> {
  if (isTauriRuntime()) return false
  if (!refresh && session) return true
  if (check) return check
  check = (async () => {
    try {
      const response = await fetch('/api/local/status', { signal: AbortSignal.timeout(3000), cache: 'no-store' })
      const data: CompanionStatus = await response.json()
      if (!response.ok || data.app !== 'easy-writing-local' || !data.token) throw new Error('请使用本地启动器打开工作台')
      session = data
      Object.assign(localBackupState, { available: true, backupDir: data.backupDir, backups: data.backups })
      return true
    } catch {
      session = null; localBackupState.available = false
      return false
    } finally { check = null }
  })()
  return check
}
export async function companionRequest(path: string, init: RequestInit = {}) {
  if (!await hasLocalCompanion()) throw new Error('本地服务未连接，请使用启动器打开工作台')
  const headers = new Headers(init.headers)
  headers.set('X-EW-Local-Token', session!.token)
  const response = await fetch(`/api/local/${path}`, { ...init, headers })
  if (!response.ok) {
    if (response.status === 403) session = null
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `本地服务返回 ${response.status}`)
  }
  return response
}
export async function localCompanionFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // Preserve provider status and streaming body for the existing AI parser.
  if (!await hasLocalCompanion()) throw new Error('本地服务未连接')
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => { headers[key] = value })
  return fetch('/api/local/ai', {
    method: 'POST', signal: init.signal,
    headers: { 'Content-Type': 'application/json', 'X-EW-Local-Token': session!.token },
    body: JSON.stringify({ url: input, method: init.method || 'GET', headers, body: init.body }),
  })
}
export async function backupBooksToDisk() {
  if (localBackupState.busy) return
  localBackupState.busy = true; localBackupState.error = ''
  try {
    const confirmed = await getLocalBackupService().snapshotActiveWritingEditor(4000, true)
    if (!confirmed) throw new Error('当前章节尚未确认保存，请稍后重试')
    const books = await getLocalLibraryStorage().listLocalBooks()
    const payload: BookSnapshot = { format: 'easy-writing-local-books', version: 1, createdAt: new Date().toISOString(), books: [] }
    for (const book of books) payload.books.push(await getLocalBookExportPayload(book.id))
    await companionRequest('backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    localBackupState.lastSuccess = new Date().toISOString()
    await hasLocalCompanion(true)
  } catch (error) {
    localBackupState.error = error instanceof Error ? error.message : '备份失败'
    throw error
  } finally { localBackupState.busy = false }
}
export function startLocalBackupSchedule() {
  if (isTauriRuntime()) return
  // No unload promises: browsers may terminate them. Explicit backup is available before exit.
  const tick = async () => {
    if (await hasLocalCompanion(true)) {
      try { await backupBooksToDisk() } catch (error) { console.warn('本地硬盘备份失败', error) }
    }
    window.setTimeout(tick, 5 * 60 * 1000)
  }
  window.setTimeout(tick, 15000)
}
