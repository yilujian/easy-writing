import { usesUnifiedStorage } from './storage-mode'
import { readDesktopRecords, decodeDesktopValue, encodeRecords, writeDesktopRecords } from './desktop-records'
/**
 * 一键备份的 IndexedDB 部分。
 *
 * 兼容旧备份格式的逻辑资料清单（桌面端实际读写统一 SQLite，网页端使用 IndexedDB）：
 * 参考资料、工作流、妙笔对话、AI 记录、拆书、生图、自定义背景、榜单缓存。
 * idb/ 文件名沿用旧版，保证旧包可读；不是桌面端的实际数据库位置：
 *
 *   备份   每个库倒成 idb/<name>.json（键值对列表），Blob 字段拆成 idb-blobs/<name>/<n> 二进制条目
 *   覆盖   清空该库后整库写回
 *   合并   参考资料、工作流、对话、生图跟着作品换号后写入；其余库只补本机没有的键
 */

import type { IdRemap } from './full-backup'

export interface IdbRecord {
  key: string | number
  value: unknown
}

export interface IdbStoreSpec {
  /** 备份条目名与清单计数用的标识 */
  name: string
  db: string
  store: string
  keyPath?: string
  label: string
  /** 合并模式：put 直接写入（键已换号或以备份为准）；add-missing 只补本机没有的键 */
  merge: 'put' | 'add-missing'
  /** 清单里怎么数（默认按记录数） */
  count?: (records: IdbRecord[]) => number
}

export interface IdbDumpFile {
  db: string
  store: string
  keyPath: string | null
  records: IdbRecord[]
}

const countByPrefix = (prefix: string) => (records: IdbRecord[]) =>
  records.filter(record => String(record.key).startsWith(prefix)).length

const countChatSessions = (records: IdbRecord[]) =>
  records
    .filter(record => String(record.key).startsWith('sessions:'))
    .reduce((sum, record) => sum + (Array.isArray(record.value) ? record.value.length : 0), 0)

export const IDB_STORES: IdbStoreSpec[] = [
  { name: 'reference', db: 'ew-local-reference', store: 'book-reference', label: '参考资料', merge: 'put' },
  { name: 'workflow', db: 'ew-local-workflow', store: 'kv', label: '工作流', merge: 'put', count: countByPrefix('run:') },
  { name: 'chat', db: 'ew-local-ai-chat', store: 'kv', label: '妙笔对话', merge: 'put', count: countChatSessions },
  { name: 'ai-records', db: 'ew-local-ai-records', store: 'records', keyPath: 'id', label: 'AI 记录', merge: 'add-missing' },
  { name: 'breakdown', db: 'ew-local-breakdown', store: 'kv', label: '拆书项目', merge: 'add-missing', count: countByPrefix('project:') },
  { name: 'ai-images', db: 'ew-local-ai-images', store: 'images', keyPath: 'id', label: '生图记录', merge: 'add-missing' },
  { name: 'skin', db: 'ew-skin-store', store: 'kv', label: '自定义背景', merge: 'put' },
  { name: 'rank', db: 'ew-local-rank', store: 'kv', label: '榜单缓存', merge: 'add-missing' },
]

export const idbEntryPath = (name: string) => `idb/${name}.json`
const idbBlobEntryPath = (name: string, index: number) => `idb-blobs/${name}/${index}`

export const countIdbRecords = (spec: IdbStoreSpec, records: IdbRecord[]) =>
  spec.count ? spec.count(records) : records.length

// ---------------------------------------------------------------------------
// Blob 拆装：IndexedDB 里的 Blob 不能进 JSON，拆成独立二进制条目
// ---------------------------------------------------------------------------

interface SerializedBlobRef {
  __ewBlob: true
  entry: string
  type: string
}

const isBlobRef = (value: unknown): value is SerializedBlobRef =>
  Boolean(value) && typeof value === 'object' && (value as SerializedBlobRef).__ewBlob === true

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export const extractIdbBlobs = (name: string, records: IdbRecord[]) => {
  const blobs: Array<{ entry: string; blob: Blob }> = []
  const serializable = records.map(record => {
    if (!isPlainObject(record.value)) return record
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [field, item] of Object.entries(record.value)) {
      if (typeof Blob !== 'undefined' && item instanceof Blob) {
        const entry = idbBlobEntryPath(name, blobs.length)
        blobs.push({ entry, blob: item })
        next[field] = { __ewBlob: true, entry, type: item.type } satisfies SerializedBlobRef
        changed = true
      } else {
        next[field] = item
      }
    }
    return changed ? { key: record.key, value: next } : record
  })
  return { records: serializable, blobs }
}

