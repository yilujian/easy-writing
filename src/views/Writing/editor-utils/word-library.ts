import type { Editor } from '@tiptap/core'
import { closeHistory } from 'prosemirror-history'

export const WORD_LIBRARY_INSERT = 'wordLibraryInsert'
export const SUPPRESS_AI_SUGGESTION = 'suppressAiSuggestion'

/** 纯文本插入且单独成组，保留正文现有标记，不把内容当作 HTML。 */
export const insertLibraryWord = (editor: Editor, text: string, from: number, to: number) => {
  const transaction = closeHistory(editor.state.tr).insertText(text, from, to)
    .setMeta(WORD_LIBRARY_INSERT, true).setMeta(SUPPRESS_AI_SUGGESTION, true)
  editor.view.dispatch(transaction)
  editor.view.dispatch(closeHistory(editor.state.tr))
}
