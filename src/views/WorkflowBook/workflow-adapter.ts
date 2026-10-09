import { normalizeCharacterAliases } from '@/utils/character-aliases'
import type { JsonRecord } from '@/types/json'
import type {
  WorkflowArtifact,
  WorkflowCreationDefaults,
  WorkflowRun,
} from '@/types/workflow'
import type {
  WorkflowBaseConfig,
  WorkflowDraft,
  WorkflowHistoryItem,
  WorkflowOutlineChapter,
  WorkflowOutlineInfoItem,
  WorkflowOutlineResult,
  WorkflowOutlineSuggestion,
  WorkflowOutlineStage,
  WorkflowOutlineTitleOption,
  WorkflowOutlineVolume,
  WorkflowAgentMap,
  WorkflowSettingCard,
  WorkflowSettingCharacter,
  WorkflowSettingCore,
  WorkflowSettingResult,
  WorkflowSettingStoryline,
  WorkflowStatus,
  WorkflowStepCode,
} from './types'

const visibleSteps: WorkflowStepCode[] = ['MODE_SELECT', 'BASE_CONFIG', 'OUTLINE_GENERATE', 'SETTING_GENERATE']

const defaultBaseConfig: WorkflowBaseConfig = {
  platform: '番茄小说',
  genre: '玄幻',
  platformCategory: '',
  platformCategoryCode: '',
  platformCategorySource: 'common',
  tags: [],
  title: '',
  targetWords: '100万字左右',
  chapterTargetWords: '2200字左右',
  protagonist: '成长型主角',
  storyPerspective: '第三人称',
  audience: '男频',
  sellingPoint: '',
  // 空值 = 跟随 AI 偏好（各环节按对应场景的偏好模型执行），也是新建草稿的默认；
  // 不自动补具体模型，避免以 explicit 层静默压过用户的功能级模型偏好
  modelCode: '',
  modelFollowPreference: false,
  agentId: '',
}

const defaultAgentMap: WorkflowAgentMap = {}
const systemManagedAgentScenes = new Set(['studio_critic', 'studio_settle'])

const defaultOutlineSuggestions: WorkflowOutlineSuggestion[] = [
  { title: '优化故事冲突', desc: '增强矛盾张力', icon: 'fa-solid fa-bolt' },
  { title: '丰富角色动机', desc: '深化人物弧光', icon: 'fa-solid fa-user-pen' },
  { title: '补充伏笔线索', desc: '增强故事层次', icon: 'fa-solid fa-route' },
  { title: '优化节奏结构', desc: '提升阅读体验', icon: 'fa-solid fa-wave-square' },
  { title: '拓展世界观设定', desc: '完善背景细节', icon: 'fa-solid fa-globe' },
  { title: '生成更多卷纲', desc: '扩展故事篇幅', icon: 'fa-solid fa-layer-group' },
]

const defaultAssistActions = [
  { title: '生成世界背景', desc: '自动生成世界观设定', icon: 'fa-regular fa-lightbulb' },
  { title: '优化势力格局', desc: '丰富宗门与势力关系', icon: 'fa-solid fa-wand-magic-sparkles' },
  { title: '生成修炼体系', desc: '完善境界与规则设定', icon: 'fa-solid fa-spa' },
  { title: '生成地理环境', desc: '补充地图与区域细节', icon: 'fa-regular fa-map' },
  { title: '生成历史脉络', desc: '创建世界历史大事件', icon: 'fa-regular fa-calendar' },
  { title: '设定风格调整', desc: '调整整体设定风格', icon: 'fa-solid fa-sliders' },
]

const defaultCore: WorkflowSettingCore = {
  cultivation: {
    intro: '',
    realms: [],
    more: '',
  },
  ability: {
    intro: '',
    innate: { icon: 'fa-solid fa-cloud', title: '先天能力', desc: '' },
    acquired: { icon: 'fa-solid fa-spa', title: '后天能力', desc: '' },
    dimensions: [],
  },
  mechanics: {
    intro: '',
    items: [],
  },
  resources: {
    intro: '',
    items: [],
  },
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const normalizeVisibleStep = (step?: string): WorkflowStepCode => {
  const code = String(step || 'MODE_SELECT') as WorkflowStepCode
  return visibleSteps.includes(code) ? code : 'BASE_CONFIG'
}

const asText = (value: unknown) => String(value || '').trim()

const asTextArray = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return value.map(item => asText(item)).filter(Boolean)
}

const asTextList = (value: unknown) => {
  const text = asText(value)
  return Array.isArray(value) ? asTextArray(value) : (text ? [text] : [])
}

const getSelectedTitle = (outline: WorkflowOutlineResult) => (
  outline.titleOptions.find(item => item.id === outline.selectedTitleId)?.name || outline.titleOptions[0]?.name || ''
)

export const WORKFLOW_CREATION_DEFAULT_KEYS = [
  'platform',
  'genre',
  'targetWords',
  'chapterTargetWords',
  'protagonist',
  'storyPerspective',
  'audience',
] as const

