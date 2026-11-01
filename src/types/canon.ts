// 作品状态与体检的数据类型；与 src-tauri/src/contracts/documents.json 对齐。
// 模型侧、Rust 宿主与前端共用同一份契约。

/** 内容来源：author 为作者明确表达，assumed 为作者委托 AI 拟定，suggested 为尚未确认的 AI 建议。不能把建议记成作者决定。 */
export interface PlanDecision {
  value: string
  by: 'author' | 'assumed' | 'suggested'
}

/** 八步开书中的作者决定。已回答的直接记录；明确委托才标 assumed，未确认建议不能代替作者选择。 */
export interface PlanDecisions {
  /** 类型 */
  genre?: PlanDecision
  /** 发在哪、写给谁，如“番茄，男频” */
  platform?: PlanDecision
  /** 兼容已记录的故事选择；不另设卖点选择题 */
  hook?: PlanDecision
  /** 主角姓名 */
  protagonistName?: PlanDecision
  /** 第3步由作者选择或明确委托的具体行动结果；原因属于人物动机 */
  protagonistGoal?: PlanDecision
  /** 兼容旧方案；第3步确认，新方案放入 writingPreferences.narration */
  narration?: PlanDecision
  /** 第6步由作者选择或明确委托的开篇方案；已经选过的直接沿用 */
  openingDirection?: PlanDecision
}

/** 人称只表示叙述者形式，限知或全知等信息放在 viewpoint，不拼在人称里。 */
export interface PlanNarration {
  value: '第一人称' | '第三人称'
  by: 'author' | 'assumed' | 'suggested'
}

/** 人称与视角分别记录。叙述人称在第3步由作者选择或明确委托，不自动默认第三人称；已有作品沿用设置。 */
export interface PlanWritingPreferences {
  /** 叙述人称 */
  narration?: PlanNarration
  /** 叙述跟随谁、读者可以知道哪些信息；按故事需要拟定 */
  viewpoint?: PlanDecision
  /** 轻松、严肃、黑暗等情绪倾向；与题材分类分开 */
  tone?: PlanDecision
  /** 旧方案原有叙述说明的无损保留，新方案不要填写 */
  legacyNarrationNote?: string
}

/** 建书时写进人物表的人物；主角放第一个，重要配角一两个即可。 */
export interface PlanCharacter {
  name: string
  role: '主角' | '配角' | '反派'
  /** 身份与处境 */
  summary: string
  /** 行动目标：当前或近期希望完成的具体事情 */
  goal?: string
  /** 人物动机：为什么要做这件事 */
  motivation?: string
  /** 长期目标：全书或较长阶段希望达成的结果，可待定 */
  longTermGoal?: string
  /** 性格与缺点 */
  personality?: string
  /** 特殊能力、它的规则与限制 */
  ability?: string
}

/** 建书时写进作品资料的世界设定；只写开头会用到的。 */
export interface PlanSetting {
  name: string
  type?: '地理' | '势力' | '功法' | '物品' | '等级' | '其他'
  detail: string
}

