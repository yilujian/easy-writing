import type { PiActivity, PiChatState, PiEvent, PiMessage, PiDraft, PiSessionHistory } from '@/types/agent-pi'
import { toolOperation, summarizeToolArgs, summarizeToolResult } from './tool-summaries'
import { draftBelongsToCall, draftIdFromResult } from './draft-references'
import { normalizeAnswer, normalizeQuestionSpec } from './questions'
import { parseSkillCommand } from './skills'
import type { PiQuestionAnswer, PiQuestionSpec } from '@/types/agent-pi'

export const piMessageText = (message: PiMessage) =>
  typeof message.content === 'string'
    ? message.content
    : (message.content || [])
        .filter(part => part.type === 'text')
        .map(part => part.text || '')
        .join('\n')

const ATTACHMENT_MARK = /\n*<yichuang-(attachment|event|ref)>[\s\S]*?<\/yichuang-\1>/g
/** 去掉聊天附件、平台事件、资料引用标记和技能命令前缀；标题、搜索和起名都不该看到内部标记。 */
export const stripAttachmentMarker = (text: string) =>
  (text.startsWith('/skill:') ? (parseSkillCommand(text)?.text ?? text.replace(/^\/skill:\S+\s*/, '')) : text)
    .replace(/^<skill name="[^"]*"[^>]*>[\s\S]*?<\/skill>\s*/, '')
    .replace(ATTACHMENT_MARK, ' ')

/** 平台事件消息：由界面代作者发出，比如任务完成后让 Agent 接着说结论；标记只给界面识别。 */
export interface PiPlatformEvent {
  kind: string
  taskId: string
  title: string
  scope?: string
  [key: string]: unknown
}
export const platformEventMessage = (text: string, event: PiPlatformEvent) =>
  `${text}\n\n<yichuang-event>${JSON.stringify(event)}</yichuang-event>`
export const breakdownEventMessage = (task: { id: string; title: string; scope: string }) =>
  platformEventMessage(
    `《${task.title}》${task.scope} 的拆书任务已经完成。请用 read_breakdown 读取范围报告和需要的章节分析，给出这次拆解的结论，分清原文事实、分析判断和可借鉴写法。`,
    { kind: 'breakdown_completed', taskId: task.id, title: task.title, scope: task.scope }
  )
export function parseEventMessage(text: string): { text: string; event: PiPlatformEvent | null } {
  const match = text.match(/\n\n<yichuang-event>([^\n]*)<\/yichuang-event>$/)
  if (!match) return { text, event: null }
  try {
    const event = JSON.parse(match[1])
    if (typeof event?.kind !== 'string' || typeof event.taskId !== 'string') return { text, event: null }
    return { text: text.slice(0, match.index), event: event as PiPlatformEvent }
  } catch {
    return { text, event: null }
  }
}
/** 平台事件的种类表：聊天里那枚小标签的文字，以及这一轮是不是接在启动任务的那条回复后面说的。
 *  任务完成（拆书、蒸馏、封面）是同一个问题的后半段答案，并进去；批量写作每章都是独立的交付，各自一条。 */
const EVENT_KINDS: Record<string, { chip: (target: string) => string; continues: boolean }> = {
  breakdown_completed: { chip: target => `${target} 拆完，自动接着分析`, continues: true },
  distillation_completed: { chip: target => `${target} 蒸馏完成，自动接着说`, continues: true },
  cover_completed: { chip: target => `${target} 封面已生成`, continues: true },
  batch_chapter: { chip: target => `${target} 开始写下一章`, continues: false },
  batch_completed: { chip: target => `${target} 批量写作完成`, continues: false }
}
/** 聊天里那枚事件小标签的文字。 */
export function eventChipText(event: PiPlatformEvent) {
  const target = `《${event.title}》${event.scope || ''}`
  return EVENT_KINDS[event.kind]?.chip(target) ?? `${target} 平台事件`
}
export const eventContinues = (event: PiPlatformEvent) => EVENT_KINDS[event.kind]?.continues ?? false
/** 侧栏与页面标题用的会话名：去掉附件标记、压缩空白，最多 28 字。 */
export const sessionTitleFrom = (text: string) =>
  stripAttachmentMarker(text).replace(/\s+/g, ' ').trim().slice(0, 28)

