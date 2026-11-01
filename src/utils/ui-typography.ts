export const DEFAULT_UI_FONT_SIZE = 14
export const MIN_UI_FONT_SIZE = 12
export const MAX_UI_FONT_SIZE = 20

export function normalizeUiFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_FONT_SIZE
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(value)))
}

/** 只调整界面文字比例，正文保留自己的字号；默认比例为 1。 */
export function applyUiFontSize(value: unknown, root = document.documentElement) {
  const size = normalizeUiFontSize(value)
  root.style.setProperty('--ui-font-scale', String(size / DEFAULT_UI_FONT_SIZE))
  root.style.setProperty('--ui-control-scale', String(Math.max(1, size / DEFAULT_UI_FONT_SIZE)))
  root.dataset.uiFontSize = String(size)
  root.toggleAttribute('data-ui-enlarged', size > DEFAULT_UI_FONT_SIZE)
}

/** Canvas 图表不能读取 CSS font-size，使用与界面相同的比例。 */
export function uiChartFontSize(base: number): number {
  const scale = Number(document.documentElement.style.getPropertyValue('--ui-font-scale')) || 1
  return base * scale
}
