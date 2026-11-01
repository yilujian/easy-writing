import type { JsonRecord } from '@/types/json'
import type {
  WorkflowChapterRewriteMode,
  WorkflowChapterRewriteSubmitResult,
  WorkflowGenerateBookResult,
  WorkflowReviewAction,
  WorkflowTask,
} from '@/types/workflow'
import { buildParagraphPolishMessages, buildPlotOutlineMessages } from '@/config/workflow-prompts'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { createLocalEntityId, nowIso, LOCAL_USER_ID } from '@/storage/local-library-utils'
import {
  readLocalWorkflowRun,
  completeWorkflowAiDraft,
  readRepairedLocalTask,
  writeLocalWorkflowRun,
  writeLocalWorkflowTask,
  type LocalWorkflowRun,
} from '@/storage/local-workflow'
import { parseWorkflowJson, requestWorkflowAi, WorkflowAiError } from '@/utils/workflow-ai'
import { getWritingStorage } from '@/storage'
import { workflowResumeText } from '@/utils/workflow-local-draft'
import { countWords } from '@/utils/word-count'
import { createLocalBookFromRun } from '@/utils/local-workflow-book'
import {
  buildLocalWorkflowEvent,
  emitLocalWorkflowEvent,
  findLiveLocalTaskForRun,
  getLiveLocalTask,
  registerLiveLocalTask,
  unregisterLiveLocalTask,
} from '@/utils/local-workflow-runtime'
import {
  launchLocalBookWriter,
  launchLocalChapterRewrite,
  readChapterText,
  resolveWorkflowModelCode,
  countRemainingChapters,
  saveGeneratedChapterContent,
} from '@/utils/local-workflow-writer'

/**
 * 逐章自动生文的任务控制面（页面直接消费的本地接口层）。
 *
 * 职责：建书并起任务、暂停/恢复/停止、质检确认（接受/重写）、剧情章纲确认、
 * 单章重写候选（发起/应用/丢弃）、段落定向润色。生成本身在 local-workflow-writer
 * 的后台循环里跑，这里只做状态迁移、互斥守卫和收尾清理。
 */

const asText = (value: unknown) => String(value ?? '').trim()

/** 生成任务尚未终结的状态：这些状态下不允许再起新任务 */
const BUSY_STATUSES = new Set(['queued', 'running', 'review_required', 'paused'])

const readTaskOrThrow = async (taskId: number) => {
  const task = await readRepairedLocalTask(Number(taskId))
  if (!task) throw new Error('生成任务不存在')
  return task
}

const readRunOrThrow = async (runId: number) => {
  const run = await readLocalWorkflowRun(runId)
  if (!run) throw new Error('工作流不存在')
  return run
}

/** 待确认章的收尾：把章上的待确认标记清掉（接受→完成；停止→交还人工） */
const clearReviewChapterStatus = async (task: WorkflowTask, next: string | null) => {
  const chapterId = Number(
    task.payload?.qualityReview?.chapterId || task.currentChapterId || 0
  )
  if (!chapterId) return
  await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: next })
}

/** 模型请求也登记到任务控制器，停止后不能再出现迟到的剧情候选。 */
const withModelTask = async <T,>(
  task: WorkflowTask,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  if (findLiveLocalTaskForRun(Number(task.runId))) throw new Error('该工作流已有生成任务在运行')
  const controller = new AbortController()
  registerLiveLocalTask({
    taskId: task.id,
    runId: Number(task.runId),
    kind: 'rewrite',
    requestCancel: () => controller.abort()
  })
  try {
    const result = await action(controller.signal)
    if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
    return result
  } catch (error) {
    const canceled = controller.signal.aborted
    await writeLocalWorkflowTask({
      ...task,
      status: canceled ? 'canceled' : 'failed',
      canCancel: false,
      errorMessage: canceled ? null : error instanceof Error ? error.message : '生成失败，草稿已保留',
      errorCode: error instanceof WorkflowAiError ? error.code : canceled ? 'CANCELED' : 'UNKNOWN'
    })
    throw error
  } finally {
    unregisterLiveLocalTask(task.id)
  }
}

// ---------------------------------------------------------------------------
// 建书 + 起任务
// ---------------------------------------------------------------------------

