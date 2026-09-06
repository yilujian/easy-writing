<!-- Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md. -->
<template>
  <el-config-provider :locale="zhCn">
  <div id="app" :class="{ 'desktop-shell': desktopShell, 'web-shell': !desktopShell }">
    <DesktopTitleBar v-if="desktopShell" />
    <GlobalSearchPalette />

    <div class="app-shell-body">
      <!-- 背景层 -->
      <div class="ink-bg-container">
        <img :src="themeStore.currentSkinObj.img" class="ink-bg-image" alt="" @error="(e) => ((e.target as HTMLElement).style.visibility = 'hidden')" />
      </div>
      <div class="paper-texture"></div>

      <!-- 路由视图 -->
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </div>

    <DesktopUpdateModal
      :visible="desktopUpdateVisible"
      :state="desktopUpdateState"
      :release-notes-only="desktopUpdateNotesOnly"
      @close="closeDesktopUpdateNotes"
      @retry="retryDesktopUpdate"
      @update="startDesktopUpdate"
      @restart="restartAfterDesktopUpdate"
    />

    <!-- 关窗保存提示：关闭前快照/备份期间给出可见反馈，避免"点了没反应"的观感 -->
    <div v-if="desktopClosing" class="app-closing-overlay">
      <div class="app-closing-card">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>正在保存并备份您的作品，即将退出…</span>
      </div>
    </div>

    <div
      v-if="appContextMenuVisible"
      class="app-context-menu"
      :style="{ left: `${appContextMenuX}px`, top: `${appContextMenuY}px` }"
      @mousedown.prevent
      @click.stop
    >
      <button
        v-for="item in appContextMenuItems"
        :key="item.action"
        type="button"
        @click="handleAppContextMenuAction(item.action)"
      >
        {{ item.label }}
      </button>
    </div>
  </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { ref, onBeforeUnmount, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useThemeStore } from '@/stores/theme'
import { isTauriRuntime } from '@/storage'
import { getLocalBackupService } from '@/storage/local-backup-service'
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  dismissDesktopUpdate,
  consumePendingDesktopUpdateNotes,
  type DesktopUpdateSnapshot,
} from '@/utils/desktop-update'
import { OFFICIAL_DOWNLOAD_URL } from '@/config/opensource'
import { openLink } from '@/utils/external-link'
import DesktopTitleBar from '@/components/DesktopTitleBar.vue'
import GlobalSearchPalette from '@/components/GlobalSearchPalette.vue'
import DesktopUpdateModal from '@/components/DesktopUpdateModal.vue'

const themeStore = useThemeStore()
const backupService = getLocalBackupService()
const desktopShell = isTauriRuntime()
let automaticUpdateTimer: ReturnType<typeof setTimeout> | null = null
let updateCheckPromise: Promise<void> | null = null
let manualUpdateFeedback = false
let manualUpdateMessage: ReturnType<typeof ElMessage> | null = null
const runtimeBodyClass = desktopShell ? 'desktop-runtime' : 'web-runtime'

type AppContextAction = 'cut' | 'copy' | 'paste' | 'selectAll'

const appContextMenuVisible = ref(false)
const appContextMenuX = ref(0)
const appContextMenuY = ref(0)
const appContextMenuItems = ref<Array<{ label: string; action: AppContextAction }>>([])
let appContextTarget: HTMLElement | null = null
let unlistenCloseRequested: (() => void) | null = null
let desktopCloseConfirmed = false

const desktopUpdateVisible = ref(false)
// 关窗保存进行中（遮罩提示）
const desktopClosing = ref(false)
const desktopUpdateNotesOnly = ref(false)
const desktopUpdateState = ref<DesktopUpdateSnapshot>({
  phase: 'checking',
  message: '正在检查新版本...',
})
// 仅供本地开发验收真实更新弹窗，正式构建会移除该入口。
const desktopUpdatePreviewEnabled =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get('previewUpdate') === '1'

const closeAppContextMenu = () => {
  appContextMenuVisible.value = false
  appContextTarget = null
}

const getEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return null
  const editable = target.closest('input, textarea, [contenteditable="true"]') as HTMLElement | null
  if (editable instanceof HTMLInputElement) {
    return ['', 'text', 'search', 'url', 'tel', 'password', 'email'].includes(editable.type) ? editable : null
  }
  return editable
}

const isReadonlyEditable = (target: HTMLElement) => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.disabled || target.readOnly
  }
  return false
}

const setContextMenuPosition = (event: MouseEvent, itemCount: number) => {
  appContextMenuX.value = Math.min(event.clientX, window.innerWidth - 172)
  appContextMenuY.value = Math.min(event.clientY, window.innerHeight - itemCount * 36 - 12)
}

