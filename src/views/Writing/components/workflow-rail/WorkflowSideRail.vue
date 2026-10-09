<template>
  <aside
    class="workflow-side-rail border-gradient-l"
    :class="{ collapsed: !activeToolId, 'no-transition': isResizing }"
    :style="railStyle"
  >
    <!-- 拖拽调宽手柄（仅展开时可用） -->
    <div
      v-if="activeToolId"
      class="rail-resize-handle"
      :class="{ active: isResizing }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整工作流面板宽度"
      @mousedown="startResize"
    ></div>

    <!-- 展开的面板窗口：容器常驻，KeepAlive 缓存不随收起丢失 -->
    <div class="rail-panel" :style="panelStyle">
      <header v-if="activeTool" class="rail-panel-header">
        <div class="rail-panel-heading">
          <i :class="activeTool.icon"></i>
          <strong>{{ activeTool.name }}</strong>
        </div>
        <button
          type="button"
          class="rail-panel-collapse"
          title="收起面板"
          aria-label="收起面板"
          @click="closePanel"
        >
          <i class="fa-solid fa-angles-right"></i>
        </button>
      </header>

      <div class="rail-panel-body">
        <Transition name="rail-panel-switch" mode="out-in">
          <KeepAlive>
            <WorkflowControlPanel
              v-if="activeToolId === 'task'"
              key="task"
              :state="state"
              :task="task"
              :logs="logs"
              :model-code="taskModelCode"
              :model-name="taskModelName"
              :stage-text="stageText"
              :writing-scene="writingScene"
              :action-pending="actionPending"
              :dismissed-issue-keys="dismissedIssueKeys"
              :active-issue-key="activeIssueKey"
              :polished-issue-keys="polishedIssueKeys"
              @pause="emit('pause')"
              @resume="emit('resume')"
              @stop="emit('stop')"
              @review="(action, feedback) => emit('review', action, feedback)"
              @plot-outline-review="action => emit('plotOutlineReview', action)"
              @edit-review="emit('editReview')"
              @locate-issue="key => emit('locateIssue', key)"
              @dismiss-issue="key => emit('dismissIssue', key)"
              @restore-dismissed-issues="emit('restoreDismissedIssues')"
              @polish-issue="key => emit('polishIssue', key)"
            />
            <WorkflowOutlinePanel
              v-else-if="activeToolId === 'outline'"
              key="outline"
              :book-id="bookId"
              :run-id="workflowRunId"
              :task-id="workflowTaskId"
              :task="task"
              :state="state"
            />
            <WorkflowRulesPanel
              v-else-if="activeToolId === 'rules'"
              key="rules"
              :run="run"
              :saving="configSaving"
              @apply="emit('updateConfig', $event)"
            />
            <RewritePanel
              v-else-if="activeToolId === 'rewrite'"
              key="rewrite"
              :chapter-id="rewriteChapterId"
              :chapter-title="rewriteChapterTitle"
            />
            <WorkflowCharacterPanel
              v-else-if="activeToolId === 'characters'"
              key="characters"
              :book-id="bookId"
              @lore-updated="emit('loreUpdated')"
            />
            <WordLibraryPanel v-else-if="activeToolId === 'words'" key="words" :book-id="bookId" />
            <WorkflowWorldPanel
              v-else-if="activeToolId === 'world'"
              key="world"
              :book-id="bookId"
              @lore-updated="emit('loreUpdated')"
            />
            <WorkflowWorkPanel
              v-else-if="activeToolId === 'work'"
              key="work"
              :run="run"
              :saving="configSaving"
              :has-content="hasContent"
              :review-required="state === 'review_required'"
              @apply="emit('updateConfig', $event)"
            />
          </KeepAlive>
        </Transition>
      </div>
    </div>

    <!-- 右缘竖向图标工具栏 -->
    <nav class="rail-bar" aria-label="工作流面板工具栏">
      <button
        v-for="tool in WORKFLOW_RAIL_TOOLS"
        :key="tool.id"
        type="button"
        class="rail-tool"
        :class="{ active: tool.id === activeToolId, 'has-divider': tool.dividerBefore, 'word-library-tool': tool.id === 'words' }"
        :aria-pressed="tool.id === activeToolId"
        :title="tool.id === activeToolId ? `收起${tool.name}` : `展开${tool.name}`"
        @click="selectTool(tool.id)"
      >
        <Notebook v-if="tool.id === 'words'" class="word-library-tool-icon" aria-hidden="true" />
        <i v-else :class="tool.icon"></i>
        <span>{{ tool.name }}</span>
        <em v-if="toolBadge(tool.id)" class="rail-tool-dot" :class="`is-${toolBadge(tool.id)}`"></em>
      </button>
    </nav>
  </aside>
