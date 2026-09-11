import { defineStore } from 'pinia'
import { ref } from 'vue'
import { navigationGroups } from '@/config/navigation'
import type { MenuId, UiPreferences, WordCountMode } from '@/types/ui-preferences'

const STORAGE_KEY = 'ew-ui-preferences'
export const defaultUiPreferences = (): UiPreferences => ({ hiddenMenus: [], wordCountMode: 'all' })

export function readUiPreferences(): UiPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    const ids = new Set(navigationGroups.flatMap(group => group.items.map(item => item.id)))
    return {
      hiddenMenus: Array.isArray(value?.hiddenMenus)
        ? value.hiddenMenus.filter((id: MenuId) => ids.has(id))
        : [],
      wordCountMode: value?.wordCountMode === 'text' ? 'text' : 'all'
    }
  } catch {
    return defaultUiPreferences()
  }
}

export const useUiPreferencesStore = defineStore('ui-preferences', () => {
  const initial = readUiPreferences()
  const hiddenMenus = ref(initial.hiddenMenus)
  const wordCountMode = ref<WordCountMode>(initial.wordCountMode)
  const isMenuVisible = (id: MenuId) => !hiddenMenus.value.includes(id)
  function save(value: UiPreferences) {
    const next = { hiddenMenus: [...value.hiddenMenus], wordCountMode: value.wordCountMode }
    // 先持久化再更新页面；写入失败时由设置中心统一提示，不伪装成已保存。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    hiddenMenus.value = next.hiddenMenus
    wordCountMode.value = next.wordCountMode
    window.dispatchEvent(new CustomEvent('ew-ui-preferences-changed'))
  }
  return { hiddenMenus, wordCountMode, isMenuVisible, save }
})
