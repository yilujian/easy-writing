<template>
  <div>
    <EwModal v-model:visible="showMoveGroupModal" title="移动分组" width="420px" :close-on-click-modal="true">
      <div class="move-group-form">
        <label class="move-group-label">目标分组</label>
        <el-select
v-model="moveGroupId" class="ink-select move-group-select" placeholder="未分组"
          popper-class="ink-select-popper">
          <el-option label="未分组" value="" />
          <el-option v-for="group in bookGroups" :key="group.id" :label="group.title" :value="String(group.id)" />
        </el-select>
      </div>
      <template #footer>
        <button class="ink-btn ink-btn-outline" type="button" @click="showMoveGroupModal = false">取消</button>
        <button class="ink-btn ink-btn-primary" type="button" @click="submitMoveGroup">确认移动</button>
      </template>
    </EwModal>

    <EwModal
v-model:visible="showGroupModal" :title="groupModalTitle" width="420px" :close-on-click-modal="true"
      @close="closeGroupModal">
      <input
v-model="groupFormTitle" class="ink-input group-name-input" type="text" maxlength="40" placeholder="分组名称"
        @keydown.enter.prevent="submitGroupForm" />
      <template #footer>
        <button class="ink-btn ink-btn-outline" type="button" @click="closeGroupModal">取消</button>
        <button class="ink-btn ink-btn-primary" type="button" @click="submitGroupForm">
          {{ editingGroup ? '保存' : '创建' }}
        </button>
      </template>
    </EwModal>

    <EwModal
v-model:visible="showManageGroupModal" title="管理分组" width="560px" custom-class="group-manage-modal"
      :close-on-click-modal="true">
      <div v-if="bookGroups.length" class="manage-group-list">
        <div v-for="group in bookGroups" :key="group.id" class="manage-group-row">
          <div class="manage-group-info">
            <i class="fa-regular fa-folder"></i>
            <span>{{ group.title }}</span>
            <em>{{ getGroupCount(group.id) }}本</em>
          </div>
          <div class="manage-group-actions">
            <button type="button" @click="handleRenameGroup(group)">
              <i class="fa-solid fa-pen"></i>
              重命名
            </button>
            <button class="danger" type="button" @click="handleDeleteGroup(group)">
              <i class="fa-solid fa-trash"></i>
              删除
            </button>
          </div>
        </div>
      </div>
      <div v-else class="manage-group-empty">
        <i class="fa-regular fa-folder-open"></i>
        <p>暂无自定义分组</p>
      </div>
      <template #footer>
        <button class="ink-btn ink-btn-outline" type="button" @click="showManageGroupModal = false">关闭</button>
        <button class="ink-btn ink-btn-primary" type="button" @click="handleCreateGroup">
          <i class="fa-solid fa-plus"></i>
          新建分组
        </button>
      </template>
    </EwModal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import { inkConfirm } from '@/utils/ink-confirm'
import type { Book, BookGroup } from '@/types'
import { getLocalLibraryStorage } from '@/storage/local-library'

defineProps<{
  bookGroups: BookGroup[]
  getGroupCount: (groupId: number | string) => number
}>()

const emit = defineEmits<{
  (e: 'changed'): void
  (e: 'group-deleted', groupId: string): void
}>()

const localLibrary = getLocalLibraryStorage()

const showMoveGroupModal = ref(false)
const showGroupModal = ref(false)
const showManageGroupModal = ref(false)
const movingBook = ref<Book | null>(null)
const moveGroupId = ref('')
const editingGroup = ref<BookGroup | null>(null)
const groupFormTitle = ref('')

const groupModalTitle = computed(() => (editingGroup.value ? '重命名分组' : '新建分组'))

const openManage = () => {
  showManageGroupModal.value = true
}

const openCreate = () => {
  showManageGroupModal.value = false
  editingGroup.value = null
  groupFormTitle.value = ''
  showGroupModal.value = true
}

const openMove = (work: Book) => {
  movingBook.value = work
  moveGroupId.value = work.groupId ? String(work.groupId) : ''
  showMoveGroupModal.value = true
}

const handleCreateGroup = openCreate

const handleRenameGroup = (group: BookGroup) => {
  showManageGroupModal.value = false
  editingGroup.value = group
  groupFormTitle.value = group.title
  showGroupModal.value = true
}

const closeGroupModal = () => {
  showGroupModal.value = false
  editingGroup.value = null
  groupFormTitle.value = ''
}

const submitGroupForm = async () => {
  const title = groupFormTitle.value.trim()
  if (!title) {
    ElMessage.warning('分组名称不能为空')
    return
  }
  const group = editingGroup.value
  try {
    if (group) {
      await localLibrary.updateLocalGroup({ id: group.id, title })
      ElMessage.success('保存成功')
    } else {
      await localLibrary.createLocalGroup({ title })
      ElMessage.success('创建成功')
    }
    closeGroupModal()
    emit('changed')
  } catch (error) {
    console.error(group ? '重命名分组失败:' : '创建分组失败:', error)
  }
}

const handleDeleteGroup = (group: BookGroup) => {
  inkConfirm(
    `确定要删除“${group.title}”吗？分组内作品会移入未分组。`,
    '删除分组',
    {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'work-delete-confirm-btn',
    }
  )
    .then(async () => {
      try {
        await localLibrary.deleteLocalGroup([group.id])
        ElMessage.success('删除成功')
        emit('group-deleted', String(group.id))
        emit('changed')
      } catch (error) {
        console.error('删除分组失败:', error)
      }
    })
    .catch(() => {
      // cancel
    })
}

const submitMoveGroup = async () => {
  if (!movingBook.value) return
  try {
    await localLibrary.updateLocalBook({
      id: movingBook.value.id,
      groupId: moveGroupId.value || null,
    })
    ElMessage.success('移动成功')
    showMoveGroupModal.value = false
    movingBook.value = null
    emit('changed')
  } catch (error) {
    console.error('移动分组失败:', error)
  }
}

defineExpose({ openManage, openCreate, openMove })
</script>

<style scoped lang="scss">
.move-group-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.move-group-label {
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 700;
  color: var(--ink-sec);
}

.move-group-select {
  width: 100%;
}

.group-name-input {
  width: 100%;
}

.manage-group-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.manage-group-row {
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-glass-bg);
}

.manage-group-info {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-main);

  i {
    color: var(--ink-accent);
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
  }

  em {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-style: normal;
    flex-shrink: 0;
  }
}

.manage-group-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;

  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--bg-main);
    color: var(--ink-sec);
    cursor: pointer;
    padding: 6px 9px;
    font-size: calc(12px * var(--ui-font-scale, 1));

    &:hover {
      color: var(--ink-main);
      border-color: var(--ink-main);
    }

    &.danger:hover {
      color: var(--el-color-danger);
      border-color: var(--el-color-danger-light-5);
      background: var(--el-color-danger-light-9);
    }
  }
}

.manage-group-empty {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--ui-border);
  border-radius: 8px;
  color: var(--ink-sec);

  i {
    font-size: calc(28px * var(--ui-font-scale, 1));
    opacity: 0.72;
  }

  p {
    margin: 0;
    font-size: calc(14px * var(--ui-font-scale, 1));
  }
}

</style>