export const generateLocalWorkflowBook = async (data: {
  runId: number
}): Promise<{ data: WorkflowGenerateBookResult }> => {
  const run = await readRunOrThrow(data.runId)

  // 书级互斥：本 run 已有没跑完的任务时不再起新任务，把活任务交回页面
  const existing = run.latestBookTaskId
    ? await readRepairedLocalTask(Number(run.latestBookTaskId))
    : null
  if (
    findLiveLocalTaskForRun(Number(run.id)) ||
    (existing && BUSY_STATUSES.has(String(existing.status || '')))
  ) {
    return {
      data: {
        conflict: true,
        message: '当前工作流已有生成任务在进行，可进入作品继续或先停止',
        activeTask: { ...(existing as WorkflowTask), title: run.title },
      },
    }
  }

  if (!run.bookId) {
    await createLocalBookFromRun(run)
  }
  const bookId = Number(run.bookId)
  const tree = await getLocalLibraryStorage().getLocalBookTree(String(bookId))
  const chapters = tree.flatMap(volume => volume.children)
  const pending = chapters.filter(chapter => chapter.workflowStatus === 'incomplete').length
  const firstVolumeMode = asText(tree[0]?.planMeta?.chapterCountMode) === 'fixed' ? 'fixed' : 'dynamic'
  const book = await getLocalLibraryStorage().getLocalBookDetail(bookId)

  const task: WorkflowTask = {
    id: createLocalEntityId(),
    runId: Number(run.id),
    bookId,
    bizType: 'book_generate',
    status: 'queued',
    progress: 0,
    generatedWords: 0,
    totalGeneratedWords: Number(book?.wordCount || 0),
    finishedChapters: chapters.length - pending,
    totalChapters: chapters.length,
    chapterPlanningMode: firstVolumeMode,
    canPause: true,
    canResume: false,
    canCancel: true,
    startedAt: nowIso(),
    payload: {},
    checkpoint: null,
  }
  await writeLocalWorkflowTask(task)
  run.activeTaskId = Number(task.id)
  run.latestBookTaskId = Number(task.id)
  run.status = 'generating'
  run.updateTime = nowIso()
  await writeLocalWorkflowRun(run)
  launchLocalBookWriter(task)
  return { data: task }
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复 / 停止
// ---------------------------------------------------------------------------

export const pauseLocalWorkflowTask = async (data: { taskId: number }) => {
  const task = await readTaskOrThrow(data.taskId)
  const live = getLiveLocalTask(Number(data.taskId))
  if (live?.requestPause && ['queued', 'running'].includes(String(task.status))) {
    live.requestPause()
    const snapshot = { ...task, requestedAction: 'pause' as const }
    // 活任务自行保存终态，避免这个旧快照在取消完成后覆盖终态。
    return { data: snapshot }
  }
  return { data: task }
}

export const resumeLocalWorkflowTask = async (data: { taskId: number }) => {
  const task = await readTaskOrThrow(data.taskId)
  if (!['paused', 'interrupted', 'failed'].includes(String(task.status))) {
    return { data: task }
  }
  if (findLiveLocalTaskForRun(Number(task.runId))) {
    throw new Error('该工作流已有生成任务在运行')
  }
  // 恢复前重读本地稿。暂停期间的修改（含清空）必须替换旧断点。
  const checkpoint = task.checkpoint
  if (checkpoint?.chapterId) {
    const chapterId = Number(checkpoint.chapterId)
    const draft = await getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, String(task.bookId), chapterId)
    const text = workflowResumeText(draft, String(checkpoint.contentText || ''))
    const words = countWords(text)
    task.checkpoint = {
      ...checkpoint,
      contentText: text,
      payload: { ...(checkpoint.payload || {}), seq: Number(checkpoint.payload?.seq || 0) + 1 },
    }
    task.totalGeneratedWords = Math.max(0, Number(task.totalGeneratedWords || 0) - Number(task.generatedWords || 0)) + words
    task.generatedWords = words
  }
  const next: WorkflowTask = {
    ...task,
    status: 'queued',
    requestedAction: null,
    errorMessage: null,
    canPause: true,
    canResume: false,
    canCancel: true,
  }
  await writeLocalWorkflowTask(next)
  const run = await readRunOrThrow(Number(task.runId))
  run.activeTaskId = Number(task.id)
  run.status = 'generating'
  await writeLocalWorkflowRun(run)
  launchLocalBookWriter(next)
  return { data: next }
}