export { summarizeToolArgs, summarizeToolResult } from './tool-summaries'
export function formatDuration(ms: number) {
  if (ms < 1000) return '不到 1 秒'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`
}

function messageOperation(messages: PiMessage[], message: PiMessage) {
  if (!message.toolCallId) return message.toolName
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].content
    if (!Array.isArray(parts)) continue
    const call = parts.find(part => part.type === 'toolCall' && part.id === message.toolCallId)
    if (call) return toolOperation(call.name, call.arguments)
  }
  return message.toolName
}

export function projectPiMessage(message: PiMessage, operation = message.toolName): PiMessage {
  if (message.role === 'toolResult') {
    const draftId = draftIdFromResult(message.details)
    return {
      role: message.role,
      timestamp: message.timestamp,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: message.isError,
      summary: summarizeToolResult(operation, message),
      content: message.isError ? message.content : [],
      ...(message.details?.supersededByAuthorInput
        ? { details: { supersededByAuthorInput: true } }
        : draftId
        ? { details: { draftId } }
        : message.details?.questionSpec
          ? { details: { questionSpec: message.details.questionSpec, answer: normalizeAnswer(message.details.answer ? message.details.answer as Record<string, unknown> : message.details) } }
        : message.toolName === 'ask_author' && message.details
          ? { details: { answer: normalizeAnswer(message.details.answer ? (message.details.answer as Record<string, unknown>) : message.details) } }
          : {})
    }
  }
  return {
    ...message,
    content:
      typeof message.content === 'string'
        ? message.content
        : (message.content || []).map(part => ({ ...part }))
  }
}
export const projectPiHistory = (messages: PiMessage[]) => {
  const operations = new Map<string, string | undefined>()
  return messages.filter(message => ['user', 'assistant', 'toolResult'].includes(message.role)).map(message => {
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content) if (part.type === 'toolCall' && part.id)
        operations.set(part.id, toolOperation(part.name, part.arguments))
    return projectPiMessage(message, operations.get(message.toolCallId || '') || message.toolName)
  })
}

/** 沿原生 leaf/parentId 读取当前分支，包含压缩前的消息，不混入其他分支。 */
export function projectPiEntries(history: PiSessionHistory): PiMessage[] {
  const entries = new Map(history.entries.map(entry => [entry.id, entry]))
  const chain: PiSessionHistory['entries'] = [],
    seen = new Set<string>()
  let id = history.leafId
  while (id) {
    if (seen.has(id)) throw new Error('Agent 会话历史关联异常')
    seen.add(id)
    const entry = entries.get(id)
    if (!entry) throw new Error('Agent 会话历史不完整')
    chain.push(entry)
    id = entry.parentId
  }
  chain.reverse()
  const retryOmissions = new Set(chain.filter(e => e.type === 'context_edit' && e.replacement === null).map(e => e.targetId))
  const messages = chain.flatMap((entry, index) => {
    if (entry.type === 'custom' && entry.customType === 'yichuang-ranking-choice' && entry.data?.standalone === true) {
      const data = entry.data
      return [{role:'toolResult' as const,toolName:'refresh_rankings',toolCallId:String(data.operationId)+':confirm',content:'已记录本次刷新选择。',
        timestamp:entry.timestamp?Date.parse(entry.timestamp):undefined,details:{questionSpec:data.questionSpec,answer:data.answer}}]
    }
    if (entry.type === 'custom_message' && ['yichuang-clarification','yichuang-ranking-result','yichuang-plan-receipt','yichuang-operation-paused'].includes(entry.customType || '') && entry.display && typeof entry.content === 'string')
      return [{ role: 'assistant' as const, content: entry.content, timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined, ...(entry.details ? {details:entry.details} : {}) }]
    if (entry.type !== 'message' || !entry.message) return []
    const message = entry.message
    if (!message.errorMessage || !retryOmissions.has(entry.id)) return [message]
    let recovered = false
    for (const next of chain.slice(index + 1)) {
      if (next.message?.role === 'user') break
      if (next.message?.role === 'assistant' && next.message.stopReason !== 'error' && next.message.stopReason !== 'aborted') { recovered = true; break }
    }
    return [{ ...message, errorRecovered: recovered }]
  })
  return projectPiHistory(messages)
}

/** 重试只更新显示状态，不重放任何工具或候选写入。 */
export function receivePiRetry(chat: Pick<PiChatState, 'messages' | 'retry'>, event: PiEvent) {
  if (event.type === 'auto_retry_start') {
    chat.retry = { attempt: Number(event.attempt || 1), maxAttempts: Number(event.maxAttempts || 1) }
    const failed = [...chat.messages].reverse().find(m => m.role === 'assistant' && m.errorMessage && !m.errorRecovered)
    if (failed) failed.errorRetrying = true
  } else if (event.type === 'auto_retry_end') {
    for (const message of chat.messages) if (message.errorRetrying) {
      message.errorRetrying = false
      message.errorRecovered = event.success === true
    }
    chat.retry = undefined
  }
}

type StreamingChat = Pick<PiChatState, 'messages' | 'streamingIndex'> &
  Partial<Pick<PiChatState, 'thinkingMs' | 'thinkingStartedAt'>>

/** Pi 1.3 RPC 的 message_update 只有增量，没有累计 message/partial。 */
export function receivePiMessage(chat: StreamingChat, event: PiEvent) {
  if (event.type === 'message_update' && !event.message) {
    const update = event.assistantMessageEvent
    const message = chat.streamingIndex == null ? undefined : chat.messages[chat.streamingIndex]
    if (!update || message?.role !== 'assistant' || !Array.isArray(message.content)) return
    const index = update.contentIndex
    if (index == null || !Number.isSafeInteger(index) || index < 0) return
    if (update.type === 'text_start') message.content[index] = { type: 'text', text: '' }
    if (update.type === 'text_delta') {
      const part = message.content[index] || (message.content[index] = { type: 'text', text: '' })
      if (part.type === 'text') part.text = (part.text || '') + (update.delta || '')
    }
    if (update.type === 'text_end') message.content[index] = { type: 'text', text: update.content || '' }
    if (update.type === 'toolcall_start')
      message.content[index] = { type: 'toolCall', id: update.id, name: update.toolName }
    if (update.type === 'toolcall_end' && update.toolCall) message.content[index] = { ...update.toolCall }
    // 思考块逐字进过程区；用时由界面按收到起止事件的时刻计算，Pi 不保存这个时间。
    if (update.type === 'thinking_start' || update.type === 'thinking_delta') {
      const part = message.content[index] || (message.content[index] = { type: 'thinking', thinking: '' })
      if (part.type === 'thinking' && update.type === 'thinking_delta')
        part.thinking = (part.thinking || '') + (update.delta || '')
      if (chat.thinkingStartedAt == null) chat.thinkingStartedAt = Date.now()
    }
    if (update.type === 'thinking_end') {
      message.content[index] = { type: 'thinking', thinking: update.content || '' }
      if (chat.thinkingStartedAt != null && chat.thinkingMs) {
        const key = String(message.timestamp ?? '')
        chat.thinkingMs[key] = (chat.thinkingMs[key] || 0) + Math.max(0, Date.now() - chat.thinkingStartedAt)
      }
      chat.thinkingStartedAt = null
    }
    return
  }
  const raw = event.message
  const message = raw && typeof raw !== 'string' && raw.role === 'custom'
    ? ['yichuang-clarification','yichuang-ranking-result','yichuang-plan-receipt','yichuang-operation-paused'].includes(raw.customType) && raw.display ? { role: 'assistant' as const, content: raw.content, timestamp: raw.timestamp, ...(raw.details ? {details:raw.details} : {}) } : undefined
    : raw
  if (!message || typeof message === 'string' || !['user', 'assistant', 'toolResult'].includes(message.role))
    return
  let index =
    message.timestamp == null
      ? -1
      : chat.messages.findIndex(
          m =>
            m.role === message.role &&
            m.timestamp === message.timestamp &&
            m.toolCallId === message.toolCallId
        )
  if (
    index < 0 &&
    event.type !== 'message_start' &&
    message.role === 'assistant' &&
    chat.streamingIndex != null
  )
    index = chat.streamingIndex
  if (index < 0) {
    index = chat.messages.length
    chat.messages.push(projectPiMessage(message, messageOperation(chat.messages, message)))
  } else chat.messages[index] = projectPiMessage(message, messageOperation(chat.messages, message))
  if (message.role === 'assistant') chat.streamingIndex = event.type === 'message_end' ? null : index
}

export interface PiTurnStep {
  kind: 'thinking' | 'tool'
  id: string
  text?: string
  name?: string
  argsSummary?: string
  status?: string
  progress?: string
  resultSummary?: string
  durationMs?: number
  isError?: boolean
  /** 这次调用针对的任务（read_breakdown/control_task 的 taskId）：别处启动的任务在这里被读过，任务卡就放在这一轮。 */
  taskId?: string
}
export interface PiTurnQuestion {
  id: string
  spec: PiQuestionSpec
  answer: PiQuestionAnswer | null
}
/** 主流程按发生顺序排列：模型写的每段文字和它问作者的每张卡都在这里，不藏进过程区。 */
export type PiTurnSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'question'; id: string; spec: PiQuestionSpec; answer: PiQuestionAnswer | null }
/** 一条回复里的一轮：作者的话开始第一轮；任务完成后平台代发的事件开始的那一轮，接在启动任务的同一条回复里。 */
export interface PiTurnRound {
  id: string
  /** 开始这一轮的平台事件；作者自己说的话开始的轮次为空。 */
  event: PiPlatformEvent | null
  /** 过程区按发生顺序：思考与工具。 */
  steps: PiTurnStep[]
  thinkingMs: number
  segments: PiTurnSegment[]
  answer: string
  drafts: PiDraft[]
  error: string
  recoveredErrors?: string[]
  running: boolean
  stopped: boolean
}
/** 聊天里的一条问答：作者的话，加上模型为它做的一轮或几轮；各字段是所有轮次的汇总。 */
export interface PiTurn {
  id: string
  user?: PiMessage
  rounds: PiTurnRound[]
  segments: PiTurnSegment[]
  /** 这一轮问过作者的卡片，按先后排列；answer 为空表示还没回答。 */
  questions: PiTurnQuestion[]
  progress: string[]
  answer: string
  error: string
  operations: PiActivity[]
  steps: PiTurnStep[]
  thinkingMs: number
  drafts: PiDraft[]
  running: boolean
  stopped: boolean
}
/** 判断事件该接在哪条回复后面只需要任务是由哪次工具调用（或哪条作者消息）启动的。 */
export interface PiTaskOwner {
  id: string
  callId?: string | null
  anchor?: number | null
}
interface TurnGroup {
  id: string
  user?: PiMessage
  messages: PiMessage[]
}
export function buildPiTurns(
  messages: PiMessage[],
  live: PiActivity[],
  running: boolean,
  stopped: boolean,
  drafts: PiDraft[] = [],
  timings: Record<string, number> = {},
  tasks: PiTaskOwner[] = []
): PiTurn[] {
  const groups: TurnGroup[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user')
      groups.push({ id: `turn:${message.timestamp ?? index}:${index}`, user: message, messages: [] })
    else if (message.role === 'assistant' || message.role === 'toolResult') {
      if (!groups.length) groups.push({ id: `turn:${message.timestamp ?? index}`, messages: [] })
      groups[groups.length - 1].messages.push(message)
    }
  }
  const byId = new Map(drafts.map(draft => [draft.id, draft]))
  const calls = (m: PiMessage) => (Array.isArray(m.content) ? m.content.filter(p => p.type === 'toolCall') : [])
  const isProgress = (m: PiMessage) => m.stopReason === 'toolUse' || calls(m).length > 0
  /** 一组消息（一条作者消息或一个平台事件之后、下一条之前）换算成一轮。 */
  const buildRound = (group: TurnGroup, last: boolean) => {
    const assistants = group.messages.filter(m => m.role === 'assistant')
    const final = assistants[assistants.length - 1]
    const answer = final && !isProgress(final) ? piMessageText(final) : ''
    const operations = new Map<string, PiActivity>()
    const interrupted = assistants.some(m => m.stopReason === 'aborted') || (last && stopped)
    const pendingStatus = last && running ? '进行中' : interrupted ? '已停止' : '未完成'
    const steps: PiTurnStep[] = []
    const toolSteps = new Map<string, PiTurnStep>()
    const segments: PiTurnSegment[] = []
    const questions = new Map<string, PiTurnQuestion>()
    for (const [position, message] of group.messages.entries()) {
      if (message.role === 'assistant') {
        const parts = Array.isArray(message.content)
          ? message.content
          : [{ type: 'text', text: message.content }]
        parts.forEach((part, i) => {
          const id = `${message.timestamp ?? position}:${i}`
          if (part.type === 'thinking') {
            if (!(part.thinking || '').trim()) return
            steps.push({
              kind: 'thinking',
              id,
              text: part.thinking,
              durationMs: timings[String(message.timestamp ?? '')]
            })
          } else if (part.type === 'text') {
            if ((part.text || '').trim()) segments.push({ kind: 'text', id, text: part.text || '' })
          } else if (part.type === 'toolCall' && part.id) {
            const step: PiTurnStep = {
              kind: 'tool',
              id: part.id,
              name: toolOperation(part.name, part.arguments) || '',
              argsSummary: summarizeToolArgs(part.name, part.arguments),
              status: pendingStatus,
              ...(typeof part.arguments?.taskId === 'string' ? { taskId: part.arguments.taskId } : {})
            }
            steps.push(step)
            toolSteps.set(part.id, step)
            operations.set(part.id, { id: part.id, name: toolOperation(part.name, part.arguments) || '', status: pendingStatus })
            if (part.name === 'ask_author') {
              const question: PiTurnQuestion = { id: part.id, spec: normalizeQuestionSpec(part.arguments), answer: null }
              questions.set(part.id, question)
              segments.push({ kind: 'question', id: part.id, spec: question.spec, answer: null })
            }
          }
        })
      } else if (message.role === 'toolResult' && message.toolCallId) {
        if (message.details?.questionSpec && !questions.has(message.toolCallId)) {
          const spec = normalizeQuestionSpec(message.details.questionSpec as Record<string, unknown>)
          questions.set(message.toolCallId, { id: message.toolCallId, spec, answer: null })
          segments.push({ kind: 'question', id: message.toolCallId, spec, answer: null })
        }
        const status = message.details?.supersededByAuthorInput ? '已撤销' : message.isError ? '未完成' : '已完成'
        operations.set(message.toolCallId, {
          id: message.toolCallId,
          name: message.toolName || operations.get(message.toolCallId)?.name || '',
          status
        })
        const step = toolSteps.get(message.toolCallId)
        if (step) {
          step.status = status
          step.isError = !!message.isError
          step.resultSummary = message.summary ?? summarizeToolResult(step.name, message)
        }
        const asked = questions.get(message.toolCallId)
        if (asked) {
          asked.answer =
            (message.details?.answer as PiQuestionAnswer | undefined) ||
            (message.isError ? { selected: [], selectedIds: [], cancelled: true } : null)
          const segment = segments.find(item => item.kind === 'question' && item.id === message.toolCallId)
          if (segment && segment.kind === 'question') segment.answer = asked.answer
        }
      }
    }
    if (last)
      for (const activity of live) {
        operations.set(activity.id, activity)
        const step = toolSteps.get(activity.id)
        const patch = {
          status: activity.status,
          progress: activity.progress,
          ...(activity.durationMs != null ? { durationMs: activity.durationMs } : {}),
          ...(activity.resultSummary ? { resultSummary: activity.resultSummary } : {}),
          ...(activity.isError != null ? { isError: activity.isError } : {})
        }
        if (step) Object.assign(step, patch)
        else {
          const fresh: PiTurnStep = {
            kind: 'tool',
            id: activity.id,
            name: activity.name,
            argsSummary: summarizeToolArgs(activity.name, activity.args),
            ...(typeof activity.args?.taskId === 'string' ? { taskId: activity.args.taskId } : {}),
            ...patch
          }
          steps.push(fresh)
          toolSteps.set(activity.id, fresh)
        }
      }
    const documents = new Map<string, PiDraft>()
    // 一轮内同一份候选只挂一张卡；改候选（带 draftId 重交）的那一轮也挂它的卡，作者在当前位置就能点开看改后的稿
    const attach = (draft?: PiDraft) => {
      if (draft && !documents.has(draft.id)) documents.set(draft.id, draft)
    }
    for (const message of group.messages) {
      const draftId = message.role === 'toolResult' ? draftIdFromResult(message.details) : undefined
      if (draftId) attach(byId.get(draftId))
      // 正文编号按作者轮次生成，来源另存调用编号；其他候选直接使用会话与调用编号。
      for (const call of calls(message))
        if (call.id)
          for (const draft of drafts) if (draftBelongsToCall(draft, call.id)) attach(draft)
    }
    const round: PiTurnRound = {
      id: group.id,
      event: group.user ? parseEventMessage(piMessageText(group.user)).event : null,
      steps,
      thinkingMs: steps.reduce((sum, step) => sum + (step.kind === 'thinking' ? step.durationMs || 0 : 0), 0),
      segments,
      answer,
      drafts: [...documents.values()],
      error: assistants
        .filter(m => m.stopReason !== 'aborted' && !m.errorRecovered && !m.errorRetrying)
        .map(m => m.errorMessage || '')
        .filter(Boolean)
        .slice(-1)
        .join('\n'),
      recoveredErrors: assistants.filter(m => m.errorRecovered || m.errorRetrying).map(m => m.errorMessage || '').filter(Boolean),
      running: last && running,
      stopped: interrupted
    }
    return {
      round,
      questions: [...questions.values()],
      operations: [...operations.values()],
      progress: assistants
        .filter(m => m !== final || isProgress(m))
        .map(piMessageText)
        .filter(Boolean)
    }
  }
  type Built = ReturnType<typeof buildRound>
  const taskById = new Map(tasks.map(task => [task.id, task]))
  /** 这条回复里是否启动了该任务：按启动它的工具调用，没有记调用时按发起它的作者消息。 */
  const startedHere = (turn: { user?: PiMessage; built: Built[] }, taskId: string) => {
    const task = taskById.get(taskId)
    if (!task) return false
    if (task.callId) return turn.built.some(item => item.operations.some(o => o.id === task.callId))
    return task.anchor != null && turn.user?.timestamp === task.anchor
  }
  const turns: Array<{ id: string; user?: PiMessage; built: Built[] }> = []
  for (const [index, group] of groups.entries()) {
    const built = buildRound(group, index === groups.length - 1)
    const previous = turns[turns.length - 1]
    const event = built.round.event
    if (event && eventContinues(event) && previous && startedHere(previous, event.taskId)) previous.built.push(built)
    else turns.push({ id: group.id, user: group.user, built: [built] })
  }
  return turns.map(turn => {
    const rounds = turn.built.map(item => item.round)
    const tail = rounds[rounds.length - 1]
    return {
      id: turn.id,
      user: turn.user,
      rounds,
      segments: rounds.flatMap(round => round.segments),
      questions: turn.built.flatMap(item => item.questions),
      progress: turn.built.flatMap(item => item.progress),
      answer: tail.answer,
      error: rounds.map(round => round.error).filter(Boolean).join('\n'),
      operations: turn.built.flatMap(item => item.operations),
      steps: rounds.flatMap(round => round.steps),
      thinkingMs: rounds.reduce((sum, round) => sum + round.thinkingMs, 0),
      drafts: rounds.flatMap(round => round.drafts),
      running: tail.running,
      stopped: rounds.some(round => round.stopped)
    }
  })
}

/**
 * 每一轮该放哪些任务卡。任务卡是任务的入口（进度、暂停、查看报告），放的位置按任务和对话的真实关系定：
 * 1. 在这条对话里启动的，放在启动它的那一轮（按启动它的工具调用；没记调用的按发起它的作者消息放第一轮）；
 * 2. 别处（其他对话、拆书工作台）启动而这里读过结果的，放在第一次读它的那一轮，只放一次；
 * 3. 本对话的任务两条都对不上（旧记录）的，交给界面放在末尾；其他对话的任务没读过就不显示。
 */
export function placeTasks<T extends PiTaskOwner & { sessionId: string }>(turns: PiTurn[], tasks: T[], sessionId: string) {
  const byRound = new Map<string, T[]>()
  const unplaced: T[] = []
  const put = (roundId: string, task: T) => byRound.set(roundId, [...(byRound.get(roundId) || []), task])
  for (const task of tasks) {
    let placed = false
    for (const turn of turns) {
      const started = task.callId
        ? turn.rounds.find(round => round.steps.some(step => step.kind === 'tool' && step.id === task.callId))
        : task.anchor != null && turn.user?.timestamp === task.anchor
          ? turn.rounds[0]
          : undefined
      if (started) {
        put(started.id, task)
        placed = true
        break
      }
    }
    if (!placed)
      for (const turn of turns) {
        const read = turn.rounds.find(round => round.steps.some(step => step.taskId === task.id))
        if (read) {
          put(read.id, task)
          placed = true
          break
        }
      }
    if (!placed && task.sessionId === sessionId) unplaced.push(task)
  }
  return { byRound, unplaced }
}