const showAppContextMenu = (event: MouseEvent, items: Array<{ label: string; action: AppContextAction }>, target: HTMLElement | null) => {
  appContextTarget = target
  appContextMenuItems.value = items
  setContextMenuPosition(event, items.length)
  appContextMenuVisible.value = true
}

const handleGlobalContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  closeAppContextMenu()

  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('.app-context-menu, .context-menu, .custom-bubble-menu, .ai-bubble-menu, .editor-wrapper, .ProseMirror, .reference-panel-content, .outline-tree, .setting-tree')) {
    return
  }

  const editable = getEditableTarget(target)
  if (editable) {
    const readonly = isReadonlyEditable(editable)
    const items: Array<{ label: string; action: AppContextAction }> = readonly
      ? [{ label: '复制', action: 'copy' }, { label: '全选', action: 'selectAll' }]
      : [
          { label: '剪切', action: 'cut' },
          { label: '复制', action: 'copy' },
          { label: '粘贴', action: 'paste' },
          { label: '全选', action: 'selectAll' },
        ]
    showAppContextMenu(event, items, editable)
    return
  }

  if (window.getSelection()?.toString()) {
    showAppContextMenu(event, [{ label: '复制', action: 'copy' }], null)
  }
}

const insertTextToContextTarget = (text: string) => {
  const target = appContextTarget
  if (!target) return
  target.focus({ preventScroll: true })
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    target.setRangeText(text, start, end, 'end')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  document.execCommand('insertText', false, text)
}

const selectContextTargetText = () => {
  const target = appContextTarget
  if (!target) return
  target.focus({ preventScroll: true })
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(target)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const handleAppContextMenuAction = async (action: AppContextAction) => {
  if (action === 'selectAll') {
    selectContextTargetText()
  } else if (action === 'paste') {
    const text = navigator.clipboard?.readText
      ? await navigator.clipboard.readText().catch(() => '')
      : ''
    if (text) {
      insertTextToContextTarget(text)
    } else {
      document.execCommand('paste')
    }
  } else {
    appContextTarget?.focus({ preventScroll: true })
    document.execCommand(action)
  }
  closeAppContextMenu()
}

const destroyDesktopSubWindows = async () => {
  if (!isTauriRuntime()) return
  const { getAllWindows } = await import('@tauri-apps/api/window')
  const subWindows = (await getAllWindows()).filter((item) => item.label !== 'main')
  // 主窗口退出前统一销毁独立子窗口，避免 Tauri 进程留下可见窗口。
  await Promise.allSettled(subWindows.map((item) => item.destroy()))
}

const setupDesktopCloseBackup = async () => {
  if (!isTauriRuntime()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const { ask } = await import('@tauri-apps/plugin-dialog')
    const appWindow = getCurrentWindow()
    if (appWindow.label !== 'main') return
    unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
      if (desktopCloseConfirmed) return
      event.preventDefault()
      desktopClosing.value = true

      try {
        const backup = await backupService.backupBeforeExit()
        if (!backup.ok) {
          desktopClosing.value = false
          const message = backup.result.failed[0]?.message || '本地备份失败'
          const shouldExit = await ask(`本地备份失败：${message}。是否仍然退出？`, {
            title: '本地备份失败',
            kind: 'warning',
          })
          if (!shouldExit) return
          desktopClosing.value = true
        }
      } catch {
        desktopClosing.value = false
        const shouldExit = await ask('关闭前备份失败，是否仍然退出？', {
          title: '本地备份失败',
          kind: 'warning',
        }).catch(() => true)
        if (!shouldExit) return
        desktopClosing.value = true
      }

      desktopCloseConfirmed = true
      try {
        await destroyDesktopSubWindows()
      } finally {
        await appWindow.destroy()
      }
    })
  } catch (error) {
    console.error('setup desktop close backup failed', error)
  }
}

const applyDesktopUpdateState = (state: DesktopUpdateSnapshot) => {
  desktopUpdateState.value = state
  if (state.phase !== 'checking') {
    desktopUpdateNotesOnly.value = false
    desktopUpdateVisible.value = state.phase !== 'error' || Boolean(state.info) || manualUpdateFeedback
  }
}

