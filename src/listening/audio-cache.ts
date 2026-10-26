/**
 * 云端朗读音频缓存。
 *
 * 这是唯一一处刻意不走 unified storage 的用户数据：音频 Blob 体积大、可随时重建，
 * 放进 SQLite 会拖慢备份和启动。缓存独立放 IndexedDB，不进入 full_backup 的
 * IDB_STORES，设置中心提供占用统计与清理。
 */

const DB_NAME = 'ew-listening-audio'
const STORE_NAME = 'segments'
const DB_VERSION = 1
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
let cacheEpoch = 0

interface AudioCacheRecord {
  key: string
  blob: Blob
  bytes: number
  createdAt: number
  lastAccessAt: number
}

const openDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开朗读缓存失败'))
  })
}

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | null> => {
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      let request: IDBRequest<T> | void
      try {
        request = run(store)
      } catch (error) {
        reject(error)
        return
      }
      tx.oncomplete = () => resolve(request && 'result' in request ? request.result : null)
      tx.onerror = () => reject(tx.error || new Error('朗读缓存事务失败'))
      tx.onabort = () => reject(tx.error || new Error('朗读缓存事务中止'))
    })
  } finally {
    db.close()
  }
}

const fallbackHash = (text: string) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `djb2-${(hash >>> 0).toString(16)}-${text.length}`
}

/** 缓存键：模型、音色、格式、语速、文本任一变化都不应命中旧音频 */
export const buildAudioCacheKey = async (parts: Array<string | number>): Promise<string> => {
  const text = parts.map(part => String(part)).join('|')
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined
  if (subtle?.digest) {
    try {
      const buffer = await subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(buffer))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      // WebView 的安全上下文判断有差异，退化到同步哈希
    }
  }
  return fallbackHash(text)
}

export const getCachedAudio = async (key: string): Promise<Blob | null> => {
  // 读取与 LRU 触摸放在同一读写事务，避免“清理后旧触摸又把记录写回来”。
  const db = await openDb()
  if (!db) return null
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key) as IDBRequest<AudioCacheRecord>
      let blob: Blob | null = null
      request.onsuccess = () => {
        const record = request.result
        if (!record?.blob) return
        blob = record.blob
        store.put({ ...record, lastAccessAt: Date.now() })
      }
      tx.oncomplete = () => resolve(blob)
      tx.onerror = () => reject(tx.error || new Error('读取朗读缓存失败'))
      tx.onabort = () => reject(tx.error || new Error('读取朗读缓存事务中止'))
    })
  } finally {
    db.close()
  }
}

const pruneCache = async (maxBytes = DEFAULT_MAX_BYTES) => {
  const records = await withStore<AudioCacheRecord[]>('readonly', store => store.getAll())
  if (!records?.length) return
  const total = records.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
  if (total <= maxBytes) return
  const doomed = [...records].sort((a, b) => Number(a.lastAccessAt) - Number(b.lastAccessAt))
  let remaining = total
  for (const item of doomed) {
    if (remaining <= maxBytes) break
    await withStore('readwrite', store => {
      store.delete(item.key)
      return undefined
    })
    remaining -= Number(item.bytes) || 0
  }
}

export const getAudioCacheEpoch = () => cacheEpoch

export const putCachedAudio = async (key: string, blob: Blob, expectedEpoch = cacheEpoch) => {
  if (!blob.size || expectedEpoch !== cacheEpoch) return
  await withStore('readwrite', store => {
    // 清理发生在合成期间时，不允许旧请求在清理完成后重新写回。
    if (expectedEpoch !== cacheEpoch) return undefined
    store.put({
      key,
      blob,
      bytes: blob.size,
      createdAt: Date.now(),
      lastAccessAt: Date.now()
    } satisfies AudioCacheRecord)
    return undefined
  })
  await pruneCache()
}

export const getAudioCacheStats = async (): Promise<{ count: number; bytes: number }> => {
  const records = await withStore<AudioCacheRecord[]>('readonly', store => store.getAll())
  return (records || []).reduce(
    (stats, item) => ({
      count: stats.count + 1,
      bytes: stats.bytes + (Number(item.bytes) || 0)
    }),
    { count: 0, bytes: 0 }
  )
}

export const clearAudioCache = async () => {
  cacheEpoch += 1
  await withStore('readwrite', store => {
    store.clear()
    return undefined
  })
}

export const formatAudioCacheBytes = (bytes: number) => {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
