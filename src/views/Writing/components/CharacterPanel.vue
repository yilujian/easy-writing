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

    <!-- 资料 / 关系图 页签 -->
    <div class="character-tabs">
      <button
        v-for="tab in CHARACTER_TABS"
        :key="tab.value"
        type="button"
        :class="{ active: activeTab === tab.value }"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 关系画布（进入页签时挂载，自动带出最新角色清单） -->
    <CharacterRelationCanvas
      v-if="activeTab === 'graph'"
      :book-id="props.bookId"
      @characters-changed="handleCanvasCharactersChanged"
      @edit-character="handleCanvasEditCharacter"
    />

    <!-- 主体区域 -->
    <div v-show="activeTab === 'list'" class="panel-body">
      <!-- 详情内容 (表单) -->
      <div class="detail-content" v-if="currentCharacter">
        <div class="section-header">
          <input v-model="currentCharacter.name" class="title-input" placeholder="输入角色姓名..." @blur="saveCurrentCharacter" />
          <i class="fa-solid fa-edit"></i>
        </div>

        <div class="character-form-container">
          <div class="form-item">
            <label>别名</label>
            <CharacterAliasesInput
              :model-value="currentCharacter.aliases"
              :name="currentCharacter.name"
              :character-id="currentCharacter.id"
              :characters="characterTree.flatMap(folder => folder.children)"
              @update:model-value="saveCharacterAliases"
            />
          </div>
          <div class="form-item">
            <label>身份/角色</label>
            <el-select v-model="currentCharacter.role" placeholder="请选择" @change="saveCurrentCharacter" class="ink-select" popper-class="ink-select-popper">
              <el-option v-for="option in ROLE_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>

          <!-- <div class="form-row">
            <div class="form-item half">
              <label>年龄</label>
              <input type="text" v-model="currentCharacter.age" placeholder="例如：18岁" />
            </div>
            <div class="form-item half">
              <label>性别</label>
              <el-select v-model="currentCharacter.gender" placeholder="请选择">
                <el-option value="男">男</el-option>
                <el-option value="女">女</el-option>
              </el-select>
            </div>
          </div> -->

          <div class="form-item">
            <div class="label-row">
              <label>外貌特征</label>
              <div class="ai-action-group">
                <button class="ai-btn" :class="{ loading: aiPolishLoading.appearance }" :disabled="aiPolishLoading.appearance" @click="handleAiPolish('appearance')" title="AI 润色">
                  <i :class="['fa-solid', aiPolishLoading.appearance ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
                  {{ aiPolishLoading.appearance ? '润色中...' : 'AI润色' }}
                </button>
                <button
v-if="canUndoCharacterPolish('appearance')" class="ai-btn undo-btn" type="button"
                  title="恢复 AI 润色前内容" @click="handleUndoCharacterPolish('appearance')">
                  <i class="fa-solid fa-rotate-left"></i>
                  撤销
                </button>
              </div>
            </div>
            <textarea v-model="currentCharacter.appearance" rows="5" placeholder="描述角色的外貌特征..." @blur="saveCurrentCharacter"></textarea>
          </div>

          <div class="form-item">
            <div class="label-row">
              <label>性格特点</label>
              <div class="ai-action-group">
                <button class="ai-btn" :class="{ loading: aiPolishLoading.personality }" :disabled="aiPolishLoading.personality" @click="handleAiPolish('personality')" title="AI 润色">
                  <i :class="['fa-solid', aiPolishLoading.personality ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
                  {{ aiPolishLoading.personality ? '润色中...' : 'AI润色' }}
                </button>
                <button
