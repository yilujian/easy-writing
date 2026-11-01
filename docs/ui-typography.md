# 界面字号

设置入口：设置中心 → 外观主题 → 界面字号。范围 12–20px，默认基准 14px；默认保持原有字号层级和尺寸。设置中心沿用草稿、取消、保存与恢复默认的交互，预览文字只展示草稿字号。

## 字号来源

- `UiPreferences.uiFontSize` 经统一 `appSettings` 持久化；旧数据缺少字段时为 14。
- `startup/ui-typography.ts` 在应用挂载前恢复根变量；网页标签页通过 storage 事件同步，桌面主窗口与参考窗口通过 Tauri 事件同步，桌面端落盘完成后广播。
- `--ui-font-scale` 是相对 14 的比例。固定 UI 字号使用 `calc(原字号 * var(--ui-font-scale, 1))`，相对 `em` / `inherit` 由父元素传递，不重复乘比例。
- `--ui-control-scale` 不小于 1，用于需要随文字增长的控件高度。Element Plus 的尺寸和字号变量在 `ui-typography.scss`、`element-theme.scss` 中统一适配，包括 body 下的浮层。
- Canvas 图表使用 `uiChartFontSize`，不修改导出图片或封面设计中的字号。

## 正文边界

编辑器仍使用 `WritingEditorStore.fontSize` 和原有排版度量，手机预览跟随正文字号。`.ProseMirror` 和 `.reader-scroll` 的 UI 比例固定为 1。界面字号不改写正文、字号设置或编辑器历史。

## 布局约定

放大时优先让标签、说明、按钮和目录自然换行，控件和弹窗保留滚动空间。写作工具栏按编辑区实际宽度换行；正文区域保留可用宽度。不要用整页 zoom、transform 或运行时遍历正文来实现字号调整。

## 验证

`tests/ui-typography.test.ts` 覆盖旧设置、边界值、草稿和保存、保存失败、恢复默认、正文隔离、网页和桌面窗口同步及监听清理。已有编辑器、段落设置、查找替换和字数统计回归继续保留。
