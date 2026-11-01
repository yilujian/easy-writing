import { appSettings, flushAppSettings } from '@/storage/app-settings'
import { nowIso } from './local-library-utils'

/**
 * 微信助手本地状态：只记作者在微信里选的"当前作品"。
 *
 * 绑定凭据在 Rust 侧的 weixin-bot.json；对话在宿主的微信会话里；主动推送在宿主的投递队列（weixin_delivery）；
 * 写操作的确认由宿主的审批门按通道档案处理。与灵感便签同一存储通道（桌面端 SQLite 设置记录，网页端 localStorage）。
 */

const SESSION_KEY = 'ew-weixin-bot-session'
/**
 * 结构版本：低于此版本的旧记录（带过对话记忆与待确认操作）只保留当前作品。
 * v2（2026-10-11）：旧会话的历史里混进过模型编造的榜单，整体作废。
 */
const SESSION_VERSION = 2

export interface WeixinSession {
  version?: number
  currentBookId: string | null
  currentBookTitle: string | null
  updatedAt: string
}

const emptySession = (): WeixinSession => ({
  version: SESSION_VERSION,
  currentBookId: null,
  currentBookTitle: null,
  updatedAt: nowIso(),
})

export const getWeixinSession = (): WeixinSession => {
  let stored: Partial<WeixinSession> | null = null
  try {
    const raw = appSettings.getItem(SESSION_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    stored = parsed && typeof parsed === 'object' ? (parsed as Partial<WeixinSession>) : null
  } catch {
    // 读坏了直接回默认，当前作品可以重新选，不影响主功能
    stored = null
  }
  if (!stored) return emptySession()
  return {
    ...emptySession(),
    currentBookId: stored.currentBookId ?? null,
    currentBookTitle: stored.currentBookTitle ?? null,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : nowIso(),
  }
}

export const setWeixinCurrentBook = async (book: { id: string; title: string } | null): Promise<WeixinSession> => {
  const session: WeixinSession = {
    ...emptySession(),
    currentBookId: book ? String(book.id) : null,
    currentBookTitle: book ? book.title : null,
  }
  appSettings.setItem(SESSION_KEY, JSON.stringify(session))
  await flushAppSettings()
  return session
}
