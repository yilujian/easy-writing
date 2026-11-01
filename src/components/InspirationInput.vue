<template>
  <div
ref="wrapperRef" class="inspiration-input" :class="[
    `variant-${variant}`,
    { 'is-focused': hasFocus, 'is-disabled': disabled }
  ]" :style="rootStyle" @click="handleWrapperClick">
    <div
ref="editorRef" class="inspiration-input__editor" :contenteditable="!disabled" :data-placeholder="placeholder"
      @input="handleInput" @keydown="handleKeydown" @keyup="handleKeyup" @click="handleClick" @focus="handleFocus"
      @blur="handleBlur" @paste="handlePaste" @beforeinput="handleBeforeInput" @compositionstart="isComposing = true"
      @compositionend="handleCompositionEnd"></div>
    <div
v-if="mention.visible" class="inspiration-input__mention"
      :style="{ left: `${mention.left}px`, top: `${mention.top}px` }" @mousedown.prevent>
      <div class="mention-header">
        <span class="mention-title">标签</span>
        <span class="mention-tip">回车确认</span>
      </div>
      <div v-if="mention.options.length" class="mention-list">
        <button
v-for="(option, idx) in mention.options" :key="option.value" type="button" class="mention-item"
          :class="{ active: idx === mention.activeIndex }" @mousedown.prevent="applyMention(option.value)">
          <span class="mention-prefix">#</span>
          <span class="mention-label">{{ option.label }}</span>
          <span v-if="option.meta" class="mention-meta">{{ option.meta }}</span>
        </button>
      </div>
      <div v-else class="mention-empty">
        暂无历史标签，回车创建
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

interface MentionOption {
  value: string
  label: string
  meta?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    disabled?: boolean
    maxLength?: number
    options?: MentionOption[]
    variant?: 'default' | 'compact' | 'plain'
    minHeight?: string
  }>(),
  {
    modelValue: '',
    placeholder: '',
    disabled: false,
    maxLength: 500,
    options: () => [],
    variant: 'default',
    minHeight: ''
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'focus'): void
  (e: 'blur'): void
}>()

const editorRef = ref<HTMLDivElement | null>(null)
const wrapperRef = ref<HTMLDivElement | null>(null)
const hasFocus = ref(false)
const lastValue = ref('')
const isComposing = ref(false)

const mention = reactive({
  visible: false,
  query: '',
  options: [] as MentionOption[],
  activeIndex: 0,
  left: 0,
  top: 0,
  triggerNode: null as Text | null,
  triggerOffset: 0,
  cursorOffset: 0
})

const rootStyle = computed(() => {
  if (!props.minHeight) return undefined
  return { '--inspiration-input-min-height': props.minHeight }
})

const normalizeText = (value: string) => value.replace(/\u00a0/g, ' ')

const getPlainText = () => {
  const editor = editorRef.value
  if (!editor) return ''
  return normalizeText(editor.innerText || '')
}

const escapeForTextNode = (value: string) => value.replace(/\r/g, '')

const renderFromValue = (value: string) => {
  const editor = editorRef.value
  if (!editor) return
  editor.innerHTML = ''
  const text = escapeForTextNode(value || '')
  if (!text) return
  const fragment = document.createDocumentFragment()
  const match = text.match(/(^|[\s\u00a0\n])(#[\u4e00-\u9fa5a-zA-Z0-9_-]+)/)

  const appendText = (segment: string) => {
    if (!segment) return
    const parts = segment.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) fragment.appendChild(document.createElement('br'))
      if (part) fragment.appendChild(document.createTextNode(part))
    })
  }

  if (match && match.index !== undefined) {
    const prefixEnd = match.index + match[1].length
    appendText(text.slice(0, prefixEnd))
    const span = document.createElement('span')
    span.className = 'inspiration-tag'
    span.textContent = match[2]
    span.contentEditable = 'false'
    fragment.appendChild(span)
    appendText(text.slice(prefixEnd + match[2].length))
  } else {
    appendText(text)
  }
  editor.appendChild(fragment)
}