export const cancelLocalWorkflowTask = async (data: { taskId: number }) => {
  const task = await readTaskOrThrow(data.taskId)
  const live = getLiveLocalTask(Number(data.taskId))
  if (live) {
    live.requestCancel()
    const snapshot = { ...task, requestedAction: 'cancel' as const }
    // 活任务自行保存终态，避免这个旧快照在取消完成后覆盖终态。
    return { data: snapshot }
  }
  if (['canceled', 'succeeded'].includes(String(task.status))) return { data: task }
  // 停驻中的任务（paused/interrupted/failed/review_required）：直接终结并保留内容；
  // 待确认章交还人工编辑，不能让"待确认"角标跟着已终结的任务留一辈子
  if (task.payload?.qualityReview || task.payload?.plotOutlineReview) {
    await clearReviewChapterStatus(task, null)
  }
  const next: WorkflowTask = {
    ...task,
    status: 'canceled',
    remainingChapters: await countRemainingChapters(String(task.bookId)),
    requestedAction: null,
    canPause: false,
    canResume: false,
    canCancel: false,
    finishedAt: nowIso(),
  }
  await writeLocalWorkflowTask(next)
  const run = await readLocalWorkflowRun(Number(task.runId))
  if (run) {
    if (Number(run.activeTaskId || 0) === Number(task.id)) run.activeTaskId = null
    run.status = 'canceled'
    await writeLocalWorkflowRun(run)
  }
  return { data: next }
}

// ---------------------------------------------------------------------------
// 质检确认（接受 / 重写）与剧情章纲确认
// ---------------------------------------------------------------------------

export const reviewLocalWorkflowTask = async (data: {
  taskId: number
  action: WorkflowReviewAction
  contentVersion: number
  feedback?: string
  feedbackToRules?: boolean
  rewriteMode?: WorkflowChapterRewriteMode
}) => {
  const task = await readTaskOrThrow(data.taskId)
  if (String(task.status) !== 'review_required' || !task.payload?.qualityReview) {
    throw new Error('当前没有等待确认的章节')
  }
  const run = await readRunOrThrow(Number(task.runId))
  const review = task.payload.qualityReview
  const chapterId = Number(review.chapterId || 0)
  const feedback = asText(data.feedback)

  // 把补充要求沉淀为写作规则（以后每章遵守）
  if (feedback && data.feedbackToRules) {
    const rules = [asText(run.config?.writingRules), feedback].filter(Boolean).join('\n')
    run.config = { ...(run.config || {}), writingRules: rules }
    await writeLocalWorkflowRun(run)
  }

  if (data.action === 'accept') {
    await clearReviewChapterStatus(task, null)
    const finished = Number(task.finishedChapters || 0) + 1
    const next: WorkflowTask = {
      ...task,
      status: 'queued',
      finishedChapters: finished,
      progress: Math.min(99, Math.round((finished / Math.max(Number(task.totalChapters || 1), 1)) * 100)),
      canReview: false,
      canPause: true,
      canCancel: true,
      payload: { ...(task.payload || {}), qualityReview: null, qualitySuggestions: review, rewriteDirective: null },
    }
    await writeLocalWorkflowTask(next)
    run.activeTaskId = Number(task.id)
    await writeLocalWorkflowRun(run)
    emitLocalWorkflowEvent(
      buildLocalWorkflowEvent('review-resolved', Number(task.runId), Number(task.id), { message: '已接受本章，继续生成' })
    )
    launchLocalBookWriter(next)
    return { data: next }
  }

  // rewrite：剧情模式先出新章纲候选等确认；正文模式直接按意见整章重写
  if (data.rewriteMode === 'plot') {
    const modelCode = await resolveWorkflowModelCode(run)
    const stored = await readChapterText(String(run.bookId), chapterId)
    const raw = await withModelTask(task, signal => requestWorkflowAi({
      runId: Number(run.id),
      key: `plot:${chapterId}`,
      requiredKeys: ['title', 'summary'],
      signal,
      scene: 'workflow_plot_adjust',
      sceneLabel: '建书·剧情调整',
      modelCode,
      messages: buildPlotOutlineMessages({
        materials: {
          '本章原章纲': `《${review.chapterTitle}》`,
          '本章原正文（节选）': stored.text.slice(0, 2000),
          '用户要求': feedback || '换一个更有张力的剧情走向',
        },
      }),
    }))
    const parsed = parseWorkflowJson(raw, ['title', 'summary'])
    const title = asText(parsed?.title)
    const summary = asText(parsed?.summary)
    if (!title || !summary) throw new Error('新章纲生成失败，请重试')
    const next: WorkflowTask = {
      ...task,
      payload: {
        ...(task.payload || {}),
        qualityReview: null,
        plotOutlineReview: {
          chapterId,
          chapterTitle: title,
          chapterSummary: summary,
          contentVersion: Number(review.contentVersion || data.contentVersion || 0),
          originalQualityReview: review,
        },
      },
    }
    await writeLocalWorkflowTask(next)
    await completeWorkflowAiDraft(Number(run.id), `plot:${chapterId}`)
    return { data: next }
  }

  const stored = await readChapterText(String(run.bookId), chapterId)
  const next: WorkflowTask = {
    ...task,
    status: 'queued',
    canReview: false,
    canPause: true,
    canCancel: true,
    checkpoint: null,
    payload: {
      ...(task.payload || {}),
      qualityReview: null,
      rewriteDirective: { chapterId, instruction: feedback, baseText: stored.text },
    },
  }
  await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: 'incomplete' })
  await writeLocalWorkflowTask(next)
  run.activeTaskId = Number(task.id)
  await writeLocalWorkflowRun(run)
  emitLocalWorkflowEvent(
    buildLocalWorkflowEvent('review-resolved', Number(task.runId), Number(task.id), { message: '正在按要求重写本章' })
  )
  launchLocalBookWriter(next)
  return { data: next }
}

