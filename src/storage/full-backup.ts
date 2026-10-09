import { usesUnifiedStorage, STORAGE_MODE_KEY } from './storage-mode'
import { encodeImportedBookAssets, decodeBookAssets, prepareBackupBook } from './book-assets'
import { desktopInvoke, decodeDesktopValue, encodeRecords, type PersistedStore } from './desktop-records'
import { libraryImportStatements, writingImportStatements } from './desktop-import'
import { validateBackupData } from './backup-validation'
import { beginStorageMaintenance, endStorageMaintenance } from './storage-maintenance'
import { hasLiveLocalTasks } from '@/utils/local-workflow-runtime'
import { appSettings, flushAppSettings, SETTINGS_NAMESPACE } from '@/storage/app-settings'
/**
 * 一键备份 / 一键恢复（桌面端，单个 zip）。
 *
 * 包内条目：
 *   manifest.json        格式与计数
 *   library.json         作品库四张表（分组/书/卷/章，含已删除）
 *   writing.json         正文草稿、章节历史版本、sync_settings 键值
 *   local-storage.json   全部 ew-* 本地键（模型配置含 API Key、提示词偏好、统计、界面设置……）
 *   fonts.json + fonts/  导入的自定义字体
 *   idb/<name>.json      IndexedDB 各库（参考资料、工作流、妙笔对话、AI 记录、拆书、生图、背景图、榜单缓存），
 *   idb-blobs/           其中的 Blob 字段（生图）拆出的二进制条目；见 full-backup-idb.ts
 *   prompts/             提示词文档（Rust 侧直接从 Documents/易创提示词 进出）
 *
 * 恢复两种模式：
 *   overwrite  先清空再写入，工作台整体回到备份时的状态（可先自动做一次安全备份）
 *   merge      备份里的作品作为新记录加入；与本机冲突的 id 重映射，正文/版本/统计/位置/参考资料/工作流/对话/生图随之改键；
 *              设置类以备份为准，模型按 id 补缺，其余本机已有的保留
 */

import { getLocalLibraryStorage } from './local-library'
import {
  buildChapterStorageKey,
  createChapterVersionId,
  getWritingStorage,
  isTauriRuntime,
  type LocalWritingSettings,
  type WritingStorageDump,
} from './index'
import type { LocalLibraryDump } from './local-library-types'
import { createLocalEntityId } from './local-library-utils'
import { clearImportedFonts, listImportedFonts, readImportedFontFile, saveImportedFont } from './local-fonts'
import {
  IDB_STORES,
  countIdbRecords,
  dumpIdbStore,
  extractIdbBlobs,
  idbEntryPath,
  listIdbKeys,
  mergeIdbRecords,
  planIdbIdRemap,
  remapIdFields,
  remapIdbRecords,
  restoreIdbBlobs,
  restoreIdbStore,
  type IdbDumpFile,
  type IdbRecord,
} from './full-backup-idb'
import type { ImportedFont } from '@/types/imported-font'

export type FullRestoreMode = 'overwrite' | 'merge'

export const FULL_BACKUP_FORMAT = 'ew-full-backup'
export const FULL_BACKUP_VERSION = 2

export interface FullBackupManifest {
  format: typeof FULL_BACKUP_FORMAT
  version: number
  createdAt: string
  appVersion: string
  platform: string
  counts: {
    groups: number
    books: number
    volumes: number
    chapters: number
    drafts: number
    versions: number
    fonts: number
    localStorageKeys: number
    /** IndexedDB 各库计数（键为 full-backup-idb 里的 name）；旧版备份没有这一项 */
    idb?: Record<string, number>
  }
}

export interface FullBackupSummary {
  path: string
  bytes: number
  entries: number
  /** 备份完成但有内容因附件损坏未包含（封面、生图等）；备份本身有效 */
  warnings?: string[]
}

export interface FullBackupEntry {
  path: string
  size: number
}

export interface FullBackupInspection {
  session: string
  manifest: FullBackupManifest
  entries: FullBackupEntry[]
  promptCount: number
}

export interface FullRestoreReport {
  warnings?: string[]
  mode: FullRestoreMode
  books: number
  chapters: number
  versions: number
  fonts: number
  prompts: number
  /** IndexedDB 各库写入计数（键为 full-backup-idb 里的 name） */
  idb: Record<string, number>
  safetyBackupPath: string
}

