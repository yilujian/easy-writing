import { reactive } from 'vue'
import { isTauriRuntime } from '@/storage'
import { writingCommand } from '@/writing-service/client'
import { piWeixinCommand as agentCommand } from '@/agent-pi/weixin-adapter'
import { safeFileName, textToBase64 } from '@/writing-service/media'
import { appSettings, flushAppSettings } from '@/storage/app-settings'
import { getWeixinSession, setWeixinCurrentBook } from '@/storage/local-weixin-bot'
import { nowIso } from '@/storage/local-library-utils'
import {
  listenWeixinMessages,
  listenWeixinStatus,
  weixinBotAck,
  weixinBotAttach,
  weixinBotSendMedia,
  weixinBotSendText,
  weixinBotSendTyping,
  weixinBotStart,
  weixinBotStatus,
  type WeixinBotStatus,
  type WeixinInboundMessage,
  type WeixinMediaPayload,
} from './bridge'
import { parseWeixinCommand, WEIXIN_HELP_TEXT, type WeixinCommand } from './commands'
import { startWeixinNotifier, stopWeixinNotifier } from './notify'
import { markdownToPlainText, splitForWeixin } from './render'
import { appendWeixinLog, updateWeixinLog, type WeixinLogInput, type WeixinLogRoute, type WeixinLogStep } from '@/storage/local-weixin-log'
import { previewText, weixinLog } from './logfile'

/**
 * 微信通道适配器：微信是 Agent 的一个通道，只做收发和渲染。
 *
 * 入站消息经 Pi 适配器进入独立微信会话，桌面 Agent(Pi版本) 可查看同一段原生历史；
 * 回复与引导卡由 Pi 产生，适配器投影为通道消息；这里渲染纯文本和编号，并把作者的选择交回 Pi。
 * 工具和写入仍走 Pi 平台能力；通道只解析卡片回答，不识别业务意图。
 * 主动推送（自动生文完成等）由 notify.ts 负责，推不出去的通知借作者下一条消息补发。
 * 每条消息的来往仍记两份：对话账本（设置页回看）与技术日志文件（排障用）。
 */

export interface WeixinChannelState {
  started: boolean
  processing: boolean
  queued: number
  lastHandledAt: string
  lastError: string
  status: WeixinBotStatus | null
  /** 对话账本有新写入就 +1：设置页据此刷新列表 */
  logVersion: number
}

export const weixinChannelState = reactive<WeixinChannelState>({
  started: false,
  processing: false,
  queued: 0,
  lastHandledAt: '',
  lastError: '',
  status: null,
  logVersion: 0,
})

const QUEUE_LIMIT = 5
/** "正在输入"状态的刷新间隔；服务端会自动过期，处理长任务时要续 */
const TYPING_INTERVAL_MS = 10_000
/** 一轮 Agent 运行最多等多久；超过就告诉作者仍在进行，结果稍后推送 */
const RUN_WAIT_MS = 10 * 60_000
const SETTLE_POLL_MS = 1500
/** 章节候选先发开头预览，全文作为文件发 */
const PREVIEW_CHARS = 300
const SESSION_EPOCH_KEY = 'ew-weixin-agent-session-epoch'

const queue: WeixinInboundMessage[] = []
let pumping = false
let unlistenMessage: (() => void) | null = null
let unlistenStatus: (() => void) | null = null
let unlistenSession: (() => void) | null = null

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error || '未知错误'))

// ---------------------------------------------------------------------------
// 宿主里的会话、消息、卡片、成果（只声明这里用到的字段）
// ---------------------------------------------------------------------------

interface AgentOption {
  id: string
  title: string
  description?: string
  input?: { label?: string; placeholder?: string }
}

interface AgentStep {
  key: string
  question: string
  options?: AgentOption[]
  multiple?: boolean
  required?: boolean
}

export interface AgentChoice {
  afterAnswer?: 'continue' | 'pause'
  kind?: string
  question?: string
  description?: string
  options?: AgentOption[]
  status: string
  allowFreeText?: boolean
  multiple?: boolean
  defaultOptionId?: string
  steps?: AgentStep[]
  artifactIds?: string[]
}

export interface AgentMessage {
  id: string
  runId?: string
  role: string
  text?: string
  kind?: string
  choice?: AgentChoice
  /** 宿主记在卡片消息上的问题与作答规则：能否打字、多选、分步问答、对比成果 */
  prompt?: Partial<AgentChoice> & { defaultOptionId?: string }
  artifactId?: string
}

interface AgentReferenceView {
  kind?: string
  bookId?: string
  title?: string
}

export interface AgentSessionView {
  id: string
  status: string
  runId?: string
  error?: string
  messages: AgentMessage[]
  pendingInputs?: unknown[]
  references?: AgentReferenceView[]
  modelCode?: string
}

interface AgentArtifactView {
  id: string
  kind: string
  title?: string
  content?: string
  bookTitle?: string
}

