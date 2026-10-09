import { appSettings, flushAppSettings } from '@/storage/app-settings'
import dayjs from 'dayjs'
import { getWritingStorage } from './index'
import { getLocalLibraryStorage } from './local-library'
import { listReferenceBookStamps } from './local-reference-store'
import { exportLocalBookReference } from './local-reference-transfer'
import {
  isTauriRuntime,
  type LocalWritingSettings,
  type WritingStorage,
} from './writing-storage'

// 写作编辑器快照提供者计数：编辑器挂载/卸载时登记，
// 关窗快照据此区分"无编辑器（秒过）"与"编辑器在场（等应答）"。
let writingSnapshotProviderCount = 0
export const markWritingSnapshotProvider = (active: boolean) => {
  writingSnapshotProviderCount = Math.max(0, writingSnapshotProviderCount + (active ? 1 : -1))
}

export interface BackupChapterResult {
  chapterId: number
  title: string
  dirPath: string
  txtPath: string
  jsonPath: string
}

export interface BackupRunResult {
  supported: boolean
  skipped: boolean
  backupDir: string
  total: number
  success: number
  failed: Array<{ chapterId: number; title: string; message: string }>
  results: BackupChapterResult[]
  lastBackupAt?: number
  /** 参考数据（大纲/角色/设定/时间线/故事线）备份账目：按书计数 */
  referenceTotal?: number
  referenceSuccess?: number
  referenceFailed?: Array<{ bookId: string; title: string; message: string }>
}

export interface BackupBeforeExitResult {
  ok: boolean
  result: BackupRunResult
}

type ChapterMeta = {
  volumeId: string
  volumeTitle: string
  chapterTitle: string
  /** 目录里的实际位置（卷内第几章 / 第几卷，从 1 起）；恢复时据此排序，标题不带章号也不会乱 */
  orderNo?: number | null
  volumeOrderNo?: number | null
}

type CatalogMeta = {
  bookTitle: string
  chapters: Map<number, ChapterMeta>
}

// 开源版为本地单用户，备份身份固定 guest（与写作台存储键一致）
const resolveCurrentUserId = () => 'guest'

type LooseNode = Record<string, unknown>

/**
 * 从本地库镜像解析目录元数据（零网络）：云端书的完整目录已由
 * backupAllCloudBooks/importRemoteCatalog 镜像到本地库，备份路径优先用它——
 * 退出备份决不能等网络（跨洋往返 × 书数曾把退出拖到十几秒）。
 */
const resolveCatalogMetaFromLocal = async (bookId: string | number): Promise<CatalogMeta | null> => {
  try {
    const localLibrary = getLocalLibraryStorage()
    const [detail, tree] = await Promise.all([
      localLibrary.getLocalBookDetail(bookId).catch(() => null),
      localLibrary.getLocalBookTree(bookId).catch(() => []),
    ])
    const chapters = new Map<number, ChapterMeta>()
    // 目录树已按 sortNo/创建时间排好，这里记的是实际展示位置，比 sortNo 可靠（手建章节 sortNo 常为 0）
    ;(Array.isArray(tree) ? tree : []).forEach((volume, volumeIndex) => {
      const volumeId = String(volume?.id ?? '0')
      const volumeTitle = String(volume?.title || '默认分卷')
      ;(volume.children || []).forEach((chapter, chapterIndex) => {
        const chapterId = Number(chapter?.id || 0)
        if (!chapterId) return
        chapters.set(chapterId, {
          volumeId,
          volumeTitle,
          chapterTitle: String(chapter?.title || `章节_${chapterId}`),
          orderNo: chapterIndex + 1,
          volumeOrderNo: volumeIndex + 1,
        })
      })
    })
    if (!chapters.size && !detail) return null
    return {
      bookTitle: String((detail as LooseNode | null)?.title || `作品_${bookId}`),
      chapters,
    }
  } catch {
    return null
  }
}

const resolveBackupError = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '备份失败'
}

// ---------------------------------------------------------------------------
// 参考数据备份（大纲/角色/设定/时间线/故事线，按书整包）
// ---------------------------------------------------------------------------

/** 各书上次备份时参考库的更新时间印记；与之相同则本轮跳过，不重写相同快照 */
const REFERENCE_MARKS_KEY = 'ew-reference-backup-marks'

