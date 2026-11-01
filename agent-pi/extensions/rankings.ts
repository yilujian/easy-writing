import type { PiRankRefreshSource } from '../../src/types/pi-rankings.js'

type Result = { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }
type Call = (tool: string, args: Record<string, unknown>, id: string, signal?: AbortSignal) => Promise<Result>
type Entry = { type: string; customType?: string; data?: unknown }
const publicSource = (source: Record<string, unknown>) => {
  const { id: _id, estimatedSeconds: _estimate, needsRefresh: _refresh, ...value } = source
  return value
}
const response = (details: Record<string, unknown>): Result => {
  // 刷新计划和确认原文供平台执行、展示和留档；模型只接收实际资料与处理结果。
  const {
    refreshSources: _plans,
    refreshSource: _plan,
    questionSpec: _question,
    answer: _answer,
    ...data
  } = details
  if (data.source && typeof data.source === 'object')
    data.source = publicSource(data.source as Record<string, unknown>)
  if (Array.isArray(data.sources))
    data.sources = data.sources.map(source =>
      source.source ? { ...source, source: publicSource(source.source) } : publicSource(source)
    )
  return { content: [{ type: 'text', text: JSON.stringify(data) }], details }
}
export function refreshResultText(result: Record<string, unknown>): string {
  if (result.cancelled) return '已取消本次榜单刷新，未启动抓取。'
  if (result.refreshChoice === 'local') return '本次没有联网更新榜单。'
  if (result.current) return '本次范围均有当天缓存，未重复抓取。'
  if (result.blocked || result.needsScope || result.needsSelection) return String(result.reason)
  if (!Array.isArray(result.sources)) throw new Error('平台未返回刷新结果')
  const crawled = result.sources.filter(source => source.crawled === true).length
  return `榜单刷新处理完成：实际抓取 ${crawled} 个，复用缓存 ${result.sources.length - crawled} 个。`
}

