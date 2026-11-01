import type { LocalChatMessageInput } from '@/utils/local-ai-client'
import { promptText, renderPromptText } from '@/storage/local-prompts'
import {
  DEFAULT_SCENE_KINDS,
  type DistillationBook,
  type DistillationChapterCard,
  type DistillationNote,
  type DistillationPick,
  type StyleCard,
  type StyleSample
} from '@/types/distillation-task'

/**
 * 蒸馏的提示词（第三版）：章卡（card）、书级归纳（book）、讲法卡（styleCard）、禁忌情境（tabooContext）、禁忌读判（tabooRead）、校准（calibrate）。
 * 模型只给段落编号、判断和逐字原句；原文由程序按编号取回并核对，档案由程序编。
 * 场景类型、分析目录、钩子类型、爽点类型、禁忌对照表都是提示词库里的表，这里解析成列表给程序校验用。
 */
const block = (materials: Record<string, string>) =>
  Object.entries(materials)
    .filter(([, value]) => String(value ?? '').trim())
    .map(([key, value]) => `【${key}】\n${String(value).trim()}`)
    .join('\n\n')
const system = (shape: string, extra = '') => renderPromptText('distillation', 'system', { JSON形状: shape, 补充要求: extra })
/** 上一次输出被程序退回（如证据原句对不上原文）时，把问题附在任务后面让模型改。 */
const fix = (feedback?: string) => (feedback ? [`【上一次的问题】${feedback} 请改正后重新输出完整 JSON。`] : [])
/** 第二版写法卡给模型和作者看的一行；旧版技能的取范例还在用。 */
export const noteLine = (note: Pick<DistillationNote, 'kind' | 'when' | 'how' | 'avoid'>) =>
  `【${note.kind}】${note.when}：${note.how.join('；')}。${note.avoid ? `禁忌：${note.avoid}。` : ''}`

/** 分类表每行"名称：说明"；只有名称也行。 */
export function parseKindTable(text: string): Array<{ name: string; note: string }> {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const index = line.search(/[:：]/)
      return index > 0 ? { name: line.slice(0, index).trim(), note: line.slice(index + 1).trim() } : { name: line, note: '' }
    })
    .filter(item => item.name)
}
const kindNames = (slot: string, fallback: readonly string[]) => {
  const names = parseKindTable(promptText('distillation', slot)).map(k => k.name)
  return names.length ? names : [...fallback]
}
export const sceneKinds = () => kindNames('sceneKinds', DEFAULT_SCENE_KINDS)
export const dimensions = () =>
  kindNames('dimensions', ['叙述者姿态', '视角与心理贴近度', '句段呼吸', '对白体系', '情绪呈现', '描写密度与感官偏好', '词汇光谱与口头禅', '修辞习惯', '章首章尾', '标点排版'])
export const hookKinds = () => kindNames('hookKinds', ['悬念句', '反转句', '新人物登场', '危机落下', '视觉奇观', '笑点收束', '情绪余味', '信息揭露', '无钩子'])
export const beatKinds = () => kindNames('beatKinds', ['反杀', '打脸', '身份揭露', '被低估后证明', '获得升级', '金手指展示', '情感回报', '笑点'])
/** 禁忌对照表原文；解析在 style-taboos.ts。 */
export const tabooCatalogText = () => promptText('distillation', 'tabooCatalog')
const tables = () =>
  block({
    场景类型表: promptText('distillation', 'sceneKinds'),
    钩子类型表: promptText('distillation', 'hookKinds'),
    爽点类型表: promptText('distillation', 'beatKinds')
  })

/** 章卡：一章（或长章的一段）正文，段落已编号，填章卡并标出连续原文候选。 */
export const buildCardMessages = (params: {
  bookTitle: string
  chapterTitle: string
  chapterNo: number
  part: number
  parts: number
  paragraphs: string[]
  offset: number
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'cardShape'), promptText('distillation', 'cardNote')) },
  {
    role: 'user',
    content: [
      tables(),
      block({
        书名: params.bookTitle,
        章节: `第${params.chapterNo}章《${params.chapterTitle}》${params.parts > 1 ? `（第 ${params.part + 1}/${params.parts} 段，段落号接着前一段）` : ''}`,
        '正文（段落已编号）': params.paragraphs.map((text, index) => `[${params.offset + index + 1}] ${text}`).join('\n')
      }),
      `【任务】${promptText('distillation', 'cardTask')}`
    ].join('\n\n')
  }
]
/** 章卡给模型看的样子：去掉程序字段，段落号保留。 */
export const cardForModel = (card: DistillationChapterCard) => ({
  chapter: card.chapterNo,
  title: card.chapterTitle,
  summary: card.summary,
  opening: card.opening,
  ending: { kind: card.ending.kind, note: card.ending.note },
  beats: card.beats.map(b => ({ kind: b.kind, strength: b.strength, note: b.note })),
  setups: card.setups.map(s => ({ item: s.item, how: s.how })),
  payoffs: card.payoffs.map(p => ({ item: p.item, how: p.how })),
  reveals: card.reveals.map(r => ({ item: r.item, carrier: r.carrier })),
  characters: card.characters
})
/** 书级归纳：看一批章卡，写卖点与人设、结构骨架；多批时再合并。 */
export const buildBookMessages = (params: {
  bookTitle: string
  scope: string
  cards: DistillationChapterCard[]
  previous?: DistillationBook[]
  feedback?: string
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'bookShape'), promptText('distillation', 'bookNote')) },
  {
    role: 'user',
    content: [
      block({
        书名: params.bookTitle,
        范围: params.scope,
        章卡: params.cards.length ? JSON.stringify(params.cards.map(cardForModel), null, 0) : '',
        之前几批的归纳: params.previous?.length ? params.previous.map((item, index) => `第 ${index + 1} 批：${JSON.stringify(item)}`).join('\n') : ''
      }),
      `【任务】${params.previous?.length ? promptText('distillation', 'bookMergeTask') : promptText('distillation', 'bookTask')}`,
      ...fix(params.feedback)
    ].join('\n\n')
  }
]
/** 原文段给模型看的样子：章号加段落号，模型引证据时照着写。 */
export const passageText = (pick: Pick<DistillationPick, 'kind' | 'chapterNo' | 'startPara' | 'endPara' | 'text' | 'why'>) =>
  `【第${pick.chapterNo}章 第${pick.startPara}–${pick.endPara}段 · ${pick.kind}】${pick.why ? `（${pick.why}）` : ''}\n${pick.text}`
