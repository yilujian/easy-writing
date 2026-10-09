<template>
  <div class="ai-bubble-menu" :class="{ 'plot-binding-mode': mode === 'plot-binding' }" @mousedown.stop>
    <div v-if="!isLoading" class="toolbar-pill">
      <button type="button" :class="{ active: activePanel === 'ai' }" @click="togglePanel('ai')">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
        <span>AI润色</span>
      </button>
      <span class="toolbar-divider"></span>
      <button type="button" :class="{ active: activePanel === 'binding' }" @click="togglePanel('binding')">
        <i class="fa-solid fa-link"></i>
        <span>绑定</span>
      </button>
      <span class="toolbar-divider"></span>
      <button type="button" :class="{ active: activePanel === 'more' }" @click="togglePanel('more')">
        <i class="fa-solid fa-ellipsis"></i>
        <span>更多</span>
      </button>
    </div>

    <div v-if="!isLoading && activePanel === 'ai'" class="expand-panel ai-panel">
      <div class="panel-title">
        <span><i class="fa-solid fa-wand-magic-sparkles"></i> AI润色</span>
        <button type="button" @click="activePanel = null">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="ai-action-grid">
        <button type="button" @click="handleAddToChat">
          <i class="fa-solid fa-comment-dots"></i>
          <span>添加至对话</span>
        </button>
        <button type="button" :class="{ active: activeAiAction === 'polish' }" @click="handleAction('polish')">
          <i class="fa-solid fa-wand-magic-sparkles"></i>
          <span>润色</span>
        </button>
        <button type="button" :class="{ active: activeAiAction === 'expand' }" @click="handleAction('expand')">
          <i class="fa-solid fa-pen-fancy"></i>
          <span>扩写</span>
        </button>
        <button type="button" :class="{ active: activeAiAction === 'fix' }" @click="handleAction('fix')">
          <i class="fa-solid fa-check"></i>
          <span>纠错</span>
        </button>
      </div>
      <div class="custom-input">
        <input
          v-model="customPrompt"
          placeholder="补充你的要求，例如：更口语化、更紧张、更简洁..."
          @keydown.enter.prevent="handleCustomSubmit"
        />
        <button type="button" @click="handleCustomSubmit">
          <i class="fa-regular fa-paper-plane"></i>
        </button>
      </div>
    </div>

    <div v-if="!isLoading && activePanel === 'binding'" class="expand-panel binding-panel">
      <button type="button" @click="emit('bind-storyline')">
        <i class="fa-solid fa-diagram-project"></i>
        <span>绑定到故事线</span>
      </button>
      <button type="button" @click="emit('bind-timeline')">
        <i class="fa-solid fa-timeline"></i>
        <span>绑定到时间线</span>
      </button>
      <button type="button" @click="emit('create-plot-node')">
        <i class="fa-solid fa-plus"></i>
        <span>新建关联节点</span>
      </button>
    </div>

    <div v-if="!isLoading && activePanel === 'more'" class="expand-panel more-panel">
      <button type="button" @click="emit('add-to-word-library')">
        <i class="fa-solid fa-spell-check"></i><span>加入常用词</span>
      </button>
      <button type="button" @click="addSelectionToInspiration">
        <i class="fa-regular fa-lightbulb"></i>
        <span>加入灵感</span>
      </button>
      <button type="button" @click="copySelection">
        <i class="fa-regular fa-copy"></i>
        <span>复制片段</span>
      </button>
      <button type="button" @click="clearSelection">
        <i class="fa-solid fa-eraser"></i>
        <span>清除选择</span>
      </button>
    </div>

    <div v-if="isLoading" class="loading" :class="{ 'has-stream': streamingText }">
      <div class="loading-row">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>AI 正在生成中...</span>
        <button type="button" class="stop-btn" @click.stop="stopAiTask">
          <i class="fa-solid fa-stop"></i>
          <span>停止</span>
        </button>
      </div>
      <div v-if="streamingText" ref="streamPreviewRef" class="stream-preview">{{ streamingText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Editor } from '@tiptap/vue-3'
// 开源版：划词动作走本地 BYOK 直连（文本默认偏好模型）；存灵感走本地灵感库
import { streamLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildSelectionActionMessages, selectionActionTemperature, type SelectionActionType } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import { addLocalInspiration } from '@/storage/local-inspiration'
import { ElMessage } from 'element-plus'

// 定义 Emits，把结果抛给父组件处理
const emit = defineEmits<{
  (e: 'done', payload: { original: string, from: number, to: number }): void
  (e: 'add-to-chat', payload: { content: string, range: string }): void
  (e: 'loading', value: boolean): void
  (e: 'bind-storyline'): void
  (e: 'bind-timeline'): void
  (e: 'create-plot-node'): void
  (e: 'add-to-word-library'): void
}>()

const props = defineProps<{
  editor: Editor
  bookId: string | number
  chapterId?: string | number
  chapterTitle?: string
  chapterSummary?: string
  mode?: 'ai' | 'plot-binding'
}>()

const mode = computed(() => props.mode || 'ai')

type ActionType = 'polish' | 'expand' | 'fix' | 'custom'
type PanelType = 'ai' | 'binding' | 'more'

const isLoading = ref(false)
const customPrompt = ref('')
const abortController = ref<AbortController | null>(null)
// 流式预览：生成内容逐字进面板，完成后才原子替换选区；中途停止不落稿
const streamingText = ref('')
const streamPreviewRef = ref<HTMLElement | null>(null)
const userStopped = ref(false)

watch(streamingText, () => {
  void nextTick(() => {
    const el = streamPreviewRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
const activePanel = ref<PanelType | null>(null)
const activeAiAction = ref<ActionType | null>(null)

const aiModelStore = useAiModelStore()

const extractSceneTailAnchor = (text: string, maxSentences = 3, maxLength = 320) => {
  const normalized = String(text || '').replace(/\r/g, '\n').trim()
  if (!normalized) return ''
  const sentences = normalized
    .split(/(?<=[。！？!?；;])/)
    .map(item => item.trim())
    .filter(Boolean)
  const anchor = sentences.length
    ? sentences.slice(-maxSentences).join(' ')
    : normalized.slice(-maxLength)
  return anchor.length > maxLength ? anchor.slice(-maxLength) : anchor
}

const buildSelectionContext = (from: number, to: number) => {
  const doc = props.editor.state.doc
  const docSize = doc.content.size
  const windowSize = 220
  const before = doc.textBetween(Math.max(0, from - windowSize), from, '\n', '\n').trim()
  const after = doc.textBetween(to, Math.min(docSize, to + windowSize), '\n', '\n').trim()

  return [
    props.chapterTitle ? `【当前章节】\n${props.chapterTitle}` : '',
    props.chapterSummary ? `【章节摘要】\n${props.chapterSummary}` : '',
    before ? `【选区前文】\n${before}` : '',
    after ? `【选区后文】\n${after}` : ''
  ].filter(Boolean).join('\n\n')
}

const getSelectionText = () => {
  const { from, to } = props.editor.state.selection
  return props.editor.state.doc.textBetween(from, to, '\n')
}

const togglePanel = (panel: PanelType) => {
  activePanel.value = activePanel.value === panel ? null : panel
}

const copyText = async (text: string) => {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

const executeAiTask = async (action: ActionType, prompt?: string) => {
  const { from, to } = props.editor.state.selection
  const selectedText = props.editor.state.doc.textBetween(from, to, '\n')

  if (!selectedText || (to - from) === 0) {
    ElMessage.warning('请先选中需要处理的文本')
    return
  }
  if (isLoading.value) {
    ElMessage.warning('AI 正在处理中，请稍候...')
    return
  }

  activeAiAction.value = action

  const instruction = prompt?.trim()
  if (action === 'custom' && !instruction) {
    ElMessage.warning('请输入要执行的指令')
    return
  }
  // 划词动作用「模型管理」里的文本默认模型；组未加载时先加载一次
  if (!aiModelStore.textModel) {
    await aiModelStore.loadTextModels()
  }
  const modelCode = aiModelStore.textModel
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  isLoading.value = true
  emit('loading', true)

  const controller = new AbortController()
  abortController.value = controller

  let generatedText = ''
  streamingText.value = ''
  userStopped.value = false

  try {
    const data = await new Promise<string>((resolve, reject) => {
      let collected = ''
      void streamLocalChatCompletion(
        {
          scene: 'selection_action',
          sceneLabel: '划词工具',
          modelCode,
          temperature: selectionActionTemperature(action as SelectionActionType),
          messages: buildSelectionActionMessages({
            action: action as SelectionActionType,
            selection: selectedText,
            context: buildSelectionContext(from, to),
            instruction,
            chapterTitle: props.chapterTitle || '',
            chapterSummary: props.chapterSummary || '',
            sceneAnchor: extractSceneTailAnchor(props.editor.getText())
          }),
          signal: controller.signal
        },
        {
          onDelta: (text) => {
            collected += text
            streamingText.value = collected
          },
          onDone: () => resolve(collected),
          onError: (message) => reject(new Error(message)),
        }
      )
    })

    // 用户主动停止：结果多半是半截，不应用到正文
    if (userStopped.value) return

    generatedText = (data || '').trim()
    if (!generatedText) {
      throw new Error('AI 暂无返回内容')
    }

    // 请求期间用户可能已改动正文，旧的 from/to 会落点错位、覆盖到无关内容。
    // 替换前校验原选区文本未变；变了就放弃这次改写，提示重试，避免污染其它段落。
    const docSize = props.editor.state.doc.content.size
    const stillSameSelection =
      from <= docSize &&
      to <= docSize &&
      props.editor.state.doc.textBetween(from, to, '\n') === selectedText
    if (!stillSameSelection) {
      ElMessage.warning('检测到正文已改动，本次改写已取消，请重新选中后重试')
      return
    }

    // 1. 替换文本
    props.editor.chain()
      .focus()
      .setTextSelection({ from, to })
      .insertContent(generatedText)
      .run()

    // 2. 给新文本加上持久化高亮 (AiReviewExtension)
    const newTo = from + generatedText.length
    props.editor.commands.setAiReviewRange({ from, to: newTo })

    // 3. 任务完成，通知父组件生成 ReviewWidget
    emit('done', {
      original: selectedText,
      from: from,
      to: newTo
    })

    // 清空选区，让 BubbleMenu 自动隐藏
    props.editor.commands.setTextSelection(newTo)

    if (action === 'custom') {
      customPrompt.value = ''
    }
    activePanel.value = null
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('AI 编辑失败', error)
    ElMessage.error(String(error?.message || 'AI 处理失败，请稍后重试'))
  } finally {
    isLoading.value = false
    emit('loading', false)
    abortController.value = null
    activeAiAction.value = null
    streamingText.value = ''
  }
}

// 用户主动停止：中止在途请求，executeAiTask 的 finally 负责复位加载态
const stopAiTask = () => {
  if (!abortController.value) return
  userStopped.value = true
  abortController.value.abort()
  ElMessage.info('已停止，本次结果未应用')
}

const handleAction = (type: ActionType) => executeAiTask(type)
const handleCustomSubmit = () => {
  if (!customPrompt.value.trim()) return
  executeAiTask('custom', customPrompt.value)
}

const handleAddToChat = () => {
  const { from, to } = props.editor.state.selection
  if (to - from === 0) return

  const selectedText = props.editor.state.doc.textBetween(from, to, '\n')

  let range = ''
  const view = props.editor.view
  if (view?.dom) {
    try {
      const startDocCoords = view.coordsAtPos(1)
      const fromCoords = view.coordsAtPos(from)
      const toCoords = view.coordsAtPos(to)
      const domInfo = view.domAtPos(from)
      const node = (domInfo.node.nodeType === 3 ? domInfo.node.parentElement : domInfo.node) as HTMLElement
      const lineHeight = parseFloat(window.getComputedStyle(node).lineHeight)

      if (!isNaN(lineHeight) && lineHeight > 0) {
        const startLine = Math.max(1, Math.round((fromCoords.top - startDocCoords.top) / lineHeight) + 1)
        const endLine = Math.max(startLine, Math.round((toCoords.top - startDocCoords.top) / lineHeight) + 1)
        range = startLine === endLine ? `第${startLine}行` : `${startLine}-${endLine}行`
      }
    } catch {
      range = ''
    }
  }

  if (!range) {
    const startLine = props.editor.state.doc.resolve(from).index(0) + 1
    const endLine = props.editor.state.doc.resolve(to).index(0) + 1
    range = startLine === endLine ? `第${startLine}段` : `${startLine}-${endLine}段`
  }

  emit('add-to-chat', {
    content: selectedText,
    range
  })
  activePanel.value = null
}

const addSelectionToInspiration = async () => {
  const selectedText = getSelectionText().trim()
  if (!selectedText) {
    ElMessage.warning('请先选中需要加入灵感的文本')
    return
  }
  try {
    addLocalInspiration({
      content: selectedText,
      tag: '正文片段',
    })
    activePanel.value = null
    ElMessage.success('已加入灵感')
  } catch (error) {
    console.warn('加入灵感失败', error)
    ElMessage.error('加入灵感失败')
  }
}

const copySelection = async () => {
  const selectedText = getSelectionText().trim()
  if (!selectedText) {
    ElMessage.warning('请先选中需要复制的文本')
    return
  }
  try {
    await copyText(selectedText)
    activePanel.value = null
    ElMessage.success('已复制片段')
  } catch (error) {
    console.warn('复制失败', error)
    ElMessage.error('复制失败')
  }
}

const clearSelection = () => {
  const { to } = props.editor.state.selection
  props.editor.chain().focus().setTextSelection(to).run()
  activePanel.value = null
}

onBeforeUnmount(() => {
  abortController.value?.abort()
})
</script>

<style scoped lang="scss">
.ai-bubble-menu {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: visible;
  min-width: 0;
  border-radius: 18px;
}

.toolbar-pill {
  position: relative;
  z-index: 2;
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px 6px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 82%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-glass-bg) 92%, var(--bg-main));
  box-shadow: 0 10px 28px color-mix(in srgb, var(--ink-main) 16%, transparent);
  backdrop-filter: blur(18px);

  &::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -7px;
    width: 14px;
    height: 14px;
    background: inherit;
    border-right: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    transform: translateX(-50%) rotate(45deg);
    z-index: -1;
  }

  button {
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 9px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 52%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--ui-glass-bg) 48%, transparent);
    color: var(--ink-main);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;

    &.active {
      background: color-mix(in srgb, var(--ink-accent) 12%, var(--ui-glass-bg));
      color: var(--ink-accent);
      font-weight: 700;
    }

    &:hover {
      border-color: color-mix(in srgb, var(--ink-accent) 34%, var(--ui-border));
      background: color-mix(in srgb, var(--ui-glass-bg) 78%, transparent);
      color: var(--ink-accent);
    }

    i {
      width: 14px;
      text-align: center;
      font-size: 13px;
    }
  }
}

.toolbar-divider {
  width: 1px;
  height: 18px;
  background: color-mix(in srgb, var(--ui-border) 78%, transparent);
}

.expand-panel {
  position: absolute;
  top: 50px;
  left: 50%;
  z-index: 1;
  border: 1px solid color-mix(in srgb, var(--ui-border) 80%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-glass-bg) 94%, var(--bg-main));
  box-shadow: 0 14px 34px color-mix(in srgb, var(--ink-main) 18%, transparent);
  backdrop-filter: blur(20px);
  transform: translateX(-50%);
}