v-if="canUndoCharacterPolish('personality')" class="ai-btn undo-btn" type="button"
                  title="恢复 AI 润色前内容" @click="handleUndoCharacterPolish('personality')">
                  <i class="fa-solid fa-rotate-left"></i>
                  撤销
                </button>
              </div>
            </div>
            <textarea v-model="currentCharacter.personality" rows="5" placeholder="描述角色的性格特点..." @blur="saveCurrentCharacter"></textarea>
          </div>

          <div class="form-item">
            <div class="label-row">
              <label>背景故事</label>
              <div class="ai-action-group">
                <button class="ai-btn" :class="{ loading: aiPolishLoading.background }" :disabled="aiPolishLoading.background" @click="handleAiPolish('background')" title="AI 润色">
                  <i :class="['fa-solid', aiPolishLoading.background ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
                  {{ aiPolishLoading.background ? '润色中...' : 'AI润色' }}
                </button>
                <button
v-if="canUndoCharacterPolish('background')" class="ai-btn undo-btn" type="button"
                  title="恢复 AI 润色前内容" @click="handleUndoCharacterPolish('background')">
                  <i class="fa-solid fa-rotate-left"></i>
                  撤销
                </button>
              </div>
            </div>
            <textarea v-model="currentCharacter.background" rows="6" placeholder="角色的生平经历、背景故事..." @blur="saveCurrentCharacter"></textarea>
          </div>
        </div>
      </div>
      <div class="detail-content empty-state" v-else>
        <p>请选择左侧角色进行编辑</p>
      </div>

      <!-- 拖拽手柄 -->
      <div class="resize-handle" :class="{ active: isResizing }" @mousedown="startResize"></div>

      <!-- 角色树 -->
      <div class="outline-tree border-gradient-l" :style="{ width: store.characterTreeWidth + 'px' }">
        <!-- 搜索栏 -->
        <div class="tree-header">
          <div class="search-wrapper">
            <input type="text" placeholder="搜索姓名或别名..." class="tree-search" v-model="searchText">
            <i class="fa-solid fa-magnifying-glass search-icon"></i>
          </div>
          <button class="add-button" title="新建分组" @click="handleAddFolder">
            <i class="fa-solid fa-folder-plus"></i>
          </button>
          <button class="add-button" title="新建角色" style="margin-left: 4px;" @click="handleAddCharacter">
            <i class="fa-solid fa-user-plus"></i>
          </button>
        </div>

        <div class="tree-toolbar">
          <span>角色列表</span>
          <i class="fa-solid fa-filter" title="筛选"></i>
        </div>

        <!-- 树状列表 -->
        <div class="tree-list" @dragover.prevent>
          <div v-for="(folder, fIndex) in filteredCharacterTree" :key="folder.id" class="folder-group">
            <!-- 文件夹行 -->
            <div
class="tree-item folder"
              :class="{
                'drag-over': dragTarget?.id === folder.id && dragTarget?.type === 'folder',
                'force-hover': contextMenu.visible && contextMenu.type === 'folder' && contextMenu.item?.id === folder.id
              }" :draggable="!searchText.trim()"
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
class="fa-solid fa-plus action-btn" @click.stop="handleAddCharacterToFolder(folder)"
                    title="新建角色"></i>
                </div>
              </template>
            </div>

            <!-- 角色列表 -->
            <div v-if="folder.isOpen || searchText.trim()" class="outline-list">
              <div
v-for="(item, iIndex) in visibleCharacters(folder)" :key="item.id" class="tree-item child" :class="{
                'active': currentCharacter?.id === item.id,
                'drag-over': dragTarget?.id === item.id && dragTarget?.type === 'file',
                'force-hover': contextMenu.visible && contextMenu.item?.id === item.id
              }" :draggable="!searchText.trim()" @click="selectCharacter(item)" @dblclick.stop="startEdit(item)"
                @contextmenu.prevent.stop="handleContextMenu($event, item)"
                @dragstart.stop="onDragStart($event, { type: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @drop.stop="onDrop($event, { type: 'file', fIndex: fIndex, iIndex: iIndex, item: item })"
                @dragover.prevent>

                <template v-if="editingCharacterId === item.id">
                  <input
ref="editInputRef" type="text" v-model="editingName" class="edit-input" @blur="saveEdit(item)"
                    @keyup.enter="saveEdit(item)" @keyup.esc="cancelEdit" @click.stop />
                </template>
                <template v-else>
                  <i class="fa-solid fa-user"></i>
                  <span class="item-text">{{ item.name }}</span>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 角色右键菜单 -->
    <Teleport to="body">
      <div
