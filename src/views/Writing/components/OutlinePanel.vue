<template>
  <div class="panel-content reference-panel-content" :class="{ 'resizing': isResizing }">
    <!-- 面板标题 -->
    <div v-if="!hideHeader" class="panel-header">
      <span class="panel-title">{{ title }}</span>
      <div class="panel-actions">
        <button
          class="action-icon"
          type="button"
          :title="panelMode === 'side' ? '新窗口打开' : '收回侧栏'"
          @click="panelMode === 'side' ? handlePopout() : handleDock()"
        >
          <i :class="panelMode === 'side' ? 'fa-solid fa-up-right-from-square' : 'fa-solid fa-arrow-right-to-bracket'"></i>
        </button>
        <button class="action-icon" type="button" title="关闭" @click="handleClose">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>

    <!-- 主体区域 -->
    <div class="panel-body">
      <!-- 详情内容 (Rich Text Editor) -->
      <div class="detail-content" v-if="currentOutline">
        <div class="section-header">
          <input
            v-model="currentOutline.title"
            class="title-input"
            placeholder="输入大纲标题..."
            @input="handleTitleInput"
            @blur="commitCurrentTitle"
            @keyup.enter="commitCurrentTitle"
          />
          <i class="fa-solid fa-edit"></i>
        </div>

        <div class="editor-toolbar">
          <span>大纲内容</span>
          <div class="ai-action-group">
            <button
class="ai-btn" :class="{ loading: isAiPolishing }" :disabled="isAiPolishing"
              @click="handleAiPolish">
              <i :class="['fa-solid', isAiPolishing ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
              {{ isAiPolishing ? '润色中...' : 'AI润色' }}
            </button>
            <button
v-if="canUndoOutlinePolish" class="ai-btn undo-btn" type="button" title="恢复 AI 润色前内容"
              @click="handleUndoOutlinePolish">
              <i class="fa-solid fa-rotate-left"></i>
              撤销
            </button>
          </div>
        </div>

        <div class="editor-container">
          <WangEditor
v-if="currentOutline" v-model:value="currentOutline.content" ref="wangEditorRef"
            class="outline-editor" />
        </div>
      </div>
      <div class="detail-content empty-state" v-else>
        <p>请选择左侧大纲进行编辑</p>
      </div>

      <!-- 拖拽手柄 -->
      <div class="resize-handle" :class="{ active: isResizing }" @mousedown="startResize"></div>

      <!-- 目录树 -->
      <div class="outline-tree border-gradient-l" :style="{ width: store.outlineTreeWidth + 'px' }">
        <!-- 搜索栏 -->
        <div class="tree-header">
          <div class="search-wrapper">
            <input type="text" placeholder="搜索大纲..." class="tree-search" v-model="searchText">
            <i class="fa-solid fa-magnifying-glass search-icon"></i>
          </div>
          <button class="add-button" title="新建文件夹" @click="handleAddFolder">
            <i class="fa-solid fa-folder-plus"></i>
          </button>
          <button class="add-button" title="新建大纲" style="margin-left: 4px;" @click="handleAddOutline">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>

        <div class="tree-toolbar">
          <span>目录</span>
          <i class="fa-solid fa-filter" title="筛选"></i>
        </div>

        <!-- 树状列表 -->
        <div class="tree-list" @dragover.prevent>
          <div v-for="(folder, fIndex) in outlineTree" :key="folder.id" class="folder-group">
            <!-- 文件夹行 -->
            <div
class="tree-item folder"
              :class="{ 'drag-over': dragTarget?.id === folder.id && dragTarget?.type === 'folder' }" draggable="true"
              @click="toggleFolder(folder)" @contextmenu.prevent.stop="handleContextMenu($event, folder, 'folder')"
              @dragstart.stop="onDragStart($event, { type: 'folder', index: fIndex, item: folder })"
              @drop.stop="onDrop($event, { type: 'folder', index: fIndex, item: folder })" @dragover.prevent>
              <template v-if="editingFolderId === folder.id">
                <input
ref="editInputRef" type="text" v-model="editingFolderTitle" class="edit-input"
                  @blur="saveEditFolder(folder)" @keyup.enter="saveEditFolder(folder)" @keyup.esc="cancelEditFolder"
                  @click.stop />
              </template>
              <template v-else>
                <i :class="['fa-regular', folder.isOpen ? 'fa-folder-open' : 'fa-folder']"></i>
                <span class="item-text">{{ folder.title }}</span>
                <div class="item-actions">
                  <i
class="fa-solid fa-plus action-btn" @click.stop="handleAddOutlineToFolder(folder)"
                    title="新建大纲"></i>
                </div>
              </template>
            </div>

            <!-- 大纲列表 -->
            <div v-if="folder.isOpen" class="outline-list">
              <div