export type WorkflowCreationDefaultKey =
  (typeof WORKFLOW_CREATION_DEFAULT_KEYS)[number]

export const applyWorkflowCreationDefaultsToNewDraft = (
  draft: WorkflowDraft,
  creationDefaults?: WorkflowCreationDefaults | null,
  touchedKeys?: ReadonlySet<WorkflowCreationDefaultKey>,
) => {
  if (
    !creationDefaults ||
    Number(draft.id || 0) !== 0 ||
    Number(draft.bookId || 0) !== 0 ||
    Number(draft.draftRevision || 0) !== 0
  ) {
    return false
  }
  const nextBaseConfig = { ...draft.baseConfig }
  let changed = false
  WORKFLOW_CREATION_DEFAULT_KEYS.forEach(key => {
    if (touchedKeys?.has(key)) return
    const currentValue = asText(draft.baseConfig[key])
    const legacyValue = asText(defaultBaseConfig[key])
    const nextValue = asText(creationDefaults[key])
    if (!nextValue || currentValue !== legacyValue || nextValue === currentValue) return
    nextBaseConfig[key] = nextValue
    changed = true
  })
  if (changed) draft.baseConfig = nextBaseConfig
  return changed
}

export const createInitialWorkflowDraft = (
  creationDefaults?: WorkflowCreationDefaults | null,
): WorkflowDraft => {
  const draft: WorkflowDraft = {
    id: 0,
    bookId: 0,
    draftRevision: 0,
    outlineRevision: 0,
    title: '未命名工作流',
    status: 'draft',
    currentStep: 'MODE_SELECT',
    templateCode: '',
    templateName: '',
    ideaText: '',
    baseConfig: clone(defaultBaseConfig),
    agentMap: clone(defaultAgentMap),
    templatePolicy: {},
    outlineResult: createEmptyOutlineResult(),
    settingResult: createEmptySettingResult(),
  }
  applyWorkflowCreationDefaultsToNewDraft(draft, creationDefaults)
  return draft
}

export const createEmptyOutlineResult = (): WorkflowOutlineResult => ({
  titleOptions: [{ id: 'title-1', name: '未命名作品' }],
  selectedTitleId: 'title-1',
  intro: '',
  storyHook: '',
  worldItems: [],
  volumes: [{
    id: 'vol-1',
    title: '第一卷',
    summary: '',
    chapterCount: 1,
    chapterCountMode: 'dynamic',
    chapterRange: { min: 1, max: 1 },
    stages: [],
  }],
  selectedVolumeId: 'vol-1',
  chapters: [],
  infoItems: [],
  suggestions: clone(defaultOutlineSuggestions),
})

export const createEmptySettingResult = (): WorkflowSettingResult => ({
  worldCards: [
    { id: 'world-name', icon: 'fa-solid fa-earth-asia', title: '世界名称', content: '', size: 'normal' },
    { id: 'world-type', icon: 'fa-solid fa-layer-group', title: '世界类型', tags: [], size: 'normal' },
    { id: 'world-rule', icon: 'fa-solid fa-yin-yang', title: '世界规则', content: '', size: 'full' },
  ],
  core: clone(defaultCore),
  characters: [],
  storylines: [],
  assistActions: clone(defaultAssistActions),
  records: [],
})

export const applyWorkflowRunToDraft = (draft: WorkflowDraft, run: WorkflowRun) => {
  const summary = run.summary || {}
  Object.assign(draft, {
    id: Number(run.id || 0),
    bookId: Number(run.bookId || 0),
    draftRevision: Number(run.draftRevision || 0),
    outlineRevision: Number(run.outlineRevision || 0),
    title: run.title || '未命名工作流',
    status: (run.status || 'draft') as WorkflowStatus,
    currentStep: normalizeVisibleStep(run.currentStep),
    templateCode: asText(run.templateCode || run.config?.templateCode),
    templateName: asText(run.templateName || run.config?.templateName),
    ideaText: asText(summary.ideaText),
    baseConfig: {
      ...clone(defaultBaseConfig),
      ...(run.config || {}),
      // 显式「跟随 AI 偏好」时保持空模型（每个环节按场景偏好解析），否则回退具体模型
      modelCode: run.config?.modelFollowPreference
        ? ''
        : run.modelCode || run.config?.modelCode || defaultBaseConfig.modelCode,
      agentId: run.agentId || run.config?.agentId || defaultBaseConfig.agentId,
    },
    agentMap: normalizeAgentMap(run.config?.agentMap, run.agentId || run.config?.agentId),
    templatePolicy: normalizePlainObject(run.config?.templatePolicy),
    outlineResult: normalizeOutlineResult(
      pickResultSource(
        summary.workflowOutlineUi,
        summary.workflowOutline,
        findArtifactContent(run.artifacts, 'outline'),
        outlineUiHasContent,
      )
    ),
    settingResult: normalizeSettingResult(
      pickResultSource(
        summary.workflowSettingUi,
        summary.workflowSetting,
        findArtifactContent(run.artifacts, 'setting'),
        settingUiHasContent,
      )
    ),
  })
}

