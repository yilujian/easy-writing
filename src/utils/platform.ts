// src/utils/platform.ts

/**
 * 判断当前环境是否为 Mac OS (包含 iOS 设备)
 * 注意：加了 typeof window 判断，防止 SSR 服务端渲染报错
 */
export const isMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
};

/**
 * 获取 AI 强行调用的快捷键名称
 * 用于 UI 展示，例如 Placeholder
 * @returns "Cmd + /" (Mac) 或 "Alt + /" (Win)
 */
export const getAiShortcutTitle = (): string => {
  return isMac() ? 'Cmd + /' : 'Alt + /';
};

/**
 * 检查键盘事件是否触发了 AI 强行补全
 * 逻辑：Mac 使用 Meta(Command) + /，Windows 使用 Alt + /
 * @param e 键盘事件对象
 */
export const isAiShortcut = (e: KeyboardEvent): boolean => {
  if (e.key !== '/') return false;

  // Mac 使用 Meta 键 (Command)，Windows 使用 Alt 键
  return isMac() ? e.metaKey : e.altKey;
};

/**
 * 【新增】检查是否触发 查找/搜索 快捷键
 * 逻辑：Mac 使用 Cmd + F，Windows 使用 Ctrl + F
 * 使用 toLowerCase() 兼容大小写（防止用户开启大写锁定时失效）
 */
export const isFindShortcut = (e: KeyboardEvent): boolean => {
  if (e.key.toLowerCase() !== 'f') return false;

  // Mac 用 Meta(Command), Windows 用 Ctrl
  return isMac() ? e.metaKey : e.ctrlKey;
};

/**
 * 【新增】检查是否触发 保存 快捷键
 * 逻辑：Mac 使用 Cmd + S，Windows 使用 Ctrl + S
 */
export const isSaveShortcut = (e: KeyboardEvent): boolean => {
  if (e.key.toLowerCase() !== 's') return false;

  // Mac 用 Meta(Command), Windows 用 Ctrl
  return isMac() ? e.metaKey : e.ctrlKey;
};

/**
 * 【新增】检查是否触发 "添加至对话" 快捷键
 * 逻辑：Mac 使用 Cmd + U，Windows 使用 Ctrl + U
 */
export const isAddToChatShortcut = (e: KeyboardEvent): boolean => {
  if (e.key.toLowerCase() !== 'l') return false;

  // Mac 用 Meta(Command), Windows 用 Ctrl
  return isMac() ? e.metaKey : e.ctrlKey;
};

export const getWordLibraryShortcutTitle = () => isMac() ? '⌘⇧L' : 'Ctrl+Shift+L';

export const isWordLibraryShortcut = (event: KeyboardEvent) =>
  !event.altKey && event.shiftKey && (isMac() ? event.metaKey : event.ctrlKey)
  && (event.code === 'KeyL' || event.key.toLowerCase() === 'l');
