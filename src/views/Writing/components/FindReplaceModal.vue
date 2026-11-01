<template>
  <EwModal
    v-model:visible="visible"
    title="查找替换"
    width="480px"
    :modal="false"
    :close-on-click-modal="false"
    :show-close="!replacing"
    :draggable="true"
    custom-class="find-replace-dialog"
    :initial-position="props.initialPosition"
    :header-style="{ padding: '16px 20px 12px' }"
    :body-style="{ padding: '0 20px 16px' }"
    @close="onClose"
  >
    <template #header><h2 class="find-title">查找替换</h2></template>
    <div class="find-replace-body" :aria-busy="busy">
      <div class="find-row">
        <label for="chapter-find-query">查找</label>
        <el-input
          id="chapter-find-query"
          v-model="query"
          class="find-field"
          placeholder="输入查找词"
          :disabled="replacing"
          @keydown.enter.prevent="navigate(1)"
        >
          <template #suffix>
            <button
              type="button"
              class="book-search-action"
              :disabled="!query || busy || !bookId"
              @click="searchBook"
            >
              <i v-if="searching" class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
              {{ searching ? '搜索中' : '搜索全书' }}
            </button>
          </template>
        </el-input>
      </div>
      <div class="find-row">
        <label for="chapter-find-replace">替换</label>
        <el-input
          id="chapter-find-replace"
          v-model="replace"
          class="find-field"
          placeholder="替换词为空时，执行删除"
          :disabled="readOnly || replacing"
          @keydown.enter.prevent="replaceCurrent"
        />
      </div>
      <div class="find-actions">
        <div class="find-navigation" aria-label="匹配项导航">
          <button
            type="button"
            class="find-arrow"
            aria-label="上一个匹配"
            :disabled="busy || !total"
            @click="navigate(-1)"
          >
            <i class="fa-solid fa-caret-left" aria-hidden="true"></i>
          </button>
          <span class="match-count" aria-live="polite">{{ total ? `${position}/${total}` : '—' }}</span>
          <button
            type="button"
            class="find-arrow"
            aria-label="下一个匹配"
            :disabled="busy || !total"
            @click="navigate(1)"
          >
            <i class="fa-solid fa-caret-right" aria-hidden="true"></i>
          </button>
        </div>
        <div class="replace-actions">
          <button
            type="button"
            class="ink-btn ink-btn-primary ink-btn-sm"
            :disabled="!canReplace"
            @click="replaceCurrent"
          >
            替换
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline ink-btn-sm"
            :disabled="!canReplace"
            @click="replaceChapter"
          >
            本章替换
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline ink-btn-sm"
            :disabled="busy || readOnly || !ready || !query || query === replace || !bookId || !commitBook"
            @click="replaceBook"
          >
            {{ replacing ? '替换中' : '全书替换' }}
          </button>
        </div>
      </div>
      <p v-if="readOnly" class="find-hint">当前正文暂不可替换，可继续查找。</p>
      <p
        v-if="notice"
        class="find-notice"
        :class="{ error: noticeError }"
        :role="noticeError ? 'alert' : 'status'"
      >
        {{ notice }}
      </p>
      <section v-if="bookResult" class="book-find-results" aria-label="全书搜索结果">
        <div class="book-result-heading">
          <span>全书正文 · {{ bookResult.chapters.length }} 章 · {{ bookResult.total }} 处</span>
          <button type="button" :disabled="busy" @click="leaveBookSearch">返回本章</button>
        </div>
        <p v-if="stale" class="find-hint">正文已变化，下次定位时将重新搜索。</p>
        <p v-if="!bookResult.total" class="find-empty">全书正文中没有找到“{{ bookResult.query }}”</p>
        <div v-else class="book-result-list">
          <button
            v-for="chapter in bookResult.chapters"
            :key="chapter.chapterId"
            type="button"
            class="book-result"
            :class="{ active: chapter.chapterId === activeChapterId }"
            :disabled="busy"
            @click="openResult(chapter.chapterId)"
          >
            <span class="book-result-title"
              ><strong>{{ chapter.title }}</strong
              ><small>{{ chapter.matches.length }} 处</small></span
            >
            <span class="book-result-volume"
              >{{ chapter.volumeTitle }}<span v-if="chapter.readOnly"> · 暂不可替换</span></span
            >
            <span class="book-result-snippet"
              >{{ chapter.snippet.before }}<mark>{{ chapter.snippet.match }}</mark
              >{{ chapter.snippet.after }}</span
            >
          </button>
        </div>
      </section>
    </div>
  </EwModal>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Transaction } from 'prosemirror-state'
