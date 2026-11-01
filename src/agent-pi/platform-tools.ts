import { setSampleChoice } from './prose-samples'
import { writingCommand } from '@/writing-service/client'
import type { StoredLocalChapterDraft } from '@/storage'
import { generateProse, type ProseInfo } from './prose'
import { announceRunControl } from './run-control'
import { pauseHeldTasks } from './tasks'
import type { PiRunControlChange } from '@/types/agent-pi'
import { listRankings, readRankings, refreshRankings } from './ranking-tools'
import { getLocalLibraryStorage, LOCAL_USER_ID } from '@/storage/local-library'
import { getWritingStorage } from '@/storage'
import { readDoc } from '@/storage/local-reference-store'
import { findSkill, reloadSkills, runSkillScript, sessionSkill } from './skills'
import { readBreakdown, runBreakdown, runDistillation, runBatch, makeCover, controlTaskTool, reparseBookAttachment } from './research-tools'
import { entitySpecs } from './creation'
import type { PiEntityKind, PiEntityDraft, PiChapterPlan } from '@/types/agent-pi'
import { withRecordStore } from '@/storage/desktop-records'
import { trackStorageWrite } from '@/storage/storage-maintenance'
import type {
  PiBook,
  PiDraft,
  PiChapterDraft,
  PiNewChapterDraft,
  PiOutlineDraft,
  PiToolRequest,
  PiAdoptionTicket,
  PiDraftConfirmation
} from '@/types/agent-pi'
import { isTauriRuntime } from '@/storage/writing-storage'
import { piCommand } from './client'
import { notifyDraftApplied } from './tasks'
import { readStorySummary,previewFullLedger,startBackfill,type BackfillPreview } from './story-ledger'
import { isInstructionOnlySkill, isStyleSkill, readStyleExamples, releaseStyleReads, sourceNamesOf, styleReadAt } from './style-tools'
import { leakedNames } from './style-fingerprint'
import { batchTasks } from './batch-tasks'
import { searchWritingResources, readWritingResource, resourceEvidenceFor } from './writing-resources'

const store = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>('ew-agent-pi', 'drafts', undefined, mode, run)
function readBookChapter(bookId: string, chapterId: number) {
  return isTauriRuntime()
    ? writingCommand<StoredLocalChapterDraft>('chapter_source', { bookId, chapterId: String(chapterId) })
    : getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, bookId, chapterId)
}
const readDraft = (id: string) => store<PiDraft | undefined>('readonly', s => s.get(id))
const writeDraft = (draft: PiDraft) =>
  store('readwrite', s => s.put(JSON.parse(JSON.stringify(draft)), draft.id))
const bases = new Map<string, { version: number; text: string; title: string }>()
const referenceBases = new Map<string, Record<string, unknown>>()
const outlineBases = new Map<string, Map<number, PiOutlineDraft['baseOutline'] & { nodeType?: number }>>()
const proseRequests = new Map<string,string>()
const applying = new Map<string, Promise<PiDraft>>()
const uncertainSaves = new Map<string, PiAdoptionTicket>()
/** 本轮刚在卡上采用的新书：宿主要等这一轮结束才把对话绑过去，这期间同一会话的工具调用先按它算。 */
const sessionBooks = new Map<string, PiBook>()
const freshBookTurns = new Map<string, { bookId: string; turnId: string }>()
export const sessionBookOverride = (sessionId: string) => sessionBooks.get(sessionId) || null
/** 这个对话里还没采用、也没搁置的新书候选（最新的一份）。 */
async function pendingBookDraft(sessionId: string) {
  return (
    (await listPiDrafts()).find(
      (d): d is PiEntityDraft => d.kind === 'entity' && d.entity === 'book' && d.sessionId === sessionId && !d.appliedAt && !d.dismissedAt
    ) || null
  )
}
/** 没绑作品时给模型的话：有待采用的新书就指路到会出卡的工具，没有就说清怎么绑。 */
async function noBookError(sessionId: string) {
  const pending = await pendingBookDraft(sessionId)
  return new Error(pending
    ? '新书《' + pending.title + '》尚未采用，请先用 prepare_writing 完成作品准备。'
    : '当前对话没有绑定作品，请选择已有作品，或先提交新书候选，再准备写作。')
}
// 开始关闭时立即捕获，避免保存失败已从 applying 移除后被误当成收尾成功。
export const capturePiSaves = () => Promise.allSettled([...applying.values()])
export async function waitForPiSaves(captured = capturePiSaves()) {
  const results = [...(await captured), ...(await capturePiSaves())]
  if (results.some(r => r.status === 'rejected'))
    throw new Error('Agent 正式保存未成功完成，已取消关闭。请查看草稿中的保存结果并重试。')
  for (const [key, ticket] of uncertainSaves) {
    const result = await piCommand<{ status: string; draft?: PiDraft }>('adoption_status', { ticket })
    if (result.status !== 'committed' || !result.draft)
      throw new Error('Agent 正式保存结果仍未确认，已取消关闭。请保留草稿并重试核对保存结果。')
    uncertainSaves.delete(key)
    notifyChapterSaved(result.draft)
  }
}
export function releasePiToolContext(instanceId: string) {
  proseRequests.delete(instanceId)
  for (const [key, batch] of materialConfirmations) if (batch.instanceId === instanceId) materialConfirmations.delete(key)
  for (const key of bases.keys()) if (key.startsWith(instanceId + ':')) bases.delete(key)
  outlineBases.delete(instanceId)
  referenceBases.delete(instanceId)
  releaseStyleReads(instanceId)
  leakWarned.delete(instanceId)
}
/** 每个 Pi 实例已经提醒过的参考书人名：同一个名字只拦一次，第二次照样保存并记一条提醒，不让模型反复重写。 */
const leakWarned = new Map<string, Set<string>>()
/** 作者这本书自己的名字：书名、人物名与别名、设定名。参考书的名字撞上这些（如本书设定里有"异怒系统"，参考书人名表里的"系统"）就不算搬运。 */
async function ownNames(bookId: string) {
  const [doc, detail] = await Promise.all([readDoc(bookId), getLocalLibraryStorage().getLocalBookDetail(bookId)])
  return [detail?.title || '', ...doc.characters.flatMap(c => [c.name, ...(c.aliases || [])]), ...doc.worldSettings.map(w => w.name)]
    .map(n => String(n || '').trim())
    .filter(Boolean)
}
/**
 * 按写作方法技能写时，保存前核对两件事：这一章取过范例；正文里没把参考书的人物搬进来（按蒸馏时记下的人名表核对，本书自己的名字除外）。
 * 批量写作只看本会话任务绑定的技能；确认是普通流程 Skill 时不要求文风样本。
 * 文风技能的范例读取要晚于本章事件；单章写作沿用本会话的文风技能校验。
 * 人名第一次查到退回让模型改；同一个名字第二次仍在就放行并返回提醒（可能本来就是本书用词），不让模型反复重写整章。
 */
