<template>
  <aside
class="writing-right-panel border-gradient-l"
    :class="{ collapsed: !activeToolId, 'no-transition': isResizing }"
    :style="{ width: activeToolId ? (store.rightPanelWidth + 48) + 'px' : '48px' }">
    <!-- 拖拽手柄 -->
    <div v-if="activeToolId" class="resize-handle" :class="{ active: isResizing }" @mousedown="startResize"></div>

    <!-- 内容区域 -->
    <div class="panel-container" :style="{ width: activeToolId ? store.rightPanelWidth + 'px' : '0' }">
      <Transition name="panel-switch" mode="out-in">
        <WritingReferencePanelHost
          v-if="activeReferenceToolId"
          ref="sidePanelHostRef"
          :key="activeReferenceToolId"
          :tool-id="activeReferenceToolId"
          :title="currentPanel.title"
          :book-id="bookId"
          panel-mode="side"
          @close="closePanel"
          @popout="handlePanelPopout(activeReferenceToolId)"
          @lore-updated="handleLoreUpdated"
        />
        <AiChatPanel
v-else-if="activeToolId === 'magic'" key="magic" :title="currentPanel.title" :book-id="bookId"
          @close="closePanel" />
        <InspirationPanel
v-else-if="activeToolId === 'inspiration'" key="inspiration" :title="currentPanel.title"
          :book-id="bookId" @close="closePanel" />
        <WordLibraryPanel v-else-if="activeToolId === 'words'" key="words" :book-id="bookId" />
        <MobilePreviewPanel
v-else-if="activeToolId === 'preview'" key="preview" :title="currentPanel.title"
          @close="closePanel" />
      </Transition>
    </div>

    <!-- 右侧工具栏 -->
    <div class="tool-sidebar">
      <div
v-for="tool in visibleTools" :key="tool.id" :class="['tool-item', { active: tool.active, 'word-library-tool': tool.id === 'words' }]"
        @click="selectTool(tool)">
        <Notebook v-if="tool.id === 'words'" class="word-library-tool-icon" aria-hidden="true" />
        <i v-else :class="tool.icon"></i>
        <span>{{ tool.name }}</span>
      </div>
    </div>
  </aside>

  <EwModal
    v-model:visible="webPopoutVisible"
    :title="poppedPanelTitle"
    width="min(1180px, calc(100vw - 48px))"
    height="min(760px, calc(100vh - var(--desktop-titlebar-height, 0px) - 48px))"
    :modal="false"
    :draggable="true"
    :resizable="true"
    :resize-min-width="720"
    :resize-min-height="520"
    :close-on-click-modal="false"
    :show-close="false"
    custom-class="reference-panel-modal"
    :body-style="popoutBodyStyle"
    @close="closeWebPopout"
  >
    <template #header>
      <div class="popout-modal-header">
        <h2 class="popout-modal-title">{{ poppedPanelTitle }}</h2>
        <div class="popout-modal-actions">
          <button class="popout-modal-action" type="button" title="收回侧栏" @mousedown.stop @click.stop="dockWebPopout">
            <i class="fa-solid fa-arrow-right-to-bracket"></i>
          </button>
          <button class="popout-modal-action" type="button" title="关闭" @mousedown.stop @click.stop="closeWebPopout">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
    </template>
    <WritingReferencePanelHost
      v-if="poppedToolId"
      ref="popoutHostRef"
      :tool-id="poppedToolId"
      :title="poppedPanelTitle"
      :book-id="bookId"
      panel-mode="popout"
      hide-header
      @close="closeWebPopout"
      @dock="dockWebPopout"
      @lore-updated="handleLoreUpdated"
    />
  </EwModal>
</template>