interface LocalBook {
  id: number | string
  title: string
}

// ---------------------------------------------------------------------------
// 记录：对话账本 + 技术日志
// ---------------------------------------------------------------------------

interface MessageTrace {
  messageId: string
  /** 账本写失败时为 0：后续只写技术日志 */
  entryId: number
  startedAt: number
  route: WeixinLogRoute
  steps: WeixinLogStep[]
  model: string
  note: string
}

const traces = new Map<string, MessageTrace>()
let logWarned = false

const warnLogFailure = (error: unknown) => {
  if (!logWarned) console.warn('[微信助手] 对话账本写入失败，后续只记技术日志', error)
  logWarned = true
  weixinLog('warn', 'log-write-failed', { error: describeError(error) })
}

const bumpLogVersion = () => {
  weixinChannelState.logVersion += 1
}

const logEntry = async (input: WeixinLogInput) => {
  try {
    await appendWeixinLog(input)
    bumpLogVersion()
  } catch (error) {
    warnLogFailure(error)
  }
}

const traceOf = (message: WeixinInboundMessage) => traces.get(message.messageId) || null

const openTrace = async (message: WeixinInboundMessage): Promise<MessageTrace> => {
  const trace: MessageTrace = { messageId: message.messageId, entryId: 0, startedAt: Date.now(), route: 'system', steps: [], model: '', note: '' }
  traces.set(message.messageId, trace)
  if (traces.size > 200) traces.delete(traces.keys().next().value!)
  weixinLog('info', 'inbound', { messageId: message.messageId, kind: message.kind, from: message.fromUserId, text: previewText(message.text) })
  try {
    const entry = await appendWeixinLog({ direction: 'in', kind: message.kind, text: message.text, route: 'system', ok: true })
    trace.entryId = entry.id
    bumpLogVersion()
  } catch (error) {
    warnLogFailure(error)
  }
  return trace
}

