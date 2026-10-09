import { withRecordStore } from './desktop-records'
import { createLocalEntityId, nowIso } from './local-library-utils'

/**
 * 妙笔对话本地库：替代旧服务端 /ai/chat/* 会话与历史通道。
 * 会话按书分组、消息按会话整包存 IndexedDB；函数返回 { data } 信封，面板只换 import。
 */

export interface LocalChatSession {
  id: number
  bookId: string
  title: string
  createTime: string
  updateTime: string
}

export interface LocalChatMessage {
  id: number
  role: 'user' | 'ai'
  content: string
  createTime: string
}

const DB_NAME = 'ew-local-ai-chat'
const STORE_NAME = 'kv'

const withStore = <T>(mode: IDBTransactionMode, run: Parameters<typeof withRecordStore>[4]) =>
  withRecordStore<T>(DB_NAME, STORE_NAME, undefined, mode, run)

const sessionsKey = (bookId: string | number) => `sessions:${bookId}`
const messagesKey = (sessionId: string | number) => `messages:${sessionId}`

const readList = async <T>(key: string): Promise<T[]> => {
  const stored = await withStore<unknown>('readonly', store => store.get(key))
  return Array.isArray(stored) ? (stored as T[]) : []
}

const writeList = async (key: string, list: unknown[]) => {
  await withStore('readwrite', store => store.put(JSON.parse(JSON.stringify(list)), key))
}

/** 会话按实体 id 反查所属书的会话列表键（改名/删除只带会话 id） */
const findSessionsKeyById = async (sessionId: number): Promise<string | null> => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  for (const key of keys) {
    const text = String(key)
    if (!text.startsWith('sessions:')) continue
    const sessions = await readList<LocalChatSession>(text)
    if (sessions.some(session => session.id === sessionId)) return text
  }
  return null
}

export const listLocalChatSessions = async (params: { bookId: string }) => {
  const sessions = await readList<LocalChatSession>(sessionsKey(params.bookId))
  const sorted = [...sessions].sort((a, b) => b.updateTime.localeCompare(a.updateTime))
  return { data: sorted }
}

export const createLocalChatSession = async (data: { bookId: string; firstQuestion?: string }) => {
  const title = String(data.firstQuestion || '').trim().slice(0, 20) || '新对话'
  const session: LocalChatSession = {
    id: createLocalEntityId(),
    bookId: String(data.bookId),
    title,
    createTime: nowIso(),
    updateTime: nowIso(),
  }
  const key = sessionsKey(data.bookId)
  const sessions = await readList<LocalChatSession>(key)
  sessions.push(session)
  await writeList(key, sessions)
  return { data: session }
}

export const getLocalChatHistory = async (params: { sessionId: string }) => {
  const messages = await readList<LocalChatMessage>(messagesKey(params.sessionId))
  return { data: messages }
}

export const deleteLocalChatSessions = async (data: { ids: number[] }) => {
  for (const id of data.ids) {
    const key = await findSessionsKeyById(id)
    if (key) {
      const sessions = await readList<LocalChatSession>(key)
      await writeList(key, sessions.filter(session => session.id !== id))
    }
    await withStore('readwrite', store => store.delete(messagesKey(id)))
  }
  return { data: true }
}

export const renameLocalChatSession = async (data: { id: number; title: string }) => {
  const key = await findSessionsKeyById(data.id)
  if (!key) throw new Error('会话不存在')
  const sessions = await readList<LocalChatSession>(key)
  const session = sessions.find(item => item.id === data.id)
  if (!session) throw new Error('会话不存在')
  session.title = String(data.title || '').trim() || session.title
  session.updateTime = nowIso()
  await writeList(key, sessions)
  return { data: session }
}

export const deleteLocalChatMessage = async (data: { id: number }) => {
  const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys())
  for (const key of keys) {
    const text = String(key)
    if (!text.startsWith('messages:')) continue
    const messages = await readList<LocalChatMessage>(text)
    if (messages.some(message => message.id === data.id)) {
      await writeList(text, messages.filter(message => message.id !== data.id))
      return { data: true }
    }
  }
  return { data: true }
}

/** 一轮问答落库（面板流式结束时调用），并顶新会话的更新时间 */
export const appendLocalChatMessages = async (
  sessionId: number,
  entries: Array<{ role: 'user' | 'ai'; content: string }>
) => {
  const key = messagesKey(sessionId)
  const messages = await readList<LocalChatMessage>(key)
  for (const entry of entries) {
    messages.push({
      id: createLocalEntityId(),
      role: entry.role,
      content: entry.content,
      createTime: nowIso(),
    })
  }
  await writeList(key, messages)
  const sessionsKeyText = await findSessionsKeyById(sessionId)
  if (sessionsKeyText) {
    const sessions = await readList<LocalChatSession>(sessionsKeyText)
    const session = sessions.find(item => item.id === sessionId)
    if (session) {
      session.updateTime = nowIso()
      await writeList(sessionsKeyText, sessions)
    }
  }
  return { data: true }
}