const runDesktopUpdateCheck = async (silent = false) => {
  if (!silent && automaticUpdateTimer) {
    clearTimeout(automaticUpdateTimer)
    automaticUpdateTimer = null
  }
  if (!desktopShell) {
    if (!silent) void openLink(OFFICIAL_DOWNLOAD_URL, { title: '官网下载' })
    return
  }
  if (['downloading', 'preparing', 'installing', 'installed'].includes(desktopUpdateState.value.phase)
    && !desktopUpdateNotesOnly.value) {
    if (!silent) desktopUpdateVisible.value = true
    return
  }
  if (silent && desktopUpdateVisible.value) return
  if (!silent) {
    manualUpdateFeedback = true
    manualUpdateMessage ??= ElMessage({ type: 'info', message: '正在检查更新…', duration: 0 })
  }
  if (updateCheckPromise) return updateCheckPromise
  desktopUpdateVisible.value = false
  desktopUpdateNotesOnly.value = false
  updateCheckPromise = (async () => {
    const result = await checkDesktopUpdate({ onStateChange: applyDesktopUpdateState })
    if (result.status === 'latest' && manualUpdateFeedback) ElMessage.success('当前已是最新版本')
  })()
  try {
    await updateCheckPromise
  } finally {
    manualUpdateMessage?.close()
    manualUpdateMessage = null
    manualUpdateFeedback = false
    updateCheckPromise = null
  }
}

const prepareDesktopUpdate = async () => {
  const backup = await backupService.backupBeforeExit({ requireSnapshotConfirmation: true })
  if (!backup.ok) throw new Error(backup.result.failed[0]?.message || '作品保存失败，已暂停更新，请保存后重试。')
  const { flushWriteJournal } = await import('@/storage/write-journal')
  await flushWriteJournal()
}

const startDesktopUpdate = async () => {
  if (desktopUpdatePreviewEnabled) return
  await installDesktopUpdate({ beforeInstall: prepareDesktopUpdate, onStateChange: applyDesktopUpdateState })
}

const showPendingDesktopUpdateNotes = async () => {
  const info = await consumePendingDesktopUpdateNotes()
  if (!info) return
  desktopUpdateState.value = {
    phase: 'installed',
    info,
    message: '已完成版本更新。',
  }
  desktopUpdateNotesOnly.value = true
  desktopUpdateVisible.value = true
}

const showDesktopUpdatePreview = () => {
  desktopUpdateState.value = {
    phase: 'available',
    info: {
      currentVersion: '1.0.5',
      version: '1.0.6',
      date: '2026-09-04T10:00:00+08:00',
      body: [
        '1. 支持从官网检查并安装新版本；',
        '2. 更新前展示版本说明与下载进度；',
        '3. 安装前自动保存并备份作品。',
      ].join('\n'),
    },
    message: '本地样式预览，不会下载安装。',
  }
  desktopUpdateNotesOnly.value = false
  desktopUpdateVisible.value = true
}

const handleDesktopUpdateRequest = () => {
  void runDesktopUpdateCheck(false)
}

const retryDesktopUpdate = () => {
  void runDesktopUpdateCheck(false)
}

const closeDesktopUpdateNotes = () => {
  if (['downloading', 'preparing', 'installing'].includes(desktopUpdateState.value.phase)) return
  void dismissDesktopUpdate()
  if (desktopUpdateNotesOnly.value) {
    desktopUpdateState.value = { phase: 'checking', message: '正在检查新版本...' }
  }
  desktopUpdateVisible.value = false
  desktopUpdateNotesOnly.value = false
}

let updateRestarting = false
const restartAfterDesktopUpdate = async () => {
  if (!isTauriRuntime() || updateRestarting) return
  updateRestarting = true
  try {
    await prepareDesktopUpdate()
    await destroyDesktopSubWindows()
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_app')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重启失败，请稍后重试')
  } finally {
    updateRestarting = false
  }
}

// 周期性本地文件备份：把设置里的“备份间隔(10/20/30分钟)”接上真正的定时器。
// 之前该设置只存值不生效；这里用自排程的 setTimeout，每轮重新读取间隔，改设置下一轮即生效。
const BACKUP_INTERVAL_MS: Record<string, number> = {
  '10m': 10 * 60 * 1000,
  '20m': 20 * 60 * 1000,
  '30m': 30 * 60 * 1000,
}
let backupTimer: ReturnType<typeof setTimeout> | null = null
let periodicBackupRunning = false

