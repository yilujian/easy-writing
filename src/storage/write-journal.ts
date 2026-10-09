import { appSettings } from '@/storage/app-settings'
/**
 * 本地写入取证日志。
 *
 * 丢稿类问题的最大障碍不是修不好，而是事后无法判断"到底写没写进去、写到哪儿了"。
 * 这里为每次章节落盘留一行记录：时间、存储键、字数、后端、回读校验结果。
 * 用户报障时把这个文件发回来即可定位，不必再靠推理。
 *
 * 成本控制：
 * - 成功记录在内存里攒批（5 秒或 20 条），失败记录立刻落盘——出问题的那一条最不能丢。
 * - 桌面端写应用数据目录（与库同盘，始终本地），按 1MB 轮转一份 .1 备份。
 * - 浏览器端没有文件系统，退化为 localStorage 环形缓冲，只留最近 200 条。
 */

import { isTauriRuntime, type WritingStorageBackend } from './writing-storage'

const FLUSH_INTERVAL_MS = 5000
const FLUSH_BATCH_SIZE = 20
const MAX_FILE_BYTES = 1024 * 1024
const WEB_JOURNAL_KEY = 'ew-write-journal'
const WEB_JOURNAL_LIMIT = 200

export interface WriteJournalEntry {
  at: number
  backend: WritingStorageBackend
  storageKey: string
  chars: number
  ok: boolean
  reason?: string
  /** 操作类型：save=落盘，load=打开章节读取，version=生成本地历史版本 */
  op?: 'save' | 'load' | 'version' | 'history' | 'guard'
  /** 补充上下文（如章节标题、切换前后的 id） */
  detail?: string
}

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let journalPath = ''
let journalPathPromise: Promise<string> | null = null

const formatLine = (entry: WriteJournalEntry) => {
  const time = new Date(entry.at).toISOString()
  const status = entry.ok ? 'ok' : `FAIL(${entry.reason || 'unknown'})`
  return [
    time,
    entry.op || 'save',
    entry.backend,
    entry.storageKey,
    entry.chars,
    status,
    entry.detail || '',
  ].join('\t')
}

const resolveJournalPath = async () => {
  if (journalPath) return journalPath
  if (!journalPathPromise) {
    journalPathPromise = (async () => {
      // 与 SQLite 库同一个应用数据目录：始终在本地磁盘，不受用户自定义备份目录影响
      //（备份目录可能被指到网盘或慢盘，逐次写日志会拖慢保存）。
      const { appDataDir, join } = await import('@tauri-apps/api/path')
      const path = await join(await appDataDir(), 'logs', 'write-journal.log')
      journalPath = path
      return path
    })().catch(error => {
      journalPathPromise = null
      throw error
    })
  }
  return await journalPathPromise
}

const writeWebJournal = (lines: string[]) => {
  try {
    const raw = appSettings.getItem(WEB_JOURNAL_KEY)
    const existed = raw ? String(raw).split('\n').filter(Boolean) : []
    const next = existed.concat(lines).slice(-WEB_JOURNAL_LIMIT)
    appSettings.setItem(WEB_JOURNAL_KEY, next.join('\n'))
  } catch {
    // 隐私模式或配额用尽：日志是辅助能力，失败不影响主流程。
  }
}

const writeDesktopJournal = async (lines: string[]) => {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('append_app_log', {
    filePath: await resolveJournalPath(),
    content: `${lines.join('\n')}\n`,
    maxBytes: MAX_FILE_BYTES,
  })
}

const flush = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!buffer.length) return
  const lines = buffer
  buffer = []
  try {
    if (isTauriRuntime()) await writeDesktopJournal(lines)
    else writeWebJournal(lines)
  } catch (error) {
    // 日志本身失败不能反过来影响写作：只在控制台留痕，不重新入队避免无限堆积。
    console.warn('写入取证日志失败', error)
  }
}

const scheduleFlush = () => {
  if (flushTimer) return
  flushTimer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS)
}

/** 章节打开时记录读取结果：用于比对"写进去的键"和"读出来的键"是否一致 */
export const recordChapterLoadJournal = (params: {
  backend: WritingStorageBackend
  storageKey: string
  chars: number
  found: boolean
  detail: string
}) => {
  recordWriteJournal({
    at: Date.now(),
    op: 'load',
    backend: params.backend,
    storageKey: params.storageKey,
    chars: params.chars,
    // 读不到草稿是本次排查的核心信号，按失败立即落盘，不进攒批队列
    ok: params.found,
    reason: params.found ? undefined : 'draft_missing',
    detail: params.detail,
  })
}

export const recordWriteJournal = (entry: WriteJournalEntry) => {
  buffer.push(formatLine(entry))
  // 失败记录立刻落盘：崩溃或强制关闭时，最需要留下的就是这一条。
  if (!entry.ok || buffer.length >= FLUSH_BATCH_SIZE) {
    void flush()
    return
  }
  scheduleFlush()
}

/** 关窗/刷新前把攒批的记录冲干净 */
export const flushWriteJournal = () => flush()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => void flush())
}