v-if="contextMenu.visible" class="context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }" @click.stop @contextmenu.prevent.stop>
        <div v-if="contextMenuMeta" class="menu-header">
          <div class="menu-title">{{ contextMenuMeta.title }}</div>
          <div v-if="contextMenuMeta.info" class="menu-info">{{ contextMenuMeta.info }}</div>
        </div>
        <div class="menu-divider" v-if="contextMenuMeta"></div>
        <template v-if="contextMenu.type === 'folder'">
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-item" @click="handleMenuAction('new-character')">新建角色</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除分组</div>
        </template>
        <template v-else>
          <div class="menu-item" @click="handleMenuAction('rename')">重命名</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" @click="handleMenuAction('delete')">删除角色</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import CharacterAliasesInput from '@/components/CharacterAliasesInput.vue'
import { getCharacterNames } from '@/utils/character-aliases'
import { ref, watch, nextTick, onBeforeUnmount, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { useWritingEditorStore } from '@/stores/writing-editor'
// 开源版：角色数据走本地参考库（IndexedDB），函数形状对齐原服务端接口，调用点不动
import {
  addLocalCharacter as addCharacterApi,
  updateLocalCharacter as updateCharacterApi,
  deleteLocalCharacters as deleteCharacterApi,
  listLocalCharacters as getCharacterListApi,
  listLocalCharacterGroups as listCharacterGroupApi,
  addLocalCharacterGroup as addCharacterGroupApi,
  updateLocalCharacterGroup as updateCharacterGroupApi,
  deleteLocalCharacterGroups as deleteCharacterGroupApi,
} from '@/storage/local-reference'
import type { Character, CharacterGroup } from '@/types'
// 开源版：面板 AI 走本地 BYOK 直连（文本默认偏好模型）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { useAiModelStore } from '@/stores/ai-model'
import { buildCharacterFieldMessages } from '@/config/ai-prompts'
import { promptTemperature } from '@/storage/local-prompts'

import CharacterRelationCanvas from './CharacterRelationCanvas.vue'

const store = useWritingEditorStore()
const aiModelStore = useAiModelStore()

const CHARACTER_TABS = [
  { label: '资料', value: 'list' },
  { label: '关系图', value: 'graph' },
] as const
const activeTab = ref<'list' | 'graph'>('list')

/** 画布上建/删了角色：资料树重载，实体高亮跟着刷新 */
const handleCanvasCharactersChanged = async () => {
  await fetchCharacterData()
  emit('lore-updated')
}

/** 画布「编辑资料」：切回资料页签并选中该角色 */
const handleCanvasEditCharacter = async (id: number) => {
  activeTab.value = 'list'
  await fetchCharacterData()
  for (const folder of characterTree.value) {
    const card = folder.children.find(item => Number(item.id) === Number(id))
    if (card) {
      folder.isOpen = true
      selectCharacter(card)
      return
    }
  }
}

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

const ROLE_OPTIONS = [
  { label: '主角', value: 0 },
  { label: '配角', value: 1 },
  { label: '反派', value: 2 },
  { label: '路人', value: 3 }
]

interface CharacterCard extends Character {
  type: 'file'
}

interface CharacterFolder {
  id: string
  originId?: number
  title: string
  children: CharacterCard[]
  type: 'folder'
  isOpen: boolean
  isVirtual?: boolean
}

interface DragData {
  type: 'folder' | 'file'
  index?: number
  fIndex?: number
  iIndex?: number
  item: CharacterFolder | CharacterCard
}

type CharacterField = 'appearance' | 'personality' | 'background'

const aiPolishLoading = reactive<Record<CharacterField, boolean>>({
  appearance: false,
  personality: false,
  background: false
})

const aiPolishControllers: Record<CharacterField, AbortController | null> = {
  appearance: null,
  personality: null,
  background: null
}

const characterUndoSnapshots = reactive<Record<CharacterField, { characterId: number; originalText: string } | null>>({
  appearance: null,
  personality: null,
  background: null
})

const searchText = ref('')
const filteredCharacterTree = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase()
  if (!query) return characterTree.value
  return characterTree.value.filter(folder => visibleCharacters(folder).length)
})
const visibleCharacters = (folder: CharacterFolder) => {
  const query = searchText.value.trim().toLocaleLowerCase()
  return query ? folder.children.filter(character => getCharacterNames(character).some(name => name.toLocaleLowerCase().includes(query))) : folder.children
}
const characterTree = ref<CharacterFolder[]>([])
const currentCharacter = ref<CharacterCard | null>(null)
const activeCharacterId = ref<number | null>(null)