/** 开书方案包含题材定位、故事构思、人物设定、世界观设定、剧情大纲、开篇章纲、书名与简介；最后创建作品。
按八步逐步推进，已回答的沿用。progress.current 是首个未完成步骤，blocking 列出未定决定；新书需完成作者选择或明确委托后再创建，授权与版本另行核验。 */
export interface BookPlan {
  /** 准备阶段可留空；建书前必须有，由作者在备选里挑或自拟后写入 */
  workingTitle: string
  writingMode?: 'explore' | 'outline'
  /** 作者选择的写作画像编号，从 list_writing_profiles 获取；未知时省略，不能把已明确的平台只写在说明里 */
  profileId?: string
  /** 本书已确定的读者群，如男频、女频或不限 */
  audience?: string
  /** 作者对本书的具体文风要求，随开书方案创建时传给生成、修订与评审 */
  styleRequirements?: string
  /** styleRequirements 的作者原话依据，必须逐字来自作者消息；没有依据的风格建议使用 styleSuggestions */
  styleRequirementQuote?: string
  /** AI 或平台提供的文风建议，可调整，不作为作者强制要求 */
  styleSuggestions?: string
  /** 选择记录与内容来源 */
  decisions?: PlanDecisions
  writingPreferences?: PlanWritingPreferences
  /** 读者在书城看到的简介，20–600 字；建书时随书名一起写进作品，开书阶段不要另存简介候选 */
  intro?: string
  /** 主角身份、核心设定、起始事件与主要阻力组成的完整故事方案；选过故事就沿用，不重新拆成选择题 */
  premise?: string
  /** 这份故事方案区别于同类作品的吸引点，是方案说明，不是需要另选的方向 */
  sellingPoint?: string
  /** 给作者看的主角说明；要写进人物表的人物用 characters，没定的姓名不能冒充作者决定 */
  protagonist?: string
  /** 谁或什么阻碍主角达成目标；与特殊能力的规则和代价分开说明 */
  conflict?: string
  /** 主角放第一个；建书时写进人物表 */
  characters?: PlanCharacter[]
  /** 社会背景、势力关系及题材需要的力量体系；只写开篇所需内容，不强制特殊能力 */
  world?: PlanSetting[]
  /** 把已选故事展开为主线、阶段发展与关键事件；不重新选故事，不强制确定结局 */
  outline?: string
  /** 按第6步选定或委托拟定的开篇方案展开前三章的事件、人物选择与衔接 */
  opening?: string
  /** 可继续完善的内容，不自动转成必答问题 */
  unresolved?: string[]
}

export interface CharacterFields {
  /** 姓名 */
  name?: string
  /** 0主角，1主要配角，2反派，3路人 */
  role?: number
  /** 0女，1男，2其他 */
  gender?: number
  /** 年龄描述文本，例如 "20岁"、"二十多岁"；未知时省略，不能传数字或 null */
  age?: string
  /** 外貌 */
  appearance?: string
  /** 性格 */
  personality?: string
  /** 背景 */
  background?: string
  /** 能力 */
  ability?: string
  /** 标签 */
  tags?: string[]
  /** 正文中出现的其他称呼，索引器据此解析人物；不含本名 */
  aliases?: string[]
  /** 口头禅、语气、句长偏好、禁用词、代表台词；生成对白与审稿时使用 */
  voice?: string
}

export interface OutlineFields {
  /** 标题 */
  title?: string
  /** 大纲内容 */
  content?: string
  /** 根目录传 "0" */
  parentId?: string
  /** 0目录，1内容 */
  nodeType?: number
}

export interface WorldFields {
  /** 设定名称 */
  name?: string
  /** 0地理，1势力，2功法，3物品，4等级，5其他 */
  type?: number
  /** 设定内容 */
  detail?: string
}

export interface TaskSegment {
  /** 作者原文中的连续片段，逐字保留，不改写、不增加 */
  text: string
  role: 'writing' | 'execution'
}

export interface TaskProjection {
  segments: TaskSegment[]
}

export interface DeliveryStep {
  revision: number
  action: 'review' | 'revise' | 'restore'
  reason: string
  issueIds?: string[]
}

export interface RequestBudget {
  callsLeft: number
  callsUsed: number
  secondsLeft: number
}

export interface DeliveryStatus {
  status: 'reviewing' | 'revising' | 'ready' | 'awaiting_author' | 'budget_exhausted' | 'failed' | 'needs_attention'
  revision: number
  rounds: number
  reason: string
  remainingIssueIds: string[]
  history: DeliveryStep[]
  /** 按工具返回的原始文本编号传入，不改成数字 */
  operationId?: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  runId?: string
  fingerprint?: string
  budget?: RequestBudget
}

export interface RankSourceRequest {
  siteCode?: 'fanqie' | 'qidian' | 'qimao'
  gender?: 'male' | 'female'
  rankType?: string
  category?: string
  offset?: number
  limit?: number
}

export interface RankGetRequest {
  /** 能力目录中的榜单编号 */
  sourceId: number
  /** latest 获取最新可用榜单，必要时联网刷新；cached 仅本地；historical 精确读取 statDate 指定日期 */
  freshness: 'latest' | 'cached' | 'historical'
  /** 快照日期 YYYY-MM-DD；空值选择本地最新快照 */
  statDate?: string
  limit?: number
}

