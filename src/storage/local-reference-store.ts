import { trackStorageWrite } from './storage-maintenance'
import { StorageRecordCorruptError } from './stored-record'
import type { CommonWord } from '@/types/word-library'
import { normalizeCharacterAliases } from '@/utils/character-aliases'
import { usesUnifiedStorage } from './storage-mode'
import { withRecordStore, mutateDesktopRecord } from './desktop-records'
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
 * 数据按书整包保存：桌面端 SQLite，网页端 IndexedDB。
 * CRUD 函数在 local-reference.ts（书域）与 local-reference-plot.ts（剧情域），
 * 备份迁移在 local-reference-transfer.ts。
 */

const DB_NAME = 'ew-local-reference'
const STORE_NAME = 'book-reference'

export interface BookReferenceDoc {
  version: 1
  bookId: string
  outlineNodes: OutlineNode[]
  commonWords: CommonWord[]
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
  commonWords: [],
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

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

export const bookKey = (bookId: string | number) => String(bookId)

function normalizeReferenceDoc(value: unknown, bookId: string | number): BookReferenceDoc {
  const empty = emptyDoc(bookKey(bookId))
  if (value == null) return empty
  if (typeof value !== 'object' || Array.isArray(value) || (value as BookReferenceDoc).version !== 1)
    throw new StorageRecordCorruptError('作品参考资料')
  const doc = { ...empty, ...value } as BookReferenceDoc
  for (const field of Object.keys(empty) as Array<keyof BookReferenceDoc>) {
    if (Array.isArray(empty[field]) && !Array.isArray(doc[field])) throw new StorageRecordCorruptError('作品参考资料')
  }
  if (String(doc.bookId) !== bookKey(bookId)) throw new StorageRecordCorruptError('作品参考资料归属')
  return doc
}

/** 彻底删除某书的参考数据整包（回收站"彻底删除"级联用） */
export const deleteLocalReferenceDoc = async (bookId: string | number) => {
  await withStore('readwrite', store => store.delete(bookKey(bookId)))
}

export const readDoc = async (bookId: string | number): Promise<BookReferenceDoc> => {
  const stored = await withStore<unknown>('readonly', store => store.get(bookKey(bookId)))
  {
    const doc = normalizeReferenceDoc(stored, bookId)
    doc.characters = doc.characters.map(character => ({
      ...character, aliases: normalizeCharacterAliases(character.name, character.aliases),
    }))
    return doc
  }
}

const mutateDocInternal = async <T>(
  bookId: string | number,
  fn: (doc: BookReferenceDoc) => T
 ): Promise<T> => {
  if (usesUnifiedStorage()) return mutateDesktopRecord(`${DB_NAME}/${STORE_NAME}`, bookKey(bookId), value => {
    const doc = normalizeReferenceDoc(value, bookId)
    const result = fn(doc)
    doc.updatedAt = nowIso()
    return { value: doc, result }
  })
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(bookKey(bookId))
      let result: T
      request.onsuccess = () => {
        try {
          const doc = normalizeReferenceDoc(request.result, bookId)
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

export const mutateDoc = <T>(bookId: string | number, fn: (doc: BookReferenceDoc) => T): Promise<T> =>
  trackStorageWrite(() => mutateDocInternal(bookId, fn))

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
