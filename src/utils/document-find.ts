import type { Node as DocumentNode } from 'prosemirror-model'

export interface DocumentMatch {
  from: number
  to: number
}

/** 字面查找，跨同段落内的粗体/链接等文本节点；不跨段落或内联原子节点。 */
export function findDocumentMatches(doc: DocumentNode, query: string): DocumentMatch[] {
  const matches: DocumentMatch[] = []
  if (!query) return matches
  doc.descendants((node, position) => {
    if (!node.isTextblock) return
    let text = '',
      runStart = 0
    const scan = () => {
      let offset = 0
      while (offset <= text.length - query.length) {
        const found = text.indexOf(query, offset)
        if (found < 0) break
        matches.push({
          from: position + 1 + runStart + found,
          to: position + 1 + runStart + found + query.length
        })
        offset = found + query.length
      }
      text = ''
    }
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) runStart = offset
        text += child.text || ''
      } else scan()
    })
    scan()
    return false
  })
  return matches
}