</template>

<script setup lang="ts">
import { Notebook } from '@element-plus/icons-vue'
import { defineAsyncComponent, computed, onBeforeUnmount, onMounted, ref } from 'vue'
const WordLibraryPanel = defineAsyncComponent(() => import('../WordLibraryPanel.vue'))
import { useWritingEditorStore } from '@/stores/writing-editor'
import { getLocalAiModelDisplayName } from '@/storage/local-ai-models'
import type {
  WorkflowReviewAction,
  WorkflowRun,
  WorkflowTask,
} from '@/types/workflow'
import type {
  WorkflowControlLog,
  WorkflowControlState,
} from '../../composables/useWorkflowWritingSession'
import WorkflowCharacterPanel from '../WorkflowCharacterPanel.vue'
import WorkflowControlPanel from '../WorkflowControlPanel.vue'
import WorkflowWorldPanel from '../WorkflowWorldPanel.vue'
import WorkflowOutlinePanel from './WorkflowOutlinePanel.vue'
import WorkflowRulesPanel from './WorkflowRulesPanel.vue'
import WorkflowWorkPanel from './WorkflowWorkPanel.vue'
import RewritePanel from './RewritePanel.vue'
import {
  WORKFLOW_RAIL_BAR_WIDTH,
  WORKFLOW_RAIL_MAX_VIEWPORT_RATIO,
  WORKFLOW_RAIL_OUTLINE_COMFORT_WIDTH,
  WORKFLOW_RAIL_PANEL_MIN_WIDTH,
  WORKFLOW_RAIL_TOOLS,
  WORKFLOW_RAIL_TRANSITION_MS,
  clampWorkflowRailPanelWidth,
  persistWorkflowRailPanelWidth,
  readStoredWorkflowRailPanelWidth,
  type WorkflowRailToolId,
  type WorkflowRuntimeConfigUpdate,
} from './rail'

const props = withDefaults(defineProps<{
  bookId: string | number
  run: WorkflowRun | null
  state: WorkflowControlState
  task: WorkflowTask | null
  logs: WorkflowControlLog[]
  stageText?: string
  writingScene?: number
  actionPending?: boolean
  configSaving?: boolean
  hasContent?: boolean
  /** 已校验的工作流身份（大纲面板拉工作流视图目录用），未校验传 0 */
  workflowRunId?: number
  workflowTaskId?: number
  /** 用户已忽略的建议键（父级持久化） */
  dismissedIssueKeys?: string[]
  /** 正文选中段对应的建议键（卡片联动） */
  activeIssueKey?: string
  /** 已执行"AI 修改此段"的建议键 */
  polishedIssueKeys?: string[]
}>(), {
  stageText: '',
  writingScene: 0,
  actionPending: false,
  configSaving: false,
  hasContent: false,
  workflowRunId: 0,
  workflowTaskId: 0,
  dismissedIssueKeys: () => [],
  activeIssueKey: '',
  polishedIssueKeys: () => [],
})

// 任务面板的模型显示名：本地 run 没有服务端回填的 effectiveModelName，
// 按 code 到本地模型库查名，否则会把内部负数 id 亮给用户
const taskModelCode = computed(() => String(props.run?.effectiveModelCode || props.run?.modelCode || ''))
const taskModelName = computed(
  () => String(props.run?.effectiveModelName || '') || getLocalAiModelDisplayName(taskModelCode.value)
)

const emit = defineEmits<{
  (event: 'pause'): void
  (event: 'resume'): void
  (event: 'stop'): void
  (event: 'review', action: WorkflowReviewAction, feedback?: { feedback?: string; feedbackToRules?: boolean; rewriteMode?: 'content' | 'plot' }): void
  (event: 'plotOutlineReview', action: 'accept' | 'discard'): void
  (event: 'editReview'): void
  (event: 'updateConfig', payload: WorkflowRuntimeConfigUpdate): void
  (event: 'loreUpdated'): void
  (event: 'locateIssue', issueKey: string): void
  (event: 'dismissIssue', issueKey: string): void
  (event: 'restoreDismissedIssues'): void
  (event: 'polishIssue', issueKey: string): void
}>()

