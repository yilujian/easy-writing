import type { LocalChatMessageInput } from '@/utils/local-ai-client'
import { promptTemperature, promptText, renderPromptText } from '@/storage/local-prompts'

/**
 * 写作台小件的提示词组装器（妙笔/续写/划词/参考面板/取名/灵感/榜单/封面）。
 *
 * 提示词文本本体全部在本地 md 提示词库（storage/local-prompts，
 * 默认值见 config/prompts/），这里只做消息拼装：把动态素材
 * （正文、选中文本、参数）代入用户可编辑的模板。
 */

/** 对话历史带入的最大条数（一问一答算两条），控制上下文规模 */
const CHAT_HISTORY_WINDOW = 20

// ---------------------------------------------------------------------------
// 通用：带上下文的自由指令生成（起章名/写细纲/提章纲这类"给素材出结果"场景）
// ---------------------------------------------------------------------------

export const buildFreeInstructionMessages = (params: {
  instruction: string
  selection?: string
  context?: string
}): LocalChatMessageInput[] => {
  const parts = [
    params.context ? `【背景】${params.context}` : '',
    params.selection ? `【素材】\n${params.selection}` : '',
    `【指令】${params.instruction}`,
  ].filter(Boolean)
  return [
    { role: 'system', content: promptText('free-instruction', 'system') },
    { role: 'user', content: parts.join('\n') },
  ]
}

// ---------------------------------------------------------------------------
// 取名器：七类命名（人名/地名/势力/功法/装备/妖兽/物品）
// ---------------------------------------------------------------------------

export const buildNamingMessages = (params: {
  categoryLabel: string
  fields: Record<string, string | number | undefined>
}): LocalChatMessageInput[] => {
  const lines = Object.entries(params.fields)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `${key}：${value}`)
  return [
    { role: 'system', content: promptText('naming', 'system') },
    { role: 'user', content: `生成【${params.categoryLabel}】名字。\n${lines.join('\n')}` },
  ]
}

// ---------------------------------------------------------------------------
// 建书弹窗：作品简介生成 / 润色
// ---------------------------------------------------------------------------

export const buildBookIntroMessages = (params: {
  mode: 'generate' | 'polish'
  info: Record<string, string>
  current?: string
}): LocalChatMessageInput[] => {
  const infoLines = Object.entries(params.info)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `${key}：${value}`)
  const task = promptText('book-intro', params.mode === 'generate' ? 'generateTask' : 'polishTask')
  return [
    { role: 'system', content: promptText('book-intro', 'system') },
    {
      role: 'user',
      content: [
        `【作品信息】\n${infoLines.join('\n')}`,
        params.current ? `【待润色简介】\n${params.current}` : '',
        `【任务】${task}`,
      ].filter(Boolean).join('\n'),
    },
  ]
}

// ---------------------------------------------------------------------------
// 结构化生成（时间线提取/补全/矛盾检测、故事线建议、建书向导）：要求输出 JSON
// ---------------------------------------------------------------------------

export const buildStructuredJsonMessages = (params: {
  task: string
  materials: Record<string, string>
  /** 期望的 JSON 形状说明，例如 {"events":[{"title","summary","timeLabel","lineType"}]} */
  shape: string
  limit?: number
}): LocalChatMessageInput[] => {
  const materialLines = Object.entries(params.materials)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `【${key}】\n${value}`)
  return [
    {
      role: 'system',
      content: renderPromptText('structured-analysis', 'system', { JSON形状: params.shape }),
    },
    {
      role: 'user',
      content: [
        materialLines.join('\n\n'),
        `【任务】${params.task}${params.limit ? `最多 ${params.limit} 条。` : ''}`,
      ].join('\n\n'),
    },
  ]
}

// ---------------------------------------------------------------------------
// 参考面板：大纲润色 / 设定优化（富文本 HTML）、角色字段润色（纯文本）
// ---------------------------------------------------------------------------

export const buildRichTextPolishMessages = (params: {
  kind: 'outline' | 'setting'
  name?: string
  typeLabel?: string
  selection: string
}): LocalChatMessageInput[] => {
  const task = params.kind === 'outline'
    ? promptText('reference-polish', 'outlineTask')
    : renderPromptText('reference-polish', 'settingTask', {
        名称说明: params.name ? `（「${params.name}」，类别：${params.typeLabel || '其他'}）` : '',
      })
  return [
    { role: 'system', content: promptText('reference-polish', 'richTextSystem') },
    { role: 'user', content: `【原文】\n${params.selection}\n【任务】${task}` },
  ]
}

const CHARACTER_FIELD_SLOTS: Record<'appearance' | 'personality' | 'background', string> = {
  appearance: 'appearanceTask',
  personality: 'personalityTask',
  background: 'backgroundTask',
}

export const buildCharacterFieldMessages = (params: {
  field: 'appearance' | 'personality' | 'background'
  selection: string
}): LocalChatMessageInput[] => [
  { role: 'system', content: promptText('reference-polish', 'characterSystem') },
  {
    role: 'user',
    content: `【原文】\n${params.selection}\n【任务】${promptText('reference-polish', CHARACTER_FIELD_SLOTS[params.field])}`,
  },
]

// ---------------------------------------------------------------------------
// 灵感：生成一条写作灵感（写作台灵感面板 / 灵感页每日推荐共用）
// ---------------------------------------------------------------------------

export const buildInspirationSparkMessages = (params: {
  recentTags?: string[]
  recentContents?: string[]
}): LocalChatMessageInput[] => {
  const parts = [
    params.recentTags?.length ? `【最近的灵感标签】${params.recentTags.join('、')}` : '',
    params.recentContents?.length ? `【最近记下的灵感】\n${params.recentContents.join('\n')}` : '',
    `【任务】${promptText('inspiration', 'task')}`,
  ].filter(Boolean)
  return [
    { role: 'system', content: promptText('inspiration', 'system') },
    { role: 'user', content: parts.join('\n') },
  ]
}