/** 范围查询；筛选条件只收窄采集范围，展示数量不限制分类数量。 */
export interface RankCollectionRequest {
  /** 作者要看的平台；作者没指定时这不是可以随便补的默认值 */
  siteCode: 'fanqie' | 'qidian' | 'qimao'
  /** 目录 filters.rankTypes 中的榜型值 */
  rankType: string
  /** 省略表示所有频道；仅请求明确限定频道时填写 */
  gender?: 'male' | 'female'
  /** 省略表示该范围的全部分类，不依据浏览偏好或已有缓存缩小范围 */
  category?: string
  /** 默认 latest，按频控刷新整个范围，没抓过的来源要联网，常需几分钟；cached 只读本地快照；historical 读取指定历史日期 */
  freshness?: 'latest' | 'cached' | 'historical'
  /** 快照日期 YYYY-MM-DD；空值选择本地最新快照 */
  statDate?: string
  /** 汇总展示总条数，默认20，在不同指标口径组间分配；不限制采集的分类数量 */
  limit?: number
  /** 每分类预览条数，默认3；完整采集结果保存在快照库，可用 get_rank 读取 */
  perCategoryLimit?: number
}

/** 人物、地点、物品、势力的引用。id 解析不到时省略，宿主放入待登记列表，不以文本名入账。 */
export interface EntityRef {
  kind: 'character' | 'location' | 'item' | 'faction'
  /** 人物表或实体表中的编号；解析不到时省略 */
  id?: string
  name: string
}

export interface Event {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  eventId: string
  summary: string
  characters: EntityRef[]
  location?: EntityRef
  /** 故事发生顺序；倒叙、回忆按实际发生时间填写 */
  storyOrder: number
  isFlashback: boolean
  /** 伪装、误导、假死等后文会推翻的表象 */
  isMisdirection: boolean
}

export interface StateChange {
  character: EntityRef
  field: 'realm' | 'location' | 'item' | 'relation' | 'goal' | 'alive'
  before?: string
  after: string
  /** field=alive 时填写：这次变化之后此人是否还活着。假死、濒死、重伤、被封印都算 alive；正文没写清就填 unknown */
  aliveAfter?: 'alive' | 'dead' | 'unknown'
  storyOrder: number
  /** 所属事件；伪装、误导事件里的变化不参与状态折叠 */
  eventId?: string
  /** 来源原文中连续存在的摘录，不改字、不拼接；宿主核对不到原文即降为待核实 */
  quote: string
  /** 0 到 1；低于 0.7 进入待核实 */
  confidence: number
}

export interface Fact {
  /** 首次出现时分配，后文引用同一编号；修正旧事实用 supersedes */
  factId: string
  text: string
  /** 来源原文中连续存在的摘录，不改字、不拼接；宿主核对不到原文即降为待核实 */
  quote: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  supersedes?: string
}

export interface KnowledgeEntry {
  character: EntityRef
  /** 按工具返回的原始文本编号传入，不改成数字 */
  factId: string
  /** 得知该事实的故事顺序 */
  learnedAt: number
  /** true 表示只有读者通过叙述得知，人物本身并不知道 */
  viaNarration: boolean
  /** 按工具返回的原始文本编号传入，不改成数字 */
  eventId?: string
  /** 来源原文中连续存在的摘录，不改字、不拼接；宿主核对不到原文即降为待核实 */
  quote: string
}

export interface ThreadTouch {
  kind: 'foreshadow' | 'suspense' | 'promise' | 'payoffSetup' | 'romance'
  action: 'plant' | 'advance' | 'payoff'
  /** advance / payoff 必须引用已有线索；plant 留空由宿主分配 */
  threadId?: string
  text: string
  /** 来源原文中连续存在的摘录，不改字、不拼接；宿主核对不到原文即降为待核实 */
  quote: string
}

export interface HookSpec {
  position: 'opening' | 'mid' | 'end'
  type: '悬念' | '危机' | '反转' | '期待' | '情绪' | '信息' | '关系'
  text: string
  strength?: number
}

