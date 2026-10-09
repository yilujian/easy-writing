import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { SUPPRESS_AI_SUGGESTION } from '../editor-utils/word-library'

export interface AICopilotOptions {
  enabled?: boolean | (() => boolean);
  onFetchSuggestion: (payload: {
    context: string;
    mode: 'inline' | 'next_beat';
  }) => Promise<string | null>;
  onCancelRequest?: () => void;
  /** 用户按 Tab 采纳幽灵字建议后回调，用于码字账本把这些字记到 AI 名下 */
  onAcceptSuggestion?: (text: string) => void;
  debounceMin?: number;
  debounceMax?: number;
  minRequestInterval?: number;
  minChangedChars?: number;
  rateLimitCooldown?: number;
}

export default Extension.create<AICopilotOptions>({
  name: 'aiCopilot',

  addOptions() {
    return {
      enabled: true,
      onFetchSuggestion: async () => null,
      onCancelRequest: undefined,
      debounceMin: 1200,
      debounceMax: 1800,
      minRequestInterval: 8000,
      minChangedChars: 12,
      rateLimitCooldown: 60000,
    }
  },

  addProseMirrorPlugins() {
    const key = new PluginKey('aiCopilot')
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let typingVersion = 0
    let lastRequestAt = 0
    let lastRequestContext = ''
    let cooldownUntil = 0

    const {
      onFetchSuggestion,
      onCancelRequest,
      onAcceptSuggestion,
      debounceMin = 1200,
      debounceMax = 1800,
      minRequestInterval = 8000,
      minChangedChars = 12,
      rateLimitCooldown = 60000
    } = this.options

    const isEnabled = () => {
      const enabled = this.options.enabled
      return typeof enabled === 'function' ? enabled() : enabled !== false
    }

    const getDebounceDelay = () => {
      const min = Math.max(0, debounceMin)
      const range = Math.max(0, debounceMax - min)
      return min + Math.random() * (range || 0)
    }

    const hasMeaningfulTextAfterCursor = (state: EditorState, from: number) => {
      try {
        const end = state.doc.content.size
        if (from >= end) return false
        const tail = state.doc.textBetween(from, end, '\n', '\n')
        return /[^\s\u00a0\u3000]/.test(String(tail || ''))
      } catch {
        return false
      }
    }

    const detectAutocompleteMode = (text: string): 'inline' | 'next_beat' => {
      const normalized = String(text || '').trim()
      if (!normalized) return 'next_beat'
      if (/[，、：,:—\\-（(“"'《【]$/.test(normalized)) return 'inline'
      if (/[。！？!?；;]$/.test(normalized)) return 'next_beat'
      return 'inline'
    }

    const normalizeRequestContext = (text: string) => String(text || '').replace(/\s+/g, ' ').trim()

    const getChangedCharCount = (prev: string, next: string) => {
      if (!prev) return next.length
      if (prev === next) return 0
      let index = 0
      while (index < prev.length && index < next.length && prev[index] === next[index]) {
        index += 1
      }
      return Math.max(0, next.length - index)
    }

    const isRateLimitError = (error: { msg?: string; message?: string } | null) => {
      const message = String(error?.msg || error?.message || '')
      // 并发占满（如后台自动生文运行中）与频率限流同样进入冷却，避免打字期间反复空撞
      return (
        message.includes('频繁') ||
        message.includes('任务较多') ||
        message.includes('rate limit') ||
        message.includes('Too Many Requests')
      )
    }

    return [
      new Plugin({
        key,
        state: {
          init() {
            return { suggestion: null, loading: false, decoration: DecorationSet.empty, skipAutocomplete: false }
          },
          apply(tr, value, oldState, newState) {
            if (tr.getMeta(SUPPRESS_AI_SUGGESTION)) {
              return { ...value, suggestion: null, loading: false, decoration: DecorationSet.empty, skipAutocomplete: true }
            }
            // 1. 用户按 Tab 采纳
            if (tr.getMeta('ACCEPT_SUGGESTION')) {
              return { ...value, suggestion: null, loading: false, decoration: DecorationSet.empty }
            }

            // 2. 用户打字或光标移动 -> 立即清除当前建议
            if (tr.docChanged || tr.selectionSet) {
              return { suggestion: null, loading: false, decoration: DecorationSet.empty, skipAutocomplete: false }
            }

            // 3. API 返回新建议
            const newSuggestion = tr.getMeta('UPDATE_SUGGESTION')
            if (newSuggestion !== undefined) {
              let deco = DecorationSet.empty
              if (newSuggestion) {
                const { to } = newState.selection
                // 创建一个 widget 装饰器
                const widget = Decoration.widget(to, () => {
                  // 1. 外层容器 (用于定位)
                  const container = document.createElement('span')
                  container.className = 'ai-ghost-wrapper'

                  // 2. 幽灵文字本体
                  const textSpan = document.createElement('span')
                  textSpan.className = 'ghost-text'
                  textSpan.textContent = newSuggestion

                  // 3. 悬浮提示窗 (Cursor 风格)
                  const tooltip = document.createElement('span')
                  tooltip.className = 'ai-ghost-tooltip'
                  // 这里用 HTML 结构来画那个 Tab 键的小方框
                  tooltip.innerHTML = `<span class="key-cap">Tab</span> 采纳`

                  // 组装
                  container.appendChild(textSpan)
                  container.appendChild(tooltip)

                  return container
                }, { side: 1 })

                deco = DecorationSet.create(newState.doc, [widget])
              }
              return { ...value, suggestion: newSuggestion, loading: false, decoration: deco }
            }

            return value
          },
        },
        // 这里定义视图层的逻辑（监听更新）
        view(_editorView) {
          return {
            update: (view, prevState) => {
              if (!isEnabled() || key.getState(view.state)?.skipAutocomplete) {
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = null
                typingVersion++
                onCancelRequest?.()
                const currentState = key.getState(view.state)
                if (currentState?.suggestion) {
                  view.dispatch(view.state.tr.setMeta('UPDATE_SUGGESTION', null))
                }
                return
              }

              // 只有文档内容变化才触发（打字时），光标单纯移动不触发
              if (!prevState.doc.eq(view.state.doc)) {
                // 文本发生变化，取消当前请求并清除防抖定时器
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = null
                typingVersion++
                onCancelRequest?.()

                const scheduledVersion = typingVersion
                const runAutocomplete = async () => {
                  debounceTimer = null
                  if (!isEnabled()) return
                  // 如果期间有新的输入，放弃此次任务
                  if (scheduledVersion !== typingVersion) return

                  const { state } = view
                  const { from, $from } = state.selection
                  if ($from.parentOffset < $from.parent.content.size) {
                    return
                  }
                  if (hasMeaningfulTextAfterCursor(state, from)) {
                    return
                  }

                  // 自动补全更看重“光标附近”的局部上下文，不能吃太长前文
                  const limit = 260
                  const start = Math.max(0, from - limit)
                  const context = state.doc.textBetween(start, from, '\n')

                  if (!context.trim() || context.length < 5) return
                  const now = Date.now()
                  if (now < cooldownUntil) return
                  if (now - lastRequestAt < minRequestInterval) {
                    debounceTimer = setTimeout(runAutocomplete, minRequestInterval - (now - lastRequestAt))
                    return
                  }

                  const requestContext = normalizeRequestContext(context)
                  if (!requestContext || requestContext === lastRequestContext) return
                  if (getChangedCharCount(lastRequestContext, requestContext) < minChangedChars) return

                  lastRequestAt = now
                  lastRequestContext = requestContext
                  try {
                    const mode = detectAutocompleteMode(context)
                    const suggestion = await onFetchSuggestion({ context, mode })

                    if (view.isDestroyed || scheduledVersion !== typingVersion) return

                    if (suggestion) {
                      const tr = view.state.tr.setMeta('UPDATE_SUGGESTION', suggestion)
                      view.dispatch(tr)
                    }
                  } catch (e) {
                    if (isRateLimitError(e)) {
                      cooldownUntil = Date.now() + rateLimitCooldown
                    }
                    console.error('AI Copilot 请求失败:', e)
                  }
                }

                debounceTimer = setTimeout(runAutocomplete, getDebounceDelay())
              }
            },
            destroy: () => {
              if (debounceTimer) clearTimeout(debounceTimer)
              debounceTimer = null
              typingVersion++
              onCancelRequest?.()
            },
          }
        },
        props: {
          decorations(state) {
            return key.getState(state).decoration
          },
          handleKeyDown(view, event) {
            if (!isEnabled()) return false
            const state = key.getState(view.state)

            // 只有当存在建议时，才拦截按键
            if (state && state.suggestion) {
              if (event.key === 'Tab') {
                event.preventDefault()
                const tr = view.state.tr.insertText(state.suggestion)
                tr.setMeta('ACCEPT_SUGGESTION', true)
                view.dispatch(tr)
                onAcceptSuggestion?.(state.suggestion)
                return true
              }

              // 按 Esc 或 任意方向键 取消建议
              if (event.key === 'Escape' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                // 不阻止默认行为，但清除建议
                const tr = view.state.tr.setMeta('UPDATE_SUGGESTION', null)
                view.dispatch(tr)
                // 如果是 Esc，阻止默认行为
                if (event.key === 'Escape') return true
              }
            }
            return false
          },
        },
      }),
    ]
  },
})
