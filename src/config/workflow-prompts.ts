import type { LocalChatMessageInput } from '@/utils/local-ai-client'
import { promptText, renderPromptText } from '@/storage/local-prompts'

/**
 * 逐章自动生文的提示词库（工作流建书第五步起的所有 AI 调用）。
 *
 * 与 ai-prompts.ts 的分工：那边是写作台小件（润色/取名/灵感等），
 * 这边是工作流引擎专用（章纲规划、细纲、正文流式、重写、调整）。
 * 素材文本由引擎组装好传入，组装器只负责拼消息，保持纯函数可测。
 */

const materialBlock = (materials: Record<string, string>) =>
  Object.entries(materials)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `【${key}】\n${String(value).trim()}`)
    .join('\n\n')

const jsonSystem = (shape: string, extra = '') =>
  renderPromptText('workflow-writer', 'jsonSystem', { JSON形状: shape, 补充要求: extra })

/** 批量规划本卷接下来的章纲（标题 + 80-150 字章纲） */
export const buildChapterPlanMessages = (params: {
  materials: Record<string, string>
  count: number
  startChapterNo: number
  isFinalStretch: boolean
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(promptText('workflow-writer', 'planShape')),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】${renderPromptText('workflow-writer', 'planTask', { 起始章号: params.startChapterNo, 数量: params.count })}`,
        promptText('workflow-writer', 'planNote'),
        params.isFinalStretch ? promptText('workflow-writer', 'planFinal') : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]

/** 把一章章纲展开成细纲：拍数按本章目标字数定，每拍约 600 字 */
export const buildChapterBeatsMessages = (params: {
  materials: Record<string, string>
  beatCount: number
  wordsPerBeat: number
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(
      promptText('workflow-writer', 'beatsShape'),
      renderPromptText('workflow-writer', 'beatsNote', { 拍数: params.beatCount, 每拍字数: params.wordsPerBeat })
    ),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'beatsTask')}`,
    ].join('\n\n'),
  },
]

/** 正文生成（流式）：全新开写或断点续写共用 */
export const buildChapterContentMessages = (params: {
  materials: Record<string, string>
  targetWords: number
  /** 篇幅上限，默认目标的 1.2 倍 */
  maxWords?: number
  /** 断点续写时传已写部分，提示模型无缝接着写 */
  partialText?: string
  /** 重写模式的补充要求（为空表示常规生成） */
  rewriteInstruction?: string
}): LocalChatMessageInput[] => {
  const partial = String(params.partialText || '').trim()
  const instruction = String(params.rewriteInstruction || '').trim()
  return [
    {
      role: 'system',
      content: renderPromptText('workflow-writer', 'contentSystem', {
        目标字数: params.targetWords,
        上限字数: params.maxWords || Math.round(params.targetWords * 1.2)
      }),
    },
    {
      role: 'user',
      content: [
        materialBlock(params.materials),
        instruction ? renderPromptText('workflow-writer', 'rewriteNote', { 要求: instruction }) : '',
        partial
          ? [
              '【已写部分】',
              partial,
              `【任务】${promptText('workflow-writer', 'continueTask')}`,
            ].join('\n')
          : `【任务】${renderPromptText('workflow-writer', 'freshTask', { 目标字数: params.targetWords })}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ]
}

/** 剧情模式重写：先出新章纲候选（标题 + 章纲），确认后再生成正文 */
export const buildPlotOutlineMessages = (params: {
  materials: Record<string, string>
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(promptText('workflow-writer', 'plotShape')),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'plotRewriteTask')}`,
    ].join('\n\n'),
  },
]

/** 确认面板"AI 修改此段"：只改这一段，返回纯文本 */
export const buildParagraphPolishMessages = (params: {
  materials: Record<string, string>
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: promptText('workflow-writer', 'paragraphSystem'),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      `【任务】${promptText('workflow-writer', 'paragraphTask')}`,
    ].join('\n\n'),
  },
]

/** 大纲"按要求调整"：输出与当前大纲同构的完整 JSON */
export const buildOutlineAdjustMessages = (params: {
  materials: Record<string, string>
  scopeLabel: string
  instruction: string
  preserveLabels: string[]
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(
      promptText('workflow-wizard', 'outlineShape'),
      promptText('workflow-wizard', 'outlineAdjustNote')
    ),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】只调整：${params.scopeLabel}。`,
        `调整要求：${params.instruction || promptText('workflow-wizard', 'outlineAdjustFallback')}`,
        params.preserveLabels.length ? `必须保持不变：${params.preserveLabels.join('、')}。` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]

/** 设定"按要求调整"：输出与当前设定同构的完整 JSON */
export const buildSettingAdjustMessages = (params: {
  materials: Record<string, string>
  scopeLabel: string
  instruction: string
  preserveLabels: string[]
}): LocalChatMessageInput[] => [
  {
    role: 'system',
    content: jsonSystem(
      promptText('workflow-wizard', 'settingShape'),
      promptText('workflow-wizard', 'settingAdjustNote')
    ),
  },
  {
    role: 'user',
    content: [
      materialBlock(params.materials),
      [
        `【任务】只调整：${params.scopeLabel}。`,
        `调整要求：${params.instruction || promptText('workflow-wizard', 'settingAdjustFallback')}`,
        params.preserveLabels.length ? `必须保持不变：${params.preserveLabels.join('、')}。` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n'),
  },
]
