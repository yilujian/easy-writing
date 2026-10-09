import type { JsonRecord } from '@/types/json'
import type { NovelRankItem } from '@/types/novel-rank'
import { dict_data } from '@/config/fanqie-font-dict'
import { findRankCategory, type RankSeedSource } from '@/config/rank-sources'
import { isTauriRuntime } from '@/storage'
import { fetchQimaoRankPage } from '@/utils/local-rank-qimao'
import { fetchQidianRank } from '@/utils/local-rank-qidian'
import { crawlRankPageViaWindow } from '@/utils/local-rank-window'

/**
 * 榜单本机爬虫（移植自老服务端 statistics/service/rank 的番茄/七猫适配器）。
 *
 * - 桌面端走 @tauri-apps/plugin-http（可带 UA/Referer，不受跨域限制）；
 *   网页端浏览器直连必被跨域拦下，直接给可读提示——榜单抓取是桌面版功能。
 * - 番茄：抓榜单页 HTML（SSR 首屏，约头部 20-30 名；懒加载后续页归 V2），
 *   DOMParser 解析 + 私用区字体映射解码；乱码超半数熔断报错，保住上一份好快照。
 * - 七猫：官方 JSON 接口，按 meta.maxPages 翻页合并。
 * - 用户用自己的网络为自己抓公开榜单页，频控在存储层（每源每日一次，手动可刷）。
 */

const FETCH_TIMEOUT_MS = 30_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const resolveCrawlFetch = async (): Promise<FetchLike> => {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch as unknown as FetchLike
  }
  throw new Error('榜单抓取是桌面版功能：浏览器受跨域限制无法直接访问平台站点，请在桌面客户端使用')
}

const fetchWithTimeout = async (url: string, init: RequestInit) => {
  const crawlFetch = await resolveCrawlFetch()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await crawlFetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`目标站返回 HTTP ${response.status}`)
    return response
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`抓取超时（${FETCH_TIMEOUT_MS / 1000} 秒无响应）`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    window.clearTimeout(timer)
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// 通用小工具（与老适配器同口径）
// ---------------------------------------------------------------------------

const normalizeSpaces = (text: string) => String(text || '').replace(/\s+/g, ' ').trim()

/** 番茄私用区字体解码 */
const decodeFanqieText = (text: string) =>
  Array.from(String(text || ''))
    .map(char => (dict_data as Record<string, string>)[String(char.charCodeAt(0))] ?? char)
    .join('')

const countPuaChars = (text: string) => {
  let count = 0
  for (const char of String(text || '')) {
    const code = char.codePointAt(0) || 0
    if (code >= 0xe000 && code <= 0xf8ff) count += 1
  }
  return count
}

export const parseChineseNumber = (input: string) => {
  const match = normalizeSpaces(input).match(/([\d.]+)\s*([万亿]?)/)
  if (!match) return 0
  const value = Number(match[1])
  if (!Number.isFinite(value)) return 0
  const factor = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1
  return Math.round(value * factor)
}

const normalizeUrlAttr = (url?: string | null) => String(url || '').trim().replace(/&amp;/g, '&')

const toAbsoluteUrl = (base: string, maybePath?: string | null) => {
  const path = String(maybePath || '').trim()
  if (!path) return ''
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`
}

/** 从页面脚本里抠出 `marker = {...}` 的完整 JSON（字符串感知的括号配平） */
const extractAssignedJson = (raw: string, marker: string): string => {
  const input = String(raw || '')
  const index = input.indexOf(marker)
  if (index < 0) return ''
  let i = index + marker.length
  while (i < input.length && /\s/.test(input[i]!)) i += 1
  if (input[i] === '=') {
    i += 1
    while (i < input.length && /\s/.test(input[i]!)) i += 1
  }
  const start = i
  if (input[start] !== '{' && input[start] !== '[') return ''
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  for (let pos = start; pos < input.length; pos += 1) {
    const ch = input[pos] as string
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const last = stack.pop()
      if (!last || (ch === '}' && last !== '{') || (ch === ']' && last !== '[')) return ''
      if (!stack.length) return input.slice(start, pos + 1)
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// 番茄：HTML 解析（DOMParser 版，选择器与老 cheerio 实现一致）
// ---------------------------------------------------------------------------

const FANQIE_BASE = 'https://fanqienovel.com'

const isFanqiePlaceholderCover = (url?: string) => normalizeUrlAttr(url).includes('novel-static')

const pickBestCoverUrl = (candidates: Array<string | undefined>) => {
  const normalized = candidates.map(item => normalizeUrlAttr(item)).filter(Boolean)
  const real = normalized.find(url => url.includes('fqnovelpic.com/novel-pic/'))
  if (real) return real
  return normalized.find(url => !isFanqiePlaceholderCover(url)) || normalized[0] || ''
}

const coverMapFromInitialState = (html: string) => {
  const map = new Map<string, string>()
  const jsonText = extractAssignedJson(html, 'window.__INITIAL_STATE__')
  if (!jsonText) return map
  try {
    const state = JSON.parse(jsonText)
    const list = state?.rank?.book_list
    if (!Array.isArray(list)) return map
    for (const item of list) {
      const bookId = String(item?.bookId || '').trim()
      const thumbUri = String(item?.thumbUri || '').trim()
      if (bookId && thumbUri) map.set(bookId, toAbsoluteUrl('https:', thumbUri.startsWith('//') ? thumbUri : `//${thumbUri.replace(/^https?:\/\//, '')}`))
    }
  } catch {
    // INITIAL_STATE 结构变化时只损失封面，不影响条目
  }
  return map
}