// UI 快照在「尚未生成」时是一份非空的空骨架（默认书名 + 第一卷 + 建议列表），
// 用 `快照 || 产物` 会让它永久遮蔽服务端真实产物——用户中途离开页面、生成在后台
// 完成的场景下，回来看到的就是一片空白。只有快照确有内容时才优先它（保留手动编辑）。
const pickResultSource = (
  uiSnapshot: unknown,
  canonicalSnapshot: unknown,
  artifactContent: JsonRecord | null,
  hasContent: (value: unknown) => boolean
) => {
  if (hasContent(uiSnapshot)) return uiSnapshot as JsonRecord
  if (hasContent(canonicalSnapshot)) return canonicalSnapshot as JsonRecord
  return artifactContent || null
}

const outlineUiHasContent = (value: unknown) => {
  if (!isPlainObject(value)) return false
  if (Array.isArray(value.chapters) && value.chapters.length) return true
  if (Array.isArray(value.worldItems) && value.worldItems.length) return true
  if (asText(value.storyHook)) return true
  if (Array.isArray(value.volumes) && value.volumes.some(item => asText(item?.summary))) return true
  return Array.isArray(value.titleOptions)
    && value.titleOptions.some(item => asText(item?.name) && asText(item?.name) !== '未命名作品')
}

const settingUiHasContent = (value: unknown) => {
  if (!isPlainObject(value)) return false
  if (Array.isArray(value.characters) && value.characters.some(item => asText(item?.name))) return true
  if (Array.isArray(value.storylines) && value.storylines.some(item => asText(item?.title) || asText(item?.desc))) return true
  // worldCards 骨架自带 id/icon/title，只看用户可见内容
  const worldCards = Array.isArray(value.worldCards) ? value.worldCards : []
  if (worldCards.some(item => asText(item?.content) || item?.tags?.length || item?.bullets?.length)) return true
  const core = isPlainObject(value.core) ? value.core : null
  if (!core) return false
  return Boolean(
    asText(core.cultivation?.intro)
    || core.cultivation?.realms?.length
    || asText(core.ability?.intro)
    || core.mechanics?.items?.length
    || core.resources?.items?.length
  )
}

export const mapWorkflowHistory = (runs: WorkflowRun[]): WorkflowHistoryItem[] => (
  runs.map(run => ({
    id: Number(run.id),
    title: run.title || '未命名工作流',
    stepTitle: stepTitleMap[normalizeVisibleStep(run.currentStep)],
    status: (run.status || 'draft') as WorkflowStatus,
    updatedAt: formatUpdateTime(run.updateTime || run.createTime),
    model: run.modelCode || run.config?.modelCode || '',
    agent: run.agentId || run.config?.agentId || '',
  }))
)

export const buildWorkflowSavePayload = (draft: WorkflowDraft, override: Partial<WorkflowDraft> = {}) => {
  const nextDraft = { ...draft, ...override }
  const outlinePayload = toWorkflowOutlinePayload(nextDraft)
  const settingPayload = toWorkflowSettingPayload(nextDraft)
  return {
    id: nextDraft.id,
    expectedDraftRevision: nextDraft.draftRevision,
    title: resolveWorkflowTitle(nextDraft),
    status: nextDraft.status,
    currentStep: nextDraft.currentStep,
    modelCode: nextDraft.baseConfig.modelCode,
    agentId: nextDraft.baseConfig.agentId,
    templateCode: nextDraft.templateCode,
    templateName: nextDraft.templateName,
    config: {
      ...clone(nextDraft.baseConfig),
      templateCode: nextDraft.templateCode,
      templateName: nextDraft.templateName,
      agentMap: clone(nextDraft.agentMap),
      templatePolicy: clone(nextDraft.templatePolicy),
    },
    summary: {
      ideaText: nextDraft.ideaText,
      templateCode: nextDraft.templateCode,
      templateName: nextDraft.templateName,
      workflowOutline: outlinePayload,
      workflowOutlineUi: clone(nextDraft.outlineResult),
      workflowSetting: settingPayload,
      workflowSettingUi: clone(nextDraft.settingResult),
    },
  }
}

export const resolveWorkflowTitle = (draft: WorkflowDraft) => (
  getSelectedTitle(draft.outlineResult) || draft.baseConfig.title || draft.title || '未命名工作流'
)

export const normalizeOutlineResult = (content?: JsonRecord | null): WorkflowOutlineResult => {
  if (!content || !Object.keys(content).length) return createEmptyOutlineResult()
  const outlineContent = normalizeOutlineContent(content)
  const titleOptions = normalizeTitleOptions(outlineContent.titleOptions, outlineContent.title)
  const volumes = normalizeVolumes(outlineContent.volumes)
  const chapters = normalizeChapters(outlineContent.volumes, outlineContent.chapters, volumes)
  return {
    titleOptions,
    selectedTitleId: asText(outlineContent.selectedTitleId) || titleOptions[0]?.id || 'title-1',
    intro: normalizeOutlineIntro(outlineContent),
    storyHook: normalizeStoryHook(outlineContent),
    worldItems: normalizeWorldItems(outlineContent),
    volumes,
    selectedVolumeId: asText(outlineContent.selectedVolumeId) || volumes[0]?.id || 'vol-1',
    chapters,
    infoItems: normalizeInfoItems(outlineContent.infoItems, outlineContent),
    suggestions: normalizeSuggestions(outlineContent.suggestions),
  }
}