const LOCAL_STORAGE_PREFIX = 'ew-'
/** 会话级临时键，不进备份也不恢复 */
const LOCAL_STORAGE_SKIP = new Set(['ew-workflow-active-run', STORAGE_MODE_KEY])
/** 合并模式下"以备份为准"的设置类键 */
const SETTINGS_KEYS = new Set([
  'ew-ui-preferences',
  'ew-theme',
  'ew-skin',
  'ew-writing-editor',
  'ew-writing-plan',
  'ew-workflow-rail-panel-width',
  'ew-writing-entity-highlight-dismissed',
])
const AI_MODELS_KEY = 'ew-local-ai-models'
const WRITE_STATS_KEY = 'ew-local-write-stats'
const POSITIONS_KEY = 'ew-writing-positions'
const LOCAL_SETTINGS_KEY = 'localWritingSettings'
const BOOK_WORD_COUNT_PREFIX = 'bookWordCounts:'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 纯函数：localStorage 快照
// ---------------------------------------------------------------------------

export const snapshotLocalStorage = (storage: StorageLike = appSettings): Record<string, string> => {
  const out: Record<string, string> = {}
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !key.startsWith(LOCAL_STORAGE_PREFIX) || LOCAL_STORAGE_SKIP.has(key)) continue
    const value = storage.getItem(key)
    if (value !== null) out[key] = value
  }
  return out
}

/** overwrite：先清掉本机全部 ew-* 键再写；merge：只写给定键 */
export const applyLocalStorageSnapshot = (
  next: Record<string, string>,
  mode: FullRestoreMode,
  storage: StorageLike = appSettings
) => {
  if (mode === 'overwrite') {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key && key.startsWith(LOCAL_STORAGE_PREFIX) && !LOCAL_STORAGE_SKIP.has(key)) keys.push(key)
    }
    keys.forEach(key => storage.removeItem(key))
  }
  for (const [key, value] of Object.entries(next)) {
    if (LOCAL_STORAGE_SKIP.has(key)) continue
    storage.setItem(key, value)
  }
}

// ---------------------------------------------------------------------------
// 纯函数：合并模式的 id 重映射
// ---------------------------------------------------------------------------

export interface IdRemap {
  groups: Map<number, number>
  books: Map<number, number>
  volumes: Map<number, number>
  chapters: Map<number, number>
  /** 工作流 run / 任务 / 妙笔会话 / 生图：与本机冲突时换号（见 full-backup-idb.planIdbIdRemap） */
  runs: Map<number, number>
  tasks: Map<number, number>
  chatSessions: Map<number, number>
  images: Map<number, number>
  referenceEntities: Map<string, Map<number, number>>
}

export const emptyIdRemap = (): IdRemap => ({
  groups: new Map(),
  books: new Map(),
  volumes: new Map(),
  chapters: new Map(),
  runs: new Map(),
  tasks: new Map(),
  chatSessions: new Map(),
  images: new Map(),
  referenceEntities: new Map(),
})

export const collectLibraryIds = (dump: LocalLibraryDump) => {
  const ids = new Set<number>()
  dump.groups.forEach(item => ids.add(Number(item.id)))
  dump.books.forEach(item => ids.add(Number(item.id)))
  dump.volumes.forEach(item => ids.add(Number(item.id)))
  dump.chapters.forEach(item => ids.add(Number(item.id)))
  return ids
}

/** 本地 id 是负的时间戳；从当前时刻往下逐个分配，保证不撞本机已有 id */
export const createIdAllocator = (taken: Set<number>, seed?: number) => {
  let cursor = seed
  return () => {
    let id: number
    do { id = cursor === undefined ? createLocalEntityId() : --cursor } while (taken.has(id))
    taken.add(id)
    return id
  }
}

/** 只给与本机冲突的 id 换新号；不冲突的保留原号，这样同机备份里"删掉后想找回"的书能原样回来 */
export const planIdRemap = (dump: LocalLibraryDump, existing: Set<number>, allocate: () => number): IdRemap => {
  const remap = emptyIdRemap()
  const assign = (map: Map<number, number>, id: number) => {
    if (existing.has(id)) map.set(id, allocate())
  }
  dump.groups.forEach(item => assign(remap.groups, Number(item.id)))
  dump.books.forEach(item => assign(remap.books, Number(item.id)))
  dump.volumes.forEach(item => assign(remap.volumes, Number(item.id)))
  dump.chapters.forEach(item => assign(remap.chapters, Number(item.id)))
  return remap
}

const mapId = (map: Map<number, number>, id: number | string | null | undefined) => {
  if (id === null || id === undefined || id === '') return id
  const numeric = Number(id)
  const next = map.get(numeric)
  return next === undefined ? id : next
}
const mapIdString = (map: Map<number, number>, id: string | number) => String(mapId(map, id))

