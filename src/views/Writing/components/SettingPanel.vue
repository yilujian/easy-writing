<template>
  <div class="panel-content reference-panel-content" :class="{ 'resizing': isResizing }">
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

    <div class="panel-body">
      <div class="detail-content" v-if="currentSetting">
        <div class="section-header">
          <input
v-model="currentSetting.name" class="title-input" placeholder="输入设定名称..."
            @blur="saveCurrentSetting(true)" />
          <i class="fa-solid fa-edit"></i>
        </div>

        <div class="setting-form">
          <div class="form-item">
            <label>设定类型</label>
            <el-select
v-model="currentSetting.type" placeholder="请选择类型" class="ink-select" popper-class="ink-select-popper"
              @change="saveCurrentSetting(true)">
              <el-option
v-for="option in SETTING_TYPE_OPTIONS" :key="option.value" :value="option.value"
                :label="option.label" />
            </el-select>
          </div>
          <div class="form-item">
            <label>所属分组</label>
            <el-select
:model-value="groupSelectValue" placeholder="请选择分组" class="ink-select"
              popper-class="ink-select-popper" @change="handleGroupChange">
              <el-option v-for="option in folderOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
        </div>

        <div class="editor-toolbar">
          <span>设定详情</span>
          <div class="ai-action-group">
            <button
class="ai-btn" :class="{ loading: isAiGenerating }" :disabled="isAiGenerating"
              @click="handleAiGenerate">
              <i :class="['fa-solid', isAiGenerating ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
              {{ isAiGenerating ? '生成中...' : 'AI生成' }}
            </button>
            <button
v-if="canUndoSettingGenerate" class="ai-btn undo-btn" type="button" title="恢复 AI 生成前内容"
              @click="handleUndoSettingGenerate">
              <i class="fa-solid fa-rotate-left"></i>
              撤销
            </button>
          </div>
        </div>

        <div class="editor-container">
          <WangEditor
v-if="currentSetting" v-model:value="currentSetting.detail" ref="wangEditorRef"
            class="setting-editor" />
        </div>
      </div>
      <div class="detail-content empty-state" v-else>
        <p>请选择左侧设定进行编辑</p>
      </div>

      <div class="resize-handle" :class="{ active: isResizing }" @mousedown="startResize"></div>

      <div class="setting-tree border-gradient-l" :style="{ width: store.settingTreeWidth + 'px' }">
        <div class="tree-header">
          <div class="search-wrapper">
            <input type="text" placeholder="搜索设定..." class="tree-search" v-model="searchText">
            <i class="fa-solid fa-magnifying-glass search-icon"></i>
          </div>
          <button class="add-button" title="新建分组" @click="handleAddFolder">
            <i class="fa-solid fa-folder-plus"></i>
          </button>
          <button class="add-button" title="新建设定" style="margin-left: 4px;" @click="handleAddSetting">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>

        <div class="tree-toolbar">
          <span>设定分组</span>
          <i class="fa-solid fa-filter" title="筛选"></i>
        </div>

        <div class="tree-list" @dragover.prevent>
          <div v-for="(folder, fIndex) in settingTree" :key="folder.id" class="folder-group">
            <div
class="tree-item folder"
              :class="{
                'drag-over': dragTarget?.item?.id === folder.id && dragTarget?.kind === 'folder',
                'force-hover': contextMenu.visible && contextMenu.type === 'folder' && contextMenu.item?.id === folder.id
              }" draggable="true" @click="toggleFolder(folder)"
              @contextmenu.prevent.stop="handleContextMenu($event, folder, 'folder')"
              @dragstart.stop="onDragStart($event, { kind: 'folder', index: fIndex, item: folder })"
              @drop.stop="onDrop($event, { kind: 'folder', index: fIndex, item: folder })"
              @dragenter.prevent="markDragTarget({ kind: 'folder', item: folder })"
              @dragleave.prevent="markDragTarget(null)" @dragover.prevent>
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
                  <i class="fa-solid fa-plus action-btn" @click.stop="handleAddSettingToFolder(folder)" title="新建设定"></i>
                </div>
              </template>
            </div>

            <div v-if="folder.isOpen" class="setting-list">
              <div
