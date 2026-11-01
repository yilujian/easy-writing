import { mutateDesktopRecord } from '@/storage/desktop-records'
import type { JsonRecord } from '@/types/json'
import type { BreakdownChapterDetail, BreakdownContinueResult } from '@/types/breakdown'
import { buildBookReportMessages, buildChapterBreakdownMessages } from '@/config/breakdown-prompts'
import {
  pickLocalBreakdownChapters,
  readLocalBreakdownContent,
  readLocalBreakdownProject,
  recalcLocalBreakdownProject,
  writeLocalBreakdownContent,
  writeLocalBreakdownProject,
  type LocalBreakdownProject,
} from '@/storage/local-breakdown'
import { useAiModelStore } from '@/stores/ai-model'
import { parseAiJson } from '@/utils/ai-json'
import { NO_MODEL_MESSAGE, requestLocalChatCompletion } from '@/utils/local-ai-client'
import { promptTemperature } from '@/storage/local-prompts'
import {
  registerLiveLocalTask,
  getLiveLocalTask,
  unregisterLiveLocalTask,
} from '@/utils/local-workflow-runtime'

/**
 * 竞品拆书引擎：逐章后台拆解 + 全书汇总报告。
 *
 * continue 提交即返回（章节先置 processing），页面照常 2-3 秒轮询列表/详情；
 * 每章一次结构化 JSON 调用，产物落章、段落按节点区间打高亮映射，
 * 人物关系名字滚动聚合进项目 characterNames（工作台"主要角色"数字的来源）。
 * 黄金三章（前三章）附加深拆产物。
 */

const GOLDEN_CHAPTER_LIMIT = 3
const CHAPTER_MAX_PROMPT_PARAGRAPHS = 400

const asText = (value: unknown) => String(value ?? '').trim()

const resolveBreakdownModel = async () => {
  const code = await useAiModelStore().ensureTextModel()
  if (!code) throw new Error(NO_MODEL_MESSAGE)
  return code
}

type OutlineCard = BreakdownChapterDetail['analysis']['outline'][number]

/** 把 AI 产物整形成工作台消费的 analysis + 段落高亮映射 */
export const normalizeChapterAnalysis = (
  parsed: JsonRecord,
  paragraphCount: number
): { analysis: BreakdownChapterDetail['analysis']; insightIds: Array<number | null> } => {
  const insightIds: Array<number | null> = Array.from({ length: paragraphCount }, () => null)
  const rawOutline = Array.isArray(parsed.outline) ? parsed.outline : []
  const outline: OutlineCard[] = []
  rawOutline.forEach((node: JsonRecord, index: number) => {
    const title = asText(node?.title)
    if (!title) return
    const id = index + 1
    const start = Math.max(1, Math.min(paragraphCount, Math.round(Number(node?.startPara || 0)) || 1))
    const end = Math.max(start, Math.min(paragraphCount, Math.round(Number(node?.endPara || 0)) || start))
    for (let paragraph = start; paragraph <= end; paragraph += 1) {
      if (insightIds[paragraph - 1] === null) insightIds[paragraph - 1] = id
    }
    outline.push({
      id,
      title,
      range: `${start}-${end}段`,
      text: asText(node?.text),
      tags: Array.isArray(node?.tags)
        ? node.tags
            .map((tag: JsonRecord) => ({ text: asText(tag?.text), tone: asText(tag?.tone) || undefined }))
            .filter((tag: { text: string }) => tag.text)
        : [],
    })
  })
  const mapDim = (list: unknown, fields: string[]) =>
    (Array.isArray(list) ? list : [])
      .map((item: JsonRecord) => Object.fromEntries(fields.map(field => [field, field === 'tags'
        ? (Array.isArray(item?.tags) ? item.tags.map(asText).filter(Boolean) : [])
        : asText(item?.[field])])))
      .filter((item: JsonRecord) => Object.values(item).some(value => (Array.isArray(value) ? value.length : value)))
  const analysis: BreakdownChapterDetail['analysis'] = {
    summary: asText(parsed.summary),
    outline,
    rhythm: mapDim(parsed.rhythm, ['label', 'value', 'desc']) as BreakdownChapterDetail['analysis']['rhythm'],
    setting: mapDim(parsed.setting, ['name', 'type', 'desc', 'tags']) as BreakdownChapterDetail['analysis']['setting'],
    relations: mapDim(parsed.relations, ['from', 'to', 'relation', 'desc']) as NonNullable<BreakdownChapterDetail['analysis']['relations']>,
  }
  const golden = parsed.golden
  if (golden && typeof golden === 'object') {
    analysis.golden = {
      hook300: asText(golden.hook300),
      characterEstablish: asText(golden.characterEstablish),
      coreDilemma: asText(golden.coreDilemma),
      anchors: Array.isArray(golden.anchors)
        ? golden.anchors
            .map((anchor: JsonRecord) => ({ quote: asText(anchor?.quote), comment: asText(anchor?.comment) }))
            .filter((anchor: { quote: string }) => anchor.quote)
        : [],
    }
  }
  return { analysis, insightIds }
}