const editingCharacterId = ref<number | null>(null)
const editingName = ref('')
const editingFolderId = ref<string | null>(null)
const editingFolderTitle = ref('')
const editInputRef = ref<HTMLInputElement | null>(null)

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  item: null as CharacterCard | CharacterFolder | null,
  type: 'file' as 'file' | 'folder'
})

const contextMenuMeta = computed(() => {
  const menu = contextMenu.value
  if (!menu.item) return null

  if (menu.type === 'folder') {
    const folder = menu.item as CharacterFolder
    const groupTag = folder.isVirtual ? '系统分组' : '自定义分组'
    return {
      title: folder.title,
      info: `${folder.children.length} 个角色 | ${groupTag}`
    }
  }

  const character = menu.item as CharacterCard
  const roleLabel = ROLE_OPTIONS.find(option => option.value === character.role)?.label || '未分类'
  const folder = findFolderForCharacter(character)
  const groupName = folder?.title || '未分组'
  return {
    title: character.name || '未命名角色',
    info: `${roleLabel} | ${groupName}`
  }
})

const draggedItem = ref<DragData | null>(null)
const dragTarget = ref<CharacterFolder | CharacterCard | null>(null)
const isResizing = ref(false)
const startX = ref(0)
const startWidth = ref(0)

const ensureBookContext = () => {
  if (!props.bookId) {
    ElMessage.warning('请先选择要编辑的作品')
    return false
  }
  return true
}

const toCharacterCard = (character: Character): CharacterCard => ({
  ...character,
  type: 'file',
  name: character.name || '未命名角色',
  role: character.role ?? 0,
  gender: character.gender ?? 0,
  age: character.age || '',
  appearance: character.appearance || '',
  personality: character.personality || '',
  background: character.background || '',
  ability: character.ability || '',
  tags: character.tags || []
})

const buildCharacterTree = (groups: CharacterGroup[], characters: Character[]) => {
  const folderMap = new Map<string, CharacterFolder>()
  const folders: CharacterFolder[] = groups.map(group => {
    const folder: CharacterFolder = {
      id: String(group.id),
      originId: group.id,
      title: group.title,
      type: 'folder' as const,
      isOpen: true,
      children: []
    }
    folderMap.set(folder.id, folder)
    return folder
  })

  const ungroupedFolder: CharacterFolder = {
    id: 'virtual-ungrouped',
    title: '未分组',
    type: 'folder' as const,
    isOpen: true,
    isVirtual: true,
    children: []
  }

  characters.forEach(character => {
    const folderRef: CharacterFolder | undefined = character.groupId !== undefined && character.groupId !== null
      ? folderMap.get(String(character.groupId))
      : undefined
    const targetFolder: CharacterFolder = folderRef ?? ungroupedFolder
    targetFolder.children.push(toCharacterCard(character))
  })

  if (ungroupedFolder.children.length || !folders.length) {
    folders.push(ungroupedFolder)
  }

  characterTree.value = folders
  restoreCharacterSelection()
}

