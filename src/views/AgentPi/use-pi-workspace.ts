import { initialRunControl, readRunControl, changeRunControl, allowsTaskContinuation, RUN_CONTROL_EVENT } from '@/agent-pi/run-control'
import type { PiRunControl, PiRunControlChange } from '@/types/agent-pi'
import { toolOperation } from '@/agent-pi/tool-summaries'
import { piErrorMessage } from '@/agent-pi/errors'
import { receivePiRetry } from '@/agent-pi/conversation'
import '@/agent-pi/task-providers'
import {
  piTasks,
  pauseHeldTasks,
  resumeHeldTasks,
  taskView,
  taskEventMessage,
  markTaskContinued,
  markTaskContinueSkipped,
  hasRunningTasks,
  initializeTasks,
  stopTasks,
  taskStepMessage,
  taskStepSent,
  taskStepBlocked,
  notifyTurnSettled,
  notifyDraftApplied,
  TASK_FINISHED_EVENT,
  TASK_STEP_EVENT,
  type PiTaskFinished,
  type PiTaskView
} from '@/agent-pi/tasks'
import { allowBreakdownTasks } from '@/agent-pi/breakdown-tasks'
import { applyCover as applyCoverTask } from '@/agent-pi/cover-tasks'
import { computed, reactive, ref, markRaw } from 'vue'
import {
  abortChatImport,
  attachmentMessage,
  beginChatImport,
  cancelChatImports,
  hasRunningImports,
  listChatAttachments,
  previewChatBook,
  recoverChatImports,
  runChatImport,
  validateBookFile,
  type BookAttachment
} from '@/agent-pi/attachments'
import {
  piSkills,
  skillNamesForInput,
  findSkill,
  reloadSkills,
  saveSkill as saveSkillFile,
  deleteSkill as deleteSkillFile,
  setSkillEnabled,
  importSkill as importSkillFile,
  skillCommand,
  noteSessionSkill,
  skillsRevision,
  bumpSkillsRevision,
  type SkillInput
} from '@/agent-pi/skills'
import { referenceMessage } from '@/agent-pi/references'
import { findMentionTokens, findSkillToken, stripSkillToken } from './composer-menu'
import type { PiReference } from '@/types/agent-pi'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { listLocalAiModels } from '@/storage/local-ai-models'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { appSettings, flushAppSettings } from '@/storage/app-settings'
import { isTauriRuntime } from '@/storage'
import { piCommand, listenPi } from '@/agent-pi/client'
import {
  piMessageText,
  projectPiHistory,
  projectPiEntries,
  receivePiMessage,
  sessionTitleFrom,
  summarizeToolResult
} from '@/agent-pi/conversation'
import { generateSessionTitle } from './session-naming'
import { normalizeQuestionSpec, specFromDialog } from '@/agent-pi/questions'
import {
  preparePiDraftBatch,
  validatePiDraftBatch,
  executePiTool,
  listPiDrafts,
  savePiDraftEdit,
  applyPiDraft,
  preparePiDraftConfirmation,
  releasePiToolContext,
  capturePiSaves,
  waitForPiSaves
} from '@/agent-pi/platform-tools'
import type { AiModelOption } from '@/types/ai-model'
import type {
  PiBook,
  PiSession,
  PiMessage,
  PiEvent,
  PiDraft,
  PiDraftConfirmation,
  PiChatState,
  PiSessionContext,
  PiSessionHistory,
  PiSessionGroup,
  PiSessionSearchHit,
  PiQuestionAnswer,
  PiQuestionSpec
} from '@/types/agent-pi'

const makeChat = (modelCode = '', bookId = ''): PiChatState => ({
  key: crypto.randomUUID(),
  title: '新对话',
  updatedAt: Date.now(),
  instanceId: '',
  sessionId: '',
  sessionFile: '',
  bookId,
  modelCode,
  contextRevision: 0,
  runControl: initialRunControl(),
  controlling: false,
  settling: false,
  draft: '',
  attachment: null,
  attachments: {},
  references: [],
  skillsRevision: 0,
  pendingGroupId: '',
  messages: [],
  activities: [],
  drafts: [],
  openedDraft: null,
  openedResult: null,
  thinkingMs: {},
  thinkingStartedAt: null,
  dialog: null,
  question: null,
  answering: false,
  answerDraft: '',
  connecting: false,
  running: false,
  stopping: false,
  stopFailed: false,
  stopped: false,
  pendingTasks: 0,
  error: '',
  epoch: 0,
  streamingIndex: null
})
const executing = (chat: PiChatState) =>
  chat.controlling ||
  chat.running ||
  chat.stopping ||
  chat.stopFailed ||
  chat.pendingTasks > 0
const working = (chat: PiChatState) => executing(chat) || chat.connecting || chat.settling