/** 讲法卡给模型和作者看的一行。 */
export const styleCardLine = (card: Pick<StyleCard, 'dimension' | 'observation' | 'evidence' | 'use' | 'boundary'>) =>
  `【${card.dimension}】${card.observation}。证据：${card.evidence.map(e => `第${e.chapterNo}章「${e.quote}」`).join('、')}。用法：${card.use}。${card.boundary ? `边界：${card.boundary}。` : ''}`
/** 讲法卡：读一批连续原文候选，按分析目录写观察；多批时带上之前的卡合并。 */
export const buildStyleCardMessages = (params: {
  bookTitle: string
  scope: string
  passages: Array<Pick<DistillationPick, 'kind' | 'chapterNo' | 'startPara' | 'endPara' | 'text' | 'why'>>
  previous?: StyleCard[]
  feedback?: string
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'styleCardShape'), promptText('distillation', 'styleCardNote')) },
  {
    role: 'user',
    content: [
      block({ 分析目录: promptText('distillation', 'dimensions') }),
      block({
        书名: params.bookTitle,
        范围: params.scope,
        原文段: params.passages.map(passageText).join('\n\n'),
        之前几批的卡: params.previous?.length ? params.previous.map(styleCardLine).join('\n') : ''
      }),
      `【任务】${params.previous?.length ? promptText('distillation', 'styleCardMergeTask') : promptText('distillation', 'styleCardTask')}`,
      ...fix(params.feedback)
    ].join('\n\n')
  }
]
/** 禁忌情境：程序数出的命中片段，模型各写一句情境。 */
export const buildTabooContextMessages = (params: {
  bookTitle: string
  items: Array<{ id: string; name: string; hits: number; examples: Array<{ chapterNo: number; quote: string }> }>
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'tabooContextShape')) },
  {
    role: 'user',
    content: [
      block({
        书名: params.bookTitle,
        命中片段: params.items
          .map(item => `[${item.id}] ${item.name}（共 ${item.hits} 处）\n${item.examples.map(e => `- 第${e.chapterNo}章：${e.quote}`).join('\n')}`)
          .join('\n\n')
      }),
      `【任务】${promptText('distillation', 'tabooContextTask')}`
    ].join('\n\n')
  }
]
/** 禁忌读判：程序数不出来的条目，模型在样本里看有没有。 */
export const buildTabooReadMessages = (params: {
  bookTitle: string
  items: Array<{ id: string; name: string; note: string }>
  samples: StyleSample[]
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'tabooReadShape')) },
  {
    role: 'user',
    content: [
      block({
        书名: params.bookTitle,
        要看的写法: params.items.map(item => `[${item.id}] ${item.name}${item.note ? `：${item.note}` : ''}`).join('\n'),
        原文段: params.samples.map(s => `【第${s.chapterNo}章 第${s.startPara}–${s.endPara}段 · ${s.scene}】\n${s.text}`).join('\n\n')
      }),
      `【任务】${promptText('distillation', 'tabooReadTask')}`
    ].join('\n\n')
  }
]
/** 校准：讲法卡逐条对校准集原文。 */
export const buildCalibrateMessages = (params: {
  bookTitle: string
  cards: StyleCard[]
  chapters: Array<{ chapterNo: number; chapterTitle: string; text: string }>
}): LocalChatMessageInput[] => [
  { role: 'system', content: system(promptText('distillation', 'calibrateShape')) },
  {
    role: 'user',
    content: [
      block({
        书名: params.bookTitle,
        讲法卡: params.cards.map(card => `[${card.id}] ${styleCardLine(card)}`).join('\n'),
        校准章节原文: params.chapters.map(c => `【第${c.chapterNo}章《${c.chapterTitle}》】\n${c.text}`).join('\n\n')
      }),
      `【任务】${promptText('distillation', 'calibrateTask')}`
    ].join('\n\n')
  }
]
