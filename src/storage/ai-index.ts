import { writingCommand } from '@/writing-service/client'
import { usesSqliteCore } from './storage-mode'

/**
 * 正文检索的前端门面：索引由宿主的索引器按变更事件自动维护（正文保存即入队），
 * 前端不再自己切块、建索引或补向量。检索走状态层的全文索引（三字以上 FTS，短词 LIKE）。
 * 索引只在正文存于本机 SQLite 时可用；浏览器预览模式下调用方退回逐章扫描。
 */

export interface AiBookIndexOutcome {
  total: number
  indexed: number
  skipped: number
  removed: number
  millis: number
}

export interface AiTextSearchHit {
  chapterId: string
  chunkId: number
  seq: number
  /** 越小越相关 */
  score: number
  snippet: string
}

export interface AiTextSearchResult {
  hits: AiTextSearchHit[]
  scannedChapters: number
  indexedChapters?: number
}

export const canUseAiIndex = () => usesSqliteCore()

/**
 * 检索前的追赶：新保存的章节由触发器自动入队，索引器装上之前写好的旧书没有事件，
 * 这里把还没有章节卡的章交给索引器补（已在队列或已有卡的不重复）。索引器需要一个文本模型。
 */
export const aiIndexBook = async (bookId: string | number): Promise<AiBookIndexOutcome> => {
  const started = Date.now()
  const outcome = await writingCommand<{ queued: number }>('index_rebuild', { bookId: String(bookId), onlyMissing: true })
  return { total: outcome.queued, indexed: 0, skipped: 0, removed: 0, millis: Date.now() - started }
}

export const aiSearchText = (params: {
  bookId: string | number
  query: string
  /** 只查该章及之前；不传查全书 */
  untilChapterId?: string | number | null
  limit?: number
}) =>
  writingCommand<AiTextSearchResult>('canon_query', {
    bookId: String(params.bookId),
    view: 'search',
    query: params.query,
    untilChapterId: params.untilChapterId == null ? '' : String(params.untilChapterId),
    limit: params.limit,
  })
