import type { UserAiModelSavePayload, UserAiModelTestResult } from '@/types/user-ai-model'
import type {
  ModelTestOptions,
  ModelTestOutcome,
  ModelTestProgress,
  ModelTestResponseState
} from '@/types/model-test'
import { defaultThinkingFor, getLocalAiModelSecret, recordLocalAiModelTest } from '@/storage/local-ai-models'
import { appendLocalAiRecord } from '@/storage/local-ai-records'
import { isTauriRuntime } from '@/storage'
import {
  buildAuthHeaders,
  buildChatBody,
  joinAiUrl,
  parseExtraParams,
  readableHttpError,
  resolveAiFetch
} from './local-ai-protocol'
import {
  MODEL_TEST_CONNECT_MS,
  MODEL_TEST_IDLE_MS,
  modelTestConfiguration,
  modelTestWaitSeconds
} from './model-test-policy'
import { readModelTestResponse } from './model-test-response'

interface ActiveTest {
  config: string
  controller: AbortController
  progress: ModelTestProgress
  listeners: Set<NonNullable<ModelTestOptions['onProgress']>>
  promise: Promise<{ data: UserAiModelTestResult }>
}
const active = new Map<string, ActiveTest>()
const completedConfigurations = new WeakMap<UserAiModelTestResult, string>()
const TEST_INPUT = '连通性测试，请只简短回复 OK。'

/** 新增模型可先测试再保存；仅把同一份真实配置的结果记到保存后的模型上。 */
export async function persistModelTestResult(id: number, result: UserAiModelTestResult): Promise<boolean> {
  if (result.outcome === 'cancelled' || !getLocalAiModelSecret(String(id))) return false
  const tested = completedConfigurations.get(result)
  if (!tested || tested !== modelTestConfiguration(resolveModel({ id }))) return false
  await recordLocalAiModelTest(id, result)
  return true
}

/** 编辑时空密钥沿用原值；其余显式填写的字段不偷偷换回旧配置。 */
function resolveModel(payload: Partial<UserAiModelSavePayload>): UserAiModelSavePayload {
  const saved = payload.id == null ? null : getLocalAiModelSecret(String(payload.id))
  const read = <K extends keyof UserAiModelSavePayload>(key: K, fallback: UserAiModelSavePayload[K]) =>
    payload[key] ?? saved?.[key] ?? fallback
  const provider = read('provider', 'custom')
  return {
    id: payload.id,
    name: read('name', ''),
    scene: read('scene', 'text'),
    protocol: 'openai_compatible',
    provider,
    baseUrl: String(read('baseUrl', '')).trim(),
    modelCode: String(read('modelCode', '')).trim(),
    apiKey: payload.apiKey?.trim() || saved?.apiKey || '',
    maxContext: read('maxContext', 4096),
    maxOutputTokens: read('maxOutputTokens', 2048),
    status: read('status', 1),
    thinking: read('thinking', defaultThinkingFor(provider)),
    extraParams: read('extraParams', ''),
    testWaitSeconds: read('testWaitSeconds', undefined)
  }
}

function networkMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/not allowed on the configured scope/i.test(message)) return '桌面端未放行该接口地址，请检查 Base URL'
  if (/connect.*timed? ?out|operation timed out|tcp connect/i.test(message))
    return '未能在 60 秒内连接模型服务，请检查服务是否启动、地址与网络'
  if (error instanceof TypeError || /error sending request|Failed to fetch|fetch failed/i.test(message))
    return isTauriRuntime()
      ? '请求模型服务失败，请检查服务是否启动、接口地址与网络'
      : '网络请求失败：请检查接口地址；网页也可能受跨域限制，建议使用桌面版'
  if (/error decoding response body|network.*error|terminated|connection.*closed/i.test(message))
    return '模型响应在传输中断开，请检查网络后重试'
  return message.slice(0, 300) || '模型测试未完成'
}