export interface PayoffSpec {
  type: '打脸' | '装逼' | '升级' | '收获' | '认可' | '逆袭' | '报复' | '掌控' | '越级' | '情感' | '团宠'
  /** 铺垫来源：线索编号或前文章节与摘录 */
  setupRef?: string
  strength: number
  /** 是否写了旁观者反应放大 */
  amplified: boolean
  /** 来源原文中连续存在的摘录，不改字、不拼接；宿主核对不到原文即降为待核实 */
  quote?: string
}

export interface EmotionCurve {
  open: string
  peak: string
  close: string
}

export interface StoryTime {
  label: string
  order: number
}

/** 一章的结构化摘要。来源版本、失效状态由宿主记录，不在文档内。 */
export interface ChapterCard {
  oneLine: string
  /** 叙述顺序，即目录位置 */
  narrativeOrder: number
  events: Event[]
  stateChanges: StateChange[]
  facts: Fact[]
  knowledge: KnowledgeEntry[]
  threads: ThreadTouch[]
  hooks: HookSpec[]
  payoffs: PayoffSpec[]
  emotion: EmotionCurve
  storyTime?: StoryTime
}

/** 一个场景的要点：自然语言，写给接着往下写的人看；不写数字目标，不写写法规则。 */
export interface Scene {
  no: number
  /** 场景类型；宿主按它挑同类型的文风范例给写作模型 */
  kind: '开章' | '对白' | '打斗' | '心理' | '过渡' | '收尾'
  /** 谁在哪、要发生什么、以什么收，三五句话；只说事，不说怎么写 */
  points: string
  /** 出场人物名；宿主据此附上他们的当前状态 */
  characters?: string[]
}

/** 一章的场景安排：按叙事需要分场景，不按固定数量凑场景。 */
export interface ScenePlan {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  rulesetId: string
  /** 这一章要让读者记住的一件事，一两句 */
  chapterGoal: string
  scenes: Scene[]
  /** 章末留给读者的期待，自然语言 */
  expectation?: string
  /** 本章释放的设定或信息 */
  infoRelease?: string[]
  threadsTouched?: ThreadTouch[]
}

export interface ChapterPlanEntry {
  no: number
  title: string
  /** 谁做了什么、遇到什么阻力、结果如何，80–150 字 */
  outline: string
  /** 本章给出的期待 */
  expectation: string
  /** 本章兑现的期待；没有就省略 */
  payoff?: string
  hookType: '悬念' | '危机' | '反转' | '期待' | '情绪' | '信息' | '关系'
  payoffType?: '打脸' | '装逼' | '升级' | '收获' | '认可' | '逆袭' | '报复' | '掌控' | '越级' | '情感' | '团宠'
  /** 本章推进或回收的线索编号 */
  threads?: string[]
}

/** 一批章纲与期待-兑现表。 */
export interface ChapterBatchPlan {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  rulesetId: string
  stageGoal: string
  entries: ChapterPlanEntry[]
}

/** 一次写作任务解析出的规则集快照；规划、生成、评审必须传同一编号。 */
export interface Ruleset {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  rulesetId: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  bookId: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  profileId: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  skillId?: string
  /** 本次选定的文风技能；空字符串明确不使用文风技能 */
  styleSkillId?: string
  ruleIds: string[]
  authorInstruction?: string
  fingerprint: string
}

export interface RepairRange {
  start: number
  /** 含末段；连续修订单元必须含该问题至少一处有效引文定位 */
  end: number
}

export interface QualityIssue {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  id: string
  source: 'rule' | 'critic'
  code: string
  dimension: string
  /** block 只用于结构与数据完整性问题；语义判断只能是 suspect 或 notice */
  level: 'block' | 'suspect' | 'notice'
  message: string
  paragraphs: number[]
  /** suspect 至少两处：状态来源与本章原文 */
  quotes: string[]
  fix?: string
  metrics?: Record<string, number>
  /** 程序检测到的模式线索，尚不构成阅读问题；需要结合语境复核 */
  observation?: boolean
  /** 具体如何打断理解、削弱人物可信度或消耗阅读期待 */
  readerEffect?: string
  impact?: 'major' | 'minor'
  /** prose_only 为语言修订；draft_edit 为不改变已有事实、主线与本章目标的草稿返工；author_decision 为会改变作者已定事实、增加剧情事件或重大取舍；不成立或仅观察用 none */
  repairMode?: 'prose_only' | 'draft_edit' | 'author_decision' | 'none'
  evidenceStatus?: 'verified' | 'unlocated'
  /** 需要联动改写时列出最小完整叙述单元，包含引文段及必须一起调整的邻段，避免只改单句造成上下文重复或断裂；无需联动可省略 */
  repairRanges?: RepairRange[]
}