/**
 * 新条目的默认占位。
 *
 * 「新增了一行但没填」是很常见的中途状态，提交生文前要能识别出来并丢掉——
 * 空白角色进了提示词，模型会当成"存在但没写清楚的人物"去圆，反而拖累效果。
 * 判定与构造放在一起，改了字段不会漏掉另一边。
 */
export const SETTING_NEW_CHARACTER_NAME = '新角色'
export const SETTING_NEW_STORYLINE_TITLE = '新阶段'

export const createNewSettingCharacter = (): WorkflowSettingCharacter => ({
  id: `char-${Date.now()}`,
  name: SETTING_NEW_CHARACTER_NAME,
  aliases: [],
  gender: '其他',
  identity: '',
  background: '',
  keywords: '',
  motivation: '',
})

export const createNewSettingStoryline = (): WorkflowSettingStoryline => ({
  // 用时间戳而不是按长度取号：删掉中间一条后按长度会与现有条目撞 id，
  // 撞了之后定向调整就会改到别人头上。
  id: `line-${Date.now()}`,
  icon: 'fa-solid fa-circle-dot',
  title: SETTING_NEW_STORYLINE_TITLE,
  desc: '',
  keyEvent: '',
})

const isBlank = (value?: string) => !String(value ?? '').trim()

/**
 * 只丢「完全没动过」的条目：实质字段全空，且名称仍是默认占位或为空。
 * 用户手打过名字就保留——哪怕只填了名字，也不该替他删掉。
 */
const isUntouchedCharacter = (item: WorkflowSettingCharacter) =>
  !item.aliases?.length &&
  isBlank(item.identity) &&
  isBlank(item.background) &&
  isBlank(item.keywords) &&
  isBlank(item.motivation) &&
  (isBlank(item.name) || item.name.trim() === SETTING_NEW_CHARACTER_NAME)

const isUntouchedStoryline = (item: WorkflowSettingStoryline) =>
  isBlank(item.desc) &&
  isBlank(item.keyEvent) &&
  (isBlank(item.title) || item.title.trim() === SETTING_NEW_STORYLINE_TITLE)

/** 提交生文前清掉未填写的空行；没有可清的就原样返回，避免无谓的状态变更 */
export const dropUntouchedSettingEntries = (setting: WorkflowSettingResult) => {
  const characters = setting.characters.filter(item => !isUntouchedCharacter(item))
  const storylines = setting.storylines.filter(item => !isUntouchedStoryline(item))
  const removed =
    setting.characters.length - characters.length + (setting.storylines.length - storylines.length)
  return { setting: removed ? { ...setting, characters, storylines } : setting, removed }
}

export const normalizeSettingResult = (content?: JsonRecord | null): WorkflowSettingResult => {
  if (!content || !Object.keys(content).length) return createEmptySettingResult()
  const settingContent = normalizeSettingContent(content)
  return {
    worldCards: normalizeWorldCards(settingContent),
    core: normalizeCore(settingContent.core || settingContent.coreSetting, settingContent),
    characters: normalizeCharacters(settingContent.characters || settingContent.characterSetting),
    storylines: normalizeStorylines(settingContent.storylines || settingContent.storyline || settingContent.volumeBreakdown),
    assistActions: Array.isArray(settingContent.assistActions) && settingContent.assistActions.length
      ? settingContent.assistActions
      : clone(defaultAssistActions),
    records: Array.isArray(settingContent.records) ? settingContent.records : [],
  }
}

export const toWorkflowOutlinePayload = (draft: WorkflowDraft) => {
  const outline = draft.outlineResult
  const selectedTitle = getSelectedTitle(outline)
  return {
    title: selectedTitle,
    intro: outline.intro,
    titleOptions: clone(outline.titleOptions),
    selectedTitleId: outline.selectedTitleId,
    summary: outline.storyHook,
    storyHook: outline.storyHook,
    worldItems: clone(outline.worldItems),
    infoItems: clone(outline.infoItems),
    volumes: outline.volumes.map(volume => ({
      ...volume,
      chapters: outline.chapters
        .filter(chapter => chapter.volumeId === volume.id)
        .map(chapter => ({
          id: chapter.id,
          stageId: chapter.stageId,
          chapterNo: chapter.chapterNo,
          title: chapter.title,
          summary: chapter.summary,
          // 占位章标记必须随草稿往返保留，否则建书后分批章纲会跳过待生成章节。
          expanded: chapter.expanded === true,
        })),
    })),
  }
}

