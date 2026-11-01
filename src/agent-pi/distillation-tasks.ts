import { computed, shallowRef } from 'vue'
import { piCommand } from './client'
import { hotState } from './hot-state'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import { streamLocalChatCompletion } from '@/utils/local-ai-client'
import { parseAiJson } from '@/utils/ai-json'
import { readLocalBreakdownContent } from '@/storage/local-breakdown'
import {
  beatKinds,
  buildBookMessages,
  buildCalibrateMessages,
  buildCardMessages,
  buildStyleCardMessages,
  buildTabooContextMessages,
  buildTabooReadMessages,
  dimensions as dimensionTable,
  hookKinds,
  sceneKinds,
  styleCardLine,
  tabooCatalogText
} from '@/config/distillation-prompts'
import { bumpSkillsRevision, compactSkillName, reloadSkills } from './skills'
import { announceTaskFinished, registerTaskProvider, taskClock, type PiTaskView } from './tasks'
import { formatDuration, platformEventMessage } from './conversation'
import { isDialogueParagraph, leakedNames, styleFingerprint } from './style-fingerprint'
import { applyCalibration, normalizeCalibration, normalizeStyleCards, pickSamples, type StyleCardCheck } from './style-cards'
import { applyTabooContexts, applyTabooDiff, countTaboos, diffTaboos, normalizeTabooRead, parseTabooCatalog, tabooLine, type TabooRule } from './style-taboos'
import type {
  CalibrationRecord,
  DistillationBook,
  DistillationChapter,
  DistillationChapterCard,
  DistillationPick,
  DistillationPlan,
  DistillationTask,
  StyleCard,
  StyleFingerprint,
  StyleSample,
  TabooEntry
} from '@/types/distillation-task'

/**
 * 蒸馏文风（第三版）：读参考书的一段范围 →
 * ① 每章一张章卡（事件、章首承接、章尾钩子、爽点、伏笔、设定释放、人物功能）+ 按场景类型标出的连续原文候选（程序取原文）
 * ② 看全部章卡归纳卖点与人设、结构骨架（排法层）
 * ③ 从不同场景挑选 3 到 5 段连续原文；材料不足时保留实际数量
 * ④ 模型读候选原文写讲法卡，程序逐字核对证据原句
 * ⑤ 程序按禁忌对照表数频率，模型只写情境、看读类条目
 * ⑥ 校准集（范围末两章）核对两类卡，记录前后版本后冻结
 * ⑦ 编成一个技能（SKILL.md + references/samples.md + examples.json + evidence.json + structure.json + book-analysis.md）落到作者技能目录。
 * 进度、暂停继续、关闭恢复和拆书同一套：每一步结果都落盘，继续时不重做。
 */
export const distillationTasks = hotState('distillation:tasks', () => shallowRef<DistillationTask[]>([]))
export type DistillationPhase = 'read' | 'book' | 'samples' | 'cards' | 'taboos' | 'calibrate' | 'compile'
export interface DistillationLive {
  phase: DistillationPhase
  chapterId?: number
  part?: number
  parts?: number
  step?: number
  steps?: number
  receivedChars: number
  startedAt: number
  taskStartedAt: number
  measuredChars: number
  measuredMs: number
}
export const distillationLive = hotState('distillation:live', () => shallowRef<Record<string, DistillationLive>>({}))
/** 一章一次读完；超过这个字数的长章才分段，章卡由程序合并。 */
const WINDOW_CHARS = 12000
/** 连续原文候选的字数区间：按段落截到上限，低于下限的丢掉。 */
const PICK_MAX_CHARS = 1200
const PICK_MIN_CHARS = 500
const ENDING_CHARS = 240
const BOOK_BATCH = 40
/** 讲法卡一批读多少字的原文候选 */
const CARD_BATCH_CHARS = 15000
/** 校准集每章给模型多少字 */
const CALIBRATION_CHAPTER_CHARS = 8000
class InvalidDistillationOutput extends Error {}
const ATTEMPTS = 2
/** 导入正文里夹在章尾的作者留言：出现在章节后四成位置、以这些词开头的段落起全部去掉，不算正文。 */
export const TRAILER_MARKERS = ['作者有话说', '作者的话', '作者有话要说', '作家的话', 'PS：', 'ps：']
function setLive(id: string, patch: Partial<DistillationLive>) {
  const previous = distillationLive.value[id]
  const base: DistillationLive = previous || {
    phase: 'read',
    receivedChars: 0,
    startedAt: Date.now(),
    taskStartedAt: Date.now(),
    measuredChars: 0,
    measuredMs: 0
  }
  distillationLive.value = { ...distillationLive.value, [id]: { ...base, ...patch } }
}
function clearLive(id: string) {
  if (!distillationLive.value[id]) return
  const next = { ...distillationLive.value }
  delete next[id]
  distillationLive.value = next
}
const running = new Map<string, { controller: AbortController; promise: Promise<void>; pause: boolean }>()
const starting = new Set<Promise<unknown>>()
let closing = false
const command = <T>(op: string, args: Record<string, unknown> = {}) =>
  trackStorageWrite(() => piCommand<T>('distillation_task', { op, ...args }))
function update(task: DistillationTask) {
  distillationTasks.value = [task, ...distillationTasks.value.filter(t => t.id !== task.id)].sort(
    (a, b) => b.createdAt - a.createdAt
  )
  return task
}
const asList = (value: unknown) => (Array.isArray(value) ? (value as DistillationTask[]) : [])
export async function loadDistillationTasks() {
  distillationTasks.value = asList(await command<DistillationTask[]>('list'))
  return distillationTasks.value
}
export async function initializeDistillationTasks() {
  distillationTasks.value = asList(await command<DistillationTask[]>('recover'))
}
export const hasRunningDistillations = () => running.size > 0 || starting.size > 0
/** 范围方案：calibration 是留几章作校准集（默认 2；0 不留；范围不到 10 章宿主也不留）。 */
export const prepareDistillation = (projectId: number, chapterIds: number[], calibration?: number) =>
  command<DistillationPlan>('prepare', { projectId, chapterIds, ...(calibration != null ? { calibration } : {}) })
