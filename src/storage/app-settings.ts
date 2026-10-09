import { assertStorageWritable } from './storage-maintenance'
import { usesUnifiedStorage } from './storage-mode'
import { readDesktopRecords, writeDesktopRecords } from './desktop-records'

const values = new Map<string, string>()
const pending = new Map<string, string | null>()
let ready = false
let writer: Promise<void> | null = null
let writeError: unknown = null
export const SETTINGS_NAMESPACE = 'app-settings'
export async function initAppSettings() {
  if (!usesUnifiedStorage()) return
  const records = await readDesktopRecords(SETTINGS_NAMESPACE)
  values.clear()
  for (const record of records) {
    const value: unknown = JSON.parse(record.value)
    if (typeof value !== 'string') throw new Error(`设置格式损坏：${record.key}`)
    values.set(String(record.key), value)
  }
  ready = true
}
function assertReady() {
  if (!ready) throw new Error('桌面存储尚未完成初始化，禁止读写设置')
}
const notifyFailure = (error: unknown) => {
  window.dispatchEvent(new CustomEvent('ew-settings-save-failed', { detail: String(error) }))
}
function schedule() {
  if (writer) return
  writer = (async () => {
    while (pending.size) {
      const batch = new Map(pending)
      await writeDesktopRecords(
        SETTINGS_NAMESPACE,
        [...batch]
          .filter((item): item is [string, string] => item[1] !== null)
          .map(([key, value]) => ({ key, value: JSON.stringify(value) })),
        false,
        [...batch].filter(([, value]) => value === null).map(([key]) => key)
      )
      for (const [key, value] of batch) if (pending.get(key) === value) pending.delete(key)
    }
    writeError = null
  })()
    .catch(error => {
      writeError = error
      notifyFailure(error)
    })
    .finally(() => {
      writer = null
      if (pending.size && !writeError) schedule()
    })
}
/** Sync cache for Pinia/theme APIs; durable writes are queued, surfaced on failure and flushed before close/backup. */
export const appSettings: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> = {
  get length() {
    if (!usesUnifiedStorage()) return localStorage.length
    assertReady()
    return values.size
  },
  key(index) {
    if (!usesUnifiedStorage()) return localStorage.key(index)
    assertReady()
    return [...values.keys()][index] ?? null
  },
  getItem(key) {
    if (!usesUnifiedStorage()) return localStorage.getItem(key)
    assertReady()
    return values.get(key) ?? null
  },
  setItem(key, value) {
    assertStorageWritable()
    if (!usesUnifiedStorage()) {
      localStorage.setItem(key, value)
      return
    }
    assertStorageWritable()
    assertReady()
    values.set(key, String(value))
    pending.set(key, String(value))
    schedule()
  },
  removeItem(key) {
    assertStorageWritable()
    if (!usesUnifiedStorage()) {
      localStorage.removeItem(key)
      return
    }
    assertStorageWritable()
    assertReady()
    values.delete(key)
    pending.set(key, null)
    schedule()
  }
}
export async function flushAppSettings() {
  if (!usesUnifiedStorage()) return
  assertReady()
  if (writer) await writer
  if (pending.size) {
    schedule()
    await writer
  }
  if (writeError) throw new Error(`设置尚未保存到本地：${String(writeError)}`)
}