export const toWorkflowSettingPayload = (draft: WorkflowDraft) => {
  const setting = draft.settingResult
  return {
    title: getSelectedTitle(draft.outlineResult),
    category: draft.baseConfig.genre,
    audience: draft.baseConfig.audience,
    tags: clone(draft.baseConfig.tags),
    worldCards: clone(setting.worldCards),
    core: clone(setting.core),
    characters: setting.characters.map(item => ({
      ...item,
      role: item.badge || item.identity,
      tags: splitKeywords(item.keywords),
      goal: item.motivation,
    })),
    storylines: clone(setting.storylines),
    settings: setting.worldCards.map(card => ({
      name: card.title,
      detail: card.content || (card.tags || []).join('、') || (card.bullets || []).join('\n'),
    })),
  }
}

const findArtifactContent = (artifacts: WorkflowArtifact[] | undefined, artifactType: string) => (
  artifacts?.find(item => item.artifactType === artifactType)?.content || null
)

const normalizeOutlineContent = (content: JsonRecord) => {
  // 大纲生成可能包在 outline 字段内，展示层统一读取实际大纲内容。
  return isPlainObject(content.outline) ? content.outline : content
}

const normalizeSettingContent = (content: JsonRecord) => {
  // 设定生成可能包在 setting 字段内，展示层统一读取实际设定内容。
  return isPlainObject(content.setting) ? content.setting : content
}

const normalizeTitleOptions = (value: unknown, fallbackTitle?: unknown): WorkflowOutlineTitleOption[] => {
  const rows = Array.isArray(value) ? value : []
  const options = rows.map((item, index) => ({
    id: asText(item?.id) || `title-${index + 1}`,
    name: asText(item?.name),
  })).filter(item => item.name)
  const title = asText(fallbackTitle)
  return options.length ? options : [{ id: 'title-1', name: title || '未命名作品' }]
}

const normalizeVolumes = (value: unknown): WorkflowOutlineVolume[] => {
  const rows = Array.isArray(value) ? value : []
  const volumes = rows.map((item, index) => {
    const volumeNo = asText(item?.volume)
    const volumeId = asText(item?.id) || `vol-${index + 1}`
    const declaredCount = Math.max(1, Math.round(Number(item?.chapterCount || 1)))
    const rawMin = Math.round(Number(item?.chapterRange?.min || 0))
    const rawMax = Math.round(Number(item?.chapterRange?.max || 0))
    const rangeMin = rawMin > 0 ? rawMin : Math.max(1, Math.floor(declaredCount * 0.8))
    const rangeMax = rawMax > 0 ? rawMax : Math.max(rangeMin, Math.ceil(declaredCount * 1.2))
    const chapterRange = {
      min: Math.min(rangeMin, rangeMax),
      max: Math.max(rangeMin, rangeMax),
    }
    const chapterCount = Math.max(
      1,
      Math.round(Number(item?.chapterCount || (chapterRange.min + chapterRange.max) / 2)),
    )
    const summary = normalizeVolumeSummary(item)
    return {
      id: volumeId,
      title: asText(item?.title) || asText(item?.name) || (volumeNo ? `第${volumeNo}卷` : `第${index + 1}卷`),
      summary,
      chapterCount,
      chapterCountMode: 'dynamic' as const,
      chapterRange,
      stages: normalizeOutlineStages(item?.stages, volumeId, chapterCount, summary),
    }
  })
  return volumes.length ? volumes : [{
    id: 'vol-1',
    title: '第一卷',
    summary: '',
    chapterCount: 1,
    chapterCountMode: 'dynamic',
    chapterRange: { min: 1, max: 1 },
    stages: [],
  }]
}

const normalizeOutlineStages = (
  value: unknown,
  volumeId: string,
  _chapterCount: number,
  fallbackSummary: string,
): WorkflowOutlineStage[] => {
  const rows = Array.isArray(value) ? value : []
  const stages = rows.map((item, index) => {
    const startChapter = Math.round(Number(item?.startChapter || 0))
    const endChapter = Math.round(Number(item?.endChapter || 0))
    return {
      id: asText(item?.id) || `${volumeId}-stage-${index + 1}`,
      title: asText(item?.title || item?.name) || `阶段${index + 1}`,
      ...(startChapter > 0 ? { startChapter } : {}),
      ...(endChapter > 0 ? { endChapter } : {}),
      goal: asText(item?.goal || item?.summary),
      startState: asText(item?.startState),
      endState: asText(item?.endState || item?.payoff),
      mustHappen: asTextList(item?.mustHappen || item?.requiredEvents),
      forbidden: asTextList(item?.forbidden || item?.mustNotHappen),
      allowedNewElements: asTextList(item?.allowedNewElements),
    }
  })
  if (stages.length) return stages
  const goal = fallbackSummary || '完成本卷主线并进入下一阶段'
  return [{
    id: `${volumeId}-stage-1`,
    title: '全卷推进',
    goal,
    startState: '承接上一卷或全书开局状态',
    endState: goal,
    mustHappen: [goal],
    forbidden: [],
    allowedNewElements: ['仅限卷纲与既定设定能够推出的必要元素'],
  }]
}

