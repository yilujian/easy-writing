<template>
  <div class="desktop-titlebar" :class="[`is-${platform}`, { 'is-maximized': isMaximized, 'is-panel-window': isPanelWindow }]">
    <div
      v-if="isWindows && !isMaximized"
      class="desktop-resize-layer"
      aria-hidden="true"
    >
      <span
        v-for="handle in resizeHandles"
        :key="handle.direction"
        class="desktop-resize-handle"
        :class="`is-${handle.className}`"
        @pointerdown.prevent.stop="startResize(handle.direction)"
      ></span>
    </div>

    <header class="desktop-titlebar-main" data-tauri-drag-region @dblclick="toggleMaximize">
      <template v-if="!isPanelWindow">
        <!-- 左侧导航区：mac 留红绿灯位；Windows 显示 ☰ 菜单 -->
        <div class="titlebar-nav" data-tauri-drag-region>
          <span v-if="isMac" class="titlebar-traffic-spacer" data-tauri-drag-region></span>
          <button
            v-if="isWindows && isMainWindow"
            type="button"
            class="titlebar-icon-button titlebar-menu-trigger"
            :class="{ active: menuOpen }"
            title="菜单"
            @mousedown.prevent
            @click.stop="toggleMenu($event)"
            @dblclick.stop
          >
            <i class="fa-solid fa-bars"></i>
          </button>
          <button
            type="button"
            class="titlebar-icon-button"
            title="返回"
            :disabled="!canGoBack"
            @click.stop="goBack"
            @dblclick.stop
          >
            <i class="fa-solid fa-arrow-left"></i>
          </button>
          <button
            type="button"
            class="titlebar-icon-button"
            title="前进"
            :disabled="!canGoForward"
            @click.stop="goForward"
            @dblclick.stop
          >
            <i class="fa-solid fa-arrow-right"></i>
          </button>
          <span class="titlebar-divider" aria-hidden="true"></span>
          <span class="titlebar-page-title" data-tauri-drag-region>{{ pageTitle }}</span>
        </div>

        <div class="desktop-titlebar-drag" data-tauri-drag-region></div>

        <!-- 中间：全局搜索触发框（视觉是输入框，实际是按钮） -->
        <button
          v-if="!isSlimPage"
          type="button"
          class="titlebar-search"
          @click.stop="openGlobalSearch"
          @dblclick.stop
        >
          <i class="fa-solid fa-magnifying-glass"></i>
          <span class="titlebar-search-placeholder">搜索作品或功能…</span>
          <span class="titlebar-search-kbd">{{ isMac ? '⌘ K' : 'Ctrl K' }}</span>
        </button>

        <div class="desktop-titlebar-drag" data-tauri-drag-region></div>

        <!-- 右侧：保存状态 / 新建作品 -->
        <div v-if="!isSlimPage" class="titlebar-actions" @dblclick.stop>
          <button
            type="button"
            class="titlebar-sync"
            :class="`is-${syncStatus}`"
            :title="syncDescription"
            @click.stop="showSyncInfo"
          >
            <i v-if="syncStatus === 'syncing'" class="fa-solid fa-rotate fa-spin"></i>
            <span v-else class="titlebar-sync-dot"></span>
            <span>{{ syncLabel }}</span>
          </button>
          <button type="button" class="titlebar-pill is-primary" @click.stop="createBook">
            <i class="fa-solid fa-pen-nib"></i>
            <span>新建作品</span>
          </button>
        </div>
      </template>

      <div v-else class="desktop-titlebar-drag" data-tauri-drag-region></div>

      <div v-if="isWindows" class="desktop-titlebar-controls" @dblclick.stop>
        <button type="button" class="desktop-window-button" title="最小化" @click.stop="minimizeWindow">
          <i class="fa-solid fa-minus"></i>
        </button>
        <button type="button" class="desktop-window-button" :title="isMaximized ? '还原' : '最大化'" @click.stop="toggleMaximize">
          <i :class="isMaximized ? 'fa-regular fa-window-restore' : 'fa-regular fa-square'"></i>
        </button>
        <button type="button" class="desktop-window-button is-close" title="关闭" @click.stop="closeWindow">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>

    <!-- Windows ☰ 菜单：五组全量收纳的分组下拉 -->
    <div
      v-if="menuOpen"
      class="desktop-titlebar-menu-popover"
      :style="{ left: `${menuPopoverLeft}px` }"
      @mousedown.prevent
      @click.stop
    >
      <template v-for="(group, groupIndex) in menuGroups" :key="group.id">
        <div v-if="groupIndex > 0" class="desktop-titlebar-menu-separator is-group"></div>
        <div class="desktop-titlebar-menu-group-title">{{ group.label }}</div>
        <template v-for="item in group.items" :key="item.id">
          <div v-if="item.separator" class="desktop-titlebar-menu-separator"></div>
          <button
            v-else
            type="button"
            class="desktop-titlebar-menu-item"
            :disabled="item.disabled"
            @click="runMenuAction(item)"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.shortcut" class="desktop-titlebar-menu-shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke } from '@tauri-apps/api/core'
