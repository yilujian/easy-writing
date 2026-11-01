import { RANK_AUTO_CRAWLED_EVENT } from '@/storage/writing-storage'
import type { WorkflowRealtimeEvent } from '@/types/workflow'
import { subscribeAllLocalWorkflowEvents } from '@/utils/local-workflow-runtime'
import { writingCommand } from '@/writing-service/client'
import { previewText, weixinLog } from './logfile'

/**
 * 微信助手·主动推送（前端这一半）。
 *
 * 推送本身现在由宿主的投递队列负责（weixin_delivery）：推得出去就发，推不出去留在队列里，
 * 作者下次发消息、宿主拿到新会话令牌时补发；同一事件键十分钟内只送一次；推送也记进微信对话记录。
 * 这里只把网页层才知道的事件翻成一句话交给宿主：自动生文的完成 / 待质检 / 中断，榜单自动抓取完成。
 *
 * 本模块随通道层在启动时加载，顶部只能引轻量模块；查书名这类重操作在事件到来时按需引入。
 */

export type WeixinNotifyOutcome = 'sent' | 'queued' | 'skipped'

const NOTIFIED_EVENT_TYPES = new Set<WorkflowRealtimeEvent['type']>(['done', 'quality-review', 'error'])

let unsubscribeWorkflow: (() => void) | null = null
let rankListener: ((event: Event) => void) | null = null

/** 交给宿主投递队列推一条通知；返回这条最终去了哪 */
export const notifyWeixin = async (text: string, key = ''): Promise<WeixinNotifyOutcome> => {
  const content = String(text || '').trim()
  if (!content) return 'skipped'
  try {
    const result = await writingCommand<{ outcome: WeixinNotifyOutcome }>('automation_notify', { text: content, key, channel: 'weixin' })
    weixinLog('info', `push-${result.outcome}`, { key, chars: content.length, text: previewText(content) })
    return result.outcome
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[微信助手] 通知没交到宿主', error)
    weixinLog('warn', 'push-failed', { key, chars: content.length, error: reason })
    return 'skipped'
  }
}

// ---------------------------------------------------------------------------
// 事件 → 通知文字
// ---------------------------------------------------------------------------

export const describeWorkflowEvent = async (event: WorkflowRealtimeEvent): Promise<string> => {
  if (!NOTIFIED_EVENT_TYPES.has(event.type)) return ''
  const [{ readLocalWorkflowRun }, { getLocalLibraryStorage }] = await Promise.all([
    import('@/storage/local-workflow'),
    import('@/storage/local-library'),
  ])
  const run = await readLocalWorkflowRun(event.runId).catch(() => null)
  const library = getLocalLibraryStorage()
  const book = run?.bookId ? await library.getLocalBookDetail(run.bookId).catch(() => null) : null
  const name = book ? `《${book.title}》` : run?.title ? `「${run.title}」` : '建书任务'
  const payload = event.payload || {}
  switch (event.type) {
    case 'done': {
      const remaining = Number(payload.remainingChapters ?? 0)
      return `${name}这一卷的自动生文写完了${remaining > 0 ? `，后面还有 ${remaining} 章待写` : '，计划内的章节已写齐'}。回到电脑前可以在写作台看稿。`
    }
    case 'quality-review': {
      const chapterId = Number(payload.chapterId || 0)
      const chapter = chapterId ? await library.getLocalChapterById(chapterId).catch(() => null) : null
      return `${name}${chapter ? `《${chapter.title}》` : '新一章'}写完了，质检发现需要你确认的问题，自动生文已停下等你处理。`
    }
    case 'error':
      return `${name}自动生文中断：${String(payload.message || '未知错误')}。`
    default:
      return ''
  }
}

const onWorkflowEvent = async (event: WorkflowRealtimeEvent) => {
  if (!NOTIFIED_EVENT_TYPES.has(event.type)) return
  const text = await describeWorkflowEvent(event).catch(() => '')
  const chapterKey = event.type === 'quality-review' ? `:${String(event.payload?.chapterId || '')}` : ''
  await notifyWeixin(text, `workflow:${event.runId}:${event.type}${chapterKey}`)
}

const onRankCrawled = (event: Event) => {
  const detail = ((event as CustomEvent).detail || {}) as { date?: string; summary?: string }
  const summary = String(detail.summary || '榜单自动抓取完成')
  void notifyWeixin(`${summary}（${detail.date || '今天'}）。想看风向直接问我。`, `rank-auto:${detail.date || ''}`)
}

export const startWeixinNotifier = () => {
  if (unsubscribeWorkflow) return
  unsubscribeWorkflow = subscribeAllLocalWorkflowEvents(event => void onWorkflowEvent(event))
  if (typeof window !== 'undefined') {
    rankListener = onRankCrawled
    window.addEventListener(RANK_AUTO_CRAWLED_EVENT, rankListener)
  }
}

export const stopWeixinNotifier = () => {
  unsubscribeWorkflow?.()
  unsubscribeWorkflow = null
  if (rankListener && typeof window !== 'undefined') window.removeEventListener(RANK_AUTO_CRAWLED_EVENT, rankListener)
  rankListener = null
}