const normalizeVolumeSummary = (volume: JsonRecord) => {
  const summary = asText(volume?.summary)
  if (summary) return summary
  // 模板大纲返回的是创作字段，这里合并成卷纲摘要。
  return [
    ['目标', volume?.mainGoal],
    ['敌人', volume?.stageEnemy],
    ['资源', volume?.upgradeResources],
    ['爽点', volume?.['爽点回收']],
    ['钩子', volume?.chapterHooks],
  ].map(([label, text]) => {
    const value = asText(text)
    return value ? `${label}：${value}` : ''
  }).filter(Boolean).join('；')
}

const normalizeChapterSummary = (chapter: JsonRecord) => (
  asText(chapter?.summary) || asText(chapter?.goal) || asText(chapter?.outline)
)

// 系统占位章识别：expanded 标记优先，标记丢失时按占位摘要模式自愈
//（新版中性文案前缀 / 旧版"本卷第 N 个推进点"模板），与服务端判定保持一致。
const PLACEHOLDER_SUMMARY_PREFIX = '本章为系统占位章纲'
const LEGACY_PLACEHOLDER_SUMMARY_RE = /^本卷第\s*\d+\s*个推进点[：:]/
const isPlaceholderChapter = (chapter: JsonRecord) => {
  if (chapter?.expanded === true) return true
  const summary = normalizeChapterSummary(chapter).trim()
  return summary.startsWith(PLACEHOLDER_SUMMARY_PREFIX) || LEGACY_PLACEHOLDER_SUMMARY_RE.test(summary)
}

const normalizeStoryHook = (content: JsonRecord) => {
  const storyHook = asText(content.storyHook) || asText(content.summary)
  if (storyHook) return storyHook
  const firstVolume = Array.isArray(content.volumes) ? content.volumes[0] : null
  return firstVolume ? normalizeVolumeSummary(firstVolume) : ''
}

const normalizeWorldItems = (content: JsonRecord) => {
  const worldItems = asTextArray(content.worldItems)
  if (worldItems.length) return worldItems
  const worldSetting = isPlainObject(content.worldSetting) ? content.worldSetting : null
  if (!worldSetting) return []
  return [
    worldSetting.background,
    worldSetting.coreRule,
    worldSetting.highConcept,
  ].map(item => asText(item)).filter(Boolean)
}

const normalizeChapters = (
  volumeValue: unknown,
  chapterValue: unknown,
  volumes: WorkflowOutlineVolume[]
): WorkflowOutlineChapter[] => {
  const fromVolumes = (Array.isArray(volumeValue) ? volumeValue : []).flatMap((volume, volumeIndex) => {
    const volumeId = volumes[volumeIndex]?.id || `vol-${volumeIndex + 1}`
    const volumeChapters: JsonRecord[] = Array.isArray(volume?.chapters) ? volume.chapters : []
    return volumeChapters.map((chapter, chapterIndex) => ({
      id: asText(chapter?.id) || `${volumeId}-ch-${chapterIndex + 1}`,
      volumeId,
      stageId: asText(chapter?.stageId) || undefined,
      chapterNo: Math.round(Number(chapter?.chapterNo || 0)) || undefined,
      title: asText(chapter?.title) || `第${chapterIndex + 1}章`,
      summary: normalizeChapterSummary(chapter),
      expanded: isPlaceholderChapter(chapter),
    }))
  })
  if (fromVolumes.length) return fromVolumes
  const fromVolumeHooks = (Array.isArray(volumeValue) ? volumeValue : []).map((volume, volumeIndex) => {
    const hook = asText(volume?.chapterHooks)
    if (!hook) return null
    const volumeId = volumes[volumeIndex]?.id || `vol-${volumeIndex + 1}`
    // 卷纲只有章尾钩子时，作为该卷章节预览展示，不额外虚构章节。
    return {
      id: `${volumeId}-hook`,
      volumeId,
      title: `章尾钩子：${hook}`,
      summary: hook,
    }
  }).filter(Boolean) as WorkflowOutlineChapter[]
  if (fromVolumeHooks.length) return fromVolumeHooks
  return (Array.isArray(chapterValue) ? chapterValue : []).map((chapter, index) => ({
    id: asText(chapter?.id) || `ch-${index + 1}`,
    volumeId: asText(chapter?.volumeId) || volumes[0]?.id || 'vol-1',
    stageId: asText(chapter?.stageId) || undefined,
    chapterNo: Math.round(Number(chapter?.chapterNo || 0)) || undefined,
    title: asText(chapter?.title) || `第${index + 1}章`,
    summary: normalizeChapterSummary(chapter),
    expanded: isPlaceholderChapter(chapter),
  }))
}

// 书名与简介各自有独立字段（titleOptions / intro），infoItems 只承载其余配置信息。
// 服务端仍会把书名和简介并入 infoItems（mergeOutlineInfoItems），这里统一剥掉，
// 避免同一份数据两处保存、靠中文 label 字符串互相同步。
const OUTLINE_TITLE_LABELS = ['书名', '作品名']
const OUTLINE_INTRO_LABELS = ['简介', '作品简介', '作品介绍']

