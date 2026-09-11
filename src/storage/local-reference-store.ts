import type {
  Character,
  CharacterGroup,
  CharacterRelation,
  OutlineNode,
  WorldSetting,
  WorldSettingGroup,
} from '@/types'
import type {
  PlotBinding,
  Storyline,
  StorylineListResult,
  StorylineNode,
  StorylineNodeRelation,
  TimelineEvent,
} from '@/types/plot'
import { createLocalEntityId, nowIso } from './local-library-utils'

/**
 * 参考面板本地库的存储底盘（大纲/角色/设定/时间线/故事线共用）：
 * 数据按书整包存 IndexedDB（设定/角色详情是富文本，可能超出 localStorage 容量）。
 * CRUD 函数在 local-reference.ts（书域）与 local-reference-plot.ts（剧情域），
 * 备份迁移在 local-reference-transfer.ts。
 */

const DB_NAME = 'ew-local-reference'
const STORE_NAME = 'book-reference'

export interface BookReferenceDoc {
  version: 1
  bookId: string
  outlineNodes: OutlineNode[]
  characters: Character[]
  characterGroups: CharacterGroup[]
  characterRelations: CharacterRelation[]
  /** 关系画布上各角色卡的位置（键=角色 id）；没存过的角色由画布按默认布局摆放 */
  characterCanvasPositions: Record<string, { x: number; y: number }>

  worldSettings: WorldSetting[]
  worldSettingGroups: WorldSettingGroup[]
  timelineEvents: TimelineEvent[]
  storylines: Storyline[]
  storylineRelations: StorylineListResult['relations']
  storylineNodes: StorylineNode[]
  storylineNodeRelations: StorylineNodeRelation[]
  plotBindings: PlotBinding[]
  updatedAt: string
}

const emptyDoc = (bookId: string): BookReferenceDoc => ({
  version: 1,
  bookId,
  outlineNodes: [],
  characters: [],
  characterGroups: [],
  characterRelations: [],
  characterCanvasPositions: {},
  worldSettings: [],
  worldSettingGroups: [],
  timelineEvents: [],
  storylines: [],
  storylineRelations: [],
  storylineNodes: [],
  storylineNodeRelations: [],
  plotBindings: [],
  updatedAt: nowIso(),
})

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const request = run(tx.objectStore(STORE_NAME))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error || request.error)
      tx.onabort = () => reject(tx.error || new Error('参考数据事务中止'))
    })
  } finally {
    db.close()
  }
}

export const bookKey = (bookId: string | number) => String(bookId)

/** 彻底删除某书的参考数据整包（回收站"彻底删除"级联用） */
export const deleteLocalReferenceDoc = async (bookId: string | number) => {
  await withStore('readwrite', store => store.delete(bookKey(bookId)))
}

export const readDoc = async (bookId: string | number): Promise<BookReferenceDoc> => {
  const stored = await withStore<unknown>('readonly', store => store.get(bookKey(bookId)))
  if (stored && typeof stored === 'object' && (stored as BookReferenceDoc).version === 1) {
    return { ...emptyDoc(bookKey(bookId)), ...(stored as BookReferenceDoc) }
  }
  return emptyDoc(bookKey(bookId))
}

export const mutateDoc = async <T>(
  bookId: string | number,
  fn: (doc: BookReferenceDoc) => T
): Promise<T> => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(bookKey(bookId))
      let result: T
      request.onsuccess = () => {
        try {
          const doc = { ...emptyDoc(bookKey(bookId)), ...(request.result || {}) } as BookReferenceDoc
          result = fn(doc)
          doc.updatedAt = nowIso()
          store.put(JSON.parse(JSON.stringify(doc)), bookKey(bookId))
        } catch (error) { tx.abort(); reject(error) }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error || request.error)
      tx.onabort = () => reject(tx.error || new Error('参考数据事务中止'))
    })
  } finally { db.close() }
}

/** 服务端接口的 { data } 信封 */
export const ok = <T>(data: T) => ({ data })

/** 镜像 JSON 传输：只落 undefined 之外的字段（null 表示清空） */
export const applyDefined = <T extends object>(target: T, patch: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value
  }
}

export const nextLocalId = () => createLocalEntityId()

export const bySortNo = <T extends { sortNo?: number; id: number }>(list: T[]) =>
  [...list].sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || a.id - b.id)

export const idSet = (ids: Array<number | string>) => new Set(ids.map(id => String(id)))

/** 各书参考数据的最近更新时间（备份服务据此挑出有变化的书，避免每轮重写相同快照） */
export const listReferenceBookStamps = async (): Promise<Array<{ bookId: string; updatedAt: string }>> => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  const stamps: Array<{ bookId: string; updatedAt: string }> = []
  for (const key of keys) {
    const doc = await readDoc(String(key))
    stamps.push({ bookId: doc.bookId, updatedAt: doc.updatedAt })
  }
  return stamps
}

/** 按实体 id 反查所属书（面板的更新/删除接口只带实体 id，不带 bookId） */
export const findBookIdByEntity = async (
  id: number | undefined,
  pick: (doc: BookReferenceDoc) => Array<{ id: number }>
): Promise<string> => {
  if (id === undefined) throw new Error('缺少实体 id')
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  for (const key of keys) {
    const doc = await readDoc(String(key))
    if (pick(doc).some(item => item.id === id)) return doc.bookId
  }
  throw new Error('本地参考数据不存在（id: ' + id + '）')
}
