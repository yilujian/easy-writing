import { isTauriRuntime } from './writing-storage'
import { getStorageMode, STORAGE_MODE_KEY } from './storage-mode'
import { flushAppSettings } from './app-settings'
import { beginStorageMaintenance, endStorageMaintenance } from './storage-maintenance'
import { desktopInvoke } from './desktop-records'
import { hasLiveLocalTasks } from '@/utils/local-workflow-runtime'

export async function requireSingleStorageWindow() {
  if (!isTauriRuntime()) return
  const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
  if ((await getAllWebviewWindows()).length > 1)
    throw new Error('请先关闭独立的大纲、预览等窗口，再执行此操作，避免未保存内容被覆盖')
}

export async function retryStorageUpgrade() {
  if (!isTauriRuntime() || getStorageMode().mode !== 'legacy') return
  if (hasLiveLocalTasks()) throw new Error('请先停止正在运行的生成任务，再升级本地数据')
  await requireSingleStorageWindow()
  const { getLocalBackupService } = await import('./local-backup-service')
  if (!await getLocalBackupService().snapshotActiveWritingEditor(4000, true))
    throw new Error('当前内容尚未保存，已停止重启')
  await flushAppSettings()
  await beginStorageMaintenance()
  try {
    await requireSingleStorageWindow()
    // Retain the legacy selection until the next startup actually completes the migration.
    localStorage.setItem(STORAGE_MODE_KEY, 'retry')
    await desktopInvoke('restart_app')
  } catch (error) {
    try { localStorage.setItem(STORAGE_MODE_KEY, 'legacy') } finally { endStorageMaintenance() }
    throw error
  }
}
