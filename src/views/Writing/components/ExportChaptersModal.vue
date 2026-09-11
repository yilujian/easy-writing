<template>
  <EwModal
    v-model:visible="visibleProxy"
    :title="mode === 'merge' ? '合并导出章节' : '导出章节'"
    width="760px"
    :close-on-click-modal="true"
    custom-class="export-chapters-modal"
    @close="handleClose"
  >
    <div class="export-body">
      <div class="toolbar-row fusion-card">
        <div class="toolbar-left">
          <div class="toolbar-title">选择章节</div>
          <div class="toolbar-sub" v-if="bookTitle">当前作品：{{ bookTitle }}</div>
        </div>
        <div class="toolbar-actions">
          <button class="ink-btn ink-btn-outline" type="button" @click="selectAll" :disabled="loadingTree">全选</button>
          <button class="ink-btn ink-btn-outline" type="button" @click="clearAll" :disabled="loadingTree">清空</button>
        </div>
      </div>

      <div v-if="loadingTree" class="loading fusion-card">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>加载目录中...</span>
      </div>

      <div v-else class="tree-panel fusion-card">
        <div v-if="!tree.length" class="empty">
          <i class="fa-regular fa-note-sticky"></i>
          <span>暂无章节</span>
        </div>
        <div v-else class="tree">
          <div class="volume" v-for="vol in tree" :key="vol.id">
            <div class="volume-row">
              <label class="checkbox">
                <input
                  type="checkbox"
                  :checked="isVolumeChecked(vol)"
                  :indeterminate="isVolumeIndeterminate(vol)"
                  @change="toggleVolume(vol)"
                />
                <span class="label-text">{{ vol.title || '正文' }}</span>
              </label>
              <span class="meta">{{ vol.children.length }} 章</span>
            </div>
            <div class="chapters">
              <label class="checkbox chapter" v-for="ch in vol.children" :key="ch.id">
                <input type="checkbox" :checked="selectedIds.has(ch.id)" @change="toggleChapter(ch.id)" />
                <span class="label-text">{{ ch.title }}</span>
                <span class="meta">{{ wordCounter.format(wordCounter.value(ch)) }} 字</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="format-panel fusion-card">
        <div class="panel-title">导出格式</div>
        <div class="format-grid">
          <button type="button" class="format-card active">
            <div class="format-name">TXT</div>
            <div class="format-desc">纯文本，按目录顺序导出</div>
          </button>
        </div>
        <div class="tip">多章将按目录顺序合并为一个 TXT 文件；单章直接导出。</div>
      </div>
    </div>

    <template #footer>
      <div class="footer-actions">
        <div class="selected-hint">
          已选 <strong>{{ selectedCount }}</strong> 章
        </div>
        <button class="ink-btn ink-btn-outline" type="button" @click="visibleProxy = false" :disabled="exporting">
          取消
        </button>
        <button
          class="ink-btn ink-btn-primary"
          type="button"
          :disabled="selectedCount === 0 || exporting"
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
// 开源版：目录读本地书库，导出在本机拼 TXT
import { exportLocalChaptersTxt, getLocalLibraryStorage } from '@/storage/local-library'

const wordCounter = useWordCount()

type CatalogChapter = {
  id: number | string
  title: string
  wordCount?: number
  isPlanned?: boolean
  selectable?: boolean
}
type Chapter = Omit<CatalogChapter, 'id'> & { id: number }
type Volume = { id: number | string; title?: string; children: Chapter[] }

