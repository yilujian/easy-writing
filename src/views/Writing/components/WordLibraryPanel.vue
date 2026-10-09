<template>
  <section class="word-library-panel" aria-label="本书词库">
    <header class="word-library-heading">
      <h2>本书词库</h2>
      <button ref="addButton" type="button" class="word-library-add" :disabled="saving || !bookId" @click="beginAdd">
        <i class="fa-solid fa-plus" aria-hidden="true"></i>新增词条
      </button>
    </header>
    <div class="word-library-shortcut">
      <span>正文内快捷取词</span>
      <span class="word-library-keys" :aria-label="getWordLibraryShortcutTitle()">
        <kbd v-for="key in shortcutKeys" :key="key">{{ key }}</kbd>
      </span>
    </div>
    <div class="word-library-search-field">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input v-model="query" class="word-library-input" aria-label="搜索词库" placeholder="搜索词条、拼音或首字母" />
    </div>
    <form v-if="formVisible" class="word-library-form" @submit.prevent="save" @keydown.esc.prevent.stop="cancelEdit">
      <label for="word-library-draft">{{ editingId == null ? '新增词条' : '修改词条' }}</label>
      <input
        id="word-library-draft" ref="draftInput" v-model="draft" class="word-library-input"
        :disabled="saving || !bookId" maxlength="200" aria-label="词条内容" placeholder="输入常用人名、地名或短语" />
      <div class="word-library-actions">
        <button type="button" class="word-library-cancel" :disabled="saving" @click="cancelEdit">取消</button>
        <button class="word-library-save" :disabled="saving || !bookId || !draft.trim()">{{ saving ? '保存中…' : '保存词条' }}</button>
      </div>
    </form>
    <div class="word-library-count" aria-live="polite">{{ query.trim() ? `${filtered.length} 个匹配词条` : `${entries.length} 个词条` }}</div>
    <p v-if="loading" class="word-library-state" role="status">正在读取词库…</p>
    <p v-else-if="error" class="word-library-state" role="alert">{{ error }} <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" @click="load">重试</button></p>
    <p v-else-if="!filtered.length" class="word-library-state">{{ query ? '没有匹配的词条' : '点击“新增词条”，添加本书常用的人名、地名或短语。' }}</p>
    <div v-else class="word-library-list">
      <article v-for="entry in filtered" :key="entry.text" class="word-library-row" :class="{ 'is-editing': editingId === entry.customId }">
        <div class="word-library-copy">
          <strong>{{ entry.text }}</strong>
          <small>{{ sourceLabel(entry) }}</small>
          <span v-if="aliasOwners(entry)" class="word-library-alias">对应角色：{{ aliasOwners(entry) }}</span>
        </div>
        <div v-if="entry.customId != null" class="word-library-row-actions">
          <button type="button" class="word-library-icon-button" :disabled="saving" :aria-label="`修改${entry.text}`" title="修改词条" @click="edit(entry)">
            <EditPen aria-hidden="true" />
          </button>
          <button type="button" class="word-library-icon-button" :disabled="saving" :aria-label="`删除${entry.text}`" title="删除词条" @click="remove(entry)">
            <Delete aria-hidden="true" />
          </button>
        </div>
      </article>
    </div>
    <footer class="word-library-footer">角色与设定名称随原资料更新</footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Delete, EditPen } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { deleteCommonWord, listWordLibrary, saveCommonWord, WORD_LIBRARY_CHANGED } from '@/storage/local-word-library'
import { searchWordLibrary } from '@/utils/word-library-search'
import { getWordLibraryShortcutTitle, isMac } from '@/utils/platform'
import type { WordLibraryEntry } from '@/types/word-library'