const mergeCharacterNames = (project: LocalBreakdownProject, analysis: BreakdownChapterDetail['analysis']) => {
  const names = new Set(project.characterNames)
  for (const relation of analysis.relations || []) {
    if (relation.from) names.add(relation.from)
    if (relation.to) names.add(relation.to)
  }
  project.characterNames = [...names]
}

export interface BreakdownAnalysisResult { chapterId: number; expectedParagraphs: string[]; analysis: BreakdownChapterDetail['analysis']; paragraphInsightIds: Array<number | null> }
interface BreakdownOptions { signal?: AbortSignal; wait?: boolean; modelCode?: string; timeoutMs?: number; onProgress?: (text: string) => void; commitAnalysis?: (result: BreakdownAnalysisResult) => Promise<unknown> }
const analyzeOneChapter = async (project: LocalBreakdownProject, chapterId: number, modelCode: string, options: BreakdownOptions = {}) => {
  const { signal } = options
  signal?.throwIfAborted()
  const content = await readLocalBreakdownContent(chapterId)
  const item = project.chapters.find(chapter => chapter.id === chapterId)
  if (!content || !item) throw new Error('章节不存在')
  const paragraphs = content.paragraphs.slice(0, CHAPTER_MAX_PROMPT_PARAGRAPHS)
  const raw = await requestLocalChatCompletion({
    signal,
    timeoutMs: options.timeoutMs,
    scene: 'breakdown_chapter',
    sceneLabel: '拆书·单章拆解',
    modelCode,
    temperature: promptTemperature('breakdown', 'system'),
    messages: buildChapterBreakdownMessages({
      bookTitle: project.title,
      chapterTitle: item.title,
      chapterNo: item.sortNo,
      paragraphs,
      isGolden: item.sortNo <= GOLDEN_CHAPTER_LIMIT,
    }),
  })
  signal?.throwIfAborted()
  let parsed: JsonRecord | null = null
  try {
    parsed = parseAiJson(raw, ['summary', 'outline'])
  } catch {
    parsed = null
  }
  if (!parsed || (!asText(parsed.summary) && !Array.isArray(parsed.outline))) {
    throw new Error('拆解结果无法解析，请重试')
  }
  const { analysis, insightIds } = normalizeChapterAnalysis(parsed, content.paragraphs.length)
  signal?.throwIfAborted()
  if (options.commitAnalysis) {
    await options.commitAnalysis({ chapterId, expectedParagraphs: content.paragraphs, analysis, paragraphInsightIds: insightIds })
    return
  }
  signal?.throwIfAborted()
  await writeLocalBreakdownContent({ ...content, coverage: undefined, analysis, paragraphInsightIds: insightIds })
  mergeCharacterNames(project, analysis)
}