/** 程序量出来的数字：结构计数与文风指纹。只给人看，不进提示词，不作关卡。 */
export interface QualityMetrics {
  words: number
  paragraphs: number
  repeatedParagraphs: number
  estimatedTokens: number
  avgParagraphLen?: number
  paragraphLenStd?: number
  dialogueRatio?: number
  sentenceLenStd?: number
  /** 文风指纹：句长、句长变异、长短句占比、段长、单句段、段末短句、对白占比、各类标点每千字、比喻词每千字、“的”每百字 */
  fingerprint?: Record<string, number>
}

export interface RevisionAssessment {
  progress: 'improved' | 'unchanged' | 'regressed'
  factsPreserved: boolean
  withinScope: boolean
  reason: string
  resolvedIssueIds: string[]
}

/** 编辑评审的结果摘要：只有结论与问题，没有评分。 */
export interface CriticSummary {
  status: 'available' | 'partial' | 'unavailable' | 'not_run' | 'failed'
  errorCode?: string
  retryable?: boolean
  persona?: string
  summary?: string
  error?: string
  /** 兼容旧报告：仅表示曾尝试修订，不表示问题已解决 */
  revisedIssueIds?: string[]
  revisionAssessment?: RevisionAssessment
}

export interface StyleDriftItem {
  key: string
  label: string
  value: number
  baseline: number
  /** 相对偏差，(value-baseline)/baseline */
  ratio?: number
  flagged: boolean
}

/** 生成稿指纹与文风基线的偏移：温度计，只在界面提示，不拦保存，不进评审。 */
export interface StyleDrift {
  baseline: string
  items: StyleDriftItem[]
  flagged: number
  note?: string
}

/** 绑定到具体成果版本的体检报告；成果内容变化后由宿主标记过期。 */
export interface QualityReport {
  version: 1
  /** 按工具返回的原始文本编号传入，不改成数字 */
  artifactId: string
  reviewedRevision: number
  reviewedFingerprint: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  rulesetId: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  chapterId?: string
  /** 按工具返回的原始文本编号传入，不改成数字 */
  profileId: string
  issues: QualityIssue[]
  metrics: QualityMetrics
  critic?: CriticSummary
  writingBasisFingerprint?: string
  styleDrift?: StyleDrift
}

export interface CriticIssue {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  id: string
  source: 'rule' | 'critic'
  code: string
  dimension: string
  /** block 只用于结构与数据完整性问题；语义判断只能是 suspect 或 notice */
  level: 'block' | 'suspect' | 'notice'
  message: string
  paragraphs: number[]
  /** suspect 至少两处：状态来源与本章原文 */
  quotes: string[]
  fix: string
  metrics?: Record<string, number>
  /** 程序检测到的模式线索，尚不构成阅读问题；需要结合语境复核 */
  observation?: boolean
  /** 具体如何打断理解、削弱人物可信度或消耗阅读期待 */
  readerEffect?: string
  impact?: 'major' | 'minor'
  /** prose_only 为语言修订；draft_edit 为不改变已有事实、主线与本章目标的草稿返工；author_decision 为会改变作者已定事实、增加剧情事件或重大取舍；不成立或仅观察用 none */
  repairMode: 'prose_only' | 'draft_edit' | 'author_decision' | 'none'
  evidenceStatus?: 'verified' | 'unlocated'
  /** 每个范围为含引文段的最小完整叙述单元；只改单段或不修时返回空列表 */
  repairRanges: RepairRange[]
}

