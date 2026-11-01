/** Agent(Pi版本) 的快捷键表；界面按这张表响应，后续步骤往表里加，不在各处散写按键判断。 */
export type PiShortcutAction = 'search' | 'new' | 'send' | 'stop' | 'pane'

export const PI_SHORTCUTS: Array<{ action: PiShortcutAction; keys: string; label: string }> = [
  { action: 'search', keys: 'mod+k', label: '搜索对话' },
  { action: 'new', keys: 'mod+n', label: '新对话' },
  { action: 'send', keys: 'mod+enter', label: '发送' },
  { action: 'stop', keys: 'escape', label: '停止当前任务' },
  { action: 'pane', keys: 'mod+.', label: '收起或展开右栏' }
]

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function formatKeys(keys: string) {
  return keys
    .split('+')
    .map(part =>
      part === 'mod'
        ? isMac
          ? '⌘'
          : 'Ctrl'
        : part === 'enter'
          ? '↩'
          : part === 'escape'
            ? 'Esc'
            : part.length === 1
              ? part.toUpperCase()
              : part
    )
    .join(isMac ? ' ' : '+')
}

export const shortcutLabel = (action: PiShortcutAction) =>
  formatKeys(PI_SHORTCUTS.find(item => item.action === action)?.keys || '')

/** 输入法合成中、带 Alt/Shift 的组合都不算快捷键。 */
export function matchShortcut(event: KeyboardEvent): PiShortcutAction | null {
  if (event.isComposing || event.altKey || event.shiftKey) return null
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  for (const item of PI_SHORTCUTS) {
    const parts = item.keys.split('+')
    if (parts.includes('mod') !== mod) continue
    const main = parts[parts.length - 1]
    if (main === key || (main.length === 1 && key === main)) return item.action
  }
  return null
}

/** 输入法确认、Shift 换行和 Alt 组合键都不提交消息。Ctrl/⌘+Enter 在两种模式下均可发送。 */
export function isSendShortcut(event: KeyboardEvent, enterToSend: boolean) {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 &&
    !event.shiftKey && !event.altKey && (enterToSend || event.ctrlKey || event.metaKey)
}
