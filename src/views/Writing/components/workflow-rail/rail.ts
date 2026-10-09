import { appSettings } from '@/storage/app-settings'
import type {
  WorkflowRuntimeEffectiveScope,
  WorkflowRuntimeSettings,
} from '@/types/workflow'

/** 工作流右缘工具栏的面板标识 */
export type WorkflowRailToolId =
  | 'task'
  | 'outline'
  | 'rules'
  | 'rewrite'
  | 'characters'
  | 'words'
  | 'world'
  | 'work'

export interface WorkflowRailTool {
  id: WorkflowRailToolId
  name: string
  icon: string
  /** 该工具项上方绘制分组分隔线 */
  dividerBefore?: boolean
}

/** 图标自上而下：任务、大纲、规则、重写、角色、世界、作品（信息架构已定案） */
export const WORKFLOW_RAIL_TOOLS: WorkflowRailTool[] = [
  { id: 'task', name: '任务', icon: 'fa-solid fa-list-check' },
  { id: 'outline', name: '大纲', icon: 'fa-solid fa-list-ul', dividerBefore: true },
  { id: 'rules', name: '规则', icon: 'fa-solid fa-scale-balanced' },
  { id: 'rewrite', name: '重写', icon: 'fa-solid fa-rotate' },
  { id: 'characters', name: '角色', icon: 'fa-solid fa-users', dividerBefore: true },
  { id: 'words', name: '词库', icon: 'fa-solid fa-book-bookmark' },
  { id: 'world', name: '世界', icon: 'fa-solid fa-globe' },
  { id: 'work', name: '作品', icon: 'fa-solid fa-book' },
]

const WORKFLOW_RAIL_TOOL_IDS = new Set<string>(WORKFLOW_RAIL_TOOLS.map(tool => tool.id))

export const isWorkflowRailTool = (value: unknown): value is WorkflowRailToolId =>
  typeof value === 'string' && WORKFLOW_RAIL_TOOL_IDS.has(value)

/** 竖向图标栏宽度（与样式中的 --rail-bar-width 保持单一来源） */
export const WORKFLOW_RAIL_BAR_WIDTH = 48
/** 展开面板宽度边界与默认值 */
export const WORKFLOW_RAIL_PANEL_MIN_WIDTH = 320
export const WORKFLOW_RAIL_PANEL_MAX_WIDTH = 640
export const WORKFLOW_RAIL_PANEL_DEFAULT_WIDTH = 384
/** 大纲面板逐拍编辑需要的舒适宽度：切到大纲时不足则自动加宽 */
export const WORKFLOW_RAIL_OUTLINE_COMFORT_WIDTH = 400
/** 统一动效时长（ms），模板里通过 CSS 变量下发 */
export const WORKFLOW_RAIL_TRANSITION_MS = 200
/** 整个侧栏（面板+图标栏）最多占视口宽度的比例，防止小窗口下挤压编辑器 */
export const WORKFLOW_RAIL_MAX_VIEWPORT_RATIO = 0.46
/** 面板宽度记忆键 */
export const WORKFLOW_RAIL_WIDTH_STORAGE_KEY = 'ew-workflow-rail-panel-width'

export const clampWorkflowRailPanelWidth = (value: number) =>
  Math.max(
    WORKFLOW_RAIL_PANEL_MIN_WIDTH,
    Math.min(WORKFLOW_RAIL_PANEL_MAX_WIDTH, Math.round(Number(value) || 0))
  )

export const readStoredWorkflowRailPanelWidth = (): number => {
  try {
    const raw = Number(appSettings.getItem(WORKFLOW_RAIL_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(raw) || raw <= 0) return WORKFLOW_RAIL_PANEL_DEFAULT_WIDTH
    return clampWorkflowRailPanelWidth(raw)
  } catch {
    return WORKFLOW_RAIL_PANEL_DEFAULT_WIDTH
  }
}

export const persistWorkflowRailPanelWidth = (width: number) => {
  try {
    appSettings.setItem(
      WORKFLOW_RAIL_WIDTH_STORAGE_KEY,
      String(clampWorkflowRailPanelWidth(width))
    )
  } catch {
    // 本地存储不可用时静默降级为会话内记忆
  }
}

/** 运行时配置补丁：与旧 WorkflowWritingSidePanel 的 updateConfig 事件负载保持一致 */
export interface WorkflowRuntimeConfigUpdate {
  modelCode?: string
  config: Partial<WorkflowRuntimeSettings>
  effectiveScope: WorkflowRuntimeEffectiveScope
}
