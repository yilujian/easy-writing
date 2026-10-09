import { withRecordStore } from './desktop-records'
import type { JsonRecord } from '@/types/json'
import type {
  BreakdownChapterDetail,
  BreakdownChapterItem,
  BreakdownEstimateResult,
  BreakdownProjectDetail,
  BreakdownProjectSummary,
} from '@/types/breakdown'
import { createLocalEntityId, nowIso, parseLocalTxtBook } from './local-library-utils'
import { isLiveLocalTask } from '@/utils/local-workflow-runtime'
import { countWords } from '@/utils/word-count'

/**
 * 竞品拆书本地库：替代 /breakdown/* 全部服务端接口。
 *
 * - 项目 = 上传的 TXT 解析出的章节清单 + 各章拆解产物，全存 IndexedDB；
 * - 拆解由 local-breakdown-engine 在本进程后台跑，页面照常 2-3 秒轮询；
 *   应用中途关闭留下的 processing 章节，读取时孤儿修复成 failed（可重试）；
 * - 开源版无计费：billing/estimate 的积分字段一律为 0，页面文案已同步去积分；
 * - 经典案例库是服务端运营资产，本地为空清单；导出改为 Markdown 客户端生成。
 */

export interface LocalBreakdownChapterContent {
  projectId: number
  chapterId: number
  paragraphs: string[]
  analysis: BreakdownChapterDetail['analysis'] | null
  /** 段落 → 节点卡的高亮映射（与 analysis.outline 的 id 对应） */
  paragraphInsightIds: Array<number | null>
}

export interface LocalBreakdownProject extends BreakdownProjectSummary {
  chapters: BreakdownChapterItem[]
  report: JsonRecord | null
  /** 人物关系里出现过的名字（characterCount 的数据源） */
  characterNames: string[]
}

const DB_NAME = 'ew-local-breakdown'
const STORE_NAME = 'kv'

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

const projectKey = (id: number | string) => `project:${id}`
const contentKey = (chapterId: number | string) => `content:${chapterId}`

const readValue = async <T>(key: string): Promise<T | null> => {
  const stored = await withStore<unknown>('readonly', store => store.get(key))
  return (stored ?? null) as T | null
}

const writeValue = async (key: string, value: unknown) => {
  await withStore('readwrite', store => store.put(JSON.parse(JSON.stringify(value)), key))
}

const deleteKey = async (key: string) => {
  await withStore('readwrite', store => store.delete(key))
}

export const readLocalBreakdownProject = (id: number | string) =>
  readValue<LocalBreakdownProject>(projectKey(id))

export const writeLocalBreakdownProject = (project: LocalBreakdownProject) =>
  writeValue(projectKey(project.id), project)

export const readLocalBreakdownContent = (chapterId: number | string) =>
  readValue<LocalBreakdownChapterContent>(contentKey(chapterId))

export const writeLocalBreakdownContent = (content: LocalBreakdownChapterContent) =>
  writeValue(contentKey(content.chapterId), content)

// ---------------------------------------------------------------------------
// 项目状态口径
// ---------------------------------------------------------------------------

/** 按章节清单重算项目状态/进度/统计（所有写路径共用一个口径） */
export const recalcLocalBreakdownProject = (project: LocalBreakdownProject) => {
  const chapters = project.chapters
  const done = chapters.filter(item => item.status === 'done').length
  const processing = chapters.filter(item => item.status === 'processing').length
  const failed = chapters.filter(item => item.status === 'failed').length
  project.chapterCount = chapters.length
  project.progress = chapters.length ? Math.round((done / chapters.length) * 100) : 0
  // 有在跑的就是拆解中；全拆完是完成；有失败章报失败（可重试）；其余（含拆了一半停着）都算待拆
  project.status = processing > 0
    ? 'processing'
    : chapters.length > 0 && done === chapters.length
      ? 'done'
      : failed > 0
        ? 'failed'
        : 'wait'
  project.characterCount = project.characterNames.length
  project.updateTime = nowIso()
  return project
}

/** 孤儿修复：processing 章节但引擎里没有活循环 = 应用中途关闭，翻成可重试的 failed */
const repairOrphanProject = async (project: LocalBreakdownProject) => {
  if (isLiveLocalTask(Number(project.id))) return project
  let touched = false
  for (const chapter of project.chapters) {
    if (chapter.status !== 'processing') continue
    chapter.status = 'failed'
    chapter.errorMessage = '拆解在应用关闭时中断，可重试'
    touched = true
  }
  if (touched) {
    recalcLocalBreakdownProject(project)
    await writeLocalBreakdownProject(project)
  }
  return project
}

const toSummary = (project: LocalBreakdownProject): BreakdownProjectSummary => ({
  id: project.id,
  title: project.title,
  author: project.author,
  tags: project.tags,
  mood: project.mood,
  characterCount: project.characterCount,
  wordCount: project.wordCount,
  chapterCount: project.chapterCount,
  progress: project.progress,
  status: project.status,
  updateTime: project.updateTime,
  createTime: project.createTime,
})

// ---------------------------------------------------------------------------
// 项目生命周期
// ---------------------------------------------------------------------------