<script setup lang="ts">
import { Notebook } from '@element-plus/icons-vue'
import { defineAsyncComponent, ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import { isTauriRuntime } from '@/storage'
import { getAppWindowChromeOptions } from '@/utils/desktop-window'
import {
  useWritingEditorStore,
  WRITING_RIGHT_PANEL_MAX_WIDTH,
  WRITING_RIGHT_PANEL_MIN_WIDTH
} from '@/stores/writing-editor'
import AiChatPanel from './AiChatPanel.vue'
import InspirationPanel from './InspirationPanel.vue'
import MobilePreviewPanel from './MobilePreviewPanel.vue'
import WritingReferencePanelHost from './WritingReferencePanelHost.vue'
import {
  REFERENCE_PANEL_TITLES,
  isReferencePanelTool,
  type ReferencePanelToolId,
} from './reference-panel'
const WordLibraryPanel = defineAsyncComponent(() => import('./WordLibraryPanel.vue'))
const store = useWritingEditorStore()

const props = defineProps<{
  bookId?: string | number
  bookTitle?: string
}>()

const emit = defineEmits<{
  (e: 'lore-updated'): void
}>()

const bookId = computed(() => props.bookId || '')
const popoutBodyStyle = { padding: '0', overflow: 'hidden' }

interface Tool {
  id: string
  name: string
  icon: string
  active: boolean
}

const tools = ref<Tool[]>([
  { id: 'magic', name: '妙笔', icon: 'fa-solid fa-wand-magic-sparkles', active: false },
  { id: 'preview', name: '预览', icon: 'fa-solid fa-mobile-screen-button', active: false },
  { id: 'outline', name: '大纲', icon: 'fa-solid fa-list-ul', active: false },
  { id: 'character', name: '角色', icon: 'fa-solid fa-users', active: false },
  { id: 'settings', name: '设定', icon: 'fa-solid fa-gear', active: false },
  { id: 'timeline', name: '时间线', icon: 'fa-solid fa-timeline', active: false },
  { id: 'storyline', name: '故事线', icon: 'fa-solid fa-diagram-project', active: false },
  { id: 'words', name: '词库', icon: 'fa-solid fa-spell-check', active: false },
  { id: 'inspiration', name: '灵感', icon: 'fa-regular fa-lightbulb', active: false },
])
const visibleTools = computed(() => tools.value)

const syncToolsWithStore = () => {
  if (store.rightPanelActiveTool && !visibleTools.value.some(tool => tool.id === store.rightPanelActiveTool)) {
    store.setRightPanelActiveTool(null)
  }
  tools.value.forEach(tool => {
    tool.active = store.rightPanelActiveTool === tool.id
  })
}

syncToolsWithStore()

watch(
  () => store.rightPanelActiveTool,
  () => {
    syncToolsWithStore()
  }
)

const activeToolId = computed(() => store.rightPanelActiveTool)
const activeReferenceToolId = computed(() => isReferencePanelTool(activeToolId.value) ? activeToolId.value : null)
const poppedToolId = ref<ReferencePanelToolId | null>(null)
const webPopoutVisible = ref(false)
const sidePanelHostRef = ref<{ flushPendingSave?: () => Promise<void | boolean> } | null>(null)
const popoutHostRef = ref<{ flushPendingSave?: () => Promise<void | boolean> } | null>(null)
let desktopPanelUnlisteners: Array<() => void> = []

const currentPanel = computed(() => {
  const activeTool = visibleTools.value.find(t => t.active)
  return {
    title: activeTool ? `${activeTool.name}` : ''
  }
})

const poppedPanelTitle = computed(() => poppedToolId.value ? REFERENCE_PANEL_TITLES[poppedToolId.value] : '')

const selectTool = async (tool: Tool) => {
  if (activeReferenceToolId.value === 'outline' && await sidePanelHostRef.value?.flushPendingSave?.() === false) return
  if (tool.active) {
    store.setRightPanelActiveTool(null)
  } else {
    if (tool.id === 'preview' && store.rightPanelWidth < 520) {
      store.setRightPanelWidth(520)
    }
    if ((tool.id === 'timeline' || tool.id === 'storyline') && store.rightPanelWidth < 560) {
      store.setRightPanelWidth(560)
    }
    store.setRightPanelActiveTool(tool.id)
  }
}

const closePanel = async () => {
  if (activeReferenceToolId.value === 'outline' && await sidePanelHostRef.value?.flushPendingSave?.() === false) return
  store.setRightPanelActiveTool(null)
}

const handleLoreUpdated = () => {
  emit('lore-updated')
}

const closeWebPopout = async () => {
  if (await popoutHostRef.value?.flushPendingSave?.() === false) return
  webPopoutVisible.value = false
  poppedToolId.value = null
}

const dockWebPopout = async () => {
  const toolId = poppedToolId.value
  if (await popoutHostRef.value?.flushPendingSave?.() === false) return
  webPopoutVisible.value = false
  poppedToolId.value = null
  if (toolId) {
    store.setRightPanelActiveTool(toolId)
  }
}

const buildDesktopPanelLabel = (toolId: ReferencePanelToolId) => {
  const safeBookId = String(bookId.value).replace(/[^a-zA-Z0-9_:-]/g, '_')
  return `writing-panel-${safeBookId}-${toolId}`
}

const openDesktopPanel = async (toolId: ReferencePanelToolId) => {
  if (!bookId.value) return false
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const label = buildDesktopPanelLabel(toolId)
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return true
    }

    const title = `${REFERENCE_PANEL_TITLES[toolId]}${props.bookTitle ? `《${props.bookTitle}》` : ''}`
    const url = `/writing-panel/${encodeURIComponent(String(bookId.value))}/${toolId}?title=${encodeURIComponent(title)}`
    const panelWindow = new WebviewWindow(label, {
      url,
      title,
      width: 1180,
      height: 760,
      minWidth: 720,
      minHeight: 520,
      center: true,
      resizable: true,
      focus: true,
      ...getAppWindowChromeOptions(),
    })

    return await new Promise<boolean>((resolve) => {
      panelWindow.once('tauri://created', () => resolve(true))
      panelWindow.once('tauri://error', (event) => {
        console.error('打开参考窗口失败:', event)
        ElMessage.error('打开窗口失败')
        resolve(false)
      })
    })
  } catch (error) {
    console.error('打开参考窗口失败:', error)
    ElMessage.error('打开窗口失败')
    return false
  }
}