export const confirmLocalPlotRewriteOutline = async (data: {
  taskId: number
  action: 'accept' | 'discard'
  contentVersion?: number
}) => {
  const task = await readTaskOrThrow(data.taskId)
  const outlineReview = task.payload?.plotOutlineReview as JsonRecord | undefined
  if (!outlineReview) throw new Error('当前没有等待确认的新章纲')
  const chapterId = Number(outlineReview.chapterId || task.currentChapterId || 0)

  if (data.action === 'discard') {
    const next: WorkflowTask = {
      ...task,
      payload: {
        ...(task.payload || {}),
        plotOutlineReview: null,
        // 回到丢弃前的状态：整书任务回到质检确认；单章重写任务直接终结
        qualityReview: outlineReview.originalQualityReview || null,
      },
    }
    if (String(task.bizType) === 'chapter_rewrite') {
      next.status = 'canceled'
      next.finishedAt = nowIso()
      await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: null })
    }
    await writeLocalWorkflowTask(next)
    return { data: next }
  }

  // accept：新章纲落到章节上（细纲作废重扩），重新生成本章正文
  const run = await readRunOrThrow(Number(task.runId))
  const title = asText(outlineReview.chapterTitle)
  const summary = asText(outlineReview.chapterSummary)
  const chapter = await getLocalLibraryStorage().getLocalChapterById(chapterId)
  await getLocalLibraryStorage().updateLocalChapter({
    id: chapterId,
    title,
    summary,
    workflowStatus: 'incomplete',
    planMeta: {
      ...(chapter?.planMeta || {}),
      source: { title, summary },
      expandedOutline: null,
      outlineSource: 'volume_ai',
    },
  })
  const next: WorkflowTask = {
    ...task,
    status: 'queued',
    currentChapterTitle: title,
    canPause: true,
    canCancel: true,
    checkpoint: null,
    payload: { ...(task.payload || {}), plotOutlineReview: null, qualityReview: null, rewriteDirective: null },
  }
  await writeLocalWorkflowTask(next)
  if (String(task.bizType) === 'chapter_rewrite') {
    launchLocalChapterRewrite(next, { instruction: asText(outlineReview.instruction) })
  } else {
    run.activeTaskId = Number(task.id)
    await writeLocalWorkflowRun(run)
    launchLocalBookWriter(next)
  }
  return { data: next }
}

// ---------------------------------------------------------------------------
// 单章重写候选（写作台重写面板）
// ---------------------------------------------------------------------------

