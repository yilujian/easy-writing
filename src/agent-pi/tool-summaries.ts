import groups from '../../agent-pi/contracts/tool-groups.json'
import { entitySpecs } from './creation'
import type { PiEntityKind, PiMessage } from '@/types/agent-pi'

type Group = { selector: string; default: string; operations: Record<string, string> }
export function toolOperation(name: string | undefined, args?: Record<string, unknown>) {
  const group = (groups as Record<string, Group>)[name || '']
  return group?.operations[String(args?.[group.selector] ?? group.default)] || name
}

/** 过程区里每个工具一行的参数摘要和结果摘要；按工具名查表，不显示任何内部编号，也不截 JSON。 */
type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)
const chars = (value: unknown) => (typeof value === 'string' ? value.replace(/\s/g, '').length : 0)
export const clip = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const ID_KEY = /Id$|^id$/
const HEADING_STYLES: Record<string, string> = { auto: '自动识别', numbered: '数字序号标题', markdown: '井号标题' }
const ACTIONS: Record<string, string> = { pause: '暂停', resume: '继续', cancel: '取消' }
const PLAIN_LABELS: Record<string, string> = { title: '标题', name: '名称', query: '关键词', date: '日期' }
const REFERENCE_LABELS: Record<string, string> = {
  characters: '人物',
  settings: '设定',
  outlineNodes: '大纲',
  relations: '人物关系',
  timeline: '时间线',
  timelineEvents: '时间线',
  storylines: '故事线',
  storyNodes: '剧情节点',
  chapterReferences: '章节引用',
  volumes: '分卷'
}
const rangeOf = (args: Rec) =>
  args.scope === 'all'
    ? '全书'
    : args.fromChapter != null || args.toChapter != null
      ? `第 ${args.fromChapter ?? 1}–${args.toChapter ?? '?'} 章`
      : count(args.chapterIds)
        ? `${count(args.chapterIds)} 章`
        : ''
const draftArgs = (args: Rec) =>
  [str(args.title), typeof args.content === 'string' ? `正文 ${chars(args.content)} 字` : '']
    .filter(Boolean)
    .join('，')

export function summarizeToolArgs(tool: string | undefined, args?: Rec): string {
  if (!args) return ''
  tool = toolOperation(tool, args)
  switch (tool) {
    case 'ask_author':
      return clip(str(args.question), 80) + (count(args.options) ? `（${count(args.options)} 个选项）` : '')
    case 'plan_chapters':
      return `${count(args.chapters)} 章`
    case 'read':
    case 'read_platform_state':
      return ''
    case 'prepare_writing':
      return { chapter: '核对章节', materials: '准备作品资料', batch: '准备连写', new_chapter: '准备新章' }[str(args.target)] || '准备新章'
    case 'run_breakdown':
      return [rangeOf(args), args.reanalyze === true ? '重新分析' : ''].filter(Boolean).join('，')
    case 'make_cover':
      return str(args.summary) || str(args.prompt).slice(0, 40)
    case 'run_batch':
      return count(args.steps) ? `${count(args.steps)} 章` : ''
    case 'run_distillation':
      return [rangeOf(args), args.skillName ? `技能名「${str(args.skillName)}」` : ''].filter(Boolean).join('，')
    case 'read_breakdown': {
      const parts: string[] = []
      if (args.chapterNo != null) parts.push(`第 ${args.chapterNo} 章`)
      if (args.includeSource === true) parts.push('含原文')
      if (Number(args.catalogOffset || 0) > 0) parts.push(`目录第 ${Number(args.catalogOffset) + 1} 条起`)
      return parts.join('，')
    }
    case 'reparse_book_attachment':
      return HEADING_STYLES[str(args.headingStyle)] || str(args.headingStyle)
    case 'run_skill_script':
      return [`${str(args.skill)} / ${str(args.script)}`, Array.isArray(args.args) && args.args.length ? args.args.map(str).join(' ') : '']
        .filter(Boolean)
        .join('，')
    case 'control_task':
      return ACTIONS[str(args.action)] || str(args.action)
    case 'list_rankings':
    case 'read_rankings':
    case 'refresh_rankings':
      return args.date ? `${args.date} 的快照` : ''
    case 'save_draft':
    case 'save_new_chapter_draft':
    case 'save_outline_draft':
      return draftArgs(args)
    case 'save_skill_draft':
      return [str(args.name), args.replaceId ? `替换 ${str(args.replaceId)}` : ''].filter(Boolean).join('，')
    case 'save_creation_draft': {
      const fields = isRec(args.fields) ? args.fields : {}
      const entity = str(args.entity)
      return [entity ? entitySpecs[entity as PiEntityKind]?.label || entity : '', str(fields.title || fields.name)]
        .filter(Boolean)
        .join('，')
    }
  }
  // 其他工具只列简单字段；编号、会话和整段正文都不显示。
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (key === 'sessionId' || key === 'content' || key === 'fields' || ID_KEY.test(key) || value == null) continue
    if (typeof value === 'string' && value.trim()) parts.push(`${PLAIN_LABELS[key] || key} ${clip(value, 40)}`)
    else if (typeof value === 'number') parts.push(`${PLAIN_LABELS[key] || key} ${value}`)
    else if (typeof value === 'boolean') parts.push(`${PLAIN_LABELS[key] || key} ${value ? '是' : '否'}`)
  }
  return clip(parts.join('，'), 120)
}

