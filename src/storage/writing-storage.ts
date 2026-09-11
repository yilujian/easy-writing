import {
  TYPING_SOUND_VALUES,
  type TypingSound,
} from '@/config/typing-sounds'
import { countWords } from '@/utils/word-count'

/** TipTap 文档 JSON：存储层当不透明数据，不做结构假设 */
export type EditorDocJson = unknown

export type BackupInterval = '10m' | '20m' | '30m'

export interface LocalChapterDraft {
  userId: string
  bookId: string
  chapterId: number
  title: string
  textContent: string
  contentJson: EditorDocJson
  localVersion: number
  remoteVersion: number
  baseRemoteVersion: number
  baseTitle: string
  baseTextContent: string
  baseContentJson: EditorDocJson
  dirty: boolean
  conflict: boolean
  localOnly: boolean
  /** 自动生文的本地可见快照只用于恢复展示，不当成用户手稿处理。 */
  workflowPreview?: boolean
  updatedAt: number
  lastBackedUpAt?: number
}

export interface StoredLocalChapterDraft extends LocalChapterDraft {
  storageKey: string
}

export interface LocalWritingSettings {
  backupEnabled: boolean
  backupDir: string
  backupRetention: number
  lastBackupAt?: number
  typingSound: TypingSound
  typingEffect: 'none' | 'splash' | 'ripple' | 'mist' | 'fire' | 'cheer'
  selfDestructMode: 'off' | '10s' | '20s' | '1m' | '5m'
  backupInterval: BackupInterval
}

export interface StoredChapterVersion {
  id: string
  userId: string
  bookId: string
  chapterId: number
  source: 'local' | 'remote' | 'merged'
  title: string
  textContent: string
  contentJson: EditorDocJson
  remoteVersion: number
  remark: string
  createdAt: number
}

/** 目录树字数覆盖用的轻量行：只取计数，不读正文 payload */
export interface ChapterWordCountRow {
  bookId: string
  chapterId: number
  wordCount: number

  textWordCount?: number | null
  /** 存量数据字段：纯本地模式下恒为真 */
  dirty: boolean
}

/** 正文字数口径：与编辑器、目录树、统计保持一致（忽略所有空白） */
export const countDraftWords = (value: unknown) =>
  countWords(typeof value === 'string' ? value : String(value ?? ''))

/** 书级字数缓存按账号分桶，避免多账号在同一台机器上互相覆盖 */
export const buildBookWordCountKey = (userId: string | number) =>
  `bookWordCounts:${String(userId)}`

export interface WritingStorage {
  getChapter(chapterId: number): Promise<StoredLocalChapterDraft | null>
  getChapterByIdentity(userId: string, bookId: string | number, chapterId: number): Promise<StoredLocalChapterDraft | null>
  saveChapterLocal(payload: LocalChapterDraft): Promise<StoredLocalChapterDraft>
  saveChapterVersion(payload: Omit<StoredChapterVersion, 'id' | 'createdAt'> & { createdAt?: number }): Promise<void>
  listLocalChaptersForBackup(userId?: string, bookId?: string | number): Promise<StoredLocalChapterDraft[]>
  markChapterBackedUp(userId: string, bookId: string | number, chapterId: number, backupAt: number): Promise<void>
  getLocalWritingSettings(): Promise<LocalWritingSettings>
  setLocalWritingSettings(settings: Partial<LocalWritingSettings>): Promise<LocalWritingSettings>
  /** 本地版本历史：按章倒序返回（最新在前） */
  listChapterVersions(
    userId: string,
    bookId: string | number,
    chapterId: number
  ): Promise<StoredChapterVersion[]>
  /** 只保留最近 keep 条，其余删除 */
  pruneChapterVersions(
    userId: string,
    bookId: string | number,
    chapterId: number,
    keep: number
  ): Promise<void>
  /** 彻底删除某书全部正文/冲突/历史版本（不分归属账号，回收站"彻底删除"级联用） */
  purgeBookDrafts(bookId: string | number): Promise<void>
  /** 按书取本地草稿字数；不传 bookId 则取该用户全部 */
  listChapterWordCounts(
    userId: string,
    bookId?: string | number
  ): Promise<ChapterWordCountRow[]>
  /** 书架用的书级字数缓存：写作页算准之后落地，列表页直接读 */
  getBookWordCounts(userId: string): Promise<Record<string, number>>
  setBookWordCount(
    userId: string,
    bookId: string | number,
    wordCount: number
  ): Promise<void>
}

export const DEFAULT_LOCAL_WRITING_SETTINGS: LocalWritingSettings = {
  backupEnabled: true,
  backupDir: '',
  backupRetention: 20,
  typingSound: 'typewriter',
  typingEffect: 'ripple',
  selfDestructMode: 'off',
  backupInterval: '10m',
}

const hasValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => {
  return values.includes(value as T) ? value as T : fallback
}

