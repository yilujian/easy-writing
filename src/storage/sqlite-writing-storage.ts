import { countTextWords } from '@/utils/word-count'
import { recordWriteJournal } from './write-journal'
import {
  assertChapterWriteBack,
  buildBookWordCountKey,
  buildChapterStorageKey,
  countDraftWords,
  cloneStorageJson,
  dispatchStorageEvent,
  LocalChapterWriteVerifyError,
  LocalStorageUnavailableError,
  normalizeLocalWritingSettings,
  normalizeLocalChapterDraft,
  sleep,
  SQLITE_OPEN_RETRY_DELAYS,
  type LocalChapterDraft,
  type LocalWritingSettings,
  type StoredChapterVersion,
  type StoredLocalChapterDraft,
  type WritingStorage,
} from './writing-storage'

/** SQL 行：字段按需取用，取出即归一类型 */
type SqlRow = Record<string, unknown>

type TauriDatabase = {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
  select: <T = SqlRow>(sql: string, params?: unknown[]) => Promise<T[]>
}

/** 一次性回填标记；置位后不再重复扫描 */
const WORD_COUNT_BACKFILL_KEY = 'wordCountBackfilled'
const LOCAL_SETTINGS_KEY = 'localWritingSettings'

const safeJsonParse = <T>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

export class SqliteWritingStorage implements WritingStorage {
  private db: TauriDatabase | null = null
  private openPromise: Promise<TauriDatabase> | null = null
  private unavailable = false

