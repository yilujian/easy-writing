import {
  startBreakdown,
  prepareBreakdown,
  loadBreakdownTasks,
  controlBreakdown,
  claimWorkbenchBreakdown
} from './breakdown-tasks'
import {
  importLive,
  importProgressText,
  readBookAttachment,
  reparseChatBook,
  waitForChatImport,
  type BookAttachment,
  type HeadingStyle
} from './attachments'
import { readTaskChapter } from './breakdown-tasks'
import type { BreakdownPlan, BreakdownTask } from '@/types/breakdown-task'
import type { PiToolRequest } from '@/types/agent-pi'
import { changeRunControl } from './run-control'
import { controlTask as controlAnyTask, findTaskView } from './tasks'
import { prepareDistillation, startDistillation } from './distillation-tasks'
import { startBatch } from './batch-tasks'
import { compactSkillName, sessionSkill } from './skills'
import { DEFAULT_COVER_SIZE, startCover } from './cover-tasks'
import type { CoverBrief } from '@/types/cover-task'
import type { BatchPlan } from '@/types/batch-task'
import type { DistillationPlan } from '@/types/distillation-task'
import {
  getLocalBreakdownHistory,
  readLocalBreakdownProject,
  readLocalBreakdownContent
} from '@/storage/local-breakdown'

