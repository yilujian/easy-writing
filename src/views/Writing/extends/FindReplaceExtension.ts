import { Extension, Command } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { findDocumentMatches } from '@/utils/document-find'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    findReplace: {
      setFindQuery: (query: string) => ReturnType
      setReplaceText: (text: string) => ReturnType
      setFindOptions: (query: string, replace: string) => ReturnType
      goToFindMatch: (index: number) => ReturnType
      nextMatch: () => ReturnType
      prevMatch: () => ReturnType
      replaceCurrent: () => ReturnType
      replaceAllInDoc: () => ReturnType
    }
  }
}

export interface FindReplaceState {
  query: string
  replace: string
  decorations: DecorationSet
  matches: Array<{ from: number; to: number }>
  index: number
}

export const findReplacePluginKey = new PluginKey<FindReplaceState>('findReplace')

function collectMatches(doc: ProseMirrorNode, query: string) {
  return findDocumentMatches(doc, query)
}

function buildDecorations(doc: ProseMirrorNode, matches: Array<{ from: number; to: number }>, index: number) {
  const decos: Decoration[] = []
  matches.forEach((m, i) => {
    decos.push(Decoration.inline(m.from, m.to, {
      class: i === index ? 'find-highlight-active' : 'find-highlight',
    }))
  })
  return DecorationSet.create(doc, decos)
}

const FindReplace = Extension.create({
  name: 'findReplace',

  addCommands() {
    return {
      setFindOptions:
        (query: string, replace: string): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          const matches = collectMatches(state.doc, query)
          const index = matches.length ? Math.min(prev.index, matches.length - 1) : 0
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, {
            ...prev, query, replace, matches, index,
            decorations: buildDecorations(state.doc, matches, index),
          }))
          return true
        },
      goToFindMatch:
        (index: number): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          if (!Number.isInteger(index) || index < 0 || index >= prev.matches.length) return false
          const match = prev.matches[index]
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, {
            ...prev, index, decorations: buildDecorations(state.doc, prev.matches, index),
          }).setSelection(TextSelection.create(state.doc, match.from, match.to)).setMeta('scrolledToMatch', true).scrollIntoView())
          return true
        },
      setFindQuery:
        (query: string): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          const matches = collectMatches(state.doc, query)
          const index = matches.length ? Math.min(prev.index, matches.length - 1) : 0
          const deco = buildDecorations(state.doc, matches, index)
          const next = { ...prev, query, matches, index, decorations: deco }
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, next))
          return true
        },
      setReplaceText:
        (text: string): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          const next = { ...prev, replace: text }
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, next))
          return true
        },
      nextMatch:
        (): Command => ({ tr, state, dispatch, view }) => {
          const prev = findReplacePluginKey.getState(state)!
          if (!prev.matches.length) return true
          const index = (prev.index + 1) % prev.matches.length
          const deco = buildDecorations(state.doc, prev.matches, index)
          const sel = prev.matches[index]
          const next = { ...prev, index, decorations: deco }
          if (dispatch) {
            dispatch(tr.setMeta(findReplacePluginKey, next).setSelection(TextSelection.create(state.doc, sel.from, sel.to)).setMeta('scrolledToMatch', true).scrollIntoView())

            // 匹配项切换后滚动到编辑区中央，避免只移动选区但用户看不到。
            if (view) {
              const dom = view.domAtPos(sel.from).node
              if (dom && dom instanceof Element) {
                dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
              } else if (dom && dom.parentElement) {
                dom.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }
            }
          }
          return true
        },
      prevMatch:
        (): Command => ({ tr, state, dispatch, view }) => {
          const prev = findReplacePluginKey.getState(state)!
          if (!prev.matches.length) return true
          const index = (prev.index - 1 + prev.matches.length) % prev.matches.length
          const deco = buildDecorations(state.doc, prev.matches, index)
          const sel = prev.matches[index]
          const next = { ...prev, index, decorations: deco }
          if (dispatch) {
            dispatch(tr.setMeta(findReplacePluginKey, next).setSelection(TextSelection.create(state.doc, sel.from, sel.to)).setMeta('scrolledToMatch', true).scrollIntoView())

            // 匹配项切换后滚动到编辑区中央，避免只移动选区但用户看不到。
            if (view) {
              const dom = view.domAtPos(sel.from).node
              if (dom && dom instanceof Element) {
                dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
              } else if (dom && dom.parentElement) {
                dom.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }
            }
          }
          return true
        },
      replaceCurrent:
        (): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          if (!prev.matches.length) return true
          const { from, to } = prev.matches[prev.index]
          // 空替换文本由 ProseMirror 直接删除匹配范围。
          const insertTr = tr.insertText(prev.replace, from, to)
          const nextDoc = insertTr.doc
          const matches = collectMatches(nextDoc, prev.query)
          const index = matches.length
            ? Math.min(prev.index, matches.length - 1)
            : 0
          const deco = buildDecorations(nextDoc, matches, index)
          const next = { ...prev, matches, index, decorations: deco }
          if (dispatch) dispatch(insertTr.setMeta(findReplacePluginKey, next).scrollIntoView())
          return true
        },
      replaceAllInDoc:
        (): Command => ({ tr, state, dispatch }) => {
          const prev = findReplacePluginKey.getState(state)!
          if (!prev.matches.length) return true
          // 从后往前替换，避免位置偏移问题
          let insertTr = tr
          for (let i = prev.matches.length - 1; i >= 0; i--) {
            const { from, to } = prev.matches[i]
            insertTr = insertTr.insertText(prev.replace, from, to)
          }
          const nextDoc = insertTr.doc
          const matches = collectMatches(nextDoc, prev.query)
          const deco = buildDecorations(nextDoc, matches, 0)
          const next = { ...prev, matches, index: 0, decorations: deco }
          if (dispatch) dispatch(insertTr.setMeta(findReplacePluginKey, next).scrollIntoView())
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindReplaceState>({
        key: findReplacePluginKey,
        state: {
          init: (_, state) => {
            const base: FindReplaceState = {
              query: '',
              replace: '',
              matches: [],
              index: 0,
              decorations: DecorationSet.create(state.doc, []),
            }
            return base
          },
          apply: (tr, prev, _old, state) => {
            const meta = tr.getMeta(findReplacePluginKey) as FindReplaceState | undefined
            if (meta) {
              return meta
            }
            // 文档变化后更新装饰（保持当前查询）
            const matches = collectMatches(state.doc, prev.query)
            const index = matches.length ? Math.min(prev.index, matches.length - 1) : 0
            const deco = buildDecorations(state.doc, matches, index)
            return { ...prev, matches, index, decorations: deco }
          },
        },
        props: {
          decorations(state) {
            return findReplacePluginKey.getState(state)?.decorations || null
          },
        },
      }),
    ]
  },
})

export default FindReplace