const closeTrace = async (trace: MessageTrace, error = '') => {
  const durationMs = Date.now() - trace.startedAt
  weixinLog(error ? 'error' : 'info', 'handled', {
    messageId: trace.messageId,
    route: trace.route,
    durationMs,
    steps: trace.steps.map(step => `${step.tool}:${step.status}`),
    ...(trace.model ? { model: trace.model } : {}),
    ...(trace.note ? { note: trace.note } : {}),
    ...(error ? { error } : {}),
  })
  if (!trace.entryId) return
  try {
    await updateWeixinLog(trace.entryId, {
      route: trace.route,
      steps: trace.steps,
      durationMs,
      ...(trace.model ? { model: trace.model } : {}),
      ...(trace.note ? { note: trace.note } : {}),
      ...(error ? { ok: false, error } : {}),
    })
    bumpLogVersion()
  } catch (logError) {
    warnLogFailure(logError)
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** Pi 状态事件只用于叫醒等待中的轮询，不以事件代替持久化会话状态。 */
let wake: (() => void) | null = null
const listenAgentSessions = async () => {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<{record:{type:string}}>('pi-event', event => {
    wake?.()
    if (['agent_settled','tool_execution_start','extension_ui_request'].includes(event.payload.record.type)) scheduleFollowup()
  })
}

export const startWeixinChannel = async () => {
  if (!isTauriRuntime() || weixinChannelState.started) return
  weixinChannelState.started = true
  weixinLog('info', 'channel-start')
  try {
    unlistenStatus = await listenWeixinStatus(status => {
      logStatusChange(weixinChannelState.status, status)
      weixinChannelState.status = status
    })
    unlistenMessage = await listenWeixinMessages(enqueue)
    unlistenSession = await listenAgentSessions().catch(() => null)
    // 先挂监听再 attach：attach 之前到达的消息由 Rust 暂存，这里一次取走，不丢不重
    const pending = await weixinBotAttach()
    if (pending.length) weixinLog('info', 'attach', { pending: pending.length })
    pending.forEach(enqueue)
    const status = await weixinBotStart()
    logStatusChange(weixinChannelState.status, status)
    weixinChannelState.status = status
    startWeixinNotifier()
  } catch (error) {
    weixinChannelState.lastError = describeError(error)
    weixinLog('error', 'channel-start-failed', { error: describeError(error) })
  }
}

/** 连接状态或错误变了才记：Rust 侧心跳时也会推状态，原样全记会刷屏 */
const logStatusChange = (previous: WeixinBotStatus | null, next: WeixinBotStatus) => {
  if (previous?.state === next.state && previous?.lastError === next.lastError && previous?.bound === next.bound) return
  weixinLog(next.state === 'error' || next.state === 'stale_token' ? 'warn' : 'info', 'status', {
    state: next.state,
    bound: next.bound,
    pending: next.pendingCount,
    pushAvailable: next.pushAvailable,
    ...(next.lastError ? { error: next.lastError } : {}),
  })
}

export const stopWeixinChannel = () => {
  if (followupTimer) clearTimeout(followupTimer)
  followupTimer = null
  followup = null
  weixinLog('info', 'channel-stop')
  stopWeixinNotifier()
  unlistenMessage?.()
  unlistenStatus?.()
  unlistenSession?.()
  unlistenMessage = null
  unlistenStatus = null
  unlistenSession = null
  weixinChannelState.started = false
}

export const refreshWeixinStatus = async () => {
  weixinChannelState.status = await weixinBotStatus()
  return weixinChannelState.status
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

/** 最近接过的消息编号：Rust 侧在页面重载后会补发没回执的消息，同一条不处理两次 */
const SEEN_LIMIT = 200
const seenMessageIds: string[] = []
const markSeen = (messageId: string) => {
  if (seenMessageIds.includes(messageId)) return false
  seenMessageIds.push(messageId)
  if (seenMessageIds.length > SEEN_LIMIT) seenMessageIds.shift()
  return true
}

const enqueue = (message: WeixinInboundMessage) => {
  if (!markSeen(message.messageId)) {
    weixinLog('info', 'inbound-duplicate', { messageId: message.messageId })
    void weixinBotAck(message.messageId).catch(() => undefined)
    return
  }
  // 停止不能排在正在等待模型的那条消息后面，否则长任务无法从微信取消。
  if (parseWeixinCommand(message.text)?.name === 'stop') {
    void handleWeixinMessage(message).catch(error=>reply(message,describeError(error),'system').catch(()=>undefined))
    return
  }
  if (queue.length >= QUEUE_LIMIT) {
    weixinLog('warn', 'inbound-rejected', { messageId: message.messageId, queued: queue.length, text: previewText(message.text) })
    void logEntry({ direction: 'in', kind: message.kind, text: message.text, route: 'rejected', ok: false, error: '排队已满，未处理' })
    void reply(message, '前面还有几条在处理，这条先没接住，稍后再发一次。', 'system').catch(() => undefined)
    return
  }
  queue.push(message)
  weixinChannelState.queued = queue.length
  void pump()
}

const pump = async () => {
  if (pumping) return
  pumping = true
  try {
    while (queue.length) {
      const message = queue.shift()!
      weixinChannelState.queued = queue.length
      weixinChannelState.processing = true
      try {
        await handleWeixinMessage(message)
        weixinChannelState.lastError = ''
      } catch (error) {
        weixinChannelState.lastError = describeError(error)
        await reply(message, `这条没处理成功：${describeError(error)}`, 'system').catch(() => undefined)
      } finally {
        weixinChannelState.processing = false
        weixinChannelState.lastHandledAt = nowIso()
      }
      // 作者来了消息，宿主拿到了新令牌：让投递队列把之前推不出去的通知补发掉。不等它回来：
      // 补发是另一条线，它慢了或卡了都不能拖住下一条消息的处理（2026-10-14 曾因此整条队列停住）
      void writingCommand('delivery_flush', { channel: 'weixin' }).catch(error => {
        console.warn('[微信助手] 补发通知失败', error)
        weixinLog('warn', 'notice-flush-failed', { error: describeError(error) })
      })
    }
  } finally {
    pumping = false
  }
}

// ---------------------------------------------------------------------------
// 回复
// ---------------------------------------------------------------------------

const reply = async (message: WeixinInboundMessage, content: string, route?: WeixinLogRoute) => {
  const segments = splitForWeixin(markdownToPlainText(content))
  const trace = traceOf(message)
  const entry: WeixinLogInput = {
    direction: 'out',
    kind: 'text',
    text: content,
    route: route || trace?.route || 'system',
    ok: true,
    ...(trace?.entryId ? { replyTo: trace.entryId } : {}),
  }
  try {
    for (const segment of segments) {
      await weixinBotSendText(message.fromUserId, message.contextToken, segment)
    }
    weixinLog('info', 'sent', { messageId: message.messageId, route: entry.route, segments: segments.length, chars: content.length })
  } catch (error) {
    entry.ok = false
    entry.error = describeError(error)
    weixinLog('error', 'send-failed', { messageId: message.messageId, route: entry.route, chars: content.length, error: entry.error })
    throw error
  } finally {
    void logEntry(entry)
  }
}

const sendMedia = async (message: WeixinInboundMessage, media: WeixinMediaPayload) => {
  const trace = traceOf(message)
  const entry: WeixinLogInput = {
    direction: 'out',
    kind: media.kind,
    text: media.fileName,
    route: 'media',
    ok: true,
    ...(trace?.entryId ? { replyTo: trace.entryId } : {}),
  }
  try {
    await weixinBotSendMedia(message.fromUserId, message.contextToken, media)
    weixinLog('info', 'media-sent', { messageId: message.messageId, kind: media.kind, fileName: media.fileName, bytes: media.dataBase64.length })
  } catch (error) {
    entry.ok = false
    entry.error = describeError(error)
    weixinLog('error', 'media-failed', { messageId: message.messageId, kind: media.kind, fileName: media.fileName, error: entry.error })
    throw error
  } finally {
    void logEntry(entry)
  }
}

/** 正在处理的那条消息：Agent 这一轮中途要发文件、发图，就发到它所在的对话 */
let activeConversation: WeixinInboundMessage | null = null

/** 网页桥执行器用：把 Agent 工具准备好的文件或图片发给正在对话的作者 */
export const sendWeixinMedia = async (media: WeixinMediaPayload) => {
  if (!activeConversation) throw new Error('微信没有正在进行的对话，发不出去')
  await sendMedia(activeConversation, media)
}

/** 处理期间维持"正在输入"；失败只忽略，不影响回复 */
const startTyping = (message: WeixinInboundMessage) => {
  const send = (typing: boolean) => weixinBotSendTyping(message.contextToken, typing).catch(() => undefined)
  void send(true)
  const timer = setInterval(() => void send(true), TYPING_INTERVAL_MS)
  return {
    stop: () => {
      clearInterval(timer)
      void send(false)
    },
  }
}

// ---------------------------------------------------------------------------
// 微信会话：与 Agent 板块共用的同一段对话
// ---------------------------------------------------------------------------

const sessionEpoch = () => Number(appSettings.getItem(SESSION_EPOCH_KEY) || 0) || 0
const sessionKey = () => `weixin:${weixinChannelState.status?.botId || 'main'}:${weixinChannelState.status?.userId || 'author'}:${sessionEpoch()}`

const bookReferences = () => {
  const local = getWeixinSession()
  return local.currentBookId
    ? [{ id: `book:${local.currentBookId}`, kind: 'book', bookId: local.currentBookId, title: local.currentBookTitle || '' }]
    : []
}

/** Pi 微信会话：按绑定身份与会话序号取或建，桌面可回看同一段历史 */
const ensureAgentSession = async (): Promise<AgentSessionView> => {
  if (!weixinChannelState.status) weixinChannelState.status = await weixinBotStatus()
  return agentCommand<AgentSessionView>('create_session', {
    requestId: sessionKey(),
    title: '新对话',
    channel: 'weixin',
    modelCode: await weixinModelCode(),
    references: bookReferences(),
  })
}

const readSession = (id: string) => agentCommand<AgentSessionView>('get_session', { id })

/**
 * 宿主把一张卡分两半记：choice 里是状态、选项与默认项（作答写回这里），text 与 prompt 里是问题、能否打字、分步问答、对比成果。
 * 渲染与解析都要看完整的一张卡，少了问题作者就不知道在确认什么。
 */
const cardView = (message: AgentMessage): AgentChoice => {
  const prompt = message.prompt || {}
  const choice = (message.choice || { status: 'pending' }) as AgentChoice & { defaultId?: string }
  return {
    ...prompt,
    ...choice,
    question: choice.question || String(message.text || '').trim() || prompt.question || '',
    defaultOptionId: choice.defaultOptionId || choice.defaultId || prompt.defaultOptionId,
  }
}

const pendingCard = (session: AgentSessionView) => {
  const message = session.messages.find(m => m.choice?.status === 'pending')
  return message ? { id: message.id, choice: cardView(message) } : null
}
const presentedKey = (sessionId: string) => `ew-pi-weixin-presented:${sessionId}`
const cardFingerprint = (card: NonNullable<ReturnType<typeof pendingCard>>) => JSON.stringify(card)
async function markPresented(session: AgentSessionView) {
  const card = pendingCard(session)
  appSettings.setItem(presentedKey(session.id),card ? cardFingerprint(card) : '')
  await flushAppSettings()
}

const bookRefs = (session: AgentSessionView) =>
  (session.references || []).filter(r => r.kind === 'book' && r.bookId).map(r => ({ id: String(r.bookId), title: r.title || '' }))

/**
 * 宿主这一轮可能把别的书带进对话（open_book）或把当前书送进回收站（delete_book）：
 * 新带进来的书成为当前作品；当前作品不在引用里了就换成剩下的最后一本，没有就清空。
 */
const syncCurrentBook = async (before: AgentSessionView, after: AgentSessionView) => {
  const was = new Set(bookRefs(before).map(book => book.id))
  const now = bookRefs(after)
  const local = getWeixinSession()
  const added = now.filter(book => !was.has(book.id))
  if (added.length) {
    const next = added[added.length - 1]
    if (next.id !== local.currentBookId) await setWeixinCurrentBook(next)
    return
  }
  if (local.currentBookId && !now.some(book => book.id === local.currentBookId)) {
    await setWeixinCurrentBook(now.length ? now[now.length - 1] : null)
  }
}

/** 本轮结束：不在跑，收件箱里也没有等着续跑的话 */
const settled = (session: AgentSessionView, before: AgentSessionView) => {
  if (session.status === 'running') return false
  if (session.status === 'paused' && (session.pendingInputs?.length || 0) > 0) return false
  return session.runId !== before.runId || session.status === 'failed' || session.messages.length > before.messages.length
}

const waitForSettled = async (sessionId: string, before: AgentSessionView): Promise<AgentSessionView | null> => {
  const deadline = Date.now() + RUN_WAIT_MS
  while (Date.now() < deadline) {
    const current = await readSession(sessionId)
    if (settled(current, before)) return current
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, SETTLE_POLL_MS)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })
  }
  return null
}