.ai-panel {
  width: min(360px, calc(var(--bubble-visible-width, 100vw) - 24px), calc(100vw - 48px));
  padding: 8px 10px;
}

.panel-title {
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--ink-main);
  font-size: 14px;
  font-weight: 700;

  span,
  button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  button {
    width: 20px;
    height: 20px;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;

    &:hover {
      background: var(--ui-glass-bg-hover);
      color: var(--ink-main);
    }
  }
}

.ai-action-grid {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;

  button {
    flex: 0 0 auto;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 0;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 92%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--bg-main) 72%, var(--ui-glass-bg));
    color: var(--ink-main);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;

    i {
      width: 13px;
      color: var(--ink-sec);
      text-align: center;
      font-size: 11px;
    }

    &:first-child {
      min-width: 104px;
    }

    &.active,
    &:hover {
      border-color: color-mix(in srgb, var(--ink-accent) 48%, var(--ui-border));
      background: color-mix(in srgb, var(--ink-accent) 12%, var(--ui-glass-bg));
      color: var(--ink-accent);

      i {
        color: var(--ink-accent);
      }
    }
  }
}

.custom-input {
  height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 86%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--bg-main) 74%, transparent);

  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    color: var(--ink-main);
    font-size: 13px;

    &::placeholder {
      color: var(--ink-sec);
      opacity: 0.72;
    }
  }

  button {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;

    &:hover {
      color: var(--ink-accent);
      background: var(--ui-glass-bg-hover);
    }
  }
}

