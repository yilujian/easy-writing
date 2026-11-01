<template>
  <aside
    class="pi-sidebar"
    aria-label="Agent 导航"
    :inert="!open ? true : undefined"
    :aria-hidden="!open"
  >
    <div class="pi-brand">
      <img src="/logo.png" alt="易创" /><span>易创</span>
      <button class="pi-icon-button" aria-label="收起侧栏" @click="$emit('close')">
        <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
      </button>
    </div>
    <router-link class="pi-back" to="/novel"
      ><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>返回工作台</span></router-link
    >
    <button class="pi-new-chat ink-btn ink-btn-primary" :disabled="store.inputLocked" @click="$emit('new-chat', '')">
      <i class="fa-solid fa-plus" aria-hidden="true"></i><span>新对话</span>
    </button>
    <nav class="pi-main-navigation">
      <button type="button" :class="{ 'is-active': store.view === 'memory' }" :aria-current="store.view === 'memory' ? 'page' : undefined" @click="$emit('memory')">
        <i class="fa-regular fa-bookmark" aria-hidden="true"></i><span>记忆</span>
      </button>
      <button type="button" :class="{ 'is-active': store.view === 'resources' }" :aria-current="store.view === 'resources' ? 'page' : undefined" @click="$emit('resources')">
        <i class="fa-solid fa-book-open" aria-hidden="true"></i><span>写作资源</span>
      </button>
      <button type="button" @click="openSearch">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>搜索对话</span
        ><kbd>{{ shortcutLabel('search') }}</kbd>
      </button>
      <button type="button" :class="{ 'is-active': store.view === 'skills' }" :aria-current="store.view === 'skills' ? 'page' : undefined" @click="$emit('skills')">
        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>技能</span>
      </button>
    </nav>
    <section
      class="pi-independent-conversations"
      :class="{ 'is-drop-target': dropTarget === '' }"
      aria-label="对话"
      @dragover="allowDrop($event, '')"
      @dragleave="leaveDrop('')"
      @drop.prevent="dropOn('')"
    >
      <div class="pi-projects-heading"><span>对话</span></div>
      <div class="pi-project-conversations">
        <PiSessionRow
          v-for="session in ungrouped"
          :key="rowKey(session)"
          :session="session"
          :active="isActive(session)"
          :disabled="store.inputLocked"
          :draggable="canDrag(session)"
          @select="$emit('select', session)"
          @menu="openMenu"
          @dragstart="dragging = $event"
          @dragend="endDrag"
        />
      </div>
      <p v-if="!store.visibleSessions.length" class="pi-empty-history">开始对话后，记录会保存在本机。</p>
    </section>
    <div class="pi-projects-heading">
      <span>分组</span>
      <button
        class="pi-icon-button"
        title="新建分组"
        aria-label="新建分组"
        :disabled="store.inputLocked"
        @click="openGroupForm()"
      >
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
      </button>
    </div>
    <div class="pi-projects-scroll">
      <section
        v-for="group in store.groups"
        :key="group.id"
        class="pi-group"
        :class="{ 'is-drop-target': dropTarget === group.id }"
        :aria-label="`分组 ${group.name}`"
        @dragover="allowDrop($event, group.id)"
        @dragleave="leaveDrop(group.id)"
        @drop.prevent="dropOn(group.id)"
      >
        <div class="pi-group-heading-row" :class="{ 'is-menu-open': groupMenuId === group.id }">
          <button class="pi-group-toggle" :aria-expanded="!collapsed.includes(group.id)" @click="toggleGroup(group.id)">
            <i
              :class="collapsed.includes(group.id) ? 'fa-regular fa-folder' : 'fa-regular fa-folder-open'"
              aria-hidden="true"
            ></i>
            <span>{{ group.name }}</span>
          </button>
          <div class="pi-group-actions">
            <button
              class="pi-icon-button"
              :title="`在「${group.name}」新建对话`"
              :aria-label="`在分组 ${group.name} 新建对话`"
              :disabled="store.inputLocked"
              @click="$emit('new-chat', group.id)"
            >
              <i class="fa-regular fa-pen-to-square" aria-hidden="true"></i>
            </button>
            <el-dropdown
              trigger="click"
              popper-class="pi-conversation-menu"
              @visible-change="(visible: boolean) => (groupMenuId = visible ? group.id : null)"
              @command="(command: string) => onGroupCommand(group, command)"
            >
              <button class="pi-icon-button" :aria-label="`管理分组 ${group.name}`">
                <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename">重命名分组</el-dropdown-item>
                  <el-dropdown-item command="delete" divided class="pi-menu-danger">删除分组</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        <div v-if="!collapsed.includes(group.id)" class="pi-project-conversations">
          <PiSessionRow
            v-for="session in inGroup(group.id)"
            :key="rowKey(session)"
            :session="session"
            :active="isActive(session)"
            :disabled="store.inputLocked"
            :draggable="canDrag(session)"
            @select="$emit('select', session)"
            @menu="openMenu"
            @dragstart="dragging = $event"
            @dragend="endDrag"
          />
          <button
            v-if="!inGroup(group.id).length"
            class="pi-project-new"
            :disabled="store.inputLocked"
            @click="$emit('new-chat', group.id)"
          >
            <i class="fa-solid fa-plus" aria-hidden="true"></i><span>新建对话</span>
          </button>
        </div>
      </section>
    </div>
    <div class="pi-sidebar-bottom">
      <button type="button" aria-label="Agent 设置" @click="settingsVisible = true">
        <i class="fa-solid fa-gear" aria-hidden="true"></i><span>设置</span>
      </button>
      <button type="button" @click="openRecycle">
        <i class="fa-regular fa-trash-can" aria-hidden="true"></i><span>回收站</span
        ><small v-if="store.archivedSessions.length" class="pi-count">{{ store.archivedSessions.length }}</small>
      </button>
    </div>

    <EwModal v-model:visible="settingsVisible" title="Agent 设置" width="440px" custom-class="pi-dialog" manage-focus>
      <label class="pi-send-setting">
        <span>发送消息</span>
        <el-select
          :model-value="store.enterToSend"
          :disabled="settingsSaving"
          aria-label="发送快捷键"
          class="ink-select"
          popper-class="ink-select-popper"
          @update:model-value="changeSendMode"
        >
          <el-option label="Enter 发送，Shift + Enter 换行" :value="true" />
          <el-option label="Ctrl / ⌘ + Enter 发送，Enter 换行" :value="false" />
        </el-select>
      </label>
      <template #footer>
        <button type="button" class="ink-btn ink-btn-primary" @click="settingsVisible = false">完成</button>
      </template>
    </EwModal>

    <el-dropdown
      ref="menu"
      trigger="contextmenu"
      virtual-triggering
      :virtual-ref="menuAnchor"
      :show-arrow="false"
      :show-timeout="0"
      :hide-timeout="0"
      :persistent="false"
      :popper-options="{ strategy: 'fixed' }"
      placement="bottom-start"
      popper-class="pi-conversation-menu"
      @command="onSessionCommand"
    >
      <template #dropdown>
        <el-dropdown-menu v-if="menuSession" @contextmenu.prevent>
          <el-dropdown-item command="pin">{{ menuSession.pinnedAt ? '取消置顶' : '置顶' }}</el-dropdown-item>
          <el-dropdown-item command="rename">重命名</el-dropdown-item>
          <el-dropdown-item
            v-for="group in store.groups"
            :key="group.id"
            :command="`move:${group.id}`"
            :disabled="menuSession.groupId === group.id"
            >移到「{{ group.name }}」</el-dropdown-item
          >
          <el-dropdown-item v-if="menuSession.groupId" command="move:">移出分组</el-dropdown-item>
          <el-dropdown-item
            command="archive"
            divided
            :disabled="busy(menuSession)"
            :title="busy(menuSession) ? '请先停止当前任务' : undefined"
            >归档</el-dropdown-item
          >
          <el-dropdown-item command="delete" class="pi-menu-danger" :disabled="busy(menuSession)"
            >彻底删除</el-dropdown-item
          >
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <EwModal
      v-model:visible="nameForm.visible"
      :title="nameForm.title"
      width="440px"
      custom-class="pi-dialog"
      :close-on-click-modal="false"
      manage-focus
      @opened="nameInput?.focus()"
    >
      <form id="pi-name-form" class="pi-form" @submit.prevent="submitName">
        <label
          >{{ nameForm.label
          }}<input
            ref="nameInput"
            v-model="nameForm.value"
            class="ink-input"
            :maxlength="nameForm.max"
            :aria-label="nameForm.label"
            required
        /></label>
      </form>
      <template #footer>
        <button type="button" class="ink-btn ink-btn-outline" @click="nameForm.visible = false">取消</button>
        <button
          type="submit"
          form="pi-name-form"
          class="ink-btn ink-btn-primary"
          :disabled="nameForm.saving || !nameForm.value.trim()"
        >
          保存
        </button>
      </template>
    </EwModal>

    <EwModal
      v-model:visible="searchVisible"
      title="搜索对话"
      width="560px"
      custom-class="pi-dialog pi-search-dialog"
      manage-focus
      @opened="searchInput?.focus()"
    >
      <label class="pi-search"
        ><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i
        ><input ref="searchInput" v-model="searchQuery" placeholder="搜索对话名称或内容" aria-label="搜索对话"
      /></label>
      <div class="pi-session-results">
        <button v-for="item in searchResults" :key="rowKey(item.session)" type="button" @click="pick(item.session)">
          <i class="fa-regular fa-message" aria-hidden="true"></i
          ><span
            ><strong>{{ item.session.title }}</strong
            ><small>{{ item.snippet || item.session.book?.title || '独立会话' }}</small></span
          >
        </button>
        <p v-if="searchQuery.trim() && !searchResults.length && !searching" class="pi-small-empty">没有找到相关对话</p>
      </div>
    </EwModal>

    <EwModal v-model:visible="recycleVisible" title="回收站" width="560px" custom-class="pi-dialog" manage-focus>
      <div class="pi-session-results pi-recycle-list">
        <div v-for="session in store.archivedSessions" :key="rowKey(session)" class="pi-recycle-row">
          <i class="fa-regular fa-message" aria-hidden="true"></i
          ><span
            ><strong>{{ session.title }}</strong
            ><small>{{ session.book?.title || '独立会话' }} · 归档于 {{ formatTime(session.archivedAt) }}</small></span
          >
          <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="recycleBusy" @click="restore(session)">
            恢复
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline ink-btn-sm pi-danger-btn"
            :disabled="recycleBusy"
            @click="purge(session)"
          >
            彻底删除
          </button>
        </div>
        <p v-if="!store.archivedSessions.length" class="pi-small-empty">回收站是空的</p>
      </div>
      <template #footer>
        <button
          type="button"
          class="ink-btn ink-btn-outline"
          :disabled="recycleBusy || !store.archivedSessions.length"
          @click="purgeAll"
        >
          清空回收站
        </button>
        <button type="button" class="ink-btn ink-btn-primary" @click="recycleVisible = false">关闭</button>
      </template>
    </EwModal>
  </aside>
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { appSettings } from '@/storage/app-settings'
import { usePiWorkspace } from './use-pi-workspace'
import PiSessionRow from './PiSessionRow.vue'
import { shortcutLabel } from './shortcuts'
import { mergeSearchResults } from './session-search'
import type { PiSession, PiSessionGroup, PiSessionSearchHit } from '@/types/agent-pi'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'new-chat', groupId: string): void
  (event: 'select', session: PiSession): void
  (event: 'skills'): void
  (event: 'memory'): void
  (event: 'resources'): void
}>()
const store = usePiWorkspace()
const settingsVisible = ref(false)
const settingsSaving = ref(false)
async function changeSendMode(value: boolean) {
  if (settingsSaving.value) return
  settingsSaving.value = true
  try {
    await store.setEnterToSend(value)
  } catch (error) {
    ElMessage.error('发送快捷键保存失败：' + String(error))
  } finally {
    settingsSaving.value = false
  }
}

