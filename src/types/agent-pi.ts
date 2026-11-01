/** Pi 原生事件的界面投影，不沿用旧 Agent 的会话或任务契约。 */
export interface PiHeldTask {
  kind: import('@/agent-pi/tasks').PiTaskKind
  id: string
  revision: number
  wasRunning: boolean
}
export interface PiRunControl {
  state: 'active' | 'paused' | 'ended'
  revision: number
  heldTasks: PiHeldTask[]
  resumeAgent: boolean
  pausedBookId: string | null
  pendingInput: string | null
  rankings: import('./pi-rankings').PiRankingPolicy | null
}
export interface PiRunControlChange {
  control: PiRunControl
  releasedTasks: PiHeldTask[]
  resumeAgent: boolean
}
export interface PiBook {
  id: string
  title: string
}
export interface PiSession {
  runControl?: PiRunControl
  id: string
  file: string
  title: string
  book: PiBook | null
  updatedAt: number
  modelCode?: string
  localKey?: string
  status?: 'running' | 'waiting' | 'connecting' | 'failed'
  /** 宿主侧元数据：作者改名或自动起名、分组、置顶、归档。 */
  named?: boolean
  titleSource?: 'auto' | 'manual'
  groupId?: string | null
  pinnedAt?: number | null
  archivedAt?: number | null
}
export interface PiSessionGroup {
  id: string
  name: string
  order: number
  createdAt: number
}
export interface PiSessionSearchHit {
  id: string
  file: string
  snippet: string
}
export interface PiContent {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  arguments?: Record<string, unknown>
}
export interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: PiContent[] | string
  timestamp?: number
  stopReason?: string
  errorMessage?: string
  /** 瞬时失败的界面状态；原始错误保留用于诊断。 */
  errorRecovered?: boolean
  errorRetrying?: boolean
  toolName?: string
  toolCallId?: string
  isError?: boolean
  details?: Record<string, unknown>
  /** 工具结果的一句摘要，给过程区显示；完整结果不进界面。 */
  summary?: string
}
/** Pi 原生会话树；界面读取当前分支的持久化消息，模型压缩不删除历史卡片。 */
export interface PiSessionHistory {
  entries: Array<{ id: string; parentId: string | null; type: string; message?: PiMessage; targetId?: string; replacement?: unknown; customType?: string; display?: boolean; content?: string; timestamp?: string; data?: Record<string, unknown>; details?: Record<string, unknown> }>
  leafId: string | null
}
export interface PiEvent {
  type: string
  id?: string
  command?: string
  success?: boolean
  error?: string
  data?: Record<string, unknown>
  message?: PiMessage | { role: 'custom'; customType: string; display: boolean; content: string; timestamp: number; details?: Record<string, unknown> } | string
  assistantMessageEvent?: {
    type: string
    contentIndex?: number
    delta?: string
    content?: string
    id?: string
    toolName?: string
    toolCall?: PiContent
  }
  toolCallId?: string
  toolName?: string
  result?: { content?: PiContent[]; details?: Record<string, unknown> }
  isError?: boolean
  aborted?: boolean
  method?: string
  title?: string
  messageText?: string
  options?: string[]
  [key: string]: unknown
}
export interface PiToolRequest {
  id: string
  instanceId: string
  tool: string
  args: Record<string, unknown>
  callId: string
  book: PiBook | null
}
interface PiDraftBase {
  /** 初次生成这一候选时实际读取的资源版本与片段，不代表模型已正确遵循。 */
  proseSource?: {historyAnchor?:{id:string;revision:string};skill:string;skillVersion:number;model:string;sampleVersion?:string;sampleIds?:string[];expressionSamples?:Array<{id:string;from:string}>;editExampleIds?:string[];inputIds:string[];chapters:Array<{chapterId:string;version:number}>;callId:string}
  resourceUse?: import('./writing-resource').ResourceUse[]
  id: string
  sessionId: string
  bookId: string
  title: string
  content: string
  createdAt: number
  appliedAt?: number
  /** 作者在前情核对卡上决定暂不采用：仍显示、仍可采用，只是写新章时不再当作上一章。 */
  dismissedAt?: number
  revision?: number
}
/** 本章章纲。catalog 表示来自目录里已有的章纲；chat 表示聊天模型本次拟定、平台已存进本章大纲。 */
export interface PiChapterPlan { summary: string; beats?: string[]; source: 'catalog' | 'chat' }
export interface PiChapterDraft extends PiDraftBase {
  kind: 'chapter'
  plan?: PiChapterPlan
  selection?: {text:string;occurrence:number}
  chapterId: number
  baseVersion: number
  baseText: string
  baseTitle: string
  appliedVersion?: number
  appliedOperationId?: string
  baseVolumeId?: string
}
export interface PiOutlineDraft extends PiDraftBase {
  kind: 'outline'
  outlineId: number
  baseOutline: { title: string; content?: string }
}
export interface PiNewChapterDraft extends PiDraftBase {
  kind: 'new_chapter'
  plan?: PiChapterPlan
  appendAnchor?: string | null
  volumeId: string
  volumeTitle: string
  placement: 'append'
  /** 只有作者确认并原子创建后才有章节编号。 */
  chapterId?: number
  appliedVersion?: number
  appliedOperationId?: string
}
export type PiEntityKind = keyof typeof import('./pi-entities.json')
export interface PiEntityDraft extends PiDraftBase {
  kind: 'entity'
  entity: PiEntityKind
  targetId: string | null
  baseEntity: Record<string, unknown> | null
  appliedEntityId?: string
  appliedBookId?: string
}
/** 技能候选：模型按内置技能「创建技能」整理出的技能，作者在右栏看、改、采用后写进作者技能目录。content 是 JSON：name、description、instructions、files、replaceId。 */
export interface PiSkillDraft extends PiDraftBase {
  kind: 'skill'
  /** 替换哪个作者技能（编号）；空是新建 */
  replaceId: string | null
  appliedSkillId?: string
  appliedSkillName?: string
}
export interface PiStandaloneDraft extends PiDraftBase {
  kind: 'short_story' | 'text'
  appliedBookId?: string
  chapterId?: number
}
export type PiDraft = PiStandaloneDraft | PiChapterDraft | PiNewChapterDraft | PiOutlineDraft | PiEntityDraft | PiSkillDraft
export interface PiAdoptionTicket {
  draftId: string
  revision: number
  fingerprint: string
}
export interface PiDraftConfirmation {
  draft: PiDraft
  ticket?: PiAdoptionTicket
}

