import { trackStorageWrite } from './storage-maintenance'
import { usesUnifiedStorage } from './storage-mode'

export interface PersistedRecord {
  key: string | number
  value: string
}
export interface PersistedStore {
  namespace: string
  records: PersistedRecord[]
}
interface AssetRef {
  __ewAsset: string
  sha256: string
  size: number
  kind: 'blob' | 'buffer' | 'data-url'
  mime: string
}
export const desktopInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args)

const mimeExtension = (mime: string) =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/woff': 'woff',
    'font/woff2': 'woff2'
  })[mime] || 'bin'
/** Parse without writing files, so backup validation uses exactly the import codec. */
export function decodeImageDataUrl(value: string): Blob {
  const match = value.match(/^data:(image\/[^;,]+)(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('图片数据格式无效，原数据保留')
  const bytes = match[2]
    ? Uint8Array.from(atob(match[3]), ch => ch.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(match[3]))
  if (!bytes.length) throw new Error('图片数据为空，原数据保留')
  return new Blob([bytes], { type: match[1] })
}

export async function encodeDesktopValue(value: unknown, namespace: string): Promise<unknown> {
  if (value instanceof Blob || value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value)
    const signature = String.fromCharCode(...bytes.slice(0, 4))
    const mime =
      value instanceof Blob
        ? value.type
        : namespace.includes('font')
          ? { OTTO: 'font/otf', wOFF: 'font/woff', wOF2: 'font/woff2' }[signature] || 'font/ttf'
          : 'application/octet-stream'
    const { invoke } = await import('@tauri-apps/api/core')
    const asset = await invoke<Omit<AssetRef, 'kind' | 'mime'>>('desktop_asset_write', bytes, {
      headers: {
        'x-ew-kind': namespace.includes('font') ? 'fonts' : 'images',
        'x-ew-extension': mimeExtension(mime)
      }
    })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const expected = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
    if (asset.sha256 !== expected || asset.size !== bytes.byteLength)
      throw new Error('附件迁移字节校验失败，原数据保留')
    return { ...asset, kind: value instanceof Blob ? 'blob' : 'buffer', mime }
  }
  // Custom backgrounds used to be base64 strings in IndexedDB. Keep the public API unchanged.
  if (
    ['ew-skin-store/kv', 'book-cover'].includes(namespace) &&
    typeof value === 'string' &&
    value.startsWith('data:image/')
  ) {
    const encoded = (await encodeDesktopValue(decodeImageDataUrl(value), namespace)) as AssetRef
    return { ...encoded, kind: 'data-url' }
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => encodeDesktopValue(item, namespace)))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) next[key] = await encodeDesktopValue(item, namespace)
    return next
  }
  return value
}
export interface DecodeOptions {
  /**
   * 附件读不到（文件缺失、校验失败）时的处理：返回值替代该字段。
   * 不提供则抛错。列表类读取用它做按记录容错，避免一个坏文件让整个功能不可用。
   */
  onAssetError?: (asset: { path: string; sha256: string }, error: unknown) => unknown
}

const reportedAssets = new Set<string>()
/** 容错模式的默认处理：同一附件只告警一次，字段按缺失（null）处理 */
export const missingAssetAsNull: NonNullable<DecodeOptions['onAssetError']> = (asset, error) => {
  if (!reportedAssets.has(asset.path)) {
    reportedAssets.add(asset.path)
    console.warn(`附件读取失败，已按缺失处理：${asset.path}`, error)
  }
  return null
}

export async function decodeDesktopValue(value: unknown, options: DecodeOptions = {}): Promise<unknown> {
  if (value && typeof value === 'object' && '__ewAsset' in value) {
    const asset = value as AssetRef
    let raw: ArrayBuffer | number[]
    try {
      raw = await desktopInvoke<ArrayBuffer | number[]>('desktop_asset_read', {
        path: asset.__ewAsset,
        sha256: asset.sha256
      })
    } catch (error) {
      if (options.onAssetError) return options.onAssetError({ path: asset.__ewAsset, sha256: asset.sha256 }, error)
      throw error
    }
    const buffer = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer
    if (asset.kind === 'buffer') return buffer
    const blob = new Blob([buffer], { type: asset.mime })
    if (asset.kind === 'data-url')
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    return blob
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => decodeDesktopValue(item, options)))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) next[key] = await decodeDesktopValue(item, options)
    return next
  }
  return value
}
export async function encodeRecords(
  namespace: string,
  records: Array<{ key: string | number; value: unknown }>,
  onProgress?: (completed: number, total: number) => void
): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = []
  for (const record of records) {
    out.push({ key: record.key, value: JSON.stringify(await encodeDesktopValue(record.value, namespace)) })
    onProgress?.(out.length, records.length)
  }
  return out
}
export const readDesktopRecords = (namespace: string) =>
  desktopInvoke<PersistedRecord[]>('desktop_store_read', { namespace })