export const remapLibraryDump = (dump: LocalLibraryDump, remap: IdRemap): LocalLibraryDump => ({
  groups: dump.groups.map(group => ({ ...group, id: Number(mapId(remap.groups, group.id)) })),
  books: dump.books.map(book => ({
    ...book,
    id: Number(mapId(remap.books, book.id)),
    groupId: book.groupId == null || book.groupId === '' ? book.groupId : mapIdString(remap.groups, book.groupId),
    lastChapterId: book.lastChapterId == null ? book.lastChapterId : Number(mapId(remap.chapters, book.lastChapterId)),
    // 工作流建书把 { workflowRunId } 记在这里（对象或 JSON 字符串），run 换号后要跟着改
    globalInstruction: (remapIdFields({ globalInstruction: book.globalInstruction }, remap) as { globalInstruction: typeof book.globalInstruction }).globalInstruction,
  })),
  volumes: dump.volumes.map(volume => ({
    ...volume,
    id: Number(mapId(remap.volumes, volume.id)),
    bookId: mapIdString(remap.books, volume.bookId),
    planMeta: remapIdFields(volume.planMeta, remap) as typeof volume.planMeta,
  })),
  chapters: dump.chapters.map(chapter => ({
    ...chapter,
    id: Number(mapId(remap.chapters, chapter.id)),
    bookId: mapIdString(remap.books, chapter.bookId),
    volumeId: mapIdString(remap.volumes, chapter.volumeId),
    planMeta: remapIdFields(chapter.planMeta, remap) as typeof chapter.planMeta,
  })),
})

const remapBookWordCounts = (raw: string, remap: IdRemap) => {
  const counts = parseJson<Record<string, number>>(raw, {})
  const next: Record<string, number> = {}
  for (const [bookId, count] of Object.entries(counts)) next[mapIdString(remap.books, bookId)] = count
  return next
}

export const remapWritingDump = (dump: WritingStorageDump, remap: IdRemap): WritingStorageDump => ({
  chapters: dump.chapters.map(chapter => {
    const bookId = mapIdString(remap.books, chapter.bookId)
    const chapterId = Number(mapId(remap.chapters, chapter.chapterId))
    return { ...chapter, bookId, chapterId, storageKey: buildChapterStorageKey(chapter.userId, bookId, chapterId) }
  }),
  versions: dump.versions.map(version => {
    const bookId = mapIdString(remap.books, version.bookId)
    const chapterId = Number(mapId(remap.chapters, version.chapterId))
    return {
      ...version,
      bookId,
      chapterId,
      id: createChapterVersionId(version.userId, bookId, chapterId, version.source, version.createdAt),
    }
  }),
  settings: dump.settings.map(item =>
    item.key.startsWith(BOOK_WORD_COUNT_PREFIX)
      ? { key: item.key, value: JSON.stringify(remapBookWordCounts(item.value, remap)) }
      : item
  ),
})

// ---------------------------------------------------------------------------
// 纯函数：localStorage 各键的重映射与合并
// ---------------------------------------------------------------------------

interface WriteStatsFile {
  version?: number
  targets?: unknown
  days?: Record<string, Record<string, unknown>>
  chapterBase?: Record<string, number>
  chapterTextBase?: Record<string, number>
}

const remapChapterKey = (key: string, remap: IdRemap) => {
  const [bookId, chapterId] = key.split(':')
  if (chapterId === undefined) return key
  return `${mapIdString(remap.books, bookId)}:${mapIdString(remap.chapters, chapterId)}`
}

const remapWriteStats = (file: WriteStatsFile, remap: IdRemap): WriteStatsFile => {
  const days: Record<string, Record<string, unknown>> = {}
  for (const [date, books] of Object.entries(file.days || {})) {
    days[date] = {}
    for (const [bookId, record] of Object.entries(books || {})) days[date][mapIdString(remap.books, bookId)] = record
  }
  const mapBase = (base?: Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(base || {})) out[remapChapterKey(key, remap)] = value
    return out
  }
  return { ...file, days, chapterBase: mapBase(file.chapterBase), chapterTextBase: mapBase(file.chapterTextBase) }
}

const mergeWriteStats = (currentRaw: string, backupRaw: string, remap: IdRemap) => {
  const current = parseJson<WriteStatsFile>(currentRaw, {})
  const backup = remapWriteStats(parseJson<WriteStatsFile>(backupRaw, {}), remap)
  const days = { ...(current.days || {}) }
  for (const [date, books] of Object.entries(backup.days || {})) {
    days[date] = { ...(books || {}), ...(days[date] || {}) }
  }
  return JSON.stringify({
    ...backup,
    ...current,
    days,
    chapterBase: { ...(backup.chapterBase || {}), ...(current.chapterBase || {}) },
    chapterTextBase: { ...(backup.chapterTextBase || {}), ...(current.chapterTextBase || {}) },
  })
}

type PositionsFile = Record<string, Record<string, unknown>>