const weixinModelCode = async () => {
  const { useAiModelStore } = await import('@/stores/ai-model')
  return useAiModelStore().ensureGroupModel('weixin')
}

// ---------------------------------------------------------------------------
// 渲染：回复、引导卡、确认卡、成果
// ---------------------------------------------------------------------------

const optionLine = (index: number, option: AgentOption) =>
  `${index + 1}. ${option.title}${option.description ? `：${option.description}` : ''}`

/** 引导卡 / 确认卡渲染成编号文本；作者回编号作答 */
export const renderCard = (choice: AgentChoice): string => {
  const lines: string[] = []
  if (choice.question) lines.push(choice.question)
  if (choice.description) lines.push(choice.description)
  const options = choice.options || []
  if (choice.kind === 'steps' && choice.steps?.length) {
    choice.steps.forEach((step, stepIndex) => {
      lines.push(`${stepIndex + 1}）${step.question}${step.required ? '' : '（可不答）'}`)
      ;(step.options || []).forEach((option, index) => lines.push(`   ${optionLine(index, option)}`))
    })
    lines.push('按顺序回复每个问题的编号，用空格分开，比如「2 1 3」；没有选项的问题直接写文字。')
    return lines.join('\n')
  }
  options.forEach((option, index) => lines.push(optionLine(index, option)))
  if (options.some(option => option.input)) lines.push('需要补充内容的选项请回复「编号 内容」，例如「2 前十章」。')
  if (choice.kind === 'confirm') {
    lines.push(options.length >= 2 ? `回复 1 ${options[0].title}，回复 2 ${options[1].title}；也可以直接回复「确认」或「取消」。` : '回复「确认」执行，回复「取消」放弃。')
  } else if (options.length) {
    lines.push(
      choice.multiple
        ? '可回复多个编号，用空格或逗号分开' + (choice.allowFreeText ? '；也可以直接回复你的想法。' : '。')
        : '回复编号选择' + (choice.allowFreeText ? '，或直接回复你的想法。' : '。')
    )
  }
  return lines.join('\n')
}

