import { trackIndexedDbTransaction } from './storage-maintenance'
import { validateStoredChapter } from './stored-record'
import { countTextWords } from '@/utils/word-count'
import { recordWriteJournal } from './write-journal'
import {
  assertChapterWriteBack,
  assertChapterVersion,
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
  type ChapterSaveOptions,
  type StoredChapterVersion,
  type StoredLocalChapterDraft,
  type WritingStorage,
  type WritingStorageDump,
  type ChapterReplacementBatch,
  type ChapterReplacementResult,
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
    const transaction = trackIndexedDbTransaction(db.transaction(name, mode))
    return {
      objectStore: transaction.objectStore(name),
      transaction,
    }
  }

  async getChapter(chapterId: number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const index = objectStore.index('chapterId')
    const value = await requestToPromise<StoredLocalChapterDraft | undefined>(index.get(Number(chapterId)))
    return value === undefined ? null : validateStoredChapter(value)
  }

  async getChapterByIdentity(userId: string, bookId: string | number, chapterId: number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const key = buildChapterStorageKey(userId, bookId, chapterId)
    const value = await requestToPromise<StoredLocalChapterDraft | undefined>(objectStore.get(key))
    return value === undefined ? null : validateStoredChapter(value, key)
  }

  async saveChapterLocal(payload: LocalChapterDraft, options?: ChapterSaveOptions) {
    const normalized = normalizeLocalChapterDraft(payload)
    const storageKey = buildChapterStorageKey(normalized.userId, normalized.bookId, normalized.chapterId)
    // 读取、版本比较、写入必须处于同一 readwrite 事务，跨标签页也不能插队。
    const { objectStore, transaction } = await this.store(STORE_CHAPTERS, 'readwrite')
    const done = transactionDone(transaction)
    // 事务被主动 abort 时仍由下方原始错误向调用方报告。
    void done.catch(() => undefined)
    const current = await requestToPromise<StoredLocalChapterDraft | undefined>(objectStore.get(storageKey))
    try {
      assertChapterVersion(storageKey, current, options?.expectedLocalVersion ?? Number(current?.localVersion || 0))
    } catch (error) {
      transaction.abort()
      await done.catch(() => undefined)
      throw error
    }
    const record: StoredLocalChapterDraft = {
      ...normalized,
      storageKey,
      localVersion: Number(current?.localVersion || normalized.localVersion || 0) + 1,
      updatedAt: normalized.updatedAt || Date.now(),
      // 与 SQLite 实现同语义：覆盖写入不丢备份标记（详见 sqlite-writing-storage）
      lastBackedUpAt: normalized.lastBackedUpAt ?? Number(current?.lastBackedUpAt || 0) ?? 0,
    }
    objectStore.put(record)
    await done
    await this.verifyWriteBack(record)
    return record
  }

  async listBookChapters(userId: string, bookId: string | number) {
    const { objectStore } = await this.store(STORE_CHAPTERS, 'readonly')
    const range = IDBKeyRange.bound([userId, String(bookId), -Number.MAX_SAFE_INTEGER], [userId, String(bookId), Number.MAX_SAFE_INTEGER])
    const rows = await requestToPromise<StoredLocalChapterDraft[]>(objectStore.index('userBookChapter').getAll(range))
    return rows.map(row => validateStoredChapter(row, row.storageKey))
  }

  async replaceChapters(batch: ChapterReplacementBatch): Promise<ChapterReplacementResult> {
    if (!batch.operationId || !batch.query || batch.query === batch.replacement || !batch.edits.length) throw new Error('替换请求无效')
    if (new Set(batch.edits.map(edit => edit.chapterId)).size !== batch.edits.length) throw new Error('替换章节重复')
    const { getLocalLibraryStorage } = await import('./local-library')
    const library = getLocalLibraryStorage(), book = await library.getLocalBookDetail(batch.bookId)
    if (!book || book.deletedAt) throw new Error('作品已删除，不能替换')
    if (batch.edits.some(edit => !Number.isSafeInteger(edit.count) || edit.count <= 0 || !edit.contentJson || typeof edit.contentJson !== 'object' || (edit.contentJson as { type?: string }).type !== 'doc')) throw new Error('替换正文结构无效')
    const tree = await library.getLocalBookTree(batch.bookId)
    const catalog = new Map(tree.flatMap(volume => volume.children).map(chapter => [chapter.id, chapter]))
    if (batch.edits.some(edit => !catalog.has(edit.chapterId) || catalog.get(edit.chapterId)?.workflowStatus)) throw new Error('章节已删除或处于生成/待确认状态，请重新搜索')
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(batch))))).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const db = await this.getDb()
    const transaction = trackIndexedDbTransaction(db.transaction([STORE_CHAPTERS, STORE_VERSIONS, STORE_SETTINGS], 'readwrite'))
    const done = transactionDone(transaction)
    void done.catch(() => undefined)
    const chapters = transaction.objectStore(STORE_CHAPTERS), versions = transaction.objectStore(STORE_VERSIONS), settings = transaction.objectStore(STORE_SETTINGS)
    const receiptKey = `book-replace:${batch.operationId}`
    try {
      const previous = await requestToPromise<{ value: { fingerprint: string; result: ChapterReplacementResult } } | undefined>(settings.get(receiptKey))
      if (previous) {
        if (previous.value.fingerprint !== fingerprint) throw new Error('替换确认已变化，请重新搜索')
        await done
        return previous.value.result
      }
      const stamp = Date.now(), result = { chapterIds: [] as number[], count: 0 }
      for (const edit of batch.edits) {
        const key = buildChapterStorageKey('guest', batch.bookId, edit.chapterId)
        const current = await requestToPromise<StoredLocalChapterDraft | undefined>(chapters.get(key))
        assertChapterVersion(key, current, edit.expectedVersion)
        if (!current || current.textContent !== edit.expectedText || current.title !== edit.expectedTitle || JSON.stringify(current.contentJson) !== JSON.stringify(edit.expectedJson)) throw new Error('章节已变化，请重新搜索后再替换；本次未写入')
        if (current.conflict || current.workflowPreview) throw new Error('章节处于冲突或生成状态，不能替换')
        versions.put({ id: `${key}:local:replace:${batch.operationId}`, userId: current.userId, bookId: current.bookId, chapterId: current.chapterId,
          source: 'local', title: current.title, textContent: current.textContent, contentJson: current.contentJson, remoteVersion: current.remoteVersion,
          remark: '全书替换前', createdAt: stamp })
        chapters.put({ ...current, textContent: edit.textContent, contentJson: cloneStorageJson(edit.contentJson), localVersion: current.localVersion + 1, updatedAt: stamp, dirty: true })
        result.chapterIds.push(edit.chapterId); result.count += edit.count
      }
      settings.put({ key: receiptKey, value: { fingerprint, result } })
      await done
      return result
    } catch (error) {
      try { transaction.abort() } catch { /* 事务已结束 */ }
      await done.catch(() => undefined)
      throw error
    }
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
    const { objectStore, transaction } = await this.store(STORE_CHAPTERS, 'readwrite')
    const done = transactionDone(transaction)
    const current = await requestToPromise<StoredLocalChapterDraft | undefined>(
      objectStore.get(buildChapterStorageKey(userId, bookId, chapterId)))
    if (current) objectStore.put({
      ...current,
      lastBackedUpAt: Math.max(Number(current.lastBackedUpAt || 0), Number(backupAt || Date.now())),
    })
    await done
  }

  async exportAllRecords(): Promise<WritingStorageDump> {
    const chapters = await this.getAllFrom<StoredLocalChapterDraft>(STORE_CHAPTERS)
    const versions = await this.getAllFrom<StoredChapterVersion>(STORE_VERSIONS)
    const settings = await this.getAllFrom<{ key: string; value: unknown }>(STORE_SETTINGS)
    // IndexedDB 里 value 存的是对象，导出统一成 JSON 文本，与 SQLite 口径一致
    return {
      chapters: chapters.map(chapter => validateStoredChapter(chapter)),
      versions,
      settings: settings.map(item => ({ key: String(item.key), value: JSON.stringify(item.value ?? null) })),
    }
  }

  async importAllRecords(dump: WritingStorageDump, options: { replace: boolean }) {
    const db = await this.getDb()
    const stores: StoreName[] = [STORE_CHAPTERS, STORE_VERSIONS, STORE_SETTINGS]
    const transaction = trackIndexedDbTransaction(db.transaction(stores, 'readwrite'))
    if (options.replace) stores.forEach(name => transaction.objectStore(name).clear())
    for (const chapter of dump.chapters) {
      const normalized = normalizeLocalChapterDraft(chapter)
      transaction.objectStore(STORE_CHAPTERS).put({
        ...normalized,
        storageKey: buildChapterStorageKey(normalized.userId, normalized.bookId, normalized.chapterId),
        lastBackedUpAt: Number(chapter.lastBackedUpAt || 0),
        wordCount: countDraftWords(normalized.textContent),
        textWordCount: countTextWords(normalized.textContent),
      })
    }
    dump.versions.forEach(version => transaction.objectStore(STORE_VERSIONS).put(version))
    for (const item of dump.settings) {
      let value: unknown = null
      try {
        value = JSON.parse(item.value)
      } catch {
        value = item.value
      }
      transaction.objectStore(STORE_SETTINGS).put({ key: item.key, value })
    }
    await transactionDone(transaction)
  }

  private async getAllFrom<T>(name: StoreName) {
    const { objectStore } = await this.store(name, 'readonly')
    return await requestToPromise<T[]>(objectStore.getAll())
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