const normalizeInfoItems = (
  value: unknown,
  content?: JsonRecord
): WorkflowOutlineInfoItem[] => {
  const rows = Array.isArray(value) ? value : []
  const items = rows
    .map(item => ({
      label: asText(item?.label),
      value: asText(item?.value),
    }))
    .filter(item => item.label)
    .filter(item => (
      !OUTLINE_TITLE_LABELS.includes(item.label) && !OUTLINE_INTRO_LABELS.includes(item.label)
    ))
  if (items.length) return items
  const wordCount = asText(content?.wordCount)
  return wordCount ? [{ label: '预计字数', value: wordCount }] : []
}

const normalizeOutlineIntro = (content: JsonRecord) => {
  const intro = asText(content?.intro)
  if (intro) return intro
  // 存量草稿只把简介存在 infoItems 里，回读时迁移到独立字段。
  const rows = Array.isArray(content?.infoItems) ? content.infoItems : []
  const matched = rows.find((item: JsonRecord) => OUTLINE_INTRO_LABELS.includes(asText(item?.label)))
  return asText(matched?.value)
}

const normalizeSuggestions = (value: unknown): WorkflowOutlineSuggestion[] => {
  const rows = Array.isArray(value) ? value : []
  const suggestions = rows.map(item => ({
    title: asText(item?.title),
    desc: asText(item?.desc),
    icon: asText(item?.icon) || 'fa-solid fa-wand-magic-sparkles',
  })).filter(item => item.title)
  return suggestions.length ? suggestions : clone(defaultOutlineSuggestions)
}

const normalizeAgentMap = (value: unknown, legacyAgentId?: string): WorkflowAgentMap => {
  const rawMap = isPlainObject(value) ? value : {}
  const agentMap = { ...rawMap }
  const ideaAgent = asText(legacyAgentId)
  if (ideaAgent && !asText(agentMap.workflow_idea)) agentMap.workflow_idea = ideaAgent
  return Object.entries(agentMap).reduce((record, [scene, agentCode]) => {
    if (systemManagedAgentScenes.has(scene)) return record
    const code = asText(agentCode)
    if (code) record[scene] = code
    return record
  }, {} as WorkflowAgentMap)
}

const normalizePlainObject = (value: unknown): JsonRecord => (
  isPlainObject(value) ? { ...value } : {}
)

const isPlainObject = (value: unknown): value is JsonRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const normalizeWorldCards = (content: unknown): WorkflowSettingCard[] => {
  const source = isPlainObject(content) ? content : {}
  const rows = Array.isArray(source.worldCards) ? source.worldCards : (Array.isArray(content) ? content : [])
  const cards = rows.map((item, index) => ({
    id: asText(item?.id) || `world-${index + 1}`,
    icon: asText(item?.icon) || 'fa-solid fa-earth-asia',
    title: asText(item?.title) || `世界设定${index + 1}`,
    content: asText(item?.content),
    tags: asTextArray(item?.tags),
    bullets: asTextArray(item?.bullets),
    size: item?.size,
  }))
  if (cards.length) return cards
  const worldSetting = normalizeWorldSetting(source)
  if (!worldSetting) return createEmptySettingResult().worldCards
  const rules = asTextList(worldSetting.rules)
  const locations = normalizeNamedTextList(worldSetting.keyLocations || worldSetting['关键地点'])
  const fallbackCards: Array<WorkflowSettingCard | null> = [
    {
      id: 'world-name',
      icon: 'fa-solid fa-earth-asia',
      title: '世界名称',
      content: asText(worldSetting.name || worldSetting.title),
      size: 'normal',
    },
    {
      id: 'world-overview',
      icon: 'fa-solid fa-layer-group',
      title: '世界概览',
      content: asText(worldSetting.description || worldSetting.background || worldSetting.overview),
      size: 'normal',
    },
    {
      id: 'world-rule',
      icon: 'fa-solid fa-yin-yang',
      title: '世界规则',
      bullets: rules,
      size: 'full',
    },
    locations.length
      ? {
          id: 'world-location',
          icon: 'fa-regular fa-map',
          title: '关键地点',
          bullets: locations,
          size: 'full',
        }
      : null,
  ]
  return fallbackCards.filter((item): item is WorkflowSettingCard => Boolean(item))
}