import type { Window as TauriWindow } from '@tauri-apps/api/window'
import { getDesktopPlatform } from '@/utils/desktop-window'
import { useGlobalSyncStatus } from '@/composables/useGlobalSyncStatus'

type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'
type MenuGroupId = 'app' | 'edit' | 'view' | 'window' | 'help'

interface TitlebarMenuItem {
  id: string
  label?: string
  shortcut?: string
  separator?: boolean
  disabled?: boolean
  action?: () => void | Promise<void>
}

interface TitlebarMenuGroup {
  id: MenuGroupId
  label: string
  items: TitlebarMenuItem[]
}

const router = useRouter()
const route = useRoute()
const platform = getDesktopPlatform()
const isWindows = platform === 'windows'
const isMac = platform === 'macos'
const isMainWindow = ref(false)
const isMaximized = ref(false)
const windowLabel = ref('')
const menuOpen = ref(false)
const menuPopoverLeft = ref(0)
const unlistenFns: Array<() => void> = []
let appWindow: TauriWindow | null = null
const isPanelWindow = computed(() => windowLabel.value.startsWith('writing-panel-') || window.location.pathname.startsWith('/writing-panel/'))

// 写作/拆解工作台等沉浸页：只保留导航 + 拖拽 + 窗口按钮的精简形态。
const isSlimPage = computed(() => route.meta.hideLayout === true)
const pageTitle = computed(() => String(route.meta.title || ''))

// 无边框 Windows 窗口需要显式声明四边和四角拖拽方向。
const resizeHandles: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: 'North', className: 'north' },
  { direction: 'South', className: 'south' },
  { direction: 'West', className: 'west' },
  { direction: 'East', className: 'east' },
  { direction: 'NorthWest', className: 'north-west' },
  { direction: 'NorthEast', className: 'north-east' },
  { direction: 'SouthWest', className: 'south-west' },
  { direction: 'SouthEast', className: 'south-east' },
]

// ---------- 返回 / 前进 ----------
const canGoBack = ref(false)
const canGoForward = ref(false)

// Vue Router 4 会在 history.state 里维护 back/forward，路由变化后刷新可用性。
const refreshNavAvailability = () => {
  const state = window.history.state as { back?: unknown; forward?: unknown } | null
  canGoBack.value = Boolean(state?.back)
  canGoForward.value = Boolean(state?.forward)
}

watch(
  () => route.fullPath,
  () => { void nextTick(refreshNavAvailability) },
  { immediate: true }
)

const goBack = () => {
  if (canGoBack.value) router.back()
}

const goForward = () => {
  if (canGoForward.value) router.forward()
}

// ---------- 全局搜索 / 新建作品 ----------
const openGlobalSearch = () => {
  window.dispatchEvent(new CustomEvent('ew:global-search-open'))
}

const createBook = () => {
  void router.push({ path: '/myBooks', query: { create: '1' } })
}