/** 依据原文检查事实与表达；不打分。修订核验须返回 revisionAssessment。 */
export interface CriticReview {
  persona?: string
  summary: string
  issues: CriticIssue[]
  revisionAssessment?: RevisionAssessment
}

export interface SpanEdit {
  /** 优先使用 targetBlocks 中宿主给出的 blockId，原样带回，禁止自编或重新计算段号 */
  blockId?: string
  /** 兼容旧任务的原始段号；使用 blockId 时由宿主确定范围 */
  index?: number
  /** 合并连续目标段落时填写末段序号，包含末段；省略表示只改 index 所在段 */
  endIndex?: number
  /** 该目标段或连续段块的完整替换文字。可合段；仅纯重复或分隔标记可为空，独有信息必须保留在目标块内 */
  text: string
}

/** 定向修订：只返回被标记段落的新文本，其余段落逐字不动。 */
export interface SpanRevision {
  paragraphs: SpanEdit[]
}

export interface GatePolicy {
  block: string[]
  suspect: string[]
  notice: string[]
}

export interface PlatformProfile {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  id: string
  name: string
  /** [下限, 上限] */
  chapterWords: number[]
  paragraphMaxChars: number
  endHookRequired: boolean
  /** 开篇多少字内应出现冲突或悬念 */
  openingHookWithin: number
  /** 每多少章至少一个小爽点 */
  payoffEvery: number
  midPayoffEvery: number
  suppressMaxChapters: number
  infoReleaseLevel: 'low' | 'mid' | 'high'
  readerPersona: string
  gate: GatePolicy
}

export interface StoryTopic {
  genre: string
  emotionCore: string
  contrast: string
  logline: string
}

export interface Mainline {
  want: string
  obstacle: string
}

export interface Twist {
  readerThinks: string
  actually: string
}

export interface Ending {
  type: '爽' | '虐' | '暖'
  afterTaste?: string
}

export interface ShortStoryPlan {
  /** 按工具返回的原始文本编号传入，不改成数字 */
  rulesetId: string
  topic: StoryTopic
  openingLines: string[]
  mainline: Mainline
  /** 按作者与选定方法安排反转，不要求固定数量；无需反转时可留空 */
  twists: Twist[]
  ending: Ending
  infoOrder: string[]
  /** 从 read_style_profile 选择的表达示例编号；示例不是本故事事实 */
  styleSampleIds?: string[]
}

/** 数据证据只指明依据哪份快照、哪几本书。名次、指标由宿主从快照读出并展示，模型不转述数字，
因此“已核对”的内容不依赖对模型文字的理解。 */
export interface RankEvidence {
  kind: 'data'
  /** 榜单编号，取自榜单工具返回的 source.id 或 sourceId */
  sourceId: number
  /** 快照日期，取自返回的 snapshot.statDate */
  snapshotDate: string
  /** 相关上榜书名，照抄工具返回的 bookTitle；不填表示引用整份快照 */
  books?: string[]
}

/** 模型自己的归纳、比较、统计与题材判断，界面标为“判断”，不作核对。 */
export interface JudgmentEvidence {
  kind: 'judgment'
  fact: string
  /** 依据，如“对上述快照的归纳”“作者画像”“拆书资料” */
  source: string
}

export interface SelectionCard {
  genre: string
  sellingPoint: string
  protagonist: string
  opening: string
  benchmarks: string[]
  risks: string[]
  /** data 只引用快照与书名，数据由宿主读出；judgment 写模型的归纳与判断 */
  evidence: Array<RankEvidence | JudgmentEvidence>
}

export interface PromptOption {
  id: string
  /** 选中即可表达答案的具体内容；已有候选时使用候选名称，不用需要再填编号的操作方式代替答案 */
  title: string
  description?: string
  preview?: string
}

/** 分步问答里的一问：界面一次只显示一问。作者可以点建议选项、自己写，或跳过交给 Agent 先给建议。 */
export interface PromptStep {
  key: string
  question: string
  /** 一句话说明为什么问、答到什么程度 */
  hint?: string
  /** 2–4 个建议答案，贴合这本书已知的题材与设定 */
  options?: PromptOption[]
  /** 可以同时选多项 */
  multiple?: boolean
  /** 作者不答就没法往下做时才设 true，其余 false */
  required: boolean
  placeholder?: string
}

