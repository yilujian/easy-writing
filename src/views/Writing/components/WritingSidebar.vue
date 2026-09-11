<template>
  <aside
:class="['writing-sidebar', 'border-gradient-r', { collapsed, 'no-transition': isResizing }]"
    :style="{ width: collapsed ? '0' : `${editorStore.sidebarWidth}px` }">
    <!-- 拖拽手柄 -->
    <div class="resize-handle" @mousedown="startResize" :class="{ active: isResizing }"></div>

    <!-- 收起/展开按钮 -->
    <div class="toggle-button-wrapper">
      <button class="toggle-button" @click="toggleSidebar">
        <i :class="['fa-solid', collapsed ? 'fa-chevron-right' : 'fa-chevron-left']"></i>
      </button>
    </div>

    <div v-show="!collapsed" class="sidebar-content">
      <!-- 搜索框 -->
      <div class="search-section">
        <div class="search-wrapper">
          <input type="text" placeholder="搜索全书" class="search-input" v-model="searchText">
          <i v-if="!searchText" class="fa-solid fa-magnifying-glass search-icon"></i>
          <i v-else class="fa-solid fa-xmark search-icon clear-icon" @click="searchText = ''" title="清除搜索"></i>
        </div>
      </div>

      <!-- 新建按钮 -->
      <div v-if="!isCatalogStructureLocked" class="create-buttons">
        <button class="btn-primary create-btn" @click="handleCreateChapterBtn">新建章</button>
        <button class="btn-outline create-btn" @click="handleCreateVolumeBtn">新建卷</button>
      </div>

      <!-- 目录标题 -->
      <div class="catalog-header">
        <span>目录</span>
        <div class="catalog-actions">
          <i
v-if="!isCatalogStructureLocked" class="fa-regular fa-trash-can action-icon" title="删除选中章节/分卷"
            @click.stop="handleDeleteSelected"></i>
          <i
class="fa-solid fa-arrow-up-from-bracket action-icon"
            :title="isCatalogStructureLocked ? '导出章节' : '导入/导出章节'"
            @click.stop="handleImportExportClick"></i>
          <i
v-if="!isCatalogStructureLocked" class="fa-solid fa-arrow-down-short-wide action-icon" title="排序"
            @click.stop="handleSortClick"></i>
        </div>
      </div>

      <!-- 目录列表 -->
      <div class="catalog-list" @dragover.prevent>
        <!-- 目录拉取期间用骨架占位：空白目录配上编辑区那句「请选择左侧章节」，
             看着像这本书是空的，而不是还没加载完。 -->
        <div v-if="catalogLoading && !catalogItems.length" class="catalog-skeleton" aria-label="目录加载中">
          <div v-for="row in 6" :key="row" class="catalog-skeleton-row" :class="{ 'is-chapter': row % 3 !== 1 }"></div>
        </div>

        <!-- 无搜索结果提示 -->
        <div v-else-if="searchText && filteredCatalogItems.length === 0" class="no-results">
          <i class="fa-solid fa-magnifying-glass"></i>
          <p>未找到匹配的章节或卷</p>
        </div>

        <div v-for="(volume, vIndex) in filteredCatalogItems" :key="volume.id" class="volume-group">
          <!-- 卷标题 -->
          <div
class="catalog-item" :class="{
            'nav-item-active': activeId === volume.id && activeType === 'volume',
            'force-hover': contextMenu.visible && contextMenu.volume?.id === volume.id
          }" style="padding-left: 16px" :draggable="!isCatalogStructureLocked" @click="handleVolumeClick(volume)"
            @dragstart.stop="onDragStart($event, { type: 'volume', index: vIndex, item: volume })"
            @drop.stop="onDrop($event, { type: 'volume', index: vIndex, item: volume })" @dragover.prevent>
            <i :class="['fa-regular', volume.open ? 'fa-folder-open' : 'fa-folder']"></i>
            <!-- eslint-disable-next-line vue/no-v-html -- highlightText 先 escapeHtml 再包高亮标签，无注入面 -->
            <span class="item-title" v-html="highlightText(volume.title)"></span>

            <div class="item-actions">
              <span class="chapter-count">{{ volume.children?.length || 0 }}章</span>
              <div class="action-buttons">
                <i
v-if="!isCatalogStructureLocked" class="fa-solid fa-plus action-btn" title="新建章节"
                  @click.stop="handleAddChapter(volume)"></i>
                <i
class="fa-solid fa-ellipsis action-btn" title="更多"
                  @click.stop="handleVolumeMore(volume, $event)"></i>
              </div>
            </div>
          </div>

          <!-- 章节列表 -->
          <div v-if="volume.open" class="chapter-list">
            <div
v-for="(chapter, cIndex) in volume.children" :key="chapter.id" class="catalog-item" :class="{
              'nav-item-active': activeId === chapter.id && activeType === 'chapter',
              'force-hover': chapterContextMenu.visible && chapterContextMenu.chapter?.id === chapter.id,
              'is-planned': chapter.isPlanned || chapter.selectable === false
            }" style="padding-left: 32px"
              :draggable="!isCatalogStructureLocked && chapter.selectable !== false && !chapter.isPlanned"
              @click.stop="handleChapterClick(chapter)"
              @dblclick.stop="startEdit(chapter)" @contextmenu.prevent="handleChapterContextMenu($event, chapter)"
              @dragstart.stop="onDragStart($event, { type: 'chapter', vIndex: vIndex, cIndex: cIndex, item: chapter })"
              @drop.stop="onDrop($event, { type: 'chapter', vIndex: vIndex, cIndex: cIndex, item: chapter })"
              @dragover.prevent>

              <template v-if="editingChapterId === chapter.id">
                <input
ref="editInputRef" type="text" v-model="editingTitle" class="edit-input"
                  @blur="saveEdit(chapter)" @keyup.enter="saveEdit(chapter)" @keyup.esc="cancelEdit" @click.stop />
              </template>
              <template v-else>
                <!-- eslint-disable-next-line vue/no-v-html -- highlightText 先 escapeHtml 再包高亮标签，无注入面 -->
                <span class="item-title" v-html="highlightText(formatChapterDisplayTitle(chapter))"></span>
                <span
v-if="getChapterStatusLabel(chapter)" class="chapter-workflow-status"
                  :class="`is-${chapter.workflowStatus || 'planned'}`">
                  {{ getChapterStatusLabel(chapter) }}
                </span>
                <span v-else class="item-count">{{ wordCounter.format(wordCounter.value(chapter)) }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 卷操作下拉菜单 -->
    <div
v-if="contextMenu.visible" class="context-menu"
      :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }" @click.stop>
      <div class="menu-header">
        <div class="menu-title">{{ contextMenu.volume?.title }}</div>
        <div class="menu-info">{{ contextMenu.volume?.children?.length || 0 }}章 {{
          getVolumeWordCount(contextMenu.volume)
        }}字</div>
      </div>
      <div class="menu-divider"></div>
      <template v-if="!isCatalogStructureLocked">
        <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
        <div class="menu-item" @click="handleMenuAction('summary')">分卷简介</div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click="handleMenuAction('add_chapter')">新建章节</div>
      </template>
      <div class="menu-item" @click="handleMenuAction('export')">合并导出章节</div>
      <template v-if="!isCatalogStructureLocked">
        <div class="menu-divider"></div>
        <div class="menu-item danger" @click="handleMenuAction('delete')">删除本卷</div>
      </template>
    </div>

    <!-- 导入导出菜单 -->
    <div
