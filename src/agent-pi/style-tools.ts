import { findSkill, noteSessionSkill, readSkillFiles, reloadSkills } from './skills'
import { noteLine, styleCardLine } from '@/config/distillation-prompts'
import { tabooLine } from './style-taboos'
import { DEFAULT_EXAMPLE_KINDS, type StyleCard, type StyleSample, type TabooEntry } from '@/types/distillation-task'
import type { PiToolRequest } from '@/types/agent-pi'

/**
 * 写作时取样本：从文风技能的 references/examples.json 里取一段连续原文（按场景类型轮换，不按相似度挑），
 * 连同讲法卡和禁忌卡一起给模型，作为当前方法参考，不覆盖作者要求或本书事实。
 * 第二版技能（只有按功能类型的 examples）仍按旧逻辑取几段范例。
 * 取过样本的 Pi 实例记一笔时间，保存候选前平台核对：绑了文风技能却没取样本，不让保存。
 */
interface StyleExample {
  id: string
  kind: string
  why?: string
  text: string
  source?: { no?: number; title?: string }
}
interface StyleNote {
  /** 旧版写法卡只有一句话 */
  text?: string
  kind?: string
  when?: string
  how?: string[]
  avoid?: string
  exampleIds: string[]
}
interface StyleProfile {
  version?: number
  kinds?: string[]
  examples?: StyleExample[]
  notes?: StyleNote[]
  /** 第三版 */
  sceneKinds?: string[]
  samples?: StyleSample[]
  cards?: StyleCard[]
  taboos?: TabooEntry[]
  calibration?: { chapterNos: number[]; changed: number; dropped: number } | null
  source?: { scope?: string; chapters?: unknown[] }
  /** 参考书人名表，写作保存前核对正文没把参考书的人物搬进来 */
  sourceNames?: string[]
}
const noteText = (n: StyleNote) => n.text || noteLine({ kind: n.kind || '', when: n.when || '', how: n.how || [], avoid: n.avoid || '' })
interface StyleStructure {
  book?: { hooks?: string; pacing?: string; reveals?: string }
  hooks?: Record<string, number>
  averages?: { chars?: number; dialogueRatio?: number }
}
const DEFAULT_LIMIT = 4
const MAX_LIMIT = 8
const styleReads = new Map<string, number>()
const cursors = new Map<string, number>()
export const styleReadAt = (instanceId: string) => styleReads.get(instanceId) || 0
export const markStyleRead = (instanceId: string) => styleReads.set(instanceId, Date.now())
export const releaseStyleReads = (instanceId: string) => styleReads.delete(instanceId)
const parse = <T>(content: string | null | undefined): T | null => {
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}
/** 同一技能同一类型轮着给：游标记在整类上，从游标处往后找第一段这次还没取的。 */
function takeNext<T>(items: T[], key: string, taken: T[]): T | null {
  if (!items.length) return null
  const start = cursors.get(key) || 0
  for (let i = 0; i < items.length; i++) {
    const index = (start + i) % items.length
    if (taken.includes(items[index])) continue
    cursors.set(key, (index + 1) % items.length)
    return items[index]
  }
  return null
}
const profileCache = new Map<string, StyleProfile | null>()
const hasSamples = (profile: StyleProfile | null): profile is StyleProfile & { samples: StyleSample[] } => !!profile?.samples?.length
const hasExamples = (profile: StyleProfile | null): profile is StyleProfile & { examples: StyleExample[] } => !!profile?.examples?.length
/** 技能的样本库：不是蒸馏出来的、或读不到，就是 null。按技能的修改时间缓存。 */
async function profileOf(ref: string): Promise<StyleProfile | null> {
  try {
    let skill = findSkill(ref)
    if (!skill) {
      await reloadSkills()
      skill = findSkill(ref)
    }
    if (!skill) return null
    const key = `${skill.id}:${skill.updatedAt}`
    if (profileCache.has(key)) return profileCache.get(key) || null
    const files = await readSkillFiles(skill.id, ['references/examples.json'])
    const profile = parse<StyleProfile>(files[0]?.content)
    const value = hasSamples(profile) || hasExamples(profile) ? profile : null
    profileCache.set(key, value)
    return value
  } catch {
    return null
  }
}
/** 是不是蒸馏出来的文风技能（带原文样本库或旧版范例库）。 */
export const isStyleSkill = async (ref: string) => !!(await profileOf(ref))
/** 只有成功读到技能且确认没有平台样本库时，才将它视为普通流程 Skill。
 * 读取失败、技能缺失或损坏的样本库都不能借此跳过批量任务已有的样本校验。
 */