  /**
   * 打开本地库。要么返回可用连接，要么抛 LocalStorageUnavailableError。
   *
   * 这里刻意不再"打不开就退回 IndexedDB"：那不是降级而是分叉——
   * 同一台机器上出现两个都能写的库，跨会话读到哪一个全看运气，
   * 而写入还会返回成功，用户以为存住了。存储后端只能在启动时按平台选定，
   * 运行期只有"可用/不可用"两种状态，不存在"换一个"。
   */
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
        // 必须用字面量、且不能 @vite-ignore：否则 Vite 不处理这个 import，
        // webview 运行时无法解析裸模块名 '@tauri-apps/plugin-sql' 而直接抛错。
        // 与 dialog/updater 插件保持一致。
        const mod = await import('@tauri-apps/plugin-sql')
        type SqlPluginModule = { load: (path: string) => Promise<unknown> }
        const Database = ((mod as { default?: SqlPluginModule }).default || mod) as SqlPluginModule
        const db = await Database.load('sqlite:ew-writing.db') as TauriDatabase
        await this.ensureSchema(db)
        this.db = db
        if (this.unavailable) {
          this.unavailable = false
          dispatchStorageEvent('ew-writing-storage-recovered', { scope: 'writing' })
        }
        return db
      } catch (error) {
        lastError = error
        // 杀软扫描、系统休眠唤醒等造成的短暂文件锁，退避重试基本能扛过去。
        const wait = SQLITE_OPEN_RETRY_DELAYS[attempt]
        if (wait > 0) await sleep(wait)
      }
    }
    this.unavailable = true
    console.error('本地写作库(SQLite)打开失败', lastError)
    dispatchStorageEvent('ew-writing-storage-unavailable', {
      scope: 'writing',
      message: String(lastError),
    })
    throw new LocalStorageUnavailableError('sqlite', lastError)
  }

  private async ensureSchema(db: TauriDatabase) {
    await db.execute(`CREATE TABLE IF NOT EXISTS chapter_contents (
      storageKey TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      bookId TEXT NOT NULL,
      chapterId INTEGER NOT NULL,
      payload TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 0,
      conflict INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL,
      lastBackedUpAt INTEGER NOT NULL DEFAULT 0,
      wordCount INTEGER NOT NULL DEFAULT 0
    )`)
    // 备份标记列：把"待备份"过滤下推到 SQL，免去全表拉 payload（含全部正文）再 JS 过滤。
    // 旧库缺列时补列（已存在会报错，吞掉即可）；存量行默认 0 = 下轮全量备份一次后回归增量。
    await db.execute('ALTER TABLE chapter_contents ADD COLUMN lastBackedUpAt INTEGER NOT NULL DEFAULT 0').catch(() => undefined)
    // 字数列：目录树要按书批量取字数。有了它一条 SQL 就够，
    // 否则得把每章 payload（含全文）读出来再在 JS 里数——几百章就是几十 MB 的无谓读取。
    // 旧库补列后为 0，各章下次保存自然回填；未回填的沿用服务端字数，不会显示成 0。
    await db.execute('ALTER TABLE chapter_contents ADD COLUMN wordCount INTEGER NOT NULL DEFAULT 0').catch(() => undefined)
    await db.execute(`CREATE TABLE IF NOT EXISTS sync_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`)
    await db.execute(`CREATE TABLE IF NOT EXISTS chapter_versions (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      chapterId INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    )`)
    // 历史版本按章查询，没索引就是全表扫（且要读 payload=全文）。
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_chapter_versions_chapter ON chapter_versions (chapterId, createdAt DESC)'
    ).catch(() => undefined)
    const columns = await db.select<{ name: string }>('PRAGMA table_info(chapter_contents)')
    if (!columns.some(column => column.name === 'textWordCount')) {
      await db.execute('ALTER TABLE chapter_contents ADD COLUMN textWordCount INTEGER')
    }
    await this.backfillWordCountsOnce(db)
  }

  /**
   * 回填 wordCount 列（一次性）。
   *
   * 这一列是后加的，`ADD COLUMN ... NOT NULL DEFAULT 0` 把所有存量行都填成了 0——
   * 而它们的正文其实有几千字。于是 0 同时表示「真的是空章」和「还没算过」，
   * 读取侧无法区分，目录里就出现了"有正文却显示 0 字"。
   *
   * 补丁式的判定（只在更大时覆盖、非 0 才覆盖）都是在这个歧义上继续猜，
   * 用户真把一章删空时又会失效。这里一次性把缺口补上：回填之后 0 只有一个含义，
   * 之后每次保存都由 upsertChapterRow 写入真实值，缺口不会再产生。
   *
   * 整个计算下推到 SQLite 里完成：11598 行实测 93ms，且不搬运正文。
   * 若改成取回正文再用 countDraftWords 算，同样的数据要经 IPC 搬 20MB 以上，
   * 开库路径会卡住好几秒——正是刚优化掉的那类卡顿。
   * 代价是这里用 REPLACE 近似 `\s+`（半角空格、换行、回车、制表符、全角空格），
   * 极少数异体空白会差一两个字，下次保存即被 countDraftWords 修正。
   */
  private async backfillWordCountsOnce(db: TauriDatabase) {
    const done = await db
      .select<{ value: string }>(
        'SELECT value FROM sync_settings WHERE key = $1 LIMIT 1',
        [WORD_COUNT_BACKFILL_KEY]
      )
      .catch(() => [] as { value: string }[])
    if (done[0]?.value === '1') return

    try {
      await db.execute(
        `UPDATE chapter_contents
         SET wordCount = LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
               COALESCE(json_extract(payload, '$.textContent'), ''),
               ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(12288), ''))
         WHERE wordCount = 0`
      )
      // 书级总字数是"由每章字数汇总而来"的二级缓存，之前是拿被污染的数字算的，
      // 一并清掉；下一次加载目录会重新汇总写回。
      await db.execute("DELETE FROM sync_settings WHERE key LIKE 'bookWordCounts:%'")
      await db.execute(
        'INSERT OR REPLACE INTO sync_settings (key, value) VALUES ($1, $2)',
        [WORD_COUNT_BACKFILL_KEY, '1']
      )
    } catch (error) {
      // 回填失败不能挡住开库：字数只是展示，下次启动再试。
      console.warn('回填本地字数失败', error)
    }
  }

  async getChapter(chapterId: number) {
    const db = await this.getDb()
    const rows = await db.select<SqlRow>('SELECT payload FROM chapter_contents WHERE chapterId = $1 LIMIT 1', [Number(chapterId)])
    return safeJsonParse<StoredLocalChapterDraft | null>(rows[0]?.payload, null)
  }

  async getChapterByIdentity(userId: string, bookId: string | number, chapterId: number) {
    const db = await this.getDb()
    const key = buildChapterStorageKey(userId, bookId, chapterId)
    const rows = await db.select<SqlRow>('SELECT payload FROM chapter_contents WHERE storageKey = $1 LIMIT 1', [key])
    return safeJsonParse<StoredLocalChapterDraft | null>(rows[0]?.payload, null)
  }

  async saveChapterLocal(payload: LocalChapterDraft) {
    const db = await this.getDb()
    const normalized = normalizeLocalChapterDraft(payload)
    const current = await this.getChapterByIdentity(normalized.userId, normalized.bookId, normalized.chapterId)
    const record = {
      ...normalized,
      storageKey: buildChapterStorageKey(normalized.userId, normalized.bookId, normalized.chapterId),
      localVersion: Number(current?.localVersion || normalized.localVersion || 0) + 1,
      updatedAt: normalized.updatedAt || Date.now(),
      // 覆盖写入不得丢备份标记：调用方（同步/播种）没带时沿用旧值，
      // 否则每次覆盖都把章节打回"待备份"，退出备份被击穿成全量。
      lastBackedUpAt: normalized.lastBackedUpAt ?? Number(current?.lastBackedUpAt || 0) ?? 0,
    }
    await this.upsertChapterRow(db, record)
    await this.verifyWriteBack(record)
    return record
  }

  /**
   * chapter_contents 的唯一写入出口。
   * 四处调用方原本各写各的列，其中两处漏了 lastBackedUpAt——整行 REPLACE 会把它
   * 重置为 0，退出备份被击穿成全量。列一旦分叉就会悄悄丢字段，这里收敛成一处。
   */
  private async upsertChapterRow(db: TauriDatabase, record: StoredLocalChapterDraft) {
    await db.execute(
      `INSERT OR REPLACE INTO chapter_contents
      (storageKey, userId, bookId, chapterId, payload, dirty, conflict, updatedAt, lastBackedUpAt, wordCount, textWordCount)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.storageKey,
        String(record.userId),
        String(record.bookId),
        Number(record.chapterId),
        JSON.stringify(record),
        record.dirty ? 1 : 0,
        record.conflict ? 1 : 0,
        Number(record.updatedAt),
        Number(record.lastBackedUpAt || 0),
        countDraftWords(record.textContent),
        countTextWords(record.textContent),
      ]
    )
  }

  async listChapterVersions(userId: string, bookId: string | number, chapterId: number) {
    const db = await this.getDb()
    const rows = await db.select<SqlRow>(
      'SELECT payload FROM chapter_versions WHERE chapterId = $1 ORDER BY createdAt DESC',
      [Number(chapterId)]
    )
    return rows
      .map(row => safeJsonParse<StoredChapterVersion | null>(row.payload, null))
      .filter((item): item is StoredChapterVersion => Boolean(item))
      .filter(
        item =>
          String(item.userId) === String(userId) &&
          String(item.bookId) === String(bookId)
      )
  }

  async pruneChapterVersions(
    userId: string,
    bookId: string | number,
    chapterId: number,
    keep: number
  ) {
    const db = await this.getDb()
    // 只取 id：清理跑在每次留版本之后，没必要把 20 份全文读出来再解析一遍。
    // id 形如 userId:bookId:chapterId:source:createdAt，前缀即可定位到本章本人的版本。
    const prefix = `${userId}:${bookId}:${chapterId}:`
    const rows = await db.select<{ id: string }>(
      'SELECT id FROM chapter_versions WHERE chapterId = $1 AND id LIKE $2 ORDER BY createdAt DESC',
      [Number(chapterId), `${prefix}%`]
    )
    const expired = rows.slice(Math.max(1, keep)).map(row => row.id)
    if (!expired.length) return
    const placeholders = expired.map((_, index) => `$${index + 1}`).join(', ')
    await db.execute(`DELETE FROM chapter_versions WHERE id IN (${placeholders})`, expired)
  }

  async purgeBookDrafts(bookId: string | number) {
    const db = await this.getDb()
    // 版本 id 形如 userId:bookId:chapterId:source:createdAt，第二段即书号；
    // 只取 id 列，按段精确匹配（LIKE 中缀会误伤章号恰等于书号的行）
    const versionRows = await db.select<{ id: string }>('SELECT id FROM chapter_versions')
    const expired = versionRows.map(row => row.id).filter(id => id.split(':')[1] === String(bookId))
    if (expired.length) {
      const placeholders = expired.map((_, index) => `$${index + 1}`).join(', ')
      await db.execute(`DELETE FROM chapter_versions WHERE id IN (${placeholders})`, expired)
    }
    await db.execute('DELETE FROM chapter_contents WHERE bookId = $1', [String(bookId)])
  }

  async listChapterWordCounts(userId: string, bookId?: string | number) {
    const db = await this.getDb()
    const scoped = bookId !== undefined && bookId !== null && String(bookId) !== ''
    // 旧正文按本次读取范围分批补算；写回带 updatedAt 条件，避免覆盖并发保存的新计数。
    const scopeSql = `userId = $1${scoped ? ' AND bookId = $2' : ''}`
    const parameters = scoped ? [String(userId), String(bookId)] : [String(userId)]
    const missing = await db.select<SqlRow>(`SELECT storageKey, updatedAt, json_extract(payload, '$.textContent') AS textContent FROM chapter_contents WHERE ${scopeSql} AND textWordCount IS NULL`, parameters)
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100)
      const values: unknown[] = []
      const selects = batch.map(row => {
        const start = values.length
        values.push(row.storageKey, row.updatedAt, countTextWords(String(row.textContent ?? '')))
        return `SELECT $${start + 1} AS storageKey, $${start + 2} AS updatedAt, $${start + 3} AS count`
      })
      await db.execute(`WITH counts AS (${selects.join(' UNION ALL ')}) UPDATE chapter_contents SET textWordCount = (SELECT count FROM counts WHERE counts.storageKey = chapter_contents.storageKey) WHERE textWordCount IS NULL AND EXISTS (SELECT 1 FROM counts WHERE counts.storageKey = chapter_contents.storageKey AND counts.updatedAt = chapter_contents.updatedAt)`, values)
    }
    const rows = await db.select<SqlRow>(
      `SELECT bookId, chapterId, wordCount, textWordCount, dirty FROM chapter_contents
       WHERE userId = $1${scoped ? ' AND bookId = $2' : ''}`,
      scoped ? [String(userId), String(bookId)] : [String(userId)]
    )
    return rows.map(row => ({
      bookId: String(row.bookId),
      chapterId: Number(row.chapterId),
      wordCount: Number(row.wordCount || 0),
      textWordCount: row.textWordCount == null ? null : Number(row.textWordCount),
      dirty: Number(row.dirty || 0) === 1,
    }))
  }

  async getBookWordCounts(userId: string) {
    const db = await this.getDb()
    const rows = await db.select<SqlRow>(
      'SELECT value FROM sync_settings WHERE key = $1 LIMIT 1',
      [buildBookWordCountKey(userId)]
    )
    return safeJsonParse<Record<string, number>>(rows[0]?.value, {})
  }

  async setBookWordCount(userId: string, bookId: string | number, wordCount: number) {
    const db = await this.getDb()
    const next = {
      ...(await this.getBookWordCounts(userId)),
      [String(bookId)]: Number(wordCount || 0),
    }
    await db.execute(
      'INSERT OR REPLACE INTO sync_settings (key, value) VALUES ($1, $2)',
      [buildBookWordCountKey(userId), JSON.stringify(next)]
    )
  }

  /** 写后回读校验：写入返回成功不代表数据落到了目标库，必须自己确认一次 */
  private async verifyWriteBack(record: StoredLocalChapterDraft) {
    const chars = String(record.textContent || '').length
    try {
      await assertChapterWriteBack(record, () =>
        this.getChapterByIdentity(record.userId, record.bookId, record.chapterId)
      )
    } catch (error) {
      recordWriteJournal({
        at: Date.now(),
        backend: 'sqlite',
        storageKey: record.storageKey,
        chars,
        ok: false,
        reason: (error as LocalChapterWriteVerifyError)?.reason || 'unknown',
      })
      throw error
    }
    recordWriteJournal({
      at: Date.now(),
      backend: 'sqlite',
      storageKey: record.storageKey,
      chars,
      ok: true,
    })
  }

  async saveChapterVersion(payload: Parameters<WritingStorage['saveChapterVersion']>[0]) {
    const db = await this.getDb()
    const createdAt = payload.createdAt || Date.now()
    const id = `${payload.userId}:${payload.bookId}:${payload.chapterId}:${payload.source}:${createdAt}`
    const record = {
      ...payload,
      id,
      contentJson: cloneStorageJson(payload.contentJson),
      createdAt,
    }
    await db.execute(
      'INSERT OR REPLACE INTO chapter_versions (id, payload, chapterId, createdAt) VALUES ($1, $2, $3, $4)',
      [id, JSON.stringify(record), Number(payload.chapterId), createdAt]
    )
  }

  async listLocalChaptersForBackup(userId?: string, bookId?: string | number) {
    const db = await this.getDb()
    const normalizedUserId = userId === undefined || userId === null || String(userId) === ''
      ? ''
      : String(userId)
    const normalizedBookId = bookId === undefined || bookId === null || String(bookId) === ''
      ? ''
      : String(bookId)
    // 过滤下推到 SQL：原实现全表拉 payload（含全部正文，可达数 MB）再 JS 过滤。
    // 原 JS 判定化简后等价于 lastBackedUpAt=0 或 updatedAt>lastBackedUpAt。
    // 列值由 saveChapterLocal/markChapterBackedUp 维护；旧行列值 0 会全量备份一次后收敛。
    const rows = await db.select<SqlRow>(
      'SELECT payload FROM chapter_contents WHERE lastBackedUpAt = 0 OR updatedAt > lastBackedUpAt ORDER BY updatedAt ASC'
    )
    return rows
      .map(row => safeJsonParse<StoredLocalChapterDraft | null>(row.payload, null))
      .filter(Boolean)
      .filter(item => !normalizedUserId || String((item as StoredLocalChapterDraft).userId) === normalizedUserId)
      .filter(item => !normalizedBookId || String((item as StoredLocalChapterDraft).bookId) === normalizedBookId)
      .filter(item => {
        const record = item as StoredLocalChapterDraft
        const lastBackedUpAt = Number(record.lastBackedUpAt || 0)
        const updatedAt = Number(record.updatedAt || 0)
        return !lastBackedUpAt || updatedAt > lastBackedUpAt
      }) as StoredLocalChapterDraft[]
  }

  async markChapterBackedUp(userId: string, bookId: string | number, chapterId: number, backupAt: number) {
    const db = await this.getDb()
    const current = await this.getChapterByIdentity(userId, bookId, chapterId)
    if (!current) return
    const nextChapter = {
      ...current,
      lastBackedUpAt: Number(backupAt || Date.now()),
    }
    await this.upsertChapterRow(db, { ...nextChapter, storageKey: current.storageKey })
  }

  async getLocalWritingSettings() {
    const db = await this.getDb()
    const rows = await db.select<SqlRow>('SELECT key, value FROM sync_settings WHERE key = $1', [LOCAL_SETTINGS_KEY])
    const settings = safeJsonParse<Partial<LocalWritingSettings>>(rows[0]?.value, {})
    return normalizeLocalWritingSettings(settings)
  }

  async setLocalWritingSettings(settings: Partial<LocalWritingSettings>) {
    const db = await this.getDb()
    const current = await this.getLocalWritingSettings()
    const next = normalizeLocalWritingSettings({ ...current, ...settings })
    await db.execute('INSERT OR REPLACE INTO sync_settings (key, value) VALUES ($1, $2)', [LOCAL_SETTINGS_KEY, JSON.stringify(next)])
    return next
  }
}