v-if="importExportMenu.visible" class="context-menu"
      :style="{ top: `${importExportMenu.y}px`, left: `${importExportMenu.x}px` }" @click.stop>
      <div v-if="!isCatalogStructureLocked" class="menu-item" @click="handleImportExportAction('import')">导入</div>
      <div class="menu-item" @click="handleImportExportAction('export')">导出</div>
    </div>

    <!-- 排序菜单 -->
    <div
v-if="sortMenu.visible && !isCatalogStructureLocked" class="context-menu"
      :style="{ top: `${sortMenu.y}px`, left: `${sortMenu.x}px` }" @click.stop>
      <div class="menu-item" @click="handleSortAction('current_title')">当前卷按章节号排序</div>
      <div class="menu-item" @click="handleSortAction('current_create')">当前卷按创建时间排序</div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="handleSortAction('all_title')">全书章节按章节号排序</div>
      <div class="menu-item" @click="handleSortAction('volume_title')">分卷按卷号排序</div>
    </div>

    <!-- 章节右键菜单 -->
    <div
v-if="chapterContextMenu.visible" class="context-menu"
      :style="{ top: `${chapterContextMenu.y}px`, left: `${chapterContextMenu.x}px` }" @click.stop>
      <div class="menu-header">
        <div class="menu-title">{{ formatChapterDisplayTitle(chapterContextMenu.chapter) }}</div>
        <div class="menu-info">
          创建于 {{ formatDateTimeLoose(chapterContextMenu.chapter?.createTime, 'MM-DD HH:mm', '未知时间') }}
          <br>
          {{ wordCounter.format(wordCounter.value(chapterContextMenu.chapter)) }}字
        </div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="handleChapterMenuAction('open_sidebar')">侧边栏打开</div>
      <template v-if="canEditChapterMetadata">
        <div class="menu-item" @click="handleChapterMenuAction('editInfo')">编辑章节</div>
        <div class="menu-item" @click="handleChapterMenuAction('rename')">重命名</div>
        <div class="menu-item" @click="handleChapterMenuAction('outline')">提取章纲</div>
      </template>
      <div class="menu-item" @click="handleChapterMenuAction('export')">合并导出章节</div>
      <div class="menu-item" @click="handleChapterMenuAction('history')">历史版本</div>
      <template v-if="!isCatalogStructureLocked">
        <div class="menu-divider"></div>
        <div class="menu-item danger" @click="handleChapterMenuAction('delete')">删除本章</div>
      </template>
    </div>

    <CreateVolumeModal
v-if="!isCatalogStructureLocked" v-model:visible="createVolumeVisible"
      :initial-data="editingVolume ? { title: editingVolume.title, summary: editingVolume.summary || '' } : undefined"
      @save="handleCreateVolumeSave" />
    <CreateChapterModal
v-if="canEditChapterMetadata" v-model:visible="createChapterVisible" :initial-data="editingChapter ? {
      id: editingChapter.id,
      volumeId: editingChapter.volumeId,
      title: editingChapter.title,
      summary: editingChapter.summary || '',
      wordCount: editingChapter.wordCount
    } : undefined" :volumes="editableChapterVolumes" :selected-volume-id="selectedVolumeId" @save="handleCreateChapterSave" />

    <ImportChaptersModal
      v-if="!isCatalogStructureLocked"
      v-model:visible="importChaptersVisible"
      :book-id="bookId"
      @success="loadCatalogTree()"
    />
    <ExportChaptersModal
      v-model:visible="exportChaptersVisible"
      :book-id="bookId"
      :mode="exportChaptersMode"
      :preselected-chapter-ids="exportPreselectedChapterIds"
    />
    <ChapterHistoryModal
      v-model:visible="chapterHistoryVisible"
      :chapter-id="historyChapter?.id || null"
      :chapter-title="formatChapterDisplayTitle(historyChapter)"
      :book-id="bookId"
      :restore-disabled="
        props.workflowRestorePending
        || historyChapter?.workflowStatus === 'generating'
        || historyChapter?.id === props.workflowRestoreLockedChapterId
      "
      @restored="handleHistoryRestored"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, onUnmounted, nextTick, onMounted, computed, watch } from 'vue'
import { promptText } from '@/storage/local-prompts'
import { useRoute } from 'vue-router'
import { useWritingEditorStore, WRITING_SIDEBAR_MAX_WIDTH, WRITING_SIDEBAR_MIN_WIDTH } from '@/stores/writing-editor'
import { storeToRefs } from 'pinia'
import { chineseToNumber, generateNextChapterTitle, generateNextVolumeTitle } from '@/utils/chapter'
import { formatDateTimeLoose } from '@/utils/format'
import CreateVolumeModal from './CreateVolumeModal.vue'
import CreateChapterModal from './CreateChapterModal.vue'
import ImportChaptersModal from './ImportChaptersModal.vue'
import ExportChaptersModal from './ExportChaptersModal.vue'
import ChapterHistoryModal from './ChapterHistoryModal.vue'
// 开源版：章纲提取走本地 BYOK 直连，正文读本地写作存储
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildFreeInstructionMessages } from '@/config/ai-prompts'
import { useWordCount } from '@/composables/use-word-count'
import { countTextWords } from '@/utils/word-count'
import { useAiModelStore } from '@/stores/ai-model'
import { getLocalChapterDetailData } from '@/storage/local-reference'
import { showApiError } from '@/utils/api-error'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { isTauriRuntime } from '@/storage'
import { getLocalLibraryStorage } from '@/storage/local-library'

const route = useRoute()
const wordCounter = useWordCount()
const editorStore = useWritingEditorStore()
const aiModelStore = useAiModelStore()
const { chapterWordCount, activeChapterTitle } = storeToRefs(editorStore)
const bookId = ref<string>('')
// 首次拉取目录前默认为 true：进入页面的第一帧就该是骨架，而不是空目录。
const catalogLoading = ref(true)

interface Chapter {
  id: number
  volumeId: string
  sortNo: number
  title: string
  summary: string | null
  wordCount: number
  textWordCount?: number | null
  status: number
  isPaid: number
  type: 'chapter'
  createTime?: string
  isPlanned?: boolean
  selectable?: boolean
  workflowStatus?: 'planned' | 'generating' | 'review_required' | 'completed' | string
}

interface Volume {
  id: number
  createTime: string
  updateTime: string
  tenantId: null
  bookId: string
  sortNo: number
  title: string
  summary: string | null
  isDeleted: number
  type: 'volume'
  children: Chapter[]
  open?: boolean // UI state
}

const props = defineProps<{
  beforeSwitchChapter?: (chapter: Chapter) => Promise<boolean> | boolean
  workflowMode?: boolean
  workflowRunId?: number
  workflowTaskId?: number
  workflowStructureLocked?: boolean
  workflowRestorePending?: boolean
  workflowRestoreLockedChapterId?: number
  workflowStopped?: boolean
}>()

// 目录加载态要上抛：编辑区那句「请选择左侧章节开始创作」得等目录出来再显示，
// 否则目录还在拉取时就先断言"这本书没有章节"。
const emit = defineEmits<{
  (event: 'catalog-loading', loading: boolean): void
}>()

const localLibrary = getLocalLibraryStorage()
const isVerifiedWorkflowCatalog = computed(
  () =>
    props.workflowMode === true &&
    Number(props.workflowRunId || 0) > 0 &&
    Number(props.workflowTaskId || 0) > 0
)

// 只有活动生成任务持有目录结构；暂停、失败和完成后恢复普通章节操作。
const isCatalogStructureLocked = computed(
  () =>
    props.workflowStructureLocked === true ||
    props.workflowRestorePending === true
)
const canEditChapterMetadata = computed(
  () => !isCatalogStructureLocked.value || props.workflowStopped === true
)