export interface PromptField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'select'
  /** 作者不填就没法往下做时才设 true；问题里说了可以留空的一律 false */
  required: boolean
  placeholder?: string
  options?: string[]
  default?: string
}

/** 需要作者决定时的引导卡。choice 单选、multi 多选、steps 分步问答、form 多字段表单、compare 并排两到四份成果、confirm 是否。 */
export interface AuthorPrompt {
  kind: 'choice' | 'multi' | 'steps' | 'form' | 'compare' | 'confirm'
  question: string
  options?: PromptOption[]
  steps?: PromptStep[]
  fields?: PromptField[]
  allowFreeText: boolean
  /** compare 时并排展示的 2–4 份成果；让作者在一份成果里的候选（书名、人名）中挑时不用 compare，用 choice 把候选列成 options */
  artifactIds?: string[]
  defaultOptionId?: string
}

export interface StepAnswer {
  selectedIds: string[]
  text?: string
}

export interface AuthorAnswer {
  selectedIds: string[]
  text?: string
  fields?: Record<string, string>
  /** 分步问答：问题 key → 这一问的回答 */
  steps?: Record<string, StepAnswer>
}

/** 阅读一个片段时标出的一处有辨识度的段落：连续的段落编号，由宿主取回原文。 */
export interface DistillationPick {
  /** 这几段属于哪种场景 */
  kind: '开章' | '对白' | '打斗' | '心理' | '过渡' | '收尾'
  /** 一句话说它有辨识度在哪：对白怎么接、动作与心理怎么穿插、段落怎么收 */
  why: string
  /** passages 里连续的段落编号，合计三百到六百字 */
  sourceIds: string[]
}

export interface DistillationLeaf {
  /** 这一片段在故事里做的事：怎么开篇、怎么放信息、怎么换地图；不提人名 */
  summary: string
  observations: DistillationPick[]
}

/** 写法卡一条：可执行的做法，指向一到三段真实范例。 */
export interface DistillationNote {
  text: string
  /** 输入里范例的编号 */
  evidence: string[]
}

export interface DistillationDigest {
  /** 叙事模式：这本书怎么开篇、怎么换地图、怎么放信息，每条一行，不含人名和专有设定 */
  summary: string
  observations: DistillationNote[]
}

export interface DistillationReviewItem {
  /** 输入 notes 里的序号 */
  index: number
  verdict: 'keep' | 'revise' | 'omit'
  reason: string
  /** 核验后的写法卡；omit 留空 */
  text: string
}

export interface DistillationReview {
  items: DistillationReviewItem[]
}

export type CanonDocumentKind = 'taskProjection' | 'deliveryStatus' | 'rankSourceRequest' | 'rankGetRequest' | 'rankCollectionRequest' | 'chapterCard' | 'scenePlan' | 'chapterBatchPlan' | 'ruleset' | 'qualityReport' | 'criticReview' | 'spanRevision' | 'platformProfile' | 'shortStoryPlan' | 'selectionCard' | 'authorPrompt' | 'authorAnswer' | 'distillationLeaf' | 'distillationDigest' | 'distillationReview'

export interface CanonDocuments {
  taskProjection: TaskProjection
  deliveryStatus: DeliveryStatus
  rankSourceRequest: RankSourceRequest
  rankGetRequest: RankGetRequest
  rankCollectionRequest: RankCollectionRequest
  chapterCard: ChapterCard
  scenePlan: ScenePlan
  chapterBatchPlan: ChapterBatchPlan
  ruleset: Ruleset
  qualityReport: QualityReport
  criticReview: CriticReview
  spanRevision: SpanRevision
  platformProfile: PlatformProfile
  shortStoryPlan: ShortStoryPlan
  selectionCard: SelectionCard
  authorPrompt: AuthorPrompt
  authorAnswer: AuthorAnswer
  distillationLeaf: DistillationLeaf
  distillationDigest: DistillationDigest
  distillationReview: DistillationReview
}

export const CANON_CONTRACT_VERSION = 1
