<template>
  <EwModal
v-model:visible="visibleProxy" title="导入作品" width="min(860px, calc(100vw - 32px))" :close-on-click-modal="true"
    custom-class="import-book-modal" @close="handleClose">
    <div class="import-body">
      <div class="step-row">
        <div class="step-title">选择文件</div>
        <div class="step-desc">支持 .txt / .json 本地导入</div>
      </div>

      <div
class="drop-zone fusion-card" :class="{ 'is-dragging': isDragging }" @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop.prevent="handleDrop"
        @click="triggerPick">
        <input ref="fileInputRef" class="hidden-input" type="file" :accept="accept" @change="handlePick" />
        <div class="drop-content">
          <i class="fa-solid fa-file-arrow-up"></i>
          <div class="drop-text">
            <div class="primary">点击选择或拖拽文件到此处</div>
            <div class="secondary" v-if="selectedFileName">已选择：{{ selectedFileName }}</div>
            <div class="secondary" v-else>建议使用 UTF-8 编码的 TXT；卷名与章节名请标明第xx卷、第xx章</div>
          </div>
          <button class="ink-btn ink-btn-outline" type="button" @click.stop="triggerPick">选择文件</button>
        </div>
      </div>

      <div class="actions-row">
        <button class="ink-btn ink-btn-accent" type="button" :disabled="!file || previewLoading" @click="loadPreview">
          <i v-if="previewLoading" class="fa-solid fa-spinner fa-spin"></i>
          解析预览
        </button>
        <div class="hint" v-if="preview">
          识别到 <strong>{{ preview.chapterCount }}</strong> 章，<strong>{{ preview.volumeCount }}</strong> 卷
        </div>
      </div>

      <div v-if="preview" class="preview-panel fusion-card">
        <div class="panel-header">
          <div class="panel-title">导入预览</div>
          <div class="panel-subtitle">可编辑书名/简介后再导入</div>
        </div>

        <div class="form-grid">
          <div class="form-item title-item">
            <label>书名</label>
            <input class="ink-input-underline" type="text" v-model="overrideTitle" placeholder="请输入书名" />
          </div>
          <div class="form-item intro-item">
            <div class="label-row">
              <label>简介（可选）</label>
              <span>{{ introCount }}/500</span>
            </div>
            <textarea
              class="ink-textarea intro-textarea"
              v-model="overrideIntro"
              rows="7"
              maxlength="500"
              placeholder="可留空，系统将尝试从文件中识别"
            ></textarea>
          </div>
        </div>

        <div v-if="preview.warnings?.length" class="warnings">
          <div class="warnings-title">提示</div>
          <div class="warning-item" v-for="(w, idx) in preview.warnings" :key="idx">
            <i class="fa-solid fa-circle-info"></i>
            <span>{{ w }}</span>
          </div>
        </div>

        <div class="chapter-preview">
          <div class="chapter-title-row">
            <div class="title">章节预览</div>
            <div class="count">仅展示前 {{ preview.chaptersPreview.length }} 章</div>
          </div>
          <div class="chapter-list">
            <div class="chapter-item" v-for="(ch, idx) in preview.chaptersPreview" :key="idx">
              <span class="ch-name">{{ ch.title }}</span>
              <span class="ch-words">{{ Number(ch.wordCount || 0).toLocaleString() }} 字</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="importResult" class="result-panel fusion-card">
        <div class="panel-header">
          <div class="panel-title">导入完成</div>
          <div class="panel-subtitle">已创建作品并保存章节</div>
        </div>
        <div class="result-grid">
          <div class="result-item"><span class="k">书名</span><span class="v">{{ importResult.title }}</span></div>
          <div class="result-item"><span class="k">分卷</span><span class="v">{{ importResult.volumeCount }}</span></div>
          <div class="result-item"><span class="k">章节</span><span class="v">{{ importResult.chapterCount }}</span></div>
          <div class="result-item"><span class="k">字数</span><span class="v">{{ Number(importResult.totalWordCount ||
            0).toLocaleString() }}</span></div>
        </div>
        <div v-if="importResult.warnings?.length" class="warnings">
          <div class="warnings-title">提示</div>
          <div class="warning-item" v-for="(w, idx) in importResult.warnings" :key="idx">
            <i class="fa-solid fa-circle-info"></i>
            <span>{{ w }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="footer-actions">
        <button class="ink-btn ink-btn-outline" type="button" @click="visibleProxy = false" :disabled="importing">
          关闭
        </button>
        <button
class="ink-btn ink-btn-primary" type="button"
          :disabled="!file || !preview || importing || Boolean(importResult)" @click="handleImport">
          <i v-if="importing" class="fa-solid fa-spinner fa-spin"></i>
          确认导入
        </button>
        <button
v-if="importResult" class="ink-btn ink-btn-primary" type="button"
          @click="openWriting(importResult.bookId)">
          打开写作
        </button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import type { ImportBookPreview, ImportBookResult } from '@/types/book'
import { importLocalBookFromPreview, previewLocalBookImport, type LocalImportPreview, type LocalImportResult } from '@/storage/local-library'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'success'): void
}>()

const router = useRouter()

const visibleProxy = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