// 拖拽相关类型
interface DragData {
  type: 'volume' | 'chapter'
  index?: number // volume index
  vIndex?: number // volume index for chapter
  cIndex?: number // chapter index
  item: Volume | Chapter
}

const collapsed = ref(false)
const searchText = ref('')
const activeId = ref<number | null>(editorStore.activeChapterId ?? null)
const activeType = ref<'volume' | 'chapter' | null>(activeId.value ? 'chapter' : null)
const draggedItem = ref<DragData | null>(null)

const isWebCompactWriting = () =>
  typeof window !== 'undefined' && !isTauriRuntime() && window.matchMedia('(max-width: 900px)').matches

// 新建/编辑卷弹窗
const createVolumeVisible = ref(false)
const editingVolume = ref<Volume | null>(null)

const handleCreateVolumeBtn = () => {
  if (isCatalogStructureLocked.value) return
  editingVolume.value = null
  createVolumeVisible.value = true
}

// 新建/编辑章节弹窗
const createChapterVisible = ref(false)
const editingChapter = ref<Chapter | null>(null)
const selectedVolumeId = ref<string | number>('')

const handleCreateChapterSave = async (data: { volumeId: string | number; title: string; summary: string; wordCount: number }) => {
  if (!canEditChapterMetadata.value || (isCatalogStructureLocked.value && !editingChapter.value)) return
  try {
    if (editingChapter.value) {
      // 停止态只允许修改真实章节信息，所属分卷继续沿用原值以保护工作流计划结构。
      const volumeId = props.workflowStopped
        ? editingChapter.value.volumeId
        : String(data.volumeId)
      await localLibrary.updateLocalChapter({
        id: editingChapter.value.id,
        title: data.title,
        summary: data.summary,
        volumeId
      })
      ElMessage.success('更新成功')
      editingChapter.value = null
      await loadCatalogTree()
    } else {
      await localLibrary.createLocalChapter({
        bookId: bookId.value,
        title: data.title,
        summary: data.summary,
        volumeId: String(data.volumeId)
      })
      ElMessage.success('新建成功')
      await loadCatalogTree()

      // 自动选中新章节 (需要重新加载后才能获取到新ID)
      const volume = catalogItems.value.find(v => String(v.id) === String(data.volumeId))
      if (volume && volume.children.length > 0) {
        const newChapter = volume.children[volume.children.length - 1]
        handleChapterClick(newChapter)
      }
    }
  } catch (error) {
    console.error('保存章节失败:', error)
    showApiError(error, '操作失败')
  }
}

const handleCreateVolumeSave = async (data: { title: string, summary: string }) => {
  if (isCatalogStructureLocked.value) return
  try {
    if (editingVolume.value) {
      await localLibrary.updateLocalVolume({
        id: editingVolume.value.id,
        title: data.title.trim() || editingVolume.value.title,
        summary: data.summary
      })
      ElMessage.success('更新成功')
      editingVolume.value = null
      await loadCatalogTree()
    } else {
      // 新建卷
      let finalTitle = data.title.trim()
      if (!finalTitle) {
        const existingTitles = catalogItems.value.map(v => v.title)
        finalTitle = generateNextVolumeTitle(existingTitles)
      }

      await localLibrary.createLocalVolume({
        bookId: bookId.value,
        title: finalTitle,
        summary: data.summary || ''
      })
      ElMessage.success('新建成功')
      await loadCatalogTree()

      // 滚动到底部
      nextTick(() => {
        const list = document.querySelector('.catalog-list')
        if (list) {
          list.scrollTop = list.scrollHeight
        }
      })
    }
  } catch (error) {
    console.error('保存卷失败:', error)
    showApiError(error, '操作失败')
  }
}

// 章节重命名
const editingChapterId = ref<number | null>(null)
const editingTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const startEdit = (chapter: Chapter) => {
  if (!canEditChapterMetadata.value) return
  if (chapter.isPlanned || chapter.selectable === false) return
  editingChapterId.value = chapter.id
  editingTitle.value = chapter.title
  nextTick(() => {
    // 如果 v-for 中有多个 ref，editInputRef 可能是数组
    const input = Array.isArray(editInputRef.value) ? editInputRef.value[0] : editInputRef.value
    if (input) {
      input.focus()
      input.select()
    }
  })
}

const saveEdit = async (chapter: Chapter) => {
  if (!canEditChapterMetadata.value) {
    editingChapterId.value = null
    editingTitle.value = ''
    return
  }
  if (editingChapterId.value === null) return

  const newTitle = editingTitle.value.trim()
  if (newTitle && newTitle !== chapter.title) {
    try {
      await localLibrary.updateLocalChapter({
        id: chapter.id,
        title: newTitle
      })
      chapter.title = newTitle
      if (editorStore.activeChapterId === chapter.id) {
        editorStore.setChapterTitle(newTitle)
      }
      ElMessage.success('重命名成功')
    } catch (error) {
      console.error('重命名失败:', error)
      showApiError(error, '重命名失败')
    }
  }

  editingChapterId.value = null
  editingTitle.value = ''
}

const cancelEdit = () => {
  editingChapterId.value = null
  editingTitle.value = ''
}

// 卷菜单逻辑
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  volume: null as Volume | null
})

const handleVolumeMore = (volume: Volume, event?: MouseEvent) => {
  if (event) {
    const rect = (event.target as HTMLElement).getBoundingClientRect()
    contextMenu.value = {
      visible: true,
      x: rect.left,
      y: rect.bottom + 5,
      volume
    }
  } else {
    // Fallback if no event provided (though template passes it now)
    contextMenu.value = {
      visible: true,
      x: 0,
      y: 0,
      volume
    }
  }

  // 点击外部关闭
  document.addEventListener('click', closeContextMenu)
}

const closeContextMenu = () => {
  contextMenu.value.visible = false
  document.removeEventListener('click', closeContextMenu)
}

const handleMenuAction = async (action: string) => {
  const volume = contextMenu.value.volume
  if (!volume) return
  if (isCatalogStructureLocked.value && action !== 'export') {
    closeContextMenu()
    return
  }

  try {
    switch (action) {
      case 'rename':
      case 'summary':
        editingVolume.value = volume
        createVolumeVisible.value = true
        break
      case 'add_chapter':
        handleAddChapter(volume)
        break
      case 'export':
        openExportChaptersModal(
          'merge',
          getPersistedChapterIds(volume.children || []),
        )
        break
      case 'delete':
        await deleteVolume(volume)
        break
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('操作失败:', error)
      showApiError(error, '操作失败')
    }
  }

  closeContextMenu()
}

const getVolumeWordCount = (volume: Volume | null) => {
  if (!volume || !volume.children) return 0
  return wordCounter.format(volume.children.reduce<number | null>((sum, chapter) => { const count = wordCounter.value(chapter); return sum === null || count === null ? null : sum + count }, 0))
}

const findVolumeById = (volumeId: number | null) => {
  if (volumeId == null) return null
  return catalogItems.value.find(volume => volume.id === volumeId) || null
}

const findVolumeByChapterId = (chapterId: number | null) => {
  if (chapterId == null) return null
  return catalogItems.value.find(volume => volume.children.some(chapter => chapter.id === chapterId)) || null
}

const getActiveVolume = () => {
  if (activeType.value === 'volume') {
    return findVolumeById(activeId.value)
  }
  if (activeType.value === 'chapter') {
    return findVolumeByChapterId(activeId.value)
  }
  return null
}

const deleteVolume = async (volume: Volume) => {
  if (isCatalogStructureLocked.value) return
  await inkConfirm(
    `确定要删除分卷"${volume.title}"吗？删除后可在回收站恢复。`,
    '删除确认',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  )
  await localLibrary.deleteLocalVolume([volume.id])
  ElMessage.success('删除成功')
  await loadCatalogTree()
}