v-for="(item, iIndex) in folder.children" :key="item.id" class="tree-item child" :class="{
                'active': currentSetting?.id === item.id,
                'drag-over': dragTarget?.item?.id === item.id && dragTarget?.kind === 'file',
                'force-hover': contextMenu.visible && contextMenu.type === 'file' && contextMenu.item?.id === item.id
              }" draggable="true" @click="selectSetting(item)" @dblclick.stop="startEdit(item)"
                @contextmenu.prevent.stop="handleContextMenu($event, item)"
                @dragstart.stop="onDragStart($event, { kind: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @drop.stop="onDrop($event, { kind: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @dragenter.prevent="markDragTarget({ kind: 'file', item })"
                @dragleave.prevent="markDragTarget(null)" @dragover.prevent>

                <template v-if="editingSettingId === item.id">
                  <input
ref="editInputRef" type="text" v-model="editingName" class="edit-input"
                    @blur="saveEdit(item)" @keyup.enter="saveEdit(item)" @keyup.esc="cancelEdit" @click.stop />
                </template>
                <template v-else>
                  <i class="fa-solid fa-bookmark"></i>
                  <span class="item-text">{{ item.name }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
v-if="contextMenu.visible" class="context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }" @click.stop @contextmenu.prevent.stop>
        <template v-if="contextMenu.type === 'folder'">
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-item" @click="handleMenuAction('new-setting')">新建设定</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除分组</div>
        </template>
        <template v-else>
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除设定</div>
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
import WangEditor from '@/components/WangEditor/index.vue'
// 开源版：设定数据走本地参考库（IndexedDB），函数形状对齐原服务端接口，调用点不动
import {
  getLocalWorldSettingTree as getWorldSettingTreeApi,
  addLocalWorldSetting as addWorldSettingApi,
  updateLocalWorldSetting as updateWorldSettingApi,
  deleteLocalWorldSettings as deleteWorldSettingApi,
  addLocalWorldSettingGroup as addWorldSettingGroupApi,
  updateLocalWorldSettingGroup as updateWorldSettingGroupApi,
  deleteLocalWorldSettingGroups as deleteWorldSettingGroupApi,
} from '@/storage/local-reference'
// 开源版：面板 AI 走本地 BYOK 直连（文本默认偏好模型）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { useAiModelStore } from '@/stores/ai-model'
import { buildRichTextPolishMessages } from '@/config/ai-prompts'
import { promptTemperature } from '@/storage/local-prompts'
import type { WorldSetting, WorldSettingTreeFolder } from '@/types'

const aiModelStore = useAiModelStore()

const store = useWritingEditorStore()

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
  (e: 'lore-updated'): void
}>()

interface SettingFolder {
  id: string
  originId?: number
  title: string
  children: SettingItem[]
  isOpen: boolean
  isVirtual?: boolean
}

interface SettingItem extends WorldSetting {
  nodeType: 'file'
  detail: string
}

interface DragData {
  kind: 'folder' | 'file'
  index?: number
  fIndex?: number
  iIndex?: number
  item: SettingFolder | SettingItem
}

const SETTING_TYPE_OPTIONS = [
  { label: '地理位置', value: 0 },
  { label: '势力宗门', value: 1 },
  { label: '功法技能', value: 2 },
  { label: '物品道具', value: 3 },
  { label: '等级体系', value: 4 },
  { label: '其他', value: 5 }
]

const searchText = ref('')
const wangEditorRef = ref()
const settingTree = ref<SettingFolder[]>([])
const currentSetting = ref<SettingItem | null>(null)
const activeSettingId = ref<number | null>(null)

const editingSettingId = ref<number | null>(null)
const editingName = ref('')
const editingFolderId = ref<string | null>(null)
const editingFolderTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  item: null as SettingFolder | SettingItem | null,
  type: 'file' as 'file' | 'folder'
})

const draggedItem = ref<DragData | null>(null)
const dragTarget = ref<DragData | null>(null)
const isResizing = ref(false)
const startX = ref(0)
const startWidth = ref(0)
const detailSaveTimer = ref<number | null>(null)
const suppressAutoSave = ref(false)
const isAiGenerating = ref(false)
const aiAbortController = ref<AbortController | null>(null)
const settingUndoSnapshot = ref<{ settingId: number; originalHtml: string } | null>(null)