async function assertStyleRules(request: PiToolRequest, bookId: string, content: string): Promise<string | undefined> {
  if(request.args.authorVerbatim===true)return undefined
  const sessionId = String(request.args.sessionId || '')
  const task = batchTasks.value.find(t => t.bookId === bookId && t.sessionId === sessionId && t.status === 'running' && t.styleSkill)
  const step = task?.steps[task.cursor]
  const inBatch = Boolean(task && step && step.status === 'writing')
  const skill = inBatch ? String(task?.styleSkill || '') : sessionSkill(sessionId)
  if (!skill || (inBatch ? await isInstructionOnlySkill(skill) : !(await isStyleSkill(skill)))) return undefined
  if (styleReadAt(request.instanceId) < (inBatch ? step?.startedAt || 0 : 1))
    throw new Error(`这本书按「${skill}」的文风写：先用 read_style_examples（skill 填「${skill}」，scene 填这一章的场景类型）取一段原文样本和卡，对照着写完再保存。`)
  const own = await ownNames(bookId)
  const leaked = leakedNames(content, await sourceNamesOf(skill)).filter(name => !own.some(o => o.includes(name)))
  if (!leaked.length) return undefined
  const warned = leakWarned.get(request.instanceId) || new Set<string>()
  const fresh = leaked.filter(n => !warned.has(n))
  for (const n of leaked) warned.add(n)
  leakWarned.set(request.instanceId, warned)
  if (fresh.length)
    throw new Error(
      `正文里出现了参考书的人物：${fresh.join('、')}。只学写法，人物要用本书自己的；改掉后再保存。确实是本书自己的用词就原样再提交一次，这次会保存并附一条提醒。`
    )
  return `正文里仍有和参考书人物同名的词：${leaked.join('、')}；已按本书用词保存。`
}
/** 作者要改的是一份还没采用的章节候选：换掉它的正文，不另开一份，也不走前情核对。标题沿用候选的。 */
async function reviseCandidate(request: PiToolRequest, book: PiBook) {
  const id = String(request.args.draftId)
  const draft = await readDraft(id)
  if (!draft || draft.bookId !== book.id) throw new Error('要改的候选不存在或不属于当前作品；用 list_drafts 核对 draftId')
  if (draft.kind !== 'new_chapter' && draft.kind !== 'chapter') throw new Error('draftId 指向的不是章节候选')
  if (draft.appliedAt) throw new Error(`候选《${draft.title}》已经采用成正式章节；改它要用 read_chapter 重新读取后，用 save_draft 带 chapterId 提交改稿`)
  const content = String(request.args.content || '').trim()
  if (!content || content.length > 150000) throw new Error('草稿正文无效')
  const styleWarning = await assertStyleRules(request, book.id, content)
  const saved = await savePiDraftEdit(id, content, draft.revision ?? 0, 'supplied')
  window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
  return { draftId: id, title: saved.title, status: '候选已换成新稿，等待作者采用；标题沿用候选的。', ...(styleWarning ? { warnings: [styleWarning] } : {}) }
}
/** 平台业务确认冻结真实候选版本；令牌只属于当前实例、会话和作品。 */
const materialConfirmations = new Map<string, { instanceId: string; sessionId: string; bookId: string; confirmations: PiDraftConfirmation[] }>()
const materialDraft = (draft: PiDraft) => draft.kind === 'outline' || draft.kind === 'entity'
export async function preparePiDraftBatch(ids: string[], sessionId: string): Promise<PiDraftConfirmation[]> {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('候选清单为空、重复或超过 100 份')
  const confirmations: PiDraftConfirmation[] = []
  for (const id of ids) {
    const draft = await readDraft(id)
    if (!draft || draft.sessionId !== sessionId || draft.dismissedAt) throw new Error('候选已改变或不属于当前对话，请重新核对')
    const confirmation = await piCommand<PiDraftConfirmation>('prepare_adoption', { draftId: id, revision: draft.revision ?? 0 })
    if (!confirmation.ticket || confirmation.draft.id !== id || confirmation.draft.sessionId !== sessionId) throw new Error('候选确认身份无效')
    confirmations.push(confirmation)
  }
  return confirmations
}
export async function validatePiDraftBatch(confirmations: PiDraftConfirmation[], sessionId: string) {
  const latest = await preparePiDraftBatch(confirmations.map(c => c.draft.id), sessionId)
  for (let i = 0; i < confirmations.length; i++) {
    const before = confirmations[i], now = latest[i]
    if (before.ticket?.draftId !== now.ticket?.draftId || before.ticket?.revision !== now.ticket?.revision || before.ticket?.fingerprint !== now.ticket?.fingerprint)
      throw new Error(`《${before.draft.title}》在确认期间发生变化，请重新预览；本批尚未开始保存`)
  }
}
async function confirmMaterials(request: PiToolRequest, signal?: AbortSignal) {
  const sessionId = String(request.args.sessionId || ''), bookId = request.book?.id || ''
  if (request.args.prepare === true || request.args.inspect === true) {
    const all = (await listPiDrafts(bookId)).filter(d => d.sessionId === sessionId && d.bookId === bookId && !d.appliedAt && !d.dismissedAt && materialDraft(d)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const ids = request.args.draftIds
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string'))) throw new Error('请提供有效的候选编号列表')
    const selected = ids === undefined ? all : all.filter(d => (ids as string[]).includes(d.id))
    if (ids !== undefined && selected.length !== new Set(ids as string[]).size) throw new Error('部分资料候选已变化或不属于当前对话，请重新读取草稿列表')
    if (!selected.length) return { ready: true, adopted: [], status: '当前对话没有待确认的作品资料' }
    if (selected.some(d => d.kind === 'entity' && d.entity === 'book') && selected.length > 1) throw new Error('新书需要单独确认，请先指定一份新书候选；其他资料在作品归属确定后再确认')
    if (request.args.inspect === true) return { ready: false, items: selected.map(d => ({ id: d.id, title: d.title })) }
    const confirmations = await preparePiDraftBatch(selected.map(d => d.id), sessionId)
    checkActive(signal)
    const confirmationId = crypto.randomUUID()
    materialConfirmations.set(confirmationId, { instanceId: request.instanceId, sessionId, bookId, confirmations: JSON.parse(JSON.stringify(confirmations)) })
    return { ready: false, confirmationId, items: selected.map(d => ({ id: d.id, title: d.title, kind: d.kind === 'entity' ? entitySpecs[d.entity].label : '大纲', revision: d.revision ?? 0 })) }
  }
  const confirmationId = String(request.args.confirmationId || ''), batch = materialConfirmations.get(confirmationId)
  if (!batch || batch.instanceId !== request.instanceId || batch.sessionId !== sessionId || batch.bookId !== bookId) throw new Error('资料确认已失效，请重新预览')
  if (request.args.cancel === true) { materialConfirmations.delete(confirmationId); return { cancelled: true, status: '资料未采用，已停止依赖它的写作' } }
  if (request.args.approve !== true) throw new Error('缺少资料确认决定')
  checkActive(signal)
  await validatePiDraftBatch(batch.confirmations, sessionId)
  const adopted: Array<{ id: string; title: string }> = []
  let bookCreated = false
  try {
    for (const confirmation of batch.confirmations) {
      checkActive(signal)
      const saved = await applyPiDraft(confirmation.draft.id, confirmation)
      adopted.push({ id: saved.id, title: saved.title })
      await notifyDraftApplied(saved)
      if (saved.kind === 'entity' && saved.entity === 'book' && saved.appliedBookId) {
        bookCreated = true
        sessionBooks.set(sessionId, { id: String(saved.appliedBookId), title: saved.title })
        if (request.args.turnId) freshBookTurns.set(sessionId, { bookId: String(saved.appliedBookId), turnId: String(request.args.turnId) })
      }
    }
    materialConfirmations.delete(confirmationId)
    return { ready: true, adopted, bookCreated, status: `已正式采用 ${adopted.length} 份作品资料。请重新读取资料后继续。` }
  } catch (cause) {
    throw new Error(`本批已确认保存 ${adopted.length}/${batch.confirmations.length} 份，未继续写作。${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
function checkActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Agent 工具请求已取消')
}
async function writeToolDraft(request: PiToolRequest, draft: PiDraft, signal?: AbortSignal) {
  checkActive(signal)
  if (isTauriRuntime()) {
    // 原生提交再次检查实例/请求，并与事务提交共享临界区，不能只靠 JS 检查。
    return trackStorageWrite(() =>
      piCommand<PiDraft>('commit_draft', {
        instanceId: request.instanceId,
        requestId: request.id,
        draft
      })
    )
  }
  // 浏览器不开放 Pi 执行；此分支供独立存储测试使用。
  const resourceUse = await resourceEvidenceFor(request)
  if (resourceUse.length) draft.resourceUse = resourceUse
  checkActive(signal)
  await writeDraft(draft)
  return draft
}
export const listPiDrafts = async (bookId?: string) => {
  const values = await store<PiDraft[]>('readonly', s => s.getAll())
  return values.filter(d => !bookId || d.bookId === bookId).sort((a, b) => b.createdAt - a.createdAt)
}
/** 聊天模型本次拟的章纲默认采用：写进目标章的大纲，作者在目录里看得见、改得了。已有章纲不覆盖。 */
async function saveChapterPlan(bookId: string, chapterId: number, plan: PiChapterPlan) {
  const storage = getLocalLibraryStorage()
  const chapter = await storage.getLocalChapterById(chapterId)
  if (!chapter || String(chapter.bookId) !== String(bookId) || String(chapter.summary || '').trim()) return
  await storage.updateLocalChapter({
    id: chapterId,
    summary: plan.summary,
    ...(chapter.planMeta ? {} : { planMeta: { beats: plan.beats || [], source: 'agent' } })
  })
}
async function chapterInBook(bookId: string, chapterId: number) {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  const chapter = tree.flatMap(volume => volume.children).find(c => c.id === chapterId)
  if (!chapter) throw new Error('章节不属于当前绑定作品，或已被删除')
  return chapter
}
function selectionPositions(text: string, query: string, version: number) {
  const positions = []
  let start = text.indexOf(query)
  while (start >= 0) {
    const end = start + query.length
    positions.push({
      occurrence: positions.length + 1,
      context: text.slice(Math.max(0, start - 24), start) + '【选段】' + text.slice(end, end + 24)
    })
    start = text.indexOf(query, end)
  }
  return { positions, version }
}
export async function executePiTool(
  request: PiToolRequest,
  signal?: AbortSignal,
  progress?: (text: string) => void
) {
  checkActive(signal)
  const sessionId = String(request.args.sessionId || '')
  // 本轮刚在卡上采用的新书：宿主要等这一轮结束才把对话绑过去，这期间先按它算
  if (request.book?.id) sessionBooks.delete(sessionId)
  else if (sessionBooks.has(sessionId)) request.book = sessionBooks.get(sessionId) || null
  const { tool, args } = request
  const book = request.book
  if (tool === 'write_prose') {
    if (args.memoryAction === 'preview') {
      if (!book?.id || (!args.chapterId && !args.volumeId)) return { count: 0 }
      const target = args.chapterId
        ? { chapterId: String(args.chapterId) }
        : { volumeId: String(args.volumeId) }
      return previewFullLedger(book.id,target)
    }
    if(args.memoryAction==='chooseSample'){
      if(!book?.id)throw Error('请先选择作品')
      await setSampleChoice(book.id,String(args.choice))
      return {status:'已保存本书范文选择'}
    }
    if (args.memoryAction === 'start') {
      if (!book?.id) throw Error('请先选择要整理的作品')
      return startBackfill(book.id, args.plan as BackfillPreview, String(args.sessionModelCode))
    }
    const key = sessionId + ':' + String(args.turnId) + ':prose'
    const existing = await readDraft(key)
    if (existing) return { draftId: existing.id, title: existing.title, status: '本轮已交付' }
    if (proseRequests.get(request.instanceId) === key)
      throw Error('本轮已发起正文请求，请核对候选或告知作者失败原因，由作者决定是否重试')
    const prior = args.draftId ? await readDraft(String(args.draftId)) : undefined
    if (
      args.draftId &&
      (!prior ||
        prior.sessionId !== sessionId ||
        (prior.bookId && prior.bookId !== book?.id) ||
        prior.appliedAt ||
        prior.dismissedAt)
    )
      throw Error('待改候选不存在、归属不符或已采用')
    if (
      prior &&
      prior.kind !== 'chapter' &&
      prior.kind !== 'new_chapter' &&
      prior.kind !== 'short_story' &&
      prior.kind !== 'text'
    )
      throw Error('请选择正文候选')
    if ((args.mode === 'revise') !== !!prior) throw Error('修订已有候选时须指定 draftId')
    if (args.mode === 'new_chapter' && book) {
      const tree = await getLocalLibraryStorage().getLocalBookTree(book.id)
      const state = await chapterContinuity(book.id, tree, String(args.volumeId))
      if (state.candidates.length || state.revisions.length)
        throw Error('有待处理的上一章候选，请先用 prepare_writing 核对')
    }
    let info: ProseInfo | undefined
    const draft = await generateProse(
      request,
      String(args.sessionModelCode || ''),
      prior,
      signal,
      async (newChapter, plan, next) => {
        info = next
        if (newChapter) {
          const materials = await confirmMaterials({ ...request, args: { sessionId, inspect: true } }, signal)
          if (!materials.ready) throw Error('有待决定的作品资料，请先用 prepare_writing 核对后再写章')
        }
        if (proseRequests.get(request.instanceId) === key) throw Error('同一轮正文请求已发出')
        proseRequests.set(request.instanceId, key)
        if (plan?.source === 'chat' && args.mode === 'chapter' && book && args.chapterId)
          await saveChapterPlan(book.id, Number(args.chapterId), plan)
      }
    )
    let saved: PiDraft
    try {
      saved = await writeToolDraft(request, draft, signal)
    } catch (cause) {
      const committed = await readDraft(draft.id)
      if (committed?.proseSource?.callId !== request.callId) throw cause
      saved = committed
    }
    window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
    return {
      draftId: saved.id,
      title: saved.title,
      status: '已交付一份可编辑候选，等待作者决定',
      ...(saved.kind === 'chapter' && saved.selection ? { change: '仅改写了指定选段。' } : {}),
      ...(info && (saved.kind === 'chapter' || saved.kind === 'new_chapter')
        ? {
            plannedAhead: info.plannedAhead,
            volumePlanned: info.volumePlanned,
            next:
              info.plannedAhead > 0
                ? `后面还有 ${info.plannedAhead} 章写好了章纲没写正文，作者采用本章后按 chapterId 依次写。`
                : info.volumePlanned
                  ? '后面没有章纲了，作者采用本章后用 plan_chapters 续写下一批章纲。'
                  : '这本书没有卷纲，可以问作者要不要整理一份。'
          }
        : {})
    }
  }
  if (tool === 'control_session') {
    const result = await piCommand<PiRunControlChange>('run_control_tool', { instanceId: request.instanceId, requestId: request.id })
    announceRunControl(sessionId, result.control)
    await pauseHeldTasks(result.control.heldTasks.filter(task => task.revision === result.control.revision))
    return result
  }
  if (tool === 'confirm_materials') return confirmMaterials(request, signal)
  if (tool === 'search_writing_resources') return searchWritingResources(request, signal)
  if (tool === 'read_writing_resource') return readWritingResource(request, signal)
  if (tool === 'read_breakdown') return readBreakdown(args, signal, progress)
  if (tool === 'run_skill_script') return runSkillScript(request, signal, progress)
  if (tool === 'reparse_book_attachment') return reparseBookAttachment(args, signal, progress)
  if (tool === 'control_task') return controlTaskTool(args)
  if (tool === 'run_breakdown') return runBreakdown(request, signal)
  if (tool === 'read_style_examples') return readStyleExamples(request, signal)
  if (tool === 'run_distillation') return runDistillation(request, signal, progress)
  if (tool === 'run_batch') return runBatch(request, signal)
  if (tool === 'make_cover') return makeCover(request, signal)
  if (tool === 'list_rankings') return listRankings(args)
  if (tool === 'read_rankings') {
    return readRankings(args)
  }
  if (tool === 'refresh_rankings') return refreshRankings(args, signal, progress)
  if (tool === 'save_creation_draft') {
    const entity = String(args.entity) as PiEntityKind
    const spec = entitySpecs[entity]
    if (!spec) throw new Error('不支持的创作资料类型')
    if (entity !== 'book' && !book?.id) throw await noBookError(sessionId)
    const fields = args.fields as Record<string, unknown>
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('候选字段无效')
    if (entity === 'book' && fields.styleSkillId) {
      await reloadSkills()
      const style = findSkill(String(fields.styleSkillId))
      if (!style?.enabled || fields.styleSkillId !== style.id) throw Error('请使用已启用文风技能的编号（skillId）')
    }
    const targetId = args.targetId == null ? null : String(args.targetId)
    if (targetId && spec.createOnly) throw new Error('此能力只支持创建候选')
    // 分卷不在作品资料里，改已有分卷时从目录核对归属
    const volumeBase =
      entity === 'volume' && targetId
        ? (await getLocalLibraryStorage().getLocalBookTree(book!.id)).find(v => String(v.id) === targetId)
        : null
    if (entity === 'volume' && targetId && !volumeBase) throw new Error('分卷不属于当前作品，先用 read_book(view="chapters") 读目录')
    const records = referenceBases.get(request.instanceId)?.[spec.collection] as
      Array<Record<string, unknown>> | undefined
    const baseEntity = volumeBase
      ? { id: volumeBase.id, title: volumeBase.title, summary: volumeBase.summary || '' }
      : targetId
        ? records?.find(v => String(v.id) === targetId)
        : null
    if (targetId && !baseEntity) throw new Error('请先读取当前作品资料，再修改目标')
    const draft: PiEntityDraft = {
      id: String(args.draftId || `${args.sessionId}:${request.callId}`),
      sessionId: String(args.sessionId),
      bookId: book?.id || '',
      kind: 'entity',
      entity,
      targetId,
      baseEntity: baseEntity ? structuredClone(baseEntity) : null,
      title: String(fields.title || fields.name || baseEntity?.title || baseEntity?.name || spec.label),
      content: JSON.stringify(fields),
      createdAt: Date.now()
    }
    const prior = await readDraft(draft.id)
    if (prior && !args.draftId) {
      if (
        prior.kind !== 'entity' ||
        prior.entity !== entity ||
        prior.targetId !== targetId ||
        prior.bookId !== draft.bookId
      )
        throw new Error('同一调用不能改写其他候选')
      return { draftId: prior.id, title: prior.title, status: prior.appliedAt ? '已采用' : '待作者采用' }
    }
    const saved = await writeToolDraft(request, draft, signal)
    window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
    return {
      draftId: saved.id,
      title: saved.title,
      operation: args.draftId ? 'updated' : 'created', revision: saved.revision ?? 0,
      fields: Object.keys(fields), emptyFields: Object.entries(fields).filter(([, v]) => v === '' || v == null || Array.isArray(v) && !v.length).map(([key]) => key),
      adopted: Boolean(saved.appliedAt),
      status: saved.appliedAt ? '已采用' : args.draftId ? '已换成新稿，等待作者采用' : '候选已展示，等待作者确认后才正式保存'
    }
  }
  if (tool === 'list_drafts' && typeof args.locateSelection === 'string' && args.locateSelection) {
    const candidate = await readDraft(String(args.draftId))
    if (
      !candidate ||
      candidate.sessionId !== sessionId ||
      (candidate.bookId && candidate.bookId !== book?.id) ||
      candidate.appliedAt
    )
      throw Error('目标候选无效')
    return selectionPositions(candidate.content, args.locateSelection, candidate.revision ?? 0)
  }
  if (tool === 'list_drafts')
    return (await listPiDrafts(book?.id))
      .filter(d => book?.id || d.sessionId === args.sessionId)
      .map(d => ({
        id: d.id,
        kind: d.kind,
        ...(d.kind === 'entity' ? { entity: d.entity, appliedBookId: d.appliedBookId, fields: JSON.parse(d.content) } : {}),
        revision: d.revision ?? 0,
        targetId:
          d.kind === 'outline'
            ? d.outlineId
            : d.kind === 'entity'
              ? d.appliedEntityId || d.targetId
              : d.kind === 'skill'
                ? d.appliedSkillId || d.replaceId
                : d.chapterId,
        ...(d.kind === 'new_chapter'
          ? { volumeId: d.volumeId, volumeTitle: d.volumeTitle, placement: d.placement }
          : {}),
        title: d.title,
        applied: Boolean(d.appliedAt),
        dismissedAt: d.dismissedAt || null,
        status: d.appliedAt ? 'saved' : d.dismissedAt ? 'dismissed' : 'pending_author_confirmation'
      }))
  if (!book?.id) throw await noBookError(sessionId)
  const currentBook = await getLocalLibraryStorage().getLocalBookDetail(book.id)
  checkActive(signal)
  if (!currentBook || currentBook.deletedAt) throw new Error('当前作品不存在或已删除')
  if ((tool === 'save_new_chapter_draft' || tool === 'save_draft') && args.draftId) return reviseCandidate(request, book)
  if (tool === 'read_references') {
    const doc = await readDoc(book.id)
    checkActive(signal)
    referenceBases.set(request.instanceId, structuredClone(doc) as unknown as Record<string, unknown>)
    outlineBases.set(request.instanceId, new Map(doc.outlineNodes.map(n => [n.id, { title: n.title, content: n.content, nodeType: n.nodeType }])))
    // 故事状态：先把账本整理到最新（新采用或手改过的章补提炼），再和资料一起给模型
    const story = await readStorySummary(book.id)
    checkActive(signal)
    return { ...doc, story }
  }
  if (tool === 'save_outline_draft') {
    const outlineId = Number(args.outlineId)
    const basis = outlineBases.get(request.instanceId)?.get(outlineId)
    if (!basis) throw new Error('这个大纲节点不在本对话读到的作品资料里：先用 read_references 读资料并核对 outlineId；要新建大纲用 save_creation_draft。')
    if (basis.nodeType === 0)
      throw new Error(`《${basis.title}》是目录节点（nodeType 0），没有正文可改。要给这一卷写大纲，用 save_creation_draft 新建 nodeType 1 的正文节点（parentId 填 ${outlineId}）并填 content。`)
    const title = String(args.title || '').trim(),
      content = String(args.content || '').trim()
    if (!title || !content || content.length > 150000) throw new Error('大纲草稿内容无效')
    const id = `${String(args.sessionId)}:${request.callId}`
    const prior = await readDraft(id)
    if (prior) {
      if (
        prior.kind !== 'outline' ||
        prior.bookId !== book.id ||
        prior.outlineId !== outlineId ||
        prior.content !== content
      )
        throw new Error('同一工具调用不能改写另一份草稿')
      return { draftId: prior.id, title: prior.title, status: prior.appliedAt ? '已采用' : '待作者采用' }
    }
    const saved = await writeToolDraft(
      request,
      {
        kind: 'outline',
        id,
        sessionId: String(args.sessionId),
        bookId: book.id,
        outlineId,
        title,
        content,
        baseOutline: { title: basis.title, content: basis.content },
        createdAt: Date.now()
      },
      signal
    )
    window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
    return {
      draftId: id,
      title,
      status: saved.appliedAt ? '已采用' : '大纲修改建议已保存，等待作者采用；正式大纲未修改。'
    }
  }
  if (tool === 'save_new_chapter_draft') {
    const tree = await getLocalLibraryStorage().getLocalBookTree(book.id)
    const volumeId = String(args.volumeId || '')
    if (!volumeId) throw new Error('新章节归属未明确，请先询问作者选择已有卷')
    const volume = tree.find(v => String(v.id) === volumeId)
    checkActive(signal)
    if (!volume) throw new Error('目标卷不存在、不属于当前作品或已删除，请重新确认归属')
    if (args.check === true) return continuityReport(await chapterContinuity(book.id, tree, volumeId))
    if (args.resolve && typeof args.resolve === 'object') {
      await resolveContinuity(args.resolve as Record<string, unknown>)
      window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
      return continuityReport(await chapterContinuity(book.id, tree, volumeId))
    }
    const title = String(args.title || '').trim(),
      content = String(args.content || '').trim()
    if (!title || !content || content.length > 150000) throw new Error('草稿标题或正文无效')
    const id = `${String(args.sessionId)}:${request.callId}`
    const prior = await readDraft(id)
    if (prior) {
      if (
        (prior.kind !== 'new_chapter' && prior.kind !== 'chapter') ||
        prior.bookId !== book.id ||
        (prior.kind === 'new_chapter' && prior.volumeId !== volumeId) ||
        prior.title !== title ||
        prior.content !== content
      )
        throw new Error('同一工具调用不能改写另一份草稿')
      return { draftId: prior.id, title: prior.title, status: prior.appliedAt ? '已采用' : '待作者采用' }
    }
    // 前情核对：上一章的改稿、没采用的新章候选都要有交代，否则新章不知道接在哪一版后面
    const continuity = await chapterContinuity(book.id, tree, volumeId)
    if (continuity.candidates.length)
      throw new Error(
        `有 ${continuity.candidates.length} 份新章节候选还没采用（${continuity.candidates.map(d => `《${d.title}》`).join('、')}），新章不知道接在哪一章后面。请先调用 prepare_writing 处理前章决定，再提交候选。`
      )
    if (continuity.revisions.length)
      throw new Error(
        `上一章《${continuity.previous[continuity.previous.length - 1]?.title || ''}》有没采用的改稿，新章不知道接在哪一版后面。请先调用 prepare_writing 处理前章决定，再提交候选。`
      )
    // 材料核对：最近两章的最新正文和作品资料在本对话里读过，才算接着前文写。空白章没什么可读；本轮刚采用的新书还没有资料可读
    const fresh = freshBookTurns.get(sessionId)
    const freshBook = sessionBooks.get(sessionId)?.id === book.id ||
      (fresh?.bookId === book.id && !!args.turnId && fresh.turnId === args.turnId)
    const unread: string[] = []
    for (const previous of continuity.previous) {
      const base = bases.get(`${request.instanceId}:${previous.id}`)
      const current = await readBookChapter(book.id, previous.id)
      if (!(current?.textContent || '').trim()) continue
      if (!base || base.version !== Number(current?.localVersion || 0)) unread.push(`《${previous.title}》（chapterId ${previous.id}）`)
    }
    if (unread.length)
      throw new Error(`写新章前要先读最近的正式章节再接着写：${unread.join('、')} 在本对话里没读过，或读的不是最新版。用 read_chapter 读完再保存。`)
    if (!freshBook && !referenceBases.has(request.instanceId))
      throw new Error('写新章前要先用 read_references 读作品资料（人物、设定、大纲），再接着写。')
    const styleWarning = await assertStyleRules(request, book.id, content)
    // 卷末是空白章（新书自带的第1章）：稿子直接填进去，不另加一章
    const blank = await blankChapterIn(book.id, volume)
    const draft: PiDraft = blank
      ? {
          kind: 'chapter',
          id,
          sessionId: String(args.sessionId),
          bookId: book.id,
          chapterId: blank.id,
          title,
          content,
          baseVersion: blank.version,
          baseText: '',
          baseTitle: blank.title,
          createdAt: Date.now()
        }
      : {
          kind: 'new_chapter',
          id,
          sessionId: String(args.sessionId),
          bookId: book.id,
          volumeId,
          volumeTitle: volume.title,
          placement: 'append',
          title,
          content,
          createdAt: Date.now()
        }
    const saved = await writeToolDraft(request, draft, signal)
    freshBookTurns.delete(sessionId)
    window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
    return {
      draftId: id,
      title,
      volumeTitle: volume.title,
      placement: blank ? `填入空白章《${blank.title}》` : '追加卷末',
      status: saved.appliedAt ? '已采用' : blank ? `稿子填进了空白章《${blank.title}》，等待作者确认。` : '新章节候选已保存，正式章节尚未创建，等待作者确认。',
      ...(styleWarning ? { warnings: [styleWarning] } : {})
    }
  }
  const chapterId = Number(args.chapterId)
  if (!Number.isSafeInteger(chapterId) || !chapterId) throw new Error('章节编号无效，请先读取目录')
  const chapter = await chapterInBook(book.id, chapterId)
  const current = await readBookChapter(book.id, chapterId)
  checkActive(signal)
  const key = `${request.instanceId}:${chapterId}`
  if (tool === 'read_chapter') {
    const basis = {
      version: Number(current?.localVersion || 0),
      text: current?.textContent || '',
      title: chapter.title
    }
    bases.set(key, basis)
    if(typeof args.locateSelection==='string' && args.locateSelection)
      return selectionPositions(basis.text,args.locateSelection,basis.version)
    return {
      chapterId: String(chapterId),
      title: chapter.title,
      summary: chapter.summary,
      content: basis.text,
      version: basis.version
    }
  }
  if (tool === 'save_draft') {
    const base = bases.get(key)
    if (!base || base.version !== Number(args.baseVersion))
      throw new Error('缺少本次读取依据，请先重新读取目标章节')
    if (Number(current?.localVersion || 0) !== base.version)
      throw new Error('作者已更新正文，请重新读取后再生成草稿')
    const title = String(args.title || '').trim()
    const content = String(args.content || '').trim()
    if (!title || !content || content.length > 150000) throw new Error('草稿标题或正文无效')
    const id = `${String(args.sessionId)}:${request.callId}`
    const prior = await readDraft(id)
    if (prior) {
      if (
        prior.kind !== 'chapter' ||
        prior.bookId !== book.id ||
        prior.chapterId !== chapterId ||
        prior.content !== content
      )
        throw new Error('同一工具调用不能改写另一份草稿')
      return { draftId: prior.id, title: prior.title, status: prior.appliedAt ? '已采用' : '待作者采用' }
    }
    const styleWarning = base.text.trim() ? undefined : await assertStyleRules(request, book.id, content)
    const draft: PiChapterDraft = {
      kind: 'chapter',
      id,
      sessionId: String(args.sessionId),
      bookId: book.id,
      chapterId,
      title,
      content,
      baseVersion: base.version,
      baseText: base.text,
      baseTitle: base.title,
      createdAt: Date.now()
    }
    const saved = await writeToolDraft(request, draft, signal)
    window.dispatchEvent(new CustomEvent('ew-pi-drafts-changed'))
    return {
      draftId: id,
      title,
      status: saved.appliedAt ? '已采用' : '草稿已保存，正式正文未修改，等待作者在界面采用。',
      ...(styleWarning ? { warnings: [styleWarning] } : {})
    }
  }
  throw new Error('未开放的平台能力')
}
type BookTree = Array<{ id: number; title: string; children: Array<{ id: number; title: string }> }>
/** 卷末那一章还是空白（新书自带的第1章、作者预留的空章）：新章稿子该填进去而不是追加在它后面。 */
async function blankChapterIn(bookId: string, volume: BookTree[number]) {
  const last = volume.children[volume.children.length - 1]
  if (!last) return null
  // 新建的章可能还没有正文记录（current 为空），和正文为空串一样都是空白章
  const current = await readBookChapter(bookId, last.id)
  if ((current?.textContent || '').trim()) return null
  return { id: last.id, title: last.title, version: Number(current?.localVersion || 0) }
}
/** 作者在前情核对卡上决定"不要这份候选 / 改稿留着"：记一笔搁置，右栏照常显示、仍可采用，写新章时不再当作上一章。 */
export async function dismissPiDraft(id: string): Promise<PiDraft> {
  if (isTauriRuntime()) return trackStorageWrite(() => piCommand<PiDraft>('dismiss_draft', { id }))
  const draft = await readDraft(id)
  if (!draft) throw new Error('草稿不存在')
  if (draft.appliedAt) throw new Error('草稿已采用，不能搁置')
  const next = { ...draft, dismissedAt: Date.now() }
  await writeDraft(next)
  return next
}
/**
 * 写新章前的前情：新章接在目标卷末，前面最近两章是谁；上一章有没有针对当前版本、没采用的改稿；
 * 有没有比最近一次采用更新、没采用也没搁置的新章候选。候选和改稿不定下来，新章不知道接在哪一版后面。
 */
async function chapterContinuity(bookId: string, tree: BookTree, volumeId: string) {
  const flat = tree.flatMap(v => v.children.map(c => ({ id: c.id, title: c.title })))
  const volumeIndex = tree.findIndex(v => String(v.id) === volumeId)
  const insertAt = tree.slice(0, volumeIndex + 1).reduce((count, v) => count + v.children.length, 0)
  const previous = flat.slice(Math.max(0, insertAt - 2), insertAt)
  const drafts = (await listPiDrafts(bookId)).filter(d => !d.appliedAt && !d.dismissedAt)
  const adoptedAt = (await listPiDrafts(bookId))
    .filter(d => d.kind === 'new_chapter' && d.appliedAt)
    .reduce((latest, d) => Math.max(latest, d.createdAt), 0)
  const candidates = drafts.filter((d): d is PiNewChapterDraft => d.kind === 'new_chapter' && d.createdAt > adoptedAt)
  const last = previous[previous.length - 1]
  let revisions: PiChapterDraft[] = []
  if (last) {
    const current = await readBookChapter(bookId, last.id)
    const version = Number(current?.localVersion || 0)
    revisions = drafts.filter((d): d is PiChapterDraft => d.kind === 'chapter' && d.chapterId === last.id && d.baseVersion === version)
  }
  return { previous, candidates, revisions }
}
/** 给扩展的核对结果：没问题就 ready；有问题就连卡上的问题、选项和每个选项对应的处理一起给出，选择由作者在卡上做。 */
function continuityReport(state: Awaited<ReturnType<typeof chapterContinuity>>) {
  const previous = state.previous.map(c => ({ chapterId: String(c.id), title: c.title }))
  if (state.candidates.length) {
    const newest = state.candidates[0]
    return {
      ready: false,
      previous,
      question: '上一章还没定下来',
      description: `有 ${state.candidates.length} 份新章节候选没采用：${state.candidates.map(d => `《${d.title}》`).join('、')}。接着写之前先定它算不算数。`,
      options: [
        { id: 'adopt', title: `采用《${newest.title}》，接在它后面写`, description: '这份候选成为正式章节' },
        { id: 'dismiss', title: '这些候选不要了，接着正式目录写', description: '候选留在右栏，不再当作上一章' },
        { id: 'stop', title: '先停下', description: '我去右栏处理' }
      ],
      resolutions: {
        adopt: { action: 'adopt', draftId: newest.id, revision: newest.revision ?? 0 },
        dismiss: { action: 'dismiss', draftIds: state.candidates.map(d => d.id) }
      }
    }
  }
  if (state.revisions.length) {
    const newest = state.revisions[0]
    const last = state.previous[state.previous.length - 1]
    return {
      ready: false,
      previous,
      question: `《${last?.title || ''}》有没采用的改稿`,
      description: '新章要接在哪一版后面，先定下来。',
      options: [
        { id: 'adopt', title: `采用改稿《${newest.title}》再写`, description: '改稿成为这一章的正式正文' },
        { id: 'keep', title: '按现在的正式版写', description: '改稿留在右栏，不再提醒' },
        { id: 'stop', title: '先停下', description: '我去右栏处理' }
      ],
      resolutions: {
        adopt: { action: 'adopt', draftId: newest.id, revision: newest.revision ?? 0 },
        keep: { action: 'dismiss', draftIds: state.revisions.map(d => d.id) }
      }
    }
  }
  return { ready: true, previous }
}
/** 作者在卡上的决定：采用某份草稿，或搁置几份。采用走和右栏同一条路。 */
async function resolveContinuity(resolution: Record<string, unknown>) {
  if (resolution.action === 'adopt' && typeof resolution.draftId === 'string') {
    const confirmation = await piCommand<PiDraftConfirmation>('prepare_adoption', { draftId: resolution.draftId, revision: resolution.revision })
    const saved = await applyPiDraft(resolution.draftId, confirmation)
    await notifyDraftApplied(saved)
    return
  }
  if (resolution.action === 'dismiss' && Array.isArray(resolution.draftIds)) {
    for (const id of resolution.draftIds) if (typeof id === 'string') await dismissPiDraft(id)
    return
  }
  throw new Error('前情核对的处理方式无效')
}
export async function savePiDraftEdit(
  id: string,
  content: string,
  expectedRevision?: number,
  origin: 'author' | 'supplied' = 'supplied'
): Promise<PiDraft> {
  const draft = await readDraft(id)
  if (!draft) throw new Error('草稿不存在')
  if (draft.appliedAt) {
    if (draft.content === content) return draft
    throw new Error('草稿已采用，不能再修改')
  }
  if (!content.trim() || content.length > 150000) throw new Error('草稿正文不能为空或超过 15 万字')
  const revision = expectedRevision ?? draft.revision ?? 0
  if (isTauriRuntime()) {
    return trackStorageWrite(() =>
      piCommand<PiDraft>('edit_draft', { id, content, expectedRevision: revision, origin })
    )
  }
  if (draft.content === content) return draft
  if ((draft.revision ?? 0) !== revision) throw new Error('草稿已更新，未覆盖其他编辑')
  draft.content = content
  draft.revision = revision + 1
  await writeDraft(draft)
  return draft
}
export async function preparePiDraftConfirmation(
  id: string,
  content: string,
  revision: number,
  origin: 'author'|'supplied'='supplied'
): Promise<PiDraftConfirmation> {
  const current = await readDraft(id)
  if (current?.appliedAt) {
    if (current.content !== content)
      throw new Error('这份草稿已经采用，当前编辑内容未覆盖已保存结果，请重新读取。')
    return piCommand<PiDraftConfirmation>('prepare_adoption', {
      draftId: id,
      revision: current.revision ?? 0
    })
  }
  const draft = await savePiDraftEdit(id, content, revision,origin)
  return piCommand<PiDraftConfirmation>('prepare_adoption', { draftId: id, revision: draft.revision ?? 0 })
}
function notifyChapterSaved(draft: PiDraft) {
  if (draft.kind === 'chapter' || draft.kind === 'new_chapter')
    window.dispatchEvent(
      new CustomEvent('ew-writing-chapter-content-refresh', {
        detail: {
          bookId: draft.bookId,
          chapterId: draft.chapterId,
          source: 'pi',
          contentVersion: draft.appliedVersion
        }
      })
    )
  window.dispatchEvent(
    new CustomEvent('ew-local-book-updated', {
      detail: { bookId: draft.kind === 'entity' ? draft.appliedBookId || draft.bookId : draft.bookId }
    })
  )
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
}
async function adoptChapter(ticket: PiAdoptionTicket): Promise<PiDraft> {
  let saved: PiDraft
  const key = `${ticket.draftId}:${ticket.revision}:${ticket.fingerprint}`
  uncertainSaves.set(key, ticket)
  try {
    saved = await piCommand<PiDraft>('adopt_draft', { ticket })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (message.startsWith('PI_ADOPTION_REJECTED:')) {
      uncertainSaves.delete(key)
      throw new Error(message.replace(/^PI_ADOPTION_REJECTED:\s*/, ''))
    }
    // IPC 回复丢失不是保存失败；只查原确认的回执，不换编号重新写。
    let status: { status: string; draft?: PiDraft } | undefined
    try {
      status = await piCommand('adoption_status', { ticket })
    } catch {
      /* 结果仍未知 */
    }
    if (status?.status === 'committed' && status.draft) saved = status.draft
    else throw new Error('保存结果尚未确认，请保留当前草稿并重试；重试会核对原保存结果，不重复写入。')
  }
  uncertainSaves.delete(key)
  notifyChapterSaved(saved)
  // 人物、设定、大纲变了：各对话上次读的资料作废，写新章前得重读
  if (saved.kind === 'entity' || saved.kind === 'outline') referenceBases.clear()
  return saved
}
export function applyPiDraft(id: string, confirmation?: PiDraftConfirmation): Promise<PiDraft> {
  const ticket = confirmation?.ticket
  if (confirmation && !ticket) return Promise.reject(new Error('缺少章节确认版本，请重新预览确认'))
  const key = ticket ? id + ':' + ticket.revision + ':' + ticket.fingerprint : id + ':current'
  const existing = applying.get(key)
  if (existing) return existing
  const pending = trackStorageWrite(async () => {
    if (ticket) {
      if (ticket.draftId !== id || confirmation?.draft.id !== id) throw new Error('采用目标与确认不一致')
      return adoptChapter(ticket)
    }
    const draft = await readDraft(id)
    if (!draft) throw new Error('草稿不存在')
    const prepared = await piCommand<PiDraftConfirmation>('prepare_adoption', {
      draftId: id,
      revision: draft.revision ?? 0
    })
    if (!prepared.ticket) throw new Error('采用确认缺失')
    return adoptChapter(prepared.ticket)
  }).finally(() => applying.delete(key))
  applying.set(key, pending)
  return pending
}
