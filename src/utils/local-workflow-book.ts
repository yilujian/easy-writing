import type { JsonRecord } from '@/types/json'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { addLocalCharacter, addLocalWorldSetting } from '@/storage/local-reference'
import { addLocalStoryline } from '@/storage/local-reference-plot'
import { writeLocalWorkflowRun, type LocalWorkflowRun } from '@/storage/local-workflow'

/**
 * 工作流建书落地：把向导四步的产物（大纲 + 设定）翻译成一本真实的本地书。
 *
 * - 书：选中书名 + 简介 + 题材标签，globalInstruction 记 { workflowRunId } 关联；
 * - 卷：大纲分卷原样建卷，规划参数（阶段/目标章数）存卷 planMeta；
 * - 章：首卷章纲落成真实章节（正文空、workflowStatus=incomplete），逐章引擎按序填正文；
 * - 参考库：设定里的角色/世界观/故事线导入参考面板，写作台右栏直接可用。
 * 只在 run 还没建过书时执行；已有书的"继续生成"不再走这里。
 */

const asText = (value: unknown) => String(value ?? '').trim()

const mapGender = (value: unknown) => {
  const text = asText(value)
  if (text.includes('女')) return 0
  if (text.includes('男')) return 1
  return 2
}

const mapPerspective = (value: unknown) => (asText(value).includes('第一') ? 'first' : 'third')

const mapAudience = (value: unknown) => {
  const text = asText(value)
  if (text.includes('女')) return 'female'
  if (text.includes('男')) return 'male'
  return 'pub'
}

const joinLines = (lines: Array<string | null | undefined>) =>
  lines.map(line => asText(line)).filter(Boolean).join('\n')

export const resolveRunOutlineUi = (run: LocalWorkflowRun): JsonRecord => {
  const summary = run.summary || {}
  return (summary.workflowOutlineUi || summary.workflowOutline || {}) as JsonRecord
}

export const resolveRunSettingUi = (run: LocalWorkflowRun): JsonRecord => {
  const summary = run.summary || {}
  return (summary.workflowSettingUi || summary.workflowSetting || {}) as JsonRecord
}

export const resolveRunBookTitle = (run: LocalWorkflowRun) => {
  const outline = resolveRunOutlineUi(run)
  const options = Array.isArray(outline.titleOptions) ? outline.titleOptions : []
  const selected = options.find((item: JsonRecord) => String(item?.id) === String(outline.selectedTitleId))
  return asText(selected?.name) || asText(options[0]?.name) || asText(run.title) || '未命名作品'
}

/** '100万字'/'3000字' 这类中文数字串 → 数值（万按 1e4 展开），解析不出返回 0 */
export const parseChineseWordTarget = (value: unknown) => {
  const text = asText(value)
  const match = text.match(/([\d.]+)\s*(万)?/)
  if (!match) return 0
  const base = Number(match[1])
  if (!Number.isFinite(base)) return 0
  return Math.round(match[2] ? base * 10000 : base)
}

const importSettingCharacters = async (bookId: number, setting: JsonRecord) => {
  const characters = Array.isArray(setting.characters) ? setting.characters : []
  for (const [index, item] of characters.entries()) {
    const name = asText(item?.name)
    if (!name) continue
    await addLocalCharacter({
      bookId: String(bookId),
      name,
      aliases: item.aliases,
      role: index === 0 ? 0 : 1,
      gender: mapGender(item?.gender),
      tags: asText(item?.keywords) ? asText(item?.keywords).split(/[、,，\s]+/).filter(Boolean) : [],
      personality: joinLines([
        asText(item?.identity) ? `身份：${asText(item?.identity)}` : '',
        asText(item?.motivation) ? `动机：${asText(item?.motivation)}` : '',
      ]),
      background: asText(item?.background),
    })
  }
}

// WorldSetting.type：0地理 1势力 2功法技能 3物品道具 4等级体系 5其他
const importSettingWorld = async (
  bookId: number,
  setting: JsonRecord,
  outline: JsonRecord
) => {
  const add = (name: string, type: number, detail: string) =>
    detail
      ? addLocalWorldSetting({ bookId: String(bookId), name, type, detail })
      : Promise.resolve(null)

  const worldItems = Array.isArray(outline.worldItems) ? outline.worldItems : []
  await add('世界观要点', 5, joinLines(worldItems.map((item: unknown, i: number) => `${i + 1}. ${asText(item)}`)))

  const cards = Array.isArray(setting.worldCards) ? setting.worldCards : []
  for (const card of cards) {
    const title = asText(card?.title)
    if (!title) continue
    await add(title, 5, joinLines([
      asText(card?.content),
      ...(Array.isArray(card?.bullets) ? card.bullets.map((b: unknown) => `· ${asText(b)}`) : []),
      Array.isArray(card?.tags) && card.tags.length ? `标签：${card.tags.map(asText).join('、')}` : '',
    ]))
  }

  const core = (setting.core || {}) as JsonRecord
  const realms = Array.isArray(core.cultivation?.realms) ? core.cultivation.realms : []
  await add('力量体系', 4, joinLines([
    asText(core.cultivation?.intro),
    ...realms.map((realm: JsonRecord, i: number) => `${i + 1}. ${asText(realm?.name)}：${asText(realm?.desc)}`),
    asText(core.cultivation?.more),
  ]))
  await add('能力体系', 2, joinLines([
    asText(core.ability?.intro),
    asText(core.ability?.innate?.desc) ? `先天：${asText(core.ability?.innate?.desc)}` : '',
    asText(core.ability?.acquired?.desc) ? `后天：${asText(core.ability?.acquired?.desc)}` : '',
  ]))
  const mechanics = Array.isArray(core.mechanics?.items) ? core.mechanics.items : []
  await add('世界机制', 5, joinLines([
    asText(core.mechanics?.intro),
    ...mechanics.map((item: JsonRecord) => `${asText(item?.title)}：${asText(item?.desc)}`),
  ]))
  const resources = Array.isArray(core.resources?.items) ? core.resources.items : []
  await add('资源体系', 3, joinLines([
    asText(core.resources?.intro),
    ...resources.map((item: JsonRecord) => `${asText(item?.title)}：${asText(item?.desc)}`),
  ]))
}