/** 发起拆解（替代 /breakdown/project/continue）：提交即返回，后台逐章执行 */
export const continueLocalBreakdown = async (data: {
  projectId: number
  count?: number
  chapterIds?: number[]
  async?: number
}, options: BreakdownOptions = {}) => {
  options.signal?.throwIfAborted()
  if (getLiveLocalTask(data.projectId)) throw new Error('该拆书项目已有任务正在执行')
  const project = await readLocalBreakdownProject(data.projectId)
  if (!project) throw new Error('拆书项目不存在')
  const picked = pickLocalBreakdownChapters(project, data)
  if (!picked.length) throw new Error('暂无待拆章节')
  // 提交前确认模型可用，报错发生在用户点击的当下而不是后台静默失败
  if (!options.modelCode) await resolveBreakdownModel()
  options.signal?.throwIfAborted()
  // 读取和模型校验之后再检查一次，防止两个入口同时启动同一项目。
  if (getLiveLocalTask(data.projectId)) throw new Error('该拆书项目已有任务正在执行')
  registerLiveLocalTask({ taskId: Number(project.id), runId: Number(project.id), kind: 'breakdown', requestCancel: () => undefined })
  // Pi 的状态更新合并到最新记录，不能用启动时快照复活已删除的项目/章节。
  const update = (change: (p: LocalBreakdownProject) => void) => mutateDesktopRecord('ew-local-breakdown/kv', `project:${project.id}`, value => {
    if (!value) throw new Error('拆书项目已删除')
    const current = value as LocalBreakdownProject
    change(current); recalcLocalBreakdownProject(current)
    return { value: current, result: undefined }
  })
  try {
    if (options.commitAnalysis) await update(current => {
      for (const item of picked) {
        const c = current.chapters.find(c => c.id === item.id)
        if (!c || !['wait', 'failed'].includes(c.status)) throw new Error('拆书章节状态已改变')
        c.status = 'processing'; c.errorMessage = undefined
      }
    })
    else {
      for (const item of picked) { item.status = 'processing'; item.errorMessage = undefined }
      recalcLocalBreakdownProject(project); await writeLocalBreakdownProject(project)
    }
  } catch (cause) { unregisterLiveLocalTask(Number(project.id)); throw cause }
  const work = (async () => {
    try {
      for (const [index, item] of picked.entries()) {
        options.signal?.throwIfAborted()
        options.onProgress?.(`拆解 ${index + 1}/${picked.length}：${item.title}`)
        const fresh = await readLocalBreakdownProject(data.projectId)
        if (!fresh) return
        const chapter = fresh.chapters.find(entry => entry.id === item.id)
        // 拆解途中章节被删掉：跳过即可
        if (!chapter || chapter.status !== 'processing') continue
        try {
          const modelCode = options.modelCode || await resolveBreakdownModel()
          await analyzeOneChapter(fresh, chapter.id, modelCode, options)
          if (options.commitAnalysis) continue
          chapter.status = 'done'
          chapter.errorMessage = undefined
        } catch (error) {
          options.signal?.throwIfAborted()
          chapter.status = 'failed'
          chapter.errorMessage = error instanceof Error ? error.message : '拆解失败，请重试'
        }
        if (options.commitAnalysis) await update(current => {
          const c = current.chapters.find(c => c.id === chapter.id)
          if (c?.status === 'processing') { c.status = chapter.status; c.errorMessage = chapter.errorMessage }
        })
        else { recalcLocalBreakdownProject(fresh); await writeLocalBreakdownProject(fresh) }
      }
    } finally {
      try {
        if (options.signal?.aborted) {
          const current = await readLocalBreakdownProject(project.id)
          if (current && options.commitAnalysis) await update(latest => {
            for (const item of latest.chapters) if (picked.some(p => p.id === item.id) && item.status === 'processing') { item.status = 'wait'; item.errorMessage = undefined }
          })
          else if (current) {
            for (const item of current.chapters) if (picked.some(p => p.id === item.id) && item.status === 'processing') {
              item.status = 'wait'; item.errorMessage = undefined
            }
            recalcLocalBreakdownProject(current)
            await writeLocalBreakdownProject(current)
          }
        }
      } finally { unregisterLiveLocalTask(Number(project.id)) }
    }
  })()
  if (options.wait) await work
  else void work.catch(error => console.error('拆书任务执行失败', error))

  const result: BreakdownContinueResult = {
    projectId: Number(project.id),
    chapterIds: picked.map(item => Number(item.id)),
    chapterCount: picked.length,
    words: picked.reduce((sum, item) => sum + Number(item.wordCount || 0), 0),
    cost: 0,
    async: true,
  }
  return { data: result }
}

/** 全书汇总报告（替代 /breakdown/project/report/generate）：聚合已拆各章产物 */
export const generateLocalBreakdownReport = async (data: { projectId: number }) => {
  const project = await readLocalBreakdownProject(data.projectId)
  if (!project) throw new Error('拆书项目不存在')
  const doneChapters = project.chapters
    .filter(item => item.status === 'done')
    .sort((a, b) => a.sortNo - b.sortNo)
  if (!doneChapters.length) throw new Error('还没有已拆解的章节，先拆解后再生成报告')
  const modelCode = await resolveBreakdownModel()

  const briefs: string[] = []
  for (const item of doneChapters) {
    const content = await readLocalBreakdownContent(item.id)
    const analysis = content?.analysis
    if (!analysis) continue
    briefs.push(
      [
        `第${item.sortNo}章《${item.title}》：${asText(analysis.summary)}`,
        analysis.rhythm?.length
          ? `节奏：${analysis.rhythm.map(entry => `${entry.label}${entry.value ? `(${entry.value})` : ''}`).join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join('；')
    )
  }
  const raw = await requestLocalChatCompletion({
    temperature: promptTemperature('breakdown', 'system'),
    scene: 'breakdown_report',
    sceneLabel: '拆书·全书报告',
    modelCode,
    messages: buildBookReportMessages({ bookTitle: project.title, chapterBriefs: briefs }),
  })
  let parsed: JsonRecord | null = null
  try {
    parsed = parseAiJson(raw, ['editorNotes', 'outlineRecovery'])
  } catch {
    parsed = null
  }
  if (!parsed) throw new Error('报告生成结果无法解析，请重试')
  project.report = parsed
  recalcLocalBreakdownProject(project)
  await writeLocalBreakdownProject(project)
  return { data: { report: parsed, cost: 0 } }
}