/** 刷新确认和会话去重由平台负责；问答本身继续保存在 Pi 原生历史。 */
export function rankingTools(call: Call, append: (type: string, data: unknown) => void) {
  const asked = new Set<number>()
  const restore = (entries: Entry[]) => {
    asked.clear()
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== 'yichuang-ranking-choice') continue
      const data = entry.data as { sourceIds?: number[] } | undefined
      for (const id of data?.sourceIds || []) asked.add(id)
    }
  }
  const confirm = async (
    sources: PiRankRefreshSource[],
    sessionId: unknown,
    id: string,
    signal?: AbortSignal,
    standalone = false
  ) => {
    const seconds = sources.reduce((sum, source) => sum + source.estimatedSeconds[1], 0)
    const duration = seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`
    const localCount = sources.filter(source => source.latestDate).length
    const result = await call(
      'ask_author',
      {
        sessionId,
        kind: 'confirm',
        question:
          sources.length === 1
            ? '要联网获取最新榜单吗？'
            : `要联网获取以下 ${sources.length} 个榜单的最新数据吗？`,
        description:
          sources
            .map(
              source =>
                `${source.name}（${source.latestDate ? '本地榜单日期：' + source.latestDate : '本地暂无数据'}）`
            )
            .join('\n') + `\n联网更新预计最长用时：${duration}。`,
        options: [
          { id: 'refresh', title: '联网获取最新榜单', description: '从平台获取上面列出的榜单。' },
          {
            id: 'local',
            title: localCount ? '沿用本地榜单' : '跳过更新',
            description: !localCount
              ? '本地暂无数据，本次跳过这些榜单。'
              : localCount < sources.length
                ? '使用已有日期的数据，跳过本地没有的榜单。'
                : '使用上面日期的数据，本次不联网。'
          }
        ],
        allowFreeText: false
      },
      id + ':confirm',
      signal
    )
    signal?.throwIfAborted()
    const selected = (result.details.selectedIds as string[] | undefined)?.[0]
    const choice = result.details.cancelled
      ? 'cancel'
      : selected === 'refresh' || selected === 'local'
        ? selected
        : 'cancel'
    for (const source of sources) asked.add(source.id)
    append('yichuang-ranking-choice', {
      sourceIds: sources.map(source => source.id),
      choice,
      answeredAt: result.details.answeredAt || Date.now(),
      ...(standalone
        ? {
            standalone: true,
            operationId: id,
            questionSpec: result.details.questionSpec,
            answer: result.details
          }
        : {})
    })
    return { choice, answer: result.details }
  }
  const refreshSources = async (
    sources: PiRankRefreshSource[],
    sessionId: unknown,
    id: string,
    signal?: AbortSignal
  ) => {
    const results = []
    for (const source of sources) {
      const result = (
        await call(
          'refresh_rankings',
          { queries: [source.query], sessionId, onlyOutdated: true },
          id + ':' + source.id,
          signal
        )
      ).details
      if (result.reason === 'disabled')
        throw new Error('榜单抓取已关闭，本次未刷新；请按作者意愿使用现有资料或调整榜单设置。')
      results.push({
        source: result.source,
        reason: result.reason,
        crawled: result.crawled,
        freshness: result.freshness
      })
    }
    return results
  }
  const cancel = (answer: Record<string, unknown>) =>
    response({
      cancelled: true,
      message: '作者取消了本次榜单操作，请停止相关查询；未启动刷新。',
      questionSpec: answer.questionSpec,
      answer
    })
  return {
    restore,
    async read(params: Record<string, unknown>, id: string, signal?: AbortSignal) {
      const current = await call('read_rankings', params, id + ':read', signal)
      if (current.details.cacheOnly === true || params.cacheOnly === true) return response(current.details)
      const sources = ((current.details.refreshSources || []) as PiRankRefreshSource[]).filter(
        source => !asked.has(source.id)
      )
      if (!sources.length) return response(current.details)
      const decision = await confirm(sources, params.sessionId, id, signal)
      if (decision.choice === 'cancel') return cancel(decision.answer)
      if (decision.choice === 'local')
        return response({
          ...current.details,
          refreshChoice: 'local',
          questionSpec: decision.answer.questionSpec,
          answer: decision.answer
        })
      const refreshed = await refreshSources(sources, params.sessionId, id + ':refresh', signal)
      const latest = await call('read_rankings', params, id + ':reread', signal)
      return response({
        ...latest.details,
        refreshResults: refreshed.map(result => ({
          source: result.source,
          reason: result.reason,
          crawled: result.crawled
        })),
        questionSpec: decision.answer.questionSpec,
        answer: decision.answer
      })
    },
    async refresh(params: Record<string, unknown>, id: string, signal?: AbortSignal) {
      const preview = await call(
        'read_rankings',
        { queries: params.queries, prepareRefresh: true, sessionId: params.sessionId },
        id + ':preview',
        signal
      )
      if (preview.details.blocked || preview.details.needsScope || preview.details.needsSelection)
        return preview
      const sources = preview.details.sources as PiRankRefreshSource[]
      if (!sources?.length) throw new Error('平台未返回本次实际范围，尚未发起刷新确认')
      const outdated = sources.filter(source => source.needsRefresh)
      if (!outdated.length)
        return response({ current: true, message: '本次范围已有当天数据，未重复抓取。', sources })
      const decision = await confirm(outdated, params.sessionId, id, signal, params.standalone === true)
      if (decision.choice === 'cancel') return cancel(decision.answer)
      if (decision.choice === 'local')
        return response({
          refreshChoice: 'local',
          sources,
          questionSpec: decision.answer.questionSpec,
          answer: decision.answer
        })
      return response({
        sources: await refreshSources(outdated, params.sessionId, id + ':refresh', signal),
        questionSpec: decision.answer.questionSpec,
        answer: decision.answer
      })
    }
  }
}