const props = defineProps<{ bookId?: string | number }>()
const entries = ref<WordLibraryEntry[]>([])
const query = ref('')
const draft = ref('')
const editingId = ref<number | null>(null)
const formVisible = ref(false)
const draftInput = ref<HTMLInputElement>()
const addButton = ref<HTMLButtonElement>()
const shortcutKeys = isMac() ? ['⌘', '⇧', 'L'] : ['Ctrl', 'Shift', 'L']
const sourceLabel = (entry: WordLibraryEntry) => [...new Set(entry.sources.map(source => source.startsWith('别名 · ') ? '别名' : source))].join(' · ')
const aliasOwners = (entry: WordLibraryEntry) => entry.sources.filter(source => source.startsWith('别名 · ')).map(source => source.slice('别名 · '.length)).join('、')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
let revision = 0
const filtered = computed(() => searchWordLibrary(entries.value, query.value))
const reset = () => { draft.value = ''; editingId.value = null; formVisible.value = false }
const cancelEdit = () => {
  if (saving.value) return
  reset()
  addButton.value?.focus()
}
const beginAdd = async () => {
  reset()
  formVisible.value = true
  await nextTick()
  draftInput.value?.focus()
}
const load = async () => {
  const request = ++revision
  if (!props.bookId) { entries.value = []; loading.value = false; return }
  loading.value = true
  error.value = ''
  try {
    const data = await listWordLibrary(props.bookId)
    if (request === revision) entries.value = data
  } catch (cause) {
    if (request === revision) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (request === revision) loading.value = false }
}
const edit = async (entry: WordLibraryEntry) => {
  editingId.value = entry.customId!
  draft.value = entry.text
  formVisible.value = true
  await nextTick()
  draftInput.value?.focus()
  draftInput.value?.select()
}
const save = async () => {
  if (!props.bookId || saving.value) return
  const bookId = props.bookId
  saving.value = true
  try {
    await saveCommonWord(bookId, draft.value, editingId.value ?? undefined)
    if (props.bookId === bookId) { reset(); await load(); ElMessage.success('词条已保存') }
  } catch (cause) { ElMessage.warning(cause instanceof Error ? cause.message : String(cause)) }
  finally { saving.value = false }
}
const remove = async (entry: WordLibraryEntry) => {
  if (!props.bookId || entry.customId == null || saving.value) return
  const bookId = props.bookId
  saving.value = true
  try {
    await deleteCommonWord(bookId, entry.customId)
    if (props.bookId === bookId) { if (editingId.value === entry.customId) reset(); await load() }
  } catch (cause) { ElMessage.error(cause instanceof Error ? cause.message : String(cause)) }
  finally { saving.value = false }
}
watch(() => props.bookId, () => { reset(); query.value = ''; void load() }, { immediate: true })
onActivated(load)
const handleChanged = (event: Event) => {
  if (!saving.value && (event as CustomEvent).detail?.bookId === String(props.bookId)) void load()
}
onMounted(() => window.addEventListener(WORD_LIBRARY_CHANGED, handleChanged))
onBeforeUnmount(() => { revision++; window.removeEventListener(WORD_LIBRARY_CHANGED, handleChanged) })
</script>

