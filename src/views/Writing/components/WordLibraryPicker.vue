<template>
  <Teleport to="body">
    <section
      ref="root" class="word-picker" :style="{ left: position.left + 'px', top: position.top + 'px' }"
      aria-label="快捷取词" @keydown.stop="onKeydown">
      <div class="word-picker-heading">
        <strong>快捷取词</strong>
        <button type="button" class="word-picker-escape" aria-label="关闭取词" @click="emit('close')">Esc</button>
      </div>
      <div class="word-picker-search-field">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input
          ref="input" v-model="query" class="word-picker-search" role="combobox" aria-label="搜索词条"
          aria-autocomplete="list" aria-controls="word-picker-list" :aria-expanded="!loading && !error && results.length > 0"
          :aria-activedescendant="results.length ? `word-choice-${active}` : undefined"
          placeholder="搜索词条、拼音或首字母" autocomplete="off"
          @compositionstart="composing = true" @compositionend="composing = false" />
        <button v-if="query" type="button" class="word-picker-clear" aria-label="清空词条搜索" @click="clearQuery">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <p v-if="loading" class="word-picker-state" role="status">正在读取本书词库…</p>
      <p v-else-if="error" class="word-picker-state" role="alert">{{ error }}</p>
      <p v-else-if="!results.length" class="word-picker-state">{{ entries.length ? '没有匹配的词条' : '暂无词条，可在右侧“词库”中添加' }}</p>
      <div v-else id="word-picker-list" class="word-picker-list" role="listbox" aria-label="词条候选">
        <button
          v-for="(entry, index) in results" :id="`word-choice-${index}`" :key="entry.text"
          class="word-picker-option" :class="{ active: index === active }" type="button" role="option"
          :aria-selected="index === active" tabindex="-1" @mousedown.prevent @click="emit('insert', entry.text)">
          <strong>{{ entry.text }}</strong>
          <small :title="entry.sources.join(' · ')">{{ sourceLabel(entry) }}</small>
          <Back v-if="index === active" class="word-picker-return" aria-hidden="true" />
          <span v-else class="word-picker-return-placeholder" aria-hidden="true"></span>
        </button>
      </div>
      <footer class="word-picker-footer"><span>↑↓ 选择</span><span>Enter 插入</span><span>Esc 关闭</span></footer>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { Back } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WordLibraryEntry } from '@/types/word-library'
import { searchWordLibrary } from '@/utils/word-library-search'

const props = defineProps<{ entries: WordLibraryEntry[]; loading: boolean; error: string; position: { left: number; top: number } }>()
const emit = defineEmits<{ insert: [text: string]; close: [focus?: boolean] }>()
const query = ref('')
const active = ref(0)
const composing = ref(false)
const input = ref<HTMLInputElement>()
const root = ref<HTMLElement>()
const sourceLabel = (entry: WordLibraryEntry) => [...new Set(entry.sources.map(source => source.startsWith('别名 · ') ? '别名' : source))].join(' · ')
const clearQuery = () => { query.value = ''; input.value?.focus() }
const results = computed(() => searchWordLibrary(props.entries, query.value).slice(0, 50))
watch(results, () => { active.value = 0 })
const onKeydown = async (event: KeyboardEvent) => {
  if (event.isComposing || composing.value || event.keyCode === 229) return
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.target !== input.value) return
  if (event.key === 'Tab') { emit('close', false); return }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (!props.loading && results.value[active.value]) emit('insert', results.value[active.value].text)
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = Math.max(0, Math.min(results.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
    await nextTick()
    root.value?.querySelector(`#word-choice-${active.value}`)?.scrollIntoView({ block: 'nearest' })
  }
}
const outside = (event: PointerEvent) => {
  if (event.target instanceof Node && !root.value?.contains(event.target)) emit('close', false)
}
onMounted(() => { input.value?.focus(); document.addEventListener('pointerdown', outside, true) })
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<style scoped>
.word-picker { position: fixed; z-index: 4201; width: min(360px, calc(100vw - 24px)); max-height: min(350px, calc(100vh - 24px)); box-sizing: border-box; display: flex; flex-direction: column; padding: 14px; border: 1px solid var(--ui-border-hover); border-radius: 6px; color: var(--ink-main); background: var(--popover-bg); box-shadow: var(--ui-shadow); }
.word-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 2px 12px; flex-shrink: 0; }
.word-picker-heading strong { font-size: 18px; font-weight: 600; line-height: 1.5; }
.word-picker-escape { padding: 2px 6px; border: 1px solid var(--ui-border-hover); border-radius: 4px; color: var(--ink-sec); background: var(--input-bg); box-shadow: 0 1px 1px var(--divider); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.word-picker-escape:hover { color: var(--ink-main); background: var(--accent-soft); }
.word-picker-search-field { display: flex; align-items: center; position: relative; flex-shrink: 0; }
.word-picker-search-field > i { position: absolute; left: 11px; font-size: 14px; color: var(--ink-sec); pointer-events: none; }
.word-picker-search { width: 100%; min-width: 0; height: 36px; box-sizing: border-box; padding: 7px 32px; font: inherit; font-size: 14px; color: var(--ink-main); background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 5px; }
.word-picker-search::placeholder { color: var(--ink-sec); opacity: 1; }
.word-picker-search:focus-visible { outline: 2px solid var(--word-library-accent, var(--ink-accent)); outline-offset: 1px; }
.word-picker-clear { position: absolute; right: 5px; display: grid; place-items: center; width: 25px; height: 25px; border: 0; border-radius: 4px; color: var(--ink-sec); background: transparent; cursor: pointer; }
.word-picker-clear:hover { color: var(--ink-main); background: var(--overlay-hover); }
.word-picker-list { min-height: 0; overflow-y: auto; margin-top: 10px; }
.word-picker-option { width: 100%; min-height: 40px; display: grid; grid-template-columns: minmax(0, 1fr) auto 18px; align-items: center; gap: 12px; padding: 8px 10px; border: 0; border-radius: 4px; background: transparent; color: var(--ink-main); font: inherit; text-align: left; cursor: pointer; }
.word-picker-option strong { min-width: 0; overflow-wrap: anywhere; font-size: 17px; font-weight: 500; line-height: 1.5; }
.word-picker-option small { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-sec); font-size: 13px; }
.word-picker-option.active, .word-picker-option:hover { background: var(--accent-soft); }
.word-picker-return { width: 18px; height: 18px; color: var(--word-library-accent, var(--ink-accent)); }
.word-picker-return-placeholder { width: 18px; }
.word-picker-state { margin: 16px 2px; color: var(--ink-sec); font-size: 13px; line-height: 1.6; }
.word-picker-footer { display: flex; justify-content: space-between; gap: 8px; flex-shrink: 0; margin: 10px 2px 0; padding-top: 10px; border-top: 1px solid var(--ui-border); color: var(--ink-sec); font-size: 12px; line-height: 1.5; }
button:focus-visible { outline: 2px solid var(--word-library-accent, var(--ink-accent)); outline-offset: -2px; }
</style>