export const writeDesktopRecords = (
  namespace: string,
  records: PersistedRecord[],
  replace = false,
  remove: Array<string | number> = []
) =>
  trackStorageWrite(() => desktopInvoke<void>('desktop_store_write', { namespace, records, replace, remove }))

interface RecordActions {
  get(key: IDBValidKey): Promise<unknown>
  getAll(): Promise<unknown[]>
  getAllKeys(): Promise<IDBValidKey[]>
  put(value: unknown, key?: IDBValidKey): Promise<IDBValidKey>
  delete(key: IDBValidKey): Promise<void>
}
export interface RecordStoreOptions {
  /** 读取时附件缺失按 null 处理而不是整批失败（生图历史这类"一条坏了不该拖垮列表"的场景） */
  tolerateMissingAssets?: boolean
}
/** The selected storage mode commits before resolving. */
async function runRecordStore<T>(
  dbName: string,
  storeName: string,
  keyPath: string | undefined,
  mode: IDBTransactionMode,
  run: (store: RecordActions) => Promise<unknown>,
  options: RecordStoreOptions = {}
): Promise<T> {
  const namespace = `${dbName}/${storeName}`
  if (usesUnifiedStorage()) {
    const keyOf = (key: IDBValidKey | undefined): string | number => {
      if (typeof key !== 'string' && typeof key !== 'number')
        throw new Error('本地记录标识必须为字符串或数字')
      return key
    }
    const decode = (raw: string) =>
      decodeDesktopValue(JSON.parse(raw), options.tolerateMissingAssets ? { onAssetError: missingAssetAsNull } : {})
    const actions: RecordActions = {
      get: async key => {
        const raw = await desktopInvoke<string | null>('desktop_store_get', { namespace, key: keyOf(key) })
        return raw == null ? undefined : decode(raw)
      },
      getAll: async () => Promise.all((await readDesktopRecords(namespace)).map(record => decode(record.value))),
      getAllKeys: async () => (await readDesktopRecords(namespace)).map(record => record.key),
      put: async (value, key) => {
        const actual = keyOf(keyPath ? (value as Record<string, IDBValidKey>)[keyPath] : key)
        await writeDesktopRecords(namespace, await encodeRecords(namespace, [{ key: actual, value }]))
        return actual
      },
      delete: async key => writeDesktopRecords(namespace, [], false, [keyOf(key)])
    }
    return (await run(actions)) as T
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(storeName))
        req.result.createObjectStore(storeName, keyPath ? { keyPath } : undefined)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || new Error('本地数据事务中止'))
      tx.onerror = () => reject(tx.error || new Error('本地数据事务失败'))
    })
    // Attach a rejection handler immediately; run() can reject before we await completion.
    void completed.catch(() => undefined)
    const request = <R>(req: IDBRequest<R>) =>
      new Promise<R>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    const value = await run({
      get: key => request(store.get(key)),
      getAll: () => request(store.getAll()),
      getAllKeys: () => request(store.getAllKeys()),
      put: (value, key) => request(keyPath ? store.put(value) : store.put(value, key)),
      delete: key => request(store.delete(key))
    })
    await completed
    return value as T
  } finally {
    db.close()
  }
}

/** Track the whole operation, including its read/modify/write portion, before maintenance starts. */
export function withRecordStore<T>(
  dbName: string, storeName: string, keyPath: string | undefined, mode: IDBTransactionMode,
  run: (store: RecordActions) => Promise<unknown>, options: RecordStoreOptions = {}
): Promise<T> {
  const execute = () => runRecordStore<T>(dbName, storeName, keyPath, mode, run, options)
  return mode === 'readwrite' ? trackStorageWrite(execute) : execute()
}

const mutationQueues = new Map<string, Promise<unknown>>()
/** Serialize this view locally; SQLite compare-and-write also protects against other webviews. */
export async function mutateDesktopRecord<T>(
  namespace: string,
  key: string,
  fn: (value: unknown) => { value: unknown; result: T }
): Promise<T> {
  const queueKey = `${namespace}:${key}`
  const next = (mutationQueues.get(queueKey) || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await desktopInvoke<string | null>('desktop_store_get', { namespace, key })
        const changed = fn(raw == null ? null : JSON.parse(raw))
        const [record] = await encodeRecords(namespace, [{ key, value: changed.value }])
        const saved = await trackStorageWrite(() => desktopInvoke<boolean>('desktop_store_compare_write', {
          namespace, key, expected: raw, value: record.value,
        }))
        if (saved) return changed.result
      }
      throw new Error('资料已在另一个窗口更新，请重试保存；未覆盖已有内容')
    })
  mutationQueues.set(queueKey, next)
  try {
    return await next
  } finally {
    if (mutationQueues.get(queueKey) === next) mutationQueues.delete(queueKey)
  }
}