const editorStore = useWritingEditorStore()

// 默认展开任务面板：进入工作流写作页第一眼是生成状态。
const activeToolId = ref<WorkflowRailToolId | null>('task')
const panelWidth = ref(readStoredWorkflowRailPanelWidth())
// 小窗口下按视口比例夹住实际展示宽度，避免记忆的宽度挤没编辑器
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)

const activeTool = computed(() =>
  WORKFLOW_RAIL_TOOLS.find(tool => tool.id === activeToolId.value) || null
)

const effectivePanelWidth = computed(() => {
  const viewportCap = viewportWidth.value > 0
    ? Math.floor(viewportWidth.value * WORKFLOW_RAIL_MAX_VIEWPORT_RATIO) - WORKFLOW_RAIL_BAR_WIDTH
    : panelWidth.value
  return Math.max(
    WORKFLOW_RAIL_PANEL_MIN_WIDTH,
    Math.min(panelWidth.value, viewportCap)
  )
})

const railStyle = computed(() => ({
  width: activeToolId.value
    ? `${effectivePanelWidth.value + WORKFLOW_RAIL_BAR_WIDTH}px`
    : `${WORKFLOW_RAIL_BAR_WIDTH}px`,
  '--rail-bar-width': `${WORKFLOW_RAIL_BAR_WIDTH}px`,
  '--rail-transition': `${WORKFLOW_RAIL_TRANSITION_MS}ms`,
}))

const panelStyle = computed(() => ({ width: `${effectivePanelWidth.value}px` }))

const handleViewportResize = () => {
  viewportWidth.value = window.innerWidth
}

/** 重写面板跟随编辑器当前打开的章节 */
const rewriteChapterId = computed(() => Number(editorStore.activeChapterId || 0) || null)
const rewriteChapterTitle = computed(() => String(editorStore.activeChapterTitle || ''))

/** 任务图标状态点：待确认 / 生成中 / 失败一眼可见 */
const toolBadge = (toolId: WorkflowRailToolId) => {
  if (toolId !== 'task') return ''
  if (props.state === 'review_required') return 'warning'
  if (props.state === 'generating' || props.state === 'recovering') return 'busy'
  if (props.state === 'failed') return 'danger'
  return ''
}

const selectTool = (toolId: WorkflowRailToolId) => {
  if (activeToolId.value === toolId) {
    activeToolId.value = null
    return
  }
  // 大纲面板逐拍编辑需要更宽的操作区，宽度不足时自动加宽一次
  if (toolId === 'outline' && panelWidth.value < WORKFLOW_RAIL_OUTLINE_COMFORT_WIDTH) {
    panelWidth.value = WORKFLOW_RAIL_OUTLINE_COMFORT_WIDTH
    persistWorkflowRailPanelWidth(panelWidth.value)
  }
  activeToolId.value = toolId
}

const closePanel = () => {
  activeToolId.value = null
}

// --- 拖拽调宽（宽度记忆到 localStorage） ---
const isResizing = ref(false)
let resizeStartX = 0
let resizeStartWidth = 0

const handleResizeMove = (event: MouseEvent) => {
  if (!isResizing.value) return
  // 面板在工具栏左侧：向左拖增加宽度
  const nextWidth = resizeStartWidth + resizeStartX - event.clientX
  panelWidth.value = clampWorkflowRailPanelWidth(nextWidth)
}

const stopResize = () => {
  if (!isResizing.value) return
  isResizing.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', handleResizeMove)
  window.removeEventListener('mouseup', stopResize)
  persistWorkflowRailPanelWidth(panelWidth.value)
}

const startResize = (event: MouseEvent) => {
  event.preventDefault()
  resizeStartX = event.clientX
  resizeStartWidth = effectivePanelWidth.value
  isResizing.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', handleResizeMove)
  window.addEventListener('mouseup', stopResize)
}

onMounted(() => {
  window.addEventListener('resize', handleViewportResize)
})

onBeforeUnmount(() => {
  stopResize()
  window.removeEventListener('resize', handleViewportResize)
})
</script>