export const restoreIdbBlobs = async (
  records: IdbRecord[],
  readEntry: (entry: string) => Promise<Uint8Array>
): Promise<IdbRecord[]> => {
  const out: IdbRecord[] = []
  for (const record of records) {
    if (!isPlainObject(record.value)) {
      out.push(record)
      continue
    }
    const next: Record<string, unknown> = {}
    for (const [field, item] of Object.entries(record.value)) {
      if (isBlobRef(item)) {
        const bytes = await readEntry(item.entry)
        next[field] = new Blob([bytes as BlobPart], { type: item.type })
      } else {
        next[field] = item
      }
    }
    out.push({ key: record.key, value: next })
  }
  return out
}

// ---------------------------------------------------------------------------
// 纯函数：合并模式的换号
// ---------------------------------------------------------------------------

/** 记录里按字段名识别的关联 id；值是数字或数字字符串，换号后保持原类型 */
const ID_FIELDS: Record<string, Exclude<keyof IdRemap, 'referenceEntities'>> = {
  bookId: 'books',
  chapterId: 'chapters',
  currentChapterId: 'chapters',
  lastChapterId: 'chapters',
  firstChapterId: 'chapters',
  revealChapterId: 'chapters',
  duplicateWith: 'chapters',
  volumeId: 'volumes',
  groupId: 'groups',
  runId: 'runs',
  workflowRunId: 'runs',
  taskId: 'tasks',
  activeTaskId: 'tasks',
  latestBookTaskId: 'tasks',
  latestStepTaskId: 'tasks',
}
const ID_LIST_FIELDS: Record<string, Exclude<keyof IdRemap, 'referenceEntities'>> = {
  chapterIds: 'chapters',
  relatedChapterIds: 'chapters',
}

const mapIdValue = (map: Map<number, number>, value: unknown): unknown => {
  if (value === null || value === undefined || value === '') return value
  if (typeof value !== 'number' && typeof value !== 'string') return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  const next = map.get(numeric)
  if (next === undefined) return value
  return typeof value === 'string' ? String(next) : next
}

const remapJsonString = (text: string, remap: IdRemap) => {
  try {
    return JSON.stringify(remapIdFields(JSON.parse(text), remap))
  } catch {
    return text
  }
}

/** 深度遍历，把已知关联字段按映射表换号；不认识的字段原样保留 */
export const remapIdFields = (value: unknown, remap: IdRemap): unknown => {
  if (Array.isArray(value)) return value.map(item => remapIdFields(item, remap))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key in ID_FIELDS) out[key] = mapIdValue(remap[ID_FIELDS[key]], item)
    else if (key in ID_LIST_FIELDS && Array.isArray(item)) out[key] = item.map(entry => mapIdValue(remap[ID_LIST_FIELDS[key]], entry))
    // 工作流建书把 { workflowRunId } 以 JSON 字符串写在书的 globalInstruction 里
    else if (key === 'globalInstruction' && typeof item === 'string') out[key] = remapJsonString(item, remap)
    else out[key] = remapIdFields(item, remap)
  }
  return out
}

const prefixedId = (key: string | number, prefix: string) => {
  const text = String(key)
  if (!text.startsWith(prefix)) return null
  const numeric = Number(text.slice(prefix.length))
  return Number.isFinite(numeric) ? numeric : null
}

/**
 * 给与本机冲突的工作流 run / task、对话会话与生图记录换新号。
 * 与作品 id 的规则一致：只换冲突的，不冲突的保留原号。
 */
