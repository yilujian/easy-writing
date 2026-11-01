import type { PiReference } from '@/types/agent-pi'

/** 输入框里的弹出菜单：词首的 / 或 $ 选技能，词首的 @ 引用当前作品的资料。 */
export type MenuKind = 'skill' | 'mention'
export interface MenuTrigger {
  kind: MenuKind
  trigger: '/' | '$' | '@'
  /** 触发符在文本里的位置；替换时从这里到 end 整段去掉。 */
  start: number
  end: number
  query: string
}
/** 光标前最近的触发：三个符号都只认开头或空白之后；查询词到光标为止，不含空白。 */
export function detectMenu(text: string, caret: number): MenuTrigger | null {
  const before = text.slice(0, caret)
  const match = before.match(/(^|\s)([/$@])([^\s/$@]*)$/)
  if (!match) return null
  const trigger = match[2] as MenuTrigger['trigger']
  const start = caret - match[3].length - 1
  return { kind: trigger === '@' ? 'mention' : 'skill', trigger, start, end: caret, query: match[3] }
}
/** 选中后把触发片段从文本里去掉；选中的技能或引用变成输入框上方的标签，不进正文。 */
export function removeTrigger(text: string, menu: MenuTrigger) {
  const head = text.slice(0, menu.start)
  const tail = text.slice(menu.end).replace(/^\s/, '')
  return { text: head + tail, caret: head.length }
}
/** 简单的包含匹配：名字、描述或拼音都不做转换，输入什么就按什么找。 */
export function filterItems<T extends { title: string; keywords?: string }>(items: T[], query: string, limit = 12) {
  const needle = query.trim().toLowerCase()
  if (!needle) return items.slice(0, limit)
  const hit = (value: string | undefined) => !!value && value.toLowerCase().includes(needle)
  const starts = items.filter(item => item.title.toLowerCase().startsWith(needle))
  const rest = items.filter(item => !starts.includes(item) && (hit(item.title) || hit(item.keywords)))
  return [...starts, ...rest].slice(0, limit)
}

/** 文字里的技能标记就是 /技能名；选中后整段是一个整体，退格一次全删。 */
export const skillToken = (name: string) => `/${name}`
export interface SkillToken {
  name: string
  start: number
  end: number
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 找文字里第一个技能标记：在开头或空白后、后面是空白或结尾，且是已启用技能的名字；名字长的先比。 */
export function findSkillToken(text: string, names: string[]): SkillToken | null {
  let found: SkillToken | null = null
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const match = text.match(new RegExp(`(^|\\s)/${escape(name)}(?=\\s|$)`))
    if (match?.index === undefined) continue
    const start = match.index + match[1].length
    if (!found || start < found.start) found = { name, start, end: start + name.length + 1 }
  }
  return found
}
/** 去掉一个标记和它后面的一个空格。 */
export function stripToken(text: string, token: { start: number; end: number }) {
  return text.slice(0, token.start) + text.slice(token.end).replace(/^ /, '')
}
/** 去掉技能标记和它后面的一个空格；剩下的就是作者的话。 */
export const stripSkillToken = (text: string, token: SkillToken) => stripToken(text, token)
/** 行内标记：技能是 /技能名，引用是 @标题；两种在输入框里长得一样，光标跳过、退格先选中再删。 */
export type InlineToken =
  | { kind: 'skill'; name: string; start: number; end: number }
  | { kind: 'ref'; reference: PiReference; start: number; end: number }
export type MentionToken = Extract<InlineToken, { kind: 'ref' }>
export const mentionToken = (title: string) => `@${title}`
/** 文字里的 @ 引用：按已登记资料的标题找，开头或空白后、后面是空白或结尾；每条资料只认第一次出现。 */
export function findMentionTokens(text: string, references: PiReference[]): MentionToken[] {
  const out: MentionToken[] = []
  const taken = new Set<number>()
  for (const reference of references) {
    if (!reference.title) continue
    const pattern = new RegExp(`(^|\\s)@${escape(reference.title)}(?=\\s|$)`, 'g')
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index + match[1].length
      if (taken.has(start)) continue
      taken.add(start)
      out.push({ kind: 'ref', reference, start, end: start + reference.title.length + 1 })
      break
    }
  }
  return out
}
/** 文字里全部标记，按位置排好、互不重叠。 */
export function findTokens(text: string, skillNames: string[], references: PiReference[]): InlineToken[] {
  const skill = findSkillToken(text, skillNames)
  const all: InlineToken[] = [...(skill ? [{ kind: 'skill' as const, ...skill }] : []), ...findMentionTokens(text, references)]
  return all.sort((a, b) => a.start - b.start).filter((token, index, list) => index === 0 || token.start >= list[index - 1].end)
}
/** 在 at 处插入一个标记和一个空格，返回新文字和光标位置。 */
export function insertToken(text: string, tokenText: string, at: number) {
  const head = text.slice(0, at)
  return { text: `${head}${tokenText} ${text.slice(at)}`, caret: head.length + tokenText.length + 1 }
}
/** 把技能标记放在 at 处（触发符原来的位置）；文字里已有的标记先去掉，一条消息只有一个技能。 */
export function insertSkillToken(text: string, name: string, at: number, existing: SkillToken | null) {
  let base = text,
    position = at
  if (existing) {
    base = stripSkillToken(text, existing)
    if (existing.start < at) position = Math.max(existing.start, at - (text.length - base.length))
  }
  const token = `${skillToken(name)} `
  const head = base.slice(0, position)
  return { text: head + token + base.slice(position), caret: head.length + token.length }
}