const emitValue = () => {
  const nextValue = getPlainText()
  if (nextValue === lastValue.value) return
  lastValue.value = nextValue
  emit('update:modelValue', nextValue)
}

const handleWrapperClick = () => {
  if (props.disabled) return
  editorRef.value?.focus()
}

const handleFocus = () => {
  hasFocus.value = true
  emit('focus')
}

const handleBlur = () => {
  hasFocus.value = false
  emit('blur')
  window.setTimeout(() => {
    mention.visible = false
  }, 120)
}

const handleCompositionEnd = () => {
  isComposing.value = false
  handleInput()
}

const filterOptions = (query: string) => {
  const options = props.options || []
  if (!query) return options
  const lower = query.toLowerCase()
  return options.filter(option => option.label.toLowerCase().includes(lower))
}

const hasExistingTag = () => {
  const editor = editorRef.value
  return !!editor?.querySelector('.inspiration-tag')
}

const getCaretRect = () => {
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!editorRef.value || !editorRef.value.contains(range.startContainer)) return null
  const rect = range.getBoundingClientRect()
  if (rect && rect.height) return rect

  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  const cloneRange = range.cloneRange()
  cloneRange.insertNode(marker)
  const markerRect = marker.getBoundingClientRect()
  marker.parentNode?.removeChild(marker)
  selection.removeAllRanges()
  selection.addRange(range)
  return markerRect
}

const getTriggerState = () => {
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!editorRef.value || !editorRef.value.contains(range.startContainer)) return null
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null
  const textNode = range.startContainer as Text
  const text = textNode.textContent || ''
  const cursorOffset = range.startOffset
  const before = text.slice(0, cursorOffset)
  const match = before.match(/(^|[\s\u00a0\n])#([^\s#]*)$/)
  if (!match) return null
  const triggerOffset = (match.index ?? 0) + match[1].length
  return { textNode, triggerOffset, cursorOffset, query: match[2] || '' }
}

const updateMention = () => {
  if (props.disabled || isComposing.value) return
  if (hasExistingTag()) {
    mention.visible = false
    return
  }
  const trigger = getTriggerState()
  if (!trigger) {
    mention.visible = false
    return
  }
  const filtered = filterOptions(trigger.query)
  const shouldKeep =
    mention.visible &&
    mention.query === trigger.query &&
    mention.triggerOffset === trigger.triggerOffset
  const activeIndex = filtered.length
    ? Math.min(shouldKeep ? mention.activeIndex : 0, filtered.length - 1)
    : 0
  const caretRect = getCaretRect()
  const wrapperRect = wrapperRef.value?.getBoundingClientRect()
  const fallbackWidth = 220
  let left = 8
  let top = 0
  if (caretRect && wrapperRect) {
    const maxLeft = Math.max(8, wrapperRef.value!.clientWidth - fallbackWidth - 8)
    left = Math.min(Math.max(caretRect.left - wrapperRect.left, 8), maxLeft)
    top = caretRect.bottom - wrapperRect.top + 6
  }
  mention.visible = true
  mention.query = trigger.query
  mention.options = filtered
  mention.activeIndex = activeIndex
  mention.left = left
  mention.top = top
  mention.triggerNode = trigger.textNode
  mention.triggerOffset = trigger.triggerOffset
  mention.cursorOffset = trigger.cursorOffset
}

const insertTagNode = (value: string, fromTrigger = false) => {
  const rawValue = String(value || '').trim()
  const cleanValue = rawValue.startsWith('#') ? rawValue.slice(1) : rawValue
  if (!cleanValue) return
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount || !editorRef.value) return

  const range = document.createRange()
  if (fromTrigger && mention.triggerNode) {
    range.setStart(mention.triggerNode, mention.triggerOffset)
    range.setEnd(mention.triggerNode, mention.cursorOffset)
  } else {
    const activeRange = selection.getRangeAt(0)
    range.setStart(activeRange.startContainer, activeRange.startOffset)
    range.collapse(true)
  }
  range.deleteContents()

  const span = document.createElement('span')
  span.className = 'inspiration-tag'
  span.textContent = `#${cleanValue}`
  span.contentEditable = 'false'
  range.insertNode(span)
  const spaceNode = document.createTextNode('\u00a0')
  span.after(spaceNode)

  const nextRange = document.createRange()
  nextRange.setStart(spaceNode, 1)
  nextRange.setEnd(spaceNode, 1)
  selection.removeAllRanges()
  selection.addRange(nextRange)
}

