import { ref, shallowRef } from 'vue'
import { piCommand } from './client'
import type { PiSkill, PiToolRequest } from '@/types/agent-pi'

/** 技能列表由宿主按目录读出；界面改完后由工作台让开着的对话重新加载。 */
export const piSkills = shallowRef<PiSkill[]>([])
/** 技能每改一次加一；对话里的 Pi 实例版本落后时，发消息前先让它重新加载技能。 */
export const skillsRevision = ref(0)
export const bumpSkillsRevision = () => skillsRevision.value++
const call = <T>(op: string, args: Record<string, unknown> = {}) => piCommand<T>('skills', { op, ...args })
export async function reloadSkills() {
  const list = await call<PiSkill[]>('list')
  piSkills.value = Array.isArray(list) ? list : []
  return piSkills.value
}
export interface SkillInput {
  id?: string
  name: string
  displayName?: string
  description: string
  instructions: string
  manual: boolean
}
export async function saveSkill(input: SkillInput) {
  const saved = await call<PiSkill>('save', { ...input })
  await reloadSkills()
  return saved
}
export async function deleteSkill(id: string) {
  piSkills.value = await call<PiSkill[]>('delete', { id })
}
export async function setSkillEnabled(id: string, enabled: boolean) {
  piSkills.value = await call<PiSkill[]>('enable', { id, enabled })
}
export async function importSkill(path: string) {
  const imported = await call<PiSkill>('import', { path })
  await reloadSkills()
  return imported
}
/** 往作者技能目录里写参考文件（references/、assets/ 下），蒸馏出的范例库走这里。 */
export async function saveSkillFiles(id: string, files: Array<{ path: string; content: string }>) {
  const saved = await call<PiSkill>('save_files', { id, files })
  await reloadSkills()
  return saved
}
/** 读作者技能目录里的参考文件（references/ 下）；文件不存在时 content 为 null。 */
export const readSkillFiles = (id: string, paths: string[]) =>
  call<Array<{ path: string; content: string | null }>>('read_files', { id, paths })
/**
 * 技能名里不能有空白：Pi 的 /skill:名字 命令按第一个空格切名字，带空格的名字永远对不上、技能不会展开。
 * 生成、保存、发命令、查找都按去掉空白的名字算；宿主列目录时把旧文件里带空格的名字改掉。
 */
export const compactSkillName = (name: string) => name.replace(/\s+/g, '')
export const skillLabel = (skill: PiSkill) => skill.displayName || skill.name
export const skillNamesForInput = (skills: PiSkill[]) => [...new Set(skills.filter(s => s.enabled).flatMap(s => [s.name, skillLabel(s)]))]
/** 按名字或编号找技能；蒸馏出的技能名带书名号，作者和模型都可能只写名字；老任务记的名字可能带空格，忽略空白再对一次。 */
export const findSkill = (ref: string) => {
  const key = ref.trim()
  const compact = compactSkillName(key)
  const exact = piSkills.value.find(s => s.id === key || s.name === key) ||
    (compact ? piSkills.value.find(s => compactSkillName(s.name) === compact) : undefined)
  if (exact) return exact
  const labels = piSkills.value.filter(s => compact && compactSkillName(skillLabel(s)) === compact)
  return labels.length === 1 ? labels[0] : null
}
export const skillDisplayName = (name: string) => { const skill = findSkill(name); return skill ? skillLabel(skill) : name }
/** 作者这一轮在输入框里选的技能：发消息时登记，后台任务（批量写作）启动时据此知道按哪份写法写。 */
const sessionSkills = new Map<string, string>()
export const noteSessionSkill = (sessionId: string, name: string | null) => {
  if (!sessionId) return
  if (name) sessionSkills.set(sessionId, name)
  else sessionSkills.delete(sessionId)
}
export const sessionSkill = (sessionId: string) => sessionSkills.get(sessionId) || ''
/** Pi 原生的技能命令：消息以 /skill:名字 开头，Pi 会把技能说明放在前面、作者的话放在后面。名字里的空白去掉，否则 Pi 切不出名字。 */
export const skillCommand = (name: string, text: string) => {
  const compact = compactSkillName(findSkill(name)?.name || name)
  return text ? `/skill:${compact} ${text}` : `/skill:${compact}`
}
/** 老消息里的技能名可能带空格：按已知技能名、忽略空白逐字对上，最长的先试；返回名字在文本里到哪为止。 */
function matchKnownSkill(rest: string): { skill: string; end: number } | null {
  const names = [...new Set(piSkills.value.flatMap(s => [s.name, skillLabel(s)]))].sort((a, b) => b.length - a.length)
  for (const name of names) {
    const target = compactSkillName(name)
    if (!target) continue
    let i = 0,
      j = 0
    while (i < rest.length && j < target.length) {
      if (/\s/.test(rest[i])) {
        i++
        continue
      }
      if (rest[i] !== target[j]) break
      i++
      j++
    }
    if (j === target.length && (i >= rest.length || /\s/.test(rest[i]))) return { skill: name, end: i }
  }
  return null
}
/** 会话里存的是 Pi 展开后的样子：<skill name="…">说明</skill> 加作者的话；没展开的仍是 /skill: 前缀。 */
export function parseSkillCommand(text: string): { skill: string; text: string } | null {
  if (text.startsWith('/skill:')) {
    const rest = text.slice('/skill:'.length)
    const known = matchKnownSkill(rest)
    if (known) return { skill: known.skill, text: rest.slice(known.end).trim() }
    const raw = text.match(/^\/skill:(\S+)(?:\s+([\s\S]*))?$/)
    return raw ? { skill: raw[1], text: raw[2] || '' } : null
  }
  const expanded = text.match(/^<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>\s*([\s\S]*)$/)
  return expanded ? { skill: expanded[1], text: expanded[2] } : null
}
/** 扩展已经请作者确认过；这里只把脚本交给宿主跑，停止时让宿主杀掉进程。 */
export async function runSkillScript(
  request: PiToolRequest,
  signal?: AbortSignal,
  progress?: (text: string) => void
) {
  signal?.throwIfAborted()
  const { skill, script } = request.args as { skill?: string; script?: string }
  const cancel = () => {
    void piCommand('skill_script', { op: 'cancel', id: request.id }).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  progress?.(`正在运行 ${skill || ''} / ${script || ''}`)
  try {
    const result = await piCommand<{
      exitCode: number | null
      stdout: string
      stderr: string
      truncated: boolean
      timedOut: boolean
      cancelled: boolean
      durationMs: number
    }>('skill_script', {
      op: 'run',
      id: request.id,
      skill,
      script,
      args: Array.isArray(request.args.args) ? request.args.args : []
    })
    signal?.throwIfAborted()
    return {
      ...result,
      message: result.cancelled
        ? '脚本被停止，没有完整输出。'
        : result.timedOut
          ? '脚本超过两分钟没有结束，已终止；请不要重复运行。'
          : result.exitCode === 0
            ? '脚本运行完成。'
            : `脚本以退出码 ${result.exitCode ?? '未知'} 结束，请结合 stderr 判断。`
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