/** 卡片显示格式：兼容模型的简单建议、平台业务卡和历史问答；不是模型工具的入参。 */
export interface PiQuestionOption {
  id: string
  title: string
  description?: string
  /** 选中后在这个选项下面显示一个输入框，比如"指定区间"要填章号。 */
  input?: { label?: string; placeholder?: string }
}
/** 分步提问里的一问：可以有选项，也可以只写字；任何一问都能跳过。 */
export interface PiQuestionStep {
  key: string
  question: string
  description?: string
  options: PiQuestionOption[]
  multiple: boolean
  allowFreeText: boolean
  placeholder?: string
}
export type PiStepAnswer =
  | { selected: string[]; selectedIds: string[]; text?: string; inputs?: Record<string, string> }
  | null
export interface PiBreakdownPlanCard {
  type: 'breakdown-plan'
  plan: {
    title: string
    scope: string
    chapterCount: number
    reusable: number
    chapters: string[]
    estimatedTokens: number
    estimatedMinutes: number[]
    model: string
  }
}
/** 运行技能脚本前的确认卡：哪个技能、哪个脚本、什么参数、为什么。 */
export interface PiSkillScriptCard {
  type: 'skill-script'
  skill: string
  script: string
  args: string[]
  reason: string
}
/** 批量写作前的确认卡：作品、范围、每章目标、模型；作者直接开始，或写要改什么退回模型改。 */
export interface PiBatchPlanCard {
  type: 'batch-plan'
  title: string
  scope: string
  goals: string[]
  model: string
}
/** 生成封面前的确认卡：简报摘要、画面描述、风格、尺寸、模型。 */
export interface PiCoverBriefCard {
  type: 'cover-brief'
  summary: string
  prompt: string
  style: string
  size: string
  model: string
}
/** 平台及历史记录保留完整卡片能力；模型 ask_author 只暴露 question 与 options。 */
export interface PiQuestionSpec {
  proposals?: Array<{ id: string; title: string; content: string }>
  kind: 'choice' | 'confirm'
  afterAnswer?: 'continue' | 'pause'
  multiple: boolean
  question: string
  description?: string
  options: PiQuestionOption[]
  /** 仅用于已保存问答的只读回放，不参与新的提问流程。 */
  historySteps: PiQuestionStep[]
  allowFreeText: boolean
  card: PiBreakdownPlanCard | PiBatchPlanCard | PiSkillScriptCard | PiCoverBriefCard | null
  defaultOptionId?: string
  placeholder?: string
  multiline?: boolean
}
export interface PiQuestionAnswer {
  nextAction?: 'continue' | 'pause'
  selected: string[]
  selectedIds?: string[]
  text?: string
  /** 带输入框的选项里作者填的内容，按选项编号记。 */
  inputs?: Record<string, string>
  /** 分步提问的逐项回答；null 表示那一问跳过。 */
  steps?: Record<string, PiStepAnswer>
  cancelled?: boolean
}
export interface PiPendingQuestion {
  id: string
  callId: string
  spec: PiQuestionSpec
  startedAt: number
}
export interface PiActivity {
  id: string
  name: string
  status: string
  args?: Record<string, unknown>
  progress?: string
  resultSummary?: string
  durationMs?: number
  isError?: boolean
  startedAt?: number
}
export interface PiSessionContext {
  runControl?: PiRunControl
  bookId: string
  modelCode: string
  revision: number
  instanceId?: string
  book?: PiBook | null
}

