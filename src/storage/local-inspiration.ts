import { appSettings, flushAppSettings } from '@/storage/app-settings'
import type { Inspiration, InspirationInsights } from '@/types'

/**
 * 灵感便签本地库：替代旧服务端 /writing/inspiration 数据通道。
 * 界面功能与数据形状保持与服务端接口一致（用户将来要改造该功能，这里只换通道）。
 * 桌面端存 SQLite 设置记录；网页端使用 localStorage。
 */

const STORAGE_KEY = 'ew-local-inspirations'

const nowText = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const loadAll = (): Inspiration[] => {
  try {
    const raw = appSettings.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some(item=>!item || typeof item.id !== 'number')) throw new Error('灵感数据格式无效')
    return parsed
  } catch (error) {
    throw new Error(`读取本地灵感失败，未覆盖原数据：${String(error)}`)
  }
}

const saveAll = async (list: Inspiration[]) => {
  appSettings.setItem(STORAGE_KEY, JSON.stringify(list))
  await flushAppSettings()
}

// 与本地书库同规约：本地实体用负 ID
const nextLocalId = (list: Inspiration[]) => {
  const minId = list.reduce((min, item) => Math.min(min, Number(item.id) || 0), 0)
  return minId - 1
}

export const listLocalInspirations = (params?: { tag?: string; keyword?: string }): Inspiration[] => {
  let list = loadAll()
  const tag = String(params?.tag || '').trim()
  const keyword = String(params?.keyword || '').trim()
  if (tag) {
    list = list.filter(item => String(item.tag || '').trim() === tag)
  }
  if (keyword) {
    const lower = keyword.toLowerCase()
    list = list.filter(
      item =>
        String(item.content || '').toLowerCase().includes(lower) ||
        String(item.tag || '').toLowerCase().includes(lower)
    )
  }
  return list
}

export const addLocalInspiration = async (data: { content?: string; tag?: string; isPinned?: number }): Promise<Inspiration> => {
  const list = loadAll()
  const item: Inspiration = {
    id: nextLocalId(list),
    content: String(data.content || ''),
    tag: String(data.tag || '').trim() || undefined,
    isPinned: Number(data.isPinned || 0),
    createTime: nowText(),
    updateTime: nowText()
  }
  list.unshift(item)
  await saveAll(list)
  return item
}

export const updateLocalInspiration = async (data: Partial<Inspiration> & { id: number }): Promise<Inspiration | null> => {
  const list = loadAll()
  const index = list.findIndex(item => Number(item.id) === Number(data.id))
  if (index < 0) return null
  const next: Inspiration = {
    ...list[index],
    ...data,
    id: list[index].id,
    updateTime: nowText()
  }
  list[index] = next
  await saveAll(list)
  return next
}

export const deleteLocalInspirations = async (ids: number[]) => {
  const idSet = new Set(ids.map(Number))
  const list = loadAll().filter(item => !idSet.has(Number(item.id)))
  await saveAll(list)
}

/** 热门标签从本地灵感统计；每日推荐属 AI 能力，待第二步接本地模型 */
export const getLocalInspirationInsights = (): InspirationInsights => {
  const counts = new Map<string, number>()
  for (const item of loadAll()) {
    const tag = String(item.tag || '').trim()
    if (!tag) continue
    counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  const hotTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag]) => tag)
  return { hotTags, dailySuggestion: '' }
}