const handlePanelPopout = async (toolId: ReferencePanelToolId) => {
  if (isTauriRuntime()) {
    const opened = await openDesktopPanel(toolId)
    if (opened) {
      store.setRightPanelActiveTool(null)
    }
    return
  }
  poppedToolId.value = toolId
  webPopoutVisible.value = true
  store.setRightPanelActiveTool(null)
}

const setupDesktopPanelEvents = async () => {
  if (!isTauriRuntime()) return
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlistenDock = await listen<{ bookId?: string | number; toolId?: string }>('ew-writing-panel-dock', (event) => {
      const payload = event.payload || {}
      if (String(payload.bookId || '') !== String(bookId.value || '')) return
      if (!isReferencePanelTool(payload.toolId)) return
      store.setRightPanelActiveTool(payload.toolId)
    })
    const unlistenLoreUpdated = await listen<{ bookId?: string | number }>('ew-writing-lore-updated', (event) => {
      const payload = event.payload || {}
      if (String(payload.bookId || '') !== String(bookId.value || '')) return
      handleLoreUpdated()
    })
    desktopPanelUnlisteners = [unlistenDock, unlistenLoreUpdated]
  } catch (error) {
    console.error('监听参考窗口事件失败:', error)
  }
}

// --- 拖拽调整宽度逻辑 ---
const isResizing = ref(false)
const startX = ref(0)
const startWidth = ref(0)

const startResize = (e: MouseEvent) => {
  e.preventDefault() // 防止选中文本
  isResizing.value = true
  startX.value = e.clientX
  startWidth.value = store.rightPanelWidth

  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isResizing.value) return
  const diff = startX.value - e.clientX // 向左拖动增加宽度
  const newWidth = startWidth.value + diff

  const clampedWidth = Math.max(WRITING_RIGHT_PANEL_MIN_WIDTH, Math.min(WRITING_RIGHT_PANEL_MAX_WIDTH, newWidth))
  store.setRightPanelWidth(clampedWidth)
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onMounted(() => {
  store.setRightPanelWidth(store.rightPanelWidth)
  void setupDesktopPanelEvents()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResize)
  desktopPanelUnlisteners.forEach(unlisten => unlisten())
  desktopPanelUnlisteners = []
})
</script>