const loadReferenceMarks = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(appSettings.getItem(REFERENCE_MARKS_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const saveReferenceMarks = (marks: Record<string, string>) => {
  try {
    appSettings.setItem(REFERENCE_MARKS_KEY, JSON.stringify(marks))
  } catch (error) {
    console.warn('写入参考数据备份印记失败', error)
  }
}

/** 挑出参考数据有变化的书（限定 bookId 时只看这一本）；纯函数，供单测覆盖 */
export const pickChangedReferenceBooks = (
  stamps: Array<{ bookId: string; updatedAt: string }>,
  marks: Record<string, string>,
  bookId?: string | number
): Array<{ bookId: string; updatedAt: string }> => {
  const scope = bookId != null && bookId !== ''
    ? stamps.filter(stamp => stamp.bookId === String(bookId))
    : stamps
  return scope.filter(stamp => marks[stamp.bookId] !== stamp.updatedAt)
}

export interface ReferenceBackupReport {
  total: number
  success: number
  failed: Array<{ bookId: string; title: string; message: string }>
}

export class LocalBackupService {
  constructor(private storage: WritingStorage = getWritingStorage()) {}

  isSupported() {
    return isTauriRuntime()
  }

  async getDefaultBackupDir() {
    if (!this.isSupported()) return ''
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('get_default_backup_dir')
  }

  async openBackupDir(path?: string) {
    if (!this.isSupported()) return false
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_backup_dir', { path: path || await this.getDefaultBackupDir() })
    return true
  }

  async chooseBackupDir(currentDir?: string) {
    if (!this.isSupported()) return ''
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      title: '选择备份目录',
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      defaultPath: currentDir || await this.getDefaultBackupDir(),
    })
    return typeof selected === 'string' ? selected : ''
  }

  async getSettings() {
    const settings = await this.storage.getLocalWritingSettings()
    if (this.isSupported() && !settings.backupDir) {
      return await this.storage.setLocalWritingSettings({
        ...settings,
        backupDir: await this.getDefaultBackupDir(),
      })
    }
    return settings
  }

  async saveSettings(settings: Partial<LocalWritingSettings>) {
    return await this.storage.setLocalWritingSettings(settings)
  }

  async backupCurrentBook(bookId: string | number, userId = resolveCurrentUserId()) {
    const settings = await this.getSettings()
    return await this.backupPendingChapters({
      userId,
      bookId,
      settings,
    })
  }

  async backupAllPendingBooks(offline = false) {
    const settings = await this.getSettings()
    return await this.backupPendingChapters({
      settings,
      offline,
    })
  }

  // 超时窗口放宽到 4s：本地快照正常远快于此，超时基本意味着编辑器真的卡住。
  // 仍在超时时返回 true——因为无编辑器挂载时本就无人应答（没内容要存），
  // 若改成 false 会在“当前不在写作页”的正常关闭场景误报保存失败并弹确认框。
  async snapshotActiveWritingEditor(timeout = 4000, requireConfirmation = false) {
    if (typeof window === 'undefined') return true
    // 无编辑器挂载时（首页/书架等页面关窗）直接通过，
    // 否则事件无人应答会傻等满超时窗口，用户感知为"关闭卡顿"。
    if (writingSnapshotProviderCount <= 0) return true
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (event: Event) => {
        settled = true
        window.removeEventListener('ew-writing-local-snapshot-done', done)
        resolve((event as CustomEvent<{ success?: boolean }>).detail?.success !== false)
      }
      window.addEventListener('ew-writing-local-snapshot-done', done, { once: true })
      window.dispatchEvent(new CustomEvent('ew-writing-local-snapshot-request'))
      window.setTimeout(() => {
        if (settled) return
        window.removeEventListener('ew-writing-local-snapshot-done', done)
        // 超时未收到应答：可能无编辑器（正常）也可能编辑器卡住（异常），记录以便排查。
        console.warn('关闭前当前章节快照未在 %dms 内确认', timeout)
        resolve(!requireConfirmation)
      }, timeout)
    })
  }

  async backupBeforeExit(options: { requireSnapshotConfirmation?: boolean } = {}): Promise<BackupBeforeExitResult> {
    await flushAppSettings()
    const snapshotted = await this.snapshotActiveWritingEditor(4000, options.requireSnapshotConfirmation)
    if (!snapshotted) {
      return {
        ok: false,
        result: {
          supported: this.isSupported(),
          skipped: false,
          backupDir: '',
          total: 0,
          success: 0,
          failed: [{ chapterId: 0, title: '当前章节', message: '关闭前保存当前章节到本地失败' }],
          results: [],
        },
      }
    }
    // 退出备份：离线目录（零网络）+ 5s 硬超时。增量正常时远快于此；
    // 超时说明本地异常拥堵，未备份完的章节保持"待备份"标记，下次启动/
    // 周期备份自然补上——决不能让用户退出被无限期扣住。
    const EXIT_BACKUP_TIMEOUT = 5000
    const timeoutResult: BackupRunResult = {
      supported: true,
      skipped: true,
      backupDir: '',
      total: 0,
      success: 0,
      failed: [],
      results: [],
    }
    const result = await Promise.race([
      this.backupAllPendingBooks(true),
      new Promise<BackupRunResult>(resolve =>
        window.setTimeout(() => {
          console.warn('退出备份超过 %dms，放行退出，剩余章节下次补备份', EXIT_BACKUP_TIMEOUT)
          resolve(timeoutResult)
        }, EXIT_BACKUP_TIMEOUT)
      ),
    ])
    await flushAppSettings()
    return {
      ok: !result.failed.length,
      result,
    }
  }

  async backupPendingChapters(options: {
    userId?: string
    bookId?: string | number
    settings?: LocalWritingSettings
    /** true=零网络模式（退出路径）：目录只查本地镜像，查不到用章节自带标题兜底 */
    offline?: boolean
  }): Promise<BackupRunResult> {
    if (!this.isSupported()) {
      return {
        supported: false,
        skipped: true,
        backupDir: '',
        total: 0,
        success: 0,
        failed: [],
        results: [],
      }
    }

    const settings = options.settings || await this.getSettings()
    const backupDir = settings.backupDir || await this.getDefaultBackupDir()
    if (!settings.backupEnabled) {
      return {
        supported: true,
        skipped: true,
        backupDir,
        total: 0,
        success: 0,
        failed: [],
        results: [],
      }
    }

    // 没有待备份章节时不再早退：参考数据的变化不会把任何章节标脏，得单独查一轮
    const chapters = await this.storage.listLocalChaptersForBackup(options.userId, options.bookId)
    const { invoke } = await import('@tauri-apps/api/core')
    const catalogs = new Map<string, CatalogMeta>()
    // 目录元数据本地镜像优先（零网络零延迟）；仅非离线模式且本地缺目录时才回源。
    const getCatalog = async (bookId: string | number) => {
      const normalizedBookId = String(bookId || '0')
      const cached = catalogs.get(normalizedBookId)
      if (cached) return cached
      let catalog = await resolveCatalogMetaFromLocal(normalizedBookId)
      if (!catalog) {
        catalog = { bookTitle: `作品_${normalizedBookId}`, chapters: new Map() }
      }
      catalogs.set(normalizedBookId, catalog)
      return catalog
    }
    const backupAt = Date.now()
    const failed: BackupRunResult['failed'] = []
    const results: BackupChapterResult[] = []

    // 组装批量载荷：一次 invoke 写全部章节（Rust 端写文件+清理），
    // 替代原先每章 2 次 invoke 的串行往返。
    type BatchEntry = { chapter: (typeof chapters)[number]; bookId: string; title: string }
    const entries: BatchEntry[] = []
    const payloads: LooseNode[] = []
    for (const chapter of chapters) {
      const bookId = String(chapter.bookId || options.bookId || '0')
      const catalog = await getCatalog(bookId)
      const meta = catalog.chapters.get(Number(chapter.chapterId)) || {
        volumeId: '0',
        volumeTitle: '默认分卷',
        chapterTitle: chapter.title || `章节_${chapter.chapterId}`,
      }
      const fileStem = `${dayjs(backupAt).format('YYYYMMDD-HHmmss')}-v${Math.max(1, Number(chapter.localVersion || 1))}`
      entries.push({ chapter, bookId, title: meta.chapterTitle || chapter.title })
      payloads.push({
        backupDir,
        bookId,
        bookTitle: catalog.bookTitle,
        volumeId: meta.volumeId,
        volumeTitle: meta.volumeTitle,
        chapterId: Number(chapter.chapterId),
        chapterTitle: meta.chapterTitle || chapter.title,
        textContent: chapter.textContent || '',
        contentJson: chapter.contentJson || null,
        localVersion: Number(chapter.localVersion || 0),
        remoteVersion: Number(chapter.remoteVersion || 0),
        updatedAt: Number(chapter.updatedAt || backupAt),
        backupAt,
        fileStem,
        orderNo: meta.orderNo ?? null,
        volumeOrderNo: meta.volumeOrderNo ?? null,
      })
    }

    let batchResults: Array<{ chapterId: number; dirPath: string; txtPath: string; jsonPath: string; error?: string | null }> = []
    if (payloads.length) {
      try {
        batchResults = await invoke('write_chapter_backups', {
          payloads,
          retention: Number(settings.backupRetention || 20),
        })
      } catch (error) {
        // 批量命令整体失败（如目录不可写）：全部计失败，保留待备份标记
        const message = resolveBackupError(error)
        for (const entry of entries) {
          failed.push({ chapterId: Number(entry.chapter.chapterId), title: entry.title, message })
        }
        batchResults = []
      }
    }

    // Rust 端按输入顺序返回，用下标对齐（chapterId 仅作一致性校验，
    // 避免本地书章节 id 潜在撞号时错标）
    for (let i = 0; i < batchResults.length; i += 1) {
      const item = batchResults[i]
      const entry = entries[i]
      if (!entry || Number(entry.chapter.chapterId) !== Number(item.chapterId)) continue
      if (item.error) {
        failed.push({ chapterId: Number(item.chapterId), title: entry.title, message: item.error })
        continue
      }
      await this.storage.markChapterBackedUp(entry.chapter.userId, entry.bookId, Number(item.chapterId), backupAt)
      results.push({
        chapterId: Number(item.chapterId),
        title: entry.title,
        dirPath: item.dirPath,
        txtPath: item.txtPath,
        jsonPath: item.jsonPath,
      })
    }

    // 参考数据随每轮备份同行：只备有变化的书；失败进独立账目，不影响章节备份
    const reference = await this.backupBookReferences({
      invoke,
      backupDir,
      retention: Number(settings.backupRetention || 20),
      bookId: options.bookId,
      backupAt,
    })

    const didBackupSomething = results.length > 0 || reference.success > 0
    const lastBackupAt = didBackupSomething ? Date.now() : settings.lastBackupAt
    if (lastBackupAt && didBackupSomething) {
      await this.storage.setLocalWritingSettings({
        backupDir,
        backupRetention: settings.backupRetention,
        lastBackupAt,
      })
    }

    return {
      supported: true,
      skipped: false,
      backupDir,
      total: chapters.length,
      success: results.length,
      failed,
      results,
      lastBackupAt,
      referenceTotal: reference.total,
      referenceSuccess: reference.success,
      referenceFailed: reference.failed,
    }
  }

  /** 参考数据按书整包备份：印记未变的书跳过；任何失败都不抛出，账目随返回值走 */
  private async backupBookReferences(options: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    backupDir: string
    retention: number
    bookId?: string | number
    backupAt: number
  }): Promise<ReferenceBackupReport> {
    const report: ReferenceBackupReport = { total: 0, success: 0, failed: [] }
    const marks = loadReferenceMarks()
    let candidates: Array<{ bookId: string; updatedAt: string }> = []
    try {
      candidates = pickChangedReferenceBooks(await listReferenceBookStamps(), marks, options.bookId)
    } catch (error) {
      report.total = 1
      report.failed.push({bookId: String(options.bookId || ''), title: '参考资料', message: resolveBackupError(error)})
      return report
    }
    if (!candidates.length) return report

    const localLibrary = getLocalLibraryStorage()
    const fileStem = dayjs(options.backupAt).format('YYYYMMDD-HHmmss')
    const payloads: Array<Record<string, unknown>> = []
    const pending: Array<{ bookId: string; updatedAt: string; title: string }> = []
    for (const candidate of candidates) {
      try {
        const data = await exportLocalBookReference(candidate.bookId)
        if (!data) {
          // 参考库清空也算"已同步"，记下印记避免每轮重查
          marks[candidate.bookId] = candidate.updatedAt
          continue
        }
        const detail = await localLibrary.getLocalBookDetail(candidate.bookId).catch(() => null)
        const bookTitle = String(detail?.title || `作品_${candidate.bookId}`)
        report.total += 1
        pending.push({ ...candidate, title: bookTitle })
        payloads.push({
          backupDir: options.backupDir,
          bookId: candidate.bookId,
          bookTitle,
          fileStem,
          content: JSON.stringify(
            {
              version: 1,
              exportedAt: new Date(options.backupAt).toISOString(),
              bookId: candidate.bookId,
              bookTitle,
              reference: data,
            },
            null,
            2
          ),
        })
      } catch (error) {
        report.total += 1
        report.failed.push({
          bookId: candidate.bookId,
          title: `作品_${candidate.bookId}`,
          message: resolveBackupError(error),
        })
      }
    }

    if (payloads.length) {
      try {
        const results = (await options.invoke('write_reference_backups', {
          payloads,
          retention: options.retention,
        })) as Array<{ bookId: string; error?: string | null }>
        for (const item of results || []) {
          const source = pending.find(entry => entry.bookId === String(item.bookId))
          if (!source) continue
          if (item.error) {
            report.failed.push({ bookId: source.bookId, title: source.title, message: item.error })
          } else {
            report.success += 1
            marks[source.bookId] = source.updatedAt
          }
        }
      } catch (error) {
        const message = resolveBackupError(error)
        for (const entry of pending) {
          report.failed.push({ bookId: entry.bookId, title: entry.title, message })
        }
      }
    }

    saveReferenceMarks(marks)
    return report
  }

}

let backupService: LocalBackupService | null = null

export const getLocalBackupService = () => {
  if (!backupService) {
    backupService = new LocalBackupService()
  }
  return backupService
}
