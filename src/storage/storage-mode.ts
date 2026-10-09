import { isTauriRuntime } from './writing-storage'

export type StorageMode = { mode: 'unified' } | { mode: 'legacy'; core: 'sqlite' | 'indexeddb' }
// This is a startup preference, not user data; never migrate or restore it from a backup.
export const STORAGE_MODE_KEY = 'ew-desktop-storage-startup'
let selected: StorageMode = { mode: 'unified' }
let activated = false
let notice = ''

export function activateStorageMode(mode: StorageMode) {
  if (activated && JSON.stringify(selected) !== JSON.stringify(mode))
    throw new Error('存储模式只能在启动时切换，请先保存并重新启动')
  selected = mode
  activated = true
}
export const getStorageMode = () => selected
export const usesUnifiedStorage = () => isTauriRuntime() && selected.mode === 'unified'
export const usesSqliteCore = () => isTauriRuntime() && (selected.mode === 'unified' || selected.core === 'sqlite')
export const setStorageStartupNotice = (message: string) => { notice = message }
export const takeStorageStartupNotice = () => { const message = notice; notice = ''; return message }

export function readStartupPreference(): 'legacy' | 'retry' | null {
  try {
    const value = localStorage.getItem(STORAGE_MODE_KEY)
    return value === 'legacy' || value === 'retry' ? value : null
  } catch { return null }
}