v-for="(item, iIndex) in folder.children" :key="item.id" class="tree-item child" :class="{
                'active': currentOutline?.id === item.id,
                'drag-over': dragTarget?.id === item.id && dragTarget?.type === 'file',
                'force-hover': contextMenu.visible && contextMenu.item?.id === item.id
              }" draggable="true" @click="selectOutline(item)" @dblclick.stop="startEdit(item)"
                @contextmenu.prevent.stop="handleContextMenu($event, item)"
                @dragstart.stop="onDragStart($event, { type: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @drop.stop="onDrop($event, { type: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @dragover.prevent>

                <template v-if="editingOutlineId === item.id">
                  <input
ref="editInputRef" type="text" v-model="editingTitle" class="edit-input" @blur="saveEdit(item)"
                    @keyup.enter="saveEdit(item)" @keyup.esc="cancelEdit" @click.stop />
                </template>
                <template v-else>
                  <i class="fa-regular fa-file-lines"></i>
                  <span class="item-text">{{ item.title }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部统计 -->
    <div class="panel-footer">
      <span v-if="currentOutline">字数: {{ getWordCount() }}</span>
    </div>

    <!-- 大纲右键菜单 -->
    <Teleport to="body">
      <div
v-if="contextMenu.visible" class="context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }" @click.stop @contextmenu.prevent.stop>
        <template v-if="contextMenu.type === 'folder'">
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-item" @click="handleMenuAction('new-outline')">新建大纲</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除分类</div>
        </template>
        <template v-else>
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-item" @click="handleMenuAction('link')">绑定章节</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除大纲</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { ref, watch, nextTick, onBeforeUnmount, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { useWritingEditorStore } from '@/stores/writing-editor'
import WangEditor from "@/components/WangEditor/index.vue"
// 开源版：大纲数据走本地参考库（IndexedDB），函数形状对齐原服务端接口，调用点不动
import {
  getLocalOutlineTree as getOutlineTreeApi,
  addLocalOutlineNode as addOutlineNodeApi,
  updateLocalOutlineNode as updateOutlineNodeApi,
  deleteLocalOutlineNodes as deleteOutlineNodeApi,
  updateLocalChapterSummary as updateChapterApi,
} from '@/storage/local-reference'
// 开源版：面板 AI 走本地 BYOK 直连（文本默认偏好模型）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { useAiModelStore } from '@/stores/ai-model'
import { buildRichTextPolishMessages } from '@/config/ai-prompts'
import { promptTemperature } from '@/storage/local-prompts'
import type { OutlineNode } from '@/types'

const store = useWritingEditorStore()
const aiModelStore = useAiModelStore()

const props = defineProps<{
  title: string
  bookId?: string | number
  panelMode?: 'side' | 'popout'
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'popout'): void
  (e: 'dock'): void
}>()

interface OutlineItem {
  id: string
  originId?: number
  title: string
  content: string
  type: 'file'
}

interface OutlineFolder {
  id: string
  originId?: number
  title: string
  children: OutlineItem[]
  type: 'folder'
  isOpen: boolean
  isVirtual?: boolean
}

interface DragData {
  type: 'folder' | 'file'
  index?: number
  fIndex?: number
  iIndex?: number
  item: OutlineFolder | OutlineItem
}

const searchText = ref('')
const outlineTree = ref<OutlineFolder[]>([])
const currentOutline = ref<OutlineItem | null>(null)
const activeOutlineId = ref<string | null>(null)

const editingOutlineId = ref<string | null>(null)
const editingTitle = ref('')
const editingFolderId = ref<string | null>(null)
const editingFolderTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  item: null as OutlineItem | OutlineFolder | null,
  type: 'file' as 'file' | 'folder'
})

const draggedItem = ref<DragData | null>(null)
const dragTarget = ref<OutlineFolder | OutlineItem | null>(null)
const isResizing = ref(false)
const startX = ref(0)
const startWidth = ref(0)

const wangEditorRef = ref<InstanceType<typeof WangEditor> | null>(null)
const isAiPolishing = ref(false)
const aiAbortController = ref<AbortController | null>(null)
const outlineUndoSnapshot = ref<{ outlineId: number; originalHtml: string } | null>(null)
let contentSaveTimer: number | null = null
let pendingContentSave: { id: number; content: string } | null = null
let titleSaveTimer: number | null = null
let titleSavePromise: Promise<boolean> | null = null
const pendingTitles = new Map<number, string>()
const syncedTitleById = new Map<number, string>()
const suppressAutoSave = ref(false)

// 避免富文本编辑器初始化/空内容归一化导致反复触发保存
const normalizeRichText = (html: unknown) => {
  const raw = String(html ?? '').trim()
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, '').toLowerCase()
  if (
    compact === '<p></p>' ||
    compact === '<p><br></p>' ||
    compact === '<p><br/></p>' ||
    compact === '<p><br/></p><p><br/></p>'
  ) {
    return ''
  }
  return raw
}

const syncedContentById = new Map<number, string>()
const sourceContentById = new Map<number, string>()

const normalizeId = (id?: number | string | null) => id !== undefined && id !== null ? String(id) : ''