export async function startDistillation(
  plan: DistillationPlan,
  modelCode: string,
  owner: { sessionId: string; callId?: string; anchor?: number; autoContinue?: boolean },
  id: string = crypto.randomUUID()
) {
  if (closing) throw new Error('应用正在关闭，未启动蒸馏')
  const pending = command<DistillationTask>('create', {
    id,
    plan,
    modelCode,
    autoContinue: owner.autoContinue !== false,
    ...owner
  }).then(async value => {
    let task = update(value)
    if (closing && task.status === 'running')
      task = update(await command<DistillationTask>('paused', { id: task.id, runToken: task.runToken }))
    else if (task.status === 'running') launch(task)
    return task
  })
  starting.add(pending)
  try {
    return await pending
  } finally {
    starting.delete(pending)
  }
}
export async function controlDistillation(id: string, action: 'pause' | 'resume' | 'cancel') {
  if (closing && action === 'resume') throw new Error('正在关闭，请稍后继续')
  const live = running.get(id)
  if (action === 'resume') {
    if (live) throw new Error('任务正在运行')
    const task = update(await command<DistillationTask>('resume', { id }))
    if (closing) return update(await command<DistillationTask>('paused', { id, runToken: task.runToken }))
    launch(task)
    return task
  }
  if (action === 'pause') {
    const task = update(await command<DistillationTask>('pause', { id }))
    if (live) live.pause = true
    else if (task.status === 'pausing') return update(await command<DistillationTask>('paused', { id, runToken: task.runToken }))
    return task
  }
  const task = update(await command<DistillationTask>('cancel', { id }))
  live?.controller.abort()
  if (live) await live.promise.catch(() => {})
  return task
}
export async function setDistillationAutoContinue(id: string, autoContinue: boolean) {
  return update(await command<DistillationTask>('continue_state', { id, autoContinue }))
}
export async function markDistillationContinued(id: string) {
  return update(await command<DistillationTask>('continue_state', { id, continuedAt: Date.now(), continueSkipped: null }))
}
export async function markDistillationContinueSkipped(id: string, reason: string) {
  return update(await command<DistillationTask>('continue_state', { id, continueSkipped: reason }))
}
export async function stopDistillationTasks() {
  closing = true
  await Promise.allSettled([...starting])
  for (const live of running.values()) live.pause = true
  await Promise.allSettled([...running.values()].map(live => live.promise))
}
export function allowDistillationTasks() {
  closing = false
}
function launch(initial: DistillationTask) {
  if (running.has(initial.id)) return
  const live = { controller: new AbortController(), promise: Promise.resolve(), pause: false }
  running.set(initial.id, live)
  live.promise = run(initial, live).finally(() => {
    running.delete(initial.id)
    clearLive(initial.id)
  })
  void live.promise.catch(() => {})
}
async function complete(
  id: string,
  options: { modelCode: string; scene: string; sceneLabel: string; messages: ReturnType<typeof buildCardMessages>; signal: AbortSignal }
) {
  let text = '',
    failure = ''
  const result = await streamLocalChatCompletion(
    { ...options, temperature: 0.3 },
    {
      onDelta: delta => {
        text += delta
        setLive(id, { receivedChars: text.length })
      },
      onDone: () => {},
      onError: message => {
        failure = message
      }
    }
  )
  options.signal.throwIfAborted()
  if (failure) throw new Error(failure)
  return result.content || text
}
// ---- 纯函数：切段、洗尾、取原文、规范化模型结果、编档
/** 章尾的作者留言不算正文：从后四成里第一个以留言词开头的段落起去掉，连带它前面的分隔线。只去尾，不改段落编号。 */
export function stripTrailer(paragraphs: string[], markers = TRAILER_MARKERS) {
  const normalize = (p: string) => p.replace(/^[\s\-—=*~_【[（(「]+/, '')
  const separator = (p: string) => /^[\s\-—=*~_·.。]+$/.test(p)
  const start = Math.floor(paragraphs.length * 0.6)
  for (let i = start; i < paragraphs.length; i++) {
    const head = normalize(paragraphs[i])
    if (!markers.some(m => head.startsWith(m))) continue
    let cut = i
    while (cut > 0 && separator(paragraphs[cut - 1])) cut--
    return paragraphs.slice(0, cut)
  }
  return paragraphs
}
/** 正文按段落切成不超过 WINDOW_CHARS 的几段；一般一章一段。 */
export function splitWindows(paragraphs: string[], limit = WINDOW_CHARS) {
  const windows: Array<{ start: number; end: number }> = []
  let start = 0,
    chars = 0
  for (let i = 0; i < paragraphs.length; i++) {
    const length = paragraphs[i].length
    if (chars + length > limit && i > start) {
      windows.push({ start, end: i })
      start = i
      chars = 0
    }
    chars += length
  }
  windows.push({ start, end: paragraphs.length })
  return windows.filter(w => w.end > w.start)
}
/** Prefer scenes identified in the text. When those leave gaps, take disjoint consecutive
 * paragraphs from the selected chapters and keep their actual locations. No model call. */
export function sourceSamples(picks: DistillationPick[], scenes: string[], chapters: DistillationChapter[], texts: Map<number, string[]>): StyleSample[] {
  const samples: StyleSample[] = []
  const overlaps = (chapterNo: number, from: number, to: number) =>
    samples.some(s => s.chapterNo === chapterNo && s.startPara <= to && from <= s.endPara)
  for (const sample of pickSamples(picks, scenes, 3, 5)) {
    if (!overlaps(sample.chapterNo, sample.startPara, sample.endPara) && !samples.some(s => s.text === sample.text)) samples.push(sample)
  }
  for (const chapter of chapters) {
    if (samples.length >= 3) break
    const paragraphs = texts.get(chapter.sortNo) || []
    for (let start = 0; samples.length < 3 && start < paragraphs.length;) {
      if (overlaps(chapter.sortNo, start + 1, start + 1)) { start++; continue }
      let end = start, chars = 0
      while (end < paragraphs.length && !overlaps(chapter.sortNo, end + 1, end + 1) && chars < PICK_MIN_CHARS) {
        chars += paragraphs[end++].length
      }
      const text = clampExample(paragraphs.slice(start, end))
      if (text.trim() && (chars >= PICK_MIN_CHARS || (!samples.length && start === 0 && end === paragraphs.length))
          && !samples.some(s => s.text === text)) {
        samples.push({id:'',scene:'原文',chapterNo:chapter.sortNo,chapterTitle:chapter.title,startPara:start+1,endPara:start+text.split('\n').length,text})
      }
      start = end
    }
  }
  return samples.sort((a,b)=>a.chapterNo-b.chapterNo || a.startPara-b.startPara).map((s,i)=>({...s,id:'s'+(i+1)}))
}
/** 原文段按段落截到上限，不在句中切断。 */
export function clampExample(paragraphs: string[], max = PICK_MAX_CHARS) {
  const kept: string[] = []
  let count = 0
  for (const paragraph of paragraphs) {
    if (count + paragraph.length > max && kept.length) break
    if (count + paragraph.length > max) {
      kept.push(paragraph.slice(0, max))
      break
    }
    kept.push(paragraph)
    count += paragraph.length
  }
  return kept.join('\n')
}
/** 章尾原文：从后往前取到字数上限，给章卡当证据。 */
export function tailText(paragraphs: string[], max = ENDING_CHARS) {
  const kept: string[] = []
  let count = 0
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (count + paragraphs[i].length > max && kept.length) break
    kept.unshift(paragraphs[i])
    count += paragraphs[i].length
  }
  return kept.join('\n')
}
/** 一章的体量：字数、段数、对白段占比、短段占比。给规划当参数，不进正文提示。 */
export function chapterStats(paragraphs: string[]): DistillationChapterCard['stats'] {
  const kept = paragraphs.map(p => p.trim()).filter(Boolean)
  const chars = kept.reduce((sum, p) => sum + p.length, 0)
  const dialogue = kept.filter(isDialogueParagraph).reduce((sum, p) => sum + p.length, 0)
  return {
    chars,
    paragraphs: kept.length,
    dialogueRatio: chars ? Math.round((dialogue / chars) * 100) : 0,
    shortParagraphRatio: kept.length ? Math.round((kept.filter(p => p.length <= 15).length / kept.length) * 100) : 0
  }
}
const str = (value: unknown, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const int = (value: unknown) => (Number.isInteger(Number(value)) ? Number(value) : NaN)
const list = (value: unknown) => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [])
export interface CardKinds {
  scenes: string[]
  hooks: string[]
  beats: string[]
}
/**
 * 模型给的章卡换成程序认的：段落号必须落在这一段里（编号是全章绝对编号），类型必须在分类表里；
 * 连续原文候选按编号取原文，按段落截到上限、太短的丢掉；章尾原文由程序取。
 */
export function normalizeCard(
  parsed: unknown,
  chapter: { id: number; sortNo: number; title: string },
  part: number,
  slice: string[],
  offset: number,
  kinds: CardKinds
): { card: Omit<DistillationChapterCard, 'stats'>; picks: DistillationPick[] } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const first = offset + 1,
    last = offset + slice.length
  const para = (value: unknown) => {
    const n = int(value)
    return n >= first && n <= last ? n : 0
  }
  const range = (from: unknown, to: unknown) => {
    const a = int(from),
      b = int(to)
    return a >= first && b <= last && a <= b ? { from: a, to: b } : null
  }
  const picks: DistillationPick[] = []
  const perKind = new Map<string, number>()
  list(raw.samples).forEach((item, index) => {
    const kind = str(item.scene, 40)
    const span = range(item.from, item.to)
    if (!kinds.scenes.includes(kind) || !span) return
    if ((perKind.get(kind) || 0) >= 2) return
    const text = clampExample(slice.slice(span.from - first, span.to - first + 1))
    if (text.replace(/\s/g, '').length < PICK_MIN_CHARS) return
    const kept = text.split('\n').length
    perKind.set(kind, (perKind.get(kind) || 0) + 1)
    picks.push({
      id: `c${chapter.id}-p${part}-${index + 1}`,
      kind,
      why: str(item.why, 120),
      text,
      chapterId: chapter.id,
      chapterNo: chapter.sortNo,
      chapterTitle: chapter.title,
      startPara: span.from,
      endPara: span.from + kept - 1
    })
  })
  const ending = raw.ending && typeof raw.ending === 'object' ? (raw.ending as Record<string, unknown>) : {}
  const endingKind = str(ending.kind, 40)
  const noHook = kinds.hooks[kinds.hooks.length - 1]
  const card: Omit<DistillationChapterCard, 'stats'> = {
    chapterId: chapter.id,
    chapterNo: chapter.sortNo,
    chapterTitle: chapter.title,
    summary: str(raw.summary, 300),
    opening: str(raw.opening, 160),
    ending: {
      kind: kinds.hooks.includes(endingKind) ? endingKind : noHook,
      para: para(ending.para) || last,
      text: tailText(slice),
      note: str(ending.note, 160)
    },
    beats: list(raw.beats)
      .map(item => {
        const span = range(item.from, item.to) || (para(item.from) ? { from: para(item.from), to: para(item.from) } : null)
        const kind = str(item.kind, 40)
        const strength = Math.min(5, Math.max(1, int(item.strength) || 3))
        return kinds.beats.includes(kind) && span ? { kind, strength, from: span.from, to: span.to, note: str(item.note, 160) } : null
      })
      .filter((b): b is NonNullable<typeof b> => !!b),
    setups: list(raw.setups)
      .map(item => ({ item: str(item.item, 120), para: para(item.para), how: str(item.how, 120) }))
      .filter(s => s.item),
    payoffs: list(raw.payoffs)
      .map(item => ({ item: str(item.item, 120), para: para(item.para), how: str(item.how, 120) }))
      .filter(p => p.item),
    reveals: list(raw.reveals)
      .map(item => ({ item: str(item.item, 120), carrier: str(item.carrier, 40), para: para(item.para) }))
      .filter(r => r.item),
    characters: list(raw.characters)
      .map(item => ({ name: str(item.name, 40), role: str(item.role, 40), isNew: item.isNew === true }))
      .filter(c => c.name)
  }
  if (!card.summary && !picks.length && !card.beats.length) return null
  return { card, picks }
}
/** 长章分几段读：事件接起来，章首取第一段的，章尾取最后一段的。 */
export function mergeCards(
  previous: Omit<DistillationChapterCard, 'stats'> | undefined,
  next: Omit<DistillationChapterCard, 'stats'>
): Omit<DistillationChapterCard, 'stats'> {
  if (!previous) return next
  return {
    ...next,
    summary: [previous.summary, next.summary].filter(Boolean).join('；').slice(0, 400),
    opening: previous.opening || next.opening,
    beats: [...previous.beats, ...next.beats],
    setups: [...previous.setups, ...next.setups],
    payoffs: [...previous.payoffs, ...next.payoffs],
    reveals: [...previous.reveals, ...next.reveals],
    characters: [...previous.characters, ...next.characters.filter(c => !previous.characters.some(p => p.name === c.name))]
  }
}
/** 书级归纳：文字截长，列表只认有内容的项；连核心梗都没有就算失败重试。 */
const strs = (value: unknown, max: number, count: number) => (Array.isArray(value) ? value : []).map(v => str(v, max)).filter(Boolean).slice(0, count)
/** 规律层的句子由模板补标点，模型给的句尾标点去掉，免得出现"。；""。。"。 */
const untail = (value: string) => value.replace(/[。；;！!，,、\s]+$/u, '')
const untailAll = (values: string[]) => values.map(untail).filter(Boolean)
const EMPTY_RULES: DistillationBook['rules'] = { appeal: '', protagonist: '', power: '', humor: '', opening: [], unit: '', foreshadow: '', hooks: '', pacing: '', reveals: '', voice: [] }
/** 章卡里记的人物哪些算专名：有名字、不是把身份当名字（教官、校长、系统）、不是几个人合写（校长与教官）。 */
export const isProperName = (ch: { name: string; role: string }) => {
  const name = ch.name.trim()
  const role = ch.role.trim()
  return name.length >= 2 && !/[与和及、，,/／]/.test(name) && !(role && (role.includes(name) || name.includes(role)))
}
/** 规律层全部文字拼在一起，给人名核对用。 */
export const rulesText = (book: Pick<DistillationBook, 'rules'>) => Object.values(book.rules || EMPTY_RULES).flat().join('\n')
/** 书级归纳：第三版不再要模型写语言规则（voice），给了也不收。 */
export function normalizeBook(parsed: unknown): DistillationBook | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const rules = (raw.rules && typeof raw.rules === 'object' ? raw.rules : {}) as Record<string, unknown>
  const book: DistillationBook = {
    title: str(raw.title, 40),
    style: str(raw.style, 24).replace(/写法$/, ''),
    pitch: str(raw.pitch, 200),
    promise: str(raw.promise, 300),
    protagonist: str(raw.protagonist, 400),
    power: str(raw.power, 400),
    cast: list(raw.cast)
      .map(item => ({ role: str(item.role, 40), name: str(item.name, 40), note: str(item.note, 120) }))
      .filter(c => c.name || c.role)
      .slice(0, 16),
    openingPlan: list(raw.openingPlan)
      .map(item => ({ chapter: int(item.chapter) || 0, job: str(item.job, 120) }))
      .filter(o => o.chapter > 0 && o.job)
      .slice(0, 5),
    units: list(raw.units)
      .map(item => ({ chapters: str(item.chapters, 40), event: str(item.event, 120), note: str(item.note, 160) }))
      .filter(u => u.event)
      .slice(0, 30),
    foreshadow: list(raw.foreshadow)
      .map(item => ({ item: str(item.item, 120), plant: int(item.plant) || 0, payoff: int(item.payoff) || 0, how: str(item.how, 160) }))
      .filter(f => f.item)
      .slice(0, 40),
    hooks: str(raw.hooks, 300),
    pacing: str(raw.pacing, 300),
    reveals: str(raw.reveals, 300),
    narrative: strs(raw.narrative, 160, 10),
    rules: {
      appeal: untail(str(rules.appeal, 200)),
      protagonist: untail(str(rules.protagonist, 160)),
      power: untail(str(rules.power, 200)),
      humor: untail(str(rules.humor, 120)),
      opening: untailAll(strs(rules.opening, 80, 3)),
      unit: untail(str(rules.unit, 200)),
      foreshadow: untail(str(rules.foreshadow, 160)),
      hooks: untail(str(rules.hooks, 200)),
      pacing: untail(str(rules.pacing, 200)),
      reveals: untail(str(rules.reveals, 160)),
      voice: []
    }
  }
  return book.pitch || book.protagonist ? book : null
}
/** 技能名：作者没自己起名（还是宿主给的默认名）时，按归纳出的书名和文风定；范围不是全书就带上范围。名字里不留空白（Pi 的 /skill: 命令按空格切名字）。 */
export function skillNameFor(
  task: Pick<DistillationTask, 'title' | 'scope' | 'skillName'>,
  book: Pick<DistillationBook, 'title' | 'style'>
) {
  const suffix = task.scope === '全书' ? '' : `（${task.scope}）`
  const style = book.style.trim().replace(/写法$/, '')
  if (!style || task.skillName !== compactSkillName(`《${task.title}》写作方法${suffix}`)) return task.skillName
  return compactSkillName(`《${book.title.trim() || task.title}》${style}写法${suffix}`)
}
const chunk = <T>(items: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
/** 按字数分批：一批不超过 limit 字，至少一项。 */
export function chunkByChars<T extends { text: string }>(items: T[], limit: number) {
  const out: T[][] = []
  let batch: T[] = []
  let chars = 0
  for (const item of items) {
    if (batch.length && chars + item.text.length > limit) {
      out.push(batch)
      batch = []
      chars = 0
    }
    batch.push(item)
    chars += item.text.length
  }
  if (batch.length) out.push(batch)
  return out
}
const countBy = <T>(items: T[], key: (item: T) => string) => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) || 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])
}
const chapterLabel = (no: number) => `第${no}章`
const rangeLabel = (chapters: Array<{ sortNo: number }>) => {
  const nos = chapters.map(c => c.sortNo).sort((a, b) => a - b)
  if (!nos.length) return ''
  return nos.length === 1 ? `第 ${nos[0]} 章` : `第 ${nos[0]}—${nos[nos.length - 1]} 章`
}
/**
 * 程序编档。SKILL.md 正文：怎么用、讲法卡、禁忌卡（按原书频率）、排法（同题材时参考）、诚实边界、一段内嵌样本。
 * 全文不出现参考书人名（证据引文除外）。数字只在排法节里（字数区间、钩子分布，由章卡算）；指纹和计数落 evidence.json。
 */