export const parseFanqieRankHtml = (html: string): { pageTitle: string; cutoffText: string; items: NovelRankItem[] } => {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  const coverByBookId = coverMapFromInitialState(html)

  const pageTitle = normalizeSpaces(decodeFanqieText(doc.querySelector('.muye-rank-wrap-header h1')?.textContent || ''))
  const cutoffText = normalizeSpaces(decodeFanqieText(doc.querySelector('.muye-rank-wrap-header p')?.textContent || ''))

  const items: NovelRankItem[] = []
  doc.querySelectorAll('.muye-rank-book-list .rank-book-item').forEach((el, index) => {
    const text = (selector: string) => normalizeSpaces(el.querySelector(selector)?.textContent || '')
    const rankNo = Number(text('.book-item-index h1')) || index + 1

    const changeEl = el.querySelector('.book-item-index p')
    const changeAbs = Number(normalizeSpaces(changeEl?.textContent || '')) || 0
    const rankChange = changeEl?.querySelector('.up') ? changeAbs : changeEl?.querySelector('.down') ? -changeAbs : 0

    const bookAnchor = el.querySelector('.title a')
    const bookPath = bookAnchor?.getAttribute('href') || ''
    const bookTitle = normalizeSpaces(decodeFanqieText(bookAnchor?.textContent || ''))
    const bookUrl = normalizeUrlAttr(toAbsoluteUrl(FANQIE_BASE, bookPath))
    if (!bookTitle || !bookUrl) return
    const bookId = bookPath.match(/\/page\/(\d+)/)?.[1]

    const authorName = normalizeSpaces(decodeFanqieText(el.querySelector('.author a span')?.textContent || '')) || null

    const imgEl = el.querySelector('.book-cover img')
    const src = imgEl?.getAttribute('src') || undefined
    const dataSrc = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('data-original') || undefined
    const coverUrl = (bookId && coverByBookId.get(bookId)) || pickBestCoverUrl([src, dataSrc]) || null

    const readingText = normalizeSpaces(decodeFanqieText(text('.book-item-count'))) || null
    const lastChapterAnchor = el.querySelector('.book-item-footer-last a.chapter')
    const lastChapterTitle =
      normalizeSpaces(decodeFanqieText(normalizeSpaces(lastChapterAnchor?.textContent || '').replace(/^最近更新：/, ''))) || null

    items.push({
      rankNo,
      rankChange,
      bookTitle,
      bookId: bookId || null,
      bookUrl,
      authorName,
      coverUrl,
      intro: normalizeSpaces(decodeFanqieText(text('.desc'))) || null,
      statusText: text('.book-item-footer-status') || null,
      readingText,
      readingCount: readingText ? parseChineseNumber(readingText) : 0,
      metricName: '在读',
      metricText: readingText,
      metricValue: readingText ? parseChineseNumber(readingText) : 0,
      lastChapterTitle,
      lastChapterUrl: normalizeUrlAttr(toAbsoluteUrl(FANQIE_BASE, lastChapterAnchor?.getAttribute('href'))) || null,
      lastUpdateTimeText: text('.book-item-footer-time') || null,
      categoryName: null,
    })
  })

  // 字体乱码熔断：书名普遍残留私用区字符 = 番茄换了字体、静态字典失效——
  // 报错跳过入库，保住上一份好快照（继承老服务端同款保护）
  const garbled = items.filter(item => countPuaChars(item.bookTitle) >= 2).length
  if (items.length >= 3 && garbled / items.length > 0.5) {
    throw new Error('番茄字体解码失败（疑似目标站更换字体），本次不入库以保留上一份数据')
  }
  if (!items.length) {
    throw new Error('没有解析到榜单条目（页面结构可能已变更）')
  }
  return { pageTitle, cutoffText, items }
}

const fetchFanqieRank = async (url: string, maxPages: number) => {
  // 多页配置走隐藏窗口滚动懒加载（SSR 只给首屏 10 条）；
  // 窗口方案失败或未配置多页时退回直取首屏，宁少勿断
  if (maxPages > 1 && isTauriRuntime()) {
    try {
      const html = await crawlRankPageViaWindow(url, {
        waitSelector: '.muye-rank-book-list .rank-book-item',
        scrollRounds: Math.min(Math.max(maxPages * 6, 6), 30),
      })
      return parseFanqieRankHtml(html)
    } catch (error) {
      console.warn('番茄懒加载抓取失败，退回首屏直取', error)
    }
  }
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://fanqienovel.com/',
    },
  })
  return parseFanqieRankHtml(await response.text())
}

