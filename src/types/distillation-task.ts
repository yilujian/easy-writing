/**
 * 蒸馏任务：读参考书的一段范围，程序编成一个"文风"技能（第三版，2026-10-26）。
 * ① 章级阅读：每章一张章卡（事件、章首承接、章尾钩子、爽点、伏笔、设定释放、人物功能）+ 按场景类型标出的连续原文候选
 * ② 书级归纳：看全部章卡，写卖点与人设、结构骨架
 * ③ 样本：程序从候选里挑 6 到 10 段连续原文，覆盖场景类型，不按相似度
 * ④ 讲法卡：模型读候选原文按分析目录写观察，每条带逐字原句证据，程序核对
 * ⑤ 禁忌卡：按禁忌对照表（数据表）在原文里数频率、取命中样例，模型只写情境
 * ⑥ 校准：范围末两章不进前面任何一步，只用来核对卡；改卡记录前后版本后冻结
 * 指纹由程序算，只进 evidence.json。场景类型、分析目录、钩子类型、爽点类型、禁忌对照表都是提示词库里可改的表。
 */
/** 第二版范例的功能类型；只给旧版 examples.json 的取范例逻辑用。 */
export const DEFAULT_EXAMPLE_KINDS = ['钩子', '反差反转', '立人设', '装弱爆发', '群像反应', '设定植入', '幽默', '情绪冲击', '战斗', '烟火气'] as const
/** 第三版样本的场景类型；以提示词库里的表为准，这里是默认值。 */
export const DEFAULT_SCENE_KINDS = ['开场', '对白交锋', '动作', '推理独白', '过渡', '章尾'] as const
/** 场景类型：以提示词库里的表为准，这里只是字符串。 */
export type SceneKind = string
export interface DistillationChapter {
  id: number
  title: string
  sortNo: number
  wordCount: number
  chars: number
  sourceHash?: string
  done: boolean
  /** 本章分成几段读、读完了几段；继续时从没读的那段接着。 */
  parts: number
  partsDone: number
}
export interface DistillationPlan {
  projectId: number
  title: string
  scope: string
  /** 参与蒸馏的章（不含校准集）。 */
  chapters: DistillationChapter[]
  /** 校准集：范围末两章，不进章卡、统计、归纳和样本；蒸完只用来核对卡。范围不到 10 章时为空。 */
  calibrationChapters?: DistillationChapter[]
  estimatedRequests?: number
  estimatedTokens: number
  estimatedMinutes: number[]
  skillName: string
}
/** 模型标出的一段连续原文候选：程序按段落区间取回原文，模型不抄原文。kind 是场景类型（旧任务记录里是功能类型）。 */
export interface DistillationPick {
  id: string
  kind: SceneKind
  why: string
  text: string
  chapterId: number
  chapterNo: number
  chapterTitle: string
  startPara: number
  endPara: number
}
/** 样本：从候选里挑出的连续原文段，写作时每章给模型一段。 */
export interface StyleSample {
  id: string
  scene: string
  chapterNo: number
  chapterTitle: string
  startPara: number
  endPara: number
  text: string
}
/** 原书证据：章号、段落号、逐字原句。程序核对过 quote 确实在该章原文里。 */
export interface StyleEvidence {
  chapterNo: number
  para: number
  quote: string
}
/** 讲法卡：一条可指认的写法观察。四段：观察 → 证据 → 新场景怎么用 → 适用边界。 */
export interface StyleCard {
  id: string
  dimension: string
  observation: string
  evidence: StyleEvidence[]
  use: string
  boundary: string
}
/** 禁忌卡的一条：按对照表在原书里数出来的频率与情境；写的是"这本书用不用、用多少"，不是禁令。 */
export interface TabooEntry {
  id: string
  name: string
  /** program：程序按检索形式数；read：模型在样本里看有没有 */
  method: 'program' | 'read'
  seen: boolean
  hits: number
  /** 命中分布在几章 */
  chapters: number
  per1k: number
  /** 模型写的一句情境；读类条目是模型的判断说明 */
  contexts: string
  examples: StyleEvidence[]
  note: string
}
/** 校准记录：校准集核对前后的卡、每条结论、禁忌卡在校准集上的差异；冻结时间。 */
export interface CalibrationRecord {
  chapterNos: number[]
  cardsBefore: StyleCard[]
  cardsAfter: StyleCard[]
  verdicts: Array<{ id: string; verdict: 'keep' | 'revise' | 'drop'; reason: string }>
  tabooDiff: Array<{ id: string; name: string; rangePer1k: number; calibrationPer1k: number; note: string }>
  frozenAt: number
}
/** 章卡：一章怎么写的骨架。段落号都是原文段落编号；ending.text 是程序取的章尾原文。 */
export interface DistillationChapterCard {
  chapterId: number
  chapterNo: number
  chapterTitle: string
  summary: string
  opening: string
  ending: { kind: string; para: number; text: string; note: string }
  beats: Array<{ kind: string; strength: number; from: number; to: number; note: string }>
  setups: Array<{ item: string; para: number; how: string }>
  payoffs: Array<{ item: string; para: number; how: string }>
  reveals: Array<{ item: string; carrier: string; para: number }>
  characters: Array<{ name: string; role: string; isNew: boolean }>
  stats: { chars: number; paragraphs: number; dialogueRatio: number; shortParagraphRatio: number }
}
/** 规律层：换一本同类书也能照做的做法，不写人名和具体事件；SKILL.md 正文用它。 */
export interface DistillationRules {
  appeal: string
  protagonist: string
  power: string
  humor: string
  opening: string[]
  unit: string
  foreshadow: string
  hooks: string
  pacing: string
  reveals: string
  voice: string[]
}
/** 书级归纳：分析层（这本书的卖点与人设、结构骨架，章号可以出现）+ 规律层。不写统计数字。 */
export interface DistillationBook {
  /** 正文里能确定的真实书名；确定不了为空，技能名用导入时的书名 */
  title: string
  /** 文风概括（4–10 字），技能名用它 */
  style: string
  pitch: string
  promise: string
  protagonist: string
  power: string
  cast: Array<{ role: string; name: string; note: string }>
  openingPlan: Array<{ chapter: number; job: string }>
  units: Array<{ chapters: string; event: string; note: string }>
  foreshadow: Array<{ item: string; plant: number; payoff: number; how: string }>
  hooks: string
  pacing: string
  reveals: string
  narrative: string[]
  rules: DistillationRules
}
/** 第二版写法卡（旧版 examples.json 里还有）：写作端取范例时兼容显示用。 */
export interface DistillationNote {
  kind: string
  when: string
  how: string[]
  avoid: string
  evidence: string[]
}
/** 程序算的 15 项语言指纹：量句子与段落的形状、标点与比喻密度。只进 evidence.json 给作者看，不进正文提示。 */
export type StyleFingerprint = Record<string, number>
/** 归纳阶段落盘的中间结果：book:* 是书级归纳，samples:root 是样本，cards:* 是讲法卡，taboos:root 是禁忌卡，calibration:root 是校准记录。 */
export type DistillationDigestValue =
  | DistillationBook
  | { samples: StyleSample[] }
  | { cards: StyleCard[] }
  | { taboos: TabooEntry[] }
  | CalibrationRecord
export interface DistillationTask extends DistillationPlan {
  id: string
  sessionId: string
  callId?: string
  anchor?: number
  modelCode: string
  createdAt: number
  updatedAt: number
  status: 'running' | 'pausing' | 'paused' | 'failed' | 'cancelled' | 'completed'
  phase: 'read' | 'digest' | 'verify' | 'compile'
  runToken: string | null
  picks: DistillationPick[]
  /** 章卡，按章节编号存；长章分几段读时存的是合并后的。 */
  cards?: Record<string, DistillationChapterCard>
  digests: Record<string, DistillationDigestValue>
  /** 第二版遗留字段，第三版不再写。 */
  review: unknown
  skillId: string | null
  /** 编档后的统计，任务卡和结果面板用。 */
  outcome: { chapterCards: number; samples: number; styleCards: number; taboos: number; calibrated: number; skillFile: string } | null
  error?: string
  autoContinue?: boolean
  continuedAt?: number | null
  continueSkipped?: string | null
}