const remapPositions = (file: PositionsFile, remap: IdRemap): PositionsFile => {
  const out: PositionsFile = {}
  for (const [bookId, chapters] of Object.entries(file || {})) {
    const nextBook = mapIdString(remap.books, bookId)
    out[nextBook] = {}
    for (const [chapterId, record] of Object.entries(chapters || {})) out[nextBook][mapIdString(remap.chapters, chapterId)] = record
  }
  return out
}

const mergePositions = (currentRaw: string, backupRaw: string, remap: IdRemap) => {
  const current = parseJson<PositionsFile>(currentRaw, {})
  const backup = remapPositions(parseJson<PositionsFile>(backupRaw, {}), remap)
  const out: PositionsFile = { ...backup }
  for (const [bookId, chapters] of Object.entries(current)) out[bookId] = { ...(out[bookId] || {}), ...chapters }
  return JSON.stringify(out)
}

interface AiModelsFile {
  version?: number
  models?: Array<{ id: number }>
  preferences?: Record<string, string>
}

const mergeAiModels = (currentRaw: string, backupRaw: string) => {
  const current = parseJson<AiModelsFile>(currentRaw, {})
  const backup = parseJson<AiModelsFile>(backupRaw, {})
  const known = new Set((current.models || []).map(model => Number(model.id)))
  const added = (backup.models || []).filter(model => !known.has(Number(model.id)))
  return JSON.stringify({
    version: current.version ?? backup.version ?? 1,
    models: [...(current.models || []), ...added],
    preferences: { ...(backup.preferences || {}), ...(current.preferences || {}) },
  })
}

/** 备份里的键在本机不存在时也要按新 id 改键（统计、位置） */
const remapLocalStorageValue = (key: string, raw: string, remap: IdRemap) => {
  if (key === WRITE_STATS_KEY) return JSON.stringify(remapWriteStats(parseJson<WriteStatsFile>(raw, {}), remap))
  if (key === POSITIONS_KEY) return JSON.stringify(remapPositions(parseJson<PositionsFile>(raw, {}), remap))
  return raw
}

export const mergeLocalStorage = (
  current: Record<string, string>,
  backup: Record<string, string>,
  remap: IdRemap
): Record<string, string> => {
  const next = { ...current }
  for (const [key, raw] of Object.entries(backup)) {
    if (LOCAL_STORAGE_SKIP.has(key)) continue
    if (!(key in current)) {
      next[key] = remapLocalStorageValue(key, raw, remap)
      continue
    }
    if (SETTINGS_KEYS.has(key)) next[key] = raw
    else if (key === AI_MODELS_KEY) next[key] = mergeAiModels(current[key], raw)
    else if (key === WRITE_STATS_KEY) next[key] = mergeWriteStats(current[key], raw, remap)
    else if (key === POSITIONS_KEY) next[key] = mergePositions(current[key], raw, remap)
    // 其余（灵感、敏感词、榜单缓存、备份印记等）本机已有就保留
  }
  return next
}

/** 备份目录是本机路径，换机器多半不存在；两种模式都沿用本机现有值 */
export const preserveMachineSettings = (
  settings: WritingStorageDump['settings'],
  current: LocalWritingSettings
): WritingStorageDump['settings'] =>
  settings.map(item => {
    if (item.key !== LOCAL_SETTINGS_KEY) return item
    const parsed = parseJson<Partial<LocalWritingSettings>>(item.value, {})
    return { key: item.key, value: JSON.stringify({ ...parsed, backupDir: current.backupDir }) }
  })

export const buildFullBackupFileName = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `易创全量备份-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3,'0')}.zip`
}

export const parseFullBackupManifest = (raw: string): FullBackupManifest => {
  const manifest = parseJson<Partial<FullBackupManifest> | null>(raw, null)
  if (!manifest || manifest.format !== FULL_BACKUP_FORMAT) throw new Error('这不是易创的一键备份文件')
  if (!Number.isInteger(manifest.version) || Number(manifest.version) < 1) throw new Error('备份版本无效')
  if (Number(manifest.version) > FULL_BACKUP_VERSION) throw new Error('备份文件由更新版本的易创生成，请先升级应用再恢复')
  return manifest as FullBackupManifest
}

// ---------------------------------------------------------------------------
// 桌面端流程
// ---------------------------------------------------------------------------

export const isFullBackupSupported = () => isTauriRuntime()

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const getInvoke = async () => (await import('@tauri-apps/api/core')).invoke

const readAppVersion = async () => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return ''
  }
}

const platformLabel = () => {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'
  return 'unknown'
}

