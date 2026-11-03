/** 桌面检查更新命令返回的数据，与 Tauri Update 构造参数一致。 */
export interface DesktopUpdateMetadata {
  rid: number
  currentVersion: string
  version: string
  body?: string
  rawJson: Record<string, unknown>
}