<style scoped lang="scss">
.workflow-side-rail {
  position: relative;
  flex: 0 0 auto;
  min-width: var(--rail-bar-width);
  height: 100%;
  overflow: hidden;
  color: var(--ink-main);
  background: var(--sidebar-bg);
  transition: width var(--rail-transition) cubic-bezier(0.4, 0, 0.2, 1);
  will-change: width;

  &.no-transition {
    transition: none !important;
  }

  /* 收起时面板内容淡出但保持挂载，KeepAlive 状态不丢 */
  &.collapsed .rail-panel {
    opacity: 0;
    pointer-events: none;
  }
}

.rail-resize-handle {
  position: absolute;
  z-index: 8;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 7px;
  cursor: col-resize;

  &::after {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: transparent;
    content: '';
    transition: background-color var(--rail-transition) ease;
  }

  &:hover::after,
  &.active::after {
    background: var(--ink-accent);
  }
}

.rail-panel {
  position: absolute;
  top: 0;
  right: var(--rail-bar-width);
  bottom: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  opacity: 1;
  transition: opacity var(--rail-transition) ease;
  will-change: opacity;
}

.rail-panel-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 48px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--divider);
  background: var(--panel-header-bg);
}

.rail-panel-heading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

  i {
    color: var(--ink-accent);
    font-size: 13px;
  }

  strong {
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.rail-panel-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  transition: color var(--rail-transition) ease, background var(--rail-transition) ease;

  &:hover {
    color: var(--ink-main);
    background: var(--btn-ghost-hover-bg);
  }
}

.rail-panel-body {
  flex: 1;
  min-height: 0;

  > * {
    height: 100%;
  }
}

.rail-panel-switch-enter-active,
.rail-panel-switch-leave-active {
  transition: opacity var(--rail-transition) cubic-bezier(0.4, 0, 0.2, 1),
    transform var(--rail-transition) cubic-bezier(0.4, 0, 0.2, 1);
}

.rail-panel-switch-enter-from {
  opacity: 0;
  transform: translateX(14px);
}

.rail-panel-switch-leave-to {
  opacity: 0;
  transform: translateX(-14px);
}

.rail-bar {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: var(--rail-bar-width);
  padding: 10px 0;
  gap: 14px;
  border-left: 1px solid rgba(128, 128, 128, 0.08);
  background: var(--tool-sidebar-bg);
}

.rail-tool {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 5px 0;
  border: 0;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  transition: color var(--rail-transition) ease, background var(--rail-transition) ease;

  i {
    font-size: 15px;
  }

  span {
    font-size: 10px;
    transform: scale(0.9);
  }

  &:hover {
    color: var(--ink-main);
  }

  /* 激活指示条：靠外缘，与普通写作页右栏的肌肉记忆一致 */
  &::after {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 2px;
    background: var(--ink-accent);
    content: '';
    transform: scaleY(0);
    transform-origin: center;
    transition: transform var(--rail-transition) ease;
  }

  &.active {
    color: var(--nav-active-color, var(--ink-main));
    background: var(--nav-active-bg);

    span {
      font-weight: 700;
    }

    &::after {
      transform: scaleY(1);
    }
  }

  &.has-divider::before {
    position: absolute;
    top: -8px;
    left: 50%;
    width: 24px;
    height: 1px;
    background: var(--divider);
    content: '';
    transform: translateX(-50%);
  }
}

.rail-tool-dot {
  position: absolute;
  top: 3px;
  right: 11px;
  width: 6px;
  height: 6px;
  border-radius: 50%;

  &.is-warning {
    background: var(--state-warning-on);
  }

  &.is-danger {
    background: var(--state-danger-on);
  }

  &.is-busy {
    background: var(--ink-accent);
    animation: rail-dot-pulse 1.6s ease-in-out infinite;
  }
}

@keyframes rail-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

/* 小窗口自适应由 effectivePanelWidth 的视口比例钳制统一处理，不再叠加 CSS max-width，
   避免固定宽度面板被二次裁切。 */
.rail-tool.word-library-tool {
  width: calc(100% - 6px); margin: 0 auto; border-radius: 6px;
  .word-library-tool-icon { width: 20px; height: 20px; }
  &.active { color: var(--word-library-accent, var(--ink-accent)); background: var(--accent-soft); }
  &::after { display: none; }
}
</style>