import type { ChapterReplacementBatch, ChapterReplacementResult } from '@/storage/writing-storage'
import { findInBook, prepareBookReplacement, type BookFindResult } from '@/storage/book-find'
import { inkConfirm } from '@/utils/ink-confirm'
import { findReplacePluginKey } from '../extends/FindReplaceExtension'
import EwModal from '@/components/EwModal/index.vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    editor: Editor | null | undefined
    initialPosition?: { x: number; y: number }
    readOnly?: boolean
    ready?: boolean
    bookId?: string | number
    activeChapterId?: number | null
    prepareBook?: () => Promise<boolean>
    openChapter?: (chapterId: number) => Promise<void>
    commitBook?: (batch: ChapterReplacementBatch) => Promise<ChapterReplacementResult & { warning?: string }>
  }>(),
  {
    ready: true,
    readOnly: false,
    initialPosition: undefined,
    bookId: undefined,
    activeChapterId: undefined,
    prepareBook: undefined,
    openChapter: undefined,
    commitBook: undefined
  }
)
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
const visible = ref(false),
  query = ref(''),
  replace = ref('')
const searching = ref(false),
  replacing = ref(false),
  navigating = ref(false)
const busy = computed(() => searching.value || replacing.value || navigating.value)
const notice = ref(''),
  noticeError = ref(false),
  stale = ref(false)
const bookResult = shallowRef<BookFindResult | null>(null)
let requestVersion = 0,
  disposed = false
let observedEditor: Editor | null | undefined
let updateHandler: ((event: { transaction: Transaction }) => void) | null = null
const updateTrigger = ref(0)