.binding-panel,
.more-panel {
  width: 230px;
  padding: 10px;

  button {
    width: 100%;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-main);
    font-size: 14px;
    cursor: pointer;

    &:hover {
      background: color-mix(in srgb, var(--ink-accent) 10%, var(--ui-glass-bg));
      color: var(--ink-accent);
    }

    i {
      width: 18px;
      color: var(--ink-sec);
      text-align: center;
    }
  }
}

.more-panel button + button {
  margin-top: 4px;
}

.loading {
  min-width: 190px;
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 82%, transparent);
  border-radius: 22px;
  background: color-mix(in srgb, var(--ui-glass-bg) 92%, var(--bg-main));
  color: var(--ink-accent);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--ink-main) 16%, transparent);
}

.loading .loading-row {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 24px;
}

/* 流式预览：生成内容逐字进面板，看着不对随时停 */
.loading .stream-preview {
  max-width: 420px;
  max-height: 180px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-main) 70%, transparent);
  color: var(--ink-main);
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  text-align: left;
}

.loading .stop-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  margin-left: 4px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 82%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-sec, var(--ink-main));
  font-size: 12px;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
}

.loading .stop-btn:hover {
  color: var(--ink-accent);
  border-color: color-mix(in srgb, var(--ink-accent) 45%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
}

.loading .stop-btn i {
  font-size: 10px;
}

@media (max-width: 920px) {
  .toolbar-pill {
    button {
      padding: 0 8px;
      font-size: 13px;
    }
  }

  .ai-panel {
    width: min(360px, calc(100vw - 36px));
  }
}

@media (max-width: 420px) {
  .ai-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));

    button {
      width: 100%;
    }
  }
}
</style>