const deleteChapter = async (chapter: Chapter) => {
  if (isCatalogStructureLocked.value) return
  await inkConfirm(
    `确定要删除章节"${chapter.title}"吗？删除后可在回收站恢复。`,
    '删除确认',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  )
  await localLibrary.deleteLocalChapter([chapter.id])
  ElMessage.success('删除成功')
  await loadCatalogTree()
}

const handleDeleteSelected = async () => {
  if (isCatalogStructureLocked.value) return
  closeContextMenu()
  closeChapterContextMenu()
  closeImportExportMenu()
  closeSortMenu()

  try {
    if (activeType.value === 'volume') {
      const volume = findVolumeById(activeId.value)
      if (!volume) {
        ElMessage.warning('请先选择要删除的分卷')
        return
      }
      await deleteVolume(volume)
      return
    }

    if (activeType.value === 'chapter') {
      const chapter = findChapterInCatalog(activeId.value)
      if (!chapter) {
        ElMessage.warning('请先选择要删除的章节')
        return
      }
      await deleteChapter(chapter)
      return
    }

    ElMessage.warning('请先选择要删除的章节或分卷')
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除失败:', error)
      showApiError(error, '删除失败')
    }
  }
}

// 导入导出菜单逻辑
const importExportMenu = ref({
  visible: false,
  x: 0,
  y: 0
})

const handleImportExportClick = (event: MouseEvent) => {
  closeSortMenu()
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  importExportMenu.value = {
    visible: true,
    x: rect.left - 60, // 稍微向左偏移以对齐
    y: rect.bottom + 5
  }
  document.addEventListener('click', closeImportExportMenu)
}

const closeImportExportMenu = () => {
  importExportMenu.value.visible = false
  document.removeEventListener('click', closeImportExportMenu)
}

const handleImportExportAction = (action: 'import' | 'export') => {
  if (isCatalogStructureLocked.value && action === 'import') {
    closeImportExportMenu()
    return
  }
  if (action === 'import') {
    importChaptersVisible.value = true
  } else {
    openExportChaptersModal('batch')
  }
  closeImportExportMenu()
}

type SortAction = 'current_title' | 'current_create' | 'all_title' | 'volume_title'

const sortMenu = ref({
  visible: false,
  x: 0,
  y: 0
})

const handleSortClick = (event: MouseEvent) => {
  if (isCatalogStructureLocked.value) return
  closeContextMenu()
  closeChapterContextMenu()
  closeImportExportMenu()
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  sortMenu.value = {
    visible: true,
    x: rect.left - 140,
    y: rect.bottom + 5
  }
  document.addEventListener('click', closeSortMenu)
}

const closeSortMenu = () => {
  sortMenu.value.visible = false
  document.removeEventListener('click', closeSortMenu)
}

const titleCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

const getOrdinalInTitle = (title: string, unit: '章' | '卷') => {
  const arabicMatch = title.match(new RegExp(`第\\s*(\\d+)\\s*${unit}`))
  if (arabicMatch) return Number(arabicMatch[1])

  const chineseMatch = title.match(new RegExp(`第\\s*([零一二三四五六七八九十百千万]+)\\s*${unit}`))
  if (chineseMatch) return chineseToNumber(chineseMatch[1])

  return Number.POSITIVE_INFINITY
}

const compareTitleByOrdinal = (unit: '章' | '卷') => {
  return (a: { title: string; sortNo?: number }, b: { title: string; sortNo?: number }) => {
    const aOrdinal = getOrdinalInTitle(a.title, unit)
    const bOrdinal = getOrdinalInTitle(b.title, unit)
    if ((Number.isFinite(aOrdinal) || Number.isFinite(bOrdinal)) && aOrdinal !== bOrdinal) {
      return aOrdinal < bOrdinal ? -1 : 1
    }
    return titleCollator.compare(a.title, b.title) || Number(a.sortNo || 0) - Number(b.sortNo || 0)
  }
}

const hasChapterOrdinal = (title: string) =>
  /^第[0-9一二三四五六七八九十百千万零〇两]+[章节回]/.test(String(title || '').trim())

const formatChapterDisplayTitle = (chapter: Chapter | null) => {
  if (!chapter) return ''
  const title = String(chapter.title || '').trim() || '未命名章节'
  if (hasChapterOrdinal(title)) return title
  const sortNo = Number(chapter.sortNo || 0)
  // 工作流旧建书标题可能只存事件名，目录展示层补齐章节序号。
  return sortNo > 0 ? `第${sortNo}章 ${title}` : title
}

const getChapterStatusLabel = (chapter: Chapter) => {
  if (!isVerifiedWorkflowCatalog.value) return ''
  if (chapter.isPlanned || chapter.selectable === false || chapter.workflowStatus === 'planned') return '待生成'
  if (chapter.workflowStatus === 'generating') return '生成中'
  if (chapter.workflowStatus === 'review_required') return '待确认'
  if (chapter.workflowStatus === 'incomplete') return '未完成'
  return ''
}

const isVirtualWorkflowChapter = (chapter: Chapter) =>
  chapter.isPlanned === true || chapter.selectable === false

const getPersistedChapterIds = (chapters: Chapter[]) =>
  chapters.filter(chapter => !isVirtualWorkflowChapter(chapter)).map(chapter => chapter.id)

const getTimeValue = (value?: string) => {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

const sortChaptersInVolume = async (
  volume: Volume,
  compare: (a: Chapter, b: Chapter) => number,
  showEmptyWarning = true
) => {
  if (isCatalogStructureLocked.value) return false
  if (!volume.children.length) {
    if (showEmptyWarning) ElMessage.warning('当前卷没有章节可排序')
    return false
  }
  if (volume.children.some(isVirtualWorkflowChapter)) {
    ElMessage.warning('含待生成章节时暂不支持目录排序')
    return false
  }

  volume.children = [...volume.children].sort(compare)
  await localLibrary.sortLocalChapters({
    chapterIds: getPersistedChapterIds(volume.children),
    volumeId: String(volume.id)
  })
  return true
}

const handleSortAction = async (action: SortAction) => {
  if (isCatalogStructureLocked.value) {
    closeSortMenu()
    return
  }
  try {
    switch (action) {
      case 'current_title': {
        const volume = getActiveVolume()
        if (!volume) {
          ElMessage.warning('请先选择一个章节或分卷')
          return
        }
        if (await sortChaptersInVolume(volume, compareTitleByOrdinal('章'))) {
          ElMessage.success('当前卷排序成功')
        }
        break
      }
      case 'current_create': {
        const volume = getActiveVolume()
        if (!volume) {
          ElMessage.warning('请先选择一个章节或分卷')
          return
        }
        if (await sortChaptersInVolume(volume, (a, b) => getTimeValue(a.createTime) - getTimeValue(b.createTime))) {
          ElMessage.success('当前卷排序成功')
        }
        break
      }
      case 'all_title': {
        let changedCount = 0
        for (const volume of catalogItems.value) {
          if (await sortChaptersInVolume(volume, compareTitleByOrdinal('章'), false)) {
            changedCount += 1
          }
        }
        if (!changedCount) {
          ElMessage.warning('当前作品没有可排序章节')
          return
        }
        ElMessage.success('全书章节排序成功')
        break
      }
      case 'volume_title': {
        if (!catalogItems.value.length) {
          ElMessage.warning('当前作品没有可排序分卷')
          return
        }
        catalogItems.value = [...catalogItems.value].sort(compareTitleByOrdinal('卷'))
        await localLibrary.sortLocalVolumes({
          volumeIds: catalogItems.value.map(volume => volume.id),
          bookId: bookId.value
        })
        ElMessage.success('分卷排序成功')
        break
      }
    }
  } catch (error) {
    console.error('排序失败:', error)
    showApiError(error, '排序失败')
    await loadCatalogTree()
  } finally {
    closeSortMenu()
  }
}

// 章节右键菜单逻辑
const chapterContextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  chapter: null as Chapter | null
})