// ---------------------------------------------------------------------------
// 七猫：JSON 接口（与老适配器同字段映射）
// ---------------------------------------------------------------------------

const QIMAO_BASE = 'https://www.qimao.com'

export const parseQimaoRankJson = (input: unknown): NovelRankItem[] => {
  const root = (input && typeof input === 'object' ? input : {}) as JsonRecord
  const list = Array.isArray(root?.data?.table_data) ? root.data.table_data : []
  const items: NovelRankItem[] = []
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index] || {}
    const bookId = String(row.book_id || '').trim() || null
    const bookTitle = normalizeSpaces(String(row.title || ''))
    const bookUrl = String(row.book_url || '').trim() || toAbsoluteUrl(QIMAO_BASE, `/shuku/${bookId || ''}/`)
    if (!bookTitle || !bookUrl) continue
    const metricValue = (() => {
      const value = Number(String(row.number || '').trim())
      if (!Number.isFinite(value)) return 0
      const unit = String(row.unit || '').trim()
      return Math.round(value * (unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1))
    })()
    const direction = Number(String(row.index_change || '').trim())
    const magnitude = Number(String(row.surge_rank || '').trim())
    const latestChapterId = String(row.latest_chapter_id || '').trim()
    items.push({
      rankNo: index + 1,
      rankChange: Number.isFinite(magnitude) && magnitude > 0 && (direction === 1 || direction === -1) ? direction * magnitude : 0,
      bookTitle,
      bookId,
      bookUrl,
      authorName: normalizeSpaces(String(row.author || '')) || null,
      coverUrl: String(row.image_link || '').trim() || null,
      intro: String(row.intro || '').trim() || null,
      statusText: String(row.is_over || '').trim() === '1' ? '已完结' : '连载中',
      readingText: null,
      readingCount: 0,
      metricName: '热度',
      metricText: normalizeSpaces(`${String(row.number || '')}${String(row.unit || '')}`) || null,
      metricValue,
      lastChapterTitle: normalizeSpaces(String(row.latest_chapter_title || '')) || null,
      lastChapterUrl: latestChapterId ? toAbsoluteUrl(QIMAO_BASE, `/shuku/${bookId || ''}-${latestChapterId}/`) : null,
      lastUpdateTimeText: normalizeSpaces(String(row.update_time || '')) || null,
      categoryName: normalizeSpaces(String(row.category1_name || '')) || null,
      categorySubName: normalizeSpaces(String(row.category2_name || '')) || null,
    })
  }
  return items
}

const fetchQimaoRank = async (baseUrl: string, maxPages: number) => {
  const items: NovelRankItem[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= Math.max(1, Math.min(maxPages, 5)); page += 1) {
    const url = new URL(baseUrl)
    // 日榜固定年月会把快照写旧：清掉 date 用实时榜（继承老适配器口径）
    if (String(url.searchParams.get('date_type') || '') === '1') url.searchParams.set('date', '')
    url.searchParams.set('page', String(page))
    const pageItems = parseQimaoRankJson(await fetchQimaoRankPage(url.toString()))
    if (!pageItems.length) break
    for (const item of pageItems) {
      const key = item.bookId || item.bookUrl
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ ...item, rankNo: items.length + 1 })
    }
    if (page < maxPages) await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 500))
  }
  if (!items.length) throw new Error('七猫接口没有返回榜单条目（接口可能已变更）')
  return items
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export interface CrawledRank {
  items: NovelRankItem[]
  pageTitle?: string
  cutoffText?: string
}

/** 抓取一个榜单源（按站点分派适配器）；抛出的错误一律可读 */
export const crawlRankSource = async (source: RankSeedSource): Promise<CrawledRank> => {
  const maxPages = Number(source.meta?.maxPages || 1)
  if (source.siteCode === 'fanqie') {
    const parsed = await fetchFanqieRank(source.url, maxPages)
    // 番茄条目不带分类：从源配置补（每个分类一个榜单源）
    const category = findRankCategory(source.categoryLegacyId)
    const items = category
      ? parsed.items.map(item => ({ ...item, categoryName: category.name }))
      : parsed.items
    return { items, pageTitle: parsed.pageTitle, cutoffText: parsed.cutoffText }
  }
  if (source.siteCode === 'qimao') {
    return { items: await fetchQimaoRank(source.url, maxPages) }
  }
  if (source.siteCode === 'qidian') {
    return { items: await fetchQidianRank(source.url, maxPages) }
  }
  throw new Error(`站点 ${source.siteCode} 的抓取适配器尚未接入`)
}