// ---------- 保存状态 ----------
const { status: syncStatus, label: syncLabel, description: syncDescription } = useGlobalSyncStatus()

const showSyncInfo = () => {
  ElMessage({
    type: syncStatus.value === 'unsynced' ? 'warning' : 'info',
    message: syncDescription.value,
  })
}

// ---------- 窗口控制 ----------
const closeMenu = () => {
  menuOpen.value = false
}

const syncMaximized = async () => {
  if (!appWindow) return
  isMaximized.value = await appWindow.isMaximized().catch(() => false)
}

const minimizeWindow = async () => {
  await appWindow?.minimize()
}

const toggleMaximize = async () => {
  await appWindow?.toggleMaximize()
  await syncMaximized()
}

const closeWindow = async () => {
  await appWindow?.close()
}

const startResize = async (direction: ResizeDirection) => {
  await appWindow?.startResizeDragging(direction)
}

const execEditCommand = (command: string) => {
  document.execCommand(command)
}

const showAbout = async () => {
  await ElMessageBox.alert('易创桌面客户端', '关于易创', {
    confirmButtonText: '知道了',
  })
}

const openFeedback = async () => {
  await router.push('/feedback')
}

const reloadWindow = () => {
  window.location.reload()
}

const toggleFullscreen = async () => {
  if (!appWindow) return
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()))
}

const toggleDevtools = async () => {
  if (import.meta.env.DEV) {
    await invoke('toggle_devtools')
  }
}

// Windows 不使用原生菜单，五组桌面端常用动作全量收纳进 ☰ 下拉。
const menuGroups = computed<TitlebarMenuGroup[]>(() => [
  {
    id: 'app',
    label: '易创',
    items: [
      { id: 'about', label: '关于易创', action: showAbout },
      { id: 'app-sep-1', separator: true },
      { id: 'feedback', label: '问题反馈', action: openFeedback },
      { id: 'quit', label: '退出易创', action: closeWindow },
    ],
  },
  {
    id: 'edit',
    label: '编辑',
    items: [
      { id: 'undo', label: '撤销', shortcut: 'Ctrl+Z', action: () => execEditCommand('undo') },
      { id: 'redo', label: '重做', shortcut: 'Ctrl+Y', action: () => execEditCommand('redo') },
      { id: 'edit-sep-1', separator: true },
      { id: 'cut', label: '剪切', shortcut: 'Ctrl+X', action: () => execEditCommand('cut') },
      { id: 'copy', label: '复制', shortcut: 'Ctrl+C', action: () => execEditCommand('copy') },
      { id: 'paste', label: '粘贴', shortcut: 'Ctrl+V', action: () => execEditCommand('paste') },
      { id: 'select-all', label: '全选', shortcut: 'Ctrl+A', action: () => execEditCommand('selectAll') },
    ],
  },
  {
    id: 'view',
    label: '显示',
    items: [
      { id: 'reload', label: '重新加载', shortcut: 'Ctrl+R', action: reloadWindow },
      ...(import.meta.env.DEV ? [{ id: 'devtools', label: '开发者工具', shortcut: 'Ctrl+Shift+I', action: toggleDevtools }] : []),
      { id: 'view-sep-1', separator: true },
      { id: 'fullscreen', label: '进入全屏', action: toggleFullscreen },
    ],
  },
  {
    id: 'window',
    label: '窗口',
    items: [
      { id: 'minimize', label: '最小化', action: minimizeWindow },
      { id: 'maximize', label: isMaximized.value ? '还原窗口' : '最大化', action: toggleMaximize },
      { id: 'window-sep-1', separator: true },
      { id: 'close', label: '关闭窗口', action: closeWindow },
    ],
  },
  {
    id: 'help',
    label: '帮助',
    items: [
      { id: 'help-feedback', label: '问题反馈', action: openFeedback },
    ],
  },
])

const toggleMenu = (event: MouseEvent) => {
  menuOpen.value = !menuOpen.value
  menuPopoverLeft.value = (event.currentTarget as HTMLElement).getBoundingClientRect().left
}