export async function createFullBackup(
  targetPath: string,
  onProgress?: (text: string) => void
): Promise<FullBackupSummary> {
  await flushAppSettings()
  const invoke = await getInvoke()
  let snapshot: { library: LocalLibraryDump; writing: WritingStorageDump; stores: PersistedStore[] } | null = null
  // 单个附件文件损坏不该让整份备份做不成：封面按无封面导出，生图等按缺失导出，最后一并告知
  const warnings: string[] = []
  const brokenAssets = new Set<string>()
  if (usesUnifiedStorage()) {
    await getLocalLibraryStorage().getLocalBookDetail(0)
    await getWritingStorage().getLocalWritingSettings()
    snapshot = await desktopInvoke('desktop_storage_snapshot')
    snapshot!.library.books = await Promise.all(
      snapshot!.library.books.map(book =>
        decodeBookAssets(book, () => warnings.push(`《${book.title}》的封面文件损坏，备份里不含该封面`))
      )
    )
  }
  const snapshotRecords = async (namespace: string): Promise<IdbRecord[]> => Promise.all(
    (snapshot?.stores.find(store => store.namespace === namespace)?.records || []).map(async record => ({
      key: record.key,
      value: await decodeDesktopValue(JSON.parse(record.value), {
        onAssetError: asset => {
          brokenAssets.add(asset.path)
          return null
        },
      }),
    })))
  const session = await invoke<string>('full_backup_begin')
  const add = async (entry: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    await invoke('full_backup_add_entry', bytes, {
      headers: { 'x-ew-session': session, 'x-ew-entry': encodeURIComponent(entry) },
    })
  }
  try {
    onProgress?.('导出作品库…')
    const library = snapshot?.library ?? await getLocalLibraryStorage().exportAllRecords()
    library.books = library.books.map(book => prepareBackupBook(book, message => warnings.push(message)))
    await add('library.json', JSON.stringify(library))

    onProgress?.('导出正文与版本历史…')
    const writing = snapshot?.writing ?? await getWritingStorage().exportAllRecords()
    await add('writing.json', JSON.stringify(writing))

    onProgress?.('导出配置与统计…')
    const localStorageSnapshot: Record<string,string> = snapshot
      ? Object.fromEntries((await snapshotRecords(SETTINGS_NAMESPACE)).filter(record=>String(record.key).startsWith('ew-')&&!LOCAL_STORAGE_SKIP.has(String(record.key))).map(record=>[String(record.key),String(record.value)]))
      : snapshotLocalStorage()
    await add('local-storage.json', JSON.stringify(localStorageSnapshot))

    onProgress?.('导出字体…')
    const fonts: ImportedFont[] = []
    const fontMetadata = snapshot ? (await snapshotRecords('ew-font-store/metadata')).map(record=>record.value as ImportedFont) : await listImportedFonts()
    const fontRecords = snapshot?.stores.find(store=>store.namespace==='ew-font-store/files')?.records || []
    for (const font of fontMetadata) {
      let data: ArrayBuffer | undefined
      try {
        const raw = fontRecords.find(record=>record.key===font.id)
        data = snapshot ? (raw ? await decodeDesktopValue(JSON.parse(raw.value)) as ArrayBuffer : undefined) : await readImportedFontFile(font.id)
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('字体文件缺失或无效')
      } catch {
        warnings.push(`字体「${font.name}」的文件缺失或损坏，未包含在本次备份中；本机原记录保留`)
        continue
      }
      // 只对源文件读取容错；备份写入失败必须中止，不能误报备份成功。
      await add(`fonts/${font.id}`, new Uint8Array(data))
      fonts.push(font)
    }
    await add('fonts.json', JSON.stringify(fonts))

    onProgress?.('导出参考资料、工作流与其它记录…')
    const idbCounts: Record<string, number> = {}
    for (const spec of IDB_STORES) {
      const records = snapshot ? await snapshotRecords(`${spec.db}/${spec.store}`) : await dumpIdbStore(spec)
      const { records: serializable, blobs } = extractIdbBlobs(spec.name, records)
      for (const item of blobs) await add(item.entry, new Uint8Array(await item.blob.arrayBuffer()))
      const file: IdbDumpFile = { db: spec.db, store: spec.store, keyPath: spec.keyPath ?? null, records: serializable }
      await add(idbEntryPath(spec.name), JSON.stringify(file))
      idbCounts[spec.name] = countIdbRecords(spec, records)
    }

    const manifest: FullBackupManifest = {
      format: FULL_BACKUP_FORMAT,
      version: FULL_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: await readAppVersion(),
      platform: platformLabel(),
      counts: {
        groups: library.groups.length,
        books: library.books.filter(book => !book.deletedAt).length,
        volumes: library.volumes.length,
        chapters: library.chapters.filter(chapter => !chapter.deletedAt).length,
        drafts: writing.chapters.length,
        versions: writing.versions.length,
        fonts: fonts.length,
        localStorageKeys: Object.keys(localStorageSnapshot).length,
        idb: idbCounts,
      },
    }
    validateBackupData(library, writing, localStorageSnapshot, fonts, manifest)
    await add('manifest.json', JSON.stringify(manifest, null, 2))

    onProgress?.('压缩打包…')
    if (brokenAssets.size) warnings.push(`有 ${brokenAssets.size} 个图片附件文件损坏，对应的生图或背景图未包含在备份中`)
    const summary = await invoke<FullBackupSummary>('full_backup_finish', { session, targetPath, includePrompts: true })
    return { ...summary, warnings }
  } catch (error) {
    await invoke('full_restore_close', { session }).catch(() => undefined)
    throw error
  }
}

