import { isTauriRuntime } from './writing-storage'
import { desktopInvoke } from './desktop-records'
import { migrateDesktopStorage, type MigrationProgress, type StorageInspection } from './desktop-migration'
import { collectLegacySnapshot } from './legacy-inventory'
import { initAppSettings } from './app-settings'
import { activateStorageMode, readStartupPreference, setStorageStartupNotice, STORAGE_MODE_KEY, type StorageMode } from './storage-mode'

const canUseLegacy = (inspection: StorageInspection) =>
  !inspection.pendingRestore && ['needs_inventory', 'retry'].includes(inspection.state)

async function activate(mode: StorageMode, token: string) {
  // The native process checks the receipt again and shares one selection with all webviews.
  const selected = await desktopInvoke<StorageMode>('desktop_storage_activate', { mode, token })
  activateStorageMode(selected)
  await initAppSettings()
}

async function continueLegacy(inspection: StorageInspection, failed: boolean) {
  if (!canUseLegacy(inspection)) throw new Error('无法确认原数据可以安全使用，未切换存储')
  const snapshot = await collectLegacySnapshot()
  const hasLegacyCore = [...snapshot.records].some(([name, rows]) =>
    name.startsWith('legacy-core/') && name !== 'legacy-core/sync_settings' && rows.length > 0)
  const core = inspection.sqliteContentRecords === 0 && hasLegacyCore ? 'indexeddb' : 'sqlite'
  await activate({ mode: 'legacy', core }, inspection.token)
  let remembered = true
  try { localStorage.setItem(STORAGE_MODE_KEY, 'legacy') } catch { remembered = false }
  if (failed) setStorageStartupNotice(remembered
    ? '数据升级未完成，已继续使用原有数据。可在“保存与备份”中重新尝试。'
    : '数据升级未完成，本次继续使用原有数据。启动偏好未能保存，下次可能再次尝试升级。')
}

/** No application store is imported before this gate chooses its complete read/write backend. */
export async function initializeDesktopStorage(onProgress?: (progress: MigrationProgress) => void) {
  if (!isTauriRuntime()) return
  const session = await desktopInvoke<StorageMode | null>('desktop_storage_session')
  if (session) {
    // A webview reload is not a process restart. Do not bypass an interrupted restore's checks.
    let current = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
    if (current.pendingRestore) {
      await desktopInvoke('desktop_recover_restore')
      current = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
    }
    if (current.pendingRestore || (session.mode === 'unified' ? current.state !== 'ready' : !canUseLegacy(current)))
      throw new Error('数据状态已变化，请完全退出并重新启动应用；未继续写入')
    activateStorageMode(session)
    await initAppSettings()
    return
  }
  const initial = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
  if (readStartupPreference() === 'legacy' && canUseLegacy(initial)) {
    await continueLegacy(initial, false)
    return
  }
  try {
    await migrateDesktopStorage(onProgress)
  } catch (cause) {
    // The COMMIT may have succeeded even when its IPC reply failed. Never infer failure from an exception.
    const current = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
    if (['ready', 'adopt_legacy_receipt', 'repair_receipt'].includes(current.state) && !current.pendingRestore) {
      await migrateDesktopStorage(onProgress)
    } else if (canUseLegacy(current)) {
      await continueLegacy(current, true)
      console.warn('存储升级未完成，已核验并继续使用旧存储', cause)
      return
    } else {
      throw cause
    }
  }
  const current = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
  await activate({ mode: 'unified' }, current.token)
  // A stale preference cannot override the authoritative database receipt, even if clearing it fails.
  try { localStorage.removeItem(STORAGE_MODE_KEY) } catch { /* non-data startup preference */ }
}