const canUndoOutlinePolish = computed(() => {
  const snapshot = outlineUndoSnapshot.value
  return !!snapshot && currentOutline.value?.originId === snapshot.outlineId && !isAiPolishing.value
})

const createOutlineItem = (node: OutlineNode): OutlineItem => ({
  id: normalizeId(node.id) || `temp-${Date.now()}`,
  originId: typeof node.id === 'number' ? node.id : node.id ? Number(node.id) : undefined,
  title: node.title,
  content: node.content || '',
  type: 'file'
})

const createFolder = (node: OutlineNode): OutlineFolder => ({
  id: normalizeId(node.id),
  originId: typeof node.id === 'number' ? node.id : node.id ? Number(node.id) : undefined,
  title: node.title,
  type: 'folder' as const,
  isOpen: true,
  isVirtual: false,
  children: (node.children || []).filter(child => child.nodeType === 1).map(createOutlineItem)
})

const createVirtualFolder = (children: OutlineItem[] = []) => ({
  id: 'virtual-default',
  title: '默认分类',
  type: 'folder' as const,
  isOpen: true,
  isVirtual: true,
  children
})

const flattenNodes = (nodes: OutlineNode[] = []) => {
  const queue = [...nodes]
  const folders: OutlineNode[] = []
  const leaves: OutlineNode[] = []
  while (queue.length) {
    const node = queue.shift()!
    if (node.nodeType === 0) {
      folders.push(node)
      ;(node.children || []).forEach(child => {
        if (child.nodeType === 0) {
          queue.push(child)
        }
      })
    } else {
      leaves.push(node)
    }
  }
  return { folders, leaves }
}

const restoreSelection = () => {
  if (activeOutlineId.value) {
    const found = findOutlineById(activeOutlineId.value)
    if (found) {
      if (outlineUndoSnapshot.value?.outlineId !== found.originId) {
        outlineUndoSnapshot.value = null
      }
      suppressAutoSave.value = true
      currentOutline.value = found
      activeOutlineId.value = found.id
      nextTick(() => {
        suppressAutoSave.value = false
      })
      return
    }
  }
  const fallback = outlineTree.value.find(folder => folder.children.length > 0)?.children[0] || null
  if (outlineUndoSnapshot.value?.outlineId !== fallback?.originId) {
    outlineUndoSnapshot.value = null
  }
  suppressAutoSave.value = true
  currentOutline.value = fallback || null
  activeOutlineId.value = fallback ? fallback.id : null
  nextTick(() => {
    suppressAutoSave.value = false
  })
}

const findOutlineById = (id: string | number) => {
  const key = String(id)
  for (const folder of outlineTree.value) {
    const match = folder.children.find(child => String(child.id) === key)
    if (match) return match
  }
  return null
}

const buildOutlineTree = (nodes: OutlineNode[]) => {
  const { folders, leaves } = flattenNodes(nodes)
  const tree: OutlineFolder[] = folders.map(createFolder)
  if (leaves.length) {
    tree.unshift(createVirtualFolder(leaves.map(createOutlineItem)))
  }
  if (!tree.length) {
    tree.push(createVirtualFolder())
  }
  outlineTree.value = tree
  syncedContentById.clear()
  sourceContentById.clear()
  syncedTitleById.clear()
  for (const folder of tree) {
    for (const item of folder.children) {
      if (typeof item.originId === 'number' && Number.isFinite(item.originId)) {
        syncedContentById.set(item.originId, normalizeRichText(item.content))
        sourceContentById.set(item.originId, item.content || '')
        syncedTitleById.set(item.originId, item.title)
      }
    }
  }
  restoreSelection()
}

const ensureBookContext = () => {
  if (!props.bookId) {
    ElMessage.warning('请先选择要编辑的作品')
    return false
  }
  return true
}

const fetchOutlineTree = async () => {
  if (!props.bookId) return
  if ((pendingTitles.size || titleSavePromise || pendingContentSave) && !(await flushPendingSave())) return
  try {
    const { data } = await getOutlineTreeApi({ bookId: String(props.bookId) })
    buildOutlineTree(data || [])
  } catch (error) {
    console.error('加载大纲失败:', error)
  }
}

watch(
  () => props.bookId,
  (bookId) => {
    outlineTree.value = []
    currentOutline.value = null
    activeOutlineId.value = null
    outlineUndoSnapshot.value = null
    if (bookId) {
      fetchOutlineTree()
    }
  },
  { immediate: true }
)

watch(
  () => currentOutline.value?.content,
  () => {
    const outline = currentOutline.value
    const originId = outline?.originId
    if (!originId || !props.bookId) return
    if (suppressAutoSave.value) return

    const normalized = normalizeRichText(outline?.content)
    const synced = syncedContentById.get(originId)
    if (synced !== undefined && normalized === synced) return

    if (contentSaveTimer) {
      window.clearTimeout(contentSaveTimer)
    }
    pendingContentSave = { id: originId, content: outline?.content ?? '' }
    contentSaveTimer = window.setTimeout(() => {
      void flushPendingContentSave()
    }, 800)
  }
)

