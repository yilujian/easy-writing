import { watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { useUiPreferencesStore } from '@/stores/ui-preferences'
import { flushAppSettings } from '@/storage/app-settings'
import { applyUiFontSize, normalizeUiFontSize } from '@/utils/ui-typography'

const FONT_EVENT = 'ew-ui-font-size-changed'

/** 挂载前恢复字号；主窗口、参考面板与网页标签页共享用户设置。 */
export function installUiTypography() {
  const preferences = useUiPreferencesStore()
  const stop = watch(() => preferences.uiFontSize, value => applyUiFontSize(value), { immediate: true, flush: 'sync' })
  let disposed = false
  let unlisten: (() => void) | undefined
  const receive = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) preferences.uiFontSize = normalizeUiFontSize(value)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== 'ew-ui-preferences') return
    try {
      preferences.uiFontSize = normalizeUiFontSize(JSON.parse(event.newValue || '{}').uiFontSize)
    } catch { /* 无效的外部设置不覆盖当前显示 */ }
  }
  const publish = () => {
    if (!isTauri()) return
    const fontSize = preferences.uiFontSize
    void flushAppSettings()
      .then(async () => {
        if (disposed) return
        const { emit } = await import('@tauri-apps/api/event')
        await emit(FONT_EVENT, { fontSize })
      })
      .catch(error => console.warn('同步窗口界面字号失败', error))
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('ew-ui-preferences-changed', publish)
  if (isTauri()) {
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const off = await listen<{ fontSize: number }>(FONT_EVENT, event => receive(event.payload?.fontSize))
      if (disposed) off()
      else unlisten = off
    }).catch(error => console.warn('监听窗口界面字号失败', error))
  }
  return () => {
    disposed = true
    stop()
    unlisten?.()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('ew-ui-preferences-changed', publish)
  }
}