/** 任务完成、分步任务要发下一步，都只在模块级监听一次，交给当前的工作台实例处理。 */
let activeWorkspace: ((finished: PiTaskFinished) => Promise<void>) | null = null
let activeStepper: ((step: PiTaskFinished) => Promise<void>) | null = null
if (typeof window !== 'undefined') {
  window.addEventListener(TASK_FINISHED_EVENT, event => {
    void activeWorkspace?.((event as CustomEvent<PiTaskFinished>).detail)
  })
  window.addEventListener(TASK_STEP_EVENT, event => {
    void activeStepper?.((event as CustomEvent<PiTaskFinished>).detail)
  })
}
export const usePiWorkspace = defineStore('agent-pi-workspace', () => {
  const initial = makeChat()
  const chats = reactive(new Map<string, PiChatState>([[initial.key, initial]]))
  const activeKey = ref(initial.key)
  const current = computed(() => chats.get(activeKey.value)!)
  const field = <K extends keyof PiChatState>(key: K) =>
    computed({
      get: () => current.value[key],
      set: (value: PiChatState[K]) => {
        current.value[key] = value
      }
    })
  const ready = ref(false),
    closing = ref(false),
    restoring = ref(false)
  const books = ref<PiBook[]>([]),
    models = ref<AiModelOption[]>([]),
    sessionRecords = ref<PiSession[]>([]),
    groups = ref<PiSessionGroup[]>([])
  const connecting = field('connecting'),
    running = field('running'),
    stopping = field('stopping'),
    stopFailed = field('stopFailed'),
    stopped = field('stopped')
  const error = field('error'),
    retry = field('retry'),
    draft = field('draft'),
    bookId = field('bookId'),
    modelCode = field('modelCode'),
    instanceId = field('instanceId'),
    sessionId = field('sessionId'),
    sessionFile = field('sessionFile')
  const attachment = field('attachment'),
    attachments = field('attachments'),
    references = field('references')
  /** 主区显示对话还是技能页；选对话或新建对话都回到对话。 */
  const view = ref<'chat' | 'skills' | 'memory' | 'resources'>('chat')
  const sendModeKey = 'ew-pi-enter-to-send'
  const enterToSend = ref(appSettings.getItem(sendModeKey) === 'true')
  async function setEnterToSend(value: boolean) {
    const previous = enterToSend.value
    appSettings.setItem(sendModeKey, String(value))
    try {
      await flushAppSettings()
      enterToSend.value = value
    } catch (error) {
      appSettings.setItem(sendModeKey, String(previous))
      throw error
    }
  }
  /** 输入框里附件的目录识别；换附件或移除时取消。 */
  const previews = new Map<string, AbortController>()
  const sending = new Map<string, symbol>()
  const answerDraft = field('answerDraft')
  const messages = field('messages'),
    activities = field('activities'),
    drafts = field('drafts'),
    openedDraft = field('openedDraft'),
    openedResult = field('openedResult'),
    thinkingMs = field('thinkingMs'),
    dialog = field('dialog'),
    question = field('question'),
    answering = field('answering')
  const busy = computed(() => closing.value || restoring.value || working(current.value))
  const inputLocked = computed(() => closing.value || restoring.value)
  const sessions = computed({
    get: () => {
      const rows = new Map(sessionRecords.value.map(s => [s.file || s.id, { ...s }]))
      for (const chat of chats.values()) {
        if (!chat.sessionFile && !chat.instanceId && !chat.connecting && !chat.messages.length) continue
        const key = chat.sessionFile || chat.key,
          old = rows.get(key)
        rows.set(key, {
          id: chat.sessionId || chat.key,
          file: chat.sessionFile,
          localKey: chat.key,
          title: old?.title || chat.title,
          book: chat.bookId
            ? books.value.find(b => b.id === chat.bookId) || { id: chat.bookId, title: '作品已删除' }
            : null,
          updatedAt: Math.max(chat.updatedAt, old?.updatedAt || 0),
          named: old?.named,
          titleSource: old?.titleSource,
          // 宿主还没列出这个会话前，先按它要进的分组显示；宿主记录出现后以宿主为准。
          groupId: old ? (old.groupId ?? null) : chat.pendingGroupId || null,
          pinnedAt: old?.pinnedAt ?? null,
          archivedAt: old?.archivedAt ?? null,
          status: chat.dialog || chat.question
            ? 'waiting'
            : chat.stopFailed || chat.error
              ? 'failed'
              : chat.connecting
                ? 'connecting'
                : chat.running || chat.pendingTasks || chat.stopping
                  ? 'running'
                  : undefined
        })
      }
      return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    set: (rows: PiSession[]) => {
      sessionRecords.value = rows
    }
  })
  const visibleSessions = computed(() => sessions.value.filter(session => !session.archivedAt))
  const archivedSessions = computed(() => sessions.value.filter(session => !!session.archivedAt))
  const draftEdits = reactive(new Map<string, { content: string; revision: number; manual:boolean }>())
  const editing = new Set<Promise<void>>(),
    controls = new Set<Promise<unknown>>()
  const toolControllers = new Map<string, { chat: PiChatState; controller: AbortController }>()
  const platformTasks = new Map<string, { chat: PiChatState; task: Promise<unknown> }>()
  let initialized: Promise<void> | null = null,
    listening = false,
    bootstrapped = false,
    retiring = false
  let closingSaves: ReturnType<typeof capturePiSaves> | undefined
  function setDraftContent(content:string, manual=false){
    const d=openedDraft.value
    if(!d||d.appliedAt||inputLocked.value)return
    const pending=draftEdits.get(d.id)
    draftEdits.set(d.id,{content,revision:pending?.revision??d.revision??0,manual:manual && (pending?.manual??true)})
  }
  const draftContent = computed({
    get: () => openedDraft.value ? (draftEdits.get(openedDraft.value.id)?.content ?? openedDraft.value.content) : '',
    set: (content:string)=>setDraftContent(content)
  })
  const byInstance = (id: string) => [...chats.values()].find(chat => chat.instanceId === id)
  /** 当前对话挂着的引导卡：扩展的结构化询问优先，其次是 Pi 原生询问。 */
  const pendingQuestion = computed<{
    id: string
    callId: string
    spec: PiQuestionSpec
    source: 'tool' | 'native'
  } | null>(() => {
    const chat = current.value
    if (chat.question)
      return { id: chat.question.id, callId: chat.question.callId, spec: chat.question.spec, source: 'tool' }
    if (chat.dialog)
      return { id: String(chat.dialog.id || ''), callId: '', spec: specFromDialog(chat.dialog), source: 'native' }
    return null
  })
  function fail(cause: unknown, chat = current.value) {
    chat.error = (cause instanceof Error ? cause.message : String(cause)).replace(
      /^PI_(?:COMMAND|ADOPTION)_(?:REJECTED|UNKNOWN):\s*/,
      ''
    )
    if (current.value === chat) ElMessage.error(piErrorMessage(chat.error))
  }
  function cancelTools(chat?: PiChatState) {
    for (const [id, item] of toolControllers)
      if (!chat || item.chat === chat) {
        item.controller.abort()
        toolControllers.delete(id)
      }
    for (const item of chat ? [chat] : chats.values())
      if (item.instanceId) releasePiToolContext(item.instanceId)
  }
  async function settlePlatformTasks(chat?: PiChatState) {
    const outcomes = await Promise.allSettled(
      [...platformTasks.values()].filter(item => !chat || item.chat === chat).map(item => item.task)
    )
    const failure = outcomes.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  const request = (chat: PiChatState, type: string, args: object = {}) =>
    piCommand<Record<string, unknown>>('request', { instanceId: chat.instanceId, command: { ...args, type } })
  function stateOf(chat: PiChatState, state: Record<string, unknown>) {
    chat.sessionId = String(state.sessionId || chat.sessionId)
    chat.sessionFile =
      String(state.sessionFile || chat.sessionFile)
        .split(/[\\/]/)
        .pop() || ''
  }
  async function refresh(chat: PiChatState) {
    if (!chat.instanceId) return
    const id = chat.instanceId,
      epoch = chat.epoch
    const [state, history] = await Promise.all([request(chat, 'get_state'), request(chat, 'get_entries')])
    if (id !== chat.instanceId || epoch !== chat.epoch) return
    stateOf(chat, state)
    chat.messages = projectPiEntries(history as unknown as PiSessionHistory)
    chat.streamingIndex = null
    chat.running = Boolean(state.isStreaming || state.isCompacting)
    await Promise.all([reloadSessions(), reloadChatDrafts(chat), reloadAttachments(chat)])
  }
  /** 本会话登记过的附件（入库中、已完成、失败）；消息里的附件卡按它显示状态。 */
  async function reloadAttachments(chat: PiChatState) {
    if (!chat.sessionId) return
    const rows = await listChatAttachments(chat.sessionId).catch(() => null)
    if (rows) chat.attachments = Object.fromEntries(rows.map(row => [row.id, row]))
  }
  function setAttachment(chat: PiChatState, record: BookAttachment) {
    chat.attachments = { ...chat.attachments, [record.id]: record }
  }
  /** 窗口切回来时核对当前对话的真实状态；界面错过事件时据此恢复，不改正在运行的任务。 */
  async function resync() {
    const chat = current.value
    if (!chat.instanceId || closing.value || restoring.value || chat.stopping || !chat.running) return
    try {
      const state = await request(chat, 'get_state')
      if (!state.isStreaming && !state.isCompacting) await refresh(chat)
    } catch {
      /* 连接不上时保持现状，由下一次事件或作者停止处理 */
    }
  }
  async function reloadSessions() {
    if (!isTauriRuntime()) return
    const [rows, groupRows] = await Promise.all([
      piCommand<PiSession[]>('sessions'),
      piCommand<PiSessionGroup[]>('groups')
    ])
    sessionRecords.value = Array.isArray(rows) ? rows : []
    groups.value = Array.isArray(groupRows) ? groupRows : []
    for (const chat of chats.values())
      if (chat.pendingGroupId && chat.sessionId && sessionRecords.value.some(s => s.id === chat.sessionId))
        chat.pendingGroupId = ''
  }
  async function reloadBooks() {
    books.value = (
      await getLocalLibraryStorage().listLocalBooks({ sortBy: 'updateTime', sortOrder: 'DESC' })
    ).map(b => ({ id: String(b.id), title: b.title }))
  }
  async function reloadChatDrafts(chat: PiChatState) {
    const values = await listPiDrafts()
    chat.drafts = values.filter(d => d.sessionId === chat.sessionId || d.id === chat.openedDraft?.id)
    if (chat.openedDraft) chat.openedDraft = chat.drafts.find(d => d.id === chat.openedDraft?.id) || null
    // 模型按作者要求改过候选（修订号变了）：右栏改显示新稿，作者之前没存的编辑不再覆盖它
    for (const d of chat.drafts) {
      const edit = draftEdits.get(d.id)
      if (edit && edit.revision !== (d.revision ?? 0)) draftEdits.delete(d.id)
    }
  }
  const reloadDrafts = () => reloadChatDrafts(current.value)
  function receive(id: string, event: PiEvent) {
    const chat = byInstance(id)
    if (!chat) return
    if (event.type === 'author_decision') {
      const control = event.control as PiRunControl
      applyRunControl(chat, control)
      if (control.state !== 'active') void pauseHeldTasks(control.heldTasks.filter(task => task.revision === control.revision)).catch(cause => fail(cause, chat))
      return
    }
    receivePiRetry(chat, event)
    if (event.type === 'host_exit') {
      cancelTools(chat)
      if (closing.value || restoring.value || chat.stopping || chat.stopFailed || chat.connecting) return
      chat.instanceId = ''
      chat.running = false
      chat.streamingIndex = null
      chat.dialog = null
      chat.question = null
      chat.error = 'Agent 进程已退出，可以重开会话继续。'
      return
    }
    if (event.type === 'extension_error' && !chat.stopping && !closing.value && !restoring.value) {
      fail(event.error || '平台上下文同步失败，请重试本轮操作', chat)
    }
    if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
      receivePiMessage(chat, event)
      if (
        event.type === 'message_start' &&
        typeof event.message === 'object' &&
        event.message?.role === 'user'
      ) {
        if (chat.title === '新对话') chat.title = sessionTitleFrom(piMessageText(event.message)) || '新对话'
        chat.updatedAt = Date.now()
        void reloadSessions().catch(cause => fail(cause, chat))
      }
    }
    if (event.type === 'agent_start') {
      chat.epoch++
      chat.running = true
      chat.stopped = false
      chat.error = ''
    }
    if (event.type === 'agent_settled') {
      chat.retry = undefined
      chat.epoch++
      chat.running = false
      chat.streamingIndex = null
      chat.thinkingStartedAt = null
      chat.dialog = null
      chat.question = null
      chat.updatedAt = Date.now()
      if (!closing.value && !restoring.value && !chat.stopping && !chat.stopFailed && !chat.controlling) {
        chat.stopped = Boolean(event.aborted) && chat.messages[chat.messages.length - 1]?.details?.platformCompleted !== true
        chat.settling = true
        void refresh(chat)
          .then(() => syncContext(chat))
          .finally(() => { chat.settling = false })
          .then(() => maybeAutoName(chat))
          .then(() => chat.runControl.state === 'active' && !chat.runControl.pendingInput ? notifyTurnSettled(chat.sessionId, chat.drafts) : undefined)
          .catch(cause => fail(cause, chat))
      }
    }
    if (event.type === 'tool_execution_start') {
      const id = event.toolCallId || ''
      const args = event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : undefined
      const existing = chat.activities.find(item => item.id === id)
      if (existing) Object.assign(existing, { args: existing.args ?? args, startedAt: existing.startedAt ?? Date.now() })
      else chat.activities.push({ id, name: toolOperation(event.toolName, args) || '', status: '进行中', args, startedAt: Date.now() })
    }
    if (event.type === 'tool_execution_update') {
      const item = chat.activities.find(a => a.id === event.toolCallId)
      const partial = event.partialResult as { content?: Array<{ type: string; text?: string }> } | undefined
      if (item && partial?.content) item.progress = summarizeToolResult(item.name, { content: partial.content })
    }
    if (event.type === 'tool_execution_end') {
      const item = chat.activities.find(a => a.id === event.toolCallId)
      if (item) {
        item.status = event.isError ? '未完成' : '已完成'
        item.isError = Boolean(event.isError)
        item.durationMs =
          typeof event.durationMs === 'number'
            ? event.durationMs
            : item.startedAt
              ? Date.now() - item.startedAt
              : undefined
        item.resultSummary = summarizeToolResult(item.name, { content: event.result?.content ?? [], isError: event.isError })
        item.progress = undefined
      }
      if (event.toolName === 'plan_chapters' && !event.isError)
        window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
      if (
        ['save_draft', 'save_skill_draft', 'save_new_chapter_draft', 'save_outline_draft', 'save_creation_draft'].includes(
          event.toolName || ''
        ) &&
        !event.isError
      ) {
        void reloadChatDrafts(chat).catch(cause => fail(cause, chat))
      }
    }
    if (
      event.type === 'extension_ui_request' &&
      ['select', 'confirm', 'input', 'editor'].includes(event.method || '')
    ) {
      chat.dialog = event
      chat.answerDraft = typeof event.initialValue === 'string' ? event.initialValue : ''
    }
  }
  async function initialize() {
    if (initialized) return initialized
    const initialChat = current.value
    initialized = (async () => {
      await reloadBooks()
      models.value = (await listLocalAiModels({ scene: 'text' })).data.filter(m => m.status === 1)
      const selected = appSettings.getItem('ew-agent-pi-model') || models.value[0]?.code || ''
      if (!initialChat.modelCode)
        initialChat.modelCode = models.value.some(m => m.code === selected)
          ? selected
          : models.value[0]?.code || ''
      if (!isTauriRuntime()) {
        error.value = '请在桌面应用中使用 Agent，网页仅支持预览。'
        bootstrapped = true
        return
      }
      await reloadSkills().catch(() => undefined)
      if (bootstrapped) {
        if (!ready.value) ready.value = (await piCommand<{ ready: boolean }>('status')).ready
        await Promise.all([reloadSessions(), reloadChatDrafts(initialChat)])
        return
      }
      await initializeTasks()
      // 上次关闭前没入库完的附件没有 worker 了，标为失败，模型和作者都能看到原因。
      await recoverChatImports()
      if (!listening) {
        window.addEventListener(RUN_CONTROL_EVENT, event => {
          const { sessionId, control } = (event as CustomEvent<{ sessionId: string; control: PiRunControl }>).detail
          for (const chat of chats.values()) if (chat.sessionId === sessionId) applyRunControl(chat, control)
        })
        await listenPi(
          receive,
          async tool => {
            const chat = byInstance(tool.instanceId)
            if (!chat || retiring || restoring.value || chat.stopping || chat.stopFailed) {
              await piCommand('tool_reply', {
                instanceId: tool.instanceId,
                id: tool.id,
                error: '会话已停止或应用正在关闭'
              })
              return
            }
            const controller = new AbortController()
            toolControllers.set(tool.id, { chat, controller })
            if (tool.tool === 'ask_author') {
              // 引导卡挂在对话里等作者；停止或宿主取消时直接收起，不回复。
              controller.signal.addEventListener('abort', () => {
                if (chat.question?.id === tool.id) chat.question = null
              })
              chat.question = {
                id: tool.id,
                callId: tool.callId,
                spec: normalizeQuestionSpec(tool.args),
                startedAt: Date.now()
              }
              return
            }
            let reply: { result?: unknown; error?: string }
            try {
              const work = executePiTool(tool, controller.signal, text => {
                if (controller.signal.aborted) return
                const item = chat.activities.find(a => a.id === tool.callId)
                if (item) item.status = text
              })
              if (['write_prose', 'run_breakdown', 'refresh_rankings', 'reparse_book_attachment'].includes(tool.tool)) {
                const task = work.catch(cause => {
                  if (
                    controller.signal.aborted &&
                    (cause === controller.signal.reason || cause?.name === 'AbortError')
                  )
                    return
                  throw cause
                })
                platformTasks.set(tool.id, { chat, task })
                chat.pendingTasks++
                void task
                  .finally(() => {
                    platformTasks.delete(tool.id)
                    chat.pendingTasks--
                  })
                  .catch(() => {})
              }
              reply = { result: await work }
            } catch (cause) {
              reply = { error: cause instanceof Error ? cause.message : String(cause) }
            }
            toolControllers.delete(tool.id)
            await piCommand('tool_reply', { instanceId: tool.instanceId, id: tool.id, ...reply }).catch(
              cause => {
                if (chat.instanceId === tool.instanceId && !controller.signal.aborted) fail(cause, chat)
              }
            )
          },
          (id, ids) => {
            for (const requestId of ids) {
              const item = toolControllers.get(requestId)
              if (item?.chat.instanceId === id) item.controller.abort()
            }
          }
        )
        listening = true
      }
      const status = await piCommand<{ ready: boolean; active: string | null; instances?: unknown[] }>(
        'status'
      )
      // 仅 Webview 首次连接时回收丢失工具上下文的旧进程；切页/切对话不会进入此路径。
      if ((status.active || status.instances?.length) && ![...chats.values()].some(c => c.instanceId)) {
        await piCommand('close')
        stopped.value = true
      }
      ready.value = status.ready
      if (!ready.value) error.value = 'Agent 运行环境尚未就绪，请完成安装或开发环境初始化后重试。'
      await Promise.all([reloadSessions(), reloadDrafts()])
      bootstrapped = true
    })()
      .catch(cause => fail(cause))
      .finally(() => {
        initialized = null
      })
    return initialized
  }
  function applyRunControl(chat: PiChatState, control: PiRunControl) {
    if (control.revision > chat.runControl.revision && control.state !== 'active') sending.delete(chat.key)
    if (control.revision >= chat.runControl.revision) {
      chat.runControl = control
      if (control.state === 'active') chat.stopped = false
    }
  }
  function contextOf(chat: PiChatState, config: PiSessionContext) {
    if (config.runControl) applyRunControl(chat, config.runControl)
    chat.bookId = config.bookId
    chat.modelCode = config.modelCode
    chat.contextRevision = config.revision
    if (config.instanceId !== undefined) {
      if (chat.instanceId && chat.instanceId !== config.instanceId) releasePiToolContext(chat.instanceId)
      chat.instanceId = config.instanceId
    }
  }
  const contextSyncs = new Map<string, Promise<void>>()
  async function syncContext(
    chat: PiChatState,
    change?: Partial<Pick<PiSessionContext, 'bookId' | 'modelCode'>>
  ) {
    if (!chat.sessionFile) {
      if (change) Object.assign(chat, change)
      return
    }
    const syncing = contextSyncs.get(chat.key)
    if (syncing) {
      await syncing
      if (!change) return
    }
    if (executing(chat) || chat.connecting || inputLocked.value) return
    chat.connecting = true
    const pending = piCommand<PiSessionContext>('session_context', {
      file: chat.sessionFile,
      modelCode: chat.modelCode,
      revision: chat.contextRevision,
      ...(change ? { change } : {})
    })
    const applying = pending
      .then(config => {
        if (config) contextOf(chat, config)
      })
      .finally(() => {
        controls.delete(applying)
        contextSyncs.delete(chat.key)
        chat.connecting = false
      })
    controls.add(applying)
    contextSyncs.set(chat.key, applying)
    await applying
  }

  async function changeContext(change: Partial<Pick<PiSessionContext, 'bookId' | 'modelCode'>>) {
    const chat = current.value
    if (working(chat) || inputLocked.value) return
    try {
      await syncContext(chat, change)
      chat.error = ''
      await Promise.all([reloadSessions(), reloadChatDrafts(chat)])
      if (!chat.channel) appSettings.setItem('ew-agent-pi-model', chat.modelCode)
    } catch (cause) {
      await syncContext(chat).catch(() => undefined)
      fail(cause, chat)
    }
  }
  async function open(chat: PiChatState) {
    if (working(chat) || inputLocked.value) return
    if (!chat.modelCode) {
      ElMessage.warning('请先配置并选择文本模型')
      return
    }
    chat.connecting = true
    chat.error = ''
    chat.epoch++
    try {
      const pending = piCommand<{ instanceId: string; modelCode?: string; context?: PiSessionContext; runControl?: PiRunControl }>(
        'open',
        {
          modelCode: chat.modelCode,
          bookId: chat.bookId,
          file: chat.sessionFile,
          clientKey: chat.key
        }
      )
      controls.add(pending)
      try {
        const opened = await pending
        chat.instanceId = opened.instanceId
        if (opened.runControl) applyRunControl(chat, opened.runControl)
        if (opened.modelCode) chat.modelCode = opened.modelCode
        if (opened.context) contextOf(chat, opened.context)
      } finally {
        controls.delete(pending)
      }
      appSettings.setItem('ew-agent-pi-model', chat.modelCode)
      chat.skillsRevision = skillsRevision.value
      await refresh(chat)
      chat.stopped = false
      chat.stopFailed = false
      chat.activities = []
    } catch (cause) {
      if (!closing.value) fail(cause, chat)
    } finally {
      chat.connecting = false
    }
  }
  /** 选中文件就开始识别目录：几秒后输入框的附件卡上就有书名、章数和分章提示，入库要等发送。 */
  function attachBook(file: File) {
    if (inputLocked.value) return
    const chat = current.value
    try {
      validateBookFile(file)
      if (chat.attachment) throw new Error('请先发送或移除当前附件，再添加另一份文件')
    } catch (cause) {
      fail(cause)
      return
    }
    chat.attachment = { id: crypto.randomUUID(), file: markRaw(file), catalog: null, previewing: true, error: '' }
    const pending = chat.attachment
    const controller = new AbortController()
    previews.set(pending.id, controller)
    void previewChatBook(pending, controller.signal)
      .then(
        catalog => {
          pending.catalog = catalog
        },
        cause => {
          if (!controller.signal.aborted) pending.error = cause instanceof Error ? cause.message : String(cause)
        }
      )
      .finally(() => {
        pending.previewing = false
        previews.delete(pending.id)
      })
  }
  function removeAttachment() {
    const pending = current.value.attachment
    if (!pending) return
    previews.get(pending.id)?.abort()
    previews.delete(pending.id)
    current.value.attachment = null
  }
  async function send() {
    const chat = current.value,
      input = chat.draft,
      file = chat.attachment
    // 文字开头的 /技能名 是作者选的技能：发给 Pi 时变成 /skill: 命令，正文里不再带它。
    const token = findSkillToken(input, skillNamesForInput(piSkills.value))
    const spoken = (token ? stripSkillToken(input, token) : input).trim()
    const text = spoken || (file ? '请检查这本书的目录，并和我确认拆书范围。' : token ? '' : '')
    // 卡片挂着时，输入框里的话就是对这个问题的回答，不另起一轮。
    if (text && !file && (chat.question || chat.dialog) && !inputLocked.value && !chat.answering) {
      await answerQuestion({ selected: [], selectedIds: [], text })
      if (chat.draft === input) chat.draft = ''
      return
    }
    if ((!text && !token) || working(chat) || inputLocked.value || sending.has(chat.key)) return
    if (file?.previewing) {
      fail(new Error('目录还在识别，稍等几秒再发送'), chat)
      return
    }
    if (file && (file.error || !file.catalog)) {
      fail(new Error(file.error || '这份文件没有识别出目录'), chat)
      return
    }
    const ticket = Symbol('author input'), revision = chat.runControl.revision
    sending.set(chat.key, ticket)
    try {
      await syncContext(chat)
      if (sending.get(chat.key) !== ticket) return
      if (!chat.instanceId) await open(chat)
      if (!chat.instanceId || inputLocked.value || sending.get(chat.key) !== ticket) return
      // 正文里还在的 @标题 才算引用，跟在正文后面；附件标记放最后；选了技能就按 Pi 的 /skill: 命令发，由 Pi 展开技能说明。
      const references = findMentionTokens(text, chat.references).map(item => item.reference)
      let message = references.length ? referenceMessage(text, references) : text
      // 发送不等入库：先登记附件（带上传时识别的目录），消息立刻发出，入库在后台进行。
      let registered: BookAttachment | null = null
      if (file) {
        registered = await beginChatImport(file, chat.sessionId)
        message = attachmentMessage(message, registered)
      }
      if (token) message = skillCommand(token.name, message)
      if (token?.name) noteSessionSkill(chat.sessionId, findSkill(token.name)?.name || token.name)
      if (chat.title === '新对话')
        chat.title = sessionTitleFrom(file ? file.file.name.replace(/\.txt$/i, '') : text) || '新对话'
      try {
        await dispatchPrompt(chat, message, { revision, ticket })
      } catch (cause) {
        if (registered) await abortChatImport(registered.id, chat.sessionId).catch(() => undefined)
        throw cause
      }
      if (chat.draft === input) chat.draft = ''
      if (chat.attachment?.id === file?.id) chat.attachment = null
      chat.references = []
      if (file && registered) {
        const record = registered
        setAttachment(chat, record)
        void runChatImport(file, record, chat.key).then(
          done => setAttachment(chat, done),
          cause => {
            const failed = (cause as { attachment?: BookAttachment | null })?.attachment
            setAttachment(
              chat,
              failed || { ...record, status: 'failed', error: cause instanceof Error ? cause.message : String(cause) }
            )
          }
        )
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (sending.get(chat.key) === ticket && message.startsWith('PI_COMMAND_REJECTED:')) chat.running = false
      if (sending.get(chat.key) === ticket && !closing.value && !chat.stopping && (cause as Error)?.name !== 'AbortError') fail(cause, chat)
    } finally {
      if (sending.get(chat.key) === ticket) sending.delete(chat.key)
    }
  }
  /** --skill 路径在进程启动时确定；保留原会话重连，才能应用新增、删除和启停后的完整列表。 */
  async function ensureSkillsFresh(chat: PiChatState) {
    if (!chat.instanceId || chat.skillsRevision === skillsRevision.value) return
    await releaseIdle(chat)
    await open(chat)
    if (!chat.instanceId) throw new Error(chat.error || '技能更新后重新连接失败')
  }
  async function saveSkill(input: SkillInput) {
    const saved = await saveSkillFile(input)
    bumpSkillsRevision()
    return saved
  }
  async function deleteSkill(id: string) {
    await deleteSkillFile(id)
    bumpSkillsRevision()
  }
  async function toggleSkill(id: string, enabled: boolean) {
    await setSkillEnabled(id, enabled)
    bumpSkillsRevision()
  }
  async function importSkill(path: string) {
    const imported = await importSkillFile(path)
    bumpSkillsRevision()
    return imported
  }
  /** 右栏"采用为封面"：裁成封面比例写进作品，再刷新书库列表。 */
  async function applyCover(id: string) {
    await applyCoverTask(id)
    await reloadBooks().catch(() => ElMessage.warning('封面已保存，书库列表刷新失败'))
  }
  function addReference(item: PiReference) {
    const chat = current.value
    if (chat.references.some(r => r.kind === item.kind && r.id === item.id)) return
    chat.references = [...chat.references, { kind: item.kind, id: item.id, title: item.title }]
  }
  function removeReference(index: number) {
    const chat = current.value
    chat.references = chat.references.filter((_, i) => i !== index)
  }
  /** 把一条消息交给 Pi 开始新一轮；作者的输入和平台事件都走这里。 */
  async function dispatchPrompt(chat: PiChatState, message: string, dispatch: { origin?: 'author' | 'automatic' | 'resume'; task?: PiTaskView; revision?: number; ticket?: symbol } = {}) {
    const { origin = 'author', task, ticket } = dispatch
    const revision = dispatch.revision ?? chat.runControl.revision
    await ensureSkillsFresh(chat)
    if (inputLocked.value || ticket && sending.get(chat.key) !== ticket) throw new DOMException('本次发送已被停止，输入仍保留', 'AbortError')
    chat.epoch++
    chat.running = true
    chat.stopped = false
    chat.activities = []
    chat.updatedAt = Date.now()
    const result = await piCommand<Record<string, unknown>>('request', {
      instanceId: chat.instanceId, origin, ...(origin !== 'automatic' ? { controlRevision: revision } : {}), ...(task ? { task: { kind: task.kind, id: task.id } } : {}),
      command: { type: 'prompt', message }
    })
    const currentDispatch = !ticket || sending.get(chat.key) === ticket
    if (result.runControl) applyRunControl(chat, result.runControl as PiRunControl)
    if (!currentDispatch) throw new DOMException('本次发送已被停止，输入仍保留', 'AbortError')
    if (result.disposition === 'superseded') { chat.running = false; throw new DOMException('执行状态已改变，本条消息未执行', 'AbortError') }
    void assignPendingGroup(chat)
    if (result.disposition === 'handled' || result.disposition === 'blocked') chat.running = false
    return result
  }
  /** 所有后台续聊和连写入口共用检查；原生层还会在真正发起请求前核对状态。 */
  async function dispatchAutomatic(view: PiTaskView, message: string, step: boolean) {
    const chat = [...chats.values()].find(c => c.sessionId === view.sessionId)
    const blocked = async (reason: string) => {
      if (step) await taskStepBlocked(view)
      else await markTaskContinueSkipped(view.kind, view.id, reason)
    }
    if (!chat) return blocked('发起任务的对话没有打开')
    if (closing.value || restoring.value || chat.controlling || !allowsTaskContinuation(chat.runControl, view)) return
    if (working(chat) || chat.dialog || chat.question || sending.has(chat.key)) return blocked('对话当时正忙')
    const ticket = Symbol('automatic continuation')
    sending.set(chat.key, ticket)
    try {
      await syncContext(chat)
      if (sending.get(chat.key) !== ticket) return
      if (!allowsTaskContinuation(chat.runControl, view)) return
      if (!chat.instanceId) await open(chat)
      if (!chat.instanceId) return blocked('对话没有连接上')
      if (step) await taskStepSent(view)
      const result = await dispatchPrompt(chat, message, { origin: 'automatic', task: view, ticket })
      if (result.disposition === 'blocked') return blocked('当前阶段已暂停或结束，等待作者明确继续')
      if (!step) await markTaskContinued(view.kind, view.id)
    } catch (cause) {
      if (sending.get(chat.key) !== ticket || (cause as Error)?.name === 'AbortError') return
      await blocked(cause instanceof Error ? cause.message : String(cause))
      if (!closing.value) fail(cause, chat)
    } finally { if (sending.get(chat.key) === ticket) sending.delete(chat.key) }
  }
  async function continueAfterTask(view: PiTaskView, force = false) {
    if (view.status !== 'completed' || !force && (!view.autoContinue || view.continuedAt)) return
    if (force) await changeRunControl(view.sessionId, 'release_task', { task: { kind: view.kind, id: view.id } })
    const message = taskEventMessage(view)
    if (message) await dispatchAutomatic(view, message, false)
  }
  activeWorkspace = async finished => {
    const view = taskView(finished.kind, finished.id)
    if (view) await continueAfterTask(view)
  }
  async function sendTaskStep(view: PiTaskView) {
    const message = taskStepMessage(view)
    if (message) await dispatchAutomatic(view, message, true)
  }
  activeStepper = async step => {
    const view = taskView(step.kind, step.id)
    if (view) await sendTaskStep(view)
  }
  async function pauseConversation(chat = current.value) {
    if ((!chat.sessionId && !chat.instanceId) || chat.controlling || chat.answering || inputLocked.value) return
    const resumeAgent = chat.running || !!chat.question || !!chat.dialog
    sending.delete(chat.key)
    chat.controlling = true
    try {
      // 立即撤销当前实例；元数据写入期间，统一自动入口由 controlling 阻止进入。
      if (chat.instanceId) await stopChat(chat)
      const stopped = !chat.stopFailed
      if (chat.sessionId) {
        const changed = await changeRunControl(chat.sessionId, 'pause', { resumeAgent })
        applyRunControl(chat, changed.control)
        await pauseHeldTasks(changed.control.heldTasks.filter(task => task.revision === changed.control.revision))
      }
      chat.stopFailed = !stopped
    } catch (cause) { chat.stopFailed = true; fail(cause, chat) }
    finally { chat.controlling = false }
  }
  async function resumeConversation(chat = current.value) {
    if (chat.runControl.state !== 'paused' || working(chat) || inputLocked.value) return
    let revision: number
    try {
      await syncContext(chat)
      const control = chat.runControl
      if (control.state !== 'paused') return
      revision = control.revision
      if (control.pausedBookId === null) throw new Error('此暂停记录没有目标作品，请发送新的要求')
      if (control.pausedBookId !== chat.bookId) {
        const title = (id: string) => id ? `《${books.value.find(book => book.id === id)?.title || '原作品已不在书库'}》` : '未绑定作品的对话'
        await inkConfirm(
          `暂停的工作属于${title(control.pausedBookId)}，现在选择的是${title(chat.bookId)}。返回暂停时的目标继续？如需为当前作品创作，可取消后发送新要求；原任务仍保留。`,
          '确认继续工作的目标',
          { confirmButtonText: '返回原目标并继续', cancelButtonText: '保留暂停', distinguishCancelAndClose: true }
        )
        if (inputLocked.value || working(chat) || chat.runControl.revision !== revision) return
        await syncContext(chat, { bookId: control.pausedBookId })
      }
      if (inputLocked.value || working(chat) || chat.runControl.revision !== revision) return
    } catch (cause) {
      if (cause !== 'cancel' && cause !== 'close') fail(cause, chat)
      return
    }
    chat.controlling = true
    let changed: PiRunControlChange
    try {
      changed = await changeRunControl(chat.sessionId, 'resume', { revision })
      applyRunControl(chat, changed.control)
      await resumeHeldTasks(changed.releasedTasks)
    } catch (cause) { fail(cause, chat); return }
    finally { chat.controlling = false }
    const resumingBatch = changed.releasedTasks.some(task => task.kind === 'batch' && task.wasRunning)
    if (changed.resumeAgent && !resumingBatch) {
      if (chat.runControl.revision !== changed.control.revision || sending.has(chat.key)) return
      const ticket = Symbol('resume')
      sending.set(chat.key, ticket)
      try {
        await syncContext(chat)
        if (sending.get(chat.key) !== ticket) return
        if (!chat.instanceId) await open(chat)
        if (chat.instanceId) await dispatchPrompt(chat, '继续刚才暂停的工作。', { origin: 'resume', revision: changed.control.revision, ticket })
      } catch (cause) { if ((cause as Error)?.name !== 'AbortError') fail(cause, chat) }
      finally { if (sending.get(chat.key) === ticket) sending.delete(chat.key) }
    } else {
      for (const held of changed.releasedTasks) {
        const view = taskView(held.kind, held.id)
        if (view?.status === 'completed') await continueAfterTask(view)
        else if (view) await sendTaskStep(view)
      }
    }
  }
  async function stopChat(chat: PiChatState) {
    if (!chat.instanceId || chat.stopping) return
    chat.stopping = true
    chat.stopFailed = false
    chat.epoch++
    const id = chat.instanceId,
      settling = settlePlatformTasks(chat)
    void settling.catch(() => {})
    cancelTools(chat)
    try {
      const result = await piCommand<{
        state?: Record<string, unknown>
        messages?: PiMessage[]
        history?: PiSessionHistory
      }>('stop', {
        instanceId: id
      })
      await settling
      if (result.state) stateOf(chat, result.state)
      if (result.history?.entries) chat.messages = projectPiEntries(result.history)
      else if (Array.isArray(result.messages)) chat.messages = projectPiHistory(result.messages)
      chat.instanceId = ''
      chat.running = false
      chat.streamingIndex = null
      chat.dialog = null
      chat.question = null
      chat.stopped = true
      chat.error = ''
      chat.activities = chat.activities.map(item =>
        !['已完成', '未完成', '已停止'].includes(item.status) ? { ...item, status: '已停止' } : item
      )
    } catch (cause) {
      chat.stopFailed = true
      fail(cause, chat)
    } finally {
      chat.stopping = false
    }
    if (!chat.stopFailed)
      await Promise.all([reloadSessions(), reloadChatDrafts(chat)]).catch(cause => fail(cause, chat))
  }
  const stop = () => pauseConversation()
  /** groupId 不为空时，这个对话发出第一条消息后直接归入该分组。 */
  async function newChat(groupId = '') {
    view.value = 'chat'
    if (inputLocked.value) return
    const unsent = [...chats.values()].find(
      c => !c.sessionFile && !c.instanceId && !c.connecting && !c.messages.length
    )
    if (unsent) {
      unsent.pendingGroupId = groupId
      activeKey.value = unsent.key
      return
    }
    const previous = current.value,
      fresh = makeChat(previous.modelCode, previous.bookId)
    fresh.pendingGroupId = groupId
    chats.set(fresh.key, fresh)
    activeKey.value = fresh.key
  }
  async function assignPendingGroup(chat: PiChatState) {
    const groupId = chat.pendingGroupId
    if (!groupId || !chat.sessionId) return
    try {
      await piCommand('session_meta', { sessionId: chat.sessionId, change: { groupId } })
      await reloadSessions()
    } catch (cause) {
      // 分组可能已被删除；对话保留在未分组，不打断发送。
      chat.pendingGroupId = ''
      fail(cause, chat)
    }
  }
  async function selectSession(session: PiSession) {
    view.value = 'chat'
    if (inputLocked.value) return
    let chat =
      (session.localKey ? chats.get(session.localKey) : undefined) ||
      [...chats.values()].find(c => c.sessionFile && c.sessionFile === session.file)
    if (!chat) {
      const fresh = makeChat(session.modelCode || current.value.modelCode, session.book?.id || '')
      fresh.sessionId = session.id
      fresh.sessionFile = session.file
      fresh.title = session.title
      fresh.updatedAt = session.updatedAt
      chats.set(fresh.key, fresh)
      chat = chats.get(fresh.key)!
    }
    activeKey.value = chat.key
    if (!chat.instanceId && !working(chat)) await open(chat)
  }
  // 桌宠只读取投影，不执行工具、不自动采用候选；点击提示后才切换当前会话。
  const petActivities = computed(() => [...chats.values()].filter(chat => !chat.channel).map(chat => {
    const pendingDraft = chat.drafts.some(draft => !draft.appliedAt && !draft.dismissedAt)
    const phase = chat.error ? 'error' as const : chat.question || chat.dialog ? 'waiting' as const
      : working(chat) ? 'running' as const : pendingDraft ? 'waiting' as const : chat.stopped ? 'cancelled' as const : 'done' as const
    return { id: `pi:${chat.key}`, phase, target: `pi:${chat.key}`,
      message: phase === 'error' ? '本轮创作未完成，点击查看原因。' : phase === 'running' ? 'AI 正在处理你的创作任务…'
        : phase === 'waiting' ? (chat.question || chat.dialog ? 'AI 有个问题，等你回答。' : '候选稿已准备好，等待你确认。') : '本轮创作已完成，去看看结果吧。' }
  }))
  function focusPetChat(key: string) {
    if (inputLocked.value || !chats.has(key)) return
    view.value = 'chat'; activeKey.value = key
  }
  /** 引导卡的回答：工具桥的问题走 tool_reply，Pi 原生询问映射回原生回复。 */
  async function answerQuestion(answer: PiQuestionAnswer, chat = current.value) {
    if (inputLocked.value || chat.answering) return
    const pending = chat.question
    if (pending) {
      const pauseAfter = pending.spec.kind === 'choice' && (answer.cancelled || (answer.nextAction || pending.spec.afterAnswer) === 'pause')
      chat.answering = true
      if (pauseAfter) chat.controlling = true
      try {
        await piCommand('tool_reply', { instanceId: chat.instanceId, id: pending.id, result: answer })
        if (pauseAfter) {
          const control = await readRunControl(chat.sessionId)
          applyRunControl(chat, control)
          await pauseHeldTasks(control.heldTasks.filter(task => task.revision === control.revision))
        }
        if (chat.question?.id === pending.id) chat.question = null
        toolControllers.delete(pending.id)
      } catch (cause) {
        if (pauseAfter) chat.stopFailed = true
        fail(cause, chat)
      } finally {
        chat.answering = false
        if (pauseAfter) chat.controlling = false
      }
      return
    }
    if (!chat.dialog) return
    const spec = specFromDialog(chat.dialog)
    if (answer.cancelled) return answerDialog(undefined, chat)
    if (spec.kind === 'confirm') return answerDialog(answer.selectedIds?.[0] !== 'no', chat)
    if (chat.dialog.method === 'select') return answerDialog(answer.selected[0] ?? answer.text ?? '', chat)
    return answerDialog(answer.text ?? '', chat)
  }
  async function answerDialog(value?: string | boolean, chat = current.value) {
    const question = chat.dialog
    if (!question || inputLocked.value) return
    await piCommand('send', {
      instanceId: chat.instanceId,
      command: {
        type: 'extension_ui_response',
        id: question.id,
        ...(value === undefined
          ? { cancelled: true }
          : typeof value === 'boolean'
            ? { confirmed: value }
            : { value })
      }
    })
    if (chat.dialog?.id === question.id) {
      chat.dialog = null
      chat.answerDraft = ''
    }
  }
  function updateDraft(saved: PiDraft) {
    for (const chat of chats.values()) {
      const visible = chat.drafts.find(d => d.id === saved.id)
      if (visible) Object.assign(visible, saved)
      if (chat.openedDraft?.id === saved.id) Object.assign(chat.openedDraft, saved)
    }
  }
  function ensureAdoptionIdle(chat: PiChatState) {
    if (inputLocked.value || working(chat)) {
      const cause = new Error('本轮仍在生成或应用正在收尾，未提交采用操作；等待完成后再采用，平台确认卡不受此限制')
      ElMessage.warning(cause.message)
      throw cause
    }
  }
  async function prepareAdoption(content: string): Promise<PiDraftConfirmation | undefined> {
    if (restoring.value) throw new Error('正在恢复备份，请重新启动后再采用草稿')
    if (closing.value) throw new Error('正在关闭应用，未开始新的采用操作')
    const chat = current.value,
      selected = chat.openedDraft
    if (!selected) return
    ensureAdoptionIdle(chat)
    try {
      const prepared = await preparePiDraftConfirmation(
        selected.id,
        content,
        draftEdits.get(selected.id)?.revision ?? selected.revision ?? 0,
        draftEdits.get(selected.id)?.manual ? 'author' : 'supplied'
      )
      if (draftEdits.get(selected.id)?.content === content) draftEdits.delete(selected.id)
      updateDraft(prepared.draft)
      return prepared
    } catch (cause) {
      fail(cause, chat)
      throw cause
    }
  }
  async function adopt(confirmation: PiDraftConfirmation) {
    if (restoring.value) throw new Error('正在恢复备份，请重新启动后再采用草稿')
    if (closing.value) throw new Error('正在关闭应用，未提交新的采用操作')
    const chat = [...chats.values()].find(c => c.sessionId === confirmation.draft.sessionId) || current.value
    ensureAdoptionIdle(chat)
    try {
      const saved = await applyPiDraft(confirmation.draft.id, confirmation)
      updateDraft(saved)
      await notifyDraftApplied(saved).catch(cause => fail(cause, chat))
      if ((saved.kind === 'entity' && saved.entity === 'book') || saved.kind === 'short_story') {
        await reloadBooks().catch(() => ElMessage.warning('作品已保存，书库列表刷新失败'))
        if (saved.kind === 'entity' && !working(chat))
          await syncContext(chat).catch(() => ElMessage.warning('作品已保存，下一次发送时同步会话配置'))
      }
      if (saved.kind === 'skill') {
        // 技能目录变了：技能页刷新，开着的对话下次发消息前重新加载技能
        await reloadSkills().catch(() => undefined)
        bumpSkillsRevision()
      }
      await reloadChatDrafts(chat).catch(() =>
        ElMessage.warning('已保存，但界面刷新失败，请重新打开草稿查看。')
      )
      ElMessage.success(
        saved.kind === 'entity'
          ? saved.entity === 'book'
            ? '已创建作品，当前对话空闲后自动切换到新作品'
            : '已保存到作品资料或目录'
          : saved.kind === 'short_story' ? '已创建新书并保存首章'
          : saved.kind === 'skill'
            ? `已保存为技能「${saved.appliedSkillName || saved.title}」，输入 / 就能用`
          : saved.kind === 'outline'
            ? '已采用大纲修改建议'
            : saved.kind === 'new_chapter'
              ? '已创建新章节并保存到目标卷末'
              : '已保存到章节，并保留原文历史'
      )
    } catch (cause) {
      fail(cause, chat)
    }
  }
  async function prepareAdoptionBatch(ids: string[]) {
    ensureAdoptionIdle(current.value)
    const chat = current.value
    if (ids.some(id => !chat.drafts.some(d => d.id === id && !d.appliedAt && !d.dismissedAt))) throw new Error('候选清单已改变，请重新核对')
    return preparePiDraftBatch(ids, chat.sessionId)
  }
  /** 保存前核对冻结的整批版本；哪份失败就停在哪份，不把部分成功说成全部保存。 */
  async function adoptAll(ids: string[], confirmations?: PiDraftConfirmation[]) {
    ensureAdoptionIdle(current.value)
    const chat = current.value
    const prepared = confirmations || await prepareAdoptionBatch(ids)
    if (prepared.length !== ids.length || prepared.some((c, i) => c.draft.id !== ids[i] || c.draft.sessionId !== chat.sessionId)) throw new Error('采用清单与确认不一致')
    let done = 0
    let bookCreated = false
    try {
      await validatePiDraftBatch(prepared, chat.sessionId)
      for (const confirmation of prepared) {
        if (inputLocked.value || working(chat)) throw new Error('当前状态已变化，已停止后续采用')
        const saved = await applyPiDraft(confirmation.draft.id, confirmation)
        updateDraft(saved)
        await notifyDraftApplied(saved).catch(cause => fail(cause, chat))
        if (saved.kind === 'entity' && saved.entity === 'book') bookCreated = true
        done++
      }
    } catch (cause) {
      fail(cause, chat)
    }
    if (bookCreated) {
      await reloadBooks().catch(() => ElMessage.warning('作品已保存，书库列表刷新失败'))
      if (!working(chat)) await syncContext(chat).catch(() => ElMessage.warning('作品已保存，下一次发送时同步会话配置'))
    }
    await reloadChatDrafts(chat).catch(() => ElMessage.warning('已保存，但界面刷新失败，请重新打开草稿查看。'))
    if (done) ElMessage.success(done === ids.length ? `已采用 ${done} 份，保存到作品资料` : `已采用 ${done} 份，第 ${done + 1} 份未保存`)
  }
  async function persistEdit(id: string, content: string) {
    try {
      const selected = [...chats.values()]
        .flatMap(c => [...c.drafts, ...(c.openedDraft ? [c.openedDraft] : [])])
        .find(d => d.id === id)
      const revision = draftEdits.get(id)?.revision ?? selected?.revision ?? 0
      const saved = await savePiDraftEdit(id, content, revision,draftEdits.get(id)?.manual ? 'author' : 'supplied')
      updateDraft(saved)
      if (draftEdits.get(id)?.content === content) draftEdits.delete(id)
      else if (draftEdits.get(id)?.revision === revision)
        draftEdits.set(id, { ...draftEdits.get(id)!, revision: saved.revision ?? 0 })
    } catch (cause) {
      fail(cause)
      throw cause
    }
  }
  function editDraft(id: string, content: string) {
    const pending = persistEdit(id, content)
    editing.add(pending)
    void pending.finally(() => editing.delete(pending)).catch(() => {})
    return pending
  }
  async function flushDrafts() {
    await Promise.allSettled([...editing])
    for (const [id, edit] of [...draftEdits]) await editDraft(id, edit.content)
  }
  function beginClose() {
    closing.value = true
    closingSaves = capturePiSaves()
  }
  async function needsCloseConfirmation() {
    if (hasRunningTasks() || hasRunningImports()) return true
    if ([...chats.values()].some(c => working(c) || c.dialog || c.question)) return true
    return (await piCommand<{ busy: boolean }>('close_status')).busy
  }
  async function prepareClose() {
    // 作者确认关闭后才拒绝新工具；仅显示关闭确认时仍让原任务继续。
    retiring = true
    sending.clear()
    await cancelChatImports()
    await stopTasks()
    await piCommand('begin_exit')
    const settling = settlePlatformTasks()
    void settling.catch(() => {})
    cancelTools()
    try {
      await piCommand('close')
    } catch (cause) {
      for (const c of chats.values()) if (c.instanceId) c.stopFailed = true
      throw cause
    }
    await Promise.allSettled([...controls])
    await settling
    for (const chat of chats.values()) {
      chat.instanceId = ''
      chat.running = false
      chat.stopping = false
      chat.stopFailed = false
      chat.dialog = null
      chat.question = null
      chat.streamingIndex = null
      chat.stopped = true
    }
    await flushDrafts()
    await waitForPiSaves(closingSaves)
    await piCommand('finish_exit')
  }
  async function cancelClose() {
    await piCommand('cancel_exit')
    retiring = false
    allowBreakdownTasks()
    closing.value = false
    closingSaves = undefined
  }
  async function prepareMaintenance() {
    if (inputLocked.value) throw new Error('关闭或数据恢复正在进行，请等待完成')
    if (hasRunningTasks()) throw new Error('还有任务正在运行，请先暂停再恢复备份')
    if ([...chats.values()].some(c => working(c) || c.dialog || c.question))
      throw new Error('还有 Agent 任务在执行，请先停止再恢复备份')
    restoring.value = true
    sending.clear()
    const saves = capturePiSaves()
    try {
      if ((await piCommand<{ busy: boolean }>('close_status')).busy)
        throw new Error('还有 Agent 任务在执行，请先停止再恢复备份')
      await flushDrafts()
      await waitForPiSaves(saves)
      await piCommand('maintenance')
      cancelTools()
      for (const chat of chats.values()) {
        chat.instanceId = ''
        chat.stopped = true
      }
    } catch (cause) {
      restoring.value = false
      throw cause
    }
  }
  async function endMaintenance() {
    await piCommand('end_maintenance')
    restoring.value = false
  }
  const naming = new Set<string>()
  /** 首轮结束后自动起名；作者手动改过的名字不覆盖，起名失败只保留原标题。 */
  async function maybeAutoName(chat: PiChatState) {
    if (closing.value || restoring.value || chat.runControl.state !== 'active' || chat.runControl.pendingInput || !chat.sessionId || naming.has(chat.sessionId)) return
    if (sessionRecords.value.find(s => s.id === chat.sessionId)?.named) return
    if (chat.messages.filter(m => m.role === 'user').length !== 1) return
    naming.add(chat.sessionId)
    try {
      const title = await generateSessionTitle(chat.modelCode, chat.messages)
      if (!title || closing.value || restoring.value) return
      if (sessionRecords.value.find(s => s.id === chat.sessionId)?.titleSource === 'manual') return
      await piCommand('session_meta', { sessionId: chat.sessionId, change: { title, auto: true } })
      chat.title = title
      await reloadSessions()
    } catch {
      /* 起名失败不影响对话 */
    } finally {
      naming.delete(chat.sessionId)
    }
  }
  const chatOf = (session: PiSession) =>
    (session.localKey ? chats.get(session.localKey) : undefined) ||
    [...chats.values()].find(c => c.sessionFile && c.sessionFile === session.file)
  function discardChat(chat: PiChatState) {
    chats.delete(chat.key)
    if (activeKey.value !== chat.key) return
    const unsent = [...chats.values()].find(c => !c.sessionFile && !c.instanceId && !c.messages.length)
    if (unsent) {
      activeKey.value = unsent.key
      return
    }
    const fresh = makeChat(chat.modelCode, chat.bookId)
    chats.set(fresh.key, fresh)
    activeKey.value = fresh.key
  }
  /** 归档或删除前先回收空闲实例；运行中的对话必须先停止。 */
  async function releaseIdle(chat: PiChatState | undefined) {
    if (!chat) return
    if (working(chat)) throw new Error('对话仍在运行，请先停止')
    if (!chat.instanceId) return
    chat.stopping = true
    try {
      await piCommand('close', { instanceId: chat.instanceId })
      chat.instanceId = ''
    } finally {
      chat.stopping = false
    }
  }
  async function updateSessionMeta(session: PiSession, change: Record<string, unknown>) {
    const id = session.file ? session.id : chatOf(session)?.sessionId
    if (!id) throw new Error('对话还没有保存，发送第一条消息后再操作')
    await piCommand('session_meta', { sessionId: id, change })
    await reloadSessions()
  }
  async function renameSession(session: PiSession, title: string) {
    const name = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!name) throw new Error('请输入对话名称')
    const chat = chatOf(session)
    if (chat) chat.title = name
    await updateSessionMeta(session, { title: name })
  }
  const pinSession = (session: PiSession, pinned: boolean) => updateSessionMeta(session, { pinned })
  const moveSession = (session: PiSession, groupId: string | null) => updateSessionMeta(session, { groupId })
  async function archiveSession(session: PiSession) {
    if (inputLocked.value) return
    const chat = chatOf(session)
    await releaseIdle(chat)
    if (session.file || chat?.sessionFile) await updateSessionMeta(session, { archived: true })
    if (chat) discardChat(chat)
  }
  const restoreSession = (session: PiSession) => updateSessionMeta(session, { archived: false })
  async function deleteSession(session: PiSession) {
    if (inputLocked.value) return
    const chat = chatOf(session)
    await releaseIdle(chat)
    const file = session.file || chat?.sessionFile
    if (file) await piCommand('delete_session', { file })
    if (chat) discardChat(chat)
    await reloadSessions()
  }
  async function saveGroup(name: string, id?: string) {
    const group = await piCommand<PiSessionGroup>('group_save', { name, ...(id ? { id } : {}) })
    await reloadSessions()
    return group
  }
  async function deleteGroup(id: string) {
    await piCommand('group_delete', { id })
    await reloadSessions()
  }
  async function searchSessions(query: string) {
    const hits = await piCommand<PiSessionSearchHit[]>('search_sessions', { query })
    return Array.isArray(hits) ? hits : []
  }
  /** 页面之外的入口使用同一 Pi 生命周期及平台工具，不挂载任何对话组件。 */
  const channelChats = new Map<string, string>()
  const channelOpening = new Map<string, Promise<PiChatState>>()
  async function channelSession(key: string, selectedBook = '', selectedModel = ''): Promise<PiChatState> {
    const pending = channelOpening.get(key)
    if (pending) return pending
    const opening = (async () => {
      if (!bootstrapped) await initialize()
      if (!ready.value || inputLocked.value) throw new Error(error.value || 'Agent 暂不可用')
      let chat = chats.get(channelChats.get(key) || '')
      if (chat) return chat
      const file = appSettings.getItem(`ew-pi-channel:${key}`) || ''
      const session = sessionRecords.value.find(s => s.file === file && !s.archivedAt)
      chat = session && [...chats.values()].find(c => c.sessionFile === file)
      if (!chat) {
        const fresh = makeChat(session?.modelCode || selectedModel || current.value.modelCode, session?.book?.id || selectedBook)
        fresh.channel = 'weixin'
        fresh.sessionFile = session?.file || ''
        fresh.sessionId = session?.id || ''
        fresh.title = session?.title || '微信对话'
        chats.set(fresh.key, fresh)
        chat = chats.get(fresh.key)!
      }
      chat.channel = 'weixin'
      channelChats.set(key, chat.key)
      if (!chat.instanceId) await open(chat)
      if (!chat.instanceId) { channelChats.delete(key); throw new Error(chat.error || 'Agent 连接失败') }
      appSettings.setItem(`ew-pi-channel:${key}`, chat.sessionFile)
      await flushAppSettings()
      return chat
    })()
    channelOpening.set(key, opening)
    try { return await opening } finally { channelOpening.delete(key) }
  }
  const channelChat = (id: string) => {
    const chat = [...chats.values()].find(c => c.sessionId === id && c.channel === 'weixin')
    if (!chat) throw new Error('微信会话不存在，请重新发送')
    return chat
  }
  async function syncChannelContext(chat: PiChatState, desired?: {bookId?:string;modelCode?:string}) {
    const change = Object.fromEntries(Object.entries(desired || {}).filter(([key,value])=>value!==undefined && chat[key as 'bookId'|'modelCode']!==value))
    const persisted = chat.messages.some(m=>m.role==='user') || sessionRecords.value.some(s=>s.file===chat.sessionFile)
    if (persisted) {
      await syncContext(chat,Object.keys(change).length?change:undefined)
      return
    }
    // Pi 在第一条消息前只分配文件名，不创建 JSONL。此时没有可恢复的历史。
    if (Object.keys(change).length) {
      await stopChat(chat)
      if (chat.stopFailed) throw new Error(chat.error || '未能切换空会话')
      chat.sessionFile='';chat.sessionId='';chat.contextRevision=0
      Object.assign(chat,change)
      await open(chat)
      if (!chat.instanceId) throw new Error(chat.error || 'Agent 连接失败')
      for (const [key,chatKey] of channelChats) if (chatKey===chat.key) appSettings.setItem(`ew-pi-channel:${key}`,chat.sessionFile)
      await flushAppSettings()
    }
  }
  async function channelSend(id: string, text: string, change: { bookId: string; modelCode: string }) {
    const chat = channelChat(id)
    if (working(chat) || chat.question || chat.dialog || inputLocked.value || sending.has(chat.key))
      throw new Error('这段对话正在处理，请先完成当前提问或停止')
    const ticket = Symbol('channel input'), revision = chat.runControl.revision
    sending.set(chat.key, ticket)
    try {
      await syncChannelContext(chat, change)
      if (!chat.instanceId) await open(chat)
      if (!chat.instanceId) throw new Error(chat.error || 'Agent 连接失败')
      return await dispatchPrompt(chat, text, { revision, ticket })
    } catch (cause) {
      if (sending.get(chat.key) === ticket && String(cause).includes('PI_COMMAND_REJECTED:')) chat.running = false
      throw cause
    } finally { if (sending.get(chat.key) === ticket) sending.delete(chat.key) }
  }
  async function channelAnswer(id: string, questionId: string, answer: PiQuestionAnswer) {
    const chat = channelChat(id)
    if (String(chat.question?.id || chat.dialog?.id || '') !== questionId) throw new Error('这张确认卡已失效，请查看新的问题')
    await answerQuestion(answer, chat)
    if (String(chat.question?.id || chat.dialog?.id || '') === questionId) throw new Error(chat.error || '回答未送达，请重试')
  }
  async function channelContext(id: string, change: { bookId: string; modelCode?: string }) {
    const chat = channelChat(id)
    if (working(chat) || chat.question || chat.dialog || inputLocked.value) throw new Error('当前对话正在处理，请先停止后切换作品')
    await syncChannelContext(chat, change)
  }
  return {
    channelSession, channelChat, channelSend, channelAnswer, channelContext,
    reloadBooks,
    channelSync: (id: string) => syncChannelContext(channelChat(id)),
    channelStop: async (id: string) => {
      const chat = channelChat(id)
      if (chat.controlling || chat.answering) throw new Error('正在保存回答或处理阶段状态，请稍后再停止')
      await pauseConversation(chat)
      if (chat.stopFailed || chat.running) throw new Error(chat.error || 'Agent 停止失败，请重试')
    },
    channelDrafts: (id: string) => reloadChatDrafts(channelChat(id)),
    tasks: piTasks,
    attachment,
    attachments,
    references,
    skills: piSkills,
    enterToSend, setEnterToSend,
    view,
    saveSkill,
    deleteSkill,
    toggleSkill,
    importSkill,
    addReference,
    removeReference,
    applyCover,
    attachBook,
    removeAttachment,
    activeKey,
    inputLocked,
    answerDraft,
    restoring,
    prepareMaintenance,
    endMaintenance,
    closing,
    draftContent,
    setDraftContent,
    beginClose,
    needsCloseConfirmation,
    prepareClose,
    cancelClose,
    flushDrafts,
    ready,
    runControl: computed(() => current.value.runControl),
    settling: computed(() => current.value.settling),
    controlling: computed(() => current.value.controlling),
    connecting,
    running,
    stopping,
    stopFailed,
    busy,
    error,
    retry,
    draft,
    bookId,
    modelCode,
    changeContext,
    instanceId,
    sessionId,
    sessionFile,
    books,
    models,
    sessions,
    visibleSessions,
    archivedSessions,
    groups,
    reloadSessions,
    resync,
    continueAfterTask,
    renameSession,
    pinSession,
    moveSession,
    archiveSession,
    restoreSession,
    deleteSession,
    saveGroup,
    deleteGroup,
    searchSessions,
    messages,
    drafts,
    activities,
    dialog,
    question,
    answering,
    pendingQuestion,
    answerQuestion,
    resumeConversation,
    openedDraft,
    openedResult,
    thinkingMs,
    stopped,
    initialize,
    send,
    stop,
    newChat,
    selectSession,
    petActivities,
    focusPetChat,
    answer: answerDialog,
    prepareAdoption,
    adopt,
    adoptAll,
    prepareAdoptionBatch,
    reloadDrafts,
    editDraft
  }
})