const flushPendingContentSave = async () => {
  if (contentSaveTimer) {
    window.clearTimeout(contentSaveTimer)
    contentSaveTimer = null
  }
  const payload = pendingContentSave
  if (!payload) return true
  pendingContentSave = null
  try {
    await updateOutlineNodeApi({
      id: payload.id,
      content: payload.content
    }, { content: sourceContentById.get(payload.id) })
    sourceContentById.set(payload.id, payload.content)
    syncedContentById.set(payload.id, normalizeRichText(payload.content))
    return true
  } catch (error) {
    console.error('同步大纲内容失败:', error)
    if (!pendingContentSave) pendingContentSave = payload
    ElMessage.error(error instanceof Error ? error.message : '保存失败，当前编辑内容已保留')
    return false
  }
}

const queueTitleSave = (item: OutlineItem, value: string) => {
  const id = item.originId
  if (id == null) return
  const title = value.trim()
  if (!title) {
    pendingTitles.delete(id)
    return
  }
  if (title === syncedTitleById.get(id) && !pendingTitles.has(id) && !titleSavePromise) return
  pendingTitles.set(id, title)
  if (titleSaveTimer) window.clearTimeout(titleSaveTimer)
  titleSaveTimer = window.setTimeout(() => { void flushPendingTitles() }, 800)
}

// 按节点保留待保存标题并串行写入，避免切换节点丢失修改、旧请求覆盖较新的名称。
const flushPendingTitles = (): Promise<boolean> => {
  if (titleSaveTimer) {
    window.clearTimeout(titleSaveTimer)
    titleSaveTimer = null
  }
  if (titleSavePromise) return titleSavePromise.then(saved => saved && pendingTitles.size ? flushPendingTitles() : saved)
  titleSavePromise = (async () => {
    while (pendingTitles.size) {
      const [id, title] = pendingTitles.entries().next().value as [number, string]
      pendingTitles.delete(id)
      try {
        await updateOutlineNodeApi({ id, title }, { title: syncedTitleById.get(id) })
        syncedTitleById.set(id, title)
      } catch (error) {
        if (!pendingTitles.has(id)) pendingTitles.set(id, title)
        console.error('保存大纲标题失败:', error)
        ElMessage.error('大纲标题保存失败，请重试')
        return false
      }
    }
    return true
  })().finally(() => { titleSavePromise = null })
  return titleSavePromise.then(saved => saved && pendingTitles.size ? flushPendingTitles() : saved)
}

const handleTitleInput = (event: Event) => {
  if ((event as InputEvent).isComposing || !currentOutline.value) return
  queueTitleSave(currentOutline.value, (event.target as HTMLInputElement).value)
}

const finalizeCurrentTitle = () => {
  const item = currentOutline.value
  if (!item || item.originId == null) return
  item.title = item.title.trim() || syncedTitleById.get(item.originId) || '新大纲'
  queueTitleSave(item, item.title)
}

const commitCurrentTitle = (event?: Event) => {
  if ((event as KeyboardEvent | undefined)?.isComposing) return
  finalizeCurrentTitle()
  return flushPendingTitles()
}

const flushPendingSave = async () => {
  finalizeCurrentTitle()
  const [titleSaved, contentSaved] = await Promise.all([flushPendingTitles(), flushPendingContentSave()])
  return titleSaved && contentSaved
}

const handlePopout = async () => {
  if (!(await flushPendingSave())) return
  emit('popout')
}

const handleDock = async () => {
  if (!(await flushPendingSave())) return
  emit('dock')
}

const handleClose = async () => {
  if (!(await flushPendingSave())) return
  emit('close')
}

const selectOutline = (item: OutlineItem) => {
  // 先捕获旧节点的保存内容，再立即切换界面；待保存标题按节点独立排队。
  if (currentOutline.value?.id !== item.id) void flushPendingSave()
  if (outlineUndoSnapshot.value?.outlineId !== item.originId) {
    outlineUndoSnapshot.value = null
  }
  currentOutline.value = item
  activeOutlineId.value = item.id
}

const getWordCount = () => {
  if (!currentOutline.value?.content) return 0
  const editor = wangEditorRef.value?.editor
  if (editor && typeof editor.getText === 'function') {
    return editor.getText().replace(/\n|\r/g, '').length
  }
  return currentOutline.value.content.replace(/<[^>]+>/g, '').length
}

const startEdit = (item: OutlineItem) => {
  editingFolderId.value = null
  editingOutlineId.value = item.id
  editingTitle.value = item.title
  nextTick(() => {
    const input = Array.isArray(editInputRef.value) ? editInputRef.value[0] : editInputRef.value
    input?.focus()
    input?.select()
  })
}

const saveEdit = async (item: OutlineItem) => {
  if (!editingOutlineId.value || !item.originId) return
  const newTitle = editingTitle.value.trim()
  if (!newTitle) {
    cancelEdit()
    return
  }
  item.title = newTitle
  queueTitleSave(item, newTitle)
  if (await flushPendingTitles()) {
    activeOutlineId.value = item.id
    cancelEdit()
  }
}

