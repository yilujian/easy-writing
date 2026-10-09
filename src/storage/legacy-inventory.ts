import { STORAGE_MODE_KEY } from './storage-mode'
import specification from './migrations/desktop-v1.json'
import { desktopInvoke, type PersistedRecord } from './desktop-records'

export interface LegacyRecord {
  key: string | number
  value: unknown
}
export interface SourceManifest {
  migrationId: string
  fromVersion: number
  targetVersion: number
  sources: Record<string, { count: number; digest: string }>
}
export interface LegacySnapshot {
  records: Map<string, LegacyRecord[]>
  manifest: SourceManifest
  /** 清点时跳过的内容（未登记的库、未识别的表、缺失的表）；数据都原样留在 IndexedDB 里 */
  warnings: string[]
}

type Warn = (message: string) => void

/**
 * Read existing databases without creating missing ones or downgrading a newer schema.
 *
 * 结构上的意外（未识别的表、缺少的表）只记录提示并跳过，不能让应用永远打不开：
 * 旧数据一律不删，用户随时可以回到旧版本或人工处理。真正的读取失败（被占用、
 * 打不开、版本高于当前支持）仍然报错，因为那时既不能确认数据，也不该假装它不存在。
 */
export function readLegacyStore(
  dbName: string,
  storeName: string,
  warn: Warn = () => undefined
): Promise<LegacyRecord[]> {
  return new Promise((resolve, reject) => {
    let missing = false
    let settled = false
    let db: IDBDatabase | undefined
    const timer = window.setTimeout(() => finish(new Error(`读取旧数据超时：${dbName}/${storeName}`)), 20000)
    const finish = (error?: unknown, rows: LegacyRecord[] = []) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      db?.close()
      if (error) reject(error)
      else resolve(rows)
    }
    const request = indexedDB.open(dbName)
    request.onupgradeneeded = () => {
      missing = true
      request.transaction?.abort()
    }
    request.onerror = () =>
      finish(
        missing ? undefined : new Error(`旧数据读取失败 ${dbName}/${storeName}：${request.error?.message}`)
      )
    request.onblocked = () => finish(new Error(`旧数据被占用：${dbName}，请关闭其他窗口后重试`))
    request.onsuccess = () => {
      db = request.result
      if (settled) {
        db.close()
        return
      }
      if (db.version > specification.toVersion) {
        finish(new Error(`旧数据版本高于当前支持版本：${dbName}，请升级应用`))
        return
      }
      const knownStores = specification.stores.filter(store => store.db === dbName).map(store => store.store)
      const unknownStores = Array.from(db.objectStoreNames).filter(name => !knownStores.includes(name))
      if (unknownStores.length) {
        warn(`旧数据库 ${dbName} 含未识别的数据表（${unknownStores.join('、')}），这些表不在迁移范围内，原数据保留`)
      }
      if (!db.objectStoreNames.contains(storeName)) {
        warn(`旧数据库 ${dbName} 缺少数据表 ${storeName}，按没有旧数据处理`)
        finish(undefined, [])
        return
      }
      const tx = db.transaction(storeName, 'readonly')
      const out: LegacyRecord[] = []
      const cursor = tx.objectStore(storeName).openCursor()
      cursor.onsuccess = () => {
        if (!cursor.result || settled) return
        const { key, value } = cursor.result
        if (typeof key !== 'string' && typeof key !== 'number') {
          tx.abort()
          return
        }
        out.push({ key, value })
        cursor.result.continue()
      }
      tx.oncomplete = () => finish(undefined, out)
      tx.onabort = () => finish(new Error(`读取旧数据中止：${dbName}/${storeName}`))
      tx.onerror = () =>
        finish(tx.error || cursor.error || new Error(`读取旧数据失败：${dbName}/${storeName}`))
    }
  })
}
const sha256 = async (data: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
/** Canonical fingerprint includes binary bytes. This function performs no filesystem/database writes. */
async function canonical(value: unknown): Promise<unknown> {
  if (value instanceof Blob)
    return {
      type: 'blob',
      mime: value.type,
      size: value.size,
      digest: await sha256(await value.arrayBuffer())
    }
  if (value instanceof ArrayBuffer)
    return { type: 'buffer', size: value.byteLength, digest: await sha256(value) }
  if (Array.isArray(value)) return Promise.all(value.map(canonical))
  if (value && typeof value === 'object') {
    if (Object.prototype.toString.call(value) !== '[object Object]')
      throw new Error('旧数据包含不支持的记录类型，未修改原数据')
    const entries = []
    for (const key of Object.keys(value).sort())
      entries.push([key, await canonical((value as Record<string, unknown>)[key])])
    return Object.fromEntries(entries)
  }
  return value
}
export async function fingerprintRecords(records: LegacyRecord[]) {
  const keys = records.map(record => JSON.stringify(record.key))
  if (new Set(keys).size !== keys.length) throw new Error('旧数据记录标识重复')
  const sorted = [...records].sort((a, b) =>
    JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : JSON.stringify(a.key) > JSON.stringify(b.key) ? 1 : 0
  )
  const contents = []
  for (const record of sorted) contents.push([record.key, await canonical(record.value)])
  return {
    count: records.length,
    digest: await sha256(new TextEncoder().encode(JSON.stringify(contents)).buffer)
  }
}
export async function collectLegacySnapshot(): Promise<LegacySnapshot> {
  const warnings = new Set<string>()
  const warn: Warn = message => {
    warnings.add(message)
  }
  if (typeof indexedDB.databases === 'function') {
    const known = new Set(specification.stores.map(store => store.db))
    for (const db of await indexedDB.databases()) {
      if (db.name?.startsWith('ew-') && !known.has(db.name)) {
        warn(`检测到未登记的旧数据库 ${db.name}，不在迁移范围内，原数据保留`)
      }
    }
  }
  const records = new Map<string, LegacyRecord[]>()
  for (const store of specification.stores)
    records.set(store.namespace, await readLegacyStore(store.db, store.store, warn))
  const books = await desktopInvoke<PersistedRecord[]>('desktop_core_books')
  const fallback = records.get('legacy-core/local_books') || []
  // 这里只需读取封面；异常记录留在 SQLite，由原始数据库副本完整保留。
  // 仍以全部 SQLite 主键排除旧副本，不能用旧 IndexedDB 数据覆盖损坏的新记录。
  const sqliteBookKeys = new Set(books.map(row => String(row.key)))
  const parsedBooks: Array<{ key: string | number; value: unknown; raw: string }> = []
  for (const row of books) {
    try {
      parsedBooks.push({ key: row.key, value: JSON.parse(row.value), raw: row.value })
    } catch {
      warn(`SQLite 书籍 ${row.key} 的 JSON 损坏，已跳过封面转换，原记录保留`)
    }
  }
  const allBooks = [
    ...parsedBooks,
    ...fallback
      .filter(row => !sqliteBookKeys.has(String(row.key)))
      .map(row => ({ ...row, raw: JSON.stringify(row.value) }))
  ]
  records.set(
    specification.coverNamespace,
    allBooks
      .filter(row => {
        const book = row.value as { coverUrl?: unknown }
        return typeof book?.coverUrl === 'string' && book.coverUrl.startsWith('data:image/')
      })
      .map(row => ({ key: row.key, value: { original: row.raw, book: row.value } }))
  )
  // 字体元数据没有对应文件：这个字体本来就加载不了，跳过它，不能让迁移停下来
  const fontFiles = new Set(records.get('ew-font-store/files')!.map(row => row.key))
  const fontMetadata = records.get('ew-font-store/metadata')!
  const orphanFonts = fontMetadata.filter(row => !fontFiles.has(row.key))
  if (orphanFonts.length) {
    const names = orphanFonts.map(row => String((row.value as { name?: unknown })?.name || row.key)).join('、')
    warn(`旧字体记录缺少对应文件，已跳过：${names}`)
    records.set('ew-font-store/metadata', fontMetadata.filter(row => fontFiles.has(row.key)))
  }
  const settings: LegacyRecord[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('ew-') && key !== STORAGE_MODE_KEY) {
      const value = localStorage.getItem(key)
      if (value !== null) settings.push({ key, value })
    }
  }
  records.set(specification.settingsNamespace, settings)
  const sources: SourceManifest['sources'] = {}
  for (const [namespace, items] of records) sources[namespace] = await fingerprintRecords(items)
  return {
    records,
    manifest: {
      migrationId: specification.id,
      fromVersion: specification.fromVersion,
      targetVersion: specification.toVersion,
      sources
    },
    warnings: [...warnings]
  }
}