const restoreCharacterSelection = () => {
  if (activeCharacterId.value) {
    const existing = findCharacterById(activeCharacterId.value)
    if (existing) {
      clearInvalidCharacterUndoSnapshots(existing.id)
      currentCharacter.value = existing
      return
    }
  }
  const fallback = characterTree.value.find(folder => folder.children.length)?.children[0] || null
  clearInvalidCharacterUndoSnapshots(fallback?.id ?? null)
  currentCharacter.value = fallback || null
  activeCharacterId.value = fallback?.id ?? null
}

const findCharacterById = (id: number) => {
  for (const folder of characterTree.value) {
    const match = folder.children.find(child => child.id === id)
    if (match) return match
  }
  return null
}

const findFolderForCharacter = (character: CharacterCard) => {
  return (
    characterTree.value.find(folder =>
      folder.children.some(child => child.id === character.id)
    ) || null
  )
}

const fetchCharacterData = async () => {
  if (!props.bookId) return
  try {
    const [groupRes, characterRes] = await Promise.all([
      listCharacterGroupApi(props.bookId),
      getCharacterListApi({ bookId: String(props.bookId), page: 1, size: 500 })
    ])
    const groups = groupRes.data || []
    const characters = characterRes.data?.list || []
    buildCharacterTree(groups, characters)
  } catch (error) {
    console.error('加载角色数据失败:', error)
  }
}

watch(
  () => props.bookId,
  (bookId) => {
    characterTree.value = []
    currentCharacter.value = null
    activeCharacterId.value = null
    clearInvalidCharacterUndoSnapshots(null)
    if (bookId) {
      fetchCharacterData()
    }
  },
  { immediate: true }
)

const selectCharacter = async (item: CharacterCard) => {
  if (currentCharacter.value && currentCharacter.value.id !== item.id && !(await saveCurrentCharacter())) return
  clearInvalidCharacterUndoSnapshots(item.id)
  currentCharacter.value = item
  activeCharacterId.value = item.id
}

const startEdit = (item: CharacterCard) => {
  editingFolderId.value = null
  editingCharacterId.value = item.id
  editingName.value = item.name
  nextTick(() => {
    const input = Array.isArray(editInputRef.value) ? editInputRef.value[0] : editInputRef.value
    input?.focus()
    input?.select()
  })
}

const saveEdit = async (item: CharacterCard) => {
  if (!editingCharacterId.value) return
  const newName = editingName.value.trim()
  if (!newName || newName === item.name) {
    cancelEdit()
    return
  }
  try {
    await updateCharacterApi({ id: item.id, name: newName })
    item.name = newName
    emit('lore-updated')
  } catch (error) {
    console.error('更新角色名称失败:', error)
  } finally {
    cancelEdit()
  }
}

const cancelEdit = () => {
  editingCharacterId.value = null
  editingName.value = ''
}