export const normalizeLocalWritingSettings = (settings?: Partial<LocalWritingSettings> | null): LocalWritingSettings => {
  const merged = { ...DEFAULT_LOCAL_WRITING_SETTINGS, ...(settings || {}) }
  return {
    backupEnabled: Boolean(merged.backupEnabled),
    backupDir: String(merged.backupDir || ''),
    backupRetention: Math.max(1, Math.min(100, Number(merged.backupRetention || 20))),
    lastBackupAt: merged.lastBackupAt ? Number(merged.lastBackupAt) : undefined,
    typingSound: hasValue(merged.typingSound, TYPING_SOUND_VALUES, 'typewriter'),
    typingEffect: hasValue(merged.typingEffect, ['none', 'splash', 'ripple', 'mist', 'fire', 'cheer'] as const, 'ripple'),
    selfDestructMode: hasValue(merged.selfDestructMode, ['off', '10s', '20s', '1m', '5m'] as const, 'off'),
    backupInterval: hasValue(merged.backupInterval, ['10m', '20m', '30m'] as const, '10m'),
  }
}

export const buildChapterStorageKey = (
  userId: string | number,
  bookId: string | number,
  chapterId: string | number
) => `${String(userId)}:${String(bookId)}:${String(chapterId)}`

export const createChapterVersionId = (
  userId: string | number,
  bookId: string | number,
  chapterId: string | number,
  source: string,
  timestamp = Date.now()
) => `${String(userId)}:${String(bookId)}:${String(chapterId)}:${source}:${timestamp}`

export const cloneStorageJson = <T = unknown>(value: T): T | null => {
  if (value === undefined || value === null) return null
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return null
  }
}

export const normalizeLocalChapterDraft = (payload: LocalChapterDraft): LocalChapterDraft => ({
  ...payload,
  userId: String(payload.userId),
  bookId: String(payload.bookId),
  chapterId: Number(payload.chapterId),
  title: String(payload.title || ''),
  textContent: String(payload.textContent || ''),
  contentJson: cloneStorageJson(payload.contentJson),
  localVersion: Number(payload.localVersion || 0),
  remoteVersion: Number(payload.remoteVersion || 0),
  baseRemoteVersion: Number(payload.baseRemoteVersion || payload.remoteVersion || 0),
  baseTitle: String(payload.baseTitle || ''),
  baseTextContent: String(payload.baseTextContent || ''),
  baseContentJson: cloneStorageJson(payload.baseContentJson),
  dirty: Boolean(payload.dirty),
  conflict: Boolean(payload.conflict),
  localOnly: Boolean(payload.localOnly),
  workflowPreview: Boolean(payload.workflowPreview),
  updatedAt: Number(payload.updatedAt || Date.now()),
  lastBackedUpAt: payload.lastBackedUpAt ? Number(payload.lastBackedUpAt) : undefined,
})

export const isTauriRuntime = () => {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ || (window as unknown as Record<string, unknown>).__TAURI__)
}

export type WritingStorageBackend = 'sqlite' | 'indexeddb'

/**
 * 本地库打开重试的退避间隔（毫秒），首项 0 表示先立即试一次。
 * 杀软扫描、休眠唤醒造成的短暂文件锁靠这几次重试就能扛过去；
 * 总计约 2.3 秒内仍失败才判定为不可用。
 */
export const SQLITE_OPEN_RETRY_DELAYS = [0, 200, 600, 1500]

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export const dispatchStorageEvent = (name: string, detail: Record<string, unknown>) => {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {
    // 非浏览器环境（如单测）忽略。
  }
}

/** 本地库不可用：只在真的写不进去时抛出，调用方必须让用户看见，不得静默吞掉 */
export class LocalStorageUnavailableError extends Error {
  readonly backend: WritingStorageBackend
  readonly cause: unknown

  constructor(backend: WritingStorageBackend, cause: unknown) {
    super('本地存储当前不可用，内容未能保存到本机')
    this.name = 'LocalStorageUnavailableError'
    this.backend = backend
    this.cause = cause
  }
}

export type ChapterWriteVerifyReason = 'missing' | 'content_mismatch'

/** 写入声称成功但回读对不上：视同写入失败，绝不能对上层报成功 */
export class LocalChapterWriteVerifyError extends Error {
  readonly storageKey: string
  readonly reason: ChapterWriteVerifyReason

  constructor(storageKey: string, reason: ChapterWriteVerifyReason) {
    super(
      reason === 'missing'
        ? '本地保存后读不回这一章，内容可能未真正写入'
        : '本地保存后读回的内容与刚写入的不一致'
    )
    this.name = 'LocalChapterWriteVerifyError'
    this.storageKey = storageKey
    this.reason = reason
  }
}

/**
 * 写后回读校验。
 *
 * 不信任写入接口的返回值——它只代表"调用没抛错"，不代表"数据落到了目标库"。
 * 历史上的丢稿正是因为写入返回成功、实际落到了别处。这里按主键回读一次
 * （主键等值查询，亚毫秒级，且只发生在保存路径、不在切章路径上），
 * 对不上就抛错，让上层如实显示"本地保存失败"。
 */
export const assertChapterWriteBack = async (
  record: StoredLocalChapterDraft,
  readBack: () => Promise<StoredLocalChapterDraft | null>
) => {
  const saved = await readBack()
  if (!saved) {
    throw new LocalChapterWriteVerifyError(record.storageKey, 'missing')
  }
  if (
    String(saved.textContent || '') !== String(record.textContent || '') ||
    String(saved.title || '') !== String(record.title || '')
  ) {
    throw new LocalChapterWriteVerifyError(record.storageKey, 'content_mismatch')
  }
}
