<template>
  <EwModal
    v-model:visible="visibleProxy"
    title="导出作品"
    width="520px"
    :close-on-click-modal="true"
    custom-class="export-book-modal"
  >
    <div class="export-body">
      <div class="book-card fusion-card" v-if="book">
        <div class="book-title">{{ book.title }}</div>
        <div class="book-meta">
          <span v-if="book.category">分类：{{ book.category }}</span>
          <span v-if="book.wordCount != null">字数：{{ wordCounter.format(wordCounter.value(book)) }}</span>
        </div>
        <div class="book-intro" v-if="book.intro">{{ book.intro }}</div>
      </div>

      <div class="format-section">
        <div class="section-title">选择导出格式</div>
        <div class="format-grid">
          <button
            type="button"
            class="format-card"
            :class="{ active: format === 'txt' }"
            @click="format = 'txt'"
          >
            <div class="format-name">TXT</div>
            <div class="format-desc">纯文本，兼容性最好</div>
          </button>
          <button
            type="button"
            class="format-card"
            :class="{ active: format === secondaryFormat }"
            @click="format = secondaryFormat"
          >
            <div class="format-name">JSON</div>
            <div class="format-desc">本地备份，可再次导入恢复</div>
          </button>
        </div>
        <div class="export-tip">
          导出内容包含：书籍信息 + 分章节正文；JSON 格式还会带上大纲/角色/设定/时间线/故事线，导入后完整恢复。
        </div>
      </div>
    </div>

    <template #footer>
      <div class="footer-actions">
        <button class="ink-btn ink-btn-outline" type="button" @click="visibleProxy = false" :disabled="exporting">
          取消
        </button>
        <button
          class="ink-btn ink-btn-primary"
          type="button"
          :disabled="!book || !format || exporting"
          @click="handleExport"
        >
          <i v-if="exporting" class="fa-solid fa-spinner fa-spin"></i>
          开始导出
        </button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import { exportLocalBook } from '@/storage/local-library'
import type { Book } from '@/types'

const wordCounter = useWordCount()

const props = defineProps<{
  visible: boolean
  book: Book | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const visibleProxy = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

const secondaryFormat = 'json' as const
const format = ref<'txt' | 'json'>('txt')
const exporting = ref(false)

watch(
  () => props.visible,
  (v) => {
    if (v) format.value = 'txt'
  }
)

const handleExport = async () => {
  if (!props.book) return
  exporting.value = true
  try {
    await exportLocalBook(props.book.id, format.value === 'json' ? 'json' : 'txt')
    ElMessage.success('导出成功')
    visibleProxy.value = false
  } catch (error) {
    console.error('export book failed', error)
    ElMessage.error(String(error?.message || '导出失败，请稍后重试'))
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped lang="scss">
.export-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.book-card {
  padding: 14px 16px;
  border-radius: 14px;
}

.book-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--ink-main);
}

.book-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--ink-sec);
}

.book-intro {
  margin-top: 10px;
  font-size: 13px;
  color: var(--ink-sec);
  line-height: 1.6;
  max-height: 88px;
  overflow: hidden;
}

.format-section {
  padding: 6px 2px 0;
}

.section-title {
  font-size: 13px;
  color: var(--ink-sec);
  margin-bottom: 10px;
}

.format-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.format-card {
  border: 1px solid var(--ui-border);
  background: var(--ui-glass-bg);
  border-radius: 14px;
  padding: 14px 14px 12px;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s ease;
  box-shadow: var(--ui-shadow);
  color: var(--ink-main);

  &:hover {
    background: var(--ui-glass-bg-hover);
    border-color: var(--ui-border-hover);
  }

  &.active {
    border-color: var(--ink-accent);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  }
}

.format-name {
  font-weight: 700;
  font-size: 14px;
}

.format-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-sec);
  line-height: 1.5;
}

.export-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ink-sec);
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
