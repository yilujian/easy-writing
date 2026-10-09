import { appSettings, flushAppSettings } from '@/storage/app-settings'
import type { AiModelGroupCode, AiModelOption } from '@/types/ai-model'
import type { AiThinkingMode, UserAiModelSavePayload } from '@/types/user-ai-model'
import { createLocalEntityId, nowIso } from './local-library-utils'

/**
 * BYOK 模型本地库：替代旧服务端 /ai/user_model/* 数据通道。
 *
 * - 模型配置（含 API Key）桌面端只存本机 SQLite，永不上传；界面与文档同口径提示。
 * - 列表函数返回的选项一律剥离 apiKey（明文密钥只经 getLocalAiModelSecret 交给请求层）。
 * - 编辑保存时 apiKey 传空串 = 保留原密钥（与旧服务端"编辑不回显密钥"语义一致）。
 * - 各场景默认模型偏好（原 /ai/model/preference）也归这里，一并本地化。
 */

export interface LocalAiModel {
  id: number
  name: string
  scene: 'text' | 'image'
  provider: string
  protocol: 'openai_compatible'
  modelCode: string
  baseUrl: string
  apiKey: string
  maxContext: number
  maxOutputTokens: number
  status: number
  sort: number
  createTime: string
  /** 思考模式，老数据缺省视为跟随默认 */
  thinking?: AiThinkingMode
  /** 额外请求参数 JSON 文本 */
  extraParams?: string
  /** 最近一次连通测试：1=已连接 2=失败，缺省=未测试 */
  testStatus?: number
  lastTestAt?: string
  lastLatency?: number | null
  lastError?: string
}

interface LocalAiModelStore {
  version: 1
  models: LocalAiModel[]
  /** 各分组默认模型（值为模型 code，即 String(id)） */
  preferences: Partial<Record<AiModelGroupCode, string>>
}

const STORAGE_KEY = 'ew-local-ai-models'

const emptyStore = (): LocalAiModelStore => ({ version: 1, models: [], preferences: {} })

const loadStore = (): LocalAiModelStore => {
  try {
    const raw = appSettings.getItem(STORAGE_KEY)
    if (raw === null) return emptyStore()
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.models)) throw new Error('模型配置结构或版本不受支持')
    return {
      version: 1,
      models: parsed.models.filter((item: LocalAiModel) => item && typeof item.id === 'number'),
      preferences: parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {},
    }
  } catch (error) {
    throw new Error(`读取模型配置失败，未覆盖原配置：${String(error)}`)
  }
}

const saveStore = async (store: LocalAiModelStore) => {
  appSettings.setItem(STORAGE_KEY, JSON.stringify(store))
  await flushAppSettings()
}

/** 老数据没有 thinking 字段时按供应商给默认：能用参数关思考的供应商默认关，与模型管理的预设一致。
 *  否则升级后老配置会变成"跟随默认"，DeepSeek 这类默认开思考的模型又会把老的 8192 上限吃光 */
const PROVIDERS_DEFAULT_THINKING_OFF = new Set(['deepseek', 'aliyun', 'bigmodel', 'volcengine', 'siliconflow', 'local'])
export const defaultThinkingFor = (provider: string | undefined): AiThinkingMode =>
  PROVIDERS_DEFAULT_THINKING_OFF.has(String(provider || '').trim()) ? 'off' : 'default'

/** 模型的对外唯一码：列表/偏好/请求层都用它指认模型 */
export const localAiModelCode = (id: number) => String(id)

/** 转成界面消费的选项形状；apiKey 在此剥离 */
const toOption = (model: LocalAiModel): AiModelOption => ({
  id: model.id,
  name: model.name,
  code: localAiModelCode(model.id),
  modelCode: model.modelCode,
  scene: model.scene,
  provider: model.provider,
  protocol: model.protocol,
  baseUrl: model.baseUrl,
  ownerType: 'user',
  isMine: true,
  maxContext: model.maxContext,
  maxOutputTokens: model.maxOutputTokens,
  thinking: model.thinking || defaultThinkingFor(model.provider),
  extraParams: model.extraParams || '',
  status: model.status,
  testStatus: model.testStatus,
  lastTestAt: model.lastTestAt,
  lastLatency: model.lastLatency,
  lastError: model.lastError,
})

const sortModels = (models: LocalAiModel[]) =>
  [...models].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id)

export const listLocalAiModels = async (params?: { scene?: string }) => {
  const store = loadStore()
  const scene = String(params?.scene || '').trim()
  const models = sortModels(store.models).filter(model => !scene || model.scene === scene)
  return { data: models.map(toOption) }
}