export function compileProfile(
  task: DistillationTask,
  input: {
    book: DistillationBook
    cards: DistillationChapterCard[]
    samples: StyleSample[]
    styleCards: StyleCard[]
    taboos: TabooEntry[]
    calibration: CalibrationRecord | null
    fingerprint: StyleFingerprint
    scenes: string[]
  }
) {
  const { book, calibration, fingerprint } = input
  const samples = input.samples.slice(0, 5)
  const styleCards = input.styleCards.slice(0, 10)
  const taboos = input.taboos.slice(0, 10)
  const cards = [...input.cards].sort((a, b) => a.chapterNo - b.chapterNo)
  const scopeLabel = `${task.scope}（${cards.length} 章）`
  const bookName = book.title || task.title
  const styleName = book.style || '同类网文'
  const sourceNames = [...new Set(cards.flatMap(c => c.characters.filter(isProperName).map(ch => ch.name.trim())))]
  const hookCounts = countBy(cards, c => c.ending.kind)
  const avgChars = cards.length ? Math.round(cards.reduce((sum, c) => sum + c.stats.chars, 0) / cards.length) : 0
  const dialogue = cards.length ? Math.round(cards.reduce((sum, c) => sum + c.stats.dialogueRatio, 0) / cards.length) : 0
  const calibrationNos = (task.calibrationChapters || []).map(c => c.sortNo).sort((a, b) => a - b)
  const changed = calibration ? calibration.verdicts.filter(v => v.verdict === 'revise').length : 0
  const dropped = calibration ? calibration.verdicts.filter(v => v.verdict === 'drop').length : 0
  // 有卡却一条结论都没有，说明校准那一步模型没给出合格结果
  const judged = !!calibration && (calibration.cardsBefore.length === 0 || calibration.verdicts.length > 0)
  const lines = [
    '## 怎么用',
    `来源：《${bookName}》${scopeLabel}。写新章或改稿时按当前作品的人物和情节写。`,
    '在 references/samples.md 里按场景看连续原文；也可以用 read_style_examples 取样。只借写法。',
    '',
    '## 写法与原句',
    ...styleCards.map(card => `- ${styleCardLine(card)}`),
    ...(!styleCards.length ? ['本次没有通过原文核对的写法，直接参考范文。'] : []),
    '',
    '## 参考文件',
    `- references/samples.md 收录 ${samples.length} 段范文，各段标明章节和段落。`,
    '- references/avoid.md 列出适用范围内需要留意的写法。',
    '- references/structure.json 中的 book.rules 可用于仿写建书时讨论开篇和推进方式。',
    calibrationNos.length
      ? (judged ? `- ${rangeLabel(task.calibrationChapters || [])}用于校对，调整 ${changed} 条，删除 ${dropped} 条。` : '- 留出的章节未完成校对。')
      : '- 没有另留章节校对。'
  ]
  const source = {
    type: 'reference',
    projectId: task.projectId,
    title: task.title,
    scope: task.scope,
    chapters: task.chapters.map(c => ({ chapterId: c.id, no: c.sortNo, title: c.title })),
    calibration: calibrationNos
  }
  const profile = {
    version: 5,
    source,
    sceneKinds: input.scenes,
    samples,
    cards: styleCards,
    taboos: taboos.map(t => ({ ...t, examples: t.examples.slice(0, 3) })),
    calibration: calibration ? { chapterNos: calibration.chapterNos, changed, dropped, frozenAt: calibration.frozenAt } : null,
    sourceNames,
    examples: [] as unknown[]
  }
  const evidence = {
    version: 1,
    source,
    cards: styleCards.map(c => ({ id: c.id, dimension: c.dimension, evidence: c.evidence })),
    taboos: input.taboos,
    fingerprint,
    calibration
  }
  const structure = {
    version: 3,
    source,
    book,
    cards,
    hooks: Object.fromEntries(hookCounts),
    beats: cards.map(c => ({ chapter: c.chapterNo, strength: Math.max(0, ...c.beats.map(b => b.strength)), kinds: [...new Set(c.beats.map(b => b.kind))] })),
    averages: { chars: avgChars, dialogueRatio: dialogue },
    samples: samples.map(s => s.id)
  }
  const sceneCounts = countBy(samples, s => s.scene)
  const samplesDoc = [
    `# 《${bookName}》${task.scope} 样本（按场景类型）`,
    '每段都是参考书原文，连续不跳段。写作时只学怎么讲：句段呼吸、提示语、情绪怎么出、怎么收；人物、事件、句子都不搬。',
    '',
    '## 目录',
    ...sceneCounts.map(([k, n]) => `- ${k}：${n} 段`),
    ...samples.flatMap(s => ['', `## ${s.id} ${s.scene} · ${chapterLabel(s.chapterNo)}《${s.chapterTitle}》第 ${s.startPara}–${s.endPara} 段`, '', s.text])
  ]
  const bigBeats = cards.filter(c => c.beats.some(b => b.strength >= 4)).map(c => c.chapterNo)
  const analysisDoc = [
    `# 《${bookName}》${task.scope} 分析`,
    '参考书本身的内容，开书或排纲时参考；人物、设定、情节都不属于你的书，不照搬。',
    '',
    '## 卖点与人设',
    book.pitch ? `- 核心梗：${book.pitch}` : '',
    book.promise ? `- 读者承诺：${book.promise}` : '',
    book.protagonist ? `- 主角立法：${book.protagonist}` : '',
    book.power ? `- 金手指：${book.power}` : '',
    book.cast.length ? `- 配角配置：${book.cast.map(c => `${c.name || c.role}（${c.role}${c.note ? '，' + c.note : ''}）`).join('；')}` : '',
    '',
    '## 结构骨架',
    book.openingPlan.length ? `- 开篇任务：${book.openingPlan.map(o => `${chapterLabel(o.chapter)} ${o.job}`).join('；')}` : '',
    book.units.length ? `- 剧情单元：${book.units.map(u => `${u.chapters} 章 ${u.event}${u.note ? '（' + u.note + '）' : ''}`).join('；')}` : '',
    book.foreshadow.length
      ? `- 伏笔账本：${book.foreshadow
          .map(f => `${f.item}（${f.plant ? chapterLabel(f.plant) + '埋' : '埋点不明'}，${f.payoff ? chapterLabel(f.payoff) + '收' : '未收'}${f.how ? '：' + f.how : ''}）`)
          .join('；')}`
      : '',
    book.hooks ? `- 章尾钩子：${book.hooks}` : '',
    book.pacing ? `- 爽点节奏：${book.pacing}${bigBeats.length ? `（大爽点在${bigBeats.map(chapterLabel).join('、')}）` : ''}` : '',
    book.reveals ? `- 设定释放：${book.reveals}` : '',
    book.narrative.length ? `- 推进方式：${book.narrative.join('；')}` : '',
    '',
    '## 章卡',
    ...cards.map(
      c =>
        `- ${chapterLabel(c.chapterNo)}《${c.chapterTitle}》：${c.summary}${c.ending.kind ? `；章尾 ${c.ending.kind}` : ''}${c.beats.length ? `；爽点 ${[...new Set(c.beats.map(b => b.kind))].join('、')}` : ''}${c.reveals.length ? `；新设定 ${c.reveals.map(r => r.item).join('、')}` : ''}`
    )
  ]
  const tidy = (items: string[]) => items.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')
  return {
    instructions: tidy(lines),
    description: `按《${bookName}》${task.scope}的文风写${styleName}：写新章、改稿时用；同题材开书排纲也可参考。`.slice(0, 300),
    profile,
    evidence,
    avoidDoc: ['# 写作注意事项', ...taboos.map(entry => `- ${tabooLine(entry, scopeLabel)}`)].join('\n'),
    structure,
    samplesDoc: tidy(samplesDoc),
    analysisDoc: tidy(analysisDoc)
  }
}
async function run(initial: DistillationTask, live: { controller: AbortController; pause: boolean }) {
  let task = initial
  const signal = live.controller.signal
  const save = async (op: string, args: Record<string, unknown> = {}) => {
    task = update(await command<DistillationTask>(op, { id: task.id, runToken: initial.runToken, ...args }))
    return task
  }
  const checkpoint = async () => {
    if (live.pause || signal.aborted || task.status === 'pausing') {
      await save('paused')
      return true
    }
    return false
  }
  // parse 返回字符串表示"格式对但内容被程序退回"（如证据原句对不上原文），下一次把问题附在提示里让模型改
  const ask = async <T extends object>(
    scene: string,
    label: string,
    build: (feedback: string) => ReturnType<typeof buildCardMessages>,
    parse: (raw: string, attempt: number) => T | string | null,
    invalid: string
  ) => {
    let feedback = ''
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      setLive(task.id, { receivedChars: 0, startedAt: Date.now() })
      const raw = await complete(task.id, { modelCode: task.modelCode, scene, sceneLabel: label, messages: build(feedback), signal })
      const parsed = parse(raw, attempt)
      if (parsed && typeof parsed !== 'string') return parsed
      feedback = typeof parsed === 'string' ? parsed : ''
    }
    throw new InvalidDistillationOutput(invalid)
  }
  /** 非关键步骤（禁忌情境、读判、校准）：模型两次都给不出合格结果就放弃这一步，不让整个蒸馏失败。 */
  const tryAsk = async <T extends object>(
    scene: string,
    label: string,
    build: (feedback: string) => ReturnType<typeof buildCardMessages>,
    parse: (raw: string, attempt: number) => T | string | null,
    invalid: string
  ): Promise<T | null> => {
    try {
      return await ask<T>(scene, label, build, parse, invalid)
    } catch (error) {
      if (!(error instanceof InvalidDistillationOutput)) throw error
      return null
    }
  }
  const kinds: CardKinds = { scenes: sceneKinds(), hooks: hookKinds(), beats: beatKinds() }
  const chapterText = async (chapter: DistillationChapter) => {
    const content = await readLocalBreakdownContent(chapter.id)
    if (!content) throw new Error(`第${chapter.sortNo}章正文缺失`)
    if (chapter.sourceHash) {
      const bytes = new TextEncoder().encode(JSON.stringify(content.paragraphs))
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b =>
        b.toString(16).padStart(2, '0')
      ).join('')
      if (hash !== chapter.sourceHash)
        throw Error(`第${chapter.sortNo}章内容在确认后有改动，请重新确认蒸馏范围`)
    }
    return stripTrailer(content.paragraphs)
  }
  const digest = <T>(key: string) => task.digests[key] as T | undefined
  try {
    setLive(task.id, { phase: 'read', taskStartedAt: Date.now(), startedAt: Date.now(), receivedChars: 0, measuredChars: 0, measuredMs: 0 })
    const ordered = [...task.chapters].sort((a, b) => a.sortNo - b.sortNo)
    for (const chapter of ordered) {
      if (chapter.done) continue
      const paragraphs = await chapterText(chapter)
      const windows = splitWindows(paragraphs)
      const stats = chapterStats(paragraphs)
      for (let part = chapter.partsDone; part < windows.length; part++) {
        if (await checkpoint()) return
        const slice = paragraphs.slice(windows[part].start, windows[part].end)
        setLive(task.id, { phase: 'read', chapterId: chapter.id, part, parts: windows.length })
        const started = Date.now()
        const result = await ask(
          'distillation_card',
          `蒸馏·第${chapter.sortNo}章`,
          () => buildCardMessages({ bookTitle: task.title, chapterTitle: chapter.title, chapterNo: chapter.sortNo, part, parts: windows.length, paragraphs: slice, offset: windows[part].start }),
          raw => normalizeCard(parseAiJson(raw, ['summary', 'samples']), chapter, part, slice, windows[part].start, kinds),
          '章卡的结果格式无效'
        )
        const state = distillationLive.value[task.id]
        setLive(task.id, {
          measuredChars: (state?.measuredChars || 0) + slice.reduce((sum, p) => sum + p.length, 0),
          measuredMs: (state?.measuredMs || 0) + (Date.now() - started)
        })
        const previous = part > 0 ? task.cards?.[String(chapter.id)] : undefined
        const card: DistillationChapterCard = { ...mergeCards(previous, result.card), stats }
        await save('leaf', { chapterId: chapter.id, part, parts: windows.length, picks: result.picks, card })
      }
    }
    const cards = Object.values(task.cards || {}).sort((a, b) => a.chapterNo - b.chapterNo)
    if (!cards.length) throw new Error('这段范围里没有读出任何章卡，换个范围试试')
    // 参考书人名表（章卡里记的人物）：规律层和讲法卡里不许出现（证据引文除外），出现就退回让模型改
    const names = [...new Set(cards.flatMap(c => c.characters.filter(isProperName).map(ch => ch.name.trim())))]
    const checkBook = (parsed: DistillationBook | null, attempt: number) => {
      if (!parsed) return null
      const leaked = leakedNames(rulesText(parsed), names)
      if (leaked.length && attempt < ATTEMPTS)
        return `rules 里出现了参考书的人名：${leaked.join('、')}。规律要换一本书也能照做，人物用主角、旁观者、对手、权威等功能词。`
      return parsed
    }
    // 书级归纳：看章卡，不看原文
    const bookBatches = chunk(cards, BOOK_BATCH)
    const bookSteps = bookBatches.length + (bookBatches.length > 1 ? 1 : 0)
    const books: DistillationBook[] = []
    for (let index = 0; index < bookBatches.length; index++) {
      if (await checkpoint()) return
      const key = `book:${index}`
      let result = digest<DistillationBook>(key)
      if (!result) {
        setLive(task.id, { phase: 'book', step: index + 1, steps: bookSteps })
        result = await ask(
          'distillation_book',
          `蒸馏·归纳骨架第 ${index + 1} 批`,
          feedback => buildBookMessages({ bookTitle: task.title, scope: task.scope, cards: bookBatches[index], feedback }),
          (raw, attempt) => checkBook(normalizeBook(parseAiJson(raw, ['pitch'])), attempt),
          '书级归纳的结果格式无效'
        )
        await save('digest', { key, result })
      }
      books.push(result)
    }
    let book = digest<DistillationBook>('book:root')
    if (!book) {
      if (books.length === 1) book = books[0]
      else {
        if (await checkpoint()) return
        setLive(task.id, { phase: 'book', step: bookSteps, steps: bookSteps })
        book = await ask(
          'distillation_book',
          '蒸馏·合并骨架',
          feedback => buildBookMessages({ bookTitle: task.title, scope: task.scope, cards: [], previous: books, feedback }),
          (raw, attempt) => checkBook(normalizeBook(parseAiJson(raw, ['pitch'])), attempt),
          '合并书级归纳的结果格式无效'
        )
      }
      await save('digest', { key: 'book:root', result: book })
    }
    const chapterTexts = new Map<number, string[]>()
    for (const chapter of ordered) chapterTexts.set(chapter.sortNo, await chapterText(chapter))
    let samplesResult = digest<{ samples: StyleSample[] }>('samples:root')
    if (!samplesResult) {
      setLive(task.id, { phase: 'samples' })
      samplesResult = { samples: sourceSamples(task.picks, kinds.scenes, ordered, chapterTexts) }
      if (!samplesResult.samples.length) throw Error('所选章节没有可用的正文段落')
      await save('digest', { key: 'samples:root', result: samplesResult })
    }
    const samples = samplesResult.samples
    const dims = dimensionTable()
    const checkCards = (parsed: StyleCardCheck | null, attempt: number) => {
      if (!parsed) return null
      const leaked = parsed.cards.filter(c => leakedNames(`${c.observation}\n${c.use}\n${c.boundary}`, names).length)
      const problems = [
        ...parsed.rejected.map(r => `【${r.dimension}】${r.observation.slice(0, 20)}：${r.reason}`),
        ...leaked.map(c => `【${c.dimension}】${c.observation.slice(0, 20)}：观察和用法里出现了参考书的人名`)
      ]
      if (problems.length && attempt < ATTEMPTS) return problems.join('；')
      return { cards: parsed.cards.filter(c => !leaked.includes(c)) }
    }
    const passages = samples.map(sample => ({ ...sample, kind: sample.scene, why: '' }))
    const batches = chunkByChars(passages, CARD_BATCH_CHARS)
    let styleCards: StyleCard[] = []
    for (let index = 0; index < batches.length; index++) {
      if (await checkpoint()) return
      const key = `cards:${index}`
      let result = digest<{ cards: StyleCard[] }>(key)
      if (!result) {
        setLive(task.id, { phase: 'cards', step: index + 1, steps: batches.length })
        const previous = styleCards
        const got = await ask<{ cards: StyleCard[] }>(
          'distillation_style_card',
          `蒸馏·讲法卡第 ${index + 1} 批`,
          feedback => buildStyleCardMessages({ bookTitle: task.title, scope: task.scope, passages: batches[index], previous, feedback }),
          (raw, attempt) => checkCards(normalizeStyleCards(parseAiJson(raw, ['cards']), chapterTexts, dims, {minChapters: Math.min(2, ordered.length)}), attempt),
          '讲法卡的结果格式无效'
        )
        result = { cards: got.cards }
        await save('digest', { key, result })
      }
      styleCards = result.cards
    }
    if (!digest('cards:root')) await save('digest', { key: 'cards:root', result: { cards: styleCards } })
    else styleCards = digest<{ cards: StyleCard[] }>('cards:root')!.cards
    // 禁忌卡：程序数，模型写情境、看读类条目
    const rules: TabooRule[] = parseTabooCatalog(tabooCatalogText())
    const rangeTexts = ordered.map(c => ({ chapterNo: c.sortNo, paragraphs: chapterTexts.get(c.sortNo) || [] }))
    let taboosResult = digest<{ taboos: TabooEntry[] }>('taboos:root')
    if (!taboosResult) {
      if (await checkpoint()) return
      setLive(task.id, { phase: 'taboos', step: 1, steps: 2 })
      let entries = countTaboos(rules, rangeTexts)
      const withHits = entries.filter(e => e.hits > 0)
      if (withHits.length) {
        const parsed = await tryAsk<{ items: unknown[] }>(
          'distillation_taboo_context',
          '蒸馏·禁忌情境',
          () => buildTabooContextMessages({ bookTitle: task.title, items: withHits.map(e => ({ id: e.id, name: e.name, hits: e.hits, examples: e.examples.slice(0, 5) })) }),
          raw => {
            const value = parseAiJson(raw, ['items']) as { items?: unknown[] } | null
            return value && Array.isArray(value.items) ? (value as { items: unknown[] }) : null
          },
          '禁忌情境的结果格式无效'
        )
        if (parsed) entries = applyTabooContexts(entries, parsed)
      }
      const readRules = rules.filter(r => r.method === 'read')
      if (readRules.length) {
        if (await checkpoint()) return
        setLive(task.id, { phase: 'taboos', step: 2, steps: 2 })
        const parsed = await tryAsk<{ items: unknown[] }>(
          'distillation_taboo_read',
          '蒸馏·禁忌读判',
          () => buildTabooReadMessages({ bookTitle: task.title, items: readRules.map(r => ({ id: r.id, name: r.name, note: r.note })), samples }),
          raw => {
            const value = parseAiJson(raw, ['items']) as { items?: unknown[] } | null
            return value && Array.isArray(value.items) ? (value as { items: unknown[] }) : null
          },
          '禁忌读判的结果格式无效'
        )
        entries = [...entries, ...normalizeTabooRead(parsed, readRules, samples)]
      }
      taboosResult = { taboos: entries }
      await save('digest', { key: 'taboos:root', result: taboosResult })
    }
    let taboos = taboosResult.taboos
    // 校准：范围末两章没进前面任何一步，只拿来核对两类卡；改卡记录前后版本后冻结
    const calibrationChapters = [...(task.calibrationChapters || [])].sort((a, b) => a.sortNo - b.sortNo)
    let calibration = digest<CalibrationRecord>('calibration:root') || null
    if (!calibration && calibrationChapters.length) {
      if (await checkpoint()) return
      setLive(task.id, { phase: 'calibrate' })
      const texts: Array<{ chapter: DistillationChapter; paragraphs: string[] }> = []
      for (const chapter of calibrationChapters) texts.push({ chapter, paragraphs: await chapterText(chapter) })
      const calibrationTaboos = countTaboos(rules, texts.map(t => ({ chapterNo: t.chapter.sortNo, paragraphs: t.paragraphs })))
      const tabooDiff = diffTaboos(taboos, calibrationTaboos)
      const cardsBefore = styleCards
      let verdicts: CalibrationRecord['verdicts'] = []
      let cardsAfter = styleCards
      if (styleCards.length) {
        const parsed = await tryAsk<Array<{ id: string; verdict: 'keep' | 'revise' | 'drop'; reason: string; card?: { observation: string; use: string; boundary: string } }>>(
          'distillation_calibrate',
          '蒸馏·校准',
          () =>
            buildCalibrateMessages({
              bookTitle: task.title,
              cards: styleCards,
              chapters: texts.map(t => ({ chapterNo: t.chapter.sortNo, chapterTitle: t.chapter.title, text: clampExample(t.paragraphs, CALIBRATION_CHAPTER_CHARS) }))
            }),
          raw => normalizeCalibration(parseAiJson(raw, ['items']), styleCards.map(c => c.id)),
          '校准的结果格式无效'
        )
        if (parsed) {
          verdicts = parsed.map(item => ({ id: item.id, verdict: item.verdict, reason: item.reason }))
          cardsAfter = applyCalibration(styleCards, parsed)
        }
      }
      calibration = {
        chapterNos: calibrationChapters.map(c => c.sortNo),
        cardsBefore,
        cardsAfter,
        verdicts,
        tabooDiff,
        frozenAt: Date.now()
      }
      taboos = applyTabooDiff(taboos, tabooDiff, calibrationTaboos)
      await save('digest', { key: 'calibration:root', result: calibration })
      // 校准后的禁忌卡覆盖原记录，编档只认校准后的
      await save('digest', { key: 'taboos:root', result: { taboos } })
    } else if (calibration) {
      taboos = digest<{ taboos: TabooEntry[] }>('taboos:root')!.taboos
    }
    const finalCards = calibration ? calibration.cardsAfter : styleCards
    if (await checkpoint()) return
    setLive(task.id, { phase: 'compile' })
    const allParagraphs = ordered.flatMap(c => chapterTexts.get(c.sortNo) || [])
    const compiled = compileProfile(task, {
      book,
      cards,
      samples,
      styleCards: finalCards,
      taboos,
      calibration,
      fingerprint: styleFingerprint(allParagraphs),
      scenes: kinds.scenes
    })
    const files = [
      { path: 'references/examples.json', content: JSON.stringify(compiled.profile, null, 2) },
      { path: 'references/evidence.json', content: JSON.stringify(compiled.evidence, null, 2) },
      { path: 'references/structure.json', content: JSON.stringify(compiled.structure, null, 2) },
      { path: 'references/samples.md', content: compiled.samplesDoc },
      { path: 'references/book-analysis.md', content: compiled.analysisDoc },
      { path: 'references/avoid.md', content: compiled.avoidDoc }
    ]
    await save('complete', {
      bundle: {
        name: skillNameFor(task, book),
        description: compiled.description,
        instructions: compiled.instructions,
        files
      },
      outcome: {
        chapterCards: cards.length,
        samples: compiled.profile.samples.length,
        styleCards: compiled.profile.cards.length,
        taboos: compiled.profile.taboos.length,
        calibrated: calibration ? calibration.verdicts.filter(v => v.verdict !== 'keep').length : 0
      }
    })
    bumpSkillsRevision()
    try {
      await reloadSkills()
    } finally {
      announceTaskFinished('distillation', task.id)
    }
  } catch (error) {
    const current = await command<DistillationTask>('get', { id: initial.id })
    update(current)
    if (current.runToken !== initial.runToken || !['running', 'pausing'].includes(current.status)) return
    if (signal.aborted && live.pause) await save('paused')
    else {
      await save('fail', { error: error instanceof Error ? error.message : String(error) })
      announceTaskFinished('distillation', task.id)
    }
  }
}