const CONFIRM_WORDS = new Set(['确认', '确定', '是', '好', '好的', '保存', '存', 'ok', 'OK', 'yes', 'y'])
const CANCEL_WORDS = new Set(['取消', '算了', '不', '不用', '丢弃', '不要了', 'no', 'n'])
const NUMBERS = /^\s*\d+(\s*[,，、\s]\s*\d+)*\s*$/

export interface CardAnswer {
  nextAction?: 'continue' | 'pause'
  selectedIds: string[]
  text?: string
  inputs?: Record<string, string>
  cancelled?: boolean
  steps?: Record<string, { selectedIds: string[]; text?: string }>
}

/** 把作者的一句话解析成卡片答案；解析不出来返回要回给作者的提示 */
export const parseCardAnswer = (choice: AgentChoice, text: string): { answer: CardAnswer } | { hint: string } => {
  const options = choice.options || []
  const trimmed = text.trim()
  if (trimmed === '/取消') return {answer:{selectedIds:[],cancelled:true}}
  if (trimmed === '/跳过') return {answer:{selectedIds:[],text:trimmed}}
  const withInput = trimmed.match(/^(\d+)\s+([\s\S]+)$/)
  if (withInput && options[Number(withInput[1])-1]?.input) {
    const option = options[Number(withInput[1])-1]
    return {answer:{selectedIds:[option.id],inputs:{[option.id]:withInput[2].trim()}}}
  }
  if (choice.kind === 'steps' && choice.steps?.length) {
    const parts = trimmed.split(/[\s,，、]+/).filter(Boolean)
    const steps: NonNullable<CardAnswer['steps']> = {}
    choice.steps.forEach((step, index) => {
      const given = parts[index]
      if (!given) return
      const number = Number(given)
      const option = Number.isInteger(number) ? step.options?.[number - 1] : undefined
      steps[step.key] = option ? { selectedIds: [option.id] } : { selectedIds: [], text: given }
    })
    return { answer: { selectedIds: [], steps } }
  }
  if (choice.kind === 'confirm' && options.length >= 2) {
    if (CONFIRM_WORDS.has(trimmed) && !options[0].input) return { answer: { selectedIds: [options[0].id] } }
    if (CANCEL_WORDS.has(trimmed)) return { answer: { selectedIds: [options[1].id] } }
  }
  const byTitle = options.filter(option => option.title.trim() === trimmed)
  if (byTitle.length === 1 && !byTitle[0].input) return { answer: { selectedIds: [byTitle[0].id] } }
  if (NUMBERS.test(trimmed) && options.length) {
    const numbers = trimmed.split(/[\s,，、]+/).filter(Boolean).map(Number)
    const picked = numbers.map(n => options[n - 1]).filter(Boolean)
    if (!picked.length || picked.length !== numbers.length) return { hint: `编号要在 1 到 ${options.length} 之间。` }
    if (!choice.multiple && picked.length > 1) return { hint: '这张卡只能选一项，回复一个编号。' }
    if (picked.some(o=>o.input)) return {hint:'这个选项需要补充内容，请回复「编号 内容」。'}
    return { answer: { selectedIds: picked.map(option => option.id) } }
  }
  if (CONFIRM_WORDS.has(trimmed) && choice.defaultOptionId && options.some(option => option.id === choice.defaultOptionId)) {
    return { answer: { selectedIds: [choice.defaultOptionId] } }
  }
  if (choice.allowFreeText !== false || !options.length) return { answer: { selectedIds: [], text: trimmed } }
  return { hint: `请回复编号（1 到 ${options.length}）。` }
}

