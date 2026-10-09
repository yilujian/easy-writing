import { appSettings } from '@/storage/app-settings'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { navigationGroups } from '@/config/navigation'
import type { MenuId, UiPreferences, WordCountMode } from '@/types/ui-preferences'

const STORAGE_KEY = 'ew-ui-preferences'
export const defaultUiPreferences = (): UiPreferences => ({ hiddenMenus: [], wordCountMode: 'all', restoreWritingPosition: true })

export function readUiPreferences(): UiPreferences {
  try {
    const value = JSON.parse(appSettings.getItem(STORAGE_KEY) || '{}')
    const ids = new Set(navigationGroups.flatMap(group => group.items.map(item => item.id)))
    return {
      hiddenMenus: Array.isArray(value?.hiddenMenus)
        ? value.hiddenMenus.filter((id: MenuId) => ids.has(id))
        : [],
      wordCountMode: value?.wordCountMode === 'text' ? 'text' : 'all',
      restoreWritingPosition: value?.restoreWritingPosition !== false
    }
  } catch {
    return defaultUiPreferences()
  }
}

export const useUiPreferencesStore = defineStore('ui-preferences', () => {
  const initial = readUiPreferences()
  const hiddenMenus = ref(initial.hiddenMenus)
  const wordCountMode = ref<WordCountMode>(initial.wordCountMode)
  const restoreWritingPosition = ref(initial.restoreWritingPosition)
  const isMenuVisible = (id: MenuId) => !hiddenMenus.value.includes(id)
  function save(value: UiPreferences) {
    const next: UiPreferences = {
      hiddenMenus: [...value.hiddenMenus],
      wordCountMode: value.wordCountMode,
      restoreWritingPosition: value.restoreWritingPosition !== false,
    }
    // 先持久化再更新页面；写入失败时由设置中心统一提示，不伪装成已保存。
    appSettings.setItem(STORAGE_KEY, JSON.stringify(next))
    hiddenMenus.value = next.hiddenMenus
    wordCountMode.value = next.wordCountMode
    restoreWritingPosition.value = next.restoreWritingPosition
    window.dispatchEvent(new CustomEvent('ew-ui-preferences-changed'))
  }
  return { hiddenMenus, wordCountMode, restoreWritingPosition, isMenuVisible, save }
})