const applyMention = (value: string) => {
  const rawValue = String(value || mention.query || '').trim()
  if (!rawValue) {
    mention.visible = false
    return
  }
  insertTagNode(rawValue, true)
  mention.visible = false
  emitValue()
}

const convertTagOnSpace = () => {
  if (hasExistingTag()) return
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) return
  const range = selection.getRangeAt(0)
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return
  const textNode = range.startContainer as Text
  const text = textNode.textContent || ''
  const cursorOffset = range.startOffset
  const lastChar = text[cursorOffset - 1]
  if (lastChar !== ' ' && lastChar !== '\u00a0') return
  const textBefore = text.slice(0, cursorOffset - 1)
  const match = textBefore.match(/(^|[\s\u00a0\n])(#[\u4e00-\u9fa5a-zA-Z0-9_-]+)$/)
  if (!match) return
  const tagText = match[2]
  const startIndex = (match.index ?? 0) + match[1].length
  const tagRange = document.createRange()
  tagRange.setStart(textNode, startIndex)
  tagRange.setEnd(textNode, cursorOffset)
  tagRange.deleteContents()

  const span = document.createElement('span')
  span.className = 'inspiration-tag'
  span.textContent = tagText
  span.contentEditable = 'false'
  tagRange.insertNode(span)
  const spaceNode = document.createTextNode('\u00a0')
  span.after(spaceNode)
  const nextRange = document.createRange()
  nextRange.setStart(spaceNode, 1)
  nextRange.setEnd(spaceNode, 1)
  selection.removeAllRanges()
  selection.addRange(nextRange)
  mention.visible = false
}

const handleInput = () => {
  if (props.disabled || isComposing.value) return
  convertTagOnSpace()
  emitValue()
  updateMention()
}

const handleKeydown = (event: KeyboardEvent) => {
  if (mention.visible) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (mention.options.length) {
        mention.activeIndex = (mention.activeIndex + 1) % mention.options.length
      }
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (mention.options.length) {
        mention.activeIndex =
          (mention.activeIndex - 1 + mention.options.length) % mention.options.length
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = mention.options[mention.activeIndex]
      applyMention(selected ? selected.value : mention.query)
      return
    }
    if (event.key === 'Escape') {
      mention.visible = false
      return
    }
  }

  if (event.key === 'Enter') {
    document.execCommand('insertLineBreak')
    event.preventDefault()
    return
  }

  if (event.key === 'Backspace') {
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!range.collapsed) return
    const node = range.startContainer
    const offset = range.startOffset
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
      const prev = (node as Text).previousSibling
      if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).classList.contains('inspiration-tag')) {
        event.preventDefault()
        prev.remove()
        emitValue()
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
      const prev = (node as Element).childNodes[offset - 1]
      if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).classList.contains('inspiration-tag')) {
        event.preventDefault()
        prev.remove()
        emitValue()
      }
    }
  }
}

const handleKeyup = () => {
  updateMention()
}

const handleClick = () => {
  updateMention()
}

const handlePaste = (event: ClipboardEvent) => {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!text) return
  const current = getPlainText()
  const remaining = Math.max(0, props.maxLength - current.length)
  const insertText = remaining ? text.slice(0, remaining) : ''
  if (!insertText) return
  document.execCommand('insertText', false, insertText)
}