const draftResult = (data: unknown) =>
  isRec(data)
    ? `候选《${str(data.title)}》${str(data.status) === '已采用' ? '已采用' : str(data.status).includes('换成') ? '已换成新稿，待采用' : '已生成，待采用'}`
    : ''
const rankResult = (data: unknown) => {
  if (Array.isArray(data)) return `${data.length} 个榜单源`
  if (isRec(data) && data.needsCategoryMapping) return '已提供平台分类表，等待匹配检索分类'
  if (isRec(data) && data.mode === 'explore') return `读取 ${count(data.samples)} 个本地榜单的分类样本`
  if (isRec(data) && Array.isArray(data.groups)) return `${Number(data.matchingSourceCount || 0)} 个相关榜单源`
  if (!isRec(data) || !isRec(data.source)) return ''
  const snapshot = isRec(data.snapshot) ? data.snapshot : null
  return `${str(data.source.name)}：${snapshot ? `${str(snapshot.statDate)} 快照，${count(snapshot.items)} 本` : '暂无快照'}`
}
const BY_TOOL: Record<string, (data: unknown) => string> = {
  control_session: data => isRec(data) && isRec(data.control) ? data.control.state === 'ended' ? '当前阶段已结束，已有内容保留' : '已暂停，等待作者继续' : '',
  list_books: data => (Array.isArray(data) ? `${data.length} 部作品` : ''),
  prepare_writing: data => isRec(data) && data.ready ? '写作条件已就绪' : '',
  read_platform_state: data => isRec(data) ? `${count(data.drafts)} 份候选、${count(data.tasks)} 项任务` : '',
  read_book: data => (isRec(data) ? `《${str(data.title)}》` : ''),
  list_chapters: data =>
    Array.isArray(data)
      ? `${data.length} 卷 ${data.reduce((n: number, volume) => n + count((volume as Rec).children), 0)} 章`
      : '',
  read_chapter: data => (isRec(data) ? `《${str(data.title)}》，${chars(data.content)} 字` : ''),
  read_references: data => {
    if (!isRec(data)) return ''
    const parts = Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => `${REFERENCE_LABELS[key] || key} ${(value as unknown[]).length}`)
    return parts.length ? parts.join('、') : '已读取作品资料'
  },
  list_drafts: data =>
    Array.isArray(data)
      ? data.length
        ? `${data.length} 份候选，${data.filter(item => (item as Rec).applied).length} 份已采用`
        : '没有候选'
      : '',
  save_draft: draftResult,
  save_new_chapter_draft: draftResult,
  save_outline_draft: draftResult,
  save_creation_draft: draftResult,
  save_skill_draft: draftResult,
  read_breakdown: data => {
    if (Array.isArray(data)) return `${data.length} 本参考书`
    if (!isRec(data)) return ''
    if (isRec(data.chapter) && isRec(data.task))
      return `《${str(data.task.title)}》第 ${str(data.chapter.sortNo)} 章的分析`
    if (data.taskId && data.statusText)
      return `《${str(data.title)}》${str(data.scope)}：${str(data.statusText)}，${str(data.done)}/${str(data.total)} 章`
    if (data.estimatedTokens != null) return `准备拆《${str(data.title)}》${str(data.scope)}，${count(data.chapters)} 章`
    if (data.projectTitle && data.sortNo != null) return `《${str(data.projectTitle)}》第 ${str(data.sortNo)} 章的分析`
    if (data.status === 'importing' && isRec(data.attachment))
      return `《${str(data.title)}》正在入库，目录 ${str(data.totalChapters)} 章`
    if (data.totalChapters != null)
      return `《${str(data.title)}》目录，共 ${str(data.totalChapters)} 章${
        count(data.tasks) ? `，已有 ${count(data.tasks)} 个拆书任务` : ''
      }`
    return ''
  },
  plan_chapters: data => (isRec(data) && count(data.planned) ? `写进目录 ${count(data.planned)} 章章纲` : ''),
  run_breakdown: data =>
    isRec(data) ? `已启动${data.title ? `《${str(data.title)}》` : ''}${str(data.scope)} 的拆书任务` : '',
  make_cover: data => (isRec(data) && data.taskId ? `已开始生成《${str(data.title)}》的封面` : isRec(data) && data.modelName ? `用 ${str(data.modelName)} 生成` : ''),
  run_batch: data => (isRec(data) && data.taskId ? `已启动《${str(data.title)}》${str(data.scope)} 的批量写作` : ''),
  run_distillation: data =>
    isRec(data) && data.taskId ? `已启动《${str(data.title)}》${str(data.scope)} 的蒸馏任务` : isRec(data) && data.estimatedTokens != null ? `准备蒸馏《${str(data.title)}》${str(data.scope)}，${count(data.chapters)} 章` : '',
  control_task: data => (isRec(data) ? `《${str(data.title)}》${str(data.scope)}：${str(data.statusText)}` : ''),
  run_skill_script: data => {
    if (!isRec(data)) return ''
    if (data.cancelled === true) return '脚本被停止'
    if (data.timedOut === true) return '脚本超时，已终止'
    const out = str(data.stdout).trim()
    return `退出码 ${data.exitCode ?? '未知'}${out ? `，输出 ${out.length} 字` : '，没有输出'}`
  },
  reparse_book_attachment: data =>
    isRec(data) && data.totalChapters != null ? `重新识别目录，共 ${str(data.totalChapters)} 章` : '',
  list_rankings: rankResult,
  read_rankings: rankResult,
  refresh_rankings: data => {
    if (!isRec(data)) return ''
    if (data.cancelled) return '已取消榜单刷新'
    if (data.current) return '本次范围已有当天数据，未重复抓取'
    if (data.refreshChoice === 'local') return '按作者选择使用现有本地资料'
    const results = Array.isArray(data.sources) ? data.sources : [data]
    return results.map(result => {
      if (!isRec(result)) return ''
      const state = result.reason === 'disabled' ? '抓取已关闭' : ['recent_cache', 'current_date'].includes(str(result.reason)) ? '沿用当前缓存' : result.crawled ? '已刷新' : '已读取'
      return state + '：' + rankResult(result)
    }).filter(Boolean).join('；')
  }
}
const textOf = (content: PiMessage['content']) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter(part => part.type === 'text')
        .map(part => part.text || '')
        .join('\n')
const looksJson = (text: string) => /^\s*[[{]/.test(text)
function parseJson(text: string): unknown {
  if (!looksJson(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function summarizeToolResult(tool: string | undefined, message: Pick<PiMessage, 'content' | 'isError'>) {
  const text = textOf(message.content)
  if (message.isError) return clip(text)
  if (tool === 'ask_author') return clip(text, 120)
  if (tool === 'read') return '已读取写作技能'
  const data = parseJson(text)
  if (isRec(data) && data.supersededByAuthorInput === true) return str(data.status)
  if (isRec(data) && data.draftSubmitted === false && data.message) return clip(str(data.message))
  const summary = data === undefined ? '' : BY_TOOL[tool || '']?.(data) || ''
  if (summary) return summary
  // 没有登记的结构化结果不截 JSON 给作者看。
  return looksJson(text) ? '' : clip(text)
}
