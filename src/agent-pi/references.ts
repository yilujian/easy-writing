import { getLocalLibraryStorage } from '@/storage/local-library'
import { readDoc } from '@/storage/local-reference-store'
import type { PiReference } from '@/types/agent-pi'

/** 作者在输入框里 @ 的作品资料跟在消息后面；模型按编号用工具读，界面只显示成小标签。 */
export const referenceMessage = (text: string, references: PiReference[]) =>
  references.length ? `${text}\n\n<yichuang-ref>${JSON.stringify(references)}</yichuang-ref>` : text
export function parseReferenceMessage(text: string): { text: string; references: PiReference[] } {
  const match = text.match(/\n\n<yichuang-ref>([^\n]*)<\/yichuang-ref>$/)
  if (!match) return { text, references: [] }
  try {
    const list = JSON.parse(match[1])
    if (!Array.isArray(list)) return { text, references: [] }
    const references = list.filter(
      (item): item is PiReference =>
        !!item &&
        typeof item === 'object' &&
        ['chapter', 'character', 'setting', 'outline', 'storyline', 'breakdown'].includes(item.kind) &&
        Number.isSafeInteger(item.id) &&
        typeof item.title === 'string'
    )
    return { text: text.slice(0, match.index), references }
  } catch {
    return { text, references: [] }
  }
}
export const REFERENCE_GROUPS: Record<PiReference['kind'], string> = {
  chapter: '章节',
  character: '人物',
  setting: '设定',
  outline: '大纲',
  storyline: '故事线',
  breakdown: '参考书'
}
export interface MentionItem extends PiReference {
  /** 列表里的补充说明，如章节所属的卷。 */
  hint?: string
}
/** @ 菜单的候选：当前作品的章节、人物、设定、大纲、故事线。 */
export async function listMentionItems(bookId: string): Promise<MentionItem[]> {
  if (!bookId) return []
  const [tree, doc] = await Promise.all([getLocalLibraryStorage().getLocalBookTree(bookId), readDoc(bookId)])
  const chapters: MentionItem[] = tree.flatMap(volume =>
    (volume.children || []).map(chapter => ({
      kind: 'chapter' as const,
      id: Number(chapter.id),
      title: String(chapter.title || `第 ${chapter.id} 章`),
      hint: String(volume.title || '')
    }))
  )
  const characters: MentionItem[] = doc.characters.map(c => ({ kind: 'character', id: c.id, title: c.name }))
  const settings: MentionItem[] = doc.worldSettings.map(s => ({ kind: 'setting', id: s.id, title: s.name }))
  const outlines: MentionItem[] = doc.outlineNodes
    .filter(node => node.nodeType === 1)
    .map(node => ({ kind: 'outline', id: node.id, title: node.title }))
  const storylines: MentionItem[] = doc.storylines.map(s => ({ kind: 'storyline', id: Number(s.id), title: String(s.title || '') }))
  return [...chapters, ...characters, ...settings, ...outlines, ...storylines].filter(
    item => Number.isSafeInteger(item.id) && item.title
  )
}