const handleChapterContextMenu = (event: MouseEvent, chapter: Chapter) => {
  if (chapter.isPlanned || chapter.selectable === false) return
  chapterContextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    chapter
  }
  document.addEventListener('click', closeChapterContextMenu)
}

const closeChapterContextMenu = () => {
  chapterContextMenu.value.visible = false
  document.removeEventListener('click', closeChapterContextMenu)
}

const handleChapterMenuAction = async (action: string) => {
  const chapter = chapterContextMenu.value.chapter
  if (!chapter) return
  // 停止态只放开真实章节的信息操作，浏览操作和结构操作继续按原权限处理。
  const canEditAction =
    canEditChapterMetadata.value
    && ['editInfo', 'rename', 'outline'].includes(action)
  if (
    isCatalogStructureLocked.value
    && !canEditAction
    && action !== 'open_sidebar'
    && action !== 'export'
    && action !== 'history'
  ) {
    closeChapterContextMenu()
    return
  }

  try {
    switch (action) {
      case 'open_sidebar':
        collapsed.value = false
        handleChapterClick(chapter)
        break
      case 'editInfo':
        editingChapter.value = chapter
        selectedVolumeId.value = chapter.volumeId
        createChapterVisible.value = true
        break
      case 'rename':
        startEdit(chapter)
        break
      case 'outline':
        await extractChapterOutline(chapter)
        break
      case 'export':
        openExportChaptersModal('merge', [chapter.id])
        break
      case 'history':
        historyChapter.value = chapter
        chapterHistoryVisible.value = true
        break
      case 'delete':
        await deleteChapter(chapter)
        break
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('操作失败:', error)
      showApiError(error, '操作失败')
    }
  }

  closeChapterContextMenu()
}

// 宽度拖拽逻辑
const isResizing = ref(false)
const startX = ref(0)
const startWidth = ref(0)

const startResize = (e: MouseEvent) => {
  if (collapsed.value) return
  e.preventDefault()
  isResizing.value = true
  startX.value = e.clientX
  startWidth.value = editorStore.sidebarWidth

  document.addEventListener('mousemove', doResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}

const doResize = (e: MouseEvent) => {
  if (!isResizing.value) return
  const delta = e.clientX - startX.value
  const newWidth = Math.max(WRITING_SIDEBAR_MIN_WIDTH, Math.min(WRITING_SIDEBAR_MAX_WIDTH, startWidth.value + delta))
  editorStore.setSidebarWidth(newWidth)
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', doResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
}

onUnmounted(() => {
  stopResize()
})

const catalogItems = ref<Volume[]>([])
let catalogLoadRevision = 0
const editableChapterVolumes = computed(() => {
  if (!props.workflowStopped || !editingChapter.value) return catalogItems.value
  return catalogItems.value.filter(
    volume => String(volume.id) === String(editingChapter.value?.volumeId)
  )
})

const importChaptersVisible = ref(false)
const exportChaptersVisible = ref(false)
const exportChaptersMode = ref<'batch' | 'merge'>('batch')
const exportPreselectedChapterIds = ref<number[]>([])
const chapterHistoryVisible = ref(false)
const historyChapter = ref<Chapter | null>(null)

watch([isCatalogStructureLocked, canEditChapterMetadata], ([locked, chapterEditable]) => {
  if (!locked) return
  // 锁定工作流结构时关闭残留操作；恢复生成后还要同步收回章节编辑入口。
  createVolumeVisible.value = false
  importChaptersVisible.value = false
  editingVolume.value = null
  draggedItem.value = null
  closeSortMenu()
  if (!chapterEditable) {
    createChapterVisible.value = false
    editingChapter.value = null
    cancelEdit()
  }
})

const openExportChaptersModal = (mode: 'batch' | 'merge', preselected: number[] = []) => {
  exportChaptersMode.value = mode
  exportPreselectedChapterIds.value = preselected
  exportChaptersVisible.value = true
  closeContextMenu()
  closeChapterContextMenu()
  closeImportExportMenu()
  closeSortMenu()
}

const findChapterInCatalog = (chapterId: number | null) => {
  if (chapterId == null) return null
  for (const volume of catalogItems.value) {
    const match = volume.children.find(chapter => chapter.id === chapterId)
    if (match) return match
  }
  return null
}

const pickFirstChapter = () => {
  for (const volume of catalogItems.value) {
    const chapter = volume.children.find(item => !isVirtualWorkflowChapter(item))
    if (chapter) return chapter
  }
  return null
}

const ensureActiveChapter = () => {
  let target = findChapterInCatalog(editorStore.activeChapterId)
  if (!target) {
    target = pickFirstChapter()
  }
  if (target) {
    const displayTitle = formatChapterDisplayTitle(target)
    activeId.value = target.id
    activeType.value = 'chapter'
    if (editorStore.activeChapterId !== target.id) {
      editorStore.setActiveChapter({ id: target.id, title: displayTitle, summary: target.summary })
    } else {
      editorStore.setChapterTitle(displayTitle)
      editorStore.setActiveChapterSummary(target.summary || '')
    }
  } else {
    activeId.value = null
    activeType.value = null
    editorStore.setActiveChapter()
    editorStore.setChapterWordCount(0)
  }
}

// 加载目录树

const loadCatalogTree = async () => {
  if (!bookId.value) return
  const loadRevision = ++catalogLoadRevision
  try {
    // 本地树与目录组件的 Volume 形状字段级兼容（多余字段忽略，缺省字段组件有兜底）
    const volumeList = (await localLibrary.getLocalBookTree(bookId.value)) as unknown as Volume[]
    if (loadRevision !== catalogLoadRevision) return
    volumeList.forEach((vol: Volume) => {
      vol.open = vol.open !== false
      if (!Array.isArray(vol.children)) vol.children = []
    })
    catalogItems.value = volumeList
    ensureActiveChapter()
  } catch (error) {
    if (loadRevision !== catalogLoadRevision) return
    console.error('加载目录树失败:', error)
    showApiError(error, '加载目录树失败')
  } finally {
    // 只有最新一次请求才有资格收起骨架，否则快速切书时旧请求会提前把它撤掉。
    if (loadRevision === catalogLoadRevision) {
      catalogLoading.value = false
      emit('catalog-loading', false)
    }
  }
}

watch(
  () => route.params.bookId,
  (newBookId) => {
    if (!newBookId) return
    bookId.value = String(newBookId)
    catalogLoading.value = true
    emit('catalog-loading', true)
    activeId.value = null
    activeType.value = null
    editorStore.setActiveChapter()
    editorStore.setChapterWordCount(0)
    loadCatalogTree()
  }
)

watch(
  () => [
    Number(props.workflowRunId || 0),
    Number(props.workflowTaskId || 0),
  ] as const,
  ([runId, taskId], [previousRunId, previousTaskId]) => {
    if (
      !bookId.value ||
      (runId === previousRunId && taskId === previousTaskId)
    )
      return
    void loadCatalogTree()
  }
)

watch(
  () => editorStore.activeChapterId,
  (id) => {
    if (!id) {
      activeId.value = null
      activeType.value = null
      return
    }
    if (activeId.value === id) return
    const chapter = findChapterInCatalog(id)
    if (chapter) {
      activeId.value = chapter.id
      activeType.value = 'chapter'
    }
  }
)

watch([chapterWordCount, () => editorStore.activeChapterTextContent], ([count, text]) => {
  const currentId = editorStore.activeChapterId
  if (!currentId) return
  const chapter = findChapterInCatalog(currentId)
  if (chapter) {
    chapter.wordCount = typeof count === 'number' ? count : 0
    chapter.textWordCount = countTextWords(text)
  }
})

watch(activeChapterTitle, (title) => {
  const currentId = editorStore.activeChapterId
  if (!currentId || typeof title !== 'string') return
  const chapter = findChapterInCatalog(currentId)
  if (chapter && chapter.title !== title && formatChapterDisplayTitle(chapter) !== title) {
    chapter.title = title
  }
})

// 初始化
const handleCatalogRefresh = () => {
  void loadCatalogTree()
}

// 后台生成章节的实时字数：AI 正在写的章不一定是当前打开的章，
// 靠 activeChapter 的 watch 更新不到，由生成事件直推目录树。
function handleChapterWordsEvent(event: Event) {
  const detail = (event as CustomEvent<{ chapterId?: number; wordCount?: number; textWordCount?: number }>).detail || {}
  const chapterId = Number(detail.chapterId || 0)
  const wordCount = Number(detail.wordCount)
  if (!chapterId || !Number.isFinite(wordCount) || wordCount < 0) return
  const chapter = findChapterInCatalog(chapterId)
  if (chapter) { chapter.wordCount = wordCount; chapter.textWordCount = detail.textWordCount ?? null }
}

async function handleOpenChapterEvent(event: Event) {
  const chapterId = Number((event as CustomEvent<{ chapterId?: number }>).detail?.chapterId || 0)
  if (!chapterId) return
  let chapter = findChapterInCatalog(chapterId)
  if (!chapter) {
    await loadCatalogTree()
    chapter = findChapterInCatalog(chapterId)
  }
  if (chapter) {
    await handleChapterClick(chapter)
  }
}

onMounted(() => {
  // 网页窄屏默认收起目录，让正文优先占满可用宽度。
  if (isWebCompactWriting()) collapsed.value = true
  editorStore.setSidebarWidth(editorStore.sidebarWidth)
  bookId.value = route.params.bookId as string
  loadCatalogTree()
  window.addEventListener('ew-writing-catalog-refresh', handleCatalogRefresh)
  window.addEventListener('ew-writing-open-chapter', handleOpenChapterEvent as EventListener)
  window.addEventListener('ew-writing-chapter-words', handleChapterWordsEvent as EventListener)
})

onUnmounted(() => {
  window.removeEventListener('ew-writing-catalog-refresh', handleCatalogRefresh)
  window.removeEventListener('ew-writing-open-chapter', handleOpenChapterEvent as EventListener)
  window.removeEventListener('ew-writing-chapter-words', handleChapterWordsEvent as EventListener)
  document.removeEventListener('click', closeContextMenu)
  document.removeEventListener('click', closeChapterContextMenu)
  document.removeEventListener('click', closeImportExportMenu)
  document.removeEventListener('click', closeSortMenu)
})

// 搜索过滤的目录项
const filteredCatalogItems = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()

  // 如果没有搜索关键词，返回原始数据
  if (!keyword) {
    return catalogItems.value
  }

  // 过滤目录项
  return catalogItems.value.map(volume => {
    // 检查卷标题是否匹配
    const volumeMatches = volume.title.toLowerCase().includes(keyword)

    // 过滤章节
    const filteredChildren = volume.children.filter(chapter =>
      formatChapterDisplayTitle(chapter).toLowerCase().includes(keyword)
    )

    // 如果卷标题匹配，显示该卷的所有章节
    if (volumeMatches) {
      return {
        ...volume,
        open: true, // 自动展开匹配的卷
        _searchMatched: true // 标记为搜索匹配
      }
    }

    // 如果有章节匹配，显示该卷和匹配的章节
    if (filteredChildren.length > 0) {
      return {
        ...volume,
        children: filteredChildren,
        open: true, // 自动展开有匹配章节的卷
        _searchMatched: false
      }
    }

    // 都不匹配，返回 null
    return null
  }).filter(Boolean) as Volume[] // 过滤掉 null 值
})