/** 上传 TXT 建项目：本地解析章节（替代 /breakdown/project/upload） */
export const createLocalBreakdownProject = async (file: File) => {
  const parsed = await parseLocalTxtBook(file)
  const chapters = parsed.volumes.flatMap(volume => volume.chapters)
  if (!chapters.length) throw new Error('没有解析出任何章节，请检查文件内容')

  const projectId = createLocalEntityId()
  const items: BreakdownChapterItem[] = []
  let totalWords = 0
  for (const [index, chapter] of chapters.entries()) {
    const chapterId = createLocalEntityId()
    const paragraphs = String(chapter.textContent || '')
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
    const words = countWords(chapter.textContent || '')
    totalWords += words
    items.push({
      id: chapterId,
      title: chapter.title || `第${index + 1}章`,
      status: 'wait',
      wordCount: words,
      sortNo: index + 1,
    })
    await writeLocalBreakdownContent({
      projectId,
      chapterId,
      paragraphs,
      analysis: null,
      paragraphInsightIds: paragraphs.map(() => null),
    })
  }

  const project: LocalBreakdownProject = {
    id: projectId,
    title: parsed.title || file.name.replace(/\.[^.]+$/, ''),
    author: '',
    tags: [],
    mood: '',
    characterCount: 0,
    wordCount: totalWords,
    chapterCount: items.length,
    progress: 0,
    status: 'wait',
    createTime: nowIso(),
    updateTime: nowIso(),
    chapters: items,
    report: null,
    characterNames: [],
  }
  await writeLocalBreakdownProject(project)
  return { data: toSummary(project) }
}

export const getLocalBreakdownHistory = async () => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  const projects: BreakdownProjectSummary[] = []
  for (const key of keys) {
    const text = String(key)
    if (!text.startsWith('project:')) continue
    const project = await readValue<LocalBreakdownProject>(text)
    if (project) projects.push(toSummary(await repairOrphanProject(project)))
  }
  projects.sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')))
  return { data: projects }
}

export const getLocalBreakdownDetail = async (id: number) => {
  const stored = await readLocalBreakdownProject(id)
  if (!stored) throw new Error('拆书项目不存在')
  const project = await repairOrphanProject(stored)
  const chapters = project.chapters
  const detail: BreakdownProjectDetail = {
    ...toSummary(project),
    billing: { pointRate: 0, tokenUnitChars: 4, tokenUnitSize: 1000 },
    statusSummary: {
      wait: chapters.filter(item => item.status === 'wait').length,
      processing: chapters.filter(item => item.status === 'processing').length,
      done: chapters.filter(item => item.status === 'done').length,
      failed: chapters.filter(item => item.status === 'failed').length,
      total: chapters.length,
    },
    canContinue: chapters.some(item => item.status === 'wait' || item.status === 'failed'),
    lastError: chapters.find(item => item.status === 'failed')?.errorMessage || '',
    report: project.report,
    reportPoints: 0,
    canGenerateReport: chapters.some(item => item.status === 'done'),
  }
  return { data: detail }
}

export const deleteLocalBreakdownProject = async (data: { id: number }) => {
  const project = await readLocalBreakdownProject(data.id)
  if (project) {
    for (const chapter of project.chapters) {
      await deleteKey(contentKey(chapter.id))
    }
    await deleteKey(projectKey(data.id))
  }
  return { data: undefined as void }
}

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

export const getLocalBreakdownChapterList = async (projectId: number) => {
  const stored = await readLocalBreakdownProject(projectId)
  if (!stored) throw new Error('拆书项目不存在')
  const project = await repairOrphanProject(stored)
  return { data: [...project.chapters].sort((a, b) => a.sortNo - b.sortNo) }
}

export const getLocalBreakdownChapterDetail = async (id: number) => {
  const content = await readLocalBreakdownContent(id)
  if (!content) throw new Error('章节不存在')
  const project = await readLocalBreakdownProject(content.projectId)
  const item = project?.chapters.find(chapter => chapter.id === Number(id))
  const detail: BreakdownChapterDetail = {
    id: Number(id),
    title: item?.title || '未命名章节',
    status: item?.status || 'wait',
    wordCount: item?.wordCount || 0,
    paragraphs: content.paragraphs.map((text, index) => ({
      id: index + 1,
      text,
      insightId: content.paragraphInsightIds[index] ?? undefined,
    })),
    analysis: content.analysis || { outline: [], rhythm: [], setting: [] },
    errorMessage: item?.errorMessage,
  }
  return { data: detail }
}

export const deleteLocalBreakdownChapter = async (data: { id: number }) => {
  const content = await readLocalBreakdownContent(data.id)
  if (!content) return { data: undefined as void }
  const project = await readLocalBreakdownProject(content.projectId)
  if (project) {
    project.chapters = project.chapters.filter(chapter => chapter.id !== Number(data.id))
    recalcLocalBreakdownProject(project)
    await writeLocalBreakdownProject(project)
  }
  await deleteKey(contentKey(data.id))
  return { data: undefined as void }
}

