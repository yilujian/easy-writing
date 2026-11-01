/** 微信协议层使用的 Pi 投影：不执行模型循环，不挂载对话组件，不读取旧 Agent 会话。 */
import { usePiWorkspace } from '@/views/AgentPi/use-pi-workspace'
import { piMessageText } from './conversation'
import { specFromDialog } from './questions'
import { piCommand } from './client'
import { applyPiDraft, listPiDrafts } from './platform-tools'
import { notifyDraftApplied } from './tasks'
import type {
  PiChatState,
  PiDraftConfirmation,
  PiQuestionAnswer,
  PiQuestionSpec
} from '@/types/agent-pi'
import type { AgentChoice, AgentMessage, AgentSessionView, CardAnswer } from '@/ai/channels/weixin/channel'

const confirmations = new Map<string, PiDraftConfirmation>()
const revisions = new Map<string, number>()
const receipts = new Map<string, AgentMessage[]>()
const bump = (id: string) => revisions.set(id, (revisions.get(id) || 0) + 1)
const pending = (chat: PiChatState) =>
  chat.question
    ? { id: chat.question.id, spec: chat.question.spec }
    : chat.dialog
      ? { id: String(chat.dialog.id), spec: specFromDialog(chat.dialog) }
      : null

function cardDescription(spec: PiQuestionSpec): string {
  const c = spec.card
  if (!c) return spec.description || ''
  if (c.type === 'batch-plan')
    return [
      spec.description,
      c.title,
      c.scope,
      ...c.goals.map((g, i) => `${i + 1}. ${g}`),
      `模型：${c.model}`
    ]
      .filter(Boolean)
      .join('\n')
  if (c.type === 'breakdown-plan')
    return [
      spec.description,
      c.plan.title,
      c.plan.scope,
      `共 ${c.plan.chapterCount} 章；已有 ${c.plan.reusable} 章结果`,
      ...c.plan.chapters,
      `模型：${c.plan.model}`
    ]
      .filter(Boolean)
      .join('\n')
  if (c.type === 'cover-brief')
    return [spec.description, c.summary, c.prompt, c.style, c.size, `模型：${c.model}`]
      .filter(Boolean)
      .join('\n')
  return [spec.description, `技能：${c.skill}`, `脚本：${c.script}`, `参数：${c.args.join(' ')}`, c.reason]
    .filter(Boolean)
    .join('\n')
}
function choiceOf(spec: PiQuestionSpec): AgentChoice {

  return {
    status: 'pending',
    kind: spec.kind === 'confirm' ? 'confirm' : spec.options.length ? (spec.multiple ? 'multi' : 'single') : 'input',
    question: spec.question,
    description: [cardDescription(spec), spec.afterAnswer === 'pause' ? '本次回答会保存，随后暂停；不会自动继续生成。' : ''].filter(Boolean).join('\n'),
    afterAnswer: spec.afterAnswer,
    options: spec.options,
    multiple: spec.multiple,
    allowFreeText: spec.allowFreeText,
    defaultOptionId: spec.defaultOptionId
  }
}
async function snapshot(chat: PiChatState): Promise<AgentSessionView> {
  const s = usePiWorkspace()
  if (!chat.running && !chat.connecting) await s.channelDrafts(chat.sessionId)
  const messages: AgentMessage[] = chat.messages.map((m, i) => ({
    id: `pi:${m.timestamp || 0}:${i}`,
    role: m.role,
    text: piMessageText(m)
  }))
  messages.push(...(receipts.get(chat.sessionId) || []))
  for (const d of chat.drafts)
    messages.push({ id: `draft:${d.id}:${d.revision || 0}`, role: 'artifact', artifactId: d.id })
  const card = pending(chat)
  const lastAssistant = [...chat.messages].reverse().find(m => m.role === 'assistant')
  const failure =
    chat.error || (chat.runControl.state === 'active' && lastAssistant?.stopReason === 'error' ? lastAssistant.errorMessage || '模型调用失败' : '')
  let status = card
    ? 'choice'
    : chat.running || chat.connecting || chat.settling || chat.pendingTasks
      ? 'running'
      : failure
        ? 'failed'
        : chat.runControl.state === 'paused' || chat.stopped
          ? 'paused'
          : 'completed'
  if (chat.runControl.state !== 'active' && !failure) messages.push({ id: `control:${chat.runControl.revision}`, role: 'assistant', text: chat.runControl.state === 'paused' ? '当前工作已暂停，回答和候选已保留。' : '当前阶段已结束，已有内容保留；可以发送新的要求。' })
  if (chat.runControl.state === 'ended' && !failure && !chat.running && !chat.connecting) status = 'completed'
  if (card) {
    messages.push({
      id: `question:${card.id}:${0}`,
      role: 'assistant',
      kind: 'choice',
      choice: choiceOf(card.spec)
    })
  } else if (status === 'completed') {
    const draft = [...chat.drafts].reverse().find(d => !d.appliedAt && !d.dismissedAt)
    if (draft) {
      const id = `adopt:${draft.id}:${draft.revision || 0}`
      if (!confirmations.has(id))
        confirmations.set(
          id,
          await piCommand<PiDraftConfirmation>('prepare_adoption', {
            draftId: draft.id,
            revision: draft.revision || 0
          })
        )
      messages.push({
        id,
        role: 'assistant',
        kind: 'choice',
        choice: {
          status: 'pending',
          kind: 'confirm',
          question: `采用《${draft.title}》？`,
          description:
            draft.kind === 'new_chapter'
              ? `保存到《${s.books.find(b => b.id === draft.bookId)?.title || '当前作品'}》的「${draft.volumeTitle}」卷末。候选全文随后以文件发送。`
              : '确认后保存这份候选；正文修改会保留原文历史。候选全文随后以文件发送。',
          options: [
            { id: 'adopt', title: '采用并保存' },
            { id: 'dismiss', title: '暂不采用' }
          ],
          allowFreeText: false
        }
      })
      status = 'choice'
    }
  }
  return {
    id: chat.sessionId,
    status,
    runId: `${chat.epoch}:${revisions.get(chat.sessionId) || 0}`,
    error: failure,
    messages,
    modelCode: chat.modelCode,
    references: chat.bookId
      ? [{ kind: 'book', bookId: chat.bookId, title: s.books.find(b => b.id === chat.bookId)?.title || '' }]
      : []
  }
}

