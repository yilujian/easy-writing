<template>
  <details class="pi-resource-provenance">
    <summary>存入已有作品</summary>
    <label
      >作品
      <select v-model="bookId">
        <option value="">请选择作品</option>
        <option v-for="b in books" :key="b.id" :value="b.id">{{ b.title }}</option>
      </select></label
    >
    <label
      >存入方式
      <select v-model="target">
        <option value="append">在分卷末尾追加新章</option>
        <option value="selection">替换指定章节的选段</option>
      </select></label
    >
    <template v-if="target === 'append'">
      <label
        >分卷
        <select v-model="volumeId">
          <option value="">请选择分卷</option>
          <option v-for="v in tree" :key="v.id" :value="String(v.id)">{{ v.title }}</option>
        </select></label
      >
      <label>新章标题 <input v-model="title" /></label>
    </template>
    <template v-else>
      <label
        >章节
        <select v-model="chapterId">
          <option value="">请选择原章</option>
          <optgroup v-for="v in tree" :key="v.id" :label="v.title">
            <option v-for="c in v.children" :key="c.id" :value="String(c.id)">{{ c.title }}</option>
          </optgroup>
        </select></label
      >
      <label
        >原文（选中要替换的范围）<textarea :value="original" readonly rows="5" @select="selectText" />
      </label>
      <small v-if="selection">已选 {{ selection.text.length }} 字</small>
    </template>
    <button
      type="button"
      class="ink-btn ink-btn-outline"
      :disabled="busy || !bookId || (target === 'append' ? !volumeId || !title.trim() : !selection)"
      @click="prepare"
    >
      预览保存目标
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
  </details>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { getLocalLibraryStorage, LOCAL_USER_ID } from '@/storage/local-library'
import { getWritingStorage } from '@/storage'
import { piCommand } from '@/agent-pi/client'
import { savePiDraftEdit } from '@/agent-pi/platform-tools'
import type { PiBook, PiDraft } from '@/types/agent-pi'
const props = defineProps<{ draft: PiDraft; content: string; books: PiBook[]; disabled: boolean }>()
const emit = defineEmits<{ prepared: [draft: PiDraft] }>()
const bookId = ref(''),
  target = ref('append'),
  volumeId = ref(''),
  chapterId = ref(''),
  title = ref(props.draft.title),
  original = ref(''),
  version = ref(0),
  busy = ref(false),
  error = ref('')
const tree = ref<Awaited<ReturnType<ReturnType<typeof getLocalLibraryStorage>['getLocalBookTree']>>>([])
const selection = ref<{ text: string; occurrence: number } | null>(null)
watch(bookId, async id => {
  tree.value = []
  volumeId.value = ''
  chapterId.value = ''
  if (id) {
    const rows = await getLocalLibraryStorage().getLocalBookTree(id)
    if (id === bookId.value) tree.value = rows
  }
})
watch(chapterId, async id => {
  original.value = ''
  selection.value = null
  const book = bookId.value
  if (id) {
    const c = await getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, book, Number(id))
    if (chapterId.value === id && book === bookId.value) {
      original.value = c?.textContent || ''
      version.value = c?.localVersion || 0
    }
  }
})
function selectText(event: Event) {
  const el = event.target as HTMLTextAreaElement
  const text = el.value.slice(el.selectionStart, el.selectionEnd)
  selection.value = text
    ? { text, occurrence: el.value.slice(0, el.selectionStart).split(text).length }
    : null
}
async function prepare() {
  if (props.disabled || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const d = await savePiDraftEdit(props.draft.id, props.content, props.draft.revision ?? 0)
    const saved = await piCommand<PiDraft>('target_text', {
      id: d.id,
      revision: d.revision,
      bookId: bookId.value,
      target: target.value,
      title: title.value,
      volumeId: volumeId.value,
      chapterId: chapterId.value,
      selection: selection.value,
      version: version.value
    })
    emit('prepared', saved)
  } catch (cause) {
    error.value = String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<style scoped>
label {
  display: block;
  margin: 0.5rem 0;
}
select,
input,
textarea {
  max-width: 100%;
}
textarea {
  display: block;
  width: 100%;
}
</style>
