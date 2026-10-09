import type { JsonRecord } from '@/types/json'

export type WorkflowStatus =
  | 'draft'
  | 'waiting_user'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'

export type WorkflowStepCode =
  | 'MODE_SELECT'
  | 'BASE_CONFIG'
  | 'MODEL_SELECT'
  | 'AGENT_SELECT'
  | 'OUTLINE_GENERATE'
  | 'SETTING_GENERATE'

export interface WorkflowBaseConfig {
  platform: string
  genre: string
  platformCategory: string
  platformCategoryCode: string
  platformCategorySource: 'rank' | 'common' | 'custom'
  tags: string[]
  title: string
  targetWords: string
  chapterTargetWords: string
  protagonist: string
  storyPerspective: string
  audience: string
  sellingPoint: string
  modelCode: string
  // 用户显式选择「跟随 AI 偏好设置」（modelCode 为空时区分“未选择”与“跟随偏好”）
  modelFollowPreference?: boolean
  agentId: string
}

export type WorkflowAgentMap = Record<string, string>

export interface WorkflowOutlineTitleOption {
  id: string
  name: string
}

export interface WorkflowOutlineVolume {
  id: string
  title: string
  summary: string
  /** 内部滚动规划的当前估算值，不是卷末硬上限。 */
  chapterCount: number
  chapterCountMode: 'dynamic'
  chapterRange: {
    min: number
    max: number
  }
  stages: WorkflowOutlineStage[]
}

export interface WorkflowOutlineStage {
  id: string
  title: string
  /** 兼容旧数据的参考章位；不再作为阶段硬边界。 */
  startChapter?: number
  /** 兼容旧数据的参考章位；不再作为阶段硬边界。 */
  endChapter?: number
  goal: string
  startState: string
  endState: string
  mustHappen: string[]
  forbidden: string[]
  allowedNewElements: string[]
}

export interface WorkflowOutlineChapter {
  id: string
  volumeId: string
  /** 卷内阶段与显式关键章位由总纲生成，必须随草稿往返保留。 */
  stageId?: string
  chapterNo?: number
  title: string
  summary: string
  /** 系统占位章：进入该卷写作时由 AI 生成真实章纲；用户手动编辑后清除该标记 */
  expanded?: boolean
}

export interface WorkflowOutlineInfoItem {
  label: string
  value: string
}

export interface WorkflowOutlineSuggestion {
  title: string
  desc: string
  icon: string
}

export interface WorkflowOutlineResult {
  titleOptions: WorkflowOutlineTitleOption[]
  selectedTitleId: string
  /** 作品简介的唯一真源；infoItems 不再重复保存书名与简介 */
  intro: string
  storyHook: string
  worldItems: string[]
  volumes: WorkflowOutlineVolume[]
  selectedVolumeId: string
  chapters: WorkflowOutlineChapter[]
  infoItems: WorkflowOutlineInfoItem[]
  suggestions: WorkflowOutlineSuggestion[]
}

/** 第三步「按要求调整大纲」：调整范围只覆盖大纲里有独立字段的部分，不含章节大纲 */
export type WorkflowOutlineAdjustScope = 'all' | 'title' | 'storyHook' | 'world' | 'volumes'

/** 保留项必须能映射到具体字段，应用候选前逐项硬校验，不依赖模型自觉 */
export type WorkflowOutlinePreserveKey = 'title' | 'storyHook' | 'worldItems' | 'volumeCount'

export interface WorkflowOutlineAdjustRequest {
  scope: WorkflowOutlineAdjustScope
  instruction: string
  preserve: WorkflowOutlinePreserveKey[]
  allowVolumeTitleChange: boolean
}

export interface WorkflowOutlineAdjustChange {
  key: string
  label: string
  before: string
  after: string
}

export interface WorkflowOutlineAdjustConsistency {
  passed: boolean
  message: string
  /** 与大纲对不上的软提示，不阻断应用；大纲调整侧不产生，恒为空 */
  warnings?: string[]
}

export interface WorkflowOutlineAdjustCandidate {
  /** 服务端候选产物 ID，应用与废弃都按它定位 */
  candidateId: number
  /** 应用后将成为的版本号 */
  version: number
  request: WorkflowOutlineAdjustRequest | null
  /** 模型给出的语义标签，如「冲突前置」；代码算不出来 */
  tags: string[]
  changes: WorkflowOutlineAdjustChange[]
  consistency: WorkflowOutlineAdjustConsistency
  /** 整体重生将覆盖的手改条目数；单字段范围恒为 0 */
  manualEditCount: number
  /** 完整候选大纲，应用时整体替换当前大纲 */
  outline: WorkflowOutlineResult
}

