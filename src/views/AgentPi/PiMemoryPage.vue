<template>
  <section class="pi-memory-page" aria-label="长期记忆">
    <div class="pi-memory-toolbar">
      <div class="pi-memory-tabs" role="group" aria-label="记忆范围">
        <button
          v-for="item in scopes"
          :key="item.id"
          type="button"
          class="ink-btn ink-btn-sm"
          :class="scope === item.id ? 'ink-btn-primary' : 'ink-btn-outline'"
          :aria-pressed="scope === item.id"
          @click="scope = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <el-select v-if="scope === 'book'" v-model="bookId" placeholder="选择作品" aria-label="选择作品">
        <el-option v-for="book in store.books" :key="book.id" :value="book.id" :label="book.title" />
      </el-select>
      <button
        class="ink-btn ink-btn-outline ink-btn-sm"
        :disabled="saving || (scope === 'book' && !bookId)"
        @click="edit()"
      >
        新增记忆
      </button>
    </div>
    <p v-if="error" role="alert" class="pi-error">{{ error }}</p>
    <p v-if="loading" role="status">正在读取…</p>
    <p v-else-if="scope === 'book' && !bookId" class="pi-memory-empty">选择作品，查看它的事实记忆。</p>
    <div v-else class="pi-memory-layout">
      <div class="pi-memory-list">
        <p v-if="!visible.length" class="pi-memory-empty">
          还没有{{ scope === 'author' ? '作者偏好' : '作品事实' }}。可以在对话中说“记住…”，也可以在这里添加。
        </p>
        <button
          v-for="row in visible"
          :key="row.id"
          class="pi-memory-row"
          :class="{ 'is-active': selected?.id === row.id }"
          :disabled="saving"
          @click="edit(row)"
        >
          <span>{{ row.content }}</span
          ><small>{{ row.source === 'confirmed' ? '对话中确认' : '手动编辑' }}</small>
        </button>
      </div>
      <form v-if="editing" class="pi-memory-editor" @submit.prevent="save">
        <label for="pi-memory-content">{{
          scope === 'author' ? '作者偏好 · 适用于所有作品' : '作品事实 · 仅适用于所选作品'
        }}</label>
        <textarea
          id="pi-memory-content"
          v-model="content"
          class="ink-textarea"
          rows="9"
          maxlength="1200"
          :disabled="saving"
          placeholder="写下一条需要长期记住的偏好或事实"
        />
        <div class="pi-memory-actions">
          <button
            type="submit"
            class="ink-btn ink-btn-primary ink-btn-sm"
            :disabled="saving || !content.trim()"
          >
            保存
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline ink-btn-sm"
            :disabled="saving"
            @click="editing = false"
          >
            取消
          </button>
          <button
            v-if="selected"
            type="button"
            class="ink-btn ink-btn-outline ink-btn-sm"
            :disabled="saving"
            @click="removing = !removing"
          >
            删除
          </button>
        </div>
        <div v-if="removing" class="pi-memory-actions" role="group" aria-label="确认删除记忆">
          <span>删除后，后续对话不再引用这条记忆。</span>
          <button type="button" class="ink-btn ink-btn-sm ink-btn-outline" :disabled="saving" @click="remove">
            确认删除
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePiWorkspace } from './use-pi-workspace'
import { listMemories, saveMemory, deleteMemory, type PiMemory } from '@/agent-pi/memory'
const store = usePiWorkspace()
const scopes = [
  { id: 'author' as const, label: '作者偏好' },
  { id: 'book' as const, label: '作品事实' }
]
const scope = ref<'author' | 'book'>('author'),
  bookId = ref(store.bookId)
const rows = ref<PiMemory[]>([]),
  selected = ref<PiMemory | null>(null),
  content = ref(''),
  error = ref('')
const loading = ref(false),
  saving = ref(false),
  editing = ref(false),
  removing = ref(false)
const visible = computed(() => rows.value.filter(row => row.scope === scope.value))
let epoch = 0
async function load() {
  const own = ++epoch
  loading.value = true
  error.value = ''
  try {
    const result = await listMemories(scope.value === 'book' ? bookId.value : '')
    if (own === epoch) rows.value = result
  } catch (cause) {
    if (own === epoch) error.value = String(cause)
  } finally {
    if (own === epoch) loading.value = false
  }
}
function edit(row?: PiMemory) {
  selected.value = row || null
  content.value = row?.content || ''
  editing.value = true
  removing.value = false
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    await saveMemory({
      id: selected.value?.id || crypto.randomUUID(),
      scope: scope.value,
      bookId: scope.value === 'book' ? bookId.value : '',
      content: content.value,
      revision: selected.value?.revision || 0
    })
    editing.value = false
    await load()
  } catch (cause) {
    error.value = String(cause)
  } finally {
    saving.value = false
  }
}
async function remove() {
  if (!selected.value) return
  saving.value = true
  error.value = ''
  try {
    await deleteMemory(selected.value)
    editing.value = false
    await load()
  } catch (cause) {
    error.value = String(cause)
  } finally {
    saving.value = false
  }
}
watch(
  [scope, bookId],
  () => {
    editing.value = false
    selected.value = null
    void load()
  },
  { immediate: true }
)
</script>

<style scoped>
.pi-memory-page {
  padding: 24px 32px;
  overflow: auto;
  height: 100%;
}
.pi-memory-toolbar,
.pi-memory-tabs,
.pi-memory-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.pi-memory-toolbar {
  margin-bottom: 24px;
}
.pi-memory-toolbar .el-select {
  width: 220px;
}
.pi-memory-layout {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.3fr);
  gap: 24px;
}
.pi-memory-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 16px;
  border: 1px solid var(--ink-border, #dedbd4);
  border-radius: 10px;
  margin-bottom: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.pi-memory-row span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pi-memory-row small,
.pi-memory-empty {
  opacity: 0.65;
}
.pi-memory-row.is-active {
  border-color: var(--ink-primary, #917548);
}
.pi-memory-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-self: start;
}
.pi-memory-editor textarea {
  width: 100%;
  resize: vertical;
}
@media (max-width: 900px) {
  .pi-memory-page {
    padding: 20px;
  }
  .pi-memory-layout {
    grid-template-columns: 1fr;
  }
}
</style>