const resolveRunByChapter = async (chapterId: number) => {
  const chapter = await getLocalLibraryStorage().getLocalChapterById(chapterId)
  if (!chapter) throw new Error('章节不存在或已删除')
  const book = await getLocalLibraryStorage().getLocalBookDetail(chapter.bookId)
  if (!book) throw new Error('书籍不存在')
  const instruction = book.globalInstruction
  let parsed: unknown = instruction || {}
  if (typeof instruction === 'string') {
    try {
      parsed = JSON.parse(instruction || '{}')
    } catch {
      parsed = {} // 字段被写坏时按"非工作流作品"走可读报错，不抛裸 SyntaxError
    }
  }
  const runId = Number((parsed as Record<string, unknown>).workflowRunId || 0)
  if (!runId) throw new Error('本书不是工作流作品，无法发起单章重写')
  const run = await readRunOrThrow(runId)
  return { chapter, book, run }
}

export const rewriteLocalWorkflowChapter = async (data: {
  chapterId: number
  mode: WorkflowChapterRewriteMode
  instruction?: string
  addToRules?: boolean
}): Promise<{ data: WorkflowChapterRewriteSubmitResult }> => {
  const { chapter, run } = await resolveRunByChapter(Number(data.chapterId))
  const activeBook = run.latestBookTaskId
    ? await readRepairedLocalTask(Number(run.latestBookTaskId))
    : null
  if (
    findLiveLocalTaskForRun(Number(run.id)) ||
    (activeBook && ['queued', 'running', 'review_required'].includes(String(activeBook.status)))
  ) {
    throw new Error('本书有生成任务在进行，等它停下后再发起重写')
  }
  const instruction = asText(data.instruction)
  if (instruction && data.addToRules) {
    const rules = [asText(run.config?.writingRules), instruction].filter(Boolean).join('\n')
    run.config = { ...(run.config || {}), writingRules: rules }
    await writeLocalWorkflowRun(run)
  }
  const stored = await readChapterText(chapter.bookId, chapter.id)
  const task: WorkflowTask = {
    id: createLocalEntityId(),
    runId: Number(run.id),
    bookId: Number(run.bookId),
    bizType: 'chapter_rewrite',
    status: 'queued',
    progress: 0,
    currentChapterId: chapter.id,
    currentChapterTitle: chapter.title,
    chapterNo: Number(chapter.sortNo || 0),
    canPause: false,
    canResume: false,
    canCancel: true,
    startedAt: nowIso(),
    payload: {
      rewriteMode: data.mode,
      preRewrite: {
        title: stored.title || chapter.title,
        textContent: stored.text,
        contentJson: stored.contentJson,
        contentVersion: stored.contentVersion,
      },
    },
    checkpoint: null,
  }
  await writeLocalWorkflowTask(task)

  if (data.mode === 'plot') {
    // 剧情模式：先出新章纲候选，任务停在待确认；正文在用户确认后才动
    const modelCode = await resolveWorkflowModelCode(run)
    const raw = await withModelTask(task, signal => requestWorkflowAi({
      runId: Number(run.id),
      key: `plot:${chapter.id}`,
      requiredKeys: ['title', 'summary'],
      signal,
      scene: 'workflow_plot_adjust',
      sceneLabel: '建书·剧情调整',
      modelCode,
      messages: buildPlotOutlineMessages({
        materials: {
          '本章原章纲': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
          '本章原正文（节选）': stored.text.slice(0, 2000),
          '用户要求': instruction || '换一个更有张力的剧情走向',
        },
      }),
    }))
    const parsed = parseWorkflowJson(raw, ['title', 'summary'])
    const title = asText(parsed?.title)
    const summary = asText(parsed?.summary)
    if (!title || !summary) {
      const failed: WorkflowTask = { ...task, status: 'failed', errorMessage: '新章纲生成失败，请重试' }
      await writeLocalWorkflowTask(failed)
      return { data: failed }
    }
    const next: WorkflowTask = {
      ...task,
      status: 'review_required',
      payload: {
        ...(task.payload || {}),
        plotOutlineReview: {
          chapterId: chapter.id,
          chapterTitle: title,
          chapterSummary: summary,
          contentVersion: stored.contentVersion,
          instruction,
        },
      },
    }
    await writeLocalWorkflowTask(next)
    await completeWorkflowAiDraft(Number(run.id), `plot:${chapter.id}`)
    return { data: next }
  }

  launchLocalChapterRewrite(task, { instruction })
  return { data: task }
}