// ---- 通用任务层的视图
const STATUS_LABELS: Record<DistillationTask['status'], string> = {
  running: '进行中',
  pausing: '正在暂停',
  paused: '已暂停',
  failed: '未完成',
  cancelled: '已取消',
  completed: '已完成'
}
export const distillationEventMessage = (task: Pick<DistillationTask, 'id' | 'title' | 'scope' | 'skillName' | 'outcome' | 'skillId'>) =>
  platformEventMessage(
    `《${task.title}》${task.scope}的文风技能已经生成，技能名「${task.skillName}」${task.outcome?.skillFile ? `，文件在 ${task.outcome.skillFile}` : ''}。请用 read 读取这个 SKILL.md，用两三句话告诉作者档案里有什么（原文样本、讲法卡、按原书频率写的禁忌卡、校准情况）、写作时怎么用它；不要把整份档案贴出来。`,
    { kind: 'distillation_completed', taskId: task.id, title: task.title, scope: task.scope, skillId: task.skillId }
  )
function viewOf(task: DistillationTask, now: number): PiTaskView {
  const live = distillationLive.value[task.id]
  const active = task.status === 'running' || task.status === 'pausing'
  const totalChars = task.chapters.reduce((sum, c) => sum + c.chars, 0)
  const readChars = task.chapters.reduce((sum, c) => sum + (c.done ? c.chars : c.parts ? Math.round((c.chars * c.partsDone) / c.parts) : 0), 0)
  const readDone = task.chapters.filter(c => c.done).length
  let percent = 0
  if (task.status === 'completed') percent = 100
  else if (live?.phase === 'compile') percent = 98
  else if (live?.phase === 'calibrate') percent = 93
  else if (live?.phase === 'taboos') percent = 88 + ((live.step || 1) - 1) * 2
  else if (live?.phase === 'cards' && live.steps) percent = Math.round(78 + (((live.step || 1) - 1) / live.steps) * 10)
  else if (live?.phase === 'samples') percent = 77
  else if (live?.phase === 'book' && live.steps) percent = Math.round(70 + (((live.step || 1) - 1) / live.steps) * 6)
  else if (totalChars) percent = Math.round(Math.min(70, (readChars / totalChars) * 70))
  const speed = live?.measuredMs ? live.measuredChars / live.measuredMs : 0
  const elapsed = live ? now - live.taskStartedAt : 0
  let eta = ''
  if (live && active) {
    if (live.phase !== 'read') eta = '几分钟'
    else if (!speed) {
      const [low, high] = task.estimatedMinutes || []
      eta = low && high ? `${low}–${high} 分钟（粗估）` : ''
    } else eta = formatDuration(Math.max(0, totalChars - readChars) / speed + 180000)
  }
  const numbers = [`已读 ${readDone}/${task.chapters.length} 章`, `已标原文段 ${task.picks.length} 段`]
  if (active && elapsed > 0) numbers.push(`已用 ${formatDuration(elapsed)}`)
  if (active && eta) numbers.push(`预计还需约 ${eta}`)
  let current = ''
  if (active) {
    if (!live) current = task.status === 'pausing' ? '正在保存当前进度，保存后暂停…' : '正在准备…'
    else {
      const received = live.receivedChars ? ` · 已收到 ${live.receivedChars} 字` : ''
      const spent = ` · 本步 ${formatDuration(now - live.startedAt)}`
      if (live.phase === 'read') {
        const chapter = task.chapters.find(c => c.id === live.chapterId)
        const where = chapter ? `第${chapter.sortNo}章《${chapter.title}》` : ''
        const part = (live.parts || 1) > 1 ? `（第 ${(live.part || 0) + 1}/${live.parts} 段）` : ''
        current = `${task.status === 'pausing' ? '正在保存' : '正在读'}${where}${part}${received}${spent}`
      } else if (live.phase === 'book') current = `正在归纳卖点与结构骨架（第 ${live.step}/${live.steps} 批）${received}${spent}`
      else if (live.phase === 'samples') current = '正在挑样本…'
      else if (live.phase === 'cards') current = `正在写讲法卡并核对证据（第 ${live.step}/${live.steps} 批）${received}${spent}`
      else if (live.phase === 'taboos') current = `正在按对照表数禁忌（${live.step === 2 ? '读类条目' : '写情境'}）${received}${spent}`
      else if (live.phase === 'calibrate') current = `正在用校准集核对卡${received}${spent}`
      else current = '正在编档…'
    }
  }
  const hint =
    task.status === 'paused'
      ? '已暂停。已读的章卡和原文段保留，继续会从断点接着。'
      : task.status === 'cancelled'
        ? '已取消。没有生成技能。'
        : task.status === 'completed' && task.continueSkipped && !task.continuedAt
          ? `档案已生成，没有自动接着说：${task.continueSkipped}。`
          : ''
  const summary =
    task.status === 'completed' && task.outcome
      ? [
          `已生成技能「${task.skillName}」：${task.outcome.samples} 段样本、${task.outcome.styleCards} 条讲法卡、${task.outcome.taboos} 条禁忌卡${
            task.calibrationChapters?.length ? `，校准集核对后改动 ${task.outcome.calibrated} 条` : ''
          }。输入 / 就能用。`
        ]
      : []
  const finished = task.status === 'completed' || task.status === 'cancelled'
  return {
    kind: 'distillation',
    id: task.id,
    sessionId: task.sessionId,
    callId: task.callId,
    anchor: task.anchor,
    createdAt: task.createdAt,
    title: task.title,
    scope: `${task.scope} · 蒸馏文风`,
    status: task.status,
    statusLabel: STATUS_LABELS[task.status],
    active,
    percent,
    numbers,
    current,
    hint,
    error: task.error,
    summaryTitle: '结果',
    summary,
    autoContinue: task.autoContinue !== false,
    continuedAt: task.continuedAt,
    continueSkipped: task.continueSkipped,
    actions: {
      pause: task.status === 'running',
      resume: task.status === 'paused' || task.status === 'failed',
      retry: task.status === 'failed',
      cancel: !finished,
      autoContinue: !finished,
      continueNow: task.status === 'completed' && !!task.continueSkipped && !task.continuedAt
    },
    cancelTitle: '取消蒸馏',
    cancelText: '停止蒸馏，不会生成技能；已读的章卡和原文段保留在任务里，之后可以重新发起。',
    result: task.skillId ? { kind: 'skill', id: task.id, label: '查看文风技能' } : null
  }
}
export const distillationTaskViews = computed(() => distillationTasks.value.map(task => viewOf(task, taskClock.value)))
registerTaskProvider({
  kind: 'distillation',
  views: () => distillationTaskViews.value,
  control: controlDistillation,
  setAutoContinue: setDistillationAutoContinue,
  markContinued: markDistillationContinued,
  markContinueSkipped: markDistillationContinueSkipped,
  eventMessage: view => {
    const task = distillationTasks.value.find(t => t.id === view.id)
    return task ? distillationEventMessage(task) : null
  },
  initialize: initializeDistillationTasks,
  stopAll: stopDistillationTasks,
  hasRunning: hasRunningDistillations
})
