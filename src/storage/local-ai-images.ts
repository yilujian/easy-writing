import { withRecordStore } from './desktop-records'
import type {
  AiImageGenerateReq,
  AiImageGenerateRes,
  AiImageHistoryItem,
  AiImageHistoryQuery,
} from '@/types/ai-image'
import type { ResPage } from '@/types'
import { createLocalEntityId, nowIso } from './local-library-utils'
import { useAiModelStore } from '@/stores/ai-model'
import { getLocalAiModelSecret } from './local-ai-models'
import { NO_MODEL_MESSAGE, generateLocalAiImageRequest } from '@/utils/local-ai-client'

/**
 * 生图记录本地库（替代 /ai/image/*）：画师（角色/世界地图）与封面工坊共用。
 *
 * - 图片二进制（Blob）直接存 IndexedDB，展示时造 objectURL——同源地址，
 *   封面画布合成（canvas 导出）不会被跨域污染，比服务端图床还省事；
 * - 网页端个别供应商只回图床 url 且跨域捞不回：如实存 remoteUrl 展示，
 *   记录上标注"远程图片可能过期"；桌面端不受此限制；
 * - 负面提示词并进正文提示（OpenAI 兼容生图没有 negative_prompt 参数）。
 */

interface LocalAiImageRecord {
  id: number
  bookId: number | null
  scene: string
  title: string
  prompt: string
  negativePrompt: string
  style: string
  size: string
  quality: string
  modelCode: string
  modelName: string
  blob: Blob | null
  remoteUrl: string
  createTime: string
}

const DB_NAME = 'ew-local-ai-images'
const STORE_NAME = 'images'

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4], options?: Parameters<typeof withRecordStore>[5]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, 'id', mode, run, options)
/** 列表读取：一张图片文件坏了只让那一条没有预览，历史列表和清空照常可用 */
const readAll = () => withStore<LocalAiImageRecord[]>('readonly', store => store.getAll(), { tolerateMissingAssets: true })

// 展示地址缓存：同一条记录整个会话内复用一个 objectURL，避免每次列表都新建泄漏
const objectUrls = new Map<number, string>()

const imageUrlOf = (record: LocalAiImageRecord) => {
  if (record.blob) {
    const cached = objectUrls.get(record.id)
    if (cached) return cached
    const url = URL.createObjectURL(record.blob)
    objectUrls.set(record.id, url)
    return url
  }
  return record.remoteUrl
}

const releaseObjectUrl = (id: number) => {
  const url = objectUrls.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    objectUrls.delete(id)
  }
}

const toHistoryItem = (record: LocalAiImageRecord): AiImageHistoryItem => ({
  id: record.id,
  scene: record.scene,
  title: record.title || undefined,
  prompt: record.prompt || undefined,
  negativePrompt: record.negativePrompt || undefined,
  style: record.style || undefined,
  size: record.size || undefined,
  quality: record.quality || undefined,
  modelCode: record.modelCode || undefined,
  modelName: record.modelName || undefined,
  imageUrl: imageUrlOf(record),
  status: 1,
  createTime: record.createTime,
})

const resolveImageModelCode = async (explicit?: string) => {
  const code = String(explicit || '').trim()
  if (code) return code
  const store = useAiModelStore()
  if (!store.imageModel) await store.loadImageModels()
  if (store.imageModel) return store.imageModel
  const fallback = store.imageModels[0]?.code || ''
  if (!fallback) {
    throw new Error('还没有可用的生图模型：请先到「模型管理」添加并启用一个图片模型')
  }
  return fallback
}

/** 生成一张图并入库（替代 /ai/image/generate） */
export const generateLocalAiImage = async (
  data: AiImageGenerateReq,
  _options?: { silentError?: boolean }
) => {
  const modelCode = await resolveImageModelCode(data.model)
  const model = getLocalAiModelSecret(modelCode)
  if (!model) throw new Error(NO_MODEL_MESSAGE)
  const negative = String(data.negativePrompt || '').trim()
  const prompt = [String(data.prompt || '').trim(), negative ? `画面中不要出现：${negative}` : '']
    .filter(Boolean)
    .join('\n')
  const sceneLabels: Record<string, string> = {
    cover: '封面生成',
    character: '角色立绘',
    world: '世界地图',
  }
  const result = await generateLocalAiImageRequest({
    modelCode,
    prompt,
    size: data.size,
    quality: data.quality,
    scene: `image_${data.scene}`,
    sceneLabel: sceneLabels[String(data.scene)] || '生图',
  })
  const record: LocalAiImageRecord = {
    id: createLocalEntityId(),
    bookId: data.bookId != null && Number(data.bookId) !== 0 ? Number(data.bookId) : null,
    scene: String(data.scene || ''),
    title: String(data.title || ''),
    prompt: String(data.prompt || ''),
    negativePrompt: negative,
    style: String(data.style || ''),
    size: String(data.size || ''),
    quality: String(data.quality || ''),
    modelCode,
    modelName: model.name || model.modelCode,
    blob: result.blob || null,
    remoteUrl: result.remoteUrl || '',
    createTime: nowIso(),
  }
  await withStore('readwrite', store => store.put(record))
  const response: AiImageGenerateRes = {
    id: record.id,
    scene: record.scene,
    title: record.title || undefined,
    prompt: record.prompt || undefined,
    negativePrompt: record.negativePrompt || undefined,
    style: record.style || undefined,
    size: record.size || undefined,
    quality: record.quality || undefined,
    modelCode: record.modelCode,
    modelName: record.modelName,
    imageUrl: imageUrlOf(record),
    createdAt: record.createTime,
  }
  return { data: response }
}

/** 历史记录（替代 /ai/image/history）：按书/场景过滤 + 分页，新的在前 */
export const getLocalAiImageHistory = async (params: AiImageHistoryQuery) => {
  const all = await readAll()
  const bookId = params.bookId != null && Number(params.bookId) !== 0 ? Number(params.bookId) : null
  const scene = String(params.scene || '').trim()
  const filtered = all
    .filter(record => (bookId == null ? true : Number(record.bookId) === bookId))
    .filter(record => (scene ? record.scene === scene : true))
    .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)))
  const page = Math.max(1, Number(params.page || 1))
  const size = Math.max(1, Number(params.size || 20))
  const result: ResPage<AiImageHistoryItem> = {
    list: filtered.slice((page - 1) * size, page * size).map(toHistoryItem),
    pagination: { page, size, total: filtered.length },
  }
  return { data: result }
}

export const deleteLocalAiImages = async (data: { ids: number[] }) => {
  for (const id of data.ids) {
    releaseObjectUrl(Number(id))
    await withStore('readwrite', store => store.delete(Number(id)))
  }
  return { data: undefined as void }
}

/** 清空（替代 /ai/image/clear）：带 bookId 只清该书，不带全清 */
export const clearLocalAiImages = async (data: { bookId?: number }) => {
  const all = await readAll()
  const bookId = data.bookId != null && Number(data.bookId) !== 0 ? Number(data.bookId) : null
  for (const record of all) {
    if (bookId != null && Number(record.bookId) !== bookId) continue
    releaseObjectUrl(record.id)
    await withStore('readwrite', store => store.delete(record.id))
  }
  return { data: undefined as void }
}
