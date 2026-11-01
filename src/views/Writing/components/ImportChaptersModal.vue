<template>
  <EwModal
    v-model:visible="visibleProxy"
    title="导入章节"
    width="720px"
    :close-on-click-modal="true"
    custom-class="import-chapters-modal"
    @close="handleClose"
  >
    <div class="import-body">
      <div class="step-row">
        <div class="step-title">选择文件</div>
        <div class="step-desc">支持 .txt（本机解析，不上传）</div>
      </div>

      <div
        class="drop-zone fusion-card"
        :class="{ 'is-dragging': isDragging }"
        @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
        @click="triggerPick"
      >
        <input ref="fileInputRef" class="hidden-input" type="file" :accept="accept" @change="handlePick" />
        <div class="drop-content">
          <i class="fa-solid fa-file-arrow-up"></i>
          <div class="drop-text">
            <div class="primary">点击选择或拖拽文件到此处</div>
            <div class="secondary" v-if="selectedFileName">已选择：{{ selectedFileName }}</div>
            <div class="secondary" v-else>建议使用 UTF-8 编码的 TXT</div>
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
          <div class="panel-subtitle">导入规则：同名分卷追加章节，其余新建分卷</div>
        </div>

        <div v-if="preview.warnings?.length" class="warnings">
          <div class="warnings-title">提示</div>
          <div class="warning-item" v-for="(w, idx) in preview.warnings" :key="idx">
            <i class="fa-solid fa-circle-info"></i>
            <span>{{ w }}</span>
          </div>
        </div>

        <div class="vol-preview">
          <div class="chapter-title-row">
            <div class="title">分卷概览</div>
            <div class="count">共 {{ preview.volumeCount }} 卷</div>
          </div>
          <div class="vol-list">
            <div class="vol-item" v-for="(v, idx) in preview.volumes" :key="idx">
              <span class="v-name">{{ v.title }}</span>
              <span class="v-count">{{ v.chapterCount }} 章</span>
            </div>
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
          <div class="panel-subtitle">章节已追加到当前书籍</div>
        </div>
        <div class="result-grid">
          <div class="result-item"><span class="k">新增分卷</span><span class="v">{{ importResult.addedVolumes }}</span></div>
          <div class="result-item"><span class="k">新增章节</span><span class="v">{{ importResult.addedChapters }}</span></div>
          <div class="result-item"><span class="k">新增字数</span><span class="v">{{ Number(importResult.addedWordCount || 0).toLocaleString() }}</span></div>
          <div class="result-item"><span class="k">全书字数</span><span class="v">{{ Number(importResult.updatedBookWordCount || 0).toLocaleString() }}</span></div>
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
          class="ink-btn ink-btn-primary"
          type="button"
          :disabled="!file || !preview || importing || Boolean(importResult)"
          @click="handleImport"
        >
          <i v-if="importing" class="fa-solid fa-spinner fa-spin"></i>
          确认导入
        </button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import type { ImportChaptersPreview, ImportChaptersResult } from '@/types/book'
// 开源版：章节导入走本机 TXT 解析 + 本地书库追加
import {
  importLocalChaptersFromPreview,
  previewLocalChaptersImport,
} from '@/storage/local-library'
import type { LocalParsedBook } from '@/storage/local-library'

const props = defineProps<{
  visible: boolean
  bookId: string | number
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'success', payload?: ImportChaptersResult): void
}>()

const visibleProxy = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

const accept = '.txt'
const fileInputRef = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const selectedFileName = computed(() => file.value?.name || '')
const isDragging = ref(false)

const preview = ref<(ImportChaptersPreview & { payload: LocalParsedBook }) | null>(null)
const previewLoading = ref(false)

const importing = ref(false)
const importResult = ref<ImportChaptersResult | null>(null)

const resetState = () => {
  file.value = null
  preview.value = null
  previewLoading.value = false
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
    preview.value = await previewLocalChaptersImport(file.value)
  } catch (error) {
    console.error('import chapters preview failed', error)
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
    const data = await importLocalChaptersFromPreview(props.bookId, preview.value.payload)
    importResult.value = data
    ElMessage.success('导入成功')
    emit('success', data)
  } catch (error) {
    console.error('import chapters failed', error)
    ElMessage.error(String(error?.message || '导入失败，请稍后重试'))
  } finally {
    importing.value = false
  }
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

.warnings {
  margin-top: 8px;
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

.vol-preview {
  margin-top: 10px;
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

.vol-list {
  margin-top: 10px;
  max-height: 140px;
  overflow: auto;
  border-radius: 12px;
  border: 1px solid var(--divider);
  background: var(--surface-2);
}

.vol-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--divider);

  &:last-child {
    border-bottom: none;
  }

  .v-name {
    color: var(--ink-main);
    font-size: calc(13px * var(--ui-font-scale, 1));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .v-count {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    flex: 0 0 auto;
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