export const planIdbIdRemap = (
  backup: Record<string, IdbRecord[] | undefined>,
  currentKeys: Record<string, Set<string> | undefined>,
  allocate: () => number,
  remap: IdRemap
): IdRemap => {
  for (const record of backup.reference || []) {
    if (!isPlainObject(record.value)) continue
    const entities = new Map<number,number>()
    for (const value of Object.values(record.value)) {
      if (!Array.isArray(value)) continue
      for (const entity of value) if (isPlainObject(entity) && Number.isSafeInteger(Number(entity.id)) && Number(entity.id) !== 0) entities.set(Number(entity.id),allocate())
    }
    remap.referenceEntities.set(String(record.key),entities)
  }
  const workflowKeys = currentKeys.workflow || new Set<string>()
  for (const record of backup.workflow || []) {
    const key = String(record.key)
    if (!workflowKeys.has(key)) continue
    const runId = prefixedId(key, 'run:')
    if (runId !== null) remap.runs.set(runId, allocate())
    const taskId = prefixedId(key, 'task:')
    if (taskId !== null) remap.tasks.set(taskId, allocate())
  }
  const chatKeys = currentKeys.chat || new Set<string>()
  for (const record of backup.chat || []) {
    if (String(record.key).startsWith('sessions:') && Array.isArray(record.value)) {
      for (const session of record.value) if (isPlainObject(session) && chatKeys.has(`messages:${session.id}`)) remap.chatSessions.set(Number(session.id), allocate())
    }
  }
  for (const record of backup.chat || []) {
    const sessionId = prefixedId(record.key, 'messages:')
    if (sessionId !== null && chatKeys.has(String(record.key)) && !remap.chatSessions.has(sessionId)) remap.chatSessions.set(sessionId, allocate())
  }
  const imageKeys = currentKeys['ai-images'] || new Set<string>()
  const imageRecords = backup['ai-images'] || []
  const reservedImages = new Set([...imageKeys, ...imageRecords.map(record => String(record.key))])
  for (const record of imageRecords) {
    if (!imageKeys.has(String(record.key))) continue
    let next: number
    do { next = allocate() } while (reservedImages.has(String(next)))
    reservedImages.add(String(next))
    remap.images.set(Number(record.key), next)
  }
  return remap
}

const remapPrefixedKey = (key: string | number, prefix: string, map: Map<number, number>) => {
  const id = prefixedId(key, prefix)
  if (id === null) return { key, id: null }
  const next = map.get(id) ?? id
  return { key: `${prefix}${next}`, id: next }
}

/** 合并模式：按库把键与记录里的关联 id 换号 */
export const remapIdbRecords = (name: string, records: IdbRecord[], remap: IdRemap): IdbRecord[] => {
  if (name === 'ai-images') {
    return records.map(record => ({
      key: mapIdValue(remap.images, record.key) as string | number,
      value: isPlainObject(record.value)
        ? {
            ...record.value,
            id: mapIdValue(remap.images, record.value.id),
            bookId: mapIdValue(remap.books, record.value.bookId),
          }
        : record.value,
    }))
  }
  if (name === 'reference') {
    return records.map(record => {
      const ids = remap.referenceEntities.get(String(record.key)) || new Map<number,number>()
      const scalar = new Set(['id','parentId','groupId','fromId','toId','storylineId','fromNodeId','toNodeId','fromStorylineId','toStorylineId','storylineNodeId','timelineEventId'])
      const lists = new Set(['characterIds','settingIds','relatedEventIds','predecessorNodeIds','successorNodeIds','keyCharacterIds'])
      const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk)
        if (!isPlainObject(value)) return value
        return Object.fromEntries(Object.entries(value).map(([key,item])=>{
          if (scalar.has(key)) return [key,mapIdValue(ids,item)]
          if (lists.has(key) && Array.isArray(item)) return [key,item.map(id=>mapIdValue(ids,id))]
          if (key === 'characterCanvasPositions' && isPlainObject(item)) return [key,Object.fromEntries(Object.entries(item).map(([id,position])=>[String(mapIdValue(ids,id)),position]))]
          return [key,walk(item)]
        }))
      }
      return {key:String(mapIdValue(remap.books,String(record.key))),value:remapIdFields(walk(record.value),remap)}
    })
  }
  if (name === 'workflow') {
    return records.map(record => {
      const run = remapPrefixedKey(record.key, 'run:', remap.runs)
      const task = run.id === null ? remapPrefixedKey(record.key, 'task:', remap.tasks) : null
      const hit = run.id !== null ? run : task && task.id !== null ? task : null
      const value = remapIdFields(record.value, remap)
      if (!hit) return { key: record.key, value }
      return { key: hit.key, value: isPlainObject(value) ? { ...value, id: hit.id } : value }
    })
  }
  if (name === 'chat') {
    return records.map(record => {
      const key = String(record.key)
      if (key.startsWith('sessions:')) {
        const bookId = key.slice('sessions:'.length)
        const sessions = Array.isArray(record.value) ? record.value : []
        return {
          key: `sessions:${mapIdValue(remap.books, bookId)}`,
          value: sessions.map(session => {
            const next = remapIdFields(session, remap)
            return isPlainObject(next) ? { ...next, id: mapIdValue(remap.chatSessions, next.id) } : next
          }),
        }
      }
      if (key.startsWith('messages:')) {
        return { key: remapPrefixedKey(key, 'messages:', remap.chatSessions).key, value: record.value }
      }
      return record
    })
  }
  return records
}