const rowKey = (session: PiSession) => session.localKey || session.file || session.id
const isActive = (session: PiSession) =>
  session.localKey ? store.activeKey === session.localKey : !!store.sessionFile && store.sessionFile === session.file
const busy = (session: PiSession) => ['running', 'connecting', 'waiting'].includes(session.status || '')
const canDrag = (session: PiSession) => !store.inputLocked && !!session.file
/** 列表本身按最近更新排序，置顶的排到各自列表最前面。 */
const pinnedFirst = (list: PiSession[]) =>
  [...list].sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt))
const inGroup = (id: string) => pinnedFirst(store.visibleSessions.filter(session => session.groupId === id))
const ungrouped = computed(() =>
  pinnedFirst(
    store.visibleSessions.filter(
      session => !session.groupId || !store.groups.some(group => group.id === session.groupId)
    )
  )
)
const notify = (error: unknown) => ElMessage.error(String(error instanceof Error ? error.message : error))
async function run(task: () => Promise<unknown>) {
  try {
    await task()
  } catch (error) {
    notify(error)
  }
}

// 折叠状态只是本机的浏览偏好。
const COLLAPSED_KEY = 'ew-agent-pi-collapsed-groups'
function readCollapsed(): string[] {
  try {
    const raw = appSettings.getItem(COLLAPSED_KEY)
    const value = raw ? JSON.parse(raw) : []
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
const collapsed = ref<string[]>(readCollapsed())
function toggleGroup(id: string) {
  collapsed.value = collapsed.value.includes(id)
    ? collapsed.value.filter(item => item !== id)
    : [...collapsed.value, id]
  try {
    appSettings.setItem(COLLAPSED_KEY, JSON.stringify(collapsed.value))
  } catch {
    /* 记不住折叠状态不影响使用 */
  }
}

const dragging = ref<PiSession | null>(null)
const dropTarget = ref<string | null>(null)
function allowDrop(event: DragEvent, target: string) {
  if (!dragging.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropTarget.value = target
}
function leaveDrop(target: string) {
  if (dropTarget.value === target) dropTarget.value = null
}
function endDrag() {
  dragging.value = null
  dropTarget.value = null
}
async function dropOn(target: string) {
  const session = dragging.value
  endDrag()
  if (!session || (session.groupId || '') === target) return
  await run(() => store.moveSession(session, target || null))
}

const menu = ref<{ handleOpen: () => void; handleClose: () => void }>()
const menuAnchor = ref<{ getBoundingClientRect: () => DOMRect; contextElement: HTMLElement }>()
const menuSession = ref<PiSession | null>(null)
const groupMenuId = ref<string | null>(null)
async function openMenu(session: PiSession, event: MouseEvent | KeyboardEvent) {
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)
  const x = pointer ? event.clientX : bounds.left + 16
  const y = pointer ? event.clientY : bounds.bottom
  menuSession.value = session
  // 共用一个菜单，避免被侧栏滚动区裁切，也避免为每条会话创建弹层。
  menuAnchor.value = { getBoundingClientRect: () => new DOMRect(x, y, 0, 0), contextElement: target }
  await nextTick()
  menu.value?.handleOpen()
}
async function onSessionCommand(command: string) {
  const session = menuSession.value
  if (!session) return
  if (command === 'pin') return run(() => store.pinSession(session, !session.pinnedAt))
  if (command === 'rename') return openRename(session)
  if (command.startsWith('move:')) return run(() => store.moveSession(session, command.slice(5) || null))
  if (command === 'archive')
    return run(async () => {
      await store.archiveSession(session)
      ElMessage.success('已归档到回收站')
    })
  if (command === 'delete') {
    try {
      await inkConfirm(
        `彻底删除「${session.title}」？对话记录、候选草稿和上传的附件原文都会删除，不能恢复。`,
        '彻底删除',
        { confirmButtonText: '彻底删除', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
    await run(() => store.deleteSession(session))
  }
}
async function onGroupCommand(group: PiSessionGroup, command: string) {
  if (command === 'rename') return openGroupForm(group)
  if (command !== 'delete') return
  const count = store.visibleSessions.filter(session => session.groupId === group.id).length
  try {
    await inkConfirm(
      count ? `删除分组「${group.name}」？其中 ${count} 个对话会回到未分组。` : `删除分组「${group.name}」？`,
      '删除分组',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await run(() => store.deleteGroup(group.id))
}

const nameInput = ref<HTMLInputElement>()
const nameForm = reactive({
  visible: false,
  title: '',
  label: '',
  value: '',
  max: 60,
  saving: false,
  submit: async (_value: string): Promise<unknown> => undefined
})
function openRename(session: PiSession) {
  Object.assign(nameForm, {
    visible: true,
    title: '重命名对话',
    label: '对话名称',
    value: session.title,
    max: 60,
    submit: (value: string) => store.renameSession(session, value)
  })
}
function openGroupForm(group?: PiSessionGroup) {
  Object.assign(nameForm, {
    visible: true,
    title: group ? '重命名分组' : '新建分组',
    label: '分组名称',
    value: group?.name || '',
    max: 40,
    submit: (value: string) => store.saveGroup(value, group?.id)
  })
}
async function submitName() {
  if (nameForm.saving) return
  nameForm.saving = true
  try {
    await nameForm.submit(nameForm.value)
    nameForm.visible = false
  } catch (error) {
    notify(error)
  } finally {
    nameForm.saving = false
  }
}

const searchVisible = ref(false)
const searchInput = ref<HTMLInputElement>()
const searchQuery = ref('')
const searching = ref(false)
const hits = ref<PiSessionSearchHit[]>([])
let searchTimer = 0
let searchSeq = 0
watch(searchQuery, query => {
  window.clearTimeout(searchTimer)
  const seq = ++searchSeq
  if (!query.trim()) {
    hits.value = []
    searching.value = false
    return
  }
  searching.value = true
  searchTimer = window.setTimeout(async () => {
    try {
      const result = await store.searchSessions(query)
      if (seq === searchSeq) hits.value = result
    } catch {
      if (seq === searchSeq) hits.value = []
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }, 250)
})
const searchResults = computed(() => mergeSearchResults(searchQuery.value, store.visibleSessions, hits.value))
function openSearch() {
  searchQuery.value = ''
  hits.value = []
  searchVisible.value = true
}
function pick(session: PiSession) {
  searchVisible.value = false
  emit('select', session)
}

const recycleVisible = ref(false)
const recycleBusy = ref(false)
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})
const formatTime = (at?: number | null) => (at ? timeFormat.format(at) : '')
function openRecycle() {
  recycleVisible.value = true
}
async function withRecycle(task: () => Promise<unknown>) {
  recycleBusy.value = true
  try {
    await run(task)
  } finally {
    recycleBusy.value = false
  }
}
const restore = (session: PiSession) => withRecycle(() => store.restoreSession(session))
async function purge(session: PiSession) {
  try {
    await inkConfirm(`彻底删除「${session.title}」？不能恢复。`, '彻底删除', {
      confirmButtonText: '彻底删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await withRecycle(() => store.deleteSession(session))
}
async function purgeAll() {
  const items = [...store.archivedSessions]
  try {
    await inkConfirm(`清空回收站？${items.length} 个对话会被彻底删除，不能恢复。`, '清空回收站', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await withRecycle(async () => {
    const failures: string[] = []
    for (const session of items) {
      try {
        await store.deleteSession(session)
      } catch (error) {
        failures.push(`${session.title}：${error instanceof Error ? error.message : error}`)
      }
    }
    if (failures.length) throw new Error(failures.join('；'))
  })
}

defineExpose({ openSearch, openRecycle })
</script>