/** 阶段、相位、候选展示结构在「大纲调整」与「设定调整」之间完全一致，共用一套 */
export type WorkflowAdjustStageStatus = 'pending' | 'running' | 'done'

export interface WorkflowAdjustStage {
  key: string
  label: string
  status: WorkflowAdjustStageStatus
}

export type WorkflowAdjustPhase = 'input' | 'generating' | 'candidate'

/** 公共抽屉只关心展示所需的字段，不关心候选里装的是大纲还是设定 */
export interface WorkflowAdjustCandidateView {
  tags: string[]
  changes: WorkflowOutlineAdjustChange[]
  consistency: WorkflowOutlineAdjustConsistency
  manualEditCount: number
}

export type WorkflowSettingAdjustScope =
  | 'all'
  | 'worldCards'
  | 'core'
  | 'characters'
  | 'storylines'
  | 'character'
  | 'storyline'

/** 保留项必须能映射到具体字段，应用候选前逐项硬校验，不依赖模型自觉 */
export type WorkflowSettingPreserveKey =
  | 'characterCount'
  | 'storylineCount'
  | 'protagonist'
  | 'cultivationRealms'
  | 'worldRules'

export interface WorkflowSettingAdjustRequest {
  scope: WorkflowSettingAdjustScope
  /** 单条目范围（character / storyline）下的目标 id；其余范围为空串 */
  targetId: string
  instruction: string
  preserve: WorkflowSettingPreserveKey[]
}

export interface WorkflowSettingAdjustCandidate {
  candidateId: number
  version: number
  request: WorkflowSettingAdjustRequest | null
  tags: string[]
  changes: WorkflowOutlineAdjustChange[]
  consistency: WorkflowOutlineAdjustConsistency
  manualEditCount: number
  /** 完整候选设定，应用时整体替换当前设定 */
  setting: WorkflowSettingResult
}

export type WorkflowSettingTab = 'world' | 'core' | 'characters' | 'storyline'

// 世界背景卡片：可承载段落、标签或要点列表，size 控制在栅格中的跨度
export interface WorkflowSettingCard {
  id: string
  icon: string
  title: string
  content?: string
  tags?: string[]
  bullets?: string[]
  size?: 'normal' | 'half' | 'full'
}

// 修炼体系的单个境界
export interface WorkflowSettingRealm {
  name: string
  desc: string
}

// 核心设定中带图标的小条目（世界机制 / 资源体系 / 先后天能力）
export interface WorkflowSettingCoreItem {
  icon: string
  title: string
  desc: string
}

export interface WorkflowSettingCore {
  cultivation: {
    intro: string
    realms: WorkflowSettingRealm[]
    more: string
  }
  ability: {
    intro: string
    innate: WorkflowSettingCoreItem
    acquired: WorkflowSettingCoreItem
    dimensions: string[]
  }
  mechanics: {
    intro: string
    items: WorkflowSettingCoreItem[]
  }
  resources: {
    intro: string
    items: WorkflowSettingCoreItem[]
  }
}

export interface WorkflowSettingCharacter {
  id: string
  name: string
  aliases?: string[]
  gender: '男' | '女' | '其他'
  identity: string
  background: string
  keywords: string
  motivation: string
  badge?: string
}

export interface WorkflowSettingStoryline {
  id: string
  icon: string
  title: string
  desc: string
  keyEvent: string
}

export interface WorkflowSettingAssistAction {
  title: string
  desc: string
  icon: string
}

export interface WorkflowSettingRecord {
  title: string
  date: string
}

export interface WorkflowSettingResult {
  worldCards: WorkflowSettingCard[]
  core: WorkflowSettingCore
  characters: WorkflowSettingCharacter[]
  storylines: WorkflowSettingStoryline[]
  assistActions: WorkflowSettingAssistAction[]
  records: WorkflowSettingRecord[]
}

export interface WorkflowDraft {
  id: number
  bookId: number
  draftRevision: number
  outlineRevision: number
  title: string
  status: WorkflowStatus
  currentStep: WorkflowStepCode
  templateCode: string
  templateName: string
  ideaText: string
  baseConfig: WorkflowBaseConfig
  agentMap: WorkflowAgentMap
  templatePolicy: JsonRecord
  outlineResult: WorkflowOutlineResult
  settingResult: WorkflowSettingResult
}

export interface WorkflowHistoryItem {
  id: number
  title: string
  stepTitle: string
  status: WorkflowStatus
  updatedAt: string
  model: string
  agent: string
}