const cancelEdit = () => {
  editingOutlineId.value = null
  editingTitle.value = ''
}

const startEditFolder = (folder: OutlineFolder) => {
  editingOutlineId.value = null
  if (folder.isVirtual) {
    ElMessage.warning('默认分组不可重命名')
    return
  }
  editingFolderId.value = folder.id
  editingFolderTitle.value = folder.title
  nextTick(() => {
    const input = Array.isArray(editInputRef.value) ? editInputRef.value[0] : editInputRef.value
    input?.focus()
    input?.select()
  })
}

const saveEditFolder = async (folder: OutlineFolder) => {
  if (!editingFolderId.value || !folder.originId) return
  const newTitle = editingFolderTitle.value.trim()
  if (!newTitle || newTitle === folder.title) {
    cancelEditFolder()
    return
  }
  try {
    await updateOutlineNodeApi({ id: folder.originId, title: newTitle })
    folder.title = newTitle
  } catch (error) {
    console.error('更新文件夹失败:', error)
  } finally {
    cancelEditFolder()
  }
}

const cancelEditFolder = () => {
  editingFolderId.value = null
  editingFolderTitle.value = ''
}

const closeContextMenu = () => {
  contextMenu.value.visible = false
  document.removeEventListener('click', closeContextMenu)
}

const handleContextMenu = (event: MouseEvent, item: OutlineItem | OutlineFolder, type: 'file' | 'folder' = 'file') => {
  event.preventDefault()
  event.stopPropagation()
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    item,
    type
  }
  setTimeout(() => document.addEventListener('click', closeContextMenu), 0)
}

const confirmDeleteNode = async (ids: number[]) => {
  await inkConfirm('确定删除该条目吗？删除后可重新创建。', '提示', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  })
  if (!(await flushPendingSave())) return
  await deleteOutlineNodeApi({ ids })
  await fetchOutlineTree()
}

const handleMenuAction = (action: string) => {
  const { item, type } = contextMenu.value
  if (!item) return
  if (action === 'rename') {
    type === 'file' ? startEdit(item as OutlineItem) : startEditFolder(item as OutlineFolder)
  } else if (action === 'delete') {
    if (type === 'folder') {
      const folder = item as OutlineFolder
      if (folder.isVirtual || !folder.originId) {
        ElMessage.warning('默认分组无法删除')
      } else {
        confirmDeleteNode([folder.originId])
      }
    } else {
      const outline = item as OutlineItem
      if (outline.originId) {
        confirmDeleteNode([outline.originId])
      }
    }
  } else if (action === 'new-outline' && type === 'folder') {
    handleAddOutlineToFolder(item as OutlineFolder)
  } else if (action === 'link' && type === 'file') {
    void bindOutlineToCurrentChapter(item as OutlineItem)
  }
  closeContextMenu()
}

const bindOutlineToCurrentChapter = async (outline: OutlineItem) => {
  const chapterId = Number(store.activeChapterId || 0)
  if (!chapterId) {
    ElMessage.warning('请先在左侧目录选择一个章节')
    return
  }
  const summary = htmlToPlainText(outline.content || '').trim()
  if (!summary) {
    ElMessage.warning('当前大纲内容为空，无法绑定')
    return
  }
  await updateChapterApi({
    id: chapterId,
    summary,
  })
  ElMessage.success('已将当前大纲绑定到章节摘要')
}

const toggleFolder = (folder: OutlineFolder) => {
  folder.isOpen = !folder.isOpen
}

const getFolderParentId = (folder: OutlineFolder) => folder.isVirtual ? '0' : folder.id

const handleAddFolder = async () => {
  if (!ensureBookContext()) return
  try {
    await addOutlineNodeApi({
      bookId: String(props.bookId),
      parentId: '0',
      nodeType: 0,
      title: '新建文件夹',
      content: '',
      sortNo: outlineTree.value.filter(folder => !folder.isVirtual).length + 1
    })
    ElMessage.success('文件夹创建成功')
    await fetchOutlineTree()
  } catch (error) {
    console.error('新增文件夹失败:', error)
  }
}

const handleAddOutline = async () => {
  if (!outlineTree.value.length) {
    await handleAddFolder()
  }
  const targetFolder = outlineTree.value.find(folder => !folder.isVirtual) || outlineTree.value[0]
  if (targetFolder) {
    await handleAddOutlineToFolder(targetFolder)
  }
}

const handleAddOutlineToFolder = async (folder: OutlineFolder) => {
  if (!ensureBookContext()) return
  try {
    const { data } = await addOutlineNodeApi({
      bookId: String(props.bookId),
      parentId: getFolderParentId(folder),
      nodeType: 1,
      title: '新大纲',
      content: '<p></p>',
      sortNo: folder.children.length + 1
    })
    activeOutlineId.value = normalizeId(data.id)
    folder.isOpen = true
    await fetchOutlineTree()
    ElMessage.success('大纲创建成功')
  } catch (error) {
    console.error('新增大纲失败:', error)
  }
}

