import type { UiPreferences } from '@/types/ui-preferences'
import { inject, type InjectionKey, type Ref } from 'vue'
import type { LocalWritingSettings } from '@/storage'
import type { EditorPreferenceDraft, SettingsSectionId } from '@/types/settings-center'

/**
 * 设置中心跨分区共享的草稿与动作。
 * 用 provide/inject 而不是 props：草稿对象要被各分区直接编辑，
 * 走 props 会撞 vue/no-mutating-props 红线。
 */
export interface SettingsCenterContext {
  settingsDraft: Ref<LocalWritingSettings>
  editorDraft: EditorPreferenceDraft
  uiDraft: UiPreferences
  selectedTheme: Ref<string>
  selectedSkin: Ref<string>
  desktopSupported: boolean
  loading: Ref<boolean>
  bookId: Ref<string | number | undefined>
  navigate: (id: SettingsSectionId) => void
  close: () => void
}

export const SETTINGS_CENTER_CTX: InjectionKey<SettingsCenterContext> = Symbol('settings-center-ctx')

export const useSettingsCenterCtx = (): SettingsCenterContext => {
  const ctx = inject(SETTINGS_CENTER_CTX)
  if (!ctx) throw new Error('SettingsCenter 分区必须挂在 SettingsCenterModal 内使用')
  return ctx
}
