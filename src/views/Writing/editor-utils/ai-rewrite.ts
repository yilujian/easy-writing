import type { Editor } from '@tiptap/vue-3'
import { Slice } from 'prosemirror-model'
import type { AiRewriteResult } from '@/types/writing-ai'

export function applyAiRewrite(editor: Editor, from: number, to: number, text: string): AiRewriteResult {
  const doc = editor.state.doc
  const original = doc.textBetween(from, to, '\n')
  const originalSlice = doc.slice(from, to).toJSON()
  editor.chain().focus().setTextSelection({ from, to }).insertContent(text).run()
  // 跨段替换会合并节点，文档位置不能按字符串长度推算。
  return { original, originalSlice, from, to: to + editor.state.doc.content.size - doc.content.size }
}

export function restoreAiRewrite(editor: Editor, range: { from: number; to: number }, originalSlice: unknown) {
  const slice = Slice.fromJSON(editor.schema, originalSlice)
  editor.view.dispatch(editor.state.tr.replaceRange(range.from, range.to, slice))
}