/** 单个 Pi 会话的界面投影；执行仍由对应的原生 Pi 实例管理。 */
/** 技能：内置的随应用分发，作者的放在应用数据目录；作者改过的内置技能标 overridden。 */
export interface PiSkill {
  id: string
  name: string
  /** 面向作者的名称；name 保留为原生命令和存储标识。 */
  displayName?: string
  description: string
  /** 只在作者手动调用时加载，模型不会自己选它。 */
  manual: boolean
  instructions: string
  source: 'builtin' | 'custom'
  overridden: boolean
  enabled: boolean
  dir: string
  file: string
  scripts: string[]
  updatedAt: number
}
/** 作者在输入框里 @ 的作品资料；模型按编号用工具读。 */
export interface PiReference {
  kind: 'chapter' | 'character' | 'setting' | 'outline' | 'storyline' | 'breakdown'
  id: number
  title: string
}
export interface PiChatState {
  runControl: PiRunControl
  controlling: boolean
  settling: boolean
  /** 外部入口复用同一执行状态，不改变桌面当前打开的会话。 */
  channel?: 'weixin'
  key: string
  title: string
  updatedAt: number
  instanceId: string
  sessionId: string
  sessionFile: string
  bookId: string
  modelCode: string
  contextRevision: number
  draft: string
  attachment: import('@/agent-pi/attachments').PendingBookAttachment | null
  /** 本会话已登记的附件（入库中、已完成、失败），消息里的附件卡按它显示状态。 */
  attachments: Record<string, import('@/agent-pi/attachments').BookAttachment>
  /** 下一条消息 @ 的资料，发出后清空；技能是文字开头的 /技能名 标记，不单独存。 */
  references: PiReference[]
  /** 这个对话里的 Pi 实例加载技能列表时的版本；技能页改过后要让它重新加载。 */
  skillsRevision: number
  /** 在分组里新建的对话，第一条消息发出后再把分组写进宿主元数据。 */
  pendingGroupId: string
  messages: PiMessage[]
  activities: PiActivity[]
  drafts: PiDraft[]
  openedDraft: PiDraft | null
  /** 右栏打开的拆书报告任务编号；和草稿只能开一个。 */
  /** 右栏打开的任务结果（拆书报告、文风技能、封面）；和草稿只能开一个。 */
  openedResult: { kind: import('@/agent-pi/tasks').PiTaskKind | 'ledger'; id: string } | null
  /** 按助手消息时间戳记的思考用时，只在本次运行期间有效。 */
  thinkingMs: Record<string, number>
  thinkingStartedAt: number | null
  dialog: PiEvent | null
  /** 扩展通过工具桥发来的引导卡；Pi 原生询问仍在 dialog。 */
  question: PiPendingQuestion | null
  answering: boolean
  answerDraft: string
  connecting: boolean
  running: boolean
  stopping: boolean
  stopFailed: boolean
  stopped: boolean
  pendingTasks: number
  error: string
  retry?: { attempt: number; maxAttempts: number }
  epoch: number
  streamingIndex: number | null
}