const importSettingStorylines = async (bookId: number, setting: JsonRecord) => {
  const storylines = Array.isArray(setting.storylines) ? setting.storylines : []
  for (const [index, line] of storylines.entries()) {
    const title = asText(line?.title)
    if (!title) continue
    await addLocalStoryline({
      bookId,
      title,
      lineType: index === 0 ? 'main' : 'branch',
      summary: asText(line?.desc),
      goal: asText(line?.keyEvent),
    })
  }
}

export interface CreatedWorkflowBook {
  bookId: number
  totalPlannedChapters: number
}

/** 把 run 的大纲/设定落成一本新本地书；写回 run.bookId 后返回 */
export const createLocalBookFromRun = async (run: LocalWorkflowRun): Promise<CreatedWorkflowBook> => {
  const outline = resolveRunOutlineUi(run)
  const setting = resolveRunSettingUi(run)
  const config = (run.config || {}) as JsonRecord
  const storage = getLocalLibraryStorage()

  const book = await storage.createLocalBook({
    title: resolveRunBookTitle(run),
    intro: asText(outline.intro),
    category: asText(config.genre),
    tags: [asText(config.genre), ...(Array.isArray(config.tags) ? config.tags.map(asText) : [])].filter(Boolean),
    platform: asText(config.platform),
    perspective: mapPerspective(config.storyPerspective),
    audience: mapAudience(config.audience),
    globalInstruction: { workflowRunId: Number(run.id) },
  })
  // createLocalBook 自带"第一卷+第1章"骨架；工作流书的卷章全部按大纲来，先清掉（与 JSON 导入同套路）
  const defaultTree = await storage.getLocalBookTree(book.id)
  if (defaultTree.length) {
    await storage.deleteLocalVolume(defaultTree.map(volume => volume.id))
  }

  // 分卷：卷计划参数入 planMeta；plannedChapters 由逐章引擎按批填充
  const volumes = Array.isArray(outline.volumes) ? outline.volumes : []
  const volumeIdMap = new Map<string, number>()
  for (const [index, volume] of volumes.entries()) {
    const created = await storage.createLocalVolume({
      bookId: book.id,
      title: asText(volume?.title) || `第${index + 1}卷`,
      summary: asText(volume?.summary),
      sortNo: index + 1,
      planMeta: {
        stages: Array.isArray(volume?.stages) ? volume.stages : [],
        chapterCount: Number(volume?.chapterCount || 0),
        chapterCountMode: asText(volume?.chapterCountMode) || 'dynamic',
        chapterRange: volume?.chapterRange || null,
        chapters: [],
      },
    })
    volumeIdMap.set(String(volume?.id ?? index), created.id)
  }
  if (!volumeIdMap.size) {
    const created = await storage.createLocalVolume({ bookId: book.id, title: '第一卷', sortNo: 1 })
    volumeIdMap.set('v1', created.id)
  }

  // 首卷章纲落成真实章节：正文空，等逐章引擎按序填
  const chapters = Array.isArray(outline.chapters) ? outline.chapters : []
  const fallbackVolumeId = [...volumeIdMap.values()][0]
  let created = 0
  for (const [index, chapter] of chapters.entries()) {
    const title = asText(chapter?.title)
    if (!title) continue
    const chapterNo = Number(chapter?.chapterNo || index + 1)
    await storage.createLocalChapter({
      bookId: book.id,
      volumeId: volumeIdMap.get(String(chapter?.volumeId)) ?? fallbackVolumeId,
      title,
      summary: asText(chapter?.summary),
      sortNo: chapterNo,
      planMeta: {
        workflowPlanIndex: chapterNo,
        outlineSource: 'volume_ai',
        source: { title, summary: asText(chapter?.summary) },
      },
      workflowStatus: 'incomplete',
    })
    created += 1
  }

  await importSettingCharacters(book.id, setting)
  await importSettingWorld(book.id, setting, outline)
  await importSettingStorylines(book.id, setting)

  run.bookId = book.id
  run.status = 'generating'
  await writeLocalWorkflowRun(run)
  return { bookId: book.id, totalPlannedChapters: created }
}
