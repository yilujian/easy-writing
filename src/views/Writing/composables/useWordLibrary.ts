import { nextTick, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import type { Node } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { ElMessage } from 'element-plus'
import { listWordLibrary, saveCommonWord } from '@/storage/local-word-library'
import type { WordLibraryEntry } from '@/types/word-library'

import { insertLibraryWord, SUPPRESS_AI_SUGGESTION, WORD_LIBRARY_INSERT } from '../editor-utils/word-library'

export const useWordLibrary = (options: {
  editor: Ref<Editor | undefined>
  bookId: () => string | number | undefined
  chapterId: () => number | null
  canInsert: () => boolean
}) => {
  const visible = ref(false)
  const loading = ref(false)
  const error = ref('')
  const entries = shallowRef<WordLibraryEntry[]>([])
  const position = ref({ left: 0, top: 0 })
  let anchor: { editor: Editor; bookId: string; chapterId: number; doc: Node; from: number; to: number } | null = null
  let revision = 0

  const close = (focus = true) => {
    const previous = anchor
    visible.value = false
    anchor = null
    revision++
    if (focus && previous && !previous.editor.isDestroyed && previous.editor === options.editor.value
      && previous.bookId === String(options.bookId()) && previous.chapterId === options.chapterId()) previous.editor.view.focus()
  }

  const movePopup = () => {
    if (!anchor || anchor.editor.isDestroyed) return close(false)
    const rect = anchor.editor.view.coordsAtPos(anchor.to)
    const height = Math.min(350, window.innerHeight - 24)
    position.value = {
      left: Math.max(12, Math.min(rect.left, window.innerWidth - Math.min(360, window.innerWidth - 24) - 12)),
      top: rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - height - 8),
    }
  }

  const open = async () => {
    if (visible.value) { close(); return }
    const editor = options.editor.value
    if (!editor || editor.isDestroyed || !options.canInsert() || !editor.isEditable || !options.chapterId() || editor.view.composing) return
    anchor = { editor, doc: editor.state.doc, from: editor.state.selection.from, to: editor.state.selection.to,
      bookId: String(options.bookId()), chapterId: options.chapterId()! }
    visible.value = true
    loading.value = true
    error.value = ''
    entries.value = []
    const request = ++revision
    // 元数据同时取消在途建议、清空幽灵字；不改变正文和历史。
    editor.view.dispatch(editor.state.tr.setMeta(SUPPRESS_AI_SUGGESTION, true).setMeta('addToHistory', false))
    movePopup()
    try {
      const words = await listWordLibrary(anchor.bookId)
      if (request === revision) entries.value = words
    } catch (cause) {
      if (request === revision) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (request === revision) loading.value = false
    }
  }

  const insert = (text: string) => {
    const target = anchor
    if (!target || !options.canInsert() || target.editor.isDestroyed || !target.editor.isEditable
      || target.editor !== options.editor.value || target.bookId !== String(options.bookId())
      || target.chapterId !== options.chapterId() || !target.doc.eq(target.editor.state.doc)) {
      close(false)
      ElMessage.info('正文状态已变化，请重新取词')
      return
    }
    if (!entries.value.some(entry => entry.text === text)) return
    const editor = target.editor
    insertLibraryWord(editor, text, target.from, target.to)
    close()
  }

  const addSelection = async () => {
    const editor = options.editor.value
    if (!editor || !options.bookId()) return
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n').trim()
    if (!text) return
    try {
      await saveCommonWord(options.bookId()!, text)
      ElMessage.success('已加入本书词库')
    } catch (cause) {
      ElMessage.warning(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleUpdate = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.getMeta(WORD_LIBRARY_INSERT) && visible.value && anchor && !anchor.doc.eq(anchor.editor.state.doc)) close(false)
  }
  watch(options.editor, (editor, previous) => {
    previous?.off('update', handleUpdate)
    close(false)
    editor?.on('update', handleUpdate)
  }, { immediate: true })
  watch(() => [options.bookId(), options.chapterId(), options.canInsert()], () => close(false))
  watch(visible, async value => {
    if (value) {
      window.addEventListener('resize', movePopup)
      window.addEventListener('scroll', movePopup, true)
      await nextTick()
      movePopup()
    } else {
      window.removeEventListener('resize', movePopup)
      window.removeEventListener('scroll', movePopup, true)
    }
  })
  onBeforeUnmount(() => {
    options.editor.value?.off('update', handleUpdate)
    close(false)
    window.removeEventListener('resize', movePopup)
    window.removeEventListener('scroll', movePopup, true)
  })
  return { visible, loading, error, entries, position, open, close, insert, addSelection }
}