const artifactPreview = (artifact: AgentArtifactView) => {
  const content = String(artifact.content || '').trim()
  const head = content.slice(0, PREVIEW_CHARS)
  return `${artifact.title || '成果'}（${content.length} 字）\n${head}${content.length > head.length ? '……' : ''}`
}

/** 本轮新出现的成果：章节、短篇、草稿先发开头预览，全文作为文件发 */
const deliverArtifacts = async (message: WeixinInboundMessage, before: AgentSessionView, after: AgentSessionView) => {
  const seen = new Set(before.messages.map(m => m.artifactId).filter(Boolean))
  const ids = after.messages.map(m => m.artifactId).filter((id): id is string => Boolean(id) && !seen.has(id))
  for (const id of [...new Set(ids)]) {
    let artifact: AgentArtifactView
    try {
      artifact = await agentCommand<AgentArtifactView>('get_artifact', { id })
    } catch (error) {
      weixinLog('warn', 'artifact-read-failed', { id, error: describeError(error) })
      continue
    }
    if (!['chapter', 'short', 'draft'].includes(artifact.kind) || !artifact.content) continue
    await reply(message, artifactPreview(artifact), 'assistant')
    try {
      await sendMedia(message, {
        kind: 'file',
        fileName: `${artifact.bookTitle ? `${safeFileName(artifact.bookTitle)}-` : ''}${safeFileName(artifact.title || '成果')}.txt`,
        dataBase64: textToBase64(`${artifact.title || ''}\n\n${artifact.content}\n`),
      })
    } catch {
      await reply(message, '全文文件没发出去，可以到桌面端查看。', 'system').catch(() => undefined)
    }
  }
}

/** 本轮里助手说的话（不含卡片），按出现顺序连起来 */
const replyText = (before: AgentSessionView, after: AgentSessionView) => {
  const seen = new Set(before.messages.map(m => m.id))
  return after.messages
    .filter(m => !seen.has(m.id) && m.role === 'assistant' && m.kind !== 'choice' && String(m.text || '').trim())
    .map(m => String(m.text).trim())
    .join('\n\n')
}

// 后台拆书等完成后 Pi 会继续同一会话；这里投递新增回复，不启动任何自动任务。
let followup: {message:WeixinInboundMessage; snapshot:AgentSessionView} | null = null
let followupTimer: ReturnType<typeof setTimeout> | null = null
let deliveringFollowup = false
let followupWork: Promise<void> | null = null
function scheduleFollowup() {
  if (!followup || followupTimer || !weixinChannelState.started) return
  followupTimer = setTimeout(()=>{
    followupTimer=null
    followupWork = deliverFollowup().catch(error=>weixinLog('warn','pi-followup-failed',{error:describeError(error)})).finally(()=>{followupWork=null})
  },250)
}
async function deliverFollowup() {
  const target = followup
  if (!target || deliveringFollowup || weixinChannelState.processing || activeConversation) return
  if (weixinChannelState.status?.userId && target.message.fromUserId!==weixinChannelState.status.userId) {followup=null;return}
  deliveringFollowup=true
  try {
    const after=await readSession(target.snapshot.id)
    if (after.status==='running' || target!==followup) return
    const answer=replyText(target.snapshot,after)
    const nextCard=pendingCard(after), previousCard=pendingCard(target.snapshot)
    const changed=nextCard && (!previousCard || cardFingerprint(nextCard)!==cardFingerprint(previousCard))
    const content=[answer,changed?renderCard(nextCard.choice):'',after.status==='failed'&&target.snapshot.error!==after.error?`这轮没完成：${after.error}`:''].filter(Boolean).join('\n\n')
    if (content) await reply(target.message,content,'assistant')
    await deliverArtifacts(target.message,target.snapshot,after)
    await markPresented(after)
    if (target===followup) target.snapshot=after
  } finally {deliveringFollowup=false}
}