async function run(
  model: UserAiModelSavePayload,
  task: ActiveTest
): Promise<{ data: UserAiModelTestResult }> {
  const started = Date.now(),
    wait = modelTestWaitSeconds(model)
  const controller = task.controller,
    signal = controller.signal
  const image = model.scene === 'image'
  const url = joinAiUrl(model.baseUrl, image ? 'models' : 'chat/completions')
  const state: ModelTestResponseState = { reply: '', thinking: false }
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timedOut: 'first' | 'idle' | undefined
  let requestSent = false,
    readingStarted = false
  const result = (outcome: ModelTestOutcome, message: string): UserAiModelTestResult => ({
    ok: outcome === 'success' || outcome === 'reachable',
    outcome,
    message,
    latency: Date.now() - started,
    url,
    testedAt: new Date().toISOString(),
    ...(state.reply.trim() ? { reply: state.reply.trim().slice(0, 500) } : {}),
    ...(state.inputTokens != null ? { inputTokens: state.inputTokens } : {}),
    ...(state.outputTokens != null ? { outputTokens: state.outputTokens } : {})
  })
  const notify = () => {
    task.progress = { ...task.progress, elapsedMs: Date.now() - started }
    for (const listener of task.listeners) listener(task.progress)
  }
  const arm = (milliseconds: number, kind: 'first' | 'idle') => {
    clearTimeout(deadline)
    deadline = setTimeout(() => {
      timedOut = kind
      controller.abort()
    }, milliseconds)
  }
  const onOutput = (phase: ModelTestProgress['phase']) => {
    task.progress.phase = phase
    arm(MODEL_TEST_IDLE_MS, 'idle')
    notify()
  }
  const clock = setInterval(notify, 1000)
  let outcome: UserAiModelTestResult
  try {
    if (!model.baseUrl) throw new Error('请先填写接口地址（Base URL）')
    if (!model.modelCode) throw new Error('请先填写模型代码（模型名称）')
    let parsed: URL
    try {
      parsed = new URL(model.baseUrl)
    } catch {
      throw new Error('接口地址格式不正确，请检查 Base URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('接口地址须以 http:// 或 https:// 开头')
    if (model.scene !== 'text' && model.scene !== 'image') throw new Error('不支持的模型用途')
    const extra = parseExtraParams(model.extraParams) || {}
    if (model.extraParams?.trim() && !parseExtraParams(model.extraParams))
      throw new Error('额外请求参数须为有效的 JSON 对象')
    const stream = extra.stream !== false
    // 测试只发一个短问题；自定义参数不能替换目标模型、放大预算或要求多份回答。
    for (const key of [
      'messages',
      'model',
      'tools',
      'tool_choice',
      'max_tokens',
      'max_completion_tokens',
      'n',
      'stream'
    ])
      delete extra[key]
    const budget = Math.max(1, Math.min(model.maxOutputTokens || 2048, model.thinking === 'off' ? 128 : 2048))
    const body = image
      ? undefined
      : buildChatBody({
          baseUrl: model.baseUrl,
          provider: model.provider,
          modelCode: model.modelCode,
          thinking: model.thinking,
          messages: [{ role: 'user', content: TEST_INPUT }],
          maxTokens: budget,
          minimumOutputTokens: 0,
          stream,
          extraBody: extra
        })
    if (body && stream)
      body.stream_options = { ...((extra.stream_options as object) || {}), include_usage: true }
    const fetch = await resolveAiFetch()
    signal.throwIfAborted()
    arm(wait * 1000, 'first')
    notify()
    requestSent = true
    const response = await fetch(url, {
      method: image ? 'GET' : 'POST',
      signal,
      connectTimeout: MODEL_TEST_CONNECT_MS,
      headers: buildAuthHeaders(model.apiKey),
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    signal.throwIfAborted()
    if (!response.ok) {
      const message = await readableHttpError(response)
      outcome =
        image && [404, 405, 501].includes(response.status)
          ? result('unverified', '服务未提供可用的模型列表，请核对 Base URL；本次尚未验证生图能力')
          : result('failed', message)
    } else if (image) {
      const data = (await response.json()) as { data?: Array<{ id?: string }>; error?: { message?: string } }
      signal.throwIfAborted()
      if (data.error) throw new Error(data.error.message || '服务返回错误')
      if (!Array.isArray(data.data)) throw new Error('接口没有返回有效的模型列表，尚未验证连接配置')
      outcome = data.data.some(item => item?.id === model.modelCode)
        ? result('reachable', '模型列表可访问，已找到此模型；尚未验证生图，本次未生成图片')
        : result('unverified', '模型列表可访问，但未找到填写的模型代码；尚未验证生图，本次未生成图片')
    } else {
      readingStarted = true
      await readModelTestResponse(response, state, onOutput, signal)
      outcome = result('success', '模型已返回有效回复，测试成功')
    }
  } catch (error) {
    outcome = timedOut
      ? result(
          'timeout',
          timedOut === 'first'
            ? `${wait / 60} 分钟内未收到${image ? '模型列表' : '模型有效输出'}，${image ? '请检查接口配置' : '可在高级设置延长等待时间'}；未判定模型不可用`
            : '模型已开始响应，但连续 120 秒没有新的有效内容，测试已停止'
        )
      : signal.aborted
        ? result('cancelled', '已取消测试')
        : result(readingStarted ? 'unverified' : 'failed', networkMessage(error))
  } finally {
    clearTimeout(deadline)
    clearInterval(clock)
  }
  // 只按供应商实际返回的 usage 记账；缺失时标记未知，不伪装成没有消耗。
  if (requestSent && !image) {
    await appendLocalAiRecord({
      recordType: 'text',
      scene: 'model_test',
      sceneLabel: '模型连接测试',
      modelCode: model.id == null ? model.modelCode : String(model.id),
      modelName: model.name || model.modelCode,
      status: outcome.ok ? 1 : outcome.outcome === 'cancelled' ? 3 : 0,
      input: TEST_INPUT,
      output: state.reply,
      inputTokens: state.inputTokens ?? 0,
      outputTokens: state.outputTokens ?? 0,
      usageSource: state.inputTokens != null && state.outputTokens != null ? 'reported' : 'unavailable',
      duration: outcome.latency,
      errorMsg: outcome.ok ? undefined : outcome.message
    }).catch(error => console.warn('记录模型测试用量失败', error))
  }
  completedConfigurations.set(outcome, task.config)
  if (model.id != null)
    await persistModelTestResult(model.id, outcome).catch(error =>
      console.warn('记录模型测试结果失败', error)
    )
  return { data: outcome }
}

export function testLocalAiModel(
  payload: Partial<UserAiModelSavePayload>,
  options: ModelTestOptions = {}
): Promise<{ data: UserAiModelTestResult }> {
  const model = resolveModel(payload),
    config = modelTestConfiguration(model)
  const key =
    model.id == null ? `unsaved:${model.provider}:${model.baseUrl}:${model.modelCode}` : `saved:${model.id}`
  let task = active.get(key)
  if (task && task.config !== config) {
    task.controller.abort()
    task = undefined
  }
  if (!task) {
    const created: ActiveTest = {
      config,
      controller: new AbortController(),
      progress: { phase: 'waiting', elapsedMs: 0 },
      listeners: new Set(),
      promise: Promise.resolve()
        .then(() => run(model, created))
        .finally(() => {
          if (active.get(key) === created) active.delete(key)
        })
    }
    task = created
    active.set(key, created)
  }
  const current = task
  if (options.onProgress) {
    current.listeners.add(options.onProgress)
    options.onProgress(current.progress)
  }
  const cancel = () => current.controller.abort()
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  return current.promise.finally(() => {
    options.signal?.removeEventListener('abort', cancel)
    if (options.onProgress) current.listeners.delete(options.onProgress)
  })
}