function integer(value: unknown) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || !n) throw new Error('目标编号无效')
  return n
}
export function selectBreakdownIds(
  chapters: Array<{ id: number; sortNo: number }>,
  args: Record<string, unknown>
): number[] {
  const ordered = [...chapters].sort((a, b) => a.sortNo - b.sortNo)
  if (
    (Array.isArray(args.chapterIds) &&
      (args.scope != null || args.fromChapter != null || args.toChapter != null)) ||
    (args.scope === 'all' && (args.fromChapter != null || args.toChapter != null))
  )
    throw new Error('范围表达冲突，请只选择全书、区间或章节列表中的一种')
  if (Array.isArray(args.chapterIds)) {
    const ids = args.chapterIds.map(integer)
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !ordered.some(c => c.id === id)))
      throw new Error('请选择存在且不重复的章节')
    return ids
  }
  if (args.scope === 'all') return ordered.map(c => c.id)
  const from = Number(args.fromChapter ?? 1),
    to = Number(args.toChapter)
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < from ||
    to > ordered.length
  )
    throw new Error('拆书范围不明确或超出目录，请先和作者确认')
  return ordered.slice(from - 1, to).map(c => c.id)
}
const taskView = (t: BreakdownTask) => ({
  taskId: t.id,
  projectId: t.projectId,
  title: t.title,
  scope: t.scope,
  status: t.status,
  statusText:
    (
      {
        running: '正在运行',
        pausing: '正在保存当前片段，完成后暂停',
        paused: '已暂停',
        failed: '未完成，可继续',
        cancelled: '已取消，已完成结果保留',
        completed: '已完成'
      } as Record<string, string>
    )[t.status] || '状态待核对',
  phase: t.phase,
  done: t.chapters.filter(c => c.done).length,
  total: t.chapters.length,
  error: t.error,
  report: t.report
})
function sourcePage(paragraphs: string[], args: Record<string, unknown>) {
  const from = Number(args.paragraphFrom ?? 1),
    offset = Number(args.characterOffset ?? 0)
  if (
    !Number.isSafeInteger(from) ||
    from < 1 ||
    from > paragraphs.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('原文位置无效')
  const result: Array<{ paragraph: number; offset: number; text: string }> = []
  let remaining = 10000
  for (let i = from - 1; i < paragraphs.length && result.length < 30; i++) {
    const start = i === from - 1 ? offset : 0,
      chars = Array.from(paragraphs[i])
    if (start >= chars.length && chars.length) throw new Error('原文字符位置超出该段')
    const count = Math.min(remaining, chars.length - start)
    result.push({ paragraph: i + 1, offset: start, text: chars.slice(start, start + count).join('') })
    remaining -= count
    if (start + count < chars.length)
      return { paragraphs: result, next: { paragraphFrom: i + 1, characterOffset: start + count } }
    if (!remaining || result.length === 30)
      return {
        paragraphs: result,
        next: i + 1 < paragraphs.length ? { paragraphFrom: i + 2, characterOffset: 0 } : null
      }
  }
  return { paragraphs: result, next: null }
}
/** 给模型看的附件信息：不带整份目录；入库中带当前进度。 */
function attachmentView(meta: BookAttachment) {
  const live = importLive.value[meta.id]
  return {
    id: meta.id,
    filename: meta.filename,
    title: meta.title,
    status: meta.status,
    ...(meta.error ? { error: meta.error } : {}),
    projectId: meta.projectId,
    chapterCount: meta.chapterCount,
    headingStyle: meta.headingStyle,
    notes: meta.notes,
    ...(live ? { progress: importProgressText(live) } : {})
  }
}
/** 入库还没完成时，用上传时识别出的目录回答；章号用 sortNo，还没有章节编号。 */
function importingCatalog(meta: BookAttachment, args: Record<string, unknown>) {
  const offset = Number(args.catalogOffset ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录位置无效')
  const chapters = meta.catalog?.chapters || []
  return {
    attachment: attachmentView(meta),
    status: 'importing',
    title: meta.title,
    chapters: chapters.slice(offset, offset + 100).map(c => ({ sortNo: c.no, title: c.title, wordCount: c.chars })),
    totalChapters: meta.chapterCount,
    nextCatalogOffset: offset + 100 < chapters.length ? offset + 100 : null,
    notes: meta.notes || [],
    tasks: [],
    message:
      '附件正在后台入库，这是上传时识别出的目录，还没有章节编号和分析。可以先和作者确认范围；run_breakdown 会等入库完成后再确认并启动。'
  }
}
export async function readBreakdown(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: (text: string) => void
): Promise<unknown> {
  if (args.attachmentId) {
    const id = String(args.attachmentId),
      sessionId = String(args.sessionId)
    let attachment = await readBookAttachment(id, sessionId)
    if (attachment.status === 'failed')
      throw new Error(`附件入库失败：${attachment.error || '原因未知'}。请作者重新上传文件。`)
    if (attachment.status !== 'ready') {
      if (args.prepare !== true) return importingCatalog(attachment, args)
      attachment = await waitForChatImport(id, sessionId, signal, progress)
    }
    const inner = await readBreakdown({ ...args, attachmentId: undefined, projectId: attachment.projectId }, signal, progress)
    // 预览方案时返回的就是方案本身：宿主建任务要拿它和重新算的方案逐字段比对，多一个 attachment 字段就会被当成"内容已改变"。
    if (args.prepare === true) return inner
    return { attachment: attachmentView(attachment), ...(inner as object) }
  }
  if (args.taskId) {
    const task = (await loadBreakdownTasks()).find(t => t.id === args.taskId)
    if (!task) throw new Error('拆书任务不存在')
    if (args.chapterId || args.chapterNo) {
      const c = task.chapters.find(c =>
        args.chapterId ? c.id === integer(args.chapterId) : c.sortNo === Number(args.chapterNo)
      )
      if (!c) throw new Error('该章节不在任务范围内')
      const data = await readTaskChapter(task.id, c.id)
      return {
        task: taskView(task),
        chapter: { id: c.id, title: c.title, sortNo: c.sortNo, done: c.done },
        analysis: data.saved.result,
        sourceChanged: data.sourceChanged,
        ...(args.includeSource ? sourcePage(data.content.paragraphs, args) : {})
      }
    }
    return taskView(task)
  }
  if (!args.projectId) return (await getLocalBreakdownHistory()).data
  const project = await readLocalBreakdownProject(integer(args.projectId))
  if (!project || project.visibility === 'conversation')
    throw new Error('参考书尚未导入，请在聊天中附加 TXT 文件')
  if (args.prepare === true || Array.isArray(args.chapterIds))
    return prepareBreakdown(project.id, selectBreakdownIds(project.chapters, args), args.reanalyze === true)
  if (args.chapterId || args.chapterNo) {
    const chapter = project.chapters.find(c =>
      args.chapterId ? c.id === integer(args.chapterId) : c.sortNo === Number(args.chapterNo)
    )
    if (!chapter) throw new Error('章节不属于所选参考书')
    const content = await readLocalBreakdownContent(chapter.id)
    return {
      projectId: project.id,
      projectTitle: project.title,
      ...chapter,
      analysis: content?.analysis || null,
      ...(args.includeSource && content ? sourcePage(content.paragraphs, args) : {})
    }
  }
  const offset = Number(args.catalogOffset ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录位置无效')
  const chapters = [...project.chapters].sort((a, b) => a.sortNo - b.sortNo)
  return {
    id: project.id,
    title: project.title,
    chapters: chapters.slice(offset, offset + 100),
    totalChapters: chapters.length,
    nextCatalogOffset: offset + 100 < chapters.length ? offset + 100 : null,
    report: project.report,
    progress: project.progress,
    notes: (project as unknown as { importNotes?: string[] }).importNotes || [],
    tasks: (await loadBreakdownTasks())
      .filter(t => t.projectId === project.id)
      .map(t => {
        const view = taskView(t)
        return { ...view, report: undefined }
      })
  }
}
export async function reparseBookAttachment(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: (text: string) => void
) {
  const meta = await reparseChatBook(
    String(args.attachmentId),
    String(args.sessionId),
    String(args.headingStyle) as HeadingStyle,
    signal,
    progress
  )
  return {
    attachment: attachmentView(meta),
    ...((await readBreakdown({ projectId: meta.projectId })) as object),
    message: '目录已重新识别，尚未启动分析；已有任务和结果仍保留原范围。请在对话中核对新目录。'
  }
}
export async function runBreakdown(request: PiToolRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const plan = request.args.confirmedTarget as unknown as BreakdownPlan
  if (!plan?.chapters?.length || plan.projectId !== integer(request.args.projectId))
    throw new Error('缺少已确认的拆书范围')
  const ids = ((request.args.chapterIds as unknown[]) || []).map(integer)
  if (
    ids.length !== plan.chapters.length ||
    new Set(ids).size !== ids.length ||
    plan.chapters.some(c => !ids.includes(c.id))
  )
    throw new Error('执行范围与确认不一致')
  const task = await startBreakdown(
    plan,
    String(request.args.modelCode || ''),
    {
      sessionId: String(request.args.sessionId || ''),
      callId: request.callId
    },
    request.id
  )
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    scope: task.scope,
    message:
      '任务已启动，尚未全部完成。可以在对话中暂停、继续、取消和查看结果；用 read_breakdown 的 taskId 查询状态。'
  }
}
/** 蒸馏文风档案：prepare 时按范围出方案（附件还在入库就先等），确认后按方案启动任务。 */
export async function runDistillation(request: PiToolRequest, signal?: AbortSignal, progress?: (text: string) => void) {
  signal?.throwIfAborted()
  const args = request.args
  if (args.prepare === true) {
    let projectId = args.projectId != null && args.projectId !== '' ? integer(args.projectId) : null
    if (args.attachmentId) {
      const meta = await waitForChatImport(String(args.attachmentId), String(args.sessionId), signal, progress)
      projectId = meta.projectId
    }
    if (projectId == null) throw new Error('请提供 attachmentId 或 projectId')
    const project = await readLocalBreakdownProject(projectId)
    if (!project || project.visibility === 'conversation') throw new Error('参考书尚未导入，请在聊天中附加 TXT 文件')
    const calibration = args.calibration == null ? undefined : Number(args.calibration)
    if (calibration !== undefined && (!Number.isInteger(calibration) || calibration < 0 || calibration > 5))
      throw Error('校对章数应为 0 至 5 的整数')
    const plan = await prepareDistillation(project.id, selectBreakdownIds(project.chapters, args), calibration)
    const name = compactSkillName(String(args.skillName || ''))
    return name ? { ...plan, skillName: name.slice(0, 60) } : plan
  }
  const plan = args.confirmedTarget as unknown as DistillationPlan
  if (!plan?.chapters?.length || !Number.isSafeInteger(plan.projectId)) throw new Error('缺少已确认的蒸馏范围')
  const task = await startDistillation(
    plan,
    String(args.modelCode || ''),
    { sessionId: String(args.sessionId || ''), callId: request.callId, autoContinue: args.autoContinue === true },
    request.id
  )
  return {
    taskId: task.id,
    kind: 'distillation',
    title: task.title,
    scope: task.scope,
    skillName: task.skillName,
    status: task.status,
    message: '蒸馏任务已启动，尚未完成；完成后作者可以打开技能。用 control_task 暂停、继续或取消。'
  }
}
/** 批量写作：作者确认过每章目标后启动；第一章由工作台在本轮结束后发出。 */
export async function runBatch(request: PiToolRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const { args, book } = request
  if (!book?.id) throw new Error('批量写作需要先绑定作品')
  const confirmed = args.confirmedTarget as { steps?: Array<{ goal?: unknown }>; scope?: unknown } | undefined
  const steps = (confirmed?.steps || []).map((s, index) => ({ index, goal: String(s.goal || '').trim() })).filter(s => s.goal)
  if (!steps.length) throw new Error('缺少作者确认的每章目标')
  if (steps.length > 20) throw new Error('一次最多连写 20 章')
  const styleSkill = sessionSkill(String(args.sessionId || ''))
  const plan: BatchPlan = {
    bookId: String(book.id),
    bookTitle: String(book.title || ''),
    scope: String(confirmed?.scope || `接下来 ${steps.length} 章`),
    steps,
    ...(styleSkill ? { styleSkill } : {})
  }
  const task = await startBatch(plan, String(args.modelCode || ''), { sessionId: String(args.sessionId || ''), callId: request.callId }, request.id)
  return {
    taskId: task.id,
    kind: 'batch',
    title: task.bookTitle,
    scope: task.scope,
    total: task.steps.length,
    status: task.status,
    message: '批量写作已启动：本轮结束后平台会发"写第 1 章"的事件，你到时按事件写。现在不要开始写，用一句话告诉作者已经开始并结束本轮。'
  }
}
/** 封面：prepare 时告诉扩展用哪个图片模型；确认后按简报启动生成任务。 */
export async function makeCover(request: PiToolRequest, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const { args, book } = request
  if (!book?.id) throw new Error('生成封面需要先绑定作品')
  const { useAiModelStore } = await import('@/stores/ai-model')
  const models = useAiModelStore()
  if (!models.imageModels.length) await models.loadImageModels()
  const code = models.imageModel || models.imageModels[0]?.code || ''
  if (!code) throw new Error('还没有可用的生图模型：请先到「模型管理」添加并启用一个图片模型')
  const name = models.imageModels.find(m => m.code === code)?.name || code
  if (args.prepare === true) return { modelCode: code, modelName: name, size: DEFAULT_COVER_SIZE, bookTitle: String(book.title || '') }
  const confirmed = args.confirmedTarget as Partial<CoverBrief> | undefined
  const brief: CoverBrief = {
    prompt: String(confirmed?.prompt || '').trim(),
    negativePrompt: String(confirmed?.negativePrompt || '').trim(),
    style: String(confirmed?.style || '').trim(),
    size: String(confirmed?.size || DEFAULT_COVER_SIZE).trim(),
    summary: String(confirmed?.summary || '').trim()
  }
  if (!brief.prompt) throw new Error('缺少作者确认的封面简报')
  const task = await startCover(brief, { id: String(book.id), title: String(book.title || '') }, { code, name }, { sessionId: String(args.sessionId || ''), callId: request.callId }, request.id)
  return {
    taskId: task.id,
    kind: 'cover',
    title: task.bookTitle,
    status: task.status,
    message: '封面正在生成，通常半分钟到一分钟；生成后平台会告诉你，作者在右侧预览并采用。现在用一句话说明已开始并结束本轮。'
  }
}
/** 暂停、继续、取消本会话的任务：拆书走自己的记录（旧工作台任务首次控制后归入本会话），其他种类走通用任务层。 */
export async function controlTaskTool(args: Record<string, unknown>) {
  const action = String(args.action)
  if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('任务操作无效')
  const id = String(args.taskId || '')
  let task = (await loadBreakdownTasks()).find(t => t.id === id)
  if (task?.sessionId === 'workbench' && typeof args.sessionId === 'string' && args.sessionId)
    task = await claimWorkbenchBreakdown(task.id, args.sessionId)
  if (task) {
    if (task.sessionId !== args.sessionId) throw new Error('只能控制本会话发起的任务，请指定本会话的任务编号')
    if (action === 'resume' && task.sessionId !== 'workbench') await changeRunControl(task.sessionId, 'release_task', { task: { kind: 'breakdown', id: task.id } })
    return taskView(await controlBreakdown(task.id, action as 'pause' | 'resume' | 'cancel'))
  }
  const view = findTaskView(id)
  if (!view || view.sessionId !== args.sessionId) throw new Error('只能控制本会话发起的任务，请指定本会话的任务编号')
  await controlAnyTask(view.kind, view.id, action as 'pause' | 'resume' | 'cancel')
  const after = findTaskView(id) || view
  return { taskId: after.id, kind: after.kind, title: after.title, scope: after.scope, status: after.status, statusText: after.statusLabel }
}