// ---------------------------------------------------------------------------
// 一条消息的处理
// ---------------------------------------------------------------------------

/** 导出给测试用；正常路径由队列调用。收到即记账，处理完补上路径与耗时；抛错也记完再抛 */
export const handleWeixinMessage = async (message: WeixinInboundMessage) => {
  const trace = await openTrace(message)
  // 记进日志就算接住了：Rust 侧收到回执后不再补发；没回执（页面处理到一半重载）就会在下次挂监听时再送一遍
  void weixinBotAck(message.messageId).catch(error => weixinLog('warn', 'ack-failed', { messageId: message.messageId, error: describeError(error) }))
  try {
    await dispatchMessage(message, trace)
    await closeTrace(trace)
  } catch (error) {
    await closeTrace(trace, describeError(error))
    throw error
  }
}

const dispatchMessage = async (message: WeixinInboundMessage, trace: MessageTrace) => {
  if (message.kind !== 'text' && message.kind !== 'voice') {
    trace.note = '不支持的消息类型'
    return reply(message, '我暂时只能看懂文字和语音消息。')
  }
  const text = String(message.text || '').trim()
  if (!text) {
    trace.note = message.kind === 'voice' ? '语音没有识别出文字' : '空消息'
    return reply(message, message.kind === 'voice' ? '这条语音没有识别出文字，换成文字再发一次吧。' : '消息是空的。')
  }
  const command = text === '/跳过' ? null : parseWeixinCommand(text)
  // 斜杠命令不经宿主；「确认 / 取消」这类口语先看宿主有没有在等作者作答
  if (command && command.name !== 'confirm' && command.name !== 'cancel') {
    trace.route = 'command'
    trace.note = `命令 /${command.name}${command.arg ? ` ${command.arg}` : ''}`
    return reply(message, await runCommand(command))
  }
  trace.route = 'assistant'
  return runAgent(message, text, trace)
}

const runCommand = async (command: WeixinCommand): Promise<string> => {
  switch (command.name) {
    case 'help':
      return WEIXIN_HELP_TEXT
    case 'books':
      return listBooksText()
    case 'book':
      return switchBook(command.arg)
    case 'status':
      return statusText()
    case 'clear':
      await agentCommand('stop', {id:(await ensureAgentSession()).id})
      followup=null
      appSettings.setItem(SESSION_EPOCH_KEY, String(sessionEpoch() + 1))
      await flushAppSettings()
      return '已开始新的对话，当前作品保持不变；之前的对话在电脑端 Agent 里还能看。'
    case 'stop':
      await agentCommand('stop', {id:(await ensureAgentSession()).id})
      return '已停止这段微信对话的执行，已保存的内容保留。'
    default:
      return WEIXIN_HELP_TEXT
  }
}

const listBooks = async (): Promise<LocalBook[]> => {
  const { getLocalLibraryStorage } = await import('@/storage/local-library')
  return getLocalLibraryStorage().listLocalBooks({ sortBy: 'updateTime', sortOrder: 'DESC' })
}

const listBooksText = async () => {
  const books = await listBooks()
  if (!books.length) return '你在易创里还没有作品。'
  const local = getWeixinSession()
  const lines = books.slice(0, 20).map((book, index) => {
    const current = String(book.id) === local.currentBookId ? '（当前）' : ''
    return `${index + 1}. 《${book.title}》${current}`
  })
  return [`共 ${books.length} 本作品：`, ...lines, '', '回复「/作品 序号」切换当前作品。'].join('\n')
}

const switchBook = async (arg: string) => {
  const books = await listBooks()
  const index = Number(arg)
  const found = Number.isInteger(index) && index >= 1 && index <= books.length
    ? books[index - 1]
    : books.find(book => book.title === arg) || books.find(book => book.title.includes(arg))
  if (!found) return `没找到「${arg}」，先回复「/作品」看看序号。`
  // 当前作品进会话引用：Agent 的读写授权按会话引用判断
  const session = await ensureAgentSession()
  await agentCommand('update_session', { id: session.id, references:[{kind:'book',bookId:String(found.id),title:found.title}] })
  await setWeixinCurrentBook({ id: String(found.id), title: found.title })
  return `当前作品已切换为《${found.title}》。`
}