const canUndoSettingGenerate = computed(() => {
  const snapshot = settingUndoSnapshot.value
  return !!snapshot && currentSetting.value?.id === snapshot.settingId && !isAiGenerating.value
})

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

const syncedDetailById = new Map<number, string>()
const settingBaselines = new Map<number, Partial<WorldSetting>>()

const normalizeId = (id: string | number) => String(id)

const folderOptions = computed(() => {
  const base = [{ label: '未分组', value: 'ungrouped' }]
  settingTree.value
    .filter(folder => !folder.isVirtual && folder.originId)
    .forEach(folder => {
      base.push({ label: folder.title, value: String(folder.originId) })
    })
  return base
})

const groupSelectValue = computed(() => {
  if (!currentSetting.value?.groupId) return 'ungrouped'
  return String(currentSetting.value.groupId)
})

const htmlToPlainText = (html: string) => {
  if (!html) return ''
  if (typeof window !== 'undefined') {
    const div = document.createElement('div')
    div.innerHTML = html
    return div.textContent || div.innerText || ''
  }
  return html.replace(/<[^>]+>/g, '')
}

const setSettingEditorHtml = (html: string) => {
  // expose 的 editor 运行时已被 Vue 解包；保留双取兼容历史形态，按记录型透传
  const editorExpose = wangEditorRef.value?.editor as JsonRecord | null | undefined
  const editor = editorExpose?.value || editorExpose
  if (editor && typeof editor.setHtml === 'function') {
    editor.setHtml(html)
  }
}

const getSettingTypeLabel = (value?: number | null) => {
  const target = SETTING_TYPE_OPTIONS.find(option => option.value === value)
  return target?.label || '其他'
}

const buildSettingTree = (data: WorldSettingTreeFolder[]) => {
  settingBaselines.clear()
  for (const folder of data) for (const item of folder.children || []) settingBaselines.set(item.id, JSON.parse(JSON.stringify(item)))
  syncedDetailById.clear()
  const folders: SettingFolder[] = data.map(folder => ({
    id: normalizeId(folder.id),
    originId: typeof folder.id === 'number' ? Number(folder.id) : undefined,
    title: folder.title,
    children: (folder.children || []).map(item => ({
      ...item,
      nodeType: 'file',
      name: item.name || '未命名设定',
      detail: item.detail || '',
      type: item.type ?? 5,
      groupId: item.groupId ?? null
    })),
    isOpen: true,
    isVirtual: folder.isVirtual || false
  }))
  folders.forEach(folder => {
    folder.children.forEach(item => {
      if (typeof item.id === 'number' && Number.isFinite(item.id)) {
        syncedDetailById.set(item.id, normalizeRichText(item.detail))
      }
    })
  })
  settingTree.value = folders
}

const fetchSettingTree = async () => {
  if (!props.bookId) return
  try {
    const { data } = await getWorldSettingTreeApi({ bookId: props.bookId })
    buildSettingTree(data || [])
    restoreSelection()
  } catch (error) {
    console.error('加载设定失败:', error)
  }
}

const restoreSelection = () => {
  if (activeSettingId.value) {
    const existing = findSettingById(activeSettingId.value)
    if (existing) {
      if (settingUndoSnapshot.value?.settingId !== existing.id) {
        settingUndoSnapshot.value = null
      }
      selectSetting(existing)
      return
    }
  }
  const fallback = settingTree.value.find(folder => folder.children.length)?.children[0] || null
  if (settingUndoSnapshot.value?.settingId !== fallback?.id) {
    settingUndoSnapshot.value = null
  }
  currentSetting.value = fallback
  activeSettingId.value = fallback?.id ?? null
}

const findSettingById = (id: number) => {
  for (const folder of settingTree.value) {
    const found = folder.children.find(child => child.id === id)
    if (found) return found
  }
  return null
}

watch(
  () => props.bookId,
  (bookId) => {
    settingTree.value = []
    currentSetting.value = null
    activeSettingId.value = null
    settingUndoSnapshot.value = null
    if (bookId) {
      fetchSettingTree()
    }
  },
  { immediate: true }
)

const ensureBookContext = () => {
  if (!props.bookId) {
    ElMessage.warning('请先选择要编辑的作品')
    return false
  }
  return true
}