const handleBeforeInput = (event: InputEvent) => {
  if (!props.maxLength || props.maxLength <= 0) return
  if (event.inputType?.startsWith('delete')) return
  const currentLength = getPlainText().length
  const data = (event as InputEvent).data || ''
  if (currentLength + data.length <= props.maxLength) return
  event.preventDefault()
  const remaining = Math.max(0, props.maxLength - currentLength)
  if (!remaining) return
  document.execCommand('insertText', false, data.slice(0, remaining))
}

const focus = () => {
  if (props.disabled) return
  editorRef.value?.focus()
}

const blur = () => {
  editorRef.value?.blur()
}

const getEditor = () => editorRef.value
const getValue = () => getPlainText()

defineExpose({ focus, blur, getEditor, getValue })

onMounted(() => {
  renderFromValue(props.modelValue || '')
  lastValue.value = props.modelValue || ''
})

watch(
  () => props.modelValue,
  value => {
    if (value === lastValue.value) return
    const current = getPlainText()
    if (value === current) {
      lastValue.value = value
      return
    }
    renderFromValue(value || '')
    lastValue.value = value || ''
  }
)

watch(
  () => props.disabled,
  disabled => {
    if (!disabled) return
    mention.visible = false
  }
)

watch(
  () => props.options,
  () => {
    if (mention.visible) updateMention()
  },
  { deep: true }
)
</script>

<style scoped lang="scss">
.inspiration-input {
  --inspiration-input-padding: 12px;
  --inspiration-input-radius: 12px;
  --inspiration-input-font-size: calc(12px * var(--ui-font-scale, 1));
  --inspiration-input-min-height: 120px;
  position: relative;
  width: 100%;

  &.variant-compact {
    --inspiration-input-padding: 8px 10px;
    --inspiration-input-radius: 8px;
    --inspiration-input-font-size: calc(12px * var(--ui-font-scale, 1));
    --inspiration-input-min-height: 96px;
  }

  &.variant-plain {
    --inspiration-input-padding: 0;
    --inspiration-input-radius: 0;
    --inspiration-input-min-height: 0;
  }
}

.inspiration-input__editor {
  min-height: var(--inspiration-input-min-height);
  border-radius: var(--inspiration-input-radius);
  border: 1px solid var(--ui-border);
  background: var(--input-bg);
  padding: var(--inspiration-input-padding);
  font-size: var(--inspiration-input-font-size);
  line-height: 1.6;
  color: var(--ink-main);
  outline: none;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;
}

.inspiration-input.variant-plain .inspiration-input__editor {
  border: none;
  background: transparent;
  padding: 0;
}

.inspiration-input.is-focused .inspiration-input__editor {
  border-color: var(--input-focus-border);
  background: var(--input-focus-bg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink-accent) 10%, transparent);
}

.inspiration-input.is-disabled {
  opacity: 0.6;
  cursor: not-allowed;

  .inspiration-input__editor {
    cursor: not-allowed;
  }
}

.inspiration-input__editor:empty::before {
  content: attr(data-placeholder);
  color: var(--ink-sec);
  opacity: 0.6;
  pointer-events: none;
}



.inspiration-input__mention {
  position: absolute;
  z-index: 20;
  min-width: 220px;
  max-width: 100%;
  background: var(--ui-glass-bg-hover);
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  box-shadow: var(--ui-shadow);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  backdrop-filter: blur(14px);
}

.mention-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(11px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
}

.mention-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.mention-item {
  border: none;
  background: transparent;
  color: var(--ink-main);
  font-size: calc(12px * var(--ui-font-scale, 1));
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  transition: background 0.2s ease, color 0.2s ease;

  &.active,
  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
    color: var(--ink-main);
  }
}

.mention-prefix {
  font-weight: 600;
  color: var(--ink-accent);
}

.mention-meta {
  margin-left: auto;
  font-size: calc(11px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
}

.mention-empty {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  padding: 4px 6px;
}
</style>
<style lang="scss">
.inspiration-tag {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 16%, transparent);
  color: var(--ink-accent);
  font-weight: 600;
  margin: 0 2px;
  vertical-align: 1px;
}
</style>
