import dayjs from 'dayjs'
import type { Book } from '@/types'

/** 首页各卡共用的展示格式化；纯函数，无状态 */

export const formatWordCount = (value?: number | null) => {
  if (value === null) return '—'
  const safe = Math.max(0, Number(value) || 0)
  if (safe >= 10000) return `${(safe / 10000).toFixed(1)}万字`
  return `${safe}字`
}

export const formatUpdateTime = (value?: string) => {
  if (!value) return '暂无更新'
  const date = dayjs(value)
  if (!date.isValid()) return '暂无更新'
  const minutes = dayjs().diff(date, 'minute')
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = dayjs().diff(date, 'hour')
  if (hours < 24) return `${hours}小时前`
  const days = dayjs().diff(date, 'day')
  if (days < 30) return `${days}天前`
  return date.format('MM/DD')
}

const getBookTimestamp = (book?: Partial<Book>) => {
  const value = book?.updateTime || book?.createTime
  const date = dayjs(value)
  return date.isValid() ? date.valueOf() : 0
}

export const getSortedBooks = (list: Book[]) =>
  list.slice().sort((left, right) => getBookTimestamp(right) - getBookTimestamp(left))