const selectSetting = (item: SettingItem) => {
  if (settingUndoSnapshot.value?.settingId !== item.id) {
    settingUndoSnapshot.value = null
  }
  currentSetting.value = item
  activeSettingId.value = item.id
  suppressAutoSave.value = true
  nextTick(() => {
    suppressAutoSave.value = false
  })
}

const handleAddFolder = async () => {
  if (!ensureBookContext()) return
  try {
    const realCount = settingTree.value.filter(folder => !folder.isVirtual).length
    await addWorldSettingGroupApi({
      bookId: String(props.bookId),
      title: '新建分组',
      sortNo: realCount + 1
    })
    ElMessage.success('分组创建成功')
    await fetchSettingTree()
  } catch (error) {
    console.error('新增设定分组失败:', error)
  }
}

const handleAddSetting = async () => {
  if (!ensureBookContext()) return
  if (!settingTree.value.length) {
    await handleAddFolder()
  }
  const targetFolder = settingTree.value.find(folder => !folder.isVirtual) || settingTree.value[0]
  if (targetFolder) {
    await handleAddSettingToFolder(targetFolder)
  }
}

const handleAddSettingToFolder = async (folder: SettingFolder) => {
  if (!ensureBookContext()) return
  try {
    const { data } = await addWorldSettingApi({
      bookId: String(props.bookId),
      groupId: folder.isVirtual ? undefined : folder.originId,
      name: '新设定',
      type: 5,
      detail: '',
      sortNo: folder.children.length + 1
    })
    activeSettingId.value = data.id
    folder.isOpen = true
    await fetchSettingTree()
    ElMessage.success('设定创建成功')
    emit('lore-updated')
  } catch (error) {
    console.error('新增设定失败:', error)
  }
}

const startEdit = (item: SettingItem) => {
  editingFolderId.value = null
  editingSettingId.value = item.id
  editingName.value = item.name
  nextTick(() => {
    editInputRef.value?.focus()
    editInputRef.value?.select()
  })
}

const saveEdit = async (item: SettingItem) => {
  if (!editingSettingId.value) return
  const newName = editingName.value.trim()
  if (!newName || newName === item.name) {
    cancelEdit()
    return
  }
  try {
    await updateWorldSettingApi({ id: item.id, name: newName })
    item.name = newName
    emit('lore-updated')
  } catch (error) {
    console.error('重命名设定失败:', error)
  } finally {
    cancelEdit()
  }
}

const cancelEdit = () => {
  editingSettingId.value = null
  editingName.value = ''
}

const startEditFolder = (folder: SettingFolder) => {
  editingSettingId.value = null
  if (folder.isVirtual) {
    ElMessage.warning('该分组不可重命名')
    return
  }
  editingFolderId.value = folder.id
  editingFolderTitle.value = folder.title
  nextTick(() => {
    editInputRef.value?.focus()
    editInputRef.value?.select()
  })
}

const saveEditFolder = async (folder: SettingFolder) => {
  if (!editingFolderId.value || !folder.originId) return
  const newTitle = editingFolderTitle.value.trim()
  if (!newTitle || newTitle === folder.title) {
    cancelEditFolder()
    return
  }
  try {
    await updateWorldSettingGroupApi({ id: folder.originId, title: newTitle })
    folder.title = newTitle
  } catch (error) {
    console.error('更新分组失败:', error)
  } finally {
    cancelEditFolder()
  }
}

const cancelEditFolder = () => {
  editingFolderId.value = null
  editingFolderTitle.value = ''
}

