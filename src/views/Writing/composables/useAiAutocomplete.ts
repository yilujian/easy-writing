import { loadCharacterContext } from '@/storage/character-context'
import { appSettings } from '@/storage/app-settings'
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { ElMessage } from 'element-plus'
import { getAiShortcutTitle } from '@/utils/platform'
import { NO_MODEL_MESSAGE, requestLocalChatCompletion, streamLocalChatCompletion } from '@/utils/local-ai-client'
import { autocompleteTemperature, buildAutocompleteMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import {
  extractAutocompletePrefix,
  extractSceneTailAnchor,
} from '../editor-utils/content-normalize'

interface AiAutocompleteOptions {
  bookId: () => string | number | undefined
  editor: Ref<Editor | undefined>
  workflowMode: ComputedRef<boolean>
  workflowLocked: ComputedRef<boolean>
  workflowManualEditUnlocked: ComputedRef<boolean>
  chapterContentReady: Ref<boolean>
  activeChapterId: Ref<number | null>
  activeChapterTitle: Ref<string>
  activeChapterSummary: Ref<string>
  /** 正文被 AI 插入后标脏排队落盘（函数在组件里晚于本组合式声明，经闭包延迟取用） */
  onDraftDirty: () => void
  /** 有选区时快捷键改为弹出气泡菜单 */
  onSelectionMenu: () => void
  /** 流式续写每插入一段就回调一次，用于码字账本把这些字记到 AI 名下 */
  onAiTextInserted: (text: string) => void
}

/**
 * 打字补全（被动幽灵字）与 Cmd/Alt+/ 快捷续写（流式逐字进正文）。
 * AI 开关持久化在 localStorage；本面板模型可临时覆盖全局默认。
 * 逻辑自 WritingEditor 原样搬迁，行为不变。
 */
export const useAiAutocomplete = (options: AiAutocompleteOptions) => {
  const {
    editor,
    workflowMode,
    workflowLocked,
    workflowManualEditUnlocked,
    chapterContentReady,
    activeChapterId,
    activeChapterTitle,
    activeChapterSummary,
    onDraftDirty,
    onSelectionMenu,
    onAiTextInserted,
  } = options

  const isAiThinking = ref(false)
  const aiBusyCounter = ref(0)
  const autocompleteController = ref<AbortController | null>(null)
  // 快捷续写单独一把中止控制器：幽灵字插件在每次正文变动时都会"取消建议请求"，
  // 若与它共用一把，流式续写插进第一个字就会被自己触发的取消掐断
  const nextBeatController = ref<AbortController | null>(null)

  interface AiConfigState {
    enabled: boolean
  }

  const defaultAiConfig: AiConfigState = {
    enabled: true,
  }

  const AI_CONFIG_STORAGE_KEY = 'ew_ai_copilot_config'

  const readAiConfig = (): AiConfigState => {
    if (typeof window === 'undefined') return { ...defaultAiConfig }
    try {
      const cached = appSettings.getItem(AI_CONFIG_STORAGE_KEY)
      if (!cached) return { ...defaultAiConfig }
      const parsed = JSON.parse(cached)
      return {
        enabled:
          typeof parsed.enabled === 'boolean'
            ? parsed.enabled
            : defaultAiConfig.enabled,
      }
    } catch {
      return { ...defaultAiConfig }
    }
  }

  const aiConfig = ref<AiConfigState>(readAiConfig())

  // 本面板临时覆盖模型：空值 = 跟随「AI 模型」页的全局默认；选择不回写全局
  const autocompleteModelOverride = ref('')
  const aiModelStore = useAiModelStore()

  watch(
    aiConfig,
    (nextVal) => {
      if (typeof window === 'undefined') return
      try {
        appSettings.setItem(
          AI_CONFIG_STORAGE_KEY,
          JSON.stringify(nextVal),
        )
      } catch {
        // ignore storage quota issues
      }
    },
    { deep: true },
  )

  const aiShortcutTip = computed(() => getAiShortcutTitle())

  const aiStatusText = computed(() => {
    if (isAiThinking.value) return 'AI思考中...'
    return aiConfig.value.enabled ? 'AI 助手已开' : 'AI 助手已关'
  })

  // AI Copilot 获取建议
  const setAiBusy = (busy: boolean) => {
    aiBusyCounter.value = Math.max(0, aiBusyCounter.value + (busy ? 1 : -1))
    isAiThinking.value = aiBusyCounter.value > 0
  }

  const fetchAiSuggestion = async (payload: {
    context: string
    mode: 'inline' | 'next_beat'
  }): Promise<string | null> => {
    if (
      workflowMode.value ||
      !workflowManualEditUnlocked.value ||
      !aiConfig.value.enabled
    )
      return null

    setAiBusy(true)
    autocompleteController.value?.abort()
    const controller = new AbortController()
    autocompleteController.value = controller
    try {
      const localPreText = extractAutocompletePrefix(payload.context, 3, 220)
      const sceneAnchor = extractSceneTailAnchor(localPreText, 2, 160)
      // 被动触发的补全：没配模型就静默跳过，不打断码字（设置浮层里能看到模型状态）
      let modelCode = autocompleteModelOverride.value || aiModelStore.textModel
      if (!modelCode) {
        await aiModelStore.loadTextModels()
        modelCode = aiModelStore.textModel
      }
      if (!modelCode) return null
      const characterContext = await loadCharacterContext(options.bookId(), [payload.context, activeChapterTitle.value, activeChapterSummary.value].join('\n'))
      if (controller.signal.aborted) return null
      const data = await requestLocalChatCompletion({
        scene: 'typing_autocomplete',
        sceneLabel: '打字补全',
        modelCode,
        temperature: autocompleteTemperature(payload.mode),
        messages: buildAutocompleteMessages({
          preText: localPreText,
          characterContext,
          sceneAnchor,
          chapterTitle: activeChapterTitle.value || '',
          chapterSummary: activeChapterSummary.value || '',
          mode: payload.mode,
        }),
        maxTokens: payload.mode === 'next_beat' ? 600 : 200,
        signal: controller.signal,
      })
      // 请求期间工作流重新进入生成态时丢弃建议，避免续写补全插进生成中的正文。
      if (workflowMode.value || !workflowManualEditUnlocked.value) return null
      const suggestion = (data || '').trim()
      return suggestion || null
    } catch (error) {
      if (error?.name === 'AbortError') return null
      const message = String(error?.msg || error?.message || '')
      if (
        message.includes('频繁') ||
        message.includes('rate limit') ||
        message.includes('Too Many Requests')
      ) {
        throw error
      }
      console.warn('AI Copilot fetch failed', error)
      return null
    } finally {
      if (autocompleteController.value === controller) {
        autocompleteController.value = null
      }
      setAiBusy(false)
    }
  }

  /** 切章/卸载时统一掐掉所有在途 AI 请求（幽灵字建议 + 快捷续写） */
  const abortAiRequests = () => {
    autocompleteController.value?.abort()
    nextBeatController.value?.abort()
  }

  const cancelAiSuggestion = () => {
    if (!autocompleteController.value) return
    autocompleteController.value.abort()
  }

  /**
   * Cmd/Alt + / 快捷续写：流式逐字写进正文（不再整段干等）。
   * 位置追踪用"文档尺寸差"而不是字符数——插入内容跨段时节点边界也占位置。
   * 流入期间校验流入区未被用户改动（比较时忽略换行差异），改了就停在当前进度；
   * 切章或进入工作流锁定也会掐断，防止旧章的续写插进新章。
   */
  const triggerAiShortcut = async () => {
    if (
      !editor.value ||
      workflowMode.value ||
      !workflowManualEditUnlocked.value
    )
      return
    const ed = editor.value
    const { from, to, empty } = ed.state.selection
    if (!empty && to - from > 0) {
      onSelectionMenu()
      return
    }

    const context = ed.state.doc
      .textBetween(Math.max(0, from - 400), from, '\n', '\n')
      .trim()
    if (!context) {
      ElMessage.warning('请先输入内容或选中文本后再触发 AI')
      return
    }

    setAiBusy(true)
    // 开始续写前掐掉在途的幽灵字建议与上一次续写
    autocompleteController.value?.abort()
    nextBeatController.value?.abort()
    const controller = new AbortController()
    nextBeatController.value = controller
    const chapterIdAtStart = Number(activeChapterId.value || 0)
    const normalizeFlow = (text: string) => text.replace(/\s+/g, '')
    try {
      let modelCode = autocompleteModelOverride.value || aiModelStore.textModel
      if (!modelCode) {
        await aiModelStore.loadTextModels()
        modelCode = aiModelStore.textModel
      }
      if (!modelCode) {
        ElMessage.warning(NO_MODEL_MESSAGE)
        return
      }
      const localPreText = extractAutocompletePrefix(context, 3, 220)
      const sceneAnchor = extractSceneTailAnchor(localPreText, 2, 160)

      const characterContext = await loadCharacterContext(options.bookId(), [context, activeChapterTitle.value, activeChapterSummary.value].join('\n'))
      if (controller.signal.aborted || activeChapterId.value !== chapterIdAtStart) return
      const startPos = from
      let insertPos = from
      let accumulated = ''
      let interrupted = false
      let errored = false
      const interrupt = () => {
        interrupted = true
        controller.abort()
      }

      await new Promise<void>(resolve => {
        void streamLocalChatCompletion(
          {
            scene: 'typing_autocomplete',
            sceneLabel: '快捷续写',
            modelCode,
            temperature: autocompleteTemperature('next_beat'),
            signal: controller.signal,
            messages: buildAutocompleteMessages({
              preText: localPreText,
              characterContext,
              sceneAnchor,
              chapterTitle: activeChapterTitle.value || '',
              chapterSummary: activeChapterSummary.value || '',
              mode: 'next_beat',
            }),
          },
          {
            onDelta: text => {
              if (interrupted || !text) return
              if (
                workflowMode.value ||
                workflowLocked.value ||
                !chapterContentReady.value ||
                Number(activeChapterId.value || 0) !== chapterIdAtStart
              ) {
                interrupt()
                return
              }
              const currentFlow = ed.state.doc.textBetween(startPos, insertPos, '\n')
              if (normalizeFlow(currentFlow) !== normalizeFlow(accumulated)) {
                interrupt()
                ElMessage.info('正文有改动，续写已停在当前进度')
                return
              }
              const sizeBefore = ed.state.doc.content.size
              ed.chain().insertContentAt(insertPos, text).run()
              insertPos += ed.state.doc.content.size - sizeBefore
              accumulated += text
              onAiTextInserted(text)
            },
            onDone: () => resolve(),
            onError: message => {
              errored = true
              if (!interrupted) ElMessage.error(message)
              resolve()
            },
          }
        )
      })

      if (!accumulated && !interrupted && !errored) {
        ElMessage.warning('AI 暂无返回内容')
        return
      }
      if (!interrupted && accumulated && Number(activeChapterId.value || 0) === chapterIdAtStart) {
        ed.chain().focus().setTextSelection(Math.min(insertPos, ed.state.doc.content.size)).run()
        onDraftDirty()
      }
    } finally {
      setAiBusy(false)
      if (nextBeatController.value === controller) {
        nextBeatController.value = null
      }
    }
  }


  return {
    aiConfig,
    autocompleteModelOverride,
    aiShortcutTip,
    aiStatusText,
    isAiThinking,
    isAiStreaming: computed(() => nextBeatController.value !== null),
    abortAiRequests,
    setAiBusy,
    fetchAiSuggestion,
    cancelAiSuggestion,
    triggerAiShortcut,
  }
}