const props = defineProps<{
  visible: boolean
  bookId: string | number
  mode: 'batch' | 'merge'
  preselectedChapterIds?: number[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const visibleProxy = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

const tree = ref<Volume[]>([])
const loadingTree = ref(false)
const exporting = ref(false)
const bookTitle = ref('')

const selectedIds = ref<Set<number>>(new Set())
const selectedCount = computed(() => selectedIds.value.size)

const normalizePersistedChapter = (chapter: CatalogChapter): Chapter | null => {
  const id = Number(chapter?.id)
  // 本地章节 id 是负数，非零即真实章
  if (
    chapter?.isPlanned === true ||
    chapter?.selectable === false ||
    !Number.isSafeInteger(id) ||
    id === 0
  ) {
    return null
  }
  return { ...chapter, id }
}

const loadTree = async () => {
  loadingTree.value = true
  try {
    const library = getLocalLibraryStorage()
    const [book, volumes] = await Promise.all([
      library.getLocalBookDetail(props.bookId),
      library.getLocalBookTree(props.bookId)
    ])
    bookTitle.value = book?.title || ''
    tree.value = volumes.map(volume => ({
      ...volume,
      children: volume.children
        .map(chapter => normalizePersistedChapter(chapter))
        .filter((chapter): chapter is Chapter => Boolean(chapter)),
    }))
  } catch (error) {
    console.error('load chapter tree failed', error)
    tree.value = []
    ElMessage.error(String(error?.message || '加载目录失败'))
  } finally {
    loadingTree.value = false
  }
}

const applyPreselect = () => {
  const ids = Array.isArray(props.preselectedChapterIds) ? props.preselectedChapterIds : []
  selectedIds.value = new Set(ids.map((v) => Number(v)).filter(Boolean))
}

watch(
  () => props.visible,
  async (v) => {
    if (!v) return
    applyPreselect()
    await loadTree()
    // 预选章节可能包含当前树里不存在的旧 id，过滤一下
    const all = new Set<number>(tree.value.flatMap(vol => vol.children.map(ch => ch.id)))
    selectedIds.value = new Set(Array.from(selectedIds.value).filter(id => all.has(id)))
  }
)

const toggleChapter = (id: number) => {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const isVolumeChecked = (vol: Volume) => {
  if (!vol.children.length) return false
  return vol.children.every(ch => selectedIds.value.has(ch.id))
}

const isVolumeIndeterminate = (vol: Volume) => {
  if (!vol.children.length) return false
  const any = vol.children.some(ch => selectedIds.value.has(ch.id))
  const all = vol.children.every(ch => selectedIds.value.has(ch.id))
  return any && !all
}

const toggleVolume = (vol: Volume) => {
  const next = new Set(selectedIds.value)
  const allChecked = isVolumeChecked(vol)
  for (const ch of vol.children) {
    if (allChecked) next.delete(ch.id)
    else next.add(ch.id)
  }
  selectedIds.value = next
}

const selectAll = () => {
  selectedIds.value = new Set(tree.value.flatMap(vol => vol.children.map(ch => ch.id)))
}

const clearAll = () => {
  selectedIds.value = new Set()
}

const handleExport = async () => {
  // 提交前再次只保留真实章节 ID（本地 id 为负数，过滤零值即可）
  const ids = Array.from(selectedIds.value).filter(
    id => Number.isSafeInteger(id) && id !== 0,
  )
  if (!ids.length) return
  exporting.value = true
  try {
    const saved = await exportLocalChaptersTxt(props.bookId, ids)
    if (!saved) return
    ElMessage.success('导出成功')
    visibleProxy.value = false
  } catch (error) {
    console.error('export chapters failed', error)
    ElMessage.error(String(error?.message || '导出失败，请稍后重试'))
  } finally {
    exporting.value = false
  }
}

const handleClose = () => {
  tree.value = []
  selectedIds.value = new Set()
  exporting.value = false
}
</script>

<style scoped lang="scss">
.export-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar-row {
  padding: 14px 16px;
  border-radius: 16px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.toolbar-title {
  font-weight: 700;
  color: var(--ink-main);
}

.toolbar-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-sec);
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.loading {
  padding: 18px 16px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-sec);
}

.tree-panel {
  padding: 12px 12px;
  border-radius: 16px;
}

.empty {
  padding: 22px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  color: var(--ink-sec);
}

.tree {
  max-height: 360px;
  overflow: auto;
}

.volume {
  padding: 8px 6px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.volume:last-child {
  border-bottom: none;
}

.volume-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 6px 4px;
}

.chapters {
  padding: 6px 0 2px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  user-select: none;
}

.checkbox input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--ink-accent);
}

.checkbox.chapter {
  justify-content: space-between;
  gap: 12px;
}

.label-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-main);
  font-size: 13px;
}

.meta {
  color: var(--ink-sec);
  font-size: 12px;
  flex: 0 0 auto;
}

.format-panel {
  border-radius: 16px;
  padding: 14px 16px;
}

.panel-title {
  font-weight: 700;
  color: var(--ink-main);
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

.tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ink-sec);
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.selected-hint {
  margin-right: auto;
  font-size: 12px;
  color: var(--ink-sec);
}

.selected-hint strong {
  color: var(--ink-main);
}
</style>
