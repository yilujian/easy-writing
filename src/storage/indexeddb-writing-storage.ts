import { countTextWords } from '@/utils/word-count'
import { recordWriteJournal } from './write-journal'
import {
  assertChapterWriteBack,
  buildBookWordCountKey,
  buildChapterStorageKey,
  countDraftWords,
  cloneStorageJson,
  createChapterVersionId,
  LocalChapterWriteVerifyError,
  normalizeLocalWritingSettings,
  normalizeLocalChapterDraft,
  type LocalWritingSettings,
  type LocalChapterDraft,
  type StoredChapterVersion,
  type StoredLocalChapterDraft,
  type WritingStorage,
} from './writing-storage'

const DB_NAME = 'ew-writing-local'
const DB_VERSION = 1
const STORE_CHAPTERS = 'chapter_contents'
const STORE_VERSIONS = 'chapter_versions'
const STORE_SETTINGS = 'sync_settings'
const LOCAL_SETTINGS_KEY = 'localWritingSettings'

type StoreName =
  | typeof STORE_CHAPTERS
  | typeof STORE_VERSIONS
  | typeof STORE_SETTINGS

const requestToPromise = <T>(request: IDBRequest<T>) => {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const transactionDone = (transaction: IDBTransaction) => {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export class IndexedDbWritingStorage implements WritingStorage {
  private dbPromise: Promise<IDBDatabase> | null = null

  private getDb() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('当前环境不支持 IndexedDB'))
          return
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
            const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'storageKey' })
            store.createIndex('chapterId', 'chapterId', { unique: false })
            store.createIndex('userBookChapter', ['userId', 'bookId', 'chapterId'], { unique: true })
            store.createIndex('dirty', 'dirty', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
            const store = db.createObjectStore(STORE_VERSIONS, { keyPath: 'id' })
            store.createIndex('chapterId', 'chapterId', { unique: false })
            store.createIndex('createdAt', 'createdAt', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
            db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return this.dbPromise
  }

  private async store<T extends StoreName>(name: T, mode: IDBTransactionMode) {
    const db = await this.getDb()
    const transaction = db.transaction(name, mode)
    return {
      objectStore: transaction.objectStore(name),
      transaction,
    }
  }

  async getChapter(chapterId: number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const index = objectStore.index('chapterId')
    return await requestToPromise<StoredLocalChapterDraft | undefined>(index.get(Number(chapterId))) ?? null
  }

  async getChapterByIdentity(userId: string, bookId: string | number, chapterId: number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const key = buildChapterStorageKey(userId, bookId, chapterId)
    return await requestToPromise<StoredLocalChapterDraft | undefined>(objectStore.get(key)) ?? null
  }

  async saveChapterLocal(payload: LocalChapterDraft) {
    const normalized = normalizeLocalChapterDraft(payload)
    const current = await this.getChapterByIdentity(normalized.userId, normalized.bookId, normalized.chapterId)
    const record: StoredLocalChapterDraft = {
      ...normalized,
      storageKey: buildChapterStorageKey(normalized.userId, normalized.bookId, normalized.chapterId),
      localVersion: Number(current?.localVersion || normalized.localVersion || 0) + 1,
      updatedAt: normalized.updatedAt || Date.now(),
      // 与 SQLite 实现同语义：覆盖写入不丢备份标记（详见 sqlite-writing-storage）
      lastBackedUpAt: normalized.lastBackedUpAt ?? Number(current?.lastBackedUpAt || 0) ?? 0,
    }
    const { objectStore, transaction } = await this.store(STORE_CHAPTERS, 'readwrite')
    objectStore.put(record)
    await transactionDone(transaction)
    await this.verifyWriteBack(record)
    return record
  }

  async listChapterVersions(userId: string, bookId: string | number, chapterId: number) {
    const { objectStore } = await this.store(STORE_VERSIONS, 'readonly')
    const index = objectStore.index('chapterId')
    const rows = await requestToPromise<StoredChapterVersion[]>(index.getAll(Number(chapterId)))
    return (rows || [])
      .filter(
        item =>
          String(item.userId) === String(userId) &&
          String(item.bookId) === String(bookId)
      )
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
  }

  async pruneChapterVersions(
    userId: string,
    bookId: string | number,
    chapterId: number,
    keep: number
  ) {
    const versions = await this.listChapterVersions(userId, bookId, chapterId)
    const expired = versions.slice(Math.max(1, keep))
    if (!expired.length) return
    const { objectStore, transaction } = await this.store(STORE_VERSIONS, 'readwrite')
    expired.forEach(item => objectStore.delete(item.id))
    await transactionDone(transaction)
  }

  async purgeBookDrafts(bookId: string | number) {
    // storageKey = userId:bookId:chapterId；按中段书号匹配，不分归属账号一并清掉
    const matchesBook = (key: IDBValidKey) => String(key).split(':')[1] === String(bookId)
    for (const storeName of [STORE_CHAPTERS] as const) {
      const { objectStore, transaction } = await this.store(storeName, 'readwrite')
      const keys = await requestToPromise<IDBValidKey[]>(objectStore.getAllKeys())
      keys.filter(matchesBook).forEach(key => objectStore.delete(key))
      await transactionDone(transaction)
    }
    const { objectStore, transaction } = await this.store(STORE_VERSIONS, 'readwrite')
    const versions = await requestToPromise<StoredChapterVersion[]>(objectStore.getAll())
    versions
      .filter(item => String(item.bookId) === String(bookId))
      .forEach(item => objectStore.delete(item.id))
    await transactionDone(transaction)
  }

  async listChapterWordCounts(userId: string, bookId?: string | number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const rows = await requestToPromise<StoredLocalChapterDraft[]>(objectStore.getAll())
    const scopedBookId = bookId === undefined || bookId === null ? '' : String(bookId)
    return (rows || [])
      .filter(row => String(row.userId) === String(userId))
      .filter(row => !scopedBookId || String(row.bookId) === scopedBookId)
      .map(row => ({
        bookId: String(row.bookId),
        chapterId: Number(row.chapterId),
        wordCount: countDraftWords(row.textContent),
        textWordCount: countTextWords(row.textContent),
        dirty: Boolean(row.dirty),
      }))
  }

  async getBookWordCounts(userId: string) {
    const { objectStore } = await this.store(STORE_SETTINGS, 'readonly')
    const record = await requestToPromise<{ key: string; value: Record<string, number> } | undefined>(
      objectStore.get(buildBookWordCountKey(userId))
    )
    const value = record?.value
    return value && typeof value === 'object' ? value : {}
  }

  async setBookWordCount(userId: string, bookId: string | number, wordCount: number) {
    const next = {
      ...(await this.getBookWordCounts(userId)),
      [String(bookId)]: Number(wordCount || 0),
    }
    const { objectStore, transaction } = await this.store(STORE_SETTINGS, 'readwrite')
    objectStore.put({ key: buildBookWordCountKey(userId), value: next })
    await transactionDone(transaction)
  }

  /** 写后回读校验：写入返回成功不代表数据落到了目标库，必须自己确认一次 */
  private async verifyWriteBack(record: StoredLocalChapterDraft) {
    try {
      await assertChapterWriteBack(record, () =>
        this.getChapterByIdentity(record.userId, record.bookId, record.chapterId)
      )
    } catch (error) {
      recordWriteJournal({
        at: Date.now(),
        backend: 'indexeddb',
        storageKey: record.storageKey,
        chars: String(record.textContent || '').length,
        ok: false,
        reason: (error as LocalChapterWriteVerifyError)?.reason || 'unknown',
      })
      throw error
    }
    recordWriteJournal({
      at: Date.now(),
      backend: 'indexeddb',
      storageKey: record.storageKey,
      chars: String(record.textContent || '').length,
      ok: true,
    })
  }

  async saveChapterVersion(payload: Omit<StoredChapterVersion, 'id' | 'createdAt'> & { createdAt?: number }) {
    const timestamp = payload.createdAt || Date.now()
    const record: StoredChapterVersion = {
      ...payload,
      id: createChapterVersionId(payload.userId, payload.bookId, payload.chapterId, payload.source, timestamp),
      userId: String(payload.userId),
      bookId: String(payload.bookId),
      chapterId: Number(payload.chapterId),
      title: String(payload.title || ''),
      textContent: String(payload.textContent || ''),
      contentJson: cloneStorageJson(payload.contentJson),
      remoteVersion: Number(payload.remoteVersion || 0),
      remark: String(payload.remark || ''),
      createdAt: timestamp,
    }
    const { objectStore, transaction } = await this.store(STORE_VERSIONS, 'readwrite')
    objectStore.put(record)
    await transactionDone(transaction)
  }

  async listLocalChaptersForBackup(userId?: string, bookId?: string | number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const records = await requestToPromise<StoredLocalChapterDraft[]>(objectStore.getAll())
    const normalizedUserId = userId === undefined || userId === null || String(userId) === ''
      ? ''
      : String(userId)
    const normalizedBookId = bookId === undefined || bookId === null || String(bookId) === ''
      ? ''
      : String(bookId)
    return records
      .filter(item => !normalizedUserId || String(item.userId) === normalizedUserId)
      .filter(item => !normalizedBookId || String(item.bookId) === normalizedBookId)
      .filter(item => {
        const lastBackedUpAt = Number(item.lastBackedUpAt || 0)
        const updatedAt = Number(item.updatedAt || 0)
        const needsAttention = Boolean(item.dirty || item.localOnly || item.conflict || updatedAt > lastBackedUpAt)
        return needsAttention && (!lastBackedUpAt || updatedAt > lastBackedUpAt)
      })
      .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
  }

  async markChapterBackedUp(userId: string, bookId: string | number, chapterId: number, backupAt: number) {
    const current = await this.getChapterByIdentity(userId, bookId, chapterId)
    if (!current) return
    const { objectStore, transaction } = await this.store(STORE_CHAPTERS, 'readwrite')
    objectStore.put({
      ...current,
      lastBackedUpAt: Number(backupAt || Date.now()),
    })
    await transactionDone(transaction)
  }

  async getLocalWritingSettings() {
    const { objectStore } = await this.store(STORE_SETTINGS, 'readonly')
    const settingsRecord = await requestToPromise<{ key: string; value: Partial<LocalWritingSettings> } | undefined>(
      objectStore.get(LOCAL_SETTINGS_KEY)
    )
    return normalizeLocalWritingSettings(settingsRecord?.value || {})
  }

  async setLocalWritingSettings(settings: Partial<LocalWritingSettings>) {
    const current = await this.getLocalWritingSettings()
    const next = normalizeLocalWritingSettings({ ...current, ...settings })
    const { objectStore, transaction } = await this.store(STORE_SETTINGS, 'readwrite')
    objectStore.put({ key: LOCAL_SETTINGS_KEY, value: next })
    await transactionDone(transaction)
    return next
  }
}