<style scoped lang="scss">
.word-library-panel {
  width: 100%; flex: 1; min-width: 0; height: 100%; min-height: 0; box-sizing: border-box;
  display: flex; flex-direction: column; padding: 20px; overflow: hidden;
  color: var(--ink-main); background: var(--word-library-panel-bg, var(--popover-bg)); font-size: 14px;
}
.word-library-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.word-library-heading h2 { margin: 0; font-family: inherit; font-size: 22px; font-weight: 600; line-height: 1.4; }
.word-library-add { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 32px; padding: 5px 10px; border: 1px solid currentColor; border-radius: 5px; color: var(--word-library-accent, var(--ink-accent)); background: transparent; font: inherit; cursor: pointer; }
.word-library-add:hover { background: var(--accent-soft); }
.word-library-shortcut { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 15px 0 18px; font-size: 13px; color: var(--ink-sec); }
.word-library-keys { display: inline-flex; gap: 4px; }
kbd { min-width: 23px; height: 23px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 5px; border: 1px solid var(--ui-border-hover); border-radius: 4px; color: var(--ink-sec); background: var(--input-bg); font-family: inherit; font-size: 12px; box-shadow: 0 1px 1px var(--divider); }
.word-library-search-field { position: relative; flex-shrink: 0; }
.word-library-search-field > i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-sec); font-size: 14px; pointer-events: none; }
.word-library-input { width: 100%; min-width: 0; height: 38px; box-sizing: border-box; padding: 8px 10px; color: var(--ink-main); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 5px; font: inherit; }
.word-library-search-field .word-library-input { padding-left: 35px; }
.word-library-input::placeholder { color: var(--ink-sec); opacity: 1; }
.word-library-input:focus-visible { outline: 2px solid var(--word-library-accent, var(--ink-accent)); outline-offset: 1px; }
.word-library-form { display: flex; flex-direction: column; gap: 9px; flex-shrink: 0; margin-top: 14px; padding: 12px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--input-bg); }
.word-library-form label { color: var(--ink-sec); font-size: 12px; }
.word-library-actions { display: flex; justify-content: flex-end; gap: 8px; }
.word-library-cancel, .word-library-save { min-height: 30px; padding: 4px 12px; border-radius: 4px; font: inherit; cursor: pointer; }
.word-library-cancel { border: 1px solid var(--ui-border-hover); color: var(--ink-main); background: transparent; }
.word-library-save { border: 1px solid var(--btn-primary-bg); color: var(--btn-primary-color); background: var(--btn-primary-bg); }
.word-library-count { flex-shrink: 0; padding: 18px 0 8px; color: var(--ink-sec); font-size: 13px; }
.word-library-state { margin: 12px 0; line-height: 1.7; color: var(--ink-sec); }
.word-library-list { flex: 1; min-height: 0; overflow-y: auto; margin: 0 -8px; padding: 0 8px; }
.word-library-row { display: flex; align-items: center; gap: 10px; min-height: 74px; box-sizing: border-box; position: relative; padding: 12px 2px; border-bottom: 1px solid var(--ui-border); }
.word-library-row::before { content: ''; position: absolute; inset: 4px -8px; border-radius: 5px; background: var(--accent-soft); opacity: 0; pointer-events: none; }
.word-library-row:hover::before, .word-library-row:focus-within::before, .word-library-row.is-editing::before { opacity: 1; }
.word-library-copy { position: relative; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.word-library-copy strong { display: block; font-size: 18px; font-weight: 500; line-height: 1.5; }
.word-library-copy small { display: block; margin-top: 2px; color: var(--ink-sec); font-size: 13px; line-height: 1.5; }
.word-library-alias { display: block; margin-top: 4px; color: var(--ink-sec); font-size: 13px; line-height: 1.5; }
.word-library-row-actions { position: relative; display: flex; flex-shrink: 0; gap: 4px; opacity: 0; pointer-events: none; }
.word-library-row:hover .word-library-row-actions, .word-library-row:focus-within .word-library-row-actions, .word-library-row.is-editing .word-library-row-actions { opacity: 1; pointer-events: auto; }
.word-library-icon-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 5px; border: 0; border-radius: 4px; color: var(--word-library-accent, var(--ink-accent)); background: transparent; cursor: pointer; }
.word-library-icon-button svg { width: 19px; height: 19px; }
.word-library-icon-button:hover { background: var(--overlay-active); }
button:focus-visible { outline: 2px solid var(--word-library-accent, var(--ink-accent)); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.word-library-footer { margin-top: auto; padding-top: 15px; border-top: 1px solid var(--ui-border); color: var(--ink-sec); text-align: center; font-size: 13px; line-height: 1.6; }
@media (hover: none) { .word-library-row-actions { opacity: 1; pointer-events: auto; } }
</style>