const escapeHtml = (value: string) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 高亮搜索关键词
const highlightText = (text: string) => {
  const keyword = searchText.value.trim()
  const safeText = escapeHtml(text)
  if (!keyword) return safeText

  // 使用正则表达式进行不区分大小写的替换
  const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi')
  return safeText.replace(regex, '<mark class="search-highlight">$1</mark>')
}

const toggleSidebar = () => {
  collapsed.value = !collapsed.value
}

const handleVolumeClick = (volume: Volume) => {
  volume.open = !volume.open
  activeId.value = volume.id
  activeType.value = 'volume'
}

const handleCreateChapterBtn = () => {
  if (isCatalogStructureLocked.value) return
  let targetVolume: Volume | undefined

  // 1. 尝试根据当前选中项判断
  if (activeId.value !== null) {
    if (activeType.value === 'volume') {
      targetVolume = catalogItems.value.find(v => v.id === activeId.value)
    } else if (activeType.value === 'chapter') {
      targetVolume = catalogItems.value.find(v => v.children.some(c => c.id === activeId.value))
    }
  }

  // 2. 如果没找到，使用最后一个卷
  if (!targetVolume && catalogItems.value.length > 0) {
    targetVolume = catalogItems.value[catalogItems.value.length - 1]
  }

  // 3. 执行新建
  if (targetVolume) {
    handleAddChapter(targetVolume)
  } else {
    ElMessage.warning('请先新建分卷后再创建章节')
    handleCreateVolumeBtn()
  }
}

const handleAddChapter = async (volume: Volume) => {
  if (isCatalogStructureLocked.value) return
  try {
    // 1. 生成标题
    const existingTitles = volume.children.map(c => c.title)
    const nextTitle = generateNextChapterTitle(existingTitles)

    await localLibrary.createLocalChapter({
      bookId: bookId.value,
      title: nextTitle,
      volumeId: String(volume.id)
    })

    ElMessage.success('新建成功')

    // 3. 重新加载目录树
    await loadCatalogTree()

    // 4. 找到新创建的章节并进入编辑模式
    const updatedVolume = catalogItems.value.find(v => v.id === volume.id)
    if (updatedVolume && updatedVolume.children.length > 0) {
      const newChapter = updatedVolume.children[updatedVolume.children.length - 1]
      activeId.value = newChapter.id
      activeType.value = 'chapter'
      editorStore.setActiveChapter({
        id: newChapter.id,
        title: formatChapterDisplayTitle(newChapter),
        summary: newChapter.summary
      })

      // 延迟一下以确保 DOM 更新
      setTimeout(() => {
        startEdit(newChapter)
      }, 100)
    }
  } catch (error) {
    console.error('新建章节失败:', error)
    showApiError(error, '新建章节失败')
  }
}

// const handleAddChapter = (volume: Volume) => {
//   editingChapter.value = null
//   selectedVolumeId.value = volume.id
//   createChapterVisible.value = true
// }