const accept = '.txt,.json'
const fileInputRef = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const selectedFileName = computed(() => file.value?.name || '')
const isDragging = ref(false)

const preview = ref<ImportBookPreview | LocalImportPreview | null>(null)
const previewLoading = ref(false)
const overrideTitle = ref('')
const overrideIntro = ref('')
const introCount = computed(() => overrideIntro.value.length)

const importing = ref(false)
const importResult = ref<ImportBookResult | LocalImportResult | null>(null)

const resetState = () => {
  file.value = null
  preview.value = null
  previewLoading.value = false
  overrideTitle.value = ''
  overrideIntro.value = ''
  importing.value = false
  importResult.value = null
  isDragging.value = false
  if (fileInputRef.value) fileInputRef.value.value = ''
}

watch(
  () => props.visible,
  (v) => {
    if (v) resetState()
  }
)

const triggerPick = () => {
  fileInputRef.value?.click()
}

const setFile = (f: File) => {
  file.value = f
  preview.value = null
  importResult.value = null
}

const handlePick = (e: Event) => {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  setFile(f)
}

const handleDrop = (e: DragEvent) => {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  setFile(f)
}

const loadPreview = async () => {
  if (!file.value) return
  previewLoading.value = true
  try {
    const data = await previewLocalBookImport(file.value)
    preview.value = data
    overrideTitle.value = data?.title || ''
    overrideIntro.value = String(data?.intro || '').slice(0, 500)
  } catch (error) {
    console.error('import preview failed', error)
    ElMessage.error(String(error?.message || '解析失败，请检查文件格式'))
  } finally {
    previewLoading.value = false
  }
}

const handleImport = async () => {
  if (!file.value) return
  if (!preview.value) {
    ElMessage.warning('请先解析预览')
    return
  }
  importing.value = true
  try {
    const data = await importLocalBookFromPreview(preview.value as LocalImportPreview, {
      title: overrideTitle.value.trim(),
      intro: overrideIntro.value.trim().slice(0, 500)
    })
    importResult.value = data
    ElMessage.success('导入成功')
    emit('success')
  } catch (error) {
    console.error('import book failed', error)
    ElMessage.error(String(error?.message || '导入失败，请稍后重试'))
  } finally {
    importing.value = false
  }
}

const openWriting = (bookId: number) => {
  router.push({ name: 'Writing', params: { bookId } })
  visibleProxy.value = false
}

const handleClose = () => {
  resetState()
}
</script>

<style scoped lang="scss">
.import-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.step-row {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .step-title {
    font-weight: 700;
    color: var(--ink-main);
  }

  .step-desc {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.drop-zone {
  border-radius: 16px;
  padding: 18px;
  cursor: pointer;
  border: 1px dashed var(--divider);
  transition: all 0.2s ease;

  &.is-dragging {
    border-color: var(--ink-accent);
    background: var(--ui-glass-bg-hover);
  }
}

.hidden-input {
  display: none;
}

.drop-content {
  display: flex;
  align-items: center;
  gap: 14px;

  i {
    font-size: calc(22px * var(--ui-font-scale, 1));
    color: var(--ink-accent);
  }

  .drop-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;

    .primary {
      font-weight: 600;
      color: var(--ink-main);
    }

    .secondary {
      font-size: calc(12px * var(--ui-font-scale, 1));
      color: var(--ink-sec);
    }
  }
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 12px;

  .hint {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);

    strong {
      color: var(--ink-main);
    }
  }
}

.preview-panel,
.result-panel {
  border-radius: 16px;
  padding: 16px;
}

.panel-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 12px;

  .panel-title {
    font-weight: 700;
    color: var(--ink-main);
  }

  .panel-subtitle {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
}

.title-item {
  max-width: 420px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 8px;

  label {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.label-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
}

.ink-textarea {
  width: 100%;
  min-height: 90px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid var(--divider);
  background: var(--surface-2);
  padding: 10px 12px;
  outline: none;
  color: var(--ink-main);
  line-height: 1.6;

  &:focus {
    border-color: var(--ink-accent);
    background: var(--surface-1);
  }
}

.intro-textarea {
  min-height: 150px;
  resize: vertical;
}

.warnings {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--divider);

  .warnings-title {
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 700;
    color: var(--ink-sec);
    margin-bottom: 6px;
  }

  .warning-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    margin: 4px 0;

    i {
      margin-top: 2px;
      color: var(--ink-accent);
    }
  }
}

.chapter-preview {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--divider);
}

.chapter-title-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;

  .title {
    font-weight: 700;
    color: var(--ink-main);
  }

  .count {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.chapter-list {
  margin-top: 10px;
  max-height: 220px;
  overflow: auto;
  border-radius: 12px;
  border: 1px solid var(--divider);
  background: var(--surface-2);
}

.chapter-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--divider);

  &:last-child {
    border-bottom: none;
  }

  .ch-name {
    color: var(--ink-main);
    font-size: calc(13px * var(--ui-font-scale, 1));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ch-words {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    flex: 0 0 auto;
  }
}

.result-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.result-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);

  .k {
    color: var(--ink-sec);
  }

  .v {
    color: var(--ink-main);
    font-weight: 600;
  }
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