const persistFolderOrder = async () => {
  if (!props.bookId) return
  const tasks = outlineTree.value
    .filter(folder => !folder.isVirtual && folder.originId)
    .map((folder, index) => updateOutlineNodeApi({ id: folder.originId!, sortNo: index + 1 }))
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const persistOutlineOrder = async (folder: OutlineFolder) => {
  if (!props.bookId) return
  const tasks = folder.children
    .filter(item => item.originId)
    .map((item, index) => updateOutlineNodeApi({ id: item.originId!, sortNo: index + 1 }))
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const htmlToPlainText = (html: string) => {
  if (!html) return ''
  if (typeof window !== 'undefined') {
    const div = document.createElement('div')
    div.innerHTML = html
    return div.textContent || div.innerText || ''
  }
  return html.replace(/<[^>]+>/g, '')
}

const setOutlineEditorHtml = (html: string) => {
  // expose 的 editor 运行时已被 Vue 解包；保留双取兼容历史形态，按记录型透传
  const editorExpose = wangEditorRef.value?.editor as JsonRecord | null | undefined
  const editor = editorExpose?.value || editorExpose
  if (editor && typeof editor.setHtml === 'function') {
    editor.setHtml(html)
  }
}

const handleAiPolish = async () => {
  if (!currentOutline.value) {
    ElMessage.warning('请先选择需要润色的大纲')
    return
  }
  if (!ensureBookContext()) return
  if (isAiPolishing.value) {
    ElMessage.warning('AI 正在处理中，请稍候...')
    return
  }
  const plainText = htmlToPlainText(currentOutline.value.content || '')
  if (!plainText.trim()) {
    ElMessage.warning('请输入大纲内容后再润色')
    return
  }
  const outlineId = currentOutline.value.originId
  if (!outlineId) {
    ElMessage.warning('请先保存大纲后再润色')
    return
  }
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  isAiPolishing.value = true
  if (aiAbortController.value) {
    aiAbortController.value.abort()
  }
  const controller = new AbortController()
  aiAbortController.value = controller
  try {
    const data = await requestLocalChatCompletion({
      scene: 'outline_polish',
      sceneLabel: '大纲润色',
      modelCode,
      temperature: promptTemperature('reference-polish', 'outlineTask'),
      messages: buildRichTextPolishMessages({ kind: 'outline', selection: plainText }),
      signal: controller.signal
    })
    const polished = (data || '').trim()
    if (!polished) {
      throw new Error('AI 暂无返回内容')
    }
    if (currentOutline.value?.originId !== outlineId) {
      ElMessage.warning('已切换大纲，本次润色结果未应用')
      return
    }
    outlineUndoSnapshot.value = {
      outlineId,
      originalHtml: currentOutline.value.content || ''
    }
    const html = polished || '<p></p>'
    setOutlineEditorHtml(html)
    currentOutline.value.content = html
    ElMessage.success('AI 已完成润色')
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('AI润色失败:', error)
    ElMessage.error(String(error?.message || 'AI润色失败，请稍后重试'))
  } finally {
    if (aiAbortController.value === controller) {
      aiAbortController.value = null
    }
    isAiPolishing.value = false
  }
}

const handleUndoOutlinePolish = async () => {
  const snapshot = outlineUndoSnapshot.value
  const outline = currentOutline.value
  if (!snapshot || !outline) return
  // 撤销前校验当前大纲，避免切换后恢复到其他条目。
  if (outline.originId !== snapshot.outlineId) {
    outlineUndoSnapshot.value = null
    ElMessage.warning('当前大纲已切换，无法撤销')
    return
  }
  suppressAutoSave.value = true
  try {
    setOutlineEditorHtml(snapshot.originalHtml)
    outline.content = snapshot.originalHtml
    pendingContentSave = { id: snapshot.outlineId, content: snapshot.originalHtml }
    if (await flushPendingSave()) {
      outlineUndoSnapshot.value = null
      ElMessage.success('已撤销本次润色')
    }
  } finally {
    suppressAutoSave.value = false
  }
}

const moveOutlineToFolder = async (item: OutlineItem, folder: OutlineFolder) => {
  if (!props.bookId || !item.originId) return
  try {
    await updateOutlineNodeApi({
      id: item.originId,
      parentId: getFolderParentId(folder)
    })
  } catch (error) {
    console.error('移动大纲失败:', error)
  }
}

const onDragStart = (e: DragEvent, data: DragData) => {
  draggedItem.value = data
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
  }
}

const onDrop = async (_e: DragEvent, target: DragData) => {
  dragTarget.value = null
  const source = draggedItem.value
  if (!source) return

  if (source.type === target.type) {
    if (source.type === 'folder' && typeof source.index === 'number' && typeof target.index === 'number') {
      const item = outlineTree.value.splice(source.index, 1)[0]
      outlineTree.value.splice(target.index, 0, item)
      await persistFolderOrder()
    } else if (
      source.type === 'file' &&
      typeof source.fIndex === 'number' &&
      typeof target.fIndex === 'number' &&
      typeof source.iIndex === 'number' &&
      typeof target.iIndex === 'number'
    ) {
      const sourceFolder = outlineTree.value[source.fIndex]
      const targetFolder = outlineTree.value[target.fIndex]
      const item = sourceFolder.children.splice(source.iIndex, 1)[0]
      targetFolder.children.splice(target.iIndex, 0, item)
      if (currentOutline.value?.id === item.id) {
        selectOutline(item)
      }
      await moveOutlineToFolder(item, targetFolder)
      await persistOutlineOrder(targetFolder)
    }
  } else if (
    source.type === 'file' &&
    target.type === 'folder' &&
    typeof source.fIndex === 'number' &&
    typeof source.iIndex === 'number' &&
    typeof target.index === 'number'
  ) {
    const sourceFolder = outlineTree.value[source.fIndex]
    const targetFolder = outlineTree.value[target.index]
    const item = sourceFolder.children.splice(source.iIndex, 1)[0]
    targetFolder.children.push(item)
    targetFolder.isOpen = true
    if (currentOutline.value?.id === item.id) {
      selectOutline(item)
    }
    await moveOutlineToFolder(item, targetFolder)
    await persistOutlineOrder(targetFolder)
  }

  draggedItem.value = null
}

const startResize = (e: MouseEvent) => {
  e.preventDefault()
  isResizing.value = true
  startX.value = e.clientX
  startWidth.value = store.outlineTreeWidth
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isResizing.value) return
  const diff = startX.value - e.clientX
  const newWidth = startWidth.value + diff
  if (newWidth >= 150 && newWidth <= 600) {
    store.setOutlineTreeWidth(newWidth)
  }
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onBeforeUnmount(() => {
  closeContextMenu()
  void flushPendingSave()
  if (aiAbortController.value) {
    aiAbortController.value.abort()
  }
})

defineExpose({
  flushPendingSave
})
</script>

<style scoped lang="scss">
.panel-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 320px;
  background: transparent;

  &.resizing * {
    transition: none !important;
  }

  .panel-header {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-bottom: 1px solid rgba(128, 128, 128, 0.05);
    background: var(--panel-header-bg);

    .panel-title {
      font-weight: bold;
      font-size: calc(14px * var(--ui-font-scale, 1));
      color: var(--ink-main);
    }

    .panel-actions {
      display: flex;
      gap: 12px;

      .action-icon {
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: calc(12px * var(--ui-font-scale, 1));
        color: var(--ink-sec);
        opacity: 0.6;
        cursor: pointer;
        transition: all 0.3s ease;

        &:hover {
          opacity: 1;
          color: var(--ink-main);
        }
      }
    }
  }

  .panel-body {
    flex: 1;
    display: flex;
    overflow: hidden;
    position: relative;

    .resize-handle {
      width: 2px;
      cursor: col-resize;
      transition: background-color 0.2s;
      background: transparent;
      z-index: 10;
      height: 100%;
      margin: 0 -2px;
      /* 增加点击区域但不占用布局空间 */

      &:hover,
      &.active {
        background-color: var(--ink-accent);
      }
    }

    .detail-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0;
      background: var(--panel-bg);

      &.empty-state {
        align-items: center;
        justify-content: center;
        color: var(--ink-sec);
        font-size: calc(14px * var(--ui-font-scale, 1));
      }

      .section-header {
        display: flex;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.1);
        gap: 8px;

        .title-input {
          flex: 1;
          border: none;
          background: transparent;
          font-size: calc(16px * var(--ui-font-scale, 1));
          font-weight: bold;
          color: var(--ink-main);
          outline: none;
          padding: 4px 0;
          font-family: inherit;

          &::placeholder {
            color: var(--ink-sec);
            opacity: 0.5;
            font-weight: normal;
          }

          &:focus {
            border-bottom: 1px solid var(--ink-accent);
          }
        }

        i {
          font-size: calc(12px * var(--ui-font-scale, 1));
          color: var(--ink-sec);
          cursor: pointer;
        }
      }

      .editor-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px 8px;
        color: var(--ink-sec);

        .ai-action-group {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .ai-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 4px;
          border: none;
          font-size: calc(12px * var(--ui-font-scale, 1));
          cursor: pointer;
          background: rgba(180, 83, 9, 0.1);
          color: var(--ink-accent);
          transition: all 0.2s;

          &:hover {
            background: rgba(180, 83, 9, 0.2);
          }

          &.loading {
            cursor: wait;
          }

          &:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          i {
            font-size: calc(12px * var(--ui-font-scale, 1));
          }
        }
      }

      .editor-container {
        flex: 1;
        overflow-y: auto;
        padding: 0 16px 16px;
      }
    }

    .outline-tree {
      border-left: 1px solid rgba(128, 128, 128, 0.05);
      background: var(--tree-bg);
      display: flex;
      flex-direction: column;
      /* 宽度由 style 控制 */

      .tree-header {
        display: flex;
        gap: 6px;
        padding: 8px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.05);
        align-items: center;

        .search-wrapper {
          position: relative;
          flex: 1;

          .tree-search {
            width: 100%;
            padding: 4px 24px 4px 8px;
            font-size: calc(12px * var(--ui-font-scale, 1));
            border: 1px solid var(--input-border);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--ink-main);
            height: 26px;

            &::placeholder {
              color: var(--ink-sec);
              opacity: 0.5;
            }

            &:focus {
              background: var(--input-focus-bg);
              outline: none;
              border-color: var(--ink-accent);
            }
          }

          .search-icon {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            font-size: calc(10px * var(--ui-font-scale, 1));
            color: var(--ink-sec);
            opacity: 0.5;
          }
        }

        .add-button {
          background: none;
          border: none;
          color: var(--ink-sec);
          font-size: calc(14px * var(--ui-font-scale, 1));
          cursor: pointer;
          transition: color 0.3s ease;

          &:hover {
            color: var(--ink-main);
          }
        }
      }

      .tree-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        font-size: calc(12px * var(--ui-font-scale, 1));
        color: var(--ink-sec);
        opacity: 0.8;
        background: rgba(0, 0, 0, 0.02);

        i {
          cursor: pointer;

          &:hover {
            color: var(--ink-main);
          }
        }
      }

      .tree-list {
        flex: 1;
        overflow-y: auto;
        font-size: calc(13px * var(--ui-font-scale, 1));
        padding: 4px 0;

        .tree-item {
          padding: 10px 16px;
          color: var(--ink-sec);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s ease;
          border: 1px solid transparent;
          margin: 0;
          position: relative;
          z-index: 1;

          // 背景动画
          &::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 0;
            height: 100%;
            background: var(--nav-active-bg, rgba(0, 0, 0, 0.05));
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
            background: var(--active-bar-color, var(--ink-main));
            transform: translateY(-50%);
            transition: height 0.3s ease;
            z-index: -1;
          }

          // 悬浮或激活时展开背景
          &:hover::before,
          &.active::before,
          &.drag-over::before {
            width: 100%;
          }

          // 激活时展开左侧条
          &.active::after {
            height: 100%;
          }

          .item-text {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--ink-main);
            font-size: calc(14px * var(--ui-font-scale, 1));
          }

          .edit-input {
            flex: 1;
            width: 0;
            height: 28px;
            line-height: calc(28px * var(--ui-font-scale, 1));
            padding: 0 8px;
            font-size: calc(14px * var(--ui-font-scale, 1));
            color: var(--ink-main);
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            box-sizing: border-box;
            outline: none;
            transition: all 0.2s;
            margin-right: 8px;
            font-family: inherit;

            &:focus {
              background: var(--input-focus-bg);
              border-color: var(--input-focus-border);
            }
          }

          .item-actions {
            display: none;
            gap: 4px;

            .action-btn {
              padding: 2px;
              border-radius: 2px;
              font-size: calc(12px * var(--ui-font-scale, 1));
              color: var(--ink-sec);

              &:hover {
                background: var(--overlay-active);
                color: var(--ink-main);
              }
            }
          }

          &:hover {
            // background: rgba(0,0,0,0.03); // Removed in favor of ::before
            color: var(--ink-main);

            .item-actions {
              display: flex;
            }
          }

          &.drag-over {

            // border-color: var(--ink-accent); // Removed
            // background: rgba(180, 83, 9, 0.05); // Removed
            &::before {
              background: var(--nav-hover-bg, rgba(0, 0, 0, 0.03)); // Use hover bg for drag over
            }
          }

          &.folder {
            font-weight: 500;
            margin-top: 0;

            i {
              color: var(--ink-sec);
              font-size: calc(14px * var(--ui-font-scale, 1));
            }

            .item-text {
              font-weight: 600;
            }
          }

          &.child {
            padding-left: 32px;
            font-size: calc(14px * var(--ui-font-scale, 1));

            &.active {
              // background: var(--tree-active-bg, rgba(180, 83, 9, 0.08)); // Removed
              // color: var(--ink-accent); // Removed
              font-weight: normal;

              i {
                color: var(--ink-main);
              }

              // Match sidebar active style
            }
          }
        }
      }
    }
  }



  .panel-footer {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 12px;
    font-size: calc(11px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    background: var(--panel-footer-bg);
    border-top: 1px solid rgba(128, 128, 128, 0.05);
    font-family: system-ui, sans-serif;
  }
}

.context-menu {
  position: fixed;
  z-index: 99999;
  min-width: 160px;
  background: var(--ui-glass-bg);
  backdrop-filter: blur(8px);
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow);
  border-radius: 8px;
  padding: 6px 0;
  font-size: calc(14px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  animation: fadeIn 0.2s ease;

  .menu-divider {
    height: 1px;
    background: var(--ui-border-hover);
    margin: 4px 0;
  }

  .menu-item {
    padding: 6px 16px;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;

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
</style>