const statusText = async () => {
  const local = getWeixinSession()
  const status = weixinChannelState.status || (await weixinBotStatus().catch(() => null))
  const modelCode = await weixinModelCode().catch(() => '')
  const { getLocalAiModelDisplayName } = await import('@/storage/local-ai-models')
  const modelName = modelCode ? getLocalAiModelDisplayName(modelCode) || modelCode : ''
  let agentLine = ''
  try {
    const session = await ensureAgentSession()
    const card = pendingCard(session)
    agentLine = session.status === 'running' ? 'Agent：正在处理上一条' : card ? `Agent：在等你回答「${card.choice?.question || '一张卡片'}」` : 'Agent：空闲'
  } catch {
    agentLine = 'Agent：未连接'
  }
  return [
    `当前作品：${local.currentBookTitle ? `《${local.currentBookTitle}》` : '未选择'}`,
    `使用模型：${modelName || '未配置'}`,
    `连接状态：${status?.state === 'online' ? '在线' : status?.state || '未知'}`,
    `主动推送：${status?.pushAvailable ? '可用' : '收到这条消息后即可用'}`,
    agentLine,
  ].join('\n')
}

/** 作者的一句话 → 宿主的微信会话：有卡在等就当答案，否则当新消息；等本轮结束后渲染回复 */
const runAgent = async (message: WeixinInboundMessage, text: string, trace: MessageTrace) => {
  await followupWork
  const modelCode = await weixinModelCode()
  if (!modelCode) {
    trace.note = '没有可用模型'
    weixinLog('warn', 'no-model', { messageId: message.messageId })
    return reply(message, '还没有可用模型：请先到桌面端「模型管理」添加并启用一个文本模型。')
  }
  trace.model = modelCode
  const session = await ensureAgentSession()
  const card = pendingCard(session)
  const typing = startTyping(message)
  const startedAt = Date.now()
  activeConversation = message
  try {
    if (card?.choice && session.status === 'choice') {
      if (appSettings.getItem(presentedKey(session.id)) !== cardFingerprint(card)) {
        await reply(message,`请先核对当前内容，再回复选择：\n\n${renderCard(card.choice)}`)
        await deliverArtifacts(message,{...session,messages:[]},session)
        await markPresented(session)
        return
      }
      const parsed = parseCardAnswer(card.choice, text)
      if ('hint' in parsed) {
        trace.note = '答案没解析出来'
        return reply(message, `${parsed.hint}\n\n${renderCard(card.choice)}`)
      }
      trace.route = 'confirm'
      await agentCommand('run', {
        sessionId: session.id,
        inputKind: 'answer',
        text: '',
        resume: true,
        answer: parsed.answer,
        messageId: card.id,
        choiceId: parsed.answer.selectedIds[0] ?? null,
        modelCode,
      })
    } else {
      await agentCommand('run', { sessionId: session.id, inputKind: 'message', text, references: bookReferences(), modelCode })
    }
    const after = await waitForSettled(session.id, session)
    trace.steps.push({ tool: 'agent', label: 'Agent 对话', status: after ? 'done' : 'error', durationMs: Date.now() - startedAt, chars: 0 })
    if (!after) {
      trace.note = '等待超时'
      followup={message,snapshot:session}
      return reply(message, '这件事还在处理，可以到桌面端 Agent 查看；回复 /状态 查询，或 /停止 取消。')
    }
    const answer = replyText(session, after)
    const nextCard = after.status === 'choice' ? pendingCard(after) : null
    const parts = [answer, nextCard?.choice ? renderCard(nextCard.choice) : '']
    if (after.status === 'failed') parts.push(`这轮没完成：${after.error || '未知原因'}。可以换个说法再试。`)
    if (after.status === 'paused' && !answer) parts.push('任务已停住，可以继续说要做什么。')
    const content = parts.filter(Boolean).join('\n\n') || '模型没有给出内容，换个问法试试。'
    trace.steps[trace.steps.length - 1].chars = content.length
    await reply(message, content)
    await deliverArtifacts(message, session, after)
    await markPresented(after)
    followup={message,snapshot:after}
    if (nextCard?.choice?.artifactIds?.length) await deliverCompare(message, nextCard.choice.artifactIds)
    await syncCurrentBook(session, after).catch(error => weixinLog('warn', 'current-book-sync-failed', { error: describeError(error) }))
  } finally {
    activeConversation = null
    typing.stop()
    scheduleFollowup()
  }
}

/** 对比卡：两份成果各发一个文件，作者按编号选 */
const deliverCompare = async (message: WeixinInboundMessage, artifactIds: string[]) => {
  for (const [index, id] of artifactIds.entries()) {
    try {
      const artifact = await agentCommand<AgentArtifactView>('get_artifact', { id })
      if (!artifact.content) continue
      await sendMedia(message, {
        kind: 'file',
        fileName: `${index + 1}-${safeFileName(artifact.title || '', '成果')}.txt`,
        dataBase64: textToBase64(`${artifact.title || ''}\n\n${artifact.content}\n`),
      })
    } catch (error) {
      weixinLog('warn', 'compare-send-failed', { id, error: describeError(error) })
    }
  }
}