// ---------------------------------------------------------------------------
// 拆解选章与估算（开源版无计费，cost 恒 0）
// ---------------------------------------------------------------------------

/** 待拆章选取口径：显式 chapterIds 优先，否则按序取前 count 个 wait/failed */
export const pickLocalBreakdownChapters = (
  project: LocalBreakdownProject,
  params: { count?: number; chapterIds?: number[] }
) => {
  const retryable = project.chapters
    .filter(item => item.status === 'wait' || item.status === 'failed')
    .sort((a, b) => a.sortNo - b.sortNo)
  if (params.chapterIds?.length) {
    const wanted = new Set(params.chapterIds.map(Number))
    return retryable.filter(item => wanted.has(Number(item.id)))
  }
  return retryable.slice(0, Math.max(1, Number(params.count || 1)))
}

export const estimateLocalBreakdown = async (data: {
  projectId: number
  count?: number
  chapterIds?: number[]
}) => {
  const project = await readLocalBreakdownProject(data.projectId)
  if (!project) throw new Error('拆书项目不存在')
  const picked = pickLocalBreakdownChapters(project, data)
  const result: BreakdownEstimateResult = {
    chapterIds: picked.map(item => Number(item.id)),
    chapterCount: picked.length,
    words: picked.reduce((sum, item) => sum + Number(item.wordCount || 0), 0),
    cost: 0,
    pointRate: 0,
  }
  return { data: result }
}

// ---------------------------------------------------------------------------
// Markdown 导出（替代服务端 PDF/Word 排版）
// ---------------------------------------------------------------------------

export const exportLocalBreakdownMarkdown = async (data: { projectId: number }) => {
  const project = await readLocalBreakdownProject(data.projectId)
  if (!project) throw new Error('拆书项目不存在')
  const lines: string[] = [
    `# 《${project.title}》拆书报告`,
    '',
    `- 总字数：${project.wordCount}`,
    `- 章节数：${project.chapterCount}`,
    `- 已拆解：${project.chapters.filter(item => item.status === 'done').length} 章`,
    '',
  ]
  const report = project.report
  if (report) {
    lines.push('## 全书汇总')
    if (report.editorNotes) lines.push('', '### 编辑手记', '', String(report.editorNotes))
    if (Array.isArray(report.outlineRecovery) && report.outlineRecovery.length) {
      lines.push('', '### 大纲反推', '')
      report.outlineRecovery.forEach((item: JsonRecord) =>
        lines.push(`- ${item.stage}（${item.chapters || ''}）：${item.goal}${item.payoff ? `；兑现：${item.payoff}` : ''}`)
      )
    }
    if (Array.isArray(report.characterArcs) && report.characterArcs.length) {
      lines.push('', '### 人物弧线', '')
      report.characterArcs.forEach((item: JsonRecord) =>
        lines.push(`- ${item.name}：${item.arc}`)
      )
    }
    if (Array.isArray(report.foreshadowLedger) && report.foreshadowLedger.length) {
      lines.push('', '### 伏笔账本', '')
      report.foreshadowLedger.forEach((item: JsonRecord) =>
        lines.push(`- 第${item.plantChapter}章埋设${item.status === 'recovered' ? ` → 第${item.payoffChapter}章回收` : '（未回收）'}：${item.item}`)
      )
    }
    if (Array.isArray(report.reusableTechniques) && report.reusableTechniques.length) {
      lines.push('', '### 可复用技巧', '')
      report.reusableTechniques.forEach((item: unknown, index: number) => lines.push(`${index + 1}. ${item}`))
    }
    lines.push('')
  }
  for (const chapter of [...project.chapters].sort((a, b) => a.sortNo - b.sortNo)) {
    if (chapter.status !== 'done') continue
    const content = await readLocalBreakdownContent(chapter.id)
    const analysis = content?.analysis
    if (!analysis) continue
    lines.push(`## 第${chapter.sortNo}章 ${chapter.title}`, '')
    if (analysis.summary) lines.push(`**细纲**：${analysis.summary}`, '')
    if (analysis.outline?.length) {
      lines.push('**关键节点**：', '')
      analysis.outline.forEach(node =>
        lines.push(`- ${node.title}（${node.range}）：${node.text}${node.tags?.length ? `【${node.tags.map(tag => tag.text).join('、')}】` : ''}`)
      )
      lines.push('')
    }
    if (analysis.rhythm?.length) {
      lines.push('**爽点节奏**：', '')
      analysis.rhythm.forEach(item => lines.push(`- ${item.label}${item.value ? `（${item.value}）` : ''}：${item.desc}`))
      lines.push('')
    }
    if (analysis.setting?.length) {
      lines.push('**世界观设定**：', '')
      analysis.setting.forEach(item => lines.push(`- ${item.name}${item.type ? `·${item.type}` : ''}：${item.desc}`))
      lines.push('')
    }
    if (analysis.relations?.length) {
      lines.push('**人物关系**：', '')
      analysis.relations.forEach(item => lines.push(`- ${item.from} → ${item.to}（${item.relation}）：${item.desc}`))
      lines.push('')
    }
  }
  return new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
}
