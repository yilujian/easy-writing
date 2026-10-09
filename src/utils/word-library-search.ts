import { match } from 'pinyin-pro'
import type { WordLibraryEntry } from '@/types/word-library'

export const searchWordLibrary = (entries: WordLibraryEntry[], query: string) => {
  const search = query.trim().toLocaleLowerCase().replace(/\s+/g, '')
  if (!search) return entries
  return entries.map((entry, index) => {
    const text = entry.text.toLocaleLowerCase()
    const rank = text === search ? 0 : text.startsWith(search) ? 1 : text.includes(search) ? 2
      : match(entry.text, search, { precision: 'start', continuous: true }) ? 3 : -1
    return { entry, rank, index }
  }).filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.entry)
}