const runMenuAction = async (item: TitlebarMenuItem) => {
  if (item.disabled || !item.action) return
  closeMenu()
  await item.action()
}

const handleOutsidePointer = (event: PointerEvent) => {
  const target = event.target as HTMLElement | null
  if (target?.closest('.titlebar-menu-trigger, .desktop-titlebar-menu-popover')) return
  closeMenu()
}

onMounted(async () => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  appWindow = getCurrentWindow()
  windowLabel.value = appWindow.label
  // 主窗口和弹出窗口共用标题栏，只有主窗口显示菜单。
  isMainWindow.value = appWindow.label === 'main'
  await syncMaximized()
  unlistenFns.push(await appWindow.onResized(syncMaximized))
  window.addEventListener('pointerdown', handleOutsidePointer)
  window.addEventListener('popstate', refreshNavAvailability)
})

onBeforeUnmount(() => {
  unlistenFns.forEach(unlisten => unlisten())
  window.removeEventListener('pointerdown', handleOutsidePointer)
  window.removeEventListener('popstate', refreshNavAvailability)
})
</script>

<style scoped lang="scss">
.desktop-titlebar {
  position: relative;
  z-index: 1000;
  flex: 0 0 var(--desktop-titlebar-height, 44px);
  height: var(--desktop-titlebar-height, 44px);
  color: var(--ink-main);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-main) 94%, #ffffff 6%), color-mix(in srgb, var(--bg-main) 86%, var(--ink-main) 3%)),
    color-mix(in srgb, var(--bg-main) 92%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
  user-select: none;
  -webkit-user-select: none;
}

.desktop-titlebar.is-panel-window {
  flex-basis: 36px;
  height: 36px;
}

.desktop-titlebar-main {
  height: 100%;
  display: flex;
  align-items: center;
  min-width: 0;
}

/* ---------- 左侧导航区 ---------- */
.titlebar-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding: 0 8px;
  flex: 0 0 auto;
  min-width: 0;
}

/* mac 原生红绿灯 overlay 在 (16,24)，左侧预留空拖拽位 */
.titlebar-traffic-spacer {
  flex: 0 0 80px;
  height: 100%;
}

.titlebar-icon-button {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-main);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, opacity 0.16s ease;

  i {
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1;
  }

  &:hover:not(:disabled),
  &.active {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.titlebar-divider {
  flex: 0 0 1px;
  width: 1px;
  height: 16px;
  margin: 0 6px;
  background: color-mix(in srgb, var(--ink-main) 16%, transparent);
}

.titlebar-page-title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-main);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 44px;
}

/* ---------- 中间搜索触发框 ---------- */
.titlebar-search {
  flex: 0 1 480px;
  min-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 14%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ink-main) 5%, transparent);
  color: var(--ink-sec);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;

  > i {
    flex: 0 0 auto;
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  &:hover {
    border-color: color-mix(in srgb, var(--ink-accent) 40%, transparent);
    background: color-mix(in srgb, var(--ink-main) 8%, transparent);
  }
}

.titlebar-search-placeholder {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.titlebar-search-kbd {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 16%, transparent);
  border-radius: 5px;
  font-size: calc(10.5px * var(--ui-font-scale, 1));
  line-height: 1.5;
  color: var(--ink-sec);
}

/* ---------- 右侧操作区 ---------- */
.titlebar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding: 0 10px;
  flex: 0 0 auto;
}

.titlebar-sync {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
  transition: background 0.16s ease;

  &:hover {
    background: color-mix(in srgb, var(--ink-main) 8%, transparent);
  }

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
    color: var(--ink-accent);
  }
}

.titlebar-sync-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state-success);
}

.titlebar-sync.is-unsynced .titlebar-sync-dot {
  background: var(--state-warning);
}

.titlebar-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, filter 0.16s ease;

  i {
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.titlebar-pill.is-outline {
  border: 1px solid color-mix(in srgb, var(--ink-accent) 45%, transparent);
  background: transparent;
  color: var(--ink-accent);

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  }
}