export async function openFullBackup(zipPath: string): Promise<FullBackupInspection> {
  const invoke = await getInvoke()
  const info = await invoke<{ session: string; manifest: string; entries: FullBackupEntry[] }>('full_restore_open', { zipPath })
  try {
    const manifest = parseFullBackupManifest(info.manifest)
    return {
      session: info.session,
      manifest,
      entries: info.entries,
      promptCount: info.entries.filter(entry => entry.path.startsWith('prompts/')).length,
    }
  } catch (error) {
    await invoke('full_restore_close', { session: info.session }).catch(() => undefined)
    throw error
  }
}

export async function closeFullBackup(session: string) {
  const invoke = await getInvoke()
  await invoke('full_restore_close', { session }).catch(() => undefined)
}

const readEntryBytes = async (session: string, path: string) => {
  const invoke = await getInvoke()
  const data = await invoke<ArrayBuffer | Uint8Array | number[]>('full_restore_read_entry', { session, path })
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

const readEntryJson = async <T>(session: string, path: string): Promise<T> => {
  const bytes = await readEntryBytes(session, path)
  try { return JSON.parse(decoder.decode(bytes)) as T }
  catch { throw new Error(`备份条目损坏：${path}，未修改本机数据`) }
}

export class RestoreRestartRequiredError extends Error {
  constructor(cause: unknown) {
    super(`恢复操作已停止，需要重新启动确认数据状态；继续写入已暂停。${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'RestoreRestartRequiredError'
  }
}

export async function applyFullBackup(
  inspection: FullBackupInspection,
  mode: FullRestoreMode,
  options: { safetyBackupPath?: string; onProgress?: (text: string) => void } = {}
): Promise<FullRestoreReport> {
  if (hasLiveLocalTasks()) throw new Error('还有生成任务在运行，请先停止任务再恢复备份')
  await flushAppSettings()
  const { getLocalBackupService } = await import('./local-backup-service')
  if (!await getLocalBackupService().snapshotActiveWritingEditor(4000,true)) throw new Error('当前编辑内容尚未保存，已停止恢复')
  await flushAppSettings()
  if (!isTauriRuntime()) return performFullBackup(inspection,mode,options)
  // Finish schema initialization before blocking every ordinary writer.
  await getLocalLibraryStorage().getLocalBookDetail(0)
  await getWritingStorage().getLocalWritingSettings()
  await beginStorageMaintenance()
  try {
    const result = await performFullBackup(inspection,mode,options)
    // Keep writers blocked until restart: in-memory editor/workflow state belongs to the old DB.
    return result
  } catch (error) {
    if (!(error instanceof RestoreRestartRequiredError)) endStorageMaintenance()
    throw error
  }
}

async function performFullBackup(
  inspection: FullBackupInspection,
  mode: FullRestoreMode,
  options: { safetyBackupPath?: string; onProgress?: (text: string) => void } = {}
): Promise<FullRestoreReport> {
  const { session } = inspection
  const onProgress = options.onProgress
  const invoke = await getInvoke()
  const library = getLocalLibraryStorage()
  const writing = getWritingStorage()

  let safetyBackupPath = ''
  if (mode === 'overwrite' && options.safetyBackupPath) {
    onProgress?.('恢复前先做一次安全备份…')
    safetyBackupPath = (await createFullBackup(options.safetyBackupPath)).path
  }

  onProgress?.('读取备份内容…')
  let libraryDump = await readEntryJson<LocalLibraryDump>(session, 'library.json')
  let writingDump = await readEntryJson<WritingStorageDump>(session, 'writing.json')
  const backupLocalStorage = await readEntryJson<Record<string, string>>(session, 'local-storage.json')
  const fonts = await readEntryJson<ImportedFont[]>(session, 'fonts.json')
  validateBackupData(libraryDump, writingDump, backupLocalStorage, fonts, inspection.manifest)
  const warnings: string[] = []
  libraryDump.books = libraryDump.books.map(book => prepareBackupBook(book, message => warnings.push(message)))
  // 旧版备份没有 idb/ 条目：对应库保持本机现状，不清空
  const entryPaths = new Set(inspection.entries.map(entry => entry.path))
  const idbFiles: Record<string, IdbRecord[]> = {}
  for (const spec of IDB_STORES) {
    const path = idbEntryPath(spec.name)
    if (!entryPaths.has(path)) {
      if (inspection.manifest.counts.idb && spec.name in inspection.manifest.counts.idb) throw new Error(`备份缺少资料文件：${path}`)
      continue
    }
    const file = await readEntryJson<IdbDumpFile | null>(session, path)
    if (!file || !Array.isArray(file.records) || file.db !== spec.db || file.store !== spec.store
      || file.records.some(record => !record || !['string','number'].includes(typeof record.key) || !('value' in record))
      || new Set(file.records.map(record=>JSON.stringify(record.key))).size !== file.records.length) throw new Error(`备份资料结构无效：${path}`)
    if (inspection.manifest.counts.idb?.[spec.name] !== undefined && countIdbRecords(spec,file.records) !== inspection.manifest.counts.idb[spec.name]) throw new Error(`备份资料数量不匹配：${path}`)
    idbFiles[spec.name] = await restoreIdbBlobs(file.records, entry => readEntryBytes(session, entry))
  }

  let remap = emptyIdRemap()
  if (mode === 'merge') {
    const existing = collectLibraryIds(await library.exportAllRecords())
    const allocate = createIdAllocator(new Set([...existing, ...collectLibraryIds(libraryDump)]))
    remap = planIdRemap(libraryDump, existing, allocate)
    const currentIdbKeys: Record<string, Set<string>> = {}
    for (const spec of IDB_STORES) {
      if ((spec.name === 'workflow' || spec.name === 'chat' || spec.name === 'ai-images') && idbFiles[spec.name]) {
        currentIdbKeys[spec.name] = await listIdbKeys(spec)
        if (spec.name === 'chat') for (const record of await dumpIdbStore(spec)) {
          if (String(record.key).startsWith('sessions:') && Array.isArray(record.value)) {
            for (const session of record.value) currentIdbKeys.chat.add(`messages:${session.id}`)
          }
        }
      }
    }
    planIdbIdRemap(idbFiles, currentIdbKeys, allocate, remap)
    libraryDump = remapLibraryDump(libraryDump, remap)
    writingDump = remapWritingDump(writingDump, remap)
    // 书级字数缓存按 userId 分桶：备份里的桶要和本机同桶合并，本机值优先
    writingDump.settings = await Promise.all(
      writingDump.settings.map(async item => {
        if (!item.key.startsWith(BOOK_WORD_COUNT_PREFIX)) return item
        const current = await writing.getBookWordCounts(item.key.slice(BOOK_WORD_COUNT_PREFIX.length))
        return { key: item.key, value: JSON.stringify({ ...parseJson<Record<string, number>>(item.value, {}), ...current }) }
      })
    )
  }
  writingDump.settings = preserveMachineSettings(writingDump.settings, await writing.getLocalWritingSettings())

  // Validate/read every font before touching ANY live store.
  const fontData = new Map<string,ArrayBuffer>()
  for (const font of fonts) {
    const bytes = await readEntryBytes(session, `fonts/${font.id}`)
    fontData.set(font.id,bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }
  if (isTauriRuntime()) {
    const stores: PersistedStore[] = []
    const nextSettings = mode === 'overwrite' ? backupLocalStorage : mergeLocalStorage(snapshotLocalStorage(),backupLocalStorage,remap)
    stores.push({namespace:SETTINGS_NAMESPACE,records:await encodeRecords(SETTINGS_NAMESPACE,Object.entries(nextSettings).filter(([key])=>!LOCAL_STORAGE_SKIP.has(key)).map(([key,value])=>({key,value})))})
    const known = new Set(mode === 'merge' ? (await listImportedFonts()).map(font=>font.id) : [])
    const selected = fonts.filter(font=>!known.has(font.id))
    stores.push({namespace:'ew-font-store/metadata',records:await encodeRecords('ew-font-store/metadata',selected.map(font=>({key:font.id,value:font})))})
    stores.push({namespace:'ew-font-store/files',records:await encodeRecords('ew-font-store/files',selected.map(font=>({key:font.id,value:fontData.get(font.id)})))})
    const idb: Record<string,number> = {}
    for (const spec of IDB_STORES) {
      let records = idbFiles[spec.name]
      if (!records) continue // Legacy packages lack these stores; preserve current records.
      if (mode === 'merge') records = mergeIdbRecords(spec,remapIdbRecords(spec.name,records,remap),await dumpIdbStore(spec))
      const namespace = `${spec.db}/${spec.store}`
      stores.push({namespace,records:await encodeRecords(namespace,records)})
      idb[spec.name] = countIdbRecords(spec,records)
    }
    onProgress?.('校验完成，正在提交数据库和附件…')
    const storedLibrary = { ...libraryDump, books: await Promise.all(libraryDump.books.map(book => encodeImportedBookAssets(book, true))) }
    let legacyBase: { statements: ReturnType<typeof libraryImportStatements>; stores: PersistedStore[] } | undefined
    if (!usesUnifiedStorage()) {
      legacyBase = { statements: [], stores: [] }
      if (mode === 'merge') {
        const currentLibrary = await library.exportAllRecords()
        currentLibrary.books = await Promise.all(currentLibrary.books.map(book => encodeImportedBookAssets(prepareBackupBook(book, message => warnings.push(message)), true)))
        legacyBase.statements = [...libraryImportStatements(currentLibrary, false), ...writingImportStatements(await writing.exportAllRecords(), false)]
        const currentFonts = await listImportedFonts()
        legacyBase.stores.push({ namespace: 'ew-font-store/metadata', records: await encodeRecords('ew-font-store/metadata', currentFonts.map(font => ({ key: font.id, value: font }))) })
        const files = []
        for (const font of currentFonts) {
          const value = await readImportedFontFile(font.id)
          if (!value) throw new Error(`本机字体文件缺失：${font.name}，未开始恢复`)
          files.push({ key: font.id, value })
        }
        legacyBase.stores.push({ namespace: 'ew-font-store/files', records: await encodeRecords('ew-font-store/files', files) })
      }
      for (const spec of IDB_STORES) {
        // Old backup packages may omit modules. Preserve those current legacy records too.
        if (mode === 'overwrite' && idbFiles[spec.name]) continue
        const namespace = `${spec.db}/${spec.store}`
        legacyBase.stores.push({ namespace, records: await encodeRecords(namespace, await dumpIdbStore(spec)) })
      }
    }
    let prompts: number
    try {
      prompts = await desktopInvoke<number>('desktop_restore_apply',{

      statements:[...libraryImportStatements(storedLibrary,mode==='overwrite'),...writingImportStatements(writingDump,mode==='overwrite')],
      stores,replace:mode==='overwrite',session,mode,legacyBase,
      })
    } catch (error) { throw new RestoreRestartRequiredError(error) }
    await closeFullBackup(session)
    return {mode,books:libraryDump.books.filter(book=>!book.deletedAt).length,chapters:libraryDump.chapters.filter(chapter=>!chapter.deletedAt).length,versions:writingDump.versions.length,fonts:selected.length,prompts,idb,safetyBackupPath,...(warnings.length ? {warnings} : {})}
  }

  onProgress?.(mode === 'overwrite' ? '写入作品库（覆盖）…' : '写入作品库（合并）…')
  await library.importAllRecords(libraryDump, { replace: mode === 'overwrite' })
  onProgress?.('写入正文与版本历史…')
  await writing.importAllRecords(writingDump, { replace: mode === 'overwrite' })

  onProgress?.('写入配置与统计…')
  const nextLocalStorage =
    mode === 'overwrite' ? backupLocalStorage : mergeLocalStorage(snapshotLocalStorage(), backupLocalStorage, remap)
  applyLocalStorageSnapshot(nextLocalStorage, mode)

  onProgress?.('写入字体…')
  if (mode === 'overwrite') await clearImportedFonts()
  const knownFonts = new Set(mode === 'merge' ? (await listImportedFonts()).map(font => font.id) : [])
  let fontCount = 0
  for (const font of fonts) {
    if (knownFonts.has(font.id)) continue
    await saveImportedFont(font, fontData.get(font.id)!)
    fontCount += 1
  }

  onProgress?.('写入参考资料、工作流与其它记录…')
  const idbReport: Record<string, number> = {}
  for (const spec of IDB_STORES) {
    let records = idbFiles[spec.name]
    if (!records) continue
    if (mode === 'merge') {
      records = mergeIdbRecords(spec, remapIdbRecords(spec.name, records, remap), await dumpIdbStore(spec))
    }
    await restoreIdbStore(spec, records, { replace: mode === 'overwrite' })
    idbReport[spec.name] = countIdbRecords(spec, records)
  }

  onProgress?.('写入提示词…')
  const prompts = await invoke<number>('full_restore_apply_prompts', { session, mode })

  await closeFullBackup(session)
  return {
    mode,
    books: libraryDump.books.filter(book => !book.deletedAt).length,
    chapters: libraryDump.chapters.filter(chapter => !chapter.deletedAt).length,
    versions: writingDump.versions.length,
    fonts: fontCount,
    prompts,
    idb: idbReport,
    safetyBackupPath,
    ...(warnings.length ? { warnings } : {}),
  }
}