export const saveLocalAiModel = async (payload: UserAiModelSavePayload) => {
  const store = loadStore()
  if (payload.id != null) {
    const model = store.models.find(item => item.id === payload.id)
    if (!model) throw new Error('模型不存在')
    model.name = payload.name
    model.scene = payload.scene
    model.provider = payload.provider
    model.modelCode = payload.modelCode
    model.baseUrl = payload.baseUrl
    // 编辑时密钥留空 = 沿用原密钥
    if (String(payload.apiKey || '').trim()) model.apiKey = String(payload.apiKey).trim()
    model.maxContext = payload.maxContext
    model.maxOutputTokens = payload.maxOutputTokens
    if (payload.thinking) model.thinking = payload.thinking
    if (payload.extraParams !== undefined) model.extraParams = String(payload.extraParams || '').trim()
    model.status = payload.status
    if (payload.sort != null) model.sort = payload.sort
    await saveStore(store)
    return { data: toOption(model) }
  }
  const model: LocalAiModel = {
    id: createLocalEntityId(),
    name: payload.name,
    scene: payload.scene,
    provider: payload.provider,
    protocol: 'openai_compatible',
    modelCode: payload.modelCode,
    baseUrl: payload.baseUrl,
    apiKey: String(payload.apiKey || '').trim(),
    maxContext: payload.maxContext,
    maxOutputTokens: payload.maxOutputTokens,
    status: payload.status,
    sort: payload.sort ?? store.models.length + 1,
    createTime: nowIso(),
    thinking: payload.thinking || defaultThinkingFor(payload.provider),
    extraParams: String(payload.extraParams || '').trim(),
  }
  store.models.push(model)
  await saveStore(store)
  return { data: toOption(model) }
}

export const setLocalAiModelStatus = async (id: number, status: number) => {
  const store = loadStore()
  const model = store.models.find(item => item.id === id)
  if (!model) throw new Error('模型不存在')
  model.status = status
  await saveStore(store)
  return { data: toOption(model) }
}

/** 记录连通测试结果，列表"测试"列据此显示已连接/失败（原服务端在 test 接口里顺手写回，本地版由调用方显式落库） */
export const recordLocalAiModelTest = async (
  id: number,
  result: { ok: boolean; message?: string; latency?: number | null; testedAt?: string }
) => {
  const store = loadStore()
  const model = store.models.find(item => item.id === id)
  if (!model) throw new Error('模型不存在')
  model.testStatus = result.ok ? 1 : 2
  model.lastTestAt = result.testedAt || nowIso()
  model.lastLatency = result.latency ?? null
  model.lastError = result.ok ? '' : String(result.message || '')
  await saveStore(store)
  return { data: toOption(model) }
}

export const deleteLocalAiModel = async (id: number) => {
  const store = loadStore()
  store.models = store.models.filter(item => item.id !== id)
  // 偏好里指着被删模型的项一并清掉
  for (const key of Object.keys(store.preferences) as AiModelGroupCode[]) {
    if (store.preferences[key] === localAiModelCode(id)) delete store.preferences[key]
  }
  await saveStore(store)
  return { data: true }
}

/** 请求层取完整配置（含明文密钥）；code 即 localAiModelCode */
export const getLocalAiModelSecret = (code: string): LocalAiModel | null => {
  const store = loadStore()
  const model = store.models.find(item => localAiModelCode(item.id) === String(code))
  return model ? { ...model, thinking: model.thinking || defaultThinkingFor(model.provider) } : null
}

// ---------------------------------------------------------------------------
// 各场景默认模型偏好（原 /ai/model/preference）
// ---------------------------------------------------------------------------

/** 分组与模型场景的对应：文本模型供文本辅助与工作流，生图模型供封面 */
/** 按模型 code 取显示名：任务面板等展示场景用，避免把内部负数 id 亮给用户 */
export const getLocalAiModelDisplayName = (code: string): string => {
  const model = getLocalAiModelSecret(code)
  return model ? String(model.name || model.modelCode || '') : ''
}

export const sceneOfGroup = (groupCode: AiModelGroupCode): 'text' | 'image' =>
  groupCode === 'image_generation' ? 'image' : 'text'

export const getLocalAiPreference = (groupCode: AiModelGroupCode): string => {
  return loadStore().preferences[groupCode] || ''
}

export const saveLocalAiPreference = async (groupCode: AiModelGroupCode, modelCode: string) => {
  const store = loadStore()
  if (String(modelCode || '').trim()) {
    store.preferences[groupCode] = String(modelCode).trim()
  } else {
    delete store.preferences[groupCode]
  }
  await saveStore(store)
}