function synchronizeEditor() {
  const editor = props.editor
  if (!editor || editor.isDestroyed) return
  // 输入框是查找条件的唯一来源，切章、重新打开、替换前同步两个值，允许替换为空。
  editor.commands.setFindOptions(visible.value ? query.value : '', replace.value)
}
watch(
  () => props.modelValue,
  value => {
    visible.value = value
    synchronizeEditor()
  },
  { immediate: true }
)
watch(visible, value => {
  emit('update:modelValue', value)
  if (!value) onClose()
})
watch(
  () => props.editor,
  nextEditor => {
    if (observedEditor && updateHandler) observedEditor.off('transaction', updateHandler)
    observedEditor = nextEditor
    updateHandler = null
    updateTrigger.value++
    if (!nextEditor || nextEditor.isDestroyed) return
    updateHandler = ({ transaction }) => {
      updateTrigger.value++
      if (transaction.docChanged && bookResult.value) stale.value = true
    }
    nextEditor.on('transaction', updateHandler)
    synchronizeEditor()
  },
  { immediate: true }
)
watch(query, () => {
  requestVersion++
  bookResult.value = null
  stale.value = false
  notice.value = ''
  synchronizeEditor()
})
watch(replace, synchronizeEditor)
watch(
  () => props.bookId,
  () => {
    requestVersion++
    bookResult.value = null
    notice.value = ''
  }
)
const state = computed(() => {
  void updateTrigger.value
  if (!props.editor || props.editor.isDestroyed || !props.ready) return { count: 0, index: 0 }
  const value = findReplacePluginKey.getState(props.editor.state)
  return { count: value?.matches.length || 0, index: value?.index || 0 }
})
const total = computed(() => bookResult.value?.total ?? state.value.count)
const globalIndex = computed(() => {
  if (!bookResult.value) return state.value.count ? state.value.index : -1
  let offset = 0
  for (const chapter of bookResult.value.chapters) {
    if (chapter.chapterId === props.activeChapterId)
      return state.value.count ? offset + Math.min(state.value.index, chapter.matches.length - 1) : -1
    offset += chapter.matches.length
  }
  return -1
})
const position = computed(() => Math.max(0, globalIndex.value + 1))
const canReplace = computed(
  () =>
    !props.readOnly &&
    props.ready &&
    !busy.value &&
    Boolean(props.editor?.isEditable) &&
    state.value.count > 0 &&
    query.value !== replace.value
)
function failure(cause: unknown) {
  if (
    cause === 'cancel' ||
    cause === 'close' ||
    (cause instanceof DOMException && cause.name === 'AbortError')
  )
    return
  noticeError.value = true
  notice.value = cause instanceof Error ? cause.message : String(cause)
}
async function searchBook() {
  if (!props.bookId || !query.value || busy.value) return
  const version = ++requestVersion,
    bookId = props.bookId,
    term = query.value
  searching.value = true
  notice.value = ''
  noticeError.value = false
  try {
    if (props.prepareBook && !(await props.prepareBook()))
      throw new Error('当前章节尚未保存，请先处理后再搜索全书')
    const result = await findInBook(
      bookId,
      term,
      () => version !== requestVersion || disposed || !visible.value
    )
    if (version === requestVersion && !disposed) {
      bookResult.value = result
      stale.value = false
    }
  } catch (cause) {
    if (version === requestVersion) failure(cause)
  } finally {
    searching.value = false
  }
}
async function goTo(chapterId: number, index: number) {
  const version = requestVersion
  navigating.value = true
  try {
    if (props.activeChapterId !== chapterId) {
      if (!props.openChapter) throw new Error('当前页面不支持跨章定位')
      await props.openChapter(chapterId)
      await nextTick()
    }
    if (disposed || version !== requestVersion || !visible.value) return
    synchronizeEditor()
    if (!props.editor?.commands.goToFindMatch(index)) {
      stale.value = true
      throw new Error('该匹配位置已变化，请重新搜索')
    }
  } catch (cause) {
    failure(cause)
  } finally {
    navigating.value = false
  }
}
async function openResult(chapterId: number) {
  if (busy.value) return
  if (stale.value) await searchBook()
  if (bookResult.value?.chapters.some(chapter => chapter.chapterId === chapterId)) await goTo(chapterId, 0)
}
async function navigate(direction: 1 | -1) {
  if (busy.value || !query.value) return
  if (!bookResult.value) {
    direction === 1 ? props.editor?.commands.nextMatch() : props.editor?.commands.prevMatch()
    return
  }
  if (stale.value) await searchBook()
  if (!bookResult.value?.total) return
  let index =
    globalIndex.value < 0
      ? direction === 1
        ? 0
        : total.value - 1
      : (globalIndex.value + direction + total.value) % total.value
  for (const chapter of bookResult.value.chapters) {
    if (index < chapter.matches.length) {
      await goTo(chapter.chapterId, index)
      return
    }
    index -= chapter.matches.length
  }
}
function replaceCurrent() {
  if (!canReplace.value) return
  synchronizeEditor()
  props.editor?.commands.replaceCurrent()
}
function replaceChapter() {
  if (!canReplace.value) return
  const count = state.value.count
  synchronizeEditor()
  props.editor?.commands.replaceAllInDoc()
  noticeError.value = false
  notice.value = `本章已替换 ${count} 处`
}
async function replaceBook() {
  if (
    busy.value ||
    props.readOnly ||
    !props.ready ||
    !props.bookId ||
    !props.commitBook ||
    !query.value ||
    query.value === replace.value
  )
    return
  const bookId = props.bookId,
    term = query.value,
    replacement = replace.value,
    version = ++requestVersion
  replacing.value = true
  notice.value = ''
  noticeError.value = false
  try {
    if (props.prepareBook && !(await props.prepareBook())) throw new Error('当前章节尚未保存，已停止全书替换')
    const result = await findInBook(bookId, term, () => version !== requestVersion || disposed)
    if (!result.total) {
      bookResult.value = result
      notice.value = '全书没有可替换的匹配项'
      return
    }
    if (!visible.value || version !== requestVersion || disposed) return
    const batch = prepareBookReplacement(result, replacement)
    await inkConfirm(
      `将在当前作品的 ${result.chapters.length} 个章节中${replacement ? `替换 ${result.total} 处“${term}”为“${replacement}”` : `删除 ${result.total} 处“${term}”`}。替换前会保留各章历史版本。是否继续？`,
      '确认全书替换',
      { confirmButtonText: '确认替换', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }
    )
    if (version !== requestVersion || disposed || !visible.value || props.bookId !== bookId || props.readOnly)
      throw new Error('替换范围已变化，请重新搜索确认')
    const outcome = await props.commitBook(batch)
    bookResult.value = null
    stale.value = false
    notice.value =
      outcome.warning ||
      `已替换 ${outcome.chapterIds.length} 章，共 ${outcome.count} 处；原文可在章节历史中恢复。`
  } catch (cause) {
    failure(cause)
  } finally {
    replacing.value = false
  }
}
function leaveBookSearch() {
  requestVersion++
  bookResult.value = null
  stale.value = false
  notice.value = ''
}
function onClose() {
  if (replacing.value) return
  requestVersion++
  if (props.editor && !props.editor.isDestroyed) props.editor.commands.setFindQuery('')
}
onBeforeUnmount(() => {
  disposed = true
  requestVersion++
  if (observedEditor && updateHandler) observedEditor.off('transaction', updateHandler)
})
</script>