const deleteSetting = async (item: SettingItem) => {
  try {
    await inkConfirm(`确定删除设定「${item.name}」吗？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await deleteWorldSettingApi({ ids: [item.id] })
    await fetchSettingTree()
    ElMessage.success('设定已删除')
    emit('lore-updated')
  } catch (error) {
    console.error('删除设定失败:', error)
  }
}

const deleteFolder = async (folder: SettingFolder) => {
  if (folder.isVirtual || !folder.originId) {
    ElMessage.warning('默认分组不可删除')
    return
  }
  try {
    await inkConfirm(`确定删除分组「${folder.title}」吗？组内设定将移动到未分组。`, '删除确认', {
      type: 'warning'
    })
  } catch {
    return
  }
  try {
    await deleteWorldSettingGroupApi({ ids: [folder.originId] })
    await fetchSettingTree()
    ElMessage.success('分组已删除')
    emit('lore-updated')
  } catch (error) {
    console.error('删除分组失败:', error)
  }
}

const toggleFolder = (folder: SettingFolder) => {
  folder.isOpen = !folder.isOpen
}

const persistFolderOrder = async () => {
  if (!props.bookId) return
  const tasks = settingTree.value
    .filter(folder => !folder.isVirtual && folder.originId)
    .map((folder, index) => updateWorldSettingGroupApi({ id: folder.originId!, sortNo: index + 1 }))
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const persistSettingOrder = async (folder: SettingFolder) => {
  if (!props.bookId) return
  const tasks = folder.children.map((child, index) =>
    updateWorldSettingApi({
      id: child.id,
      groupId: folder.isVirtual ? undefined : folder.originId,
      sortNo: index + 1
    })
  )
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const moveSettingToFolder = async (item: SettingItem, folder: SettingFolder) => {
  try {
    const targetGroupId = folder.isVirtual ? null : folder.originId
    // 同一分组内只更新排序，避免发送没有实际字段的移动请求。
    if (String(item.groupId ?? '') === String(targetGroupId ?? '')) return
    await updateWorldSettingApi({
      id: item.id,
      groupId: targetGroupId
    })
    item.groupId = targetGroupId ?? null
  } catch (error) {
    console.error('移动设定失败:', error)
  }
}

const onDragStart = (e: DragEvent, data: DragData) => {
  draggedItem.value = data
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.dropEffect = 'move'
  }
}

const markDragTarget = (data: DragData | null) => {
  dragTarget.value = data
}

const onDrop = async (_e: DragEvent, target: DragData) => {
  dragTarget.value = null
  const source = draggedItem.value
  if (!source) return

  if (source.kind === target.kind) {
    if (source.kind === 'folder' && typeof source.index === 'number' && typeof target.index === 'number') {
      const item = settingTree.value.splice(source.index, 1)[0]
      settingTree.value.splice(target.index, 0, item)
      await persistFolderOrder()
    } else if (
      source.kind === 'file' &&
      typeof source.fIndex === 'number' &&
      typeof target.fIndex === 'number' &&
      typeof source.iIndex === 'number' &&
      typeof target.iIndex === 'number'
    ) {
      const sourceFolder = settingTree.value[source.fIndex]
      const targetFolder = settingTree.value[target.fIndex]
      const item = sourceFolder.children.splice(source.iIndex, 1)[0]
      targetFolder.children.splice(target.iIndex, 0, item)
      if (currentSetting.value?.id === item.id) {
        selectSetting(item)
      }
      await moveSettingToFolder(item, targetFolder)
      await persistSettingOrder(targetFolder)
      emit('lore-updated')
    }
  } else if (
    source.kind === 'file' &&
    target.kind === 'folder' &&
    typeof source.fIndex === 'number' &&
    typeof source.iIndex === 'number' &&
    typeof target.index === 'number'
  ) {
    const sourceFolder = settingTree.value[source.fIndex]
    const targetFolder = settingTree.value[target.index]
    const item = sourceFolder.children.splice(source.iIndex, 1)[0]
    targetFolder.children.push(item)
    targetFolder.isOpen = true
    if (currentSetting.value?.id === item.id) {
      selectSetting(item)
    }
    await moveSettingToFolder(item, targetFolder)
    await persistSettingOrder(targetFolder)
    emit('lore-updated')
  }

  draggedItem.value = null
}

const handleContextMenu = (event: MouseEvent, item: SettingFolder | SettingItem, type: 'file' | 'folder' = 'file') => {
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

const closeContextMenu = () => {
  contextMenu.value.visible = false
  document.removeEventListener('click', closeContextMenu)
}

const handleMenuAction = async (action: string) => {
  const { item, type } = contextMenu.value
  if (!item) return
  if (action === 'rename') {
    type === 'file' ? startEdit(item as SettingItem) : startEditFolder(item as SettingFolder)
  } else if (action === 'delete') {
    if (type === 'file') {
      await deleteSetting(item as SettingItem)
    } else {
      await deleteFolder(item as SettingFolder)
    }
  } else if (action === 'new-setting' && type === 'folder') {
    await handleAddSettingToFolder(item as SettingFolder)
  }
  closeContextMenu()
}

const saveCurrentSetting = async (silent = false) => {
  if (!currentSetting.value) return false
  try {
    const payload = {
      id: currentSetting.value.id,
      name: currentSetting.value.name,
      detail: currentSetting.value.detail,
      type: currentSetting.value.type,
      groupId: currentSetting.value.groupId
    }
    await updateWorldSettingApi(payload, settingBaselines.get(payload.id))
    settingBaselines.set(payload.id, { ...settingBaselines.get(payload.id), ...payload })
    syncedDetailById.set(currentSetting.value.id, normalizeRichText(currentSetting.value.detail))
    emit('lore-updated')
    if (!silent) {
      ElMessage.success('设定已保存')
    }
    return true
  } catch (error) {
    console.error('保存设定失败:', error)
    if (!silent) {
      ElMessage.error(error instanceof Error && error.message ? error.message : '保存失败')
    }
    return false
  }
}

const flushPendingSave = async () => {
  if (detailSaveTimer.value) {
    window.clearTimeout(detailSaveTimer.value)
    detailSaveTimer.value = null
  }
  await saveCurrentSetting(true)
}

const handlePopout = async () => {
  await flushPendingSave()
  emit('popout')
}

const handleDock = async () => {
  await flushPendingSave()
  emit('dock')
}

const handleClose = async () => {
  await flushPendingSave()
  emit('close')
}

const scheduleDetailSave = () => {
  if (suppressAutoSave.value) return
  if (detailSaveTimer.value) {
    window.clearTimeout(detailSaveTimer.value)
  }
  const target = currentSetting.value
  if (!target) return
  const payload = {
    id: target.id,
    name: target.name,
    detail: target.detail,
    type: target.type,
    groupId: target.groupId
  }
  detailSaveTimer.value = window.setTimeout(async () => {
    try {
      await updateWorldSettingApi(payload, settingBaselines.get(payload.id))
      settingBaselines.set(payload.id, { ...settingBaselines.get(payload.id), ...payload })
      syncedDetailById.set(payload.id, normalizeRichText(payload.detail))
      emit('lore-updated')
    } catch (error) {
      console.error('保存设定失败:', error)
      ElMessage.error(error instanceof Error ? error.message : '保存失败，当前编辑内容已保留')
    }
    detailSaveTimer.value = null
  }, 600)
}

watch(
  () => currentSetting.value?.detail,
  () => {
    if (!currentSetting.value || suppressAutoSave.value) return
    const synced = syncedDetailById.get(currentSetting.value.id)
    const normalized = normalizeRichText(currentSetting.value.detail)
    if (synced !== undefined && normalized === synced) return
    scheduleDetailSave()
  }
)

const handleGroupChange = async (value: string) => {
  if (!currentSetting.value || !ensureBookContext()) return
  const normalized = value === 'ungrouped' ? null : Number(value)
  if (String(currentSetting.value.groupId ?? '') === String(normalized ?? '')) return
  try {
    await updateWorldSettingApi({
      id: currentSetting.value.id,
      groupId: normalized
    })
    currentSetting.value.groupId = normalized
    activeSettingId.value = currentSetting.value.id
    await fetchSettingTree()
    ElMessage.success('分组已更新')
    emit('lore-updated')
  } catch (error) {
    console.error('更新分组失败:', error)
  }
}

const handleAiGenerate = async () => {
  if (!currentSetting.value) {
    ElMessage.warning('请选择需要优化的设定')
    return
  }
  if (!ensureBookContext()) return
  if (isAiGenerating.value) {
    ElMessage.warning('AI 正在处理中，请稍候...')
    return
  }
  const settingId = currentSetting.value.id
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  const controller = new AbortController()
  if (aiAbortController.value) {
    aiAbortController.value.abort()
  }
  aiAbortController.value = controller
  isAiGenerating.value = true
  try {
    const selection = htmlToPlainText(currentSetting.value.detail || '')
    const typeLabel = getSettingTypeLabel(currentSetting.value.type)
    const data = await requestLocalChatCompletion({
      scene: 'setting_polish',
      sceneLabel: '设定润色',
      modelCode,
      temperature: promptTemperature('reference-polish', 'settingTask'),
      messages: buildRichTextPolishMessages({
        kind: 'setting',
        name: currentSetting.value.name || '未命名设定',
        typeLabel,
        selection
      }),
      signal: controller.signal
    })
    const html = (data || '').trim()
    if (!html) {
      throw new Error('AI 暂无返回内容')
    }
    if (currentSetting.value?.id !== settingId) {
      ElMessage.warning('已切换设定，本次生成结果未应用')
      return
    }
    settingUndoSnapshot.value = {
      settingId,
      originalHtml: currentSetting.value.detail || ''
    }
    suppressAutoSave.value = true
    try {
      setSettingEditorHtml(html)
      currentSetting.value.detail = html
      await saveCurrentSetting(true)
    } finally {
      suppressAutoSave.value = false
    }
    ElMessage.success(selection.trim() ? '设定已润色完成' : '已为您生成设定详情')
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('AI生成设定失败:', error)
    ElMessage.error(String(error?.message || 'AI生成失败，请稍后重试'))
  } finally {
    if (aiAbortController.value === controller) {
      aiAbortController.value = null
    }
    isAiGenerating.value = false
  }
}

const handleUndoSettingGenerate = async () => {
  const snapshot = settingUndoSnapshot.value
  const setting = currentSetting.value
  if (!snapshot || !setting) return
  // 撤销前校验当前设定，避免切换后恢复到其他设定。
  if (setting.id !== snapshot.settingId) {
    settingUndoSnapshot.value = null
    ElMessage.warning('当前设定已切换，无法撤销')
    return
  }
  suppressAutoSave.value = true
  try {
    setSettingEditorHtml(snapshot.originalHtml)
    setting.detail = snapshot.originalHtml
    if (await saveCurrentSetting(true)) {
      settingUndoSnapshot.value = null
      ElMessage.success('已撤销本次生成')
    }
  } finally {
    suppressAutoSave.value = false
  }
}

const startResize = (e: MouseEvent) => {
  e.preventDefault()
  isResizing.value = true
  startX.value = e.clientX
  startWidth.value = store.settingTreeWidth
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
    store.setSettingTreeWidth(newWidth)
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
  settingUndoSnapshot.value = null
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
}

.resize-handle {
  width: 2px;
  cursor: col-resize;
  transition: background-color 0.2s;
  background: transparent;
  z-index: 10;
  height: 100%;
  margin: 0 -2px;

  &:hover,
  &.active {
    background-color: var(--ink-accent);
  }
}

.setting-tree {
  border-left: 1px solid rgba(128, 128, 128, 0.05);
  background: var(--tree-bg);
  display: flex;
  flex-direction: column;

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
      padding: 0;

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

      &:hover::before,
      &.active::before,
      &.drag-over::before,
      &.force-hover::before {
        width: 100%;
      }

      &.active::after,
      &.force-hover::after {
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
        color: var(--ink-main);

        .item-actions {
          display: flex;
        }
      }

      &.folder {
        font-weight: 500;

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
          font-weight: normal;

          i {
            color: var(--ink-main);
          }
        }
      }
    }
  }
}

.detail-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  overflow: hidden;
  min-width: 0;

  &.empty-state {
    align-items: center;
    justify-content: center;
    color: var(--ink-sec);
    font-size: calc(14px * var(--ui-font-scale, 1));
  }
}

.section-header {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  display: flex;
  align-items: center;
  gap: 8px;

  .title-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: calc(16px * var(--ui-font-scale, 1));
    font-weight: bold;
    color: var(--ink-main);
    background: transparent;
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

.setting-form {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;

  .form-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;

    label {
      font-size: calc(13px * var(--ui-font-scale, 1));
      color: var(--ink-sec);
      font-weight: 500;
    }

    input,
    textarea {
      padding: 8px 12px;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--ink-main);
      font-size: calc(14px * var(--ui-font-scale, 1));
      transition: all 0.2s;
      outline: none;

      &:focus {
        background: var(--input-focus-bg);
        border-color: var(--ink-accent);
      }
    }

    textarea {
      resize: vertical;
      line-height: 1.6;
    }
  }
}

.editor-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px 8px;
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
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;

  .setting-editor {
    flex: 1;
    border-radius: 12px;
    overflow: hidden;
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
  font-size: calc(14px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  animation: fadeIn 0.2s ease;

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
