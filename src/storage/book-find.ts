import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { DOMParser as ProseMirrorParser, Node as DocumentNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { findDocumentMatches, type DocumentMatch } from '@/utils/document-find'
import { normalizeEditorContentPayload } from '@/views/Writing/editor-utils/content-normalize'
import { getWritingStorage, type StoredLocalChapterDraft, type ChapterReplacementBatch } from '@/storage'
import { getLocalLibraryStorage } from './local-library'
import { LOCAL_USER_ID } from './local-library-utils'
import { recordChapterWords } from './local-write-stats'
import { countWords, countTextWords } from '@/utils/word-count'

const schema = getSchema([StarterKit])
export interface BookFindChapter {
  chapterId: number
  title: string
  volumeTitle: string
  draft: StoredLocalChapterDraft
  doc: DocumentNode
  matches: DocumentMatch[]
  snippet: { before: string; match: string; after: string }
  readOnly: boolean
}
export interface BookFindResult {
  bookId: string
  query: string
  chapters: BookFindChapter[]
  total: number
}
export function draftDocument(
  draft: Pick<StoredLocalChapterDraft, 'contentJson' | 'textContent'>
): DocumentNode {
  const source = normalizeEditorContentPayload(draft.contentJson ?? draft.textContent)
  if (typeof source !== 'string') {
    const node = DocumentNode.fromJSON(schema, source)
    if (node.type !== schema.topNodeType) throw new Error('章节正文结构无效，请先打开该章检查')
    node.check()
    return node
  }
  const root = document.createElement('div')
  root.innerHTML = source
  return ProseMirrorParser.fromSchema(schema).parse(root)
}
export function replaceDocumentMatches(doc: DocumentNode, query: string, replacement: string) {
  const matches = findDocumentMatches(doc, query)
  const tr = EditorState.create({ doc, schema: doc.type.schema }).tr
  for (let index = matches.length - 1; index >= 0; index--) {
    tr.insertText(replacement, matches[index].from, matches[index].to)
  }
  return { doc: tr.doc, count: matches.length }
}

/** 按目录顺序检索正文，不包含已删除章节、设定或参考书。 */
export async function findInBook(
  bookId: string | number,
  query: string,
  cancelled: () => boolean = () => false
): Promise<BookFindResult> {
  const result: BookFindResult = { bookId: String(bookId), query, chapters: [], total: 0 }
  if (!query) return result
  const library = getLocalLibraryStorage(),
    storage = getWritingStorage()
  const book = await library.getLocalBookDetail(bookId)
  if (!book || book.deletedAt) throw new Error('作品不存在或已删除')
  const tree = await library.getLocalBookTree(bookId)
  const drafts = new Map(
    (await storage.listBookChapters(LOCAL_USER_ID, bookId)).map(draft => [draft.chapterId, draft])
  )
  let visited = 0
  for (const volume of tree)
    for (const chapter of volume.children) {
      if (cancelled()) throw new DOMException('搜索已取消', 'AbortError')
      const draft = drafts.get(chapter.id)
      if (!draft) continue
      const doc = draftDocument(draft),
        matches = findDocumentMatches(doc, query)
      if (matches.length) {
        const first = matches[0]
        result.chapters.push({
          chapterId: chapter.id,
          title: chapter.title,
          volumeTitle: volume.title,
          draft,
          doc,
          matches,
          readOnly: Boolean(draft.conflict || draft.workflowPreview || chapter.workflowStatus),
          snippet: {
            before: doc.textBetween(Math.max(0, first.from - 24), first.from, ' '),
            match: query,
            after: doc.textBetween(first.to, Math.min(doc.content.size, first.to + 40), ' ')
          }
        })
        result.total += matches.length
      }
      if (++visited % 30 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
  return result
}

export function prepareBookReplacement(result: BookFindResult, replacement: string): ChapterReplacementBatch {
  if (!result.query || replacement === result.query) throw new Error('查找词和替换词相同，无需替换')
  if (result.chapters.some(chapter => chapter.readOnly))
    throw new Error('匹配章节中包含生成中、待确认或存在冲突的正文，请先处理后再替换')
  return {
    operationId: crypto.randomUUID(),
    bookId: result.bookId,
    query: result.query,
    replacement,
    edits: result.chapters.map(chapter => {
      const next = replaceDocumentMatches(chapter.doc, result.query, replacement)
      return {
        chapterId: chapter.chapterId,
        expectedVersion: chapter.draft.localVersion,
        expectedText: chapter.draft.textContent,
        expectedJson: chapter.draft.contentJson,
        expectedTitle: chapter.draft.title,
        textContent: next.doc.textBetween(0, next.doc.content.size, '\n'),
        contentJson: next.doc.toJSON(),
        count: next.count
      }
    })
  }
}

export async function applyBookReplacement(batch: ChapterReplacementBatch) {
  const storage = getWritingStorage(),
    library = getLocalLibraryStorage()
  const changed = await storage.replaceChapters(batch)
  // 计数只是派生数据，正文与历史已经原子提交；刷新失败不把正文成功伪装成失败。
  let warning = ''
  try {
    for (const edit of batch.edits) {
      const current = await storage.getChapterByIdentity(LOCAL_USER_ID, batch.bookId, edit.chapterId)
      // 回执重读不能把后来编辑的字数基线退回本次替换结果。
      if (
        !current ||
        current.localVersion !== edit.expectedVersion + 1 ||
        current.textContent !== edit.textContent
      )
        continue
      recordChapterWords(
        batch.bookId,
        edit.chapterId,
        countWords(edit.textContent),
        countTextWords(edit.textContent)
      )
      await library.updateLocalChapterContentMeta({
        bookId: batch.bookId,
        chapterId: edit.chapterId,
        wordCount: countWords(edit.textContent),
        expectedLocalVersion: edit.expectedVersion + 1
      })
    }
  } catch {
    warning = '正文已替换，字数统计刷新失败，重新打开作品后可核对。'
  }
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh', { detail: { bookId: batch.bookId } }))
  window.dispatchEvent(new CustomEvent('ew-local-book-updated', { detail: { bookId: batch.bookId } }))
  return { ...changed, warning }
}