const startEditFolder = (folder: CharacterFolder) => {
  editingCharacterId.value = null
  if (folder.isVirtual) {
    ElMessage.warning('未分组不可重命名')
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

const saveEditFolder = async (folder: CharacterFolder) => {
  if (!editingFolderId.value || !folder.originId) return
  const newTitle = editingFolderTitle.value.trim()
  if (!newTitle || newTitle === folder.title) {
    cancelEditFolder()
    return
  }
  try {
    await updateCharacterGroupApi({ id: folder.originId, title: newTitle })
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

const closeContextMenu = () => {
  contextMenu.value.visible = false
  document.removeEventListener('click', closeContextMenu)
}

const handleContextMenu = (event: MouseEvent, item: CharacterCard | CharacterFolder, type: 'file' | 'folder' = 'file') => {
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

const handleMenuAction = async (action: string) => {
  const { item, type } = contextMenu.value
  if (!item) return
  if (action === 'rename') {
    type === 'file' ? startEdit(item as CharacterCard) : startEditFolder(item as CharacterFolder)
  } else if (action === 'delete') {
    if (type === 'file') {
      await deleteCharacter(item as CharacterCard)
    } else {
      await deleteFolder(item as CharacterFolder)
    }
  } else if (action === 'new-character' && type === 'folder') {
    await handleAddCharacterToFolder(item as CharacterFolder)
  }
  closeContextMenu()
}

const deleteCharacter = async (character: CharacterCard) => {
  await inkConfirm(`确定删除角色「${character.name}」吗？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  })
  await deleteCharacterApi({ ids: [character.id] })
  ElMessage.success('删除成功')
  await fetchCharacterData()
  emit('lore-updated')
}

const deleteFolder = async (folder: CharacterFolder) => {
  if (folder.isVirtual || !folder.originId) {
    ElMessage.warning('默认分组不可删除')
    return
  }
  await inkConfirm(`确定删除分组「${folder.title}」吗？组内角色将移至未分组。`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  })
  await deleteCharacterGroupApi({ ids: [folder.originId] })
  ElMessage.success('分组已删除')
  await fetchCharacterData()
  emit('lore-updated')
}

const toggleFolder = (folder: CharacterFolder) => {
  folder.isOpen = !folder.isOpen
}

const handleAddFolder = async () => {
  if (!ensureBookContext()) return
  try {
    const realGroupCount = characterTree.value.filter(folder => !folder.isVirtual).length
    await addCharacterGroupApi({
      bookId: String(props.bookId),
      title: '新建分组',
      sortNo: realGroupCount + 1
    })
    ElMessage.success('分组创建成功')
    await fetchCharacterData()
  } catch (error) {
    console.error('新增分组失败:', error)
  }
}

const handleAddCharacter = async () => {
  if (!ensureBookContext()) return
  if (!characterTree.value.length) {
    await handleAddFolder()
  }
  const targetFolder = characterTree.value.find(folder => !folder.isVirtual) || characterTree.value[0]
  if (targetFolder) {
    await handleAddCharacterToFolder(targetFolder)
  }
}

const handleAddCharacterToFolder = async (folder: CharacterFolder) => {
  if (!ensureBookContext()) return
  try {
    const { data } = await addCharacterApi({
      bookId: String(props.bookId),
      groupId: folder.originId,
      name: '新角色',
      role: 0,
      gender: 0,
      sortNo: folder.children.length + 1
    })
    activeCharacterId.value = data.id
    folder.isOpen = true
    await fetchCharacterData()
    ElMessage.success('角色创建成功')
    emit('lore-updated')
  } catch (error) {
    console.error('新增角色失败:', error)
  }
}

const persistGroupOrder = async () => {
  const tasks = characterTree.value
    .filter(folder => !folder.isVirtual && folder.originId)
    .map((folder, index) => updateCharacterGroupApi({ id: folder.originId!, sortNo: index + 1 }))
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const persistCharacterOrder = async (folder: CharacterFolder) => {
  const tasks = folder.children.map((child, index) =>
    updateCharacterApi({
      id: child.id,
      groupId: folder.isVirtual ? undefined : folder.originId,
      sortNo: index + 1
    })
  )
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const moveCharacterToFolder = async (character: CharacterCard, folder: CharacterFolder) => {
  const targetGroupId = folder.isVirtual ? null : folder.originId
  // 同一分组内只更新排序，避免发送没有实际字段的移动请求。
  if (String(character.groupId ?? '') === String(targetGroupId ?? '')) return
  await updateCharacterApi({
    id: character.id,
    groupId: targetGroupId
  })
  character.groupId = targetGroupId ?? null
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
      const moved = characterTree.value.splice(source.index, 1)[0]
      characterTree.value.splice(target.index, 0, moved)
      await persistGroupOrder()
    } else if (
      source.type === 'file' &&
      typeof source.fIndex === 'number' &&
      typeof target.fIndex === 'number' &&
      typeof source.iIndex === 'number' &&
      typeof target.iIndex === 'number'
    ) {
      const sourceFolder = characterTree.value[source.fIndex]
      const targetFolder = characterTree.value[target.fIndex]
      const item = sourceFolder.children.splice(source.iIndex, 1)[0]
      targetFolder.children.splice(target.iIndex, 0, item)
      if (currentCharacter.value?.id === item.id) {
        selectCharacter(item)
      }
      await moveCharacterToFolder(item, targetFolder)
      await persistCharacterOrder(targetFolder)
      emit('lore-updated')
    }
  } else if (
    source.type === 'file' &&
    target.type === 'folder' &&
    typeof source.fIndex === 'number' &&
    typeof source.iIndex === 'number' &&
    typeof target.index === 'number'
  ) {
    const sourceFolder = characterTree.value[source.fIndex]
    const targetFolder = characterTree.value[target.index]
    const item = sourceFolder.children.splice(source.iIndex, 1)[0]
    targetFolder.children.push(item)
    targetFolder.isOpen = true
    if (currentCharacter.value?.id === item.id) {
      selectCharacter(item)
    }
    await moveCharacterToFolder(item, targetFolder)
    await persistCharacterOrder(targetFolder)
    emit('lore-updated')
  }

  draggedItem.value = null
}

const handleAiPolish = async (field: CharacterField) => {
  if (!currentCharacter.value) {
    ElMessage.warning('请先选择角色')
    return
  }
  if (!ensureBookContext()) return
  if (aiPolishLoading[field]) {
    ElMessage.warning('AI 正在处理中，请稍候...')
    return
  }
  const raw = (currentCharacter.value[field] || '').trim()
  if (!raw) {
    ElMessage.warning('请先输入内容再润色')
    return
  }
  const characterId = currentCharacter.value.id
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  const controller = new AbortController()
  if (aiPolishControllers[field]) {
    aiPolishControllers[field]?.abort()
  }
  aiPolishControllers[field] = controller
  aiPolishLoading[field] = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'character_polish',
      sceneLabel: '角色润色',
      modelCode,
      temperature: promptTemperature('reference-polish', `${field}Task`),
      messages: buildCharacterFieldMessages({ field, selection: raw }),
      signal: controller.signal
    })
    const polished = (data || '').trim()
    if (!polished) {
      throw new Error('AI 暂无返回内容')
    }
    if (currentCharacter.value?.id !== characterId) {
      ElMessage.warning('已切换角色，本次润色结果未应用')
      return
    }
    characterUndoSnapshots[field] = {
      characterId,
      originalText: currentCharacter.value[field] || ''
    }
    currentCharacter.value[field] = polished
    await saveCurrentCharacter()
    ElMessage.success('AI 已完成润色')
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('AI润色失败:', error)
    ElMessage.error(String(error?.message || 'AI润色失败，请稍后重试'))
  } finally {
    if (aiPolishControllers[field] === controller) {
      aiPolishControllers[field] = null
    }
    aiPolishLoading[field] = false
  }
}

const canUndoCharacterPolish = (field: CharacterField) => {
  const snapshot = characterUndoSnapshots[field]
  return !!snapshot && currentCharacter.value?.id === snapshot.characterId && !aiPolishLoading[field]
}

function clearInvalidCharacterUndoSnapshots(characterId: number | null) {
  ;(Object.keys(characterUndoSnapshots) as CharacterField[]).forEach((field) => {
    const snapshot = characterUndoSnapshots[field]
    if (snapshot && snapshot.characterId !== characterId) {
      characterUndoSnapshots[field] = null
    }
  })
}

const handleUndoCharacterPolish = async (field: CharacterField) => {
  const snapshot = characterUndoSnapshots[field]
  if (!snapshot || !currentCharacter.value) return
  // 撤销前校验当前角色，避免切换后恢复到其他角色。
  if (currentCharacter.value.id !== snapshot.characterId) {
    characterUndoSnapshots[field] = null
    ElMessage.warning('当前角色已切换，无法撤销')
    return
  }
  currentCharacter.value[field] = snapshot.originalText
  if (await saveCurrentCharacter()) {
    characterUndoSnapshots[field] = null
    ElMessage.success('已撤销本次润色')
  }
}

const saveCurrentCharacter = async () => {
  if (!currentCharacter.value) return true
  try {
    const payload: Partial<Character> = {
      id: currentCharacter.value.id,
      groupId: currentCharacter.value.groupId,
      name: currentCharacter.value.name,
      aliases: [...(currentCharacter.value.aliases || [])],
      role: currentCharacter.value.role,
      gender: currentCharacter.value.gender,
      age: currentCharacter.value.age,
      appearance: currentCharacter.value.appearance,
      personality: currentCharacter.value.personality,
      background: currentCharacter.value.background
    }
    await updateCharacterApi(payload)
    emit('lore-updated')
    return true
  } catch (error) {
    console.error('保存角色信息失败:', error)
    ElMessage.error('角色资料保存失败，请重试')
    return false
  }
}

const saveCharacterAliases = async (aliases: string[]) => {
  if (!currentCharacter.value) return
  currentCharacter.value.aliases = aliases
  await saveCurrentCharacter()
}

const flushPendingSave = async () => saveCurrentCharacter()

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

const startResize = (e: MouseEvent) => {
  e.preventDefault()
  isResizing.value = true
  startX.value = e.clientX
  startWidth.value = store.characterTreeWidth
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
    store.setCharacterTreeWidth(newWidth)
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
  clearInvalidCharacterUndoSnapshots(null)
  ;(Object.keys(aiPolishControllers) as CharacterField[]).forEach((key) => {
    aiPolishControllers[key]?.abort()
    aiPolishControllers[key] = null
  })
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

.character-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--ui-border);

  button {
    padding: 6px 14px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--ink-sec);
    font-size: 13px;
    cursor: pointer;

    &.active {
      color: var(--ink-main);
      border-bottom-color: var(--ink-accent);
      font-weight: 600;
    }
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
    font-size: 14px;
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
      font-size: 12px;
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

.outline-tree {
  /* width: 160px; 由 style 控制 */
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
        font-size: 12px;
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
        font-size: 10px;
        color: var(--ink-sec);
        opacity: 0.5;
      }
    }

    .add-button {
      background: none;
      border: none;
      color: var(--ink-sec);
      font-size: 14px;
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
    font-size: 12px;
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
    font-size: 13px;
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

      &.force-hover::before {
        width: 100%;
      }

      &.force-hover::after {
        height: 100%;
      }

      .item-text {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--ink-main);
        font-size: 14px;
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
          font-size: 12px;
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

      &.drag-over {
        &::before {
          background: var(--nav-hover-bg, rgba(0, 0, 0, 0.03));
        }
      }

      &.folder {
        font-weight: 500;
        margin-top: 0;

        i {
          color: var(--ink-sec);
          font-size: 14px;
        }

        .item-text {
          font-weight: 600;
        }
      }

      &.child {
        padding-left: 32px;
        font-size: 14px;

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
    font-size: 14px;
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
    font-size: 16px;
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
    font-size: 12px;
    color: var(--ink-sec);
    cursor: pointer;
  }
}

.character-form-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;

  .form-item {
    display: flex;
    flex-direction: column;
    gap: 8px;

    label {
      font-size: 13px;
      color: var(--ink-sec);
      font-weight: 500;
    }

    input,
    textarea,
    select {
      padding: 8px 12px;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--ink-main);
      font-size: 14px;
      transition: all 0.2s;
      outline: none;

      &:focus {
        background: var(--input-focus-bg);
        border-color: var(--ink-accent);
      }

      &::placeholder {
        color: var(--ink-sec);
        opacity: 0.5;
      }
    }

    select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8.825L1.175 4 2.238 2.938 6 6.7l3.763-3.762L10.825 4z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 24px;
    }

    textarea {
      resize: vertical;
      line-height: 1.6;
      min-height: 132px;
    }
  }

  .form-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;

    .half {
      flex: 1;
      min-width: 140px;
    }
  }

  .label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;

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
      font-size: 12px;
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
        font-size: 12px;
      }
    }
  }
}

.context-menu {
  position: fixed;
  z-index: 99999;
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
    padding: 8px 16px 0 16px;

    .menu-title {
      font-weight: 600;
      margin-bottom: 4px;
    }

    .menu-info {
      font-size: 12px;
      color: var(--ink-sec);
      opacity: 0.85;
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
