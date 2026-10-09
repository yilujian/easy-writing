import type { WordLibraryEntry } from '@/types/word-library'
import { getCharacterNames } from '@/utils/character-aliases'
import { mutateDoc, nextLocalId, readDoc } from './local-reference-store'

export const WORD_LIBRARY_CHANGED = 'ew-word-library-changed'
const notifyChanged = (bookId: string | number) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(WORD_LIBRARY_CHANGED, { detail: { bookId: String(bookId) } }))
}

export const listWordLibrary = async (bookId: string | number): Promise<WordLibraryEntry[]> => {
  const doc = await readDoc(bookId)
  const entries = new Map<string, WordLibraryEntry>()
  const add = (value: string, source: string, customId?: number) => {
    const text = value.trim()
    if (!text) return
    const entry = entries.get(text) || { text, sources: [] }
    if (!entry.sources.includes(source)) entry.sources.push(source)
    if (customId != null) entry.customId = customId
    entries.set(text, entry)
  }
  doc.commonWords.forEach(word => add(word.text, '自定义', word.id))
  doc.characters.forEach(character => getCharacterNames(character).forEach(name =>
    add(name, name === character.name.trim() ? '角色' : `别名 · ${character.name}`)))
  doc.worldSettings.forEach(setting => add(setting.name, '设定'))
  return [...entries.values()]
}

export const saveCommonWord = async (bookId: string | number, value: string, id?: number) => {
  const text = value.trim()
  if (!text) throw new Error('请输入词条内容')
  if (/[\r\n]/.test(text)) throw new Error('词条应为单行文字')
  if (Array.from(text).length > 200) throw new Error('词条最多 200 个字符，请选择一个词或短语')
  const saved = await mutateDoc(bookId, doc => {
    if (doc.commonWords.some(word => word.text === text && word.id !== id)) throw new Error('词条已存在')
    if (id != null) {
      const word = doc.commonWords.find(word => word.id === id)
      if (!word) throw new Error('词条不存在，请刷新后重试')
      word.text = text
      return word
    }
    const word = { id: nextLocalId(), text }
    doc.commonWords.push(word)
    return word
  })
  notifyChanged(bookId)
  return saved
}

export const deleteCommonWord = async (bookId: string | number, id: number) => {
  await mutateDoc(bookId, doc => { doc.commonWords = doc.commonWords.filter(word => word.id !== id) })
  notifyChanged(bookId)
}