<style scoped lang="scss">
.find-replace-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.find-title {
  margin: 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
  color: var(--ink-main);
  line-height: calc(20px * var(--ui-font-scale, 1));
}
.find-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.find-row label {
  flex: 0 0 28px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-main);
}
.find-field {
  flex: 1;
  min-width: 0;
}
.find-field :deep(.el-input__wrapper) {
  min-height: 34px;
  padding: 0 10px;
  background: var(--input-bg);
  border-radius: 4px;
}
.find-field :deep(.el-input__inner) {
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.book-search-action {
  border: 0;
  padding: 5px 0 5px 8px;
  color: color-mix(in srgb, var(--ink-main) 65%, var(--ink-accent));
  background: transparent;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
  white-space: nowrap;
}
.find-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  margin-top: 2px;
}
.find-navigation {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  min-width: 100px;
  gap: 6px;
}
.find-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--ink-sec);
  cursor: pointer;
  font-size: calc(18px * var(--ui-font-scale, 1));
}
.find-arrow:not(:disabled):hover,
.find-arrow:not(:disabled):focus-visible {
  background: var(--overlay-hover);
  color: var(--ink-main);
}
.match-count {
  font-size: calc(15px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.replace-actions {
  display: flex;
  gap: 8px;
}
.replace-actions .ink-btn {
  min-height: 32px;
  min-width: 68px;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.find-replace-body button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.find-replace-body button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink-main) 65%, var(--ink-accent));
  outline-offset: 2px;
}
.find-hint,
.find-notice,
.find-empty {
  margin: 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.find-notice.error {
  color: var(--state-danger);
}
.book-find-results {
  border-top: 1px solid var(--divider);
  padding-top: 10px;
}
.book-result-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-bottom: 8px;
}
.book-result-heading button {
  border: 0;
  padding: 3px 0;
  color: color-mix(in srgb, var(--ink-main) 65%, var(--ink-accent));
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.book-result-list {
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.book-result {
  display: block;
  width: 100%;
  padding: 10px;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--divider);
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  font: inherit;
}
.book-result:hover,
.book-result.active {
  background: var(--overlay-hover);
}
.book-result-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.book-result-title strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.book-result-title small {
  white-space: nowrap;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
.book-result-volume {
  display: block;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  margin: 4px 0;
}
.book-result-snippet {
  display: block;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.book-result-snippet mark {
  color: var(--ink-main);
  background: var(--accent-soft);
}
@media (max-width: 520px) {
  .find-actions {
    flex-wrap: wrap;
  }
  .find-navigation {
    flex: 0 0 120px;
  }
  .replace-actions {
    margin-left: auto;
    flex-wrap: wrap;
  }
}
</style>