.titlebar-pill.is-primary {
  border: 1px solid var(--btn-primary-bg, var(--ink-accent));
  background: var(--btn-primary-bg, var(--ink-accent));
  color: var(--btn-primary-color, #fff);

  &:hover {
    filter: brightness(1.08);
  }
}

/* ---------- 拖拽区 / 窗口按钮（沿用原实现） ---------- */
.desktop-titlebar-drag {
  flex: 1 1 auto;
  height: 100%;
  min-width: 16px;
}

.desktop-titlebar-controls {
  position: relative;
  z-index: 1300;
  display: flex;
  align-items: stretch;
  align-self: stretch;
  height: 100%;
  margin-left: auto;
}

.desktop-window-button {
  width: 46px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-main);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;

  i {
    display: block;
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1;
  }

  &:hover {
    background: color-mix(in srgb, var(--ink-main) 10%, transparent);
  }

  &.is-close:hover {
    color: #fff;
    background: #c42b1c;
  }
}

.desktop-titlebar.is-panel-window .desktop-titlebar-controls {
  align-self: center;
  height: 28px;
  margin-right: 8px;
  gap: 4px;
}

.desktop-titlebar.is-panel-window .desktop-window-button {
  width: 32px;
  height: 28px;
  border-radius: 6px;

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }
}

/* ---------- ☰ 分组菜单 ---------- */
.desktop-titlebar-menu-popover {
  position: fixed;
  top: var(--desktop-titlebar-height, 44px);
  z-index: 1300;
  width: 208px;
  max-height: calc(100vh - var(--desktop-titlebar-height, 44px) - 16px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-main) 94%, #ffffff 6%);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--ink-main) 18%, transparent);
  backdrop-filter: blur(14px);
}

.desktop-titlebar-menu-group-title {
  padding: 6px 9px 3px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  letter-spacing: 0.06em;
}

.desktop-titlebar-menu-item {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-main);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &:disabled {
    opacity: 0.48;
    cursor: default;
  }
}

.desktop-titlebar-menu-shortcut {
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.desktop-titlebar-menu-separator {
  height: 1px;
  margin: 5px 6px;
  background: color-mix(in srgb, var(--ink-main) 12%, transparent);
}

.desktop-titlebar-menu-separator.is-group {
  margin: 7px 2px 3px;
}

/* ---------- 窗口 resize handles（沿用原实现） ---------- */
.desktop-resize-layer {
  position: fixed;
  inset: 0;
  z-index: 1200;
  pointer-events: none;
}

.desktop-resize-handle {
  position: fixed;
  pointer-events: auto;
}

.desktop-resize-handle.is-north,
.desktop-resize-handle.is-south {
  left: 7px;
  right: 7px;
  height: 7px;
  cursor: ns-resize;
}

.desktop-resize-handle.is-north {
  top: 0;
}

.desktop-resize-handle.is-south {
  bottom: 0;
}

.desktop-resize-handle.is-west,
.desktop-resize-handle.is-east {
  top: 7px;
  bottom: 7px;
  width: 7px;
  cursor: ew-resize;
}

.desktop-resize-handle.is-west {
  left: 0;
}

.desktop-resize-handle.is-east {
  right: 0;
}

.desktop-resize-handle.is-north-west,
.desktop-resize-handle.is-north-east,
.desktop-resize-handle.is-south-west,
.desktop-resize-handle.is-south-east {
  width: 12px;
  height: 12px;
}

.desktop-resize-handle.is-north-west {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.desktop-resize-handle.is-north-east {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.desktop-resize-handle.is-south-west {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.desktop-resize-handle.is-south-east {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
}

.theme-dark .desktop-titlebar {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-main) 88%, #ffffff 5%), color-mix(in srgb, var(--bg-main) 92%, #000 8%)),
    var(--bg-main);
}

.theme-dark .titlebar-search {
  background: color-mix(in srgb, #ffffff 6%, transparent);
  border-color: color-mix(in srgb, #ffffff 16%, transparent);
}

.theme-dark .titlebar-sync-dot {
  filter: brightness(1.2);
}
</style>