function answerFor(choice: AgentChoice, given: CardAnswer): PiQuestionAnswer {
  return {
    selectedIds: given.selectedIds,
    selected: (choice.options || []).filter(o => given.selectedIds.includes(o.id)).map(o => o.title),
    text: given.text,
    inputs: given.inputs,
    ...(given.nextAction || choice.afterAnswer ? { nextAction: given.nextAction || choice.afterAnswer } : {}),
    cancelled: given.cancelled
  }
}

export async function piWeixinCommand<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = usePiWorkspace()
  const bookId = () =>
    String((args.references as Array<{ bookId?: string }> | undefined)?.find(r => r.bookId)?.bookId || '')
  if (action === 'create_session') {
    const chat = await s.channelSession(String(args.requestId), bookId(), String(args.modelCode || ''))
    return (await snapshot(chat)) as T
  }
  if (action === 'get_artifact') {
    const draft = (await listPiDrafts()).find(d => d.id === args.id)
    if (!draft) throw new Error('候选已删除')
    return {
      id: draft.id,
      title: draft.title,
      content: draft.content,
      kind: 'draft',
      bookTitle: s.books.find(b => b.id === draft.bookId)?.title || ''
    } as T
  }
  const chat = s.channelChat(String(args.sessionId || args.id))
  if (action === 'get_session') return (await snapshot(chat)) as T
  if (action === 'stop') {
    await s.channelStop(chat.sessionId)
    bump(chat.sessionId)
    return true as T
  }
  if (action === 'update_session') {
    await s.channelContext(chat.sessionId, { bookId: bookId() })
    return (await snapshot(chat)) as T
  }
  if (action !== 'run') throw new Error(`不支持的 Agent 微信操作：${action}`)
  if (args.inputKind !== 'answer') {
    await s.channelSend(chat.sessionId, String(args.text || ''), {
      bookId: bookId(),
      modelCode: String(args.modelCode || chat.modelCode)
    })
    return true as T
  }
  if (s.inputLocked) throw new Error('应用正在关闭或恢复，未接受微信确认')
  const before = await snapshot(chat)
  const shown = before.messages.find(m => m.choice?.status === 'pending')
  if (!shown || shown.id !== args.messageId) throw new Error('这张确认卡已改变，请查看最新问题后再选择')
  const given = args.answer as CardAnswer
  if (shown.id.startsWith('adopt:')) {
    const confirmation = confirmations.get(shown.id)
    if (!confirmation) throw new Error('候选确认已失效，请重新预览')
    if (given.selectedIds.includes('adopt')) {
      const saved = await applyPiDraft(confirmation.draft.id, confirmation)
      await notifyDraftApplied(saved)
      await s.reloadBooks()
      // 新建作品的绑定已由宿主原子写入；空闲后回读到微信会话。
      await s.channelSync(chat.sessionId)
    } else if (given.selectedIds.includes('dismiss') || given.cancelled) {
      await piCommand('dismiss_draft', { id: confirmation.draft.id })
    } else throw new Error('请明确选择采用或暂不采用')
    confirmations.delete(shown.id)
    bump(chat.sessionId)
    receipts.set(chat.sessionId, [
      ...(receipts.get(chat.sessionId) || []),
      {
        id: `receipt:${shown.id}`,
        role: 'assistant',
        text: given.selectedIds.includes('adopt')
          ? `已采用并保存《${confirmation.draft.title}》。`
          : `《${confirmation.draft.title}》暂不采用，候选仍保留在桌面右栏。`
      }
    ])
    await s.channelDrafts(chat.sessionId)
    return true as T
  }
  const q = pending(chat)
  if (!q) throw new Error('提问已结束')
  await s.channelAnswer(chat.sessionId, q.id, answerFor(shown.choice!, given))
  bump(chat.sessionId)
  return true as T
}