const normalizeCore = (core: JsonRecord | null | undefined, content?: JsonRecord): WorkflowSettingCore => {
  const worldSetting = normalizeWorldSetting(content || {})
  const characterSetting = normalizeCharacterSetting(content || {})
  const protagonist = characterSetting?.protagonist || {}
  const protagonistAbility = asText(protagonist.ability)
  const rules = asTextList(worldSetting?.rules)
  const locations = normalizeNamedTextList(worldSetting?.keyLocations || worldSetting?.['关键地点'])
  const dimensions = asTextArray(core?.ability?.dimensions)
  return {
    cultivation: {
      intro: asText(core?.cultivation?.intro),
      realms: Array.isArray(core?.cultivation?.realms) ? core.cultivation.realms : [],
      more: asText(core?.cultivation?.more),
    },
    ability: {
      intro: asText(core?.ability?.intro) || protagonistAbility,
      innate: core?.ability?.innate || {
        ...clone(defaultCore.ability.innate),
        title: '主角能力',
        desc: protagonistAbility,
      },
      acquired: core?.ability?.acquired || {
        ...clone(defaultCore.ability.acquired),
        title: '成长目标',
        desc: asText(protagonist.goal),
      },
      dimensions: dimensions.length ? dimensions : [protagonist.identity, protagonist.personality].map(item => asText(item)).filter(Boolean),
    },
    mechanics: {
      intro: asText(core?.mechanics?.intro) || asText(worldSetting?.description),
      items: Array.isArray(core?.mechanics?.items)
        ? core.mechanics.items
        : rules.map((rule, index) => ({
            icon: 'fa-solid fa-gears',
            title: `规则${index + 1}`,
            desc: rule,
          })),
    },
    resources: {
      intro: asText(core?.resources?.intro),
      items: Array.isArray(core?.resources?.items)
        ? core.resources.items
        : locations.map((location, index) => ({
            icon: 'fa-solid fa-location-dot',
            title: `地点${index + 1}`,
            desc: location,
          })),
    },
  }
}

const normalizeCharacters = (value: unknown): WorkflowSettingCharacter[] => {
  if (Array.isArray(value)) return normalizeCharacterRows(value)
  const characterSetting = isPlainObject(value) ? value : {}
  const rows = [
    characterSetting.protagonist ? { ...characterSetting.protagonist, badge: '主角', id: 'char-protagonist' } : null,
    ...(Array.isArray(characterSetting.teamMembers)
      ? characterSetting.teamMembers.map((item: JsonRecord, index: number) => ({ ...item, badge: '队友', id: `char-team-${index + 1}` }))
      : []),
    ...(Array.isArray(characterSetting.antagonists)
      ? characterSetting.antagonists.map((item: JsonRecord, index: number) => ({ ...item, badge: '反派', id: `char-antagonist-${index + 1}` }))
      : []),
  ].filter(Boolean)
  return normalizeCharacterRows(rows)
}

const normalizeCharacterRows = (rows: JsonRecord[]): WorkflowSettingCharacter[] => (
  rows.map((item, index) => ({
    id: asText(item?.id) || `char-${index + 1}`,
    name: asText(item?.name),
    aliases: normalizeCharacterAliases(asText(item?.name), item?.aliases),
    gender: normalizeCharacterGender(item?.gender),
    identity: asText(item?.identity) || asText(item?.title),
    background: asText(item?.background) || asText(item?.backstory) || asText(item?.description),
    keywords: asText(item?.keywords) || [item?.personality, item?.ability].map(text => asText(text)).filter(Boolean).join('；'),
    motivation: asText(item?.motivation) || asText(item?.goal) || asText(item?.growthArc),
    badge: asText(item?.badge),
  })).filter(item => item.name)
)

const normalizeCharacterGender = (value: unknown): WorkflowSettingCharacter['gender'] => {
  const text = asText(value).toLowerCase()
  if (value === 0 || text === '0' || text === '女' || text === 'female') return '女'
  if (value === 1 || text === '1' || text === '男' || text === 'male') return '男'
  return '其他'
}

const normalizeStorylines = (value: unknown): WorkflowSettingStoryline[] => {
  const rows = Array.isArray(value)
    ? value
    : (isPlainObject(value) && Array.isArray(value.nodes) ? value.nodes : [])
  return rows.map((item, index) => ({
    id: asText(item?.id) || asText(item?.volumeId) || `line-${index + 1}`,
    icon: asText(item?.icon) || 'fa-solid fa-circle-dot',
    title: asText(item?.title) || `阶段${index + 1}`,
    desc: asText(item?.desc) || asText(item?.summary),
    keyEvent: asText(item?.keyEvent) || asTextArray(item?.chapters).join('、'),
  }))
}

const normalizeWorldSetting = (content: JsonRecord) => {
  if (isPlainObject(content.worldSetting)) return content.worldSetting
  if (isPlainObject(content.world)) return content.world
  return null
}

const normalizeCharacterSetting = (content: JsonRecord) => (
  isPlainObject(content.characterSetting) ? content.characterSetting : {}
)

const normalizeNamedTextList = (value: unknown) => {
  if (!Array.isArray(value)) return asTextList(value)
  return value.map(item => {
    if (!isPlainObject(item)) return asText(item)
    const name = asText(item.name)
    const desc = asText(item.description || item.desc)
    return [name, desc].filter(Boolean).join('：')
  }).filter(Boolean)
}

const splitKeywords = (keywords: string) => (
  keywords.split(/[,\s，、]+/).map(item => item.trim()).filter(Boolean)
)

const formatUpdateTime = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const stepTitleMap: Record<WorkflowStepCode, string> = {
  MODE_SELECT: '灵感输入',
  BASE_CONFIG: '基础配置',
  MODEL_SELECT: '基础配置',
  AGENT_SELECT: '基础配置',
  OUTLINE_GENERATE: '生成大纲',
  SETTING_GENERATE: '生成设定',
}