const schedulePeriodicBackup = async () => {
  if (!backupService.isSupported()) return
  let delay = BACKUP_INTERVAL_MS['10m']
  try {
    const settings = await backupService.getSettings()
    delay = BACKUP_INTERVAL_MS[String(settings?.backupInterval)] || BACKUP_INTERVAL_MS['10m']
  } catch {
    // 读取设置失败用默认 10 分钟。
  }
  backupTimer = setTimeout(async () => {
    if (!periodicBackupRunning) {
      periodicBackupRunning = true
      try {
        await backupService.backupAllPendingBooks()
      } catch (error) {
        // 周期备份是兜底能力，失败不打扰用户，仅记录。
        console.warn('周期性本地备份失败', error)
      } finally {
        periodicBackupRunning = false
      }
    }
    void schedulePeriodicBackup()
  }, delay)
}

// 本地库(SQLite)打不开时不再退回浏览器存储（那会造成两个库分叉、跨会话丢稿），
// 而是明确告知"存不进去"。提示必须常驻：8 秒的 toast 用户走开就错过，
// 然后会以为一切正常继续写几个小时，最后整段丢失。
let storageUnavailableHandle: ReturnType<typeof ElMessage> | null = null
const handleStorageUnavailable = (event: Event) => {
  if (storageUnavailableHandle) return
  // 把底层原因带上提示条：是文件锁（多为旧实例未退净）、损坏还是权限，
  // 用户一眼可辨，也方便反馈时直接截图定位。
  const rawDetail = String((event as CustomEvent<{ message?: string }>).detail?.message || '')
    .replace(/\s+/g, ' ')
    .slice(0, 140)
  storageUnavailableHandle = ElMessage({
    type: 'error',
    duration: 0,
    showClose: true,
    message: `本地存储打不开，当前内容无法保存到本机。请先手动导出本章内容，然后完全退出应用（确认没有旧实例残留）再重启。${rawDetail ? `原因：${rawDetail}` : ''}`,
    onClose: () => {
      storageUnavailableHandle = null
    },
  })
}

const handleStorageRecovered = () => {
  storageUnavailableHandle?.close()
  storageUnavailableHandle = null
}

onMounted(() => {
  // 运行时类名用于隔离网页响应式样式和桌面端窗口样式。
  document.body.classList.add(runtimeBodyClass)
  window.addEventListener('contextmenu', handleGlobalContextMenu, true)
  window.addEventListener('click', closeAppContextMenu)
  window.addEventListener('blur', closeAppContextMenu)
  window.addEventListener('ew-desktop-update-check', handleDesktopUpdateRequest)
  window.addEventListener('ew-writing-storage-unavailable', handleStorageUnavailable)
  window.addEventListener('ew-writing-storage-recovered', handleStorageRecovered)
  void setupDesktopCloseBackup()
  void schedulePeriodicBackup()
  if (desktopUpdatePreviewEnabled) {
    showDesktopUpdatePreview()
  } else if (desktopShell) {
    void showPendingDesktopUpdateNotes()
    automaticUpdateTimer = setTimeout(() => void runDesktopUpdateCheck(true), 8000)
  }
})

onBeforeUnmount(() => {
  if (automaticUpdateTimer) clearTimeout(automaticUpdateTimer)
  manualUpdateMessage?.close()
  void dismissDesktopUpdate()
  document.body.classList.remove(runtimeBodyClass)
  window.removeEventListener('contextmenu', handleGlobalContextMenu, true)
  window.removeEventListener('click', closeAppContextMenu)
  window.removeEventListener('blur', closeAppContextMenu)
  window.removeEventListener('ew-desktop-update-check', handleDesktopUpdateRequest)
  window.removeEventListener('ew-writing-storage-unavailable', handleStorageUnavailable)
  window.removeEventListener('ew-writing-storage-recovered', handleStorageRecovered)
  if (backupTimer) {
    clearTimeout(backupTimer)
    backupTimer = null
  }
  unlistenCloseRequested?.()
  unlistenCloseRequested = null
})
</script>

<style scoped>
#app {
  --desktop-titlebar-height: 0px;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

#app.desktop-shell {
  --desktop-titlebar-height: 44px;
  display: flex;
  flex-direction: column;
  background: var(--bg-main);
}

.app-shell-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.app-context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 160px;
  padding: 6px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--surface-1);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(10px);
}

.app-context-menu button {
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-main);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.app-context-menu button:hover {
  background: var(--nav-active-bg);
}

.app-closing-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-main, #f5f1e8) 72%, transparent);
  backdrop-filter: blur(3px);
}

.app-closing-card {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 18px 28px;
  border: 1px solid var(--ui-border, #ddd);
  border-radius: 12px;
  background: var(--card-bg, #fff);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.16);
  color: var(--ink-main, #333);
  font-size: 14px;
  font-weight: 600;
}

.app-closing-card i {
  color: var(--ink-accent, #b04a39);
  font-size: 16px;
}
</style>