/**
 * 合并模式：算出最终要写入的记录。
 * put 类整体写入；对话的会话列表与本机同键时按会话 id 并集，本机在前；add-missing 类只留本机没有的键。
 */
export const mergeIdbRecords = (spec: IdbStoreSpec, backup: IdbRecord[], current: IdbRecord[]): IdbRecord[] => {
  const currentByKey = new Map(current.map(record => [String(record.key), record.value]))
  if (spec.name === 'reference' && backup.some(record=>currentByKey.has(String(record.key)))) throw new Error('参考资料编号冲突，未覆盖本机资料')
  if (spec.merge === 'add-missing') return backup.filter(record => !currentByKey.has(String(record.key)))
  if (spec.name !== 'chat') return backup
  return backup.map(record => {
    const key = String(record.key)
    if (!key.startsWith('sessions:') || !currentByKey.has(key)) return record
    const mine = currentByKey.get(key)
    const mineList = Array.isArray(mine) ? mine : []
    const known = new Set(mineList.map(session => String((session as { id?: unknown })?.id)))
    const incoming = (Array.isArray(record.value) ? record.value : []).filter(
      session => !known.has(String((session as { id?: unknown })?.id))
    )
    return { key, value: [...mineList, ...incoming] }
  })
}

// ---------------------------------------------------------------------------
// IndexedDB 读写
// ---------------------------------------------------------------------------

const openStoreDb = (spec: IdbStoreSpec): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(spec.db, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(spec.store)) {
        db.createObjectStore(spec.store, spec.keyPath ? { keyPath: spec.keyPath } : undefined)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const withStore = async <T>(
  spec: IdbStoreSpec,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void
): Promise<T> => {
  const db = await openStoreDb(spec)
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(spec.store, mode)
      let result: T
      let settled = false
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error || new Error(`${spec.label}读写失败`))
      tx.onabort = () => reject(tx.error || new Error(`${spec.label}事务中止`))
      try {
        run(
          tx.objectStore(spec.store),
          value => {
            if (!settled) {
              settled = true
              result = value
            }
          },
          error => {
            if (!settled) {
              settled = true
              reject(error)
              try { tx.abort() } catch { /* 已中止 */ }
            }
          }
        )
      } catch (error) {
        reject(error)
        try { tx.abort() } catch { /* 已中止 */ }
      }
    })
  } finally {
    db.close()
  }
}

const toKey = (key: IDBValidKey): string | number => (typeof key === 'number' ? key : String(key))

export const dumpIdbStore = (spec: IdbStoreSpec): Promise<IdbRecord[]> => usesUnifiedStorage()
  ? readDesktopRecords(`${spec.db}/${spec.store}`).then(records => Promise.all(records.map(async record => ({key:record.key,value:await decodeDesktopValue(JSON.parse(record.value))}))))
  : withStore<IdbRecord[]>(spec, 'readonly', (store, done, fail) => {
    const records: IdbRecord[] = []
    const request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        done(records)
        return
      }
      records.push({ key: toKey(cursor.key), value: cursor.value })
      cursor.continue()
    }
    request.onerror = () => fail(request.error)
  })

export const listIdbKeys = (spec: IdbStoreSpec): Promise<Set<string>> => usesUnifiedStorage()
  ? readDesktopRecords(`${spec.db}/${spec.store}`).then(records => new Set(records.map(record => String(record.key))))
  : withStore<Set<string>>(spec, 'readonly', (store, done, fail) => {
    const request = store.getAllKeys()
    request.onsuccess = () => done(new Set(request.result.map(key => String(key))))
    request.onerror = () => fail(request.error)
  })

/** replace：先清空再整库写入；否则只写给定记录（键已由合并逻辑决定） */
export const restoreIdbStore = async (spec: IdbStoreSpec, records: IdbRecord[], options: { replace: boolean }) => {
  if (usesUnifiedStorage()) {
    const namespace = `${spec.db}/${spec.store}`
    await writeDesktopRecords(namespace, await encodeRecords(namespace, records), options.replace)
    return records.length
  }
  return withStore<number>(spec, 'readwrite', (store, done) => {
    if (options.replace) store.clear()
    for (const record of records) {
      if (spec.keyPath) store.put(record.value)
      else store.put(record.value, record.key)
    }
    done(records.length)
  })

}
