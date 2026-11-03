import type { AiThinkingMode } from '@/types/user-ai-model'

export type AiModelGroupCode =
  | 'text_assist'
  | 'workflow_book'
  | 'image_generation'
  | 'background'
  | 'weixin'
  | 'agent_planner'
  | 'agent_writer'
  | 'agent_critic'
  | 'agent_indexer'

export interface AiModelGroupDef {
  code: AiModelGroupCode
  name: string
  hint: string
  icon: string
  /** 未单独设置默认模型时跟随哪个分组；桌面宿主按同一链路回退 */
  fallback?: AiModelGroupCode
}

/** 模型分组一张表；顺序即模型管理页的展示顺序。 */
export const AI_MODEL_GROUPS: AiModelGroupDef[] = [
  { code: 'text_assist', name: '写作助手', hint: '续写、润色、妙笔、取名等日常功能', icon: 'fa-solid fa-wand-magic-sparkles' },
  { code: 'workflow_book', name: '工作流建书', hint: '按大纲逐章生成正文，建议用最强的模型', icon: 'fa-solid fa-diagram-project' },
  { code: 'image_generation', name: '图像生成', hint: '作品封面', icon: 'fa-solid fa-image' },
  { code: 'weixin', name: '微信助手', hint: '在微信里跟易创对话时用；未设置时跟随写作助手', icon: 'fa-solid fa-comment-dots', fallback: 'text_assist' },
  { code: 'background', name: '后台整理', hint: '每章写完后自动整理人物状态与伏笔，调用次数多，可选便宜的；未设置时跟随写作助手', icon: 'fa-solid fa-clipboard-list', fallback: 'text_assist' },
  { code: 'agent_planner', name: 'Agent 规划', hint: 'Agent 对话主循环：理解指令、调用工具、规划拍子；未设置时跟随写作助手', icon: 'fa-solid fa-diagram-project', fallback: 'text_assist' },
  { code: 'agent_writer', name: 'Agent 写作', hint: '生成正文与定向修订，可以选更强的模型；未设置时跟随 Agent 规划', icon: 'fa-solid fa-pen-nib', fallback: 'agent_planner' },
  { code: 'agent_critic', name: 'Agent 评审', hint: '读者模拟体检，可与写作模型不同；未设置时跟随写作助手', icon: 'fa-solid fa-magnifying-glass', fallback: 'text_assist' },
  { code: 'agent_indexer', name: 'Agent 索引', hint: '章节卡提取与记忆整理，建议用便宜快的模型；未设置时跟随写作助手', icon: 'fa-solid fa-layer-group', fallback: 'text_assist' }
]

export const AGENT_MODEL_ROLES = ['agent_planner', 'agent_writer', 'agent_critic', 'agent_indexer'] as const
export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number]

export interface AiModelOption {
  id: number
  name: string
  code: string
  modelCode?: string
  scene: 'text' | 'image' | string
  provider?: string
  description?: string
  protocol?: string
  baseUrl?: string
  ownerType?: 'user'
  isMine?: boolean
  isDefault?: boolean
  maxContext?: number
  maxOutputTokens?: number
  thinking?: AiThinkingMode
  extraParams?: string
  testWaitSeconds?: import('./model-test').ModelTestWaitSeconds
  lastTestOutcome?: import('./model-test').ModelTestOutcome
  status?: number
  testStatus?: number
  lastTestAt?: string
  lastLatency?: number | null
  lastError?: string
  apiKeyMask?: string
}

export interface AiModelPolicyOption {
  groupCode: AiModelGroupCode | string
  groupName: string
  scene: 'text' | 'image' | string
  defaultModelId?: number | null
  selectableModelIds?: number[]
  allowUserSelect: boolean
  lockOnFirstUse: boolean
  status: number
}

export interface AiModelOptionsResult {
  policy: AiModelPolicyOption | null
  defaultModel: AiModelOption | null
  selectedModelCode?: string
  selectedModel?: AiModelOption | null
  models: AiModelOption[]
}