/** 应用重写候选（review accept 语义）：候选已在章节里，确认后终结任务 */
export const applyLocalWorkflowChapterRewrite = async (data: {
  taskId: number
  contentVersion: number
}) => {
  const task = await readTaskOrThrow(data.taskId)
  const chapterId = Number(task.currentChapterId || 0)
  await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: null })
  const next: WorkflowTask = {
    ...task,
    status: 'succeeded',
    canReview: false,
    canCancel: false,
    finishedAt: nowIso(),
    payload: { ...(task.payload || {}), qualityReview: null },
  }
  await writeLocalWorkflowTask(next)
  return { data: { applied: true, contentVersion: data.contentVersion } }
}

/** 丢弃重写候选：恢复重写前的正文与版本 */
export const discardLocalWorkflowChapterRewrite = async (data: {
  taskId: number
  contentVersion?: number
}) => {
  const task = await readTaskOrThrow(data.taskId)
  const chapterId = Number(task.currentChapterId || 0)
  const preRewrite = (task.payload as JsonRecord | undefined)?.preRewrite
  if (chapterId && preRewrite) {
    // 版本 +2：候选占了原版本 +1，恢复稿要比候选新，编辑器才会认为内容变了并重载
    await saveGeneratedChapterContent({
      bookId: String(task.bookId),
      chapterId,
      title: asText(preRewrite.title) || asText(task.currentChapterTitle),
      text: String(preRewrite.textContent || ''),
      contentVersion: Number(preRewrite.contentVersion || 0) + 2,
    })
    await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: null })
  }
  const next: WorkflowTask = {
    ...task,
    status: 'canceled',
    canCancel: false,
    finishedAt: nowIso(),
    payload: { ...(task.payload || {}), qualityReview: null },
  }
  await writeLocalWorkflowTask(next)
  return { data: { discarded: true, contentVersion: Number(preRewrite?.contentVersion || 0) + 2 } }
}

// ---------------------------------------------------------------------------
// 段落定向润色（确认面板"AI 修改此段"）
// ---------------------------------------------------------------------------

export const polishLocalWorkflowParagraph = async (data: {
  taskId: number
  chapterId: number
  issueKey: string
  paragraphText: string
  prevParagraph?: string
  nextParagraph?: string
  extraRequirement?: string
}) => {
  const task = await readRepairedLocalTask(Number(data.taskId))
  const run = task ? await readLocalWorkflowRun(Number(task.runId)) : null
  const modelCode = await resolveWorkflowModelCode((run || { config: null, summary: null }) as LocalWorkflowRun)
  // issueKey 形如 source:code:message，最后一段是问题描述
  const issueMessage = asText(String(data.issueKey || '').split(':').slice(2).join(':'))
  const issue = (task?.payload?.qualityReview?.issues || task?.payload?.qualitySuggestions?.issues || []).find(
    item => `${item.source}:${item.code}:${item.message}` === data.issueKey
  )
  const polished = await requestWorkflowAi({
    runId: Number(run?.id || task?.runId || 0),
    key: `polish:${data.chapterId}:${data.issueKey}`,
    format: 'text',
    scene: 'workflow_paragraph_polish',
    sceneLabel: '建书·段落润色',
    modelCode,
    messages: buildParagraphPolishMessages({
      materials: {
        '指出的问题': issue ? `${issue.message}${issue.fix ? `；修改建议：${issue.fix}` : ''}` : issueMessage,
        '上一段（只作上下文）': asText(data.prevParagraph),
        '目标段落': String(data.paragraphText || ''),
        '下一段（只作上下文）': asText(data.nextParagraph),
        '补充要求': asText(data.extraRequirement),
      },
    }),
  })
  const text = asText(polished)
  if (!text) throw new Error('润色结果为空，请重试')
  return {
    data: {
      taskId: Number(data.taskId),
      chapterId: Number(data.chapterId),
      issueKey: data.issueKey,
      original: String(data.paragraphText || ''),
      polished: text,
    },
  }
}
