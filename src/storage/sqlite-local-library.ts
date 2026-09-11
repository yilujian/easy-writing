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
import {
  dispatchStorageEvent,
  LocalStorageUnavailableError,
  sleep,
  SQLITE_OPEN_RETRY_DELAYS,
} from './writing-storage'

/** SQL 行：字段按需取用，取出即归一类型 */
type SqlRow = Record<string, unknown>

type TauriDatabase = {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
  select: <T = SqlRow>(sql: string, params?: unknown[]) => Promise<T[]>
}

const TABLE_BOOKS = 'local_books'
const TABLE_GROUPS = 'local_book_groups'
const TABLE_VOLUMES = 'local_volumes'
const TABLE_CHAPTERS = 'local_chapters'

const safeJsonParse = <T>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

export class SqliteLocalLibraryStorage implements LocalLibraryStorage {
  private db: TauriDatabase | null = null
  private openPromise: Promise<TauriDatabase> | null = null
  private unavailable = false

  /** 见 SqliteWritingStorage.getDb：要么返回可用连接，要么抛错，绝不换库 */
  private async getDb(): Promise<TauriDatabase> {
    if (this.db) return this.db
    if (!this.openPromise) {
      this.openPromise = this.openWithRetry().finally(() => {
        this.openPromise = null
      })
    }
    return await this.openPromise
  }