const handleChapterClick = async (chapter: Chapter) => {
  if (chapter.isPlanned || chapter.selectable === false) return
  if (editorStore.activeChapterId === chapter.id) {
    activeId.value = chapter.id
    activeType.value = 'chapter'
    return
  }
  if (props.beforeSwitchChapter) {
    const canSwitch = await Promise.resolve(props.beforeSwitchChapter(chapter))
    if (!canSwitch) {
      // 保存失败阻断切章时给出明确提示，避免“点了没反应”。
      // 版本冲突已由冲突弹窗单独提示，这里只提示硬失败（网络/云端保存失败）。
      if (editorStore.chapterSaveState !== 'conflict') {
        ElMessage.error('当前章节保存失败，请检查网络后重试')
      }
      return
    }
  }
  activeId.value = chapter.id
  activeType.value = 'chapter'
  editorStore.setActiveChapter({
    id: chapter.id,
    title: formatChapterDisplayTitle(chapter),
    summary: chapter.summary
  })
}

const extractChapterOutline = async (chapter: Chapter) => {
  if (!canEditChapterMetadata.value) return
  if (!bookId.value) return
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  const { data: detail } = await getLocalChapterDetailData({ bookId: bookId.value, id: chapter.id })
  const data = await requestLocalChatCompletion({
    scene: 'chapter_outline',
    sceneLabel: '章纲提取',
    modelCode,
    messages: buildFreeInstructionMessages({
      instruction: promptText('free-instruction', 'chapterSummary'),
      selection: detail?.textContent || chapter.summary || chapter.title,
      context: `章节名：${chapter.title}${chapter.summary ? `；现有章纲：${chapter.summary}` : ''}`
    }),
  })
  const summary = String(data || '').trim()
  if (!summary) {
    ElMessage.warning('未生成可用章纲')
    return
  }
  await localLibrary.updateLocalChapter({
    id: chapter.id,
    summary,
  })
  chapter.summary = summary
  if (editorStore.activeChapterId === chapter.id) {
    editorStore.setActiveChapterSummary(summary)
  }
  ElMessage.success('章纲已更新')
}

const handleHistoryRestored = async (chapterId: number) => {
  await loadCatalogTree()
  const restored = findChapterInCatalog(chapterId)
  if (restored) {
    editorStore.setActiveChapter()
    nextTick(() => {
      handleChapterClick(restored)
    })
  }
}

// const handleVolumeMore = (volume: Volume) => {
//   console.log('More options for volume:', volume.title)
// }

// 拖拽逻辑
const onDragStart = (e: DragEvent, data: DragData) => {
  if (isCatalogStructureLocked.value) {
    e.preventDefault()
    draggedItem.value = null
    return
  }
  if (data.type === 'chapter' && isVirtualWorkflowChapter(data.item as Chapter)) return
  draggedItem.value = data
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
  }
}

const onDrop = async (_e: DragEvent, target: DragData) => {
  if (isCatalogStructureLocked.value) {
    draggedItem.value = null
    return
  }
  if (!draggedItem.value) return
  if (target.type === 'chapter' && isVirtualWorkflowChapter(target.item as Chapter)) {
    draggedItem.value = null
    return
  }

  const source = draggedItem.value

  try {
    // 卷排序
    if (source.type === 'volume' && target.type === 'volume') {
      if (source.index !== undefined && target.index !== undefined && source.index !== target.index) {
        const item = catalogItems.value.splice(source.index, 1)[0]
        catalogItems.value.splice(target.index, 0, item)

        const volumeIds = catalogItems.value.map(v => v.id)
        await localLibrary.sortLocalVolumes({ volumeIds, bookId: bookId.value })
        ElMessage.success('排序成功')
      }
    }

    // 章节操作
    if (source.type === 'chapter') {
      const sourceVolIndex = source.vIndex!
      const sourceChapIndex = source.cIndex!

      // 移动到另一个章节位置（同卷或跨卷）
      if (target.type === 'chapter') {
        const targetVolIndex = target.vIndex!
        const targetChapIndex = target.cIndex!

        const item = catalogItems.value[sourceVolIndex].children.splice(sourceChapIndex, 1)[0]
        // 更新 item 的 volumeId
        item.volumeId = String(catalogItems.value[targetVolIndex].id)

        catalogItems.value[targetVolIndex].children.splice(targetChapIndex, 0, item)

        const chapterIds = getPersistedChapterIds(catalogItems.value[targetVolIndex].children)
        await localLibrary.sortLocalChapters({ chapterIds, volumeId: String(catalogItems.value[targetVolIndex].id) })
        if (sourceVolIndex !== targetVolIndex) {
          await localLibrary.sortLocalChapters({
            chapterIds: getPersistedChapterIds(catalogItems.value[sourceVolIndex].children),
            volumeId: String(catalogItems.value[sourceVolIndex].id)
          })
        }
        ElMessage.success('排序成功')
      }

      // 移动到卷（作为该卷第一个章节）
      if (target.type === 'volume') {
        const targetVolIndex = target.index!

        const item = catalogItems.value[sourceVolIndex].children.splice(sourceChapIndex, 1)[0]
        item.volumeId = String(catalogItems.value[targetVolIndex].id)

        catalogItems.value[targetVolIndex].children.unshift(item)
        // 自动展开目标卷
        catalogItems.value[targetVolIndex].open = true

        const chapterIds = getPersistedChapterIds(catalogItems.value[targetVolIndex].children)
        await localLibrary.sortLocalChapters({ chapterIds, volumeId: String(catalogItems.value[targetVolIndex].id) })
        if (sourceVolIndex !== targetVolIndex) {
          await localLibrary.sortLocalChapters({
            chapterIds: getPersistedChapterIds(catalogItems.value[sourceVolIndex].children),
            volumeId: String(catalogItems.value[sourceVolIndex].id)
          })
        }
        ElMessage.success('排序成功')
      }
    }
  } catch (error) {
    console.error('排序失败:', error)
    showApiError(error, '排序失败')
    // 失败时重新加载数据
    await loadCatalogTree()
  }

  draggedItem.value = null
}
</script>

