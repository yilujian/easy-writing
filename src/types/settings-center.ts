import type { TypingSound } from '@/config/typing-sounds'

export type SettingsSectionId =
  | 'overview'
  | 'menus'
  | 'writing'
  | 'appearance'
  | 'sync'
  | 'sensitive'
  | 'record'
  | 'cache'

export interface SettingsNavItem {
  id: SettingsSectionId
  label: string
  icon: string
}

export interface SettingsNavGroup {
  title: string
  items: SettingsNavItem[]
}

export interface SettingsOption<T extends string = string> {
  label: string
  value: T
  description?: string
  icon?: string
}

export interface EditorPreferenceDraft {
  fontFamily: string
  fontSize: number
  fontLineHeight: number
  contentWidth: number
  alignMode: 'left' | 'center' | 'justify'
  entityHighlightEnabled: boolean
  quickPolishToolbarEnabled: boolean
  typingSound: TypingSound
  typingEffect: 'none' | 'splash' | 'ripple' | 'mist' | 'fire' | 'cheer'
  selfDestructMode: 'off' | '10s' | '20s' | '1m' | '5m'
}