  private async openWithRetry(): Promise<TauriDatabase> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < SQLITE_OPEN_RETRY_DELAYS.length; attempt += 1) {
      try {
        // 见 SqliteWritingStorage：必须字面量导入，@vite-ignore + 变量会让
        // webview 运行时无法解析裸模块名而抛错，SQLite 永远打不开。
        const mod = await import('@tauri-apps/plugin-sql')
        type SqlPluginModule = { load: (path: string) => Promise<unknown> }
        const Database = ((mod as { default?: SqlPluginModule }).default || mod) as SqlPluginModule
        const db = await Database.load('sqlite:ew-writing.db') as TauriDatabase
        await this.ensureSchema(db)
        this.db = db
        if (this.unavailable) {
          this.unavailable = false
          dispatchStorageEvent('ew-writing-storage-recovered', { scope: 'library' })
        }
        return db
      } catch (error) {
        lastError = error
        const wait = SQLITE_OPEN_RETRY_DELAYS[attempt]
        if (wait > 0) await sleep(wait)
      }
    }
    this.unavailable = true
    console.error('本地书库(SQLite)打开失败', lastError)
    dispatchStorageEvent('ew-writing-storage-unavailable', {
      scope: 'library',
      message: String(lastError),
    })
    throw new LocalStorageUnavailableError('sqlite', lastError)
  }

  private async ensureSchema(db: TauriDatabase) {
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE_BOOKS} (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      title TEXT NOT NULL,
      groupId TEXT,
      mergeStatus TEXT NOT NULL,
      deletedAt TEXT,
      updateTime TEXT NOT NULL
    )`)
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE_GROUPS} (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      deletedAt TEXT,
      sortNo INTEGER NOT NULL
    )`)
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE_VOLUMES} (
      id INTEGER PRIMARY KEY,
      bookId TEXT NOT NULL,
      payload TEXT NOT NULL,
      deletedAt TEXT,
      sortNo INTEGER NOT NULL
    )`)
    await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE_CHAPTERS} (
      id INTEGER PRIMARY KEY,
      bookId TEXT NOT NULL,
      volumeId TEXT NOT NULL,
      payload TEXT NOT NULL,
      deletedAt TEXT,
      sortNo INTEGER NOT NULL
    )`)
    // 卷/章一律按书查询，没索引就是全表扫，且每行都要把 payload 拉出来反序列化。
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_local_chapters_book ON ${TABLE_CHAPTERS} (bookId, sortNo)`
    ).catch(() => undefined)
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_local_volumes_book ON ${TABLE_VOLUMES} (bookId, sortNo)`
    ).catch(() => undefined)
  }

  private async all<T>(table: string) {
    const db = await this.getDb()
    const rows = await db.select<{ payload: string }>(`SELECT payload FROM ${table}`)
    return rows.map(row => safeJsonParse<T | null>(row.payload, null)).filter(Boolean) as T[]
  }

  private async get<T>(table: string, id: number | string) {
    const db = await this.getDb()
    const rows = await db.select<{ payload: string }>(`SELECT payload FROM ${table} WHERE id = $1 LIMIT 1`, [Number(id)])
    return safeJsonParse<T | null>(rows[0]?.payload, null)
  }

  private async putBook(book: LocalBook) {
    const db = await this.getDb()
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE_BOOKS} (id, payload, title, groupId, mergeStatus, deletedAt, updateTime)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [book.id, JSON.stringify(book), book.title, book.groupId || null, book.mergeStatus || 'local', book.deletedAt || null, book.updateTime || nowIso()]
    )
    return book
  }

  private async putGroup(group: LocalBookGroup) {
    const db = await this.getDb()
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE_GROUPS} (id, payload, deletedAt, sortNo) VALUES ($1, $2, $3, $4)`,
      [group.id, JSON.stringify(group), group.deletedAt || null, Number(group.sortNo || 0)]
    )
    return group
  }

  private async putVolume(volume: LocalVolume) {
    const db = await this.getDb()
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE_VOLUMES} (id, bookId, payload, deletedAt, sortNo) VALUES ($1, $2, $3, $4, $5)`,
      [volume.id, String(volume.bookId), JSON.stringify(volume), volume.deletedAt || null, Number(volume.sortNo || 0)]
    )
    return volume
  }

  private async putChapter(chapter: LocalChapter) {
    const db = await this.getDb()
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE_CHAPTERS} (id, bookId, volumeId, payload, deletedAt, sortNo) VALUES ($1, $2, $3, $4, $5, $6)`,
      [chapter.id, String(chapter.bookId), String(chapter.volumeId), JSON.stringify(chapter), chapter.deletedAt || null, Number(chapter.sortNo || 0)]
    )
    return chapter
  }

  // 按书取行必须下推到 SQL。原来是把整张表（所有书的全部卷/章）读出来再在 JS 里
  // 过滤，而它挂在每次落盘都会跑的书籍统计上——书越多、章越多，打字越卡。
  private async allByBook<T>(table: string, bookId: number | string) {
    const db = await this.getDb()
    const rows = await db.select<{ payload: string }>(
      `SELECT payload FROM ${table} WHERE bookId = $1`,
      [String(bookId)]
    )
    return rows.map(row => safeJsonParse<T | null>(row.payload, null)).filter(Boolean) as T[]
  }

  private async listBookVolumes(bookId: number | string) {
    return await this.allByBook<LocalVolume>(TABLE_VOLUMES, bookId)
  }

  private async listBookChapters(bookId: number | string) {
    return await this.allByBook<LocalChapter>(TABLE_CHAPTERS, bookId)
  }

  private async refreshBookStats(bookId: number | string) {
    const book = await this.getLocalBookDetail(bookId)
    if (!book) return null
    const stats = await calcLocalBookStatsWithDrafts(bookId, await this.listBookChapters(bookId))
    const next = normalizeLocalBook({ ...book, ...stats, updateTime: nowIso() })
    await this.putBook(next)
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
        await this.putChapter(normalizeLocalChapter({ ...chapter, wordCount, textWordCount, updateTime: chapter.updateTime }))
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
    await this.putBook(next)
    return next
  }

  async listLocalBooks(query: LocalBookListQuery = {}) {
    await this.getDb()
    const keyword = String(query.keyWord || '').trim().toLowerCase()
    const direction = query.sortOrder === 'ASC' ? 1 : -1
    const books = await Promise.all((await this.all<LocalBook>(TABLE_BOOKS) || []).map(book => this.syncBookStatsIfStale(book)))
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
    await this.getDb()
    // 未登录创建的书归属 guest，登录后由认领流程改写为真实账号
    const book = normalizeLocalBook({ ownerUserId: 'guest', ...payload })
    await this.putBook(book)
    const volume = normalizeLocalVolume({ bookId: book.id, title: '第一卷', sortNo: 1 })
    await this.putVolume(volume)
    const chapter = normalizeLocalChapter({ bookId: book.id, volumeId: volume.id, title: '第1章', sortNo: 1 })
    await this.putChapter(chapter)
    return await this.refreshBookStats(book.id) || book
  }

  async importRemoteCatalog(book: Partial<LocalBook>, volumes: RemoteCatalogVolumeInput[]) {
    await this.getDb()
    // 用云端真实 id 落库（云端正、本地负，不冲突），标记 merged 供离线回退渲染。
    const bookId = Number(book.id)
    if (!bookId) return
    await this.putBook(
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
      await this.putVolume(
        normalizeLocalVolume({
          id: Number(volume.id),
          bookId: String(bookId),
          title: volume.title || '默认分卷',
          summary: volume.summary || '',
          sortNo: Number(volume.sortNo || 0),
        })
      )
      for (const chapter of volume.chapters || []) {
        await this.putChapter(
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
    await this.getDb()
    const current = await this.getLocalBookDetail(payload.id)
    const next = normalizeLocalBook({ ...(current || {}), ...payload, updateTime: nowIso() })
    await this.putBook(next)
    return next
  }

  async softDeleteLocalBook(ids: number[]) {
    for (const id of ids) {
      const book = await this.getLocalBookDetail(id)
      if (book) await this.putBook(normalizeLocalBook({ ...book, deletedAt: nowIso(), updateTime: nowIso() }))
    }
  }

  async restoreLocalBook(ids: number[]) {
    for (const id of ids) {
      const book = await this.getLocalBookDetail(id)
      if (book) await this.putBook(normalizeLocalBook({ ...book, deletedAt: null, updateTime: nowIso() }))
    }
  }

  async purgeLocalBook(ids: number[]) {
    const db = await this.getDb()
    for (const id of ids) {
      await db.execute(`DELETE FROM ${TABLE_CHAPTERS} WHERE bookId = $1`, [String(id)])
      await db.execute(`DELETE FROM ${TABLE_VOLUMES} WHERE bookId = $1`, [String(id)])
      await db.execute(`DELETE FROM ${TABLE_BOOKS} WHERE id = $1`, [Number(id)])
    }
  }

  async getLocalBookDetail(id: number | string) {
    await this.getDb()
    return await this.get<LocalBook>(TABLE_BOOKS, id)
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
    await this.putBook(next)
    return next
  }

  async markLocalBookIgnored(id: number) {
    const book = await this.getLocalBookDetail(id)
    if (!book) return null
    const next = normalizeLocalBook({ ...book, mergeStatus: 'ignored', updateTime: nowIso() })
    await this.putBook(next)
    return next
  }

  async listLocalGroups() {
    await this.getDb()
    return sortBySortNo((await this.all<LocalBookGroup>(TABLE_GROUPS) || []).filter(group => !group.deletedAt))
  }

  async createLocalGroup(payload: { title: string; sortNo?: number }) {
    await this.getDb()
    const group = normalizeLocalGroup(payload)
    await this.putGroup(group)
    return group
  }

  async updateLocalGroup(payload: { id: number; title?: string; sortNo?: number }) {
    await this.getDb()
    const current = await this.get<LocalBookGroup>(TABLE_GROUPS, payload.id)
    if (!current) return null
    const next = normalizeLocalGroup({ ...current, ...payload, updateTime: nowIso() })
    await this.putGroup(next)
    return next
  }

  async deleteLocalGroup(ids: number[]) {
    for (const id of ids) {
      const group = await this.get<LocalBookGroup>(TABLE_GROUPS, id)
      if (group) await this.putGroup(normalizeLocalGroup({ ...group, deletedAt: nowIso(), updateTime: nowIso() }))
    }
  }

  async getLocalBookTree(bookId: number | string) {
    await this.getDb()
    const chapters = await this.listBookChapters(bookId)
    const counts = await loadLocalDraftWordCounts(bookId)
    return buildLocalTree(await this.listBookVolumes(bookId), chapters.map(chapter => ({
      ...chapter, wordCount: resolveLocalChapterWords(chapter, counts), textWordCount: resolveLocalChapterTextWords(chapter, counts)
    })))
  }

  async createLocalVolume(payload: { bookId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }) {
    await this.getDb()
    const volume = normalizeLocalVolume(payload)
    await this.putVolume(volume)
    await this.refreshBookStats(payload.bookId)
    return volume
  }

  async updateLocalVolume(payload: { id: number; title?: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }) {
    await this.getDb()
    const current = await this.get<LocalVolume>(TABLE_VOLUMES, payload.id)
    if (!current) return null
    // 显式区分 undefined（不修改）与 null（清空），避免展开把已有 planMeta 抹掉
    const next = normalizeLocalVolume({
      ...current,
      ...payload,
      planMeta: payload.planMeta !== undefined ? payload.planMeta : current.planMeta,
      updateTime: nowIso(),
    })
    await this.putVolume(next)
    await this.refreshBookStats(next.bookId)
    return next
  }

  async deleteLocalVolume(ids: number[]) {
    for (const id of ids) {
      const volume = await this.get<LocalVolume>(TABLE_VOLUMES, id)
      if (!volume) continue
      await this.putVolume(normalizeLocalVolume({ ...volume, deletedAt: nowIso(), updateTime: nowIso() }))
      const chapters = (await this.all<LocalChapter>(TABLE_CHAPTERS) || []).filter(chapter => String(chapter.volumeId) === String(id))
      for (const chapter of chapters) {
        await this.putChapter(normalizeLocalChapter({ ...chapter, deletedAt: nowIso(), updateTime: nowIso() }))
      }
      await this.refreshBookStats(volume.bookId)
    }
  }

  async sortLocalVolumes(payload: { bookId: number | string; volumeIds: number[] }) {
    for (const [index, id] of payload.volumeIds.entries()) {
      const volume = await this.get<LocalVolume>(TABLE_VOLUMES, id)
      if (volume) await this.putVolume(normalizeLocalVolume({ ...volume, sortNo: index + 1, updateTime: nowIso() }))
    }
    await this.refreshBookStats(payload.bookId)
  }

  async createLocalChapter(payload: { bookId: number | string; volumeId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }) {
    await this.getDb()
    const chapter = normalizeLocalChapter(payload)
    await this.putChapter(chapter)
    await this.refreshBookStats(payload.bookId)
    return chapter
  }

  async updateLocalChapter(payload: { id: number; title?: string; summary?: string; volumeId?: string; sortNo?: number; wordCount?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }) {
    await this.getDb()
    const current = await this.get<LocalChapter>(TABLE_CHAPTERS, payload.id)
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
    await this.putChapter(next)
    await this.refreshBookStats(next.bookId)
    return next
  }

  async getLocalChapterById(id: number) {
    const chapter = await this.get<LocalChapter>(TABLE_CHAPTERS, id)
    return chapter && !chapter.deletedAt ? chapter : null
  }

  async deleteLocalChapter(ids: number[]) {
    for (const id of ids) {
      const chapter = await this.get<LocalChapter>(TABLE_CHAPTERS, id)
      if (!chapter) continue
      await this.putChapter(normalizeLocalChapter({ ...chapter, deletedAt: nowIso(), updateTime: nowIso() }))
      await this.refreshBookStats(chapter.bookId)
    }
  }

  async sortLocalChapters(payload: { volumeId: number | string; chapterIds: number[] }) {
    for (const [index, id] of payload.chapterIds.entries()) {
      const chapter = await this.get<LocalChapter>(TABLE_CHAPTERS, id)
      if (chapter) await this.putChapter(normalizeLocalChapter({ ...chapter, volumeId: payload.volumeId, sortNo: index + 1, updateTime: nowIso() }))
    }
    const first = await this.get<LocalChapter>(TABLE_CHAPTERS, payload.chapterIds[0])
    if (first) await this.refreshBookStats(first.bookId)
  }

  async updateLocalChapterContentMeta(payload: { bookId: number | string; chapterId: number; wordCount: number; title?: string }) {
    const chapter = await this.get<LocalChapter>(TABLE_CHAPTERS, payload.chapterId)
    if (!chapter) return
    await this.putChapter(normalizeLocalChapter({ ...chapter, title: payload.title || chapter.title, wordCount: payload.wordCount, updateTime: nowIso() }))
    return await this.refreshBookStats(payload.bookId)
  }
}