<style scoped lang="scss">
.writing-sidebar {
  // width: 256px; // 由 store 控制
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 280px;
  position: relative;
  z-index: 20;
  transition: width 0.3s ease;

  &.no-transition {
    transition: none !important;
  }

  &.collapsed {
    width: 0 !important;
    min-width: 0;

    .sidebar-content {
      overflow: hidden;
    }

    .resize-handle {
      display: none;
    }
  }

  .resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 2px;
    height: 100%;
    cursor: col-resize;
    z-index: 100;
    transition: background-color 0.2s;
    background: transparent;

    &:hover,
    &.active {
      background-color: var(--ink-accent);
    }
  }

  .toggle-button-wrapper {
    position: absolute;
    top: 50%;
    right: -15px;
    transform: translateY(-50%);
    z-index: 30;
  }

  .toggle-button {
    width: 16px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--toggle-btn-border);
    border-left: none;
    border-radius: 0 4px 4px 0;
    background: var(--toggle-btn-bg);
    backdrop-filter: blur(4px);
    color: var(--ink-sec);
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);

    i {
      font-size: 10px;
    }

    &:hover {
      background: var(--toggle-btn-hover-bg);
      color: var(--toggle-btn-hover-color, var(--ink-main));
    }
  }

  .sidebar-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .search-section {
    padding: 12px;

    .search-wrapper {
      position: relative;

      .search-input {
        width: 100%;
        padding: 8px 32px 8px 12px;
        font-size: 14px;
        border: 1px solid var(--input-border);
        border-radius: 4px;
        background: var(--input-bg);
        color: var(--ink-main);
        transition: all 0.3s ease;

        &::placeholder {
          color: var(--ink-sec);
          opacity: 0.6;
        }

        &:focus {
          background: var(--input-focus-bg);
          border-color: var(--input-focus-border);
          outline: none;
        }
      }

      .search-icon {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--ink-sec);
        opacity: 0.5;
        font-size: 12px;
        pointer-events: none;

        &.clear-icon {
          pointer-events: auto;
          cursor: pointer;
          opacity: 0.6;
          transition: all 0.2s ease;

          &:hover {
            opacity: 1;
            color: var(--ink-main);
          }
        }
      }
    }
  }

  .create-buttons {
    display: flex;
    gap: 8px;
    padding: 0 12px 12px;
    font-family: system-ui, sans-serif;

    .create-btn {
      flex: 1;
      padding: 6px 12px;
      font-size: 14px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .btn-primary {
      background: var(--btn-primary-bg);
      color: var(--btn-primary-color);
      border: none;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);

      &:hover {
        background: var(--btn-primary-hover-bg);
        color: var(--btn-primary-hover-color);
      }
    }

    .btn-outline {
      background: var(--btn-outline-bg);
      border: 1px solid var(--btn-outline-border);
      color: var(--ink-main);

      &:hover {
        background: var(--btn-outline-hover-bg);
      }
    }
  }

  .catalog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--ink-sec);
    border-bottom: 1px solid rgba(128, 128, 128, 0.05);
    // font-family: system-ui, sans-serif;

    .catalog-actions {
      display: flex;
      gap: 12px;

      .action-icon {
        cursor: pointer;
        transition: color 0.3s ease;

        &:hover {
          color: var(--ink-main);
        }
      }
    }
  }

  .catalog-list {
    flex: 1;
    overflow-y: auto;
    // font-family: system-ui, sans-serif;

    // 目录骨架：行高与真实条目对齐，加载完成时列表不跳动。
    // 卷标题行更宽更深，章节行缩进，形态上一眼能看出是目录。
    .catalog-skeleton {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px 12px;

      .catalog-skeleton-row {
        height: 14px;
        border-radius: 4px;
        background: linear-gradient(
          90deg,
          color-mix(in srgb, currentColor 8%, transparent) 25%,
          color-mix(in srgb, currentColor 16%, transparent) 37%,
          color-mix(in srgb, currentColor 8%, transparent) 63%
        );
        background-size: 400% 100%;
        animation: ew-catalog-skeleton-sweep 1.4s ease infinite;

        &.is-chapter {
          margin-left: 14px;
          width: 72%;
          opacity: 0.75;
        }
      }
    }

    @keyframes ew-catalog-skeleton-sweep {
      0% {
        background-position: 100% 50%;
      }
      100% {
        background-position: 0 50%;
      }
    }

    .no-results {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      color: var(--ink-sec);
      opacity: 0.6;

      i {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.3;
      }

      p {
        font-size: 14px;
        margin: 0;
      }
    }

    .catalog-item {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      font-size: 14px;
      color: var(--ink-main);
      transition: color 0.3s ease;
      cursor: pointer;
      position: relative;
      z-index: 1;

      // 覆盖主题默认背景，交由伪元素控制
      &.nav-item-active {
        background: transparent !important;
        box-shadow: none !important;
        border: none !important;
      }

      // 背景动画
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 0;
        height: 100%;
        background: var(--nav-active-bg);
        transition: width 0.3s ease;
        z-index: -1;
      }

      // 左侧条状动画
      &::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 0;
        width: 3px;
        height: 0;
        background: var(--active-bar-color, var(--ink-main)); // 使用主题定义的颜色
        transform: translateY(-50%);
        transition: height 0.3s ease;
        z-index: -1;
      }

      // 悬浮或激活时展开背景
      &:hover::before,
      &.nav-item-active::before {
        width: 100%;
      }

      // 激活时展开左侧条
      &.nav-item-active::after {
        height: 100%;
      }

      .edit-input {
        flex: 1;
        width: 0;
        height: 28px;
        line-height: 28px;
        padding: 0 8px;
        font-size: 14px;
        color: var(--ink-main);
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        border-radius: 4px;
        box-sizing: border-box;
        outline: none;
        transition: all 0.2s;
        margin-right: 8px;

        &:focus {
          background: var(--input-focus-bg);
          border-color: var(--input-focus-border);
        }
      }

      i {
        margin-right: 8px;
        font-size: 14px;
      }

      .item-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;

        // 搜索高亮样式
        :deep(.search-highlight) {
          background: var(--search-highlight-bg, rgba(255, 235, 59, 0.5));
          color: var(--search-highlight-color, inherit);
          font-weight: 600;
          padding: 2px 0;
          border-radius: 2px;
        }
      }

      .item-count {
        font-size: 12px;
        opacity: 0.5;
      }

      &.is-planned {
        cursor: default;
        color: var(--ink-sec);
        opacity: 0.72;

        &:hover::before {
          width: 0;
        }
      }

      .chapter-workflow-status {
        flex-shrink: 0;
        padding: 2px 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--ink-sec) 10%, transparent);
        color: var(--ink-sec);
        font-size: 10px;

        &.is-generating {
          background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
          color: var(--ink-accent);
        }

        &.is-review_required {
          background: color-mix(in srgb, var(--state-warning) 14%, transparent);
          color: var(--state-warning);
        }
      }

      .item-actions {
        margin-left: 8px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        min-width: 40px;

        .chapter-count {
          font-size: 12px;
          color: var(--ink-sec);
          opacity: 0.5;
        }

        .action-buttons {
          display: none;
          gap: 2px;
          align-items: center;

          .action-btn {
            font-size: 12px;
            color: var(--ink-sec);
            cursor: pointer;
            // padding: 4px;
            border-radius: 4px;
            transition: all 0.2s;

            &:hover {
              color: var(--ink-main);
              background: var(--overlay-hover);
            }
          }
        }
      }

      &:hover,
      &.force-hover {
        .item-actions {
          .chapter-count {
            display: none;
          }

          .action-buttons {
            display: flex;
          }
        }
      }
    }
  }

  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 180px;
    background: var(--ui-glass-bg);
    backdrop-filter: blur(8px);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow);
    border-radius: 8px;
    padding: 8px 0;
    font-size: 14px;
    color: var(--ink-main);
    animation: fadeIn 0.2s ease;

    .menu-header {
      padding: 8px 16px;

      .menu-title {
        font-weight: 500;
        margin-bottom: 4px;
      }

      .menu-info {
        font-size: 12px;
        color: var(--ink-sec);
        opacity: 0.8;
      }
    }

    .menu-divider {
      height: 1px;
      background: var(--ui-border-hover);
      margin: 4px 0;
    }

    .menu-item {
      padding: 8px 16px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      font-size: 14px;

      &:hover {
        background: var(--nav-hover-bg);
      }

      &.danger {
        color: var(--state-danger);

        &:hover {
          background: var(--state-danger-surface);
        }
      }
    }
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-5px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}

@media (max-width: 900px) {
  :global(body.web-runtime .writing-sidebar){
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 80;
    width: min(320px, calc(100vw - 64px)) !important;
    min-width: 0;
    max-width: calc(100vw - 64px);
    background: color-mix(in srgb, var(--bg-main) 94%, transparent);
    box-shadow: 18px 0 42px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(16px);
    transform: translateX(0);
    transition: transform 0.22s ease;
  }

  :global(body.web-runtime .writing-sidebar.collapsed){
    width: min(320px, calc(100vw - 64px)) !important;
    transform: translateX(-100%);
  }

  :global(body.web-runtime .writing-sidebar .resize-handle){
    display: none;
  }

  :global(body.web-runtime .writing-sidebar .toggle-button-wrapper){
    right: -28px;
  }

  :global(body.web-runtime .writing-sidebar .toggle-button){
    width: 28px;
    height: 46px;
    border-left: 1px solid var(--toggle-btn-border);
    border-radius: 0 8px 8px 0;
  }
}
</style>