export async function isInstructionOnlySkill(ref: string): Promise<boolean> {
  try {
    let skill = findSkill(ref)
    if (!skill) {
      await reloadSkills()
      skill = findSkill(ref)
    }
    if (!skill || !skill.enabled) return false
    const files = await readSkillFiles(skill.id, ['references/examples.json'])
    return files.find(file => file.path === 'references/examples.json')?.content === null
  } catch {
    return false
  }
}
/** 参考书人名表：技能不是蒸馏出来的、或读不到，就当没有名单。 */
export async function sourceNamesOf(ref: string): Promise<string[]> {
  const profile = await profileOf(ref)
  return (profile?.sourceNames || []).map(n => String(n).trim()).filter(n => n.length >= 2)
}
const sampleScore = (query: string, content: string) => {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).flatMap(word =>
    /[\p{Script=Han}]/u.test(word) ? Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word])
  return [...new Set(terms)].filter(term => content.toLocaleLowerCase().includes(term)).length
}
const NOTE = '样本供当前所选方法参考，作者本次要求与本书事实优先。只借鉴适用写法，不搬人物、事件或句子，不将样本当作必须套用的章节结构。'
export async function readStyleExamples(request: PiToolRequest, signal?: AbortSignal, recordSelection=true) {
  signal?.throwIfAborted()
  const ref = String(request.args.skill || '').trim()
  if (!ref) throw new Error('请填写文风技能的名字')
  let skill = findSkill(ref)
  if (!skill) {
    await reloadSkills()
    skill = findSkill(ref)
  }
  if (!skill) throw new Error(`没有叫「${ref}」的技能，用 / 菜单里显示的名字`)
  const files = await readSkillFiles(skill.id, ['references/examples.json', 'references/structure.json'])
  signal?.throwIfAborted()
  const profile = parse<StyleProfile>(files.find(f => f.path === 'references/examples.json')?.content)
  if (!hasSamples(profile) && !hasExamples(profile)) throw new Error(`「${skill.name}」没有原文样本库，不是蒸馏出的文风技能；只能按它的说明写`)
  const query = String(request.args.query || '').trim()
  const sampleId = String(request.args.sampleId || '').trim()
  const version = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(files.map(file => file.content || '').join('\n')))), byte => byte.toString(16).padStart(2, '0')).join('')
  if (sampleId && request.args.version !== version) throw new Error('样本库版本已变化或未提供版本，请重新查询后选择；未返回替代样本')
  if (query && !sampleId) {
    const candidates = hasSamples(profile)
      ? profile.samples.map(sample => ({ id: sample.id, scene: sample.scene, summary: sample.text.slice(0, 220), chapterNo: sample.chapterNo, content: sample.scene + ' ' + sample.text }))
      : profile.examples!.map(example => ({ id: example.id, scene: example.kind, summary: example.text.slice(0, 220), chapterNo: example.source?.no, content: example.kind + ' ' + (example.why || '') + ' ' + example.text }))
    return { mode: 'candidates', skill: skill.name, version, candidates: candidates.map(item => ({ ...item, score: sampleScore(query, item.content) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(({ id, scene, summary, chapterNo }) => ({ id, scene, summary, chapterNo })), note: '这些是检索摘要，尚未读取完整样本。核对当前故事条件，选择适用的 sampleId 和 version 读取；可以不选，不要只凭相似词语套用。' }
  }
  const selectedSkillName = skill.name
  const markRead = () => {
    if(recordSelection) noteSessionSkill(String(request.args.sessionId || ''), selectedSkillName)
    markStyleRead(request.instanceId)
  }
  const guidance = request.args.includeGuidance !== false
  if (hasSamples(profile)) {
    // 第三版：一段连续样本按场景类型轮换 + 讲法卡 + 禁忌卡
    const scenes = [...new Set([...(profile.sceneKinds || []), ...profile.samples.map(s => s.scene)])].filter(s => profile.samples.some(x => x.scene === s))
    const wanted = String(request.args.scene ?? (Array.isArray(request.args.kinds) ? request.args.kinds[0] : request.args.kinds) ?? '').trim()
    const scene = scenes.includes(wanted) ? wanted : ''
    const pool = scene ? profile.samples.filter(s => s.scene === scene) : profile.samples
    const sample = sampleId ? profile.samples.find(item => item.id === sampleId) : takeNext(pool, `${skill.id}:${scene || '*'}`, [])
    if (!sample) throw new Error('所选样本不存在，请重新查询；未自动换用其他样本')
    markRead()
    const display=(s:StyleSample)=>({id:s.id,scene:s.scene,from:`第${s.chapterNo}章${s.chapterTitle ? `《${s.chapterTitle}》` : ''}第 ${s.startPara}–${s.endPara} 段`,text:s.text})
    const additionalSamples=recordSelection ? [] : [...new Map([...pool,...profile.samples].map(s=>[s.id,s])).values()].filter(s=>s.id!==sample.id).slice(0,3).map(display)
    const scopeLabel = profile.source?.scope ? `${profile.source.scope}（${profile.source.chapters?.length || 0} 章）` : '范围内'
    return {
      skill: skill.name, version,
      scene: sample.scene,
      ...(wanted && !scene ? { unknownScene: wanted } : {}),
      availableScenes: scenes,
      sample:display(sample),
      ...(additionalSamples.length?{additionalSamples}:{}),
      cards: guidance ? (profile.cards || []).filter(card => !sampleId || card.evidence.some(e => e.chapterNo === sample.chapterNo)).map(styleCardLine) : [],
      taboos: guidance ? (profile.taboos || []).filter(t => !sampleId || t.examples.some(e => e.chapterNo === sample.chapterNo)).map(t => tabooLine(t, scopeLabel)) : [],
      ...(profile.calibration ? { calibration: `第 ${profile.calibration.chapterNos.join('、')} 章校准，改 ${profile.calibration.changed} 条、删 ${profile.calibration.dropped} 条` } : {}),
      note: NOTE
    }
  }
  // 第二版：按功能类型取几段范例
  const structure = parse<StyleStructure>(files.find(f => f.path === 'references/structure.json')?.content)
  const available = [...new Set([...(profile.kinds || []), ...profile.examples.map(e => e.kind)])]
  const wanted = (Array.isArray(request.args.kinds) ? request.args.kinds : [request.args.kinds ?? request.args.scene])
    .map(k => String(k ?? '').trim())
    .filter(Boolean)
  const unknown = wanted.filter(k => !available.includes(k))
  const kinds = wanted.filter(k => available.includes(k))
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.args.limit) || DEFAULT_LIMIT))
  const selected = sampleId ? profile.examples.find(example => example.id === sampleId) : null
  if (sampleId && !selected) throw new Error('所选范例不存在，请重新查询；未自动换用其他范例')
  const picked: StyleExample[] = selected ? [selected] : []
  const defaults = [...DEFAULT_EXAMPLE_KINDS] as string[]
  const order = kinds.length ? kinds : defaults.filter(k => available.includes(k)).concat(available.filter(k => !defaults.includes(k)))
  for (let round = 0; !sampleId && round < MAX_LIMIT && picked.length < limit; round++) {
    let added = false
    for (const kind of order) {
      if (picked.length >= limit) break
      const next = takeNext(profile.examples.filter(e => e.kind === kind), `${skill.id}:${kind}`, picked)
      if (next) {
        picked.push(next)
        added = true
      }
    }
    if (!added) break
  }
  markRead()
  const notes = (guidance ? profile.notes || [] : []).filter(n => n.exampleIds.some(id => picked.some(e => e.id === id))).map(noteText)
  return {
    skill: skill.name, version,
    kinds: kinds.length ? kinds : order.slice(0, picked.length),
    ...(unknown.length ? { unknownKinds: unknown, availableKinds: available } : {}),
    examples: picked.map(e => ({
      id: e.id,
      kind: e.kind,
      from: e.source?.no ? `第${e.source.no}章${e.source.title ? `《${e.source.title}》` : ''}` : '',
      why: e.why || '',
      text: e.text
    })),
    notes,
    reminders: guidance && !sampleId ? [structure?.book?.hooks, structure?.book?.pacing, structure?.book?.reveals].filter(Boolean) : [],
    ...(guidance && !sampleId && structure?.averages?.chars ? { chapterChars: structure.averages.chars } : {}),
    note: NOTE
  }
}
