import type { TextCounts } from '@/types/ui-preferences'
import type { JsonRecord } from '@/types/json'
import type {
  LocalBook,
  LocalBookGroup,
  LocalBookListQuery,
  LocalChapter,
  LocalLibraryStorage,
  LocalVolume,
  RemoteCatalogVolumeInput,
} from './local-library-types'
import {
  buildLocalTree,
  calcLocalBookStatsWithDrafts,
  loadLocalDraftWordCounts,
  resolveLocalChapterWords,
  resolveLocalChapterTextWords,
  normalizeLocalBook,
  normalizeLocalChapter,
  normalizeLocalGroup,
  normalizeLocalVolume,
  nowIso,
  sortBySortNo,
} from './local-library-utils'

const DB_NAME = 'ew-local-library'
const DB_VERSION = 1
const STORE_BOOKS = 'local_books'
const STORE_GROUPS = 'local_book_groups'
const STORE_VOLUMES = 'local_volumes'
const STORE_CHAPTERS = 'local_chapters'

type StoreName =
  | typeof STORE_BOOKS
  | typeof STORE_GROUPS
  | typeof STORE_VOLUMES
  | typeof STORE_CHAPTERS

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

export class IndexedDbLocalLibraryStorage implements LocalLibraryStorage {
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
          if (!db.objectStoreNames.contains(STORE_BOOKS)) {
            const store = db.createObjectStore(STORE_BOOKS, { keyPath: 'id' })
            store.createIndex('updateTime', 'updateTime', { unique: false })
            store.createIndex('deletedAt', 'deletedAt', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORE_GROUPS)) {
            db.createObjectStore(STORE_GROUPS, { keyPath: 'id' })
          }
          if (!db.objectStoreNames.contains(STORE_VOLUMES)) {
            const store = db.createObjectStore(STORE_VOLUMES, { keyPath: 'id' })
            store.createIndex('bookId', 'bookId', { unique: false })
          }
          if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
            const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'id' })
            store.createIndex('bookId', 'bookId', { unique: false })
            store.createIndex('volumeId', 'volumeId', { unique: false })
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

  private async all<T>(name: StoreName) {
    const { objectStore } = await this.store(name, 'readonly')
    return await requestToPromise<T[]>(objectStore.getAll())
  }

  private async put<T>(name: StoreName, payload: T) {
    const { objectStore, transaction } = await this.store(name, 'readwrite')
    objectStore.put(payload)
    await transactionDone(transaction)
    return payload
  }

  private async get<T>(name: StoreName, id: number | string) {
    const { objectStore } = await this.store(name, 'readonly')
    return await requestToPromise<T | undefined>(objectStore.get(Number(id))) ?? null
  }

  private async listBookVolumes(bookId: number | string) {
    return (await this.all<LocalVolume>(STORE_VOLUMES)).filter(volume => String(volume.bookId) === String(bookId))
  }

  private async listBookChapters(bookId: number | string) {
    return (await this.all<LocalChapter>(STORE_CHAPTERS)).filter(chapter => String(chapter.bookId) === String(bookId))
  }

  private async refreshBookStats(bookId: number | string) {
    const book = await this.getLocalBookDetail(bookId)
    if (!book) return null
    const stats = await calcLocalBookStatsWithDrafts(bookId, await this.listBookChapters(bookId))
    const next = normalizeLocalBook({ ...book, ...stats, updateTime: nowIso() })
    await this.put(STORE_BOOKS, next)
    return next
  }

  private async syncChapterStatsWithDrafts(
    bookId: number | string,
    chapters: LocalChapter[],
    draftWords: Map<number, TextCounts>
  ) {
    for (const chapter of chapters.filter(item => !item.deletedAt)) {
      const wordCount = resolveLocalChapterWords(chapter, draftWords)
      const textWordCount = resolveLocalChapterTextWords(chapter, draftWords)
      if (Number(chapter.wordCount || 0) !== wordCount || chapter.textWordCount !== textWordCount) {
        await this.put(STORE_CHAPTERS, normalizeLocalChapter({ ...chapter, wordCount, textWordCount, updateTime: chapter.updateTime }))
      }
    }
  }

  private async syncBookStatsIfStale(book: LocalBook) {
    const chapters = await this.listBookChapters(book.id)
    // 字数只取一次，章节对齐和书籍统计共用，避免同一批数据读两遍
    const draftWords = await loadLocalDraftWordCounts(book.id)
    await this.syncChapterStatsWithDrafts(book.id, chapters, draftWords)
    const stats = await calcLocalBookStatsWithDrafts(book.id, chapters, draftWords)
    if (Number(book.wordCount || 0) === stats.wordCount && Number(book.chapterCount || 0) === stats.chapterCount && book.textWordCount === stats.textWordCount) return book
    const next = normalizeLocalBook({ ...book, ...stats, updateTime: book.updateTime })
    await this.put(STORE_BOOKS, next)
    return next
  }

  async listLocalBooks(query: LocalBookListQuery = {}) {
    const keyword = String(query.keyWord || '').trim().toLowerCase()
    const direction = query.sortOrder === 'ASC' ? 1 : -1
    const books = await Promise.all((await this.all<LocalBook>(STORE_BOOKS)).map(book => this.syncBookStatsIfStale(book)))
    return books
      .filter(book => query.deletedOnly ? !!book.deletedAt : query.includeDeleted ? true : !book.deletedAt)
      .filter(book => !keyword || `${book.title} ${book.intro || ''}`.toLowerCase().includes(keyword))
      .filter(book => query.ungrouped ? !book.groupId : query.groupId == null || String(book.groupId || '') === String(query.groupId))
      .sort((a, b) => {
        const sortBy = query.sortBy || 'updateTime'
        if (sortBy === 'title') return direction * a.title.localeCompare(b.title, 'zh-CN')
        const pick = (book: Record<string, unknown>) => {
          const raw = book[sortBy]
          return Number(new Date(String(raw ?? 0)).getTime() || Number(raw) || 0)
        }
        return direction * (pick(a as unknown as Record<string, unknown>) - pick(b as unknown as Record<string, unknown>))
      })
  }

  async createLocalBook(payload: Partial<LocalBook>) {
    // 未登录创建的书归属 guest，登录后由认领流程改写为真实账号
    const book = normalizeLocalBook({ ownerUserId: 'guest', ...payload })
    await this.put(STORE_BOOKS, book)
    const volume = normalizeLocalVolume({ bookId: book.id, title: '第一卷', sortNo: 1 })
    await this.put(STORE_VOLUMES, volume)
    const chapter = normalizeLocalChapter({ bookId: book.id, volumeId: volume.id, title: '第1章', sortNo: 1 })
    await this.put(STORE_CHAPTERS, chapter)
    return await this.refreshBookStats(book.id) || book
  }

  async importRemoteCatalog(book: Partial<LocalBook>, volumes: RemoteCatalogVolumeInput[]) {
    // 用云端真实 id 落库（云端 id 为正、本地新建为负，不冲突），标记 merged 供离线回退。
    const bookId = Number(book.id)
    if (!bookId) return
    await this.put(
      STORE_BOOKS,
      normalizeLocalBook({
        ...book,
        id: bookId,
        localOnly: true,
        mergeStatus: 'merged',
        remoteBookId: bookId,
        deletedAt: null,
        updateTime: nowIso(),
      })
    )
    for (const volume of volumes || []) {
      await this.put(
        STORE_VOLUMES,
        normalizeLocalVolume({
          id: Number(volume.id),
          bookId: String(bookId),
          title: volume.title || '默认分卷',
          summary: volume.summary || '',
          sortNo: Number(volume.sortNo || 0),
        })
      )
      for (const chapter of volume.chapters || []) {
        await this.put(
          STORE_CHAPTERS,
          normalizeLocalChapter({
            id: Number(chapter.id),
            bookId: String(bookId),
            volumeId: String(volume.id),
            title: chapter.title || `章节_${chapter.id}`,
            summary: chapter.summary || '',
            sortNo: Number(chapter.sortNo || 0),
            wordCount: Number(chapter.wordCount || 0),
            status: Number(chapter.status || 0),
          })
        )
      }
    }
    await this.refreshBookStats(bookId)
  }

  async updateLocalBook(payload: Partial<LocalBook> & { id: number }) {
    const current = await this.getLocalBookDetail(payload.id)
    const next = normalizeLocalBook({ ...(current || {}), ...payload, updateTime: nowIso() })
    await this.put(STORE_BOOKS, next)
    return next
  }

  async softDeleteLocalBook(ids: number[]) {
    for (const id of ids) {
      const book = await this.getLocalBookDetail(id)
      if (book) await this.put(STORE_BOOKS, normalizeLocalBook({ ...book, deletedAt: nowIso(), updateTime: nowIso() }))
    }
  }

  async restoreLocalBook(ids: number[]) {
    for (const id of ids) {
      const book = await this.getLocalBookDetail(id)
      if (book) await this.put(STORE_BOOKS, normalizeLocalBook({ ...book, deletedAt: null, updateTime: nowIso() }))
    }
  }

  async purgeLocalBook(ids: number[]) {
    for (const id of ids) {
      const chapters = await this.listBookChapters(id)
      const { objectStore: chapterStore, transaction: chapterTx } = await this.store(STORE_CHAPTERS, 'readwrite')
      chapters.forEach(chapter => chapterStore.delete(Number(chapter.id)))
      await transactionDone(chapterTx)

      const volumes = await this.listBookVolumes(id)
      const { objectStore: volumeStore, transaction: volumeTx } = await this.store(STORE_VOLUMES, 'readwrite')
      volumes.forEach(volume => volumeStore.delete(Number(volume.id)))
      await transactionDone(volumeTx)

      const { objectStore: bookStore, transaction: bookTx } = await this.store(STORE_BOOKS, 'readwrite')
      bookStore.delete(Number(id))
      await transactionDone(bookTx)
    }
  }

  async getLocalBookDetail(id: number | string) {
    return await this.get<LocalBook>(STORE_BOOKS, id)
  }

  async listUnmergedLocalBooks() {
    return (await this.listLocalBooks()).filter(book => (book.mergeStatus || 'local') === 'local')
  }

  async markLocalBookMerged(id: number, remoteBookId: number, ownerUserId?: string) {
    const book = await this.getLocalBookDetail(id)
    if (!book) return null
    const next = normalizeLocalBook({
      ...book,
      mergeStatus: 'merged',
      remoteBookId,
      mergedAt: nowIso(),
      updateTime: nowIso(),
      ownerUserId: ownerUserId || book.ownerUserId || null,
    })
    await this.put(STORE_BOOKS, next)
    return next
  }

  async markLocalBookIgnored(id: number) {
    const book = await this.getLocalBookDetail(id)
    if (!book) return null
    const next = normalizeLocalBook({ ...book, mergeStatus: 'ignored', updateTime: nowIso() })
    await this.put(STORE_BOOKS, next)
    return next
  }

  async listLocalGroups() {
    return sortBySortNo((await this.all<LocalBookGroup>(STORE_GROUPS)).filter(group => !group.deletedAt))
  }

  async createLocalGroup(payload: { title: string; sortNo?: number }) {
    const group = normalizeLocalGroup(payload)
    await this.put(STORE_GROUPS, group)
    return group
  }

  async updateLocalGroup(payload: { id: number; title?: string; sortNo?: number }) {
    const current = await this.get<LocalBookGroup>(STORE_GROUPS, payload.id)
    if (!current) return null
    const next = normalizeLocalGroup({ ...current, ...payload, updateTime: nowIso() })
    await this.put(STORE_GROUPS, next)
    return next
  }

  async deleteLocalGroup(ids: number[]) {
    for (const id of ids) {
      const group = await this.get<LocalBookGroup>(STORE_GROUPS, id)
      if (group) await this.put(STORE_GROUPS, normalizeLocalGroup({ ...group, deletedAt: nowIso(), updateTime: nowIso() }))
    }
  }

  async getLocalBookTree(bookId: number | string) {
    const chapters = await this.listBookChapters(bookId)
    const counts = await loadLocalDraftWordCounts(bookId)
    return buildLocalTree(await this.listBookVolumes(bookId), chapters.map(chapter => ({
      ...chapter, wordCount: resolveLocalChapterWords(chapter, counts), textWordCount: resolveLocalChapterTextWords(chapter, counts)
    })))
  }

  async createLocalVolume(payload: { bookId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }) {
    const volume = normalizeLocalVolume(payload)
    await this.put(STORE_VOLUMES, volume)
    await this.refreshBookStats(payload.bookId)
    return volume
  }

  async updateLocalVolume(payload: { id: number; title?: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }) {
    const current = await this.get<LocalVolume>(STORE_VOLUMES, payload.id)
    if (!current) return null
    // 显式区分 undefined（不修改）与 null（清空），避免展开把已有 planMeta 抹掉
    const next = normalizeLocalVolume({
      ...current,
      ...payload,
      planMeta: payload.planMeta !== undefined ? payload.planMeta : current.planMeta,
      updateTime: nowIso(),
    })
    await this.put(STORE_VOLUMES, next)
    await this.refreshBookStats(next.bookId)
    return next
  }

  async deleteLocalVolume(ids: number[]) {
    for (const id of ids) {
      const volume = await this.get<LocalVolume>(STORE_VOLUMES, id)
      if (!volume) continue
      await this.put(STORE_VOLUMES, normalizeLocalVolume({ ...volume, deletedAt: nowIso(), updateTime: nowIso() }))
      const chapters = (await this.all<LocalChapter>(STORE_CHAPTERS)).filter(chapter => String(chapter.volumeId) === String(id))
      for (const chapter of chapters) {
        await this.put(STORE_CHAPTERS, normalizeLocalChapter({ ...chapter, deletedAt: nowIso(), updateTime: nowIso() }))
      }
      await this.refreshBookStats(volume.bookId)
    }
  }

  async sortLocalVolumes(payload: { bookId: number | string; volumeIds: number[] }) {
    for (const [index, id] of payload.volumeIds.entries()) {
      const volume = await this.get<LocalVolume>(STORE_VOLUMES, id)
      if (volume) await this.put(STORE_VOLUMES, normalizeLocalVolume({ ...volume, sortNo: index + 1, updateTime: nowIso() }))
    }
    await this.refreshBookStats(payload.bookId)
  }

  async createLocalChapter(payload: { bookId: number | string; volumeId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }) {
    const chapter = normalizeLocalChapter(payload)
    await this.put(STORE_CHAPTERS, chapter)
    await this.refreshBookStats(payload.bookId)
    return chapter
  }

  async updateLocalChapter(payload: { id: number; title?: string; summary?: string; volumeId?: string; sortNo?: number; wordCount?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }) {
    const current = await this.get<LocalChapter>(STORE_CHAPTERS, payload.id)
    if (!current) return null
    // 显式区分 undefined（不修改）与 null（清空），避免展开把已有 planMeta 抹掉
    const next = normalizeLocalChapter({
      ...current,
      ...payload,
      volumeId: payload.volumeId || current.volumeId,
      planMeta: payload.planMeta !== undefined ? payload.planMeta : current.planMeta,
      workflowStatus: payload.workflowStatus !== undefined ? payload.workflowStatus : current.workflowStatus,
      updateTime: nowIso(),
    })
    await this.put(STORE_CHAPTERS, next)
    await this.refreshBookStats(next.bookId)
    return next
  }

  async getLocalChapterById(id: number) {
    const chapter = await this.get<LocalChapter>(STORE_CHAPTERS, id)
    return chapter && !chapter.deletedAt ? chapter : null
  }

  async deleteLocalChapter(ids: number[]) {
    for (const id of ids) {
      const chapter = await this.get<LocalChapter>(STORE_CHAPTERS, id)
      if (!chapter) continue
      await this.put(STORE_CHAPTERS, normalizeLocalChapter({ ...chapter, deletedAt: nowIso(), updateTime: nowIso() }))
      await this.refreshBookStats(chapter.bookId)
    }
  }

  async sortLocalChapters(payload: { volumeId: number | string; chapterIds: number[] }) {
    for (const [index, id] of payload.chapterIds.entries()) {
      const chapter = await this.get<LocalChapter>(STORE_CHAPTERS, id)
      if (chapter) await this.put(STORE_CHAPTERS, normalizeLocalChapter({ ...chapter, volumeId: payload.volumeId, sortNo: index + 1, updateTime: nowIso() }))
    }
    const first = await this.get<LocalChapter>(STORE_CHAPTERS, payload.chapterIds[0])
    if (first) await this.refreshBookStats(first.bookId)
  }

  async updateLocalChapterContentMeta(payload: { bookId: number | string; chapterId: number; wordCount: number; title?: string }) {
    const chapter = await this.get<LocalChapter>(STORE_CHAPTERS, payload.chapterId)
    if (!chapter) return
    await this.put(STORE_CHAPTERS, normalizeLocalChapter({ ...chapter, title: payload.title || chapter.title, wordCount: payload.wordCount, updateTime: nowIso() }))
    return await this.refreshBookStats(payload.bookId)
  }
}