// ---------------------------------------------------------------------------
// 编辑器：打字自动补全（Copilot）
// ---------------------------------------------------------------------------

export const buildAutocompleteMessages = (params: {
  preText: string
  sceneAnchor?: string
  chapterTitle?: string
  chapterSummary?: string
  mode: 'inline' | 'next_beat'
  characterContext?: string
}): LocalChatMessageInput[] => {
  const modeLine = promptText('editor-autocomplete', params.mode === 'next_beat' ? 'nextBeat' : 'inline')
  const parts = [
    params.characterContext || '',
    params.chapterTitle ? `【本章】${params.chapterTitle}` : '',
    params.chapterSummary ? `【本章目标】${params.chapterSummary}` : '',
    params.sceneAnchor ? `【场景锚点】${params.sceneAnchor}` : '',
    `【前文】\n${params.preText}`,
    '从前文的断点处直接继续。',
  ].filter(Boolean)
  return [
    { role: 'system', content: `${promptText('editor-autocomplete', 'system')}\n${modeLine}` },
    { role: 'user', content: parts.join('\n') },
  ]
}

/** 补全/快捷续写的采样温度：inline 求稳、next_beat 求推进（迁自老服务端） */
export const autocompleteTemperature = (mode: 'inline' | 'next_beat'): number | undefined =>
  promptTemperature('editor-autocomplete', mode === 'next_beat' ? 'nextBeat' : 'inline')

// ---------------------------------------------------------------------------
// 编辑器：划词动作（润色/扩写/修错/自定义指令）
// ---------------------------------------------------------------------------

export type SelectionActionType = 'polish' | 'expand' | 'fix' | 'custom'

export const buildSelectionActionMessages = (params: {
  action: SelectionActionType
  selection: string
  context?: string
  instruction?: string
  chapterTitle?: string
  chapterSummary?: string
  sceneAnchor?: string
}): LocalChatMessageInput[] => {
  const actionLine = params.action === 'custom'
    ? renderPromptText('editor-selection', 'custom', { 指令: String(params.instruction || '').trim() })
    : promptText('editor-selection', params.action)
  const parts = [
    params.chapterTitle ? `【本章】${params.chapterTitle}` : '',
    params.chapterSummary ? `【本章目标】${params.chapterSummary}` : '',
    params.context ? `【上下文】\n${params.context}` : '',
    `【选中文本】\n${params.selection}`,
  ].filter(Boolean)
  // 动作槽是完整人设与要求（迁自服务端），通用强制要求殿后——与老服务端提示词结构一致
  return [
    { role: 'system', content: `${actionLine}\n\n${promptText('editor-selection', 'system')}` },
    { role: 'user', content: parts.join('\n') },
  ]
}

/** 划词各动作的采样温度（迁自老服务端逐场景调优） */
export const selectionActionTemperature = (action: SelectionActionType): number | undefined =>
  promptTemperature('editor-selection', action)

export const buildMiaobiMessages = (params: {
  query: string
  context?: string
  modeInstruction?: string
  history?: Array<{ role: 'user' | 'ai'; content: string }>
}): LocalChatMessageInput[] => {
  const messages: LocalChatMessageInput[] = []
  const system = [promptText('miaobi', 'system'), String(params.modeInstruction || '').trim()]
    .filter(Boolean)
    .join('\n\n')
  messages.push({ role: 'system', content: system })

  for (const item of (params.history || []).slice(-CHAT_HISTORY_WINDOW)) {
    const content = String(item.content || '').trim()
    if (!content) continue
    messages.push({ role: item.role === 'ai' ? 'assistant' : 'user', content })
  }

  const context = String(params.context || '').trim()
  const query = String(params.query || '').trim()
  messages.push({ role: 'user', content: context ? `${context}\n\n${query}` : query })
  return messages
}

// ---------------------------------------------------------------------------
// 榜单：趋势解读报告（数据分析面板，全部依据本机快照数据）
// ---------------------------------------------------------------------------

export const buildRankTrendReportMessages = (params: {
  /** 榜单上下文，如"番茄小说网 · 阅读榜 · 男频 · 都市高武 · 2026-08-29" */
  context: string
  /** 榜单条目行，如"3. 书名 / 作者 / 分类 / 在读 9.5万 / 名次↑1" */
  rankLines: string[]
  /** 名次变化行，如"书名 ↑5（第8→第3）" */
  changeLines?: string[]
  /** 分类占比行，如"都市高武 32%（16 本）" */
  categoryLines?: string[]
}): LocalChatMessageInput[] => [
  { role: 'system', content: promptText('rank-report', 'system') },
  {
    role: 'user',
    content: [
      `【榜单】${params.context}`,
      `【当前榜单】\n${params.rankLines.join('\n')}`,
      params.changeLines?.length ? `【名次变化】\n${params.changeLines.join('\n')}` : '',
      params.categoryLines?.length ? `【分类占比】\n${params.categoryLines.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  },
]

/** 封面工坊「AI 润色画面描述」：把口语描述润成可直接生图的画面提示词（纯文本） */
export const buildCoverPromptEnhanceMessages = (params: {
  prompt: string
  style: string
  tone: string
  bookInfo?: string
}): LocalChatMessageInput[] => [
  { role: 'system', content: promptText('cover-prompt', 'system') },
  {
    role: 'user',
    content: [
      params.bookInfo ? `【本书信息】\n${params.bookInfo}` : '',
      `【风格】${params.style || '自动匹配'}；【色调】${params.tone || '自动匹配'}`,
      `【作者的描述】\n${params.prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  },
]
