import { isTauriRuntime } from '@/storage/writing-storage'
import { writingCommand } from './client'

/**
 * 按用途选择上下文相关性；budgetTokens 仅控制可选检索材料的软目标。
 * 作者要求、选定技能及必要事实不受分层硬上限限制，最终容量按所选模型检查。
 */
export type EditorContextPurpose = 'ghost' | 'continue' | 'chat' | 'write'

const CACHE_MS = 30_000
const cache = new Map<string, { at: number; value: Promise<string> }>()

/**
 * 编辑器 AI 用的作品上下文（作者规则、否决约束、出场人物状态、前章概要等），由 Agent 上下文引擎装配。
 * 同一章同一用途 30 秒内复用；网页预览、没有状态层数据或调用失败时返回空串，编辑器照旧工作。
 */
export function editorContext(
  bookId: string,
  chapterId: string | number | null | undefined,
  purpose: EditorContextPurpose
): Promise<string> {
  if (!bookId || !isTauriRuntime()) return Promise.resolve('')
  ensureCanonListener()
  const key = `${bookId}:${chapterId ?? ''}:${purpose}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = writingCommand<{ ok?: boolean; rendered?: string }>('context', {
    bookId,
    chapterId: chapterId ? String(chapterId) : '',
    purpose: purpose === 'ghost' ? 'ghost' : purpose === 'chat' ? 'chat' : 'write',
    budgetTokens: { ghost: 0, continue: 2500, chat: 2000, write: 4000 }[purpose]
  })
    .then(result => (result?.ok ? String(result.rendered || '').trim() : ''))
    .catch(() => '')
  cache.set(key, { at: Date.now(), value })
  return value
}

type CanonListener = (bookId: string | null) => void
const canonListeners = new Set<CanonListener>()
let canonListening: Promise<void> | null = null

/** 宿主在索引写完章节卡、作者改规则/线索/疑点裁决时发 agent-canon-changed；先清掉该书的上下文缓存再通知面板 */
function ensureCanonListener() {
  if (canonListening || !isTauriRuntime()) return
  canonListening = import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ bookId?: string | null }>('agent-canon-changed', event => {
        const bookId = event.payload?.bookId ? String(event.payload.bookId) : null
        for (const key of [...cache.keys()]) if (!bookId || key.startsWith(`${bookId}:`)) cache.delete(key)
        canonListeners.forEach(listener => listener(bookId))
      })
    )
    .then(() => undefined)
    .catch(() => {
      canonListening = null
    })
}

/** 订阅作品状态变化；bookId 为空表示可能影响所有作品（例如删除了作者规则）。返回取消订阅函数 */
export function onCanonChanged(listener: CanonListener): () => void {
  ensureCanonListener()
  canonListeners.add(listener)
  return () => canonListeners.delete(listener)
}
