import { proseBriefSchema, proseMode } from './prose-brief.js'
import { decodeModelEscapes, RAW_TEXT_TOOLS } from './tool-input.js'
import { withAuthorMessages } from './author-messages.js'
import { decideAuthorInput, type AuthorInput } from './author-decision.js'
import type { PiRankingPolicy } from '../../src/types/pi-rankings.js'
import { rankingScopeReady, rankingVocabulary, rankingQueryLimit } from '../../src/agent-pi/ranking-scope.js'
import { rankingTools, refreshResultText } from './rankings.js'
import { publicTools, groupedArguments, resolveTool, toolNotice } from './tool-groups.js'
import { creationInputSchema, normalizeCreationInput } from './creation-input.js'
import { Type, type ProviderHeaders, type UserMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'

/** 仅扩展完整 Pi：不实现模型循环、重试、会话或流式协议。 */
export default function (pi: ExtensionAPI) {
  const model = JSON.parse(process.env.EW_PI_MODEL || '{}')
  const book = JSON.parse(process.env.EW_PI_BOOK || 'null')
  const endpoint = process.env.EW_PI_TOOL_URL || ''
  const token = process.env.EW_PI_TOOL_TOKEN || ''
  let rankingPolicy: PiRankingPolicy | null = null
  let refreshHandled = false
  let authorInputId = ''
  let expectedStop: 'aborted' | 'stop' | undefined
  let remainingTask: {source:UserMessage;content:string} | null = null
  const stop = (ctx: ExtensionContext, outcome: 'aborted' | 'stop' = 'aborted') => { expectedStop = outcome; ctx.abort() }
  if (!model.modelCode || !model.baseUrl) throw new Error('易创模型配置缺失')
  process.env.EW_PI_API_KEY = model.apiKey || 'local-no-key'
  pi.registerProvider('yichuang', {
    name: '易创模型',
    api: 'openai-completions',
    baseUrl: model.baseUrl.replace(/\/$/, ''),
    apiKey: '$EW_PI_API_KEY',
    models: [
      {
        id: model.modelCode,
        name: model.name || model.modelCode,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.maxContext || 32000,
        maxTokens: model.maxOutputTokens || 4096
      }
    ]
  })
  const providerHeaders = (headers: ProviderHeaders) => {
    if (!model.apiKey) {
      headers.Authorization = null
      headers.authorization = null
    }
  }
  pi.on('before_provider_headers', event => providerHeaders(event.headers))
  const provider = new URL(model.baseUrl).hostname === 'api.deepseek.com' ? 'deepseek' : model.provider
  const providerPayload = (source: unknown) => {
    const payload = { ...(source as Record<string, unknown>) }
    const thinking =
      model.thinking ??
      (['deepseek', 'aliyun', 'bigmodel', 'volcengine', 'siliconflow', 'local'].includes(provider)
        ? 'off'
        : 'default')
    const on = thinking === 'on'
    if (thinking !== 'default') {
      if (['deepseek', 'bigmodel', 'volcengine'].includes(provider))
        payload.thinking = { type: on ? 'enabled' : 'disabled' }
      if (['aliyun', 'siliconflow'].includes(provider)) payload.enable_thinking = on
    }
    const extra = model.extraParams ? JSON.parse(model.extraParams) : {}
    // 保留平台的供应商参数，但不允许覆盖 Pi 的消息、工具与流式契约。
    for (const [key, value] of Object.entries(extra))
      if (!['messages', 'tools', 'model', 'stream', 'tool_choice'].includes(key)) payload[key] = value
    // DeepSeek 的强制工具调用只支持非思考模式。按最终请求处理，避免额外参数重新开启思考。
    const choice = payload.tool_choice as { type?: string } | string | undefined
    const forcedTool = choice === 'required' || (typeof choice === 'object' && choice?.type === 'function')
    if (provider === 'deepseek' && forcedTool) {
      payload.thinking = { type: 'disabled' }
    }
    if (Array.isArray(payload.tools)) payload.tools = payload.tools.filter(tool => {
      const name = (tool as { function?: { name?: string } }).function?.name
      if (!['list_rankings', 'read_rankings', 'refresh_rankings'].includes(name || '')) return true
      // Local catalogue metadata is safe to discover; reading or refreshing a ranking still uses the author's scope.
      if (name === 'list_rankings') return true
      if (!rankingPolicy || rankingPolicy.intent === 'none') return false
      if (name === 'refresh_rankings' && refreshHandled) return false
      return rankingScopeReady(rankingPolicy) && (name !== 'refresh_rankings' || !rankingPolicy.cacheOnly)
    })
    return payload
  }
  pi.on('before_provider_request', event => providerPayload(event.payload))
  pi.on('session_start', (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries()
    rankings.restore(entries)
    const lastDecision = entries.filter(entry => entry.type === 'custom' && entry.customType === 'yichuang-author-decision').at(-1)
    authorInputId = String((lastDecision as {data?: {inputId?: string}} | undefined)?.data?.inputId || '')
    refreshHandled = !!authorInputId && entries.some(entry => entry.type === 'custom' && entry.customType === 'yichuang-ranking-refresh-receipt' && (entry.data as {inputId?: string})?.inputId === authorInputId)
    const binding = ctx.sessionManager
      .getEntries()
      .filter(entry => entry.type === 'custom' && entry.customType === 'yichuang-book')
      .at(-1)
    // 作品配置由宿主校验；Pi 原生记录保留每次绑定变化及完整对话历史。
    if (!binding || JSON.stringify((binding as { data: unknown }).data) !== JSON.stringify(book))
      pi.appendEntry('yichuang-book', book)
  })
  const readPlatformState = async (sessionId: string, detail: 'summary' | 'full' = 'summary', signal?: AbortSignal) => {
      // A stale local socket may reset after a long attachment import. Retry only this
      // read-only snapshot once; tool mutations and provider calls are never replayed here.
      const snapshot = () =>
        fetch(endpoint.replace(/\/tool$/, '/context'), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            connection: 'close'
          },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            sessionId, detail
          }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
        })
      let response: Awaited<ReturnType<typeof fetch>>
      try {
        response = await snapshot()
      } catch (cause) {
        const code = (cause as { cause?: { code?: string } })?.cause?.code
        if (!['ECONNRESET', 'UND_ERR_SOCKET'].includes(code || '')) throw cause
        response = await snapshot()
      }
      const data = (await response.json()) as { result?: unknown; error?: string }
      if (!response.ok || data.error || !data.result) throw new Error(data.error || '平台状态读取失败')
      return data.result
  }
  pi.on('context', async (event, ctx) => {
    try {
      let state = await readPlatformState(ctx.sessionManager.getSessionId()) as { runControl: { state: string; revision:number; pendingInput?: string | null; rankings?: PiRankingPolicy | null }; authorInput?: AuthorInput; bookPositioning?: unknown }
      const messages = withAuthorMessages(event.messages)
      if (state.runControl.pendingInput) {
        remainingTask = null
        const input = state.authorInput
        if (!input || input.id !== state.runControl.pendingInput) throw new Error('当前作者要求尚未完成判定，请重新提交要求')
        const decision = await decideAuthorInput(ctx, input, messages, {...state.runControl,bookPositioning:state.bookPositioning}, providerPayload, providerHeaders)
        ctx.signal?.throwIfAborted()
        const { status, data } = await post('/author-input', { requestId: crypto.randomUUID(), inputId: input.id, ...decision }, ctx.signal)
        if (status >= 400 || data.error) throw new Error(data.error || '执行决定未被平台接受')
        const answer = input.answer as {text?:string;selected?:string[];inputs?:Record<string,string>} | undefined
        const raw = [input.text, answer?.text, ...(answer?.selected || []), ...Object.values(answer?.inputs || {})].filter(Boolean).join('\n')
        pi.appendEntry('yichuang-author-decision', { inputId: input.id, authorText:raw, ...decision })
        authorInputId = input.id
        refreshHandled = false
        if (decision.action !== 'process') {
          if (decision.action === 'clarify') pi.sendMessage({ customType: 'yichuang-clarification', content: decision.question, display: true }, { triggerTurn: false })
          stop(ctx)
          return { messages }
        }
        state = await readPlatformState(ctx.sessionManager.getSessionId()) as typeof state
        rankingPolicy = state.runControl.rankings || null
        if (rankingPolicy?.refreshRequested && rankingPolicy.intent === 'specified' && !rankingPolicy.cacheOnly && rankingScopeReady(rankingPolicy)) {
          try {
            const result = await rankings.refresh({queries:rankingPolicy.scopes,sessionId:ctx.sessionManager.getSessionId(),standalone:true}, input.id + ':refresh', ctx.signal)
            ctx.signal?.throwIfAborted()
            refreshHandled = true
            pi.appendEntry('yichuang-ranking-refresh-receipt', {inputId:input.id})
            const handled = !result.details.blocked && !result.details.needsScope && !result.details.needsSelection
            if (handled) {
              const completed = await post('/ranking-complete', {requestId:crypto.randomUUID(),revision:state.runControl.revision}, ctx.signal)
              if (completed.status >= 400 || completed.data.error) throw new Error(completed.data.error || '平台未确认操作已处理')
              state.runControl = completed.data.result as typeof state.runControl
            }
            const completed = handled && !result.details.cancelled && decision.afterRefresh.length === 0
            pi.sendMessage({customType:'yichuang-ranking-result',content:refreshResultText(result.details),details:{platformCompleted:completed},display:true},{triggerTurn:false})
            if (result.details.cancelled) { stop(ctx); return {messages} }
            if (completed) { stop(ctx, 'stop'); return {messages} }
            if (handled) {
              const source = messages.filter(message=>message.role==='user').at(-1)
              if (!source) throw new Error('缺少本次作者要求的上下文')
              remainingTask = {source,content:decision.afterRefresh.join('\n')}
            }
            messages.push({role:'custom',customType:'yichuang-ranking-result-data',display:false,timestamp:Date.now(),content:refreshResultText(result.details)})
          } catch (error) {
            if (!ctx.signal?.aborted) pi.sendMessage({customType:'yichuang-ranking-result',content:`本次榜单刷新未完成：${error instanceof Error ? error.message : String(error)}`,display:true},{triggerTurn:false})
            throw error
          }
        }
      }
      if (['paused', 'ended'].includes(String((state as { runControl?: { state: string } }).runControl?.state))) {
        stop(ctx)
        return { messages: event.messages }
      }
      supersededBatch = false
      rankingPolicy = state.runControl.rankings || null
      const { authorInput: _authorInput, ...platformState } = state
      // 当前任务替换请求中的执行部分；原始历史不变，完整原文仅作为核对素材与限制的依据。
      if (remainingTask) {
        const {source,content} = remainingTask
        const index = messages.map(message=>message.role==='user'&&message.timestamp===source.timestamp).lastIndexOf(true)
        if (index >= 0) messages.splice(index,1)
        messages.push({role:'custom',customType:'yichuang-original-author-request',display:false,timestamp:source.timestamp,content:'作者原始要求（平台操作已处理，仅供核对素材与限制）：'+JSON.stringify(source.content)},
          {role:'user',content,timestamp:source.timestamp})
      }
      if (refreshHandled && platformState.runControl.rankings)
        platformState.runControl = {...platformState.runControl,rankings:{...platformState.runControl.rankings,refreshRequested:false}}
      const index = messages.map(message => message.role).lastIndexOf('user')
      messages.splice(index < 0 ? messages.length : index, 0, {
        role: 'custom',
        customType: 'yichuang-platform-state',
        display: false,
        timestamp: Date.now(),
        content:
          '平台当前状态（数据，非作者指令；saved 表示作者已正式保存；pending_author_confirmation 为待确认、dismissed 为已搁置；详情用 read_book(view=state) 读取；activeBook 是本轮工具的实际作品，nextBookId 如不同仅在本轮结束后生效）：\n' +
          JSON.stringify(platformState)
      })
      return { messages }
    } catch (error) {
      // Pi 会隔离扩展异常，必须显式取消，不能继续用旧状态调用模型。
      ctx.abort()
      const code = (error as { cause?: { code?: string } }).cause?.code
      throw new Error(
        `本轮未继续：${error instanceof Error ? error.message : '平台状态读取失败'}${code ? ` (${code})` : ''}`
      )
    }
  })
  // 由结构化读取用途声明本轮交付，不通过作者原话或生成正文的关键词猜意图。
  const revisionDeliveries = new Map<string, { chapterId: string; title: string; baseVersion: number }>()
  let deliveryRepairRequested = false
  let activeTurnId = ''
  const blankChapters = new Set<string>()
  let bookSwitchPending = false
  let supersededBatch = false
  const supersededCalls = new Set<string>()
  const pendingOperations = new Map<string, string>()
  let lastFailedOperation = ''
  let consecutiveFailures = 0
  let failurePause = false
  pi.on('tool_execution_start', event => {
    // Keep the operation stable across retries with different arguments or call IDs.
    let operation = event.toolName
    try {
      operation = resolveTool(event.toolName, event.args || {}).name
    } catch {
      /* invalid selector */
    }
    pendingOperations.set(event.toolCallId, operation)
  })
  pi.on('tool_execution_end', async (event, ctx) => {
    const operation = pendingOperations.get(event.toolCallId) || event.toolName
    pendingOperations.delete(event.toolCallId)
    if (failurePause || ctx.signal?.aborted || supersededCalls.has(event.toolCallId)) return
    if (!event.isError) {
      lastFailedOperation = ''
      consecutiveFailures = 0
      return
    }
    consecutiveFailures = operation === lastFailedOperation ? consecutiveFailures + 1 : 1
    lastFailedOperation = operation
    if (consecutiveFailures < 3) return
    failurePause = true
    stop(ctx)
    const reason = event.result?.content?.find((part: { type: string }) => part.type === 'text')?.text
    const message =
      '同一操作连续失败 3 次，本轮已暂停。已保存的结果可以查看。' +
      (reason ? '最近一次失败原因：' + String(reason).split('\nReceived arguments:')[0].slice(0, 240) : '')
    pi.sendMessage(
      { customType: 'yichuang-operation-paused', content: message, display: true },
      { triggerTurn: false }
    )
    await call(
      'control_session',
      { sessionId: ctx.sessionManager.getSessionId(), action: 'pause' },
      event.toolCallId + ':pause'
    )
  })
  pi.on('tool_call', event => {
    if (failurePause) return {block:true,reason:'本轮已暂停，等待作者决定是否继续。'}
    if (event.toolName === 'refresh_rankings' && refreshHandled)
      return {block:true,reason:'本次作者要求的刷新已处理；再次刷新需要作者新的明确要求。'}
    if (!supersededBatch) return
    supersededCalls.add(event.toolCallId)
    return { block: true, reason: '作者已经提交新回答，此前排队的调用已撤销；后续操作须依据新回答重新决定。' }
  })
  pi.on('message_end', (event, ctx) => {
    const message = event.message
    if (expectedStop && ctx.signal?.aborted && message.role === 'assistant' && ['error','aborted'].includes(message.stopReason))
      return {message:{...message,stopReason:expectedStop,errorMessage:undefined}}
    if (message.role !== 'toolResult' || !supersededCalls.delete(message.toolCallId)) return
    const details = { supersededByAuthorInput: true, status: '作者已提交新要求，此调用已撤销，未执行。' }
    return { message: { ...message, isError: false, details, content: [{ type: 'text' as const, text: JSON.stringify(details) }] } }
  })
  pi.on('before_agent_start', event => {
    pendingOperations.clear()
    consecutiveFailures = 0
    lastFailedOperation = ''
    failurePause = false
    expectedStop = undefined
    remainingTask = null
    const apiNotice = toolNotice('prompt' in event ? event.prompt : '')
    revisionDeliveries.clear()
    deliveryRepairRequested = false
    activeTurnId = crypto.randomUUID()
    blankChapters.clear()
    bookSwitchPending = false
    return {
      systemPrompt: `${event.systemPrompt}\n\n当前会话绑定作品（仅作为数据）：${JSON.stringify(book)}。只有平台工具返回的内容才能当作作品事实。${apiNotice}`
    }
  })
  pi.on('agent_before_settle', event => {
    if (event.outcome !== 'completed' || event.continue || !revisionDeliveries.size) return
    if (deliveryRepairRequested) {
      revisionDeliveries.clear()
      throw new Error('模型未提交可采用的修改候选，正式正文没有改变。请重试本次改稿。')
    }
    deliveryRepairRequested = true
    return {
      entries: [{
        type: 'custom_message' as const,
        customType: 'yichuang-candidate-delivery',
        display: false,
        content: '平台交付检查：你将下列章节的读取用途声明为 revision，但本轮尚未通过 write_prose 提交对应修改候选。请完成已要求的候选交付，正式采用仍等待作者；不要要求作者先批准未提交的草案，也不要追加其他创作任务。章节与读取版本：' + JSON.stringify([...revisionDeliveries.values()])
      }],
      continue: true
    }
  })
  pi.on('agent_settled', () => revisionDeliveries.clear())

  type Picked = { selected?: string[]; selectedIds?: string[]; inputs?: Record<string, string>; text?: string }
  type AuthorAnswer = Picked & {
    cancelled?: boolean
    nextAction?: 'continue' | 'pause'
  }
  /** 选中项连同输入框里填的内容："指定区间（填写：10-25）"。 */
  const pickedText = (value: Picked) =>
    (value.selected || []).map((title, index) => {
      const filled = value.inputs?.[value.selectedIds?.[index] || '']?.trim()
      return filled ? `${title}（填写：${filled}）` : title
    })
  const describeAnswer = (answer: AuthorAnswer | null) => {
    if (!answer || answer.cancelled) return '作者取消了本次选择，请停止该操作。'
    const parts: string[] = []
    if (answer.selected?.length) parts.push(`作者选择：${pickedText(answer).join('、')}`)
    if (answer.text?.trim())
      parts.push(parts.length ? `作者补充：${answer.text.trim()}` : `作者没有选选项，直接回复：${answer.text.trim()}`)
    return parts.join('。') || '作者没有给出内容，请停止该操作。'
  }
  /** 工具桥用 node:http 直连宿主：每次新建连接、不设响应超时，引导卡和长任务可以等作者或平台任意久。 */
  const post = (path: string, body: unknown, signal?: AbortSignal, timeoutMs?: number) =>
    new Promise<{ status: number; data: { error?: string; result?: unknown } }>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body))
      const req = httpRequest(
        endpoint.replace(/\/tool$/, path),
        {
          method: 'POST',
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': payload.length,
            connection: 'close'
          }
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8')
              resolve({ status: res.statusCode || 0, data: text ? JSON.parse(text) : {} })
            } catch (cause) {
              reject(cause)
            }
          })
        }
      )
      const abort = () => req.destroy(new DOMException('This operation was aborted', 'AbortError'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      req.on('error', reject)
      req.on('close', () => signal?.removeEventListener('abort', abort))
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('宿主未响应')))
      req.end(payload)
    })
  const call = async (tool: string, args: unknown, callId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    const cancel = () => {
      // 独立通知原生请求登记，不让 abort 后的断连成为唯一取消依据。
      void post('/cancel', { requestId }, undefined, 5000).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const scopedArgs = activeTurnId ? { ...(args as Record<string, unknown>), turnId: activeTurnId } : args
      const { status, data } = await post('/tool', { tool, args: scopedArgs, callId, requestId }, signal)
      if (status >= 400 || data.error) throw new Error((data.error || '平台工具调用失败') + toolNotice(data.error || ''))
      if (tool === 'ask_author' && (args as { kind?: string }).kind === 'choice') {
        supersededBatch = true
        revisionDeliveries.clear()
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data.result) }],
        details: data.result as Record<string, unknown>
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  async function confirmBookReview(
    params: Record<string, unknown>,
    id: string,
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<'write' | 'queued' | 'cancel'> {
    if (!book || !(params.chapterId || params.volumeId)) return 'write'
    const author=params.author as Array<{text:string}>|undefined
    const explicitMethod=author?.some(a=>a.text.startsWith('/skill:') || (typeof params.skillName==='string' && a.text.includes(params.skillName))) ?? false
    const target = { sessionId: params.sessionId, chapterId: params.chapterId, volumeId: params.volumeId,explicitMethod }
    // 作者已定：写第一章不弹"参考哪本书"的卡。范文来源只走作品写作设置、作者点名的文风技能或作品默认文风。
    const plan = (await call('write_prose', { ...target, memoryAction: 'preview' }, id + ':history', signal)).details
    if (Number(plan.count) <= 1 || !plan.rangeKey) return 'write'
    const key = JSON.stringify([book.id, plan.rangeKey])
    const skipped = ctx.sessionManager
      .getBranch()
      .some(
        entry =>
          entry.type === 'custom' && entry.customType === 'yichuang-memory-continue' && entry.data === key
      )
    if (skipped) return 'write'
    const answer = (
      await call(
        'ask_author',
        {
          sessionId: params.sessionId,
          kind: 'confirm',
          question: '要先整理前面的章节吗？',
          description: `共 ${plan.count} 章，约 ${plan.characters} 字，预计用量约 ${plan.estimatedTokens} tokens。已改动的旧记录已停用；现在也可以按正式原文继续写。`,
          options: [
            { id: 'continue', title: '先继续写' },
            { id: 'organize', title: '开始整理，先不写' }
          ],
          allowFreeText: false
        },
        id + ':history-confirm',
        signal
      )
    ).details as AuthorAnswer
    if (answer.cancelled || !answer.selectedIds?.length) return 'cancel'
    if (answer.selectedIds.includes('continue')) {
      pi.appendEntry('yichuang-memory-continue', key)
      return 'write'
    }
    if (!answer.selectedIds.includes('organize')) throw Error('未收到有效的选择')
    await call(
      'write_prose',
      { sessionId: params.sessionId, memoryAction: 'start', plan },
      id + ':organize',
      signal
    )
    return 'queued'
  }
  const rankings = rankingTools(call, (type, data) => pi.appendEntry(type, data))
  const creationSchema = Type.Unsafe<Record<string, unknown>>(creationInputSchema)
  const rankTypes = Type.Union([...new Set(['*', ...rankingVocabulary().flatMap(site=>site.audiences.flatMap(channel=>channel.ranks.flatMap(rank=>[rank.rankType,rank.name]).filter((value):value is string=>typeof value==='string')))])].map(value=>Type.Literal(value)))
  const rankingQueries = Type.Array(Type.Object({
    platform:Type.String({minLength:1,description:'目录中的平台代码'}),audience:Type.String({minLength:1,description:'目录中的频道代码'}),category:Type.String({minLength:1,description:'目录中的分类名；全分类总榜也可按作品分类筛选'}),rankType:rankTypes
  },{additionalProperties:false}),{minItems:1,maxItems:rankingQueryLimit})
  const tools = [
    { name: 'plan_chapters', label: '写章纲',
      description: '把一批章纲写进目录：每章标题、章纲（发生什么、冲突与结果、章末停在哪，80 到 200 字）、拍子和出场人物。平台先填该卷末尾没正文也没章纲的空白章，不够再追加；章纲默认采用，作者在目录里可改。只写事件，不写口吻文风。出场人物须在人物表里。一次 1 到 20 章；先用 read_book(view="chapters") 读目录定位分卷。',
      parameters: Type.Object({
        volumeId: Type.String({ minLength: 1 }),
        chapters: Type.Array(Type.Object({
          title: Type.String({ minLength: 1, maxLength: 80 }),
          summary: Type.String({ minLength: 1, maxLength: 400 }),
          beats: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 8 })),
          characters: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 }))
        }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })
      }, { additionalProperties: false }) },
    { name: 'search_chapters',label:'查本书早先原文',description:'按目标章节之前或目标卷末查本书的原文与出处。terms 用人物或物件名，chapterNos 为作者点名的早先章号。',
      parameters:Type.Object({chapterId:Type.Optional(Type.String()),volumeId:Type.Optional(Type.String()),terms:Type.Optional(Type.Array(Type.String(),{maxItems:8})),chapterNos:Type.Optional(Type.Array(Type.Integer({minimum:1}),{maxItems:8}))}) },
    { name: 'write_prose',label:'写正文候选',
      description:'写或改小说正文，平台根据简报独立生成一份候选。章节、卷、待采用候选、独立文本四个目标只选一个。目标章在目录里没有章纲时，在 plan 里写本章章纲（发生什么、冲突结果、章末停在哪），平台存进本章大纲；口吻和文风只能引用作者原话（quotes），不自行添加。仅改选段时带原文。远处线索用章号和人物或物件名指定。',
      parameters:proseBriefSchema },
    { name: 'control_session', label: '暂停或结束当前阶段',
      description: '作者明确要求暂停或结束当前工作时调用；pause 保留继续位置，end 结束本阶段。停止后不再调用模型确认，候选和已保存内容保留。故事中角色的动作不是控制指令。',
      parameters: Type.Object({ action: Type.Union([Type.Literal('pause'), Type.Literal('end')]) }, { additionalProperties: false })
    },
    {
      name: 'prepare_writing', label: '准备写作',
      description: '写新章或填空白章前，先处理作品采用、待保存资料、目标卷和前章版本。target=new_chapter/chapter/materials/batch；连写沿用现有末卷规则；已有章节带 chapterId，指定卷带 volumeId。每次只处理一项必要决定并返回阶段；ready=true 后读取所列前文与资料，再提交候选。候选保存本身不出确认卡。',
      parameters: Type.Object({
        target: Type.Optional(Type.Union([Type.Literal('new_chapter'), Type.Literal('chapter'), Type.Literal('materials'), Type.Literal('batch')])),
        chapterId: Type.Optional(Type.String()), volumeId: Type.Optional(Type.String())
      }, { additionalProperties: false })
    },
    {
      name: 'confirm_materials', label: '确认保存作品资料',
      description: '预览并确认采用本会话的资料候选，锁定确认时的版本；新书单独确认。draftIds 可指定清单，省略读取当前作品待采用资料。返回 adopted 才表示保存成功，取消后停止依赖这些资料的写作。',
      parameters: Type.Object({ draftIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100 })) }, { additionalProperties: false })
    },
    {
      name: 'search_writing_resources',
      label: '查找写作资源',
      description: '按当前问题、场景条件和约束检索少量适用资源摘要。根据适用条件选零至两条，再用读取操作获取原文；没有合适内容可不选。',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1000 }),
        context: Type.Optional(Type.String({ maxLength: 2000 })),
        constraints: Type.Optional(Type.String({ maxLength: 2000 })),
        kinds: Type.Optional(Type.Array(Type.Union([Type.Literal('technique'), Type.Literal('case'), Type.Literal('style'), Type.Literal('market')]))),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 }))
      }, { additionalProperties: false })
    },
    {
      name: 'read_writing_resource',
      label: '读取写作资源',
      description: '按 id 和 version 读取资源。用 nextParagraph/nextCharacterOffset 续读；includeExplanation=false 只取样本。版本或权限变化会拒绝。',
      parameters: Type.Object({
        id: Type.String(), version: Type.Integer({ minimum: 1 }), reason: Type.Optional(Type.String({ maxLength: 1000 })),
        paragraphFrom: Type.Optional(Type.Integer({ minimum: 1 })), paragraphCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
        characterOffset: Type.Optional(Type.Integer({ minimum: 0 })), includeExplanation: Type.Optional(Type.Boolean())
      }, { additionalProperties: false })
    },
    {
      name: 'read_memory', label: '读取长期记忆',
      description: '读取作者偏好和当前作品的记忆。query 可缩小范围；含编号与修订，有 omitted 时继续按问题查询。',
      parameters: Type.Object({query:Type.Optional(Type.String({description:'按记忆内容检索；留空读取。返回 omitted 时用更具体的 query 缩小范围。'}))})
    },
    {
      name: 'remember_memory', label: '记住偏好或事实',
      description: '作者要求记住或更正时提交平台确认。scope=author 表示跨作品偏好，book 表示本书事实；作者纠正某章时谁知道或不知道什么，带 afterChapterId 指明从哪章之后生效。更新先读取 id，新建省略 id。确认后才保存。',
      parameters: Type.Object({scope: Type.Union([Type.Literal('author'), Type.Literal('book')]), content: Type.String({maxLength:1200}), afterChapterId:Type.Optional(Type.String()), knowledge:Type.Optional(Type.Object({characterId:Type.String(),factId:Type.String(),known:Type.Boolean()},{description:"已核对作品中的人物和事实编号时可填写。无法核对编号就只保存作者原话和生效章节。"})), id: Type.Optional(Type.String())})
    },
    {
      name: 'forget_memory', label: '忘记一条记忆',
      description: '作者要求忘记时，先读取记忆编号，再提交删除确认；取消不改变记忆。',
      parameters: Type.Object({id: Type.String()})
    },
    {
      name: 'read_breakdown',
      label: '读取拆书资料',
      description:
        '读取附件目录、参考书原文或已有拆书结果。attachmentId 指本会话附件，projectId 指参考书。目录按 catalogOffset 翻页；章节可用 chapterId/chapterNo，原文用 includeSource 和段落偏移续读；taskId 读取范围报告。此工具不启动分析。',
      parameters: Type.Object({
        attachmentId: Type.Optional(Type.String()),
        projectId: Type.Optional(Type.String()),
        chapterId: Type.Optional(Type.String()),
        chapterNo: Type.Optional(Type.Integer({ minimum: 1 })),
        taskId: Type.Optional(Type.String()),
        includeSource: Type.Optional(Type.Boolean()),
        paragraphFrom: Type.Optional(Type.Integer({ minimum: 1 })),
        characterOffset: Type.Optional(Type.Integer({ minimum: 0 })),
        catalogOffset: Type.Optional(Type.Integer({ minimum: 0 }))
      })
    },
    {
      name: 'run_breakdown',
      label: '执行指定章节拆书',
      description:
        '执行作者要求的拆书范围。先读目录，目标填 attachmentId 或 projectId；全书 scope=all，区间 fromChapter/toChapter，离散章节 chapterIds。一次平台确认后启动；reanalyze 仅用于明确重拆。返回启动状态，结果另行读取。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String()),
        attachmentId: Type.Optional(Type.String()),
        chapterIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        scope: Type.Optional(Type.Literal('all')),
        fromChapter: Type.Optional(Type.Integer({ minimum: 1 })),
        toChapter: Type.Optional(Type.Integer({ minimum: 1 })),
        reanalyze: Type.Optional(Type.Boolean())
      })
    },
    {
      name: 'run_distillation',
      label: '蒸馏文风',
      description:
        '从参考书提炼写法为带样本与来源的 Skill。先读目录并指定范围，平台确认后启动。calibration 默认2章，少于10章不保留，0为不留；skillName 可指定。完成后读取实际 Skill，不能把启动当完成。',
      parameters: Type.Object({
        projectId: Type.Optional(Type.String()),
        attachmentId: Type.Optional(Type.String()),
        chapterIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        scope: Type.Optional(Type.Literal('all')),
        fromChapter: Type.Optional(Type.Integer({ minimum: 1 })),
        toChapter: Type.Optional(Type.Integer({ minimum: 1 })),
        skillName: Type.Optional(Type.String()),
        calibration: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 }))
      })
    },
    {
      name: 'read_style_examples',
      label: '取文风样本',
      description:
        '读取文风 Skill 的平台样本库。query 只查摘要；按 sampleId 与 version 读取选中样本。includeGuidance=false 只取原文；scene/kinds 按场景取样。提交前的样本校验保留，批量任务每章重新取样。普通流程 Skill 读取自己的参考文件。',
      parameters: Type.Object({
        skill: Type.String({ description: '文风技能的名字' }),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        sampleId: Type.Optional(Type.String({ minLength: 1 })),
        version: Type.Optional(Type.String({ description: '查询返回的样本库版本；指定 sampleId 时必须提供' })),
        includeGuidance: Type.Optional(Type.Boolean()),
        scene: Type.Optional(Type.String({ description: '这一章的场景类型；不填就轮着给' })),
        kinds: Type.Optional(Type.Array(Type.String(), { description: '旧版技能用：功能类型' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 }))
      })
    },
    {
      name: 'run_batch',
      label: '预览连写计划',
      description:
        '把每章 goal（最多20章）提交给作者看计划。这个工具先展示目标、消耗和确认按钮，等作者点击才启动；作者要求先看或确认计划时直接调用本工具。先读目录定位分卷，每章一次候选，采用后推进。',
      parameters: Type.Object({
        steps: Type.Array(Type.Object({ goal: Type.String({ minLength: 1, maxLength: 200 }) }), { minItems: 1, maxItems: 20 }),
        scope: Type.Optional(Type.String({ description: '范围的说法，如"接下来 3 章"' }))
      })
    },
    {
      name: 'make_cover',
      label: '生成封面',
      description:
        '生成当前作品封面。先读作品信息；summary 为简报，prompt 描述画面而不含书名文字。平台展示模型、尺寸与简报，确认后启动；成图预览采用后才写入作品。',
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 120 }),
        prompt: Type.String({ minLength: 1, maxLength: 2000 }),
        negativePrompt: Type.Optional(Type.String({ maxLength: 500 })),
        style: Type.Optional(Type.String({ maxLength: 60 })),
        size: Type.Optional(Type.String({ description: '宽x高，如 768x1024；不填用默认' }))
      })
    },
    {
      name: 'reparse_book_attachment',
      label: '重新识别附件目录',
      description:
        '作者明确要求修正分章时，对本会话原始附件重新识别目录。headingStyle 为 auto/numbered/markdown；不启动拆书或改写已有分析。',
      parameters: Type.Object({
        attachmentId: Type.String(),
        headingStyle: Type.Union([Type.Literal('auto'), Type.Literal('numbered'), Type.Literal('markdown')])
      })
    },
    {
      name: 'control_task',
      label: '控制任务',
      description:
        '按 taskId 暂停、继续或取消拆书、蒸馏、批量写作、封面任务。继续沿用原范围与模型；按返回 statusText 说明状态。',
      parameters: Type.Object({
        taskId: Type.String(),
        action: Type.Union([Type.Literal('pause'), Type.Literal('resume'), Type.Literal('cancel')])
      })
    },
    {
      name: 'list_rankings', label: '查看榜单目录',
      description: '只查看可用平台、频道、分类、榜种及缓存日期，不读取榜单内容、不刷新。可传已知条件缩小目录。返回 query 是平台解析的查询条件；内部编号不作为调用参数。',
      parameters: Type.Object({platform:Type.Optional(Type.String()),audience:Type.Optional(Type.String()),category:Type.Optional(Type.String()),rankType:Type.Optional(rankTypes)},{additionalProperties:false})
    },
    {
      name: 'read_rankings', label: '读取榜单内容',
      description: '省略queries即读取作者已确定的范围；只在缩小范围或选择具体来源时传queries。查询条件使用目录中的平台代码、频道、分类名和榜种；*仅表示作者允许不限定的维度。mode=single读取一个匹配榜，多个匹配返回候选，不自动挑选；mode=overview读取本次范围内每榜前五本。总榜支持按作品分类筛选；范围未确定返回缺口。保留完整本地简介、原名次和日期；缺少当天数据先确认范围与耗时，cacheOnly不刷新。',
      parameters: Type.Object({
        queries: Type.Optional(rankingQueries),
        mode: Type.Optional(Type.Union([Type.Literal('single'),Type.Literal('overview')], { default: 'single' })),
        date: Type.Optional(Type.String()), compareDate: Type.Optional(Type.String()), cacheOnly: Type.Optional(Type.Boolean()),
        keyword: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({minimum:1,maximum:20})), offset: Type.Optional(Type.Integer({minimum:0})),
        itemIds: Type.Optional(Type.Array(Type.String(),{minItems:1,maxItems:3})),excludeKeys:Type.Optional(Type.Array(Type.String(),{maxItems:100})),
        countTerms:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:40}),{minItems:1,maxItems:10}))
      },{additionalProperties:false})
    },
    {
      name: 'refresh_rankings', label: '刷新指定范围的榜单',
      description: '按查询条件匹配真实榜单，平台确认实际范围和总耗时后仅更新缺少当天数据的来源。只读本地要求不能被覆盖；沿用抓取开关、频控和取消，不更改自动抓取设置。',
      parameters: Type.Object({queries:rankingQueries},{additionalProperties:false})
    },
    {
      name: 'save_creation_draft',
      label: '保存创作候选',
      description:
        '提交作品、卷、大纲、人物、设定等资料候选。修改先 read_references，带真实 targetId，只提交变更字段；改分卷的名称或卷纲时 targetId 取目录里的卷编号；关联对象须已存在。大纲目录 nodeType=0，正文节点=1。新书采用后带默认第一卷及空白首章。',
      parameters: creationSchema
    },
    {
      name: 'list_books',
      label: '作品列表',
      description: '列出书库作品名称；正文和资料操作限于当前绑定作品。',
      parameters: Type.Object({})
    },
    {
      name: 'read_platform_state', label: '读取当前会话详情',
      description: '按需读取本会话的完整候选状态、任务、附件和记忆。已搁置候选不是待确认。',
      parameters: Type.Object({}, { additionalProperties: false })
    },
    {
      name: 'read_book',
      label: '作品信息',
      description: '读取当前绑定作品的信息，以实际 activeBook 为准。',
      parameters: Type.Object({})
    },
    {
      name: 'list_chapters',
      label: '章节目录',
      description: '读取当前作品的卷、章节与编号。长书默认展示最近的目录，需要早期章节时按从 1 开始的章号传 fromChapter。',
      parameters: Type.Object({fromChapter:Type.Optional(Type.Integer({minimum:1}))})
    },
    {
      name: 'read_chapter',
      label: '读取章节',
      description: '读取当前正式正文及版本。purpose=revision 为改稿，本轮须提交候选；review 为只审稿；context 为前情；example 为作者只要聊天示例。版本用于后续保存校验。',
      parameters: Type.Object({
        chapterId: Type.String({ description: '目录返回的章节编号' }),
        purpose: Type.Union([Type.Literal('revision'), Type.Literal('review'), Type.Literal('context'), Type.Literal('example')], { description: '本次读取用途；待作者批准的改稿仍选 revision，正式采用不由模型执行。' })
      })
    },
    {
      name: 'read_references',
      label: '读取作品资料',
      description: '读取当前作品资料与故事整理。story.state 为汇总，recent 为近期记录，pending 为待整理章节；疑点须回读正文。',
      parameters: Type.Object({})
    },
    {
      name: 'save_draft',
      label: '提交章节修改候选',
      description:
        '提交已有章节的修改候选。先 read_chapter 取得 chapterId/baseVersion；修改未采用候选用 draftId，不另建一份。这里只提交预览，不覆盖正式正文。',
      parameters: Type.Object({
        chapterId: Type.Optional(Type.String()),
        baseVersion: Type.Optional(Type.Integer({ minimum: 0 })),
        draftId: Type.Optional(Type.String({ description: '要替换的、还没采用的章节候选编号；填了就不需要 chapterId 和 baseVersion' })),
        title: Type.String(),
        content: Type.String({ minLength: 1, maxLength: 150000 })
      })
    },
    {
      name: 'save_new_chapter_draft',
      label: '提交新章节候选',
      description:
        '先 prepare_writing 完成准备，再提交新章候选，采用后追加到已有卷末；空白首章优先填入。volumeId 为已有卷，draftId 用于改未采用候选。提交前读取目标卷最近两章及 read_references，并处理未定的前章候选。',
      parameters: Type.Object({
        volumeId: Type.Optional(
          Type.String({ description: '作者明确指定的已有卷编号；多卷且未明确时先用 prepare_writing 选择' })
        ),
        draftId: Type.Optional(Type.String({ description: '要替换的、还没采用的新章候选编号；填了就是改这份候选，不另开一份' })),
        title: Type.String({ minLength: 1 }),
        content: Type.String({ minLength: 1, maxLength: 150000 })
      })
    },
    {
      name: 'save_outline_draft',
      label: '保存大纲修改建议',
      description:
        '提交现有正文大纲节点的纯文本修改候选。先读资料取得 outlineId；目录节点不能写正文，新建节点使用 save_creation_draft。',
      parameters: Type.Object({
        outlineId: Type.String(),
        title: Type.String(),
        content: Type.String({ minLength: 1, maxLength: 150000 })
      })
    },
    {
      name: 'save_skill_draft',
      label: '提交技能候选',
      description:
        '作者要求创建或修改 Skill 时提交候选。replaceId 指已有作者技能，先读原文件；files 限 references/、assets/、scripts/，脚本为 JavaScript。采用后才安装。',
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 60 }),
        description: Type.String({ minLength: 1, maxLength: 300, description: '一句话：做什么、什么时候用、什么时候不用' }),
        instructions: Type.String({ minLength: 1, maxLength: 200000 }),
        files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { maxItems: 20 })),
        replaceId: Type.Optional(Type.String({ description: '要替换的作者技能编号或名字；新建不填' }))
      })
    },
    {
      name: 'list_drafts',
      label: '已有草稿',
      description: '读取当前作品候选及其归属、版本、已采用或已搁置状态。',
      parameters: Type.Object({})
    },
    {
      name: 'run_skill_script',
      label: '运行技能脚本',
      description:
        '执行已加载 Skill 的 scripts 目录内 JavaScript。提供技能名、脚本、参数与用途；平台确认后运行，拒绝或取消后停止。',
      parameters: Type.Object({
        skill: Type.String(),
        script: Type.String(),
        args: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        reason: Type.Optional(Type.String())
      })
    }
  ]
  // 写操作和带确认卡的操作顺序执行：Pi 默认把同一轮的多个工具调用并行跑，新书候选还没落盘、人物候选就去核对作品，会全部失败
  const SEQUENTIAL = new Set([
    'control_session', 'prepare_writing', 'read_rankings', 'write_prose',
    'save_creation_draft', 'save_draft', 'save_new_chapter_draft', 'save_outline_draft', 'save_skill_draft',
    'run_breakdown', 'run_distillation', 'run_batch', 'make_cover', 'control_task', 'reparse_book_attachment',
    'remember_memory', 'forget_memory', 'run_skill_script', 'refresh_rankings', 'confirm_materials'
  ])
  for (const published of publicTools(tools))
    pi.registerTool({
      ...published,
      ...(SEQUENTIAL.has(published.name) ? { executionMode: 'sequential' as const } : {}),
      parameters: Type.Unsafe<Record<string, unknown>>(published.parameters as Record<string, unknown>),
      async execute(id, input, signal, _onUpdate, ctx) {
        const tool = groupedArguments(published.name, id, input, tools)
        const args = RAW_TEXT_TOOLS.has(tool.name) ? tool.args : decodeModelEscapes(tool.args)
        if (tool.name === 'read_platform_state') {
          const state = await readPlatformState(ctx.sessionManager.getSessionId(), 'full', signal)
          return { content: [{ type: 'text', text: JSON.stringify(state) }], details: state as Record<string, unknown> }
        }
        const params: Record<string, unknown> = { ...args, sessionId: ctx.sessionManager.getSessionId() }
        delete params.turnId
        if (activeTurnId) params.turnId = activeTurnId
        if (tool.name === 'control_session') {
          const result = await call(tool.name, params, id, signal)
          revisionDeliveries.clear()
          stop(ctx)
          return result
        }
        if (tool.name === 'prepare_writing') {
          const result = await prepareWriting(params, id, signal)
          if ('cancelled' in result.details && result.details.cancelled) revisionDeliveries.clear()
          return result
        }
        if (bookSwitchPending && ['write_prose','plan_chapters','save_creation_draft', 'save_draft', 'save_new_chapter_draft', 'save_outline_draft', 'run_batch'].includes(tool.name)) {
          revisionDeliveries.clear()
          return { content: [{ type: 'text' as const, text: '新作品已保存，正在等待本轮结束后同步绑定。本次写入未执行，请结束本轮，不要写进原作品。' }], details: { waitingForBookSwitch: true, draftSubmitted: false } }
        }
        if (tool.name === 'save_creation_draft') {
          const normalized = normalizeCreationInput(args)
          for (const key of Object.keys(params)) if (!['sessionId', 'turnId'].includes(key)) delete params[key]
          Object.assign(params, normalized)
        }
        if (tool.name === 'confirm_materials') {
          const result = await settleMaterials(params, id, signal)
          if ('cancelled' in result.details && result.details.cancelled) revisionDeliveries.clear()
          return result
        }
        if (tool.name === 'run_batch' || (tool.name === 'save_draft' && !params.draftId && blankChapters.has(String(params.chapterId)))) {
          const ready = await call('confirm_materials', { sessionId: params.sessionId, inspect: true }, id + ':materials', signal)
          if (!ready.details.ready) return needsPreparation('materials', '作品资料尚未采用，请先准备写作；本次未启动任务或提交正文。', { target: tool.name === 'run_batch' ? 'batch' : 'chapter', chapterId: params.chapterId })
        }
        if (tool.name === 'read_chapter') {
          const result = await call(tool.name, params, id, signal)
          if (String(result.details.content || '').trim()) blankChapters.delete(String(params.chapterId))
          else blankChapters.add(String(params.chapterId))
          if (params.purpose === 'revision') {
            revisionDeliveries.set(String(params.chapterId), {
              chapterId: String(params.chapterId), title: String(result.details.title || ''),
              baseVersion: Number(result.details.version)
            })
          }
          return result
        }
        if (['write_prose','save_draft','save_new_chapter_draft'].includes(tool.name)) {
          const branch=ctx.sessionManager.getBranch()
          const inputs=branch.flatMap(entry=>{
            if(entry.type==='custom' && entry.customType==='yichuang-author-decision'){
              const d=entry.data as {inputId:string;authorText?:string}
              return d.authorText?[{id:d.inputId,text:d.authorText}]:[]
            }
            if(entry.type==='message' && entry.message.role==='user'){
              const m=entry.message
              const raw=typeof m.content==='string'?m.content:m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n')
              return [{id:entry.id,text:raw}]
            }
            return []
          })
          if(tool.name==='write_prose'){
            const latest=inputs.at(-1)
            if(!latest)throw Error('缺少本次作者要求')
            const quotes=(Array.isArray(params.quotes)?params.quotes:[]).map(q=>{
              const match=[...inputs].reverse().find(entry=>typeof q==='string' && q.length && entry.text.includes(q))
              if(!match)throw Error('历史要求找不到对应的作者原话')
              return {id:match.id,text:String(q)}
            })
            params.author=[...quotes,latest]
            params.mode=proseMode(params)
            const review = await confirmBookReview(params, id, ctx, signal)
            if (review !== 'write') {
              revisionDeliveries.clear()
              if (review === 'queued') {
                pi.sendMessage(
                  {
                    customType: 'yichuang-history-receipt',
                    content: '已开始整理。你可以在故事状态里查看进度或暂停。',
                    display: true
                  },
                  { triggerTurn: false }
                )
              }
              stop(ctx, review === 'queued' ? 'stop' : 'aborted')
              return {
                content: [{ type: 'text' as const, text: review === 'queued' ? '已开始整理' : '已取消' }],
                details: { queued: review === 'queued', cancelled: review === 'cancel' }
              }
            }
            if((params.chapterId || params.draftId) && params.selection){
              const range=(await call(params.draftId?'list_drafts':'read_chapter',{sessionId:params.sessionId,chapterId:params.chapterId,draftId:params.draftId,locateSelection:params.selection},id+':range',signal)).details
              const positions=range.positions as Array<{occurrence:number;context:string}>
              if(!positions.length)throw Error('指定原文与章节不符，请重新核对')
              params.selectionVersion=range.version
              if(positions.length>1){
                const question=await call('ask_author',{sessionId:params.sessionId,kind:'confirm',question:'原章里有多处相同文字，要改哪一处？',
                  options:positions.map(p=>({id:String(p.occurrence),title:`第 ${p.occurrence} 处`,description:p.context})),allowFreeText:false},id+':choose-range',signal)
                const answer=question.details as AuthorAnswer
                const choice=positions.find(p=>answer.selectedIds?.includes(String(p.occurrence)))
                if(answer.cancelled||!choice){revisionDeliveries.clear();return {content:[{type:'text' as const,text:'已取消选段改写'}],details:{cancelled:true}}}
                params.occurrence=choice.occurrence
              }
            }
            revisionDeliveries.delete(String(params.chapterId))
            return call(tool.name,params,id,signal)
          }
          if(!inputs.some(entry=>typeof params.content==='string' && entry.text.includes(params.content))) {
            throw Error('生成或改写章节请调用 write_prose，只提交目标和要求。save_draft 的正文仅可原样保存作者提供的定稿。')
          }
          params.authorVerbatim = true
        }
        if (tool.name === 'save_draft') {
          // 已尝试提交的冲突/失败由本轮正常工具错误处理；交付检查不自动重放写操作。
          revisionDeliveries.delete(String(params.chapterId))
          return call(tool.name, params, id, signal)
        }
        if (tool.name === 'remember_memory' || tool.name === 'forget_memory') {
          const prepared = (await call(tool.name, { ...params, prepare: true }, `${id}:preview`, signal)).details as Record<string, unknown>
          const deleting = tool.name === 'forget_memory'
          const asked = await call('ask_author', {
            sessionId: params.sessionId, kind: 'confirm',
            question: deleting ? '忘记这条记忆？' : '记住这条内容？',
            description: `${prepared.scope === 'author' ? '作者偏好（所有作品）' : '当前作品事实'}${prepared.afterChapterTitle ? ' · 从《'+prepared.afterChapterTitle+'》之后生效':''}\n${prepared.content}`,
            options: [{id:'yes',title:deleting ? '忘记' : '记住'}, {id:'no',title:'取消'}], allowFreeText:false
          }, `${id}:confirm`, signal)
          const answer = asked.details as AuthorAnswer
          if (answer.cancelled || !answer.selectedIds?.includes('yes'))
            return {content:[{type:'text' as const,text:'作者没有确认，记忆未改变。'}],details:{cancelled:true}}
          return call(tool.name, { ...prepared, sessionId:params.sessionId }, id, signal)
        }
        if (tool.name === 'run_breakdown') {
          if (!params.projectId && !params.attachmentId) throw new Error('请提供 attachmentId 或 projectId')
          // 范围确认是一张引导卡：目标、已有结果数、估算和模型都展示给作者，沿用还是重拆由作者选。
          // 目标是附件时，这次读取会等附件入库完成，再按真实目录准备方案。
          const preview = async (reanalyze: boolean) =>
            (
              await call(
                'read_breakdown',
                {
                  sessionId: params.sessionId,
                  attachmentId: params.attachmentId,
                  projectId: params.projectId,
                  chapterIds: params.chapterIds,
                  scope: params.scope,
                  fromChapter: params.fromChapter,
                  toChapter: params.toChapter,
                  prepare: true,
                  reanalyze
                },
                `${id}:preview${reanalyze ? ':reanalyze' : ''}`,
                signal
              )
            ).details as {
              projectId: number
              title: string
              scope: string
              chapters: Array<{ id: number; title: string; reusable: boolean }>
              estimatedTokens: number
              estimatedMinutes: number[]
            }
          let plan = await preview(params.reanalyze === true)
          params.projectId = String(plan.projectId)
          const reusable = plan.chapters.filter(c => c.reusable).length
          const fresh = plan.chapters.length - reusable
          const question = await call(
            'ask_author',
            {
              sessionId: params.sessionId,
              kind: 'confirm',
              question: '确认拆书范围',
              description: '产出逐章分析和所选范围总结；可以暂停继续，关闭应用后不自动续跑。',
              card: {
                type: 'breakdown-plan',
                plan: {
                  title: plan.title,
                  scope: plan.scope,
                  chapterCount: plan.chapters.length,
                  reusable,
                  chapters: plan.chapters.slice(0, 12).map(c => c.title),
                  estimatedTokens: plan.estimatedTokens,
                  estimatedMinutes: plan.estimatedMinutes,
                  model: model.name || model.modelCode
                }
              },
              options: reusable
                ? [
                    {
                      id: 'reuse',
                      title: '沿用已有结果并开始',
                      description: `${reusable} 章直接用已保存的分析，${fresh ? `其余 ${fresh} 章重新分析` : '不再重新分析'}`
                    },
                    {
                      id: 'reanalyze',
                      title: '全部重拆后开始',
                      description: `${plan.chapters.length} 章全部重新分析，用量和时间按全量算`
                    }
                  ]
                : [{ id: 'start', title: '开始拆书', description: `${plan.chapters.length} 章全部分析` }],
              allowFreeText: false
            },
            `${id}:confirm`,
            signal
          )
          signal?.throwIfAborted()
          const answer = question.details as { selectedIds?: string[]; cancelled?: boolean } | null
          if (!answer || answer.cancelled || !answer.selectedIds?.length)
            return {
              content: [{ type: 'text' as const, text: '作者取消，未启动拆书任务。请停止此操作。' }],
              details: { cancelled: true }
            }
          if (answer.selectedIds[0] === 'reanalyze') {
            plan = await preview(true)
            params.reanalyze = true
          }
          params.chapterIds = plan.chapters.map(c => String(c.id))
          params.confirmedTarget = plan
          params.modelCode = String(model.id)
        }
        if (tool.name === 'run_distillation') {
          if (!params.projectId && !params.attachmentId) throw new Error('请提供 attachmentId 或 projectId')
          const plan = (
            await call('run_distillation', { ...params, prepare: true }, `${id}:preview`, signal)
          ).details as {
            projectId: number
            title: string
            scope: string
            skillName: string
            chapters: Array<{ id: number; title: string }>
            calibrationChapters?: Array<{ id: number; title: string; sortNo: number }>
            estimatedRequests: number
            estimatedTokens: number
            estimatedMinutes: number[]
          }
          const calibration = plan.calibrationChapters || []
          const question = await call(
            'ask_author',
            {
              sessionId: params.sessionId,
              kind: 'confirm',
              question: '确认蒸馏范围',
              description:
                `预计约 ${plan.estimatedRequests} 次模型请求，生成可跨书使用的文风技能。格式无效时每步最多重试一次，重试也计用量。可以暂停继续。` +
                (calibration.length
                  ? `第 ${calibration.map(c => c.sortNo).join('、')} 章留作校准集，不进蒸馏，只用来核对卡；不想留就说。`
                  : '范围不到 10 章，不留校准集。') +
                (plan.chapters.length < 50 ? '不到 50 章排法只能看出开篇写法。' : ''),
              card: {
                type: 'breakdown-plan',
                plan: {
                  title: plan.title,
                  scope: plan.scope,
                  chapterCount: plan.chapters.length,
                  reusable: 0,
                  chapters: plan.chapters.slice(0, 12).map(c => c.title),
                  estimatedTokens: plan.estimatedTokens,
                  estimatedMinutes: plan.estimatedMinutes,
                  model: model.name || model.modelCode
                }
              },
              options: [
                {
                  id: 'start',
                  title: '开始蒸馏',
                  description: params.skillName
                    ? `${plan.chapters.length} 章，生成技能「${plan.skillName}」`
                    : `${plan.chapters.length} 章，技能名按书名和文风定`
                },
                { id: 'start_continue', title: '蒸馏并继续对话', description: '完成时再调用聊天模型，接着处理本次要求。' }
              ],
              allowFreeText: false
            },
            `${id}:confirm`,
            signal
          )
          signal?.throwIfAborted()
          const answer = question.details as { selectedIds?: string[]; cancelled?: boolean } | null
          if (!answer || answer.cancelled || !['start', 'start_continue'].includes(answer.selectedIds?.[0] || ''))
            return {
              content: [{ type: 'text' as const, text: '作者取消，未启动蒸馏任务。请停止此操作。' }],
              details: { cancelled: true }
            }
          params.autoContinue = answer.selectedIds?.[0] === 'start_continue'
          params.projectId = String(plan.projectId)
          params.confirmedTarget = plan
          params.modelCode = String(model.id)
        }
        if (tool.name === 'run_batch') {
          const goals = (Array.isArray(params.steps) ? (params.steps as Array<{ goal: string }>) : []).map(s => String(s.goal || '').trim()).filter(Boolean)
          if (!goals.length) throw new Error('请先给每一章写一行目标')
          const scope = String(params.scope || `接下来 ${goals.length} 章`)
          const tree = (await call('list_chapters', { sessionId: params.sessionId }, id + ':volumes', signal)).details as unknown as Array<{ id: number }>
          if (!tree.length) throw new Error('当前作品没有分卷')
          const volumeId = String(tree[tree.length - 1].id)
          const readiness = await call('save_new_chapter_draft', { sessionId: params.sessionId, volumeId, check: true }, id + ':continuity', signal)
          if (!readiness.details.ready) return needsPreparation('continuity', '连写起点尚未确定，请先完成写作准备。', { target: 'batch', volumeId })
          // 一张卡看全部目标：按这些写，或者写要改什么退回模型改好再确认。不逐章问：一章只有一个建议，没有可选的。
          const confirmed = await call(
            'ask_author',
            {
              sessionId: params.sessionId,
              kind: 'confirm',
              question: '确认批量写作',
              description: `预计 ${goals.length} 次独立正文请求，每章另有聊天调度请求。正文最多输出约 ${goals.length*(model.maxOutputTokens||4096)} tokens；每章等你采用后再写下一章。`,
              card: { type: 'batch-plan', title: String(book?.title || ''), scope, goals, model: model.name || model.modelCode },
              options: [
                { id: 'start', title: '按这些目标开始写', description: `${goals.length} 章，每章写完等你采用` },
                {
                  id: 'adjust',
                  title: '改一下再写',
                  description: '写下要改的章和想法，我改好目标再来确认',
                  input: { label: '要改什么', placeholder: '如：第 2 章改成…；第 3 章不写' }
                }
              ],
              allowFreeText: false
            },
            `${id}:confirm`,
            signal
          )
          signal?.throwIfAborted()
          const answer = confirmed.details as { selectedIds?: string[]; inputs?: Record<string, string>; text?: string; cancelled?: boolean } | null
          if (!answer || answer.cancelled || !answer.selectedIds?.length)
            return { content: [{ type: 'text' as const, text: '作者取消，未启动批量写作。请停止此操作。' }], details: { cancelled: true } }
          if (answer.selectedIds[0] === 'adjust') {
            const wish = String(answer.inputs?.adjust || answer.text || '').trim()
            return {
              content: [
                {
                  type: 'text' as const,
                  text: wish
                    ? `作者要调整目标：${wish}。请按作者的想法改好各章目标，再调用 run_batch 让作者确认；现在不要开始写。`
                    : '作者想改目标但没写具体内容。请在对话里问清要改哪几章、怎么改，再调用 run_batch 让作者确认。'
                }
              ],
              details: { adjust: wish }
            }
          }
          params.confirmedTarget = { steps: goals.map(goal => ({ goal })), scope }
          params.modelCode = String(model.id)
        }
        if (tool.name === 'make_cover') {
          const ready = (await call('make_cover', { prepare: true, sessionId: params.sessionId }, `${id}:preview`, signal)).details as {
            modelCode: string
            modelName: string
            size: string
            bookTitle: string
          }
          const brief = {
            summary: String(params.summary || ''),
            prompt: String(params.prompt || ''),
            negativePrompt: String(params.negativePrompt || ''),
            style: String(params.style || ''),
            size: String(params.size || ready.size)
          }
          const question = await call(
            'ask_author',
            {
              sessionId: params.sessionId,
              kind: 'confirm',
              question: '确认生成封面',
              description: '按这份简报生成一张封面图；生成后在右侧预览，点采用才会写进作品。',
              card: { type: 'cover-brief', summary: brief.summary, prompt: brief.prompt, style: brief.style, size: brief.size, model: ready.modelName },
              options: [{ id: 'start', title: '生成', description: `用 ${ready.modelName} 生成一张` }],
              allowFreeText: false
            },
            `${id}:confirm`,
            signal
          )
          signal?.throwIfAborted()
          const answer = question.details as { selectedIds?: string[]; cancelled?: boolean } | null
          if (!answer || answer.cancelled || !answer.selectedIds?.length)
            return { content: [{ type: 'text' as const, text: '作者取消，未生成封面。请停止此操作。' }], details: { cancelled: true } }
          params.confirmedTarget = brief
        }
        if (tool.name === 'run_skill_script') {
          // 每次运行脚本都先给作者一张确认卡：哪个技能、哪个脚本、什么参数、为什么。
          const question = await call(
            'ask_author',
            {
              sessionId: params.sessionId,
              kind: 'confirm',
              question: '允许运行技能脚本吗？',
              description: '脚本在技能目录内由易创执行，输出交给 Agent，不会打开终端。',
              card: {
                type: 'skill-script',
                skill: String(params.skill || ''),
                script: String(params.script || ''),
                args: Array.isArray(params.args) ? params.args.map(String) : [],
                reason: String(params.reason || '')
              },
              options: [
                { id: 'run', title: '运行', description: '这一次运行，之后再运行还会再问' },
                { id: 'skip', title: '不运行', description: 'Agent 不运行脚本，改用别的办法或告诉你原因' }
              ],
              allowFreeText: false
            },
            `${id}:confirm`,
            signal
          )
          signal?.throwIfAborted()
          const answer = question.details as { selectedIds?: string[]; cancelled?: boolean } | null
          if (!answer || answer.cancelled || answer.selectedIds?.[0] !== 'run')
            return {
              content: [{ type: 'text' as const, text: '作者没有允许运行这个脚本，请不要再次请求，改用其他办法或说明情况。' }],
              details: { cancelled: true }
            }
        }
        if (tool.name === 'read_rankings' || tool.name === 'refresh_rankings') {
          const result = await rankings[tool.name === 'read_rankings' ? 'read' : 'refresh'](params, id, signal)
          if (tool.name === 'refresh_rankings' && authorInputId) {
            refreshHandled = true
            pi.appendEntry('yichuang-ranking-refresh-receipt', {inputId:authorInputId})
          }
          if (result.details.cancelled) stop(ctx)
          return result
        }
        if ((tool.name === 'save_new_chapter_draft' && !params.draftId) || (tool.name === 'save_creation_draft' && params.entity !== 'book')) {
          const current = await call('read_book', { sessionId: params.sessionId, prepare: true }, id + ':book', signal)
          if (!current.details.ready) return needsPreparation('book', '作品尚未准备好，请先选择作品或调用 prepare_writing；本次未提交候选。')
        }
        if (tool.name === 'save_new_chapter_draft' && !params.draftId) {
          const materials = await call('confirm_materials', { sessionId: params.sessionId, inspect: true }, id + ':materials', signal)
          if (!materials.details.ready) return needsPreparation('materials', '资料尚未采用，请先准备写作；本次未提交候选。')
          if (!params.volumeId) {
            const tree = (await call('list_chapters', { sessionId: params.sessionId }, id + ':volumes', signal)).details as unknown as Array<{ id: number }>
            if (tree.length !== 1) return needsPreparation('volume', '目标分卷尚未明确，请先准备写作并选择分卷。')
            params.volumeId = String(tree[0].id)
          }
          const continuity = await call('save_new_chapter_draft', { sessionId: params.sessionId, volumeId: params.volumeId, check: true }, id + ':continuity', signal)
          if (!continuity.details.ready) return needsPreparation('continuity', '前章版本尚未确定，请先准备写作；本次未提交候选。')
        }
        if (tool.name === 'plan_chapters') {
          // 章纲默认采用、不出卡，所以平台自己把写进目录的章纲贴到对话里，作者不用去目录找。
          const result = await call(tool.name, params, id, signal)
          const planned = Array.isArray(result.details.planned) ? (result.details.planned as Array<Record<string, unknown>>) : []
          if (planned.length)
            pi.sendMessage(
              {
                customType: 'yichuang-plan-receipt',
                content:
                  '章纲已写进目录，可以在目录里改：\n' +
                  planned.map(p => `- 第 ${p.chapterNo} 章 ${p.title}：${p.summary}`).join('\n'),
                display: true
              },
              { triggerTurn: false }
            )
          return result
        }
        return call(tool.name, params, id, signal)
      }
    })
  /** 资料确认是一段明确的等待阶段：固定本批候选，不等待整轮结束，不采用正文。 */
  const settleMaterials = async (params: Record<string, unknown>, id: string, signal?: AbortSignal) => {
    const prepared = await call('confirm_materials', { sessionId: params.sessionId, draftIds: params.draftIds, prepare: true }, `${id}:prepare`, signal)
    if (prepared.details.ready) return prepared
    const confirmationId = prepared.details.confirmationId
    const items = prepared.details.items as Array<{ title: string; kind: string }> | undefined
    if (typeof confirmationId !== 'string' || !items?.length) throw new Error('平台未返回有效资料清单，未开始保存或继续写作')
    const asked = await call('ask_author', {
      sessionId: params.sessionId, kind: 'confirm', question: `确认保存这 ${items.length} 份作品资料？`,
      description: items.map((item, i) => `${i + 1}. ${item.kind}：${item.title}`).join('\n') + '\n确认后写入作品资料，再继续后续步骤；正文仍另行预览采用。',
      options: [{ id: 'adopt', title: '保存这些资料并继续' }, { id: 'stop', title: '先不保存' }], allowFreeText: false
    }, `${id}:confirm`, signal)
    signal?.throwIfAborted()
    const answer = asked.details as AuthorAnswer | null
    if (!answer || answer.cancelled || answer.selectedIds?.[0] !== 'adopt') {
      await call('confirm_materials', { sessionId: params.sessionId, confirmationId, cancel: true }, `${id}:cancel`, signal)
      return { content: [{ type: 'text' as const, text: '作者未确认保存资料，已停止依赖这些资料的写作。可以继续讨论或修改候选，不要绕过确认。' }], details: { cancelled: true } }
    }
    const saved = await call('confirm_materials', { sessionId: params.sessionId, confirmationId, approve: true }, `${id}:adopt`, signal)
    if (saved.details.bookCreated && book?.id) {
      bookSwitchPending = true
      revisionDeliveries.clear()
      return { content: [{ type: 'text' as const, text: '新作品已正式创建；当前轮仍绑定原作品，请先结束本轮，待平台切换新作品后继续，不要写入原作品。' }], details: { ...saved.details, waitingForBookSwitch: true } as Record<string, unknown> }
    }
    // 采用会使先前读取的资料过期。由平台补读，确保后续工具拿到刚保存的版本。
    const references = await call('read_references', { sessionId: params.sessionId }, `${id}:refresh`, signal)
    const details: Record<string, unknown> = { ...saved.details, references: references.details }
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
  }
  const needsPreparation = (stage: string, message: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ready: false, stage, message, draftSubmitted: false, nextAction: 'prepare_writing', ...extra }) }],
    details: { ready: false, stage, draftSubmitted: false, ...extra }
  })
  const prepareWriting = async (params: Record<string, unknown>, id: string, signal?: AbortSignal) => {
    if (bookSwitchPending) return { content: [{ type: 'text' as const, text: '新作品已保存，等待本轮结束后切换；请先结束本轮。' }], details: { waitingForBookSwitch: true, ready: false, draftSubmitted: false } }
    const scope = { sessionId: params.sessionId }
    const current = await call('read_book', { ...scope, prepare: true }, id + ':book', signal)
    if (!current.details.ready) {
      if (!current.details.bookDraftId) return needsPreparation('book', '请先选择已有作品，或提交新书候选。')
      const saved = await settleMaterials({ ...scope, draftIds: [current.details.bookDraftId] }, id + ':book', signal)
      if (saved.details.cancelled || saved.details.waitingForBookSwitch) return saved
      return needsPreparation('book_saved', '新书已采用。请按当前绑定继续准备；本次没有提交正文。', { adopted: saved.details.adopted })
    }
    if (params.target === 'materials')
      return { content: [{ type: 'text' as const, text: '作品已就绪，可以提交资料候选。' }], details: { ready: true, book: current.details.book } }
    if (params.target === 'chapter') {
      if (!params.chapterId) throw new Error('已有章节的写作准备需要 chapterId')
      const chapter = await call('read_chapter', { ...scope, chapterId: params.chapterId, purpose: 'context' }, id + ':chapter', signal)
      if (String(chapter.details.content || '').trim()) return chapterReady(current.details.book, chapter.details)
    }
    const materials = await call('confirm_materials', { ...scope, inspect: true }, id + ':materials', signal)
    if (!materials.details.ready) {
      const saved = await settleMaterials(scope, id + ':materials', signal)
      if (saved.details.cancelled || saved.details.waitingForBookSwitch) return saved
      return needsPreparation('materials_saved', '资料已采用。请继续准备本章；本次没有提交正文。', { adopted: saved.details.adopted })
    }
    if (params.target === 'chapter') {
      const chapter = await call('read_chapter', { ...scope, chapterId: params.chapterId, purpose: 'context' }, id + ':chapter', signal)
      return chapterReady(current.details.book, chapter.details)
    }
    const tree = (await call('list_chapters', scope, id + ':volumes', signal)).details as unknown as Array<{ id: number; title: string; children: unknown[] }>
    if (!tree.length) throw new Error('当前作品没有分卷，请先创建分卷')
    let volumeId = String(params.volumeId || '')
    if (params.target === 'batch') {
      const last = String(tree[tree.length - 1].id)
      if (volumeId && volumeId !== last) throw new Error('当前连写只支持最后一卷，未改变作者指定的目标')
      volumeId = last
    }
    if (!volumeId && tree.length === 1) volumeId = String(tree[0].id)
    if (!volumeId) {
      const answer = await call('ask_author', { ...scope, kind: 'choice', question: '新章节放在哪一卷？',
        options: tree.map(v => ({ id: String(v.id), title: v.title, description: '现有 ' + v.children.length + ' 章，候选采用后追加卷末' })), allowFreeText: true }, id + ':volume', signal)
      signal?.throwIfAborted()
      const picked = answer.details as AuthorAnswer
      if (picked.cancelled) return cancelledPreparation()
      const chosen = picked.selectedIds?.[0]
      return needsPreparation('volume_selected', '请沿用作者选择的卷；有文字补充先处理补充，再核对前章。', {
        ...(tree.some(v => String(v.id) === chosen) ? { volumeId: chosen } : {}),
        questionSpec: answer.details.questionSpec, answer: picked
      })
    }
    if (!tree.some(v => String(v.id) === volumeId)) throw new Error('所选分卷不属于当前作品')
    const check = await call('save_new_chapter_draft', { ...scope, volumeId, check: true }, id + ':continuity', signal)
    if (check.details.ready)
      return { content: [{ type: 'text' as const, text: '写作位置已确认。write_prose 会自动读取前文和故事记录，提交本章目标即可。\n' + JSON.stringify(check.details) }], details: { ...check.details, book: current.details.book, volumeId } }
    const report = check.details as { question?: string; description?: string; options?: unknown[]; resolutions?: Record<string, unknown> }
    const answer = await call('ask_author', { ...scope, kind: 'confirm', question: report.question,
      description: report.description, options: report.options, allowFreeText: false }, id + ':continuity-choice', signal)
    signal?.throwIfAborted()
    const picked = answer.details as AuthorAnswer
    const resolution = report.resolutions?.[picked.selectedIds?.[0] || '']
    if (picked.cancelled || !resolution) return cancelledPreparation()
    await call('save_new_chapter_draft', { ...scope, volumeId, resolve: resolution }, id + ':continuity-resolve', signal)
    return needsPreparation('continuity_updated', '前章决定已处理。请继续核对准备状态并读取最新正文，本次没有提交新章。', { volumeId })
  }
  const cancelledPreparation = () => ({
    content: [{ type: 'text' as const, text: '作者取消了写作准备，本次未提交候选。请停止相关操作。' }],
    details: { cancelled: true, ready: false, draftSubmitted: false }
  })
  const chapterReady = (currentBook: unknown, chapter: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ready: true, book: currentBook, chapter }) }],
    details: { ready: true, book: currentBook, chapter }
  })
  // 模型只提供问题和建议。平台业务卡直接走 call('ask_author', ...)，不受此接口收窄影响。
  const questionText = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
      throw new Error(`提问尚未展示：${label}须为 1—${max} 字的文字。请修正格式后重发。`)
    return value.trim()
  }
  pi.registerTool({
    name: 'ask_author',
    executionMode: 'sequential',
    label: '询问作者',
    description:
      '关键方向需要作者决定时问一个问题。通常给2—4个有理由的建议；无合适建议可省略 options。multiple=true 允许多选，始终接受文字回答。正式采用和执行权限由平台确认处理。',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 1000 }),
      afterAnswer: Type.Union([Type.Literal('continue'), Type.Literal('pause')], { description: '按本次约定明确回答后继续还是暂停；只收集回答时用 pause。作者可在卡片上覆盖，不根据回答文字匹配关键词。' }),
      multiple: Type.Optional(Type.Boolean()),
      options: Type.Optional(Type.Array(Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
      }, { additionalProperties: false }), { maxItems: 8 }))
    }, { additionalProperties: false }),
    async execute(id, rawArgs, signal, _update, ctx) {
      const args = decodeModelEscapes(rawArgs)
      const question = questionText(args.question, '问题', 1000)
      if (!['continue', 'pause'].includes(args.afterAnswer)) throw new Error('请明确回答后 continue 或 pause')
      if (args.options !== undefined && (!Array.isArray(args.options) || args.options.length > 8))
        throw new Error('提问尚未展示：options 须为建议列表，最多 8 项；没有合理建议时可省略。')
      const options = (args.options || []).map(option => ({
        title: questionText(option?.title, '建议标题', 120),
        ...(option?.description !== undefined
          ? { description: questionText(option.description, '建议说明', 500) }
          : {})
      }))
      // 显式重建参数，模型不能透传 kind、card、steps 或 allowFreeText 来生成业务确认卡。
      // 不增加历史格式：原有归一化会将无选项的问题显示为自由输入，其余显示为单选加自由回答。
      const result = await call('ask_author', { question, options, kind: 'choice', afterAnswer: args.afterAnswer, multiple: args.multiple === true, allowFreeText: true, sessionId: ctx.sessionManager.getSessionId() }, id, signal)
      const answer = result.details as AuthorAnswer | null
      if (answer?.cancelled) { revisionDeliveries.clear(); stop(ctx) }
      return {
        content: [{ type: 'text', text: describeAnswer(answer) }],
        details: answer || { cancelled: true }
      }
    }
  })
  // Pi 的 Skill 加载仍走原生资源机制；模型只能读取内置技能目录和作者技能目录里的文件。
  const skillRoots: string[] = [fileURLToPath(new URL('../skills/', import.meta.url))]
  try {
    const extra = JSON.parse(process.env.EW_PI_SKILL_DIRS || '[]')
    if (Array.isArray(extra)) skillRoots.push(...extra.filter((item): item is string => typeof item === 'string'))
  } catch {
    /* 没有作者技能目录时只开放内置目录 */
  }
  const readMethod = async (requested: string) => {
    const path = await realpath(resolve(requested))
    let allowed = false
    for (const candidate of skillRoots) {
      const root = await realpath(candidate).catch(() => '')
      if (!root) continue
      const rel = relative(root, path)
      if (!rel.startsWith('..') && !isAbsolute(rel)) allowed = true
    }
    if (!allowed) throw new Error('只允许读取技能目录里的文件')
    return { path, content: await readFile(path, 'utf8') }
  }
  pi.registerTool({
    name: 'read',
    label: '读取技能文件',
    description: '读取所选 Skill 的 SKILL.md 与必要参考文件，仅限技能目录；已完整展开的内容可直接使用。',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      const method = await readMethod(args.path)
      return { content: [{ type: 'text', text: method.content + toolNotice(method.content) }], details: {} }
    }
  })
  // 技能页改完后，界面给开着的对话发这条命令，让 Pi 重新读技能列表，不用重开对话。
  pi.registerCommand('yichuang-reload', {
    description: '重新加载易创技能',
    async handler(_args, ctx) {
      await ctx.reload()
    }
  })
}