<style scoped lang="scss">
.writing-right-panel {
  display: flex;
  /* width: 384px; 由 style 动态控制 */
  flex-shrink: 0;
  min-width: 48px;
  height: 100%;
  z-index: 20;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  position: relative;
  will-change: width;

  &.collapsed {
    /* width: 48px; 由 style 动态控制 */
    .panel-container {
      width: 0;
      opacity: 0;
      pointer-events: none;
    }
  }

  &.no-transition {
    transition: none !important;

    .panel-container {
      transition: none !important;
    }
  }

  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    cursor: col-resize;
    z-index: 100;
    transition: background-color 0.2s;
    background: transparent;

    &:hover,
    &.active {
      background-color: var(--ink-accent);
    }
  }

  .panel-container {
    position: absolute;
    top: 0;
    right: 48px;
    bottom: 0;
    display: flex;
    /* width: 336px; 由 style 动态控制 */
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
    opacity: 1;
    overflow: hidden;
    will-change: width, opacity;
  }

  .panel-switch-enter-active,
  .panel-switch-leave-active {
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .panel-switch-enter-from {
    opacity: 0;
    transform: translateX(20px);
  }

  .panel-switch-leave-to {
    opacity: 0;
    transform: translateX(-20px);
  }

  .tool-sidebar {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    width: 48px;
    border-left: 1px solid rgba(128, 128, 128, 0.05);
    background: var(--tool-sidebar-bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 0;
    gap: 16px;
    flex-shrink: 0; // Prevent sidebar from shrinking

    .tool-item {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      color: var(--ink-sec);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.3s ease;
      padding: 4px 0;
      width: 100%;

      i {
        font-size: 16px;
      }

      span {
        font-size: 10px;
        transform: scale(0.9);
      }

      &:hover {
        color: var(--ink-main);
      }

      &.active {
        color: var(--ink-main);
        background: var(--nav-active-bg);

        span {
          font-weight: bold;
        }

        &::after {
          content: '';
          position: absolute;
          right: 0;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--ink-main);
          transform: scaleY(1);
          transform-origin: center;
          transition: transform 0.3s ease;
        }
      }

      &::after {
        content: '';
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--ink-main);
        transform: scaleY(0);
        transform-origin: center;
        transition: transform 0.3s ease;
      }

      /* 第3个工具项前添加分隔线 */
      &:nth-child(3)::before {
        content: '';
        position: absolute;
        top: -8px;
        left: 50%;
        transform: translateX(-50%);
        width: 24px;
        height: 1px;
        background: rgba(128, 128, 128, 0.1);
      }
    }
  }
}

.popout-modal-header {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.popout-modal-title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-main);
  font-size: 15px;
  font-weight: 700;
}

.popout-modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.popout-modal-action {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-sec);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;

  &:hover {
    color: var(--ink-main);
    background: var(--btn-ghost-hover-bg);
  }
}

:global(.reference-panel-modal .ew-modal-body) {
  padding: 0;
  overflow: hidden;
}

:global(.reference-panel-modal .panel-content) {
  width: 100%;
  height: 100%;
}

@media (max-width: 900px) {
  :global(body.web-runtime .writing-right-panel){
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 75;
    width: 48px !important;
    overflow: visible;
  }

  :global(body.web-runtime .writing-right-panel:not(.collapsed)){
    width: min(560px, calc(100vw - 48px)) !important;
  }

  :global(body.web-runtime .writing-right-panel .resize-handle){
    display: none;
  }

  :global(body.web-runtime .writing-right-panel .panel-container){
    right: 48px;
    width: min(512px, calc(100vw - 96px)) !important;
    background: color-mix(in srgb, var(--bg-main) 94%, transparent);
    box-shadow: -18px 0 42px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(16px);
  }
}
.writing-right-panel .tool-sidebar .tool-item.word-library-tool {
  width: calc(100% - 6px); padding: 6px 0; border-radius: 6px;
  .word-library-tool-icon { width: 20px; height: 20px; }
  &.active { color: var(--word-library-accent, var(--ink-accent)); background: var(--accent-soft); }
  &.active::after { display: none; }
}
</style>
