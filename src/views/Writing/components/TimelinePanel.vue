<template>
  <div class="panel-content timeline-panel" :class="{ popout: panelMode === 'popout' }">
    <div v-if="!hideHeader" class="panel-header">
      <span class="panel-title">{{ title }}</span>
      <div class="panel-actions">
        <button
class="action-icon" type="button" :title="panelMode === 'side' ? '新窗口打开' : '收回侧栏'"
          @click="panelMode === 'side' ? emit('popout') : emit('dock')">
          <i :class="panelMode === 'side' ? 'fa-solid fa-up-right-from-square' : 'fa-solid fa-arrow-right-to-bracket'"></i>
        </button>
        <button class="action-icon" type="button" title="关闭" @click="emit('close')">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>

    <div class="timeline-subtabs">
      <button
v-for="item in viewTabs" :key="item.value" type="button" :class="{ active: activeView === item.value }"
        @click="activeView = item.value">
        {{ item.label }}
      </button>
    </div>

    <div class="timeline-toolbar">
      <div class="filter-tabs">
        <button
v-for="item in filterOptions" :key="item.value" type="button" :class="{ active: activeFilter === item.value }"
          @click="activeFilter = item.value">
          {{ item.label }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="ink-btn-action" type="button" @click="openCreateModal()">
          <i class="fa-solid fa-plus"></i>
          <span>新建时间节点</span>
        </button>
        <button class="ink-btn-action" type="button" :disabled="aiLoading.extract" @click="extractFromChapter">
          <i :class="['fa-solid', aiLoading.extract ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
          <span>AI提取</span>
        </button>
        <button class="ink-btn-action" type="button" :disabled="aiLoading.gap" @click="fillGap">
          <i :class="['fa-solid', aiLoading.gap ? 'fa-spinner fa-spin' : 'fa-code-branch']"></i>
          <span>补全</span>
        </button>
        <button class="ink-btn-action" type="button" :disabled="aiLoading.conflict" @click="checkConflict">
          <i :class="['fa-solid', aiLoading.conflict ? 'fa-spinner fa-spin' : 'fa-triangle-exclamation']"></i>
          <span>检测</span>
        </button>
        <div class="sort-select">
          <i class="fa-solid fa-arrow-down-wide-short"></i>
          <span>排序：时间顺序</span>
        </div>
      </div>
    </div>

    <div class="timeline-body">
      <main class="timeline-main">
        <div v-if="loading" class="timeline-state">加载中...</div>
        <div v-else-if="!filteredEvents.length" class="timeline-state">
          <i class="fa-regular fa-clock"></i>
          <p>还没有时间节点</p>
          <button type="button" @click="openCreateModal()">新建第一个节点</button>
        </div>

        <section v-else-if="activeView === 'timeline'" class="timeline-axis-list">
          <article
v-for="(event, index) in filteredEvents" :key="event.id" class="time-row" :class="[
            `line-${event.lineType}`,
            { active: selectedEvent?.id === event.id }
          ]" draggable="true" @dragstart="startDrag(event)" @dragover.prevent @drop="dropOnEvent(event)" @click="selectEvent(event)">
            <div class="drag-handle"><i class="fa-solid fa-grip-vertical"></i></div>
            <div class="axis-mark">
              <span>{{ index + 1 }}</span>
            </div>
            <div class="time-card">
              <div class="card-top">
                <span>{{ event.timeLabel || event.timePoint || '未设置时间' }}</span>
                <em>{{ lineLabel(event.lineType) }}</em>
              </div>
              <h3>{{ event.title }}</h3>
              <p>{{ event.summary || '暂无摘要' }}</p>
              <div class="card-meta">
                <span>{{ chapterTitle(event.chapterId) }}</span>
                <span>{{ event.location || '地点未定' }}</span>
                <span>{{ eventBindingCount(event.id) }}个绑定</span>
              </div>
            </div>
          </article>
        </section>

        <section v-else-if="activeView === 'cards'" class="timeline-card-list">
          <article
v-for="event in filteredEvents" :key="event.id" class="event-tile" :class="[
            `line-${event.lineType}`,
            { active: selectedEvent?.id === event.id }
          ]" @click="selectEvent(event)">
            <span>{{ event.timeLabel || '未设置时间' }}</span>
            <h3>{{ event.title }}</h3>
            <p>{{ event.summary || '暂无摘要' }}</p>
            <div>
              <em>{{ chapterTitle(event.chapterId) }}</em>
              <em>{{ lineLabel(event.lineType) }}</em>
            </div>
          </article>
        </section>

        <section v-else class="chapter-relation-list">
          <article v-for="group in chapterGroups" :key="group.key" class="chapter-group">
            <h3>{{ group.title }}</h3>
            <div v-for="event in group.events" :key="event.id" class="chapter-event" @click="selectEvent(event)">
              <span>{{ event.timeLabel || '未设置时间' }}</span>
              <strong>{{ event.title }}</strong>
              <em>{{ eventBindingCount(event.id) }}个绑定</em>
            </div>
          </article>
        </section>
      </main>

      <aside class="timeline-detail" :class="{ side: panelMode === 'side' }">
        <template v-if="selectedEvent">
          <div class="detail-title">
            <span>节点详情</span>
            <div>
              <button type="button" title="编辑" @click="openEditModal(selectedEvent)">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button type="button" title="删除" @click="deleteEvent(selectedEvent)">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
          <label class="detail-field">
            <span>事件名称</span>
            <strong>{{ selectedEvent.title }}</strong>
          </label>
          <label class="detail-field">
            <span>时间位置</span>
            <strong>{{ selectedEvent.timeLabel || selectedEvent.timePoint || '未设置时间' }}</strong>
          </label>
          <label class="detail-field">
            <span>关联章节</span>
            <strong>{{ chapterTitle(selectedEvent.chapterId) }}</strong>
          </label>
          <label class="detail-field">
            <span>事件摘要</span>
            <p>{{ selectedEvent.summary || '暂无摘要' }}</p>
          </label>
          <div class="detail-section">
            <div class="section-head">
              <span>关联故事节点</span>
              <button type="button" @click="bindSelectedStoryNode">
                <i class="fa-solid fa-plus"></i>
                关联
              </button>
            </div>
            <el-select v-model="selectedStoryNodeId" clearable filterable class="ink-select" popper-class="ink-select-popper">
              <el-option v-for="node in storyNodes" :key="node.id" :label="node.title" :value="String(node.id)" />
            </el-select>
            <div class="tag-list">
              <span v-for="node in boundStoryNodes" :key="node.id">{{ node.title }}</span>
            </div>
          </div>
          <div class="detail-section">
            <div class="section-head">
              <span>正文锚点</span>
              <button type="button" @click="jumpSelectedAnchor">跳转</button>
            </div>
            <p>{{ selectedAnchor?.anchorText || '未绑定正文选区' }}</p>
          </div>
          <button class="delete-node-btn" type="button" @click="deleteEvent(selectedEvent)">
            <i class="fa-solid fa-trash-can"></i>
            删除节点
          </button>
        </template>
        <div v-else class="detail-empty">选择时间节点查看详情</div>
      </aside>
    </div>

    <section v-if="aiSuggestions.length || conflictIssues.length" class="suggestion-area">
      <div class="suggestion-title">
        <span>AI 建议区</span>
        <button type="button" @click="clearSuggestions">清空</button>
      </div>
      <article v-for="item in aiSuggestions" :key="item.id" class="suggestion-card">
        <div>
          <strong>{{ item.title }}</strong>
          <p>{{ item.summary }}</p>
        </div>
        <button type="button" :disabled="item.accepted" @click="acceptSuggestion(item)">
          {{ item.accepted ? '已采纳' : '采纳' }}
        </button>
      </article>
      <article v-for="item in conflictIssues" :key="item.id" class="issue-card">
        <strong>{{ item.title }}</strong>
        <p>{{ item.message }}</p>
        <em>{{ item.suggestion }}</em>
      </article>
    </section>

    <TimelineEventModal
      v-model:visible="eventModalVisible"
      :book-id="bookId"
      :event="editingEvent"
      :storylines="storylines"
      :chapters="chapters"
      :characters="characters"
      :settings="settings"
      :events="events"
      @save="handleEventSave"
    />
  </div>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { promptText } from '@/storage/local-prompts'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { showApiError } from '@/utils/api-error'
// 开源版：时间线数据走本地参考库（IndexedDB），函数形状对齐原服务端接口，调用点不动
import {
  getLocalBookTreeData as getBookTreeApi,
  listLocalCharacters as getCharacterListApi,
  getLocalWorldSettingTree as getWorldSettingTreeApi,
} from '@/storage/local-reference'
import {
  listLocalTimelineEvents as getTimelineEventListApi,
  addLocalTimelineEvent as addTimelineEventApi,
  updateLocalTimelineEvent as updateTimelineEventApi,
  deleteLocalTimelineEvents as deleteTimelineEventApi,
  saveLocalTimelineEventOrder as saveTimelineEventOrderApi,
  getLocalStorylineBundle as getStorylineListApi,
  addLocalPlotBinding as addPlotBindingApi,
} from '@/storage/local-reference-plot'
// 开源版：时间线 AI 走本地 BYOK 直连（结构化 JSON 输出）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildStructuredJsonMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import { parseAiJson } from '@/utils/ai-json'
import type { Character, WorldSetting, WorldSettingTreeFolder } from '@/types'
import type {
  PlotBinding,
  Storyline,
  StorylineNode,
  TimelineEvent,
  TimelineEventPayload,
  TimelineLineType,
} from '@/types/plot'
import TimelineEventModal from './TimelineEventModal.vue'

interface ChapterOption {
  id: number
  title: string
}

interface AiSuggestion {
  id: string
  title: string
  summary: string
  lineType: TimelineLineType
  timeLabel?: string
  accepted?: boolean
}

interface ConflictIssue {
  id: string
  title: string
  message: string
  suggestion: string
}

interface PlotSelectionDetail {
  type: 'bind-storyline' | 'bind-timeline' | 'create-plot-node'
  bookId?: string | number
  chapterId?: string | number | null
  chapterTitle?: string
  anchorStart?: number | null
  anchorEnd?: number | null
  anchorText?: string
  anchorLabel?: string
}

const props = defineProps<{
  title?: string
  bookId?: string | number
  panelMode?: 'side' | 'popout'
  hideHeader?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'popout'): void
  (e: 'dock'): void
}>()

const viewTabs = [
  { label: '时间轴', value: 'timeline' },
  { label: '卡片列表', value: 'cards' },
  { label: '关联章节', value: 'chapters' },
] as const
const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '主线', value: 'main' },
  { label: '支线', value: 'branch' },
  { label: '已绑定', value: 'bound' },
  { label: '未绑定', value: 'unbound' },
] as const

const store = useWritingEditorStore()
const activeView = ref<(typeof viewTabs)[number]['value']>('timeline')
const activeFilter = ref<(typeof filterOptions)[number]['value']>('all')
const loading = ref(false)
const events = ref<TimelineEvent[]>([])
const storylines = ref<Storyline[]>([])
const storyNodes = ref<StorylineNode[]>([])
const bindings = ref<PlotBinding[]>([])
const chapters = ref<ChapterOption[]>([])
const characters = ref<Character[]>([])
const settings = ref<WorldSetting[]>([])
const selectedEventId = ref<number | null>(null)
const selectedStoryNodeId = ref('')
const eventModalVisible = ref(false)
const editingEvent = ref<TimelineEvent | null>(null)
const pendingAnchor = ref<PlotSelectionDetail | null>(null)
const draggedEventId = ref<number | null>(null)
const aiLoading = reactive({ extract: false, gap: false, conflict: false })
const aiModelStore = useAiModelStore()
const ensureAiModel = async () => {
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) ElMessage.warning(NO_MODEL_MESSAGE)
  return modelCode
}
const aiSuggestions = ref<AiSuggestion[]>([])
const conflictIssues = ref<ConflictIssue[]>([])

const bookId = computed(() => props.bookId || '')
const panelMode = computed(() => props.panelMode || 'side')
const selectedEvent = computed(() => events.value.find(item => item.id === selectedEventId.value) || null)
const selectedEventBindings = computed(() => selectedEvent.value
  ? bindings.value.filter(item => String(item.timelineEventId || '') === String(selectedEvent.value?.id))
  : [])
const selectedAnchor = computed(() => selectedEventBindings.value.find(item => item.anchorText) || null)
const boundStoryNodes = computed(() => selectedEventBindings.value
  .map(item => storyNodes.value.find(node => String(node.id) === String(item.storylineNodeId || '')))
  .filter(Boolean) as StorylineNode[])
const filteredEvents = computed(() => {
  const list = [...events.value].sort((a, b) => Number(a.timeOrder || 0) - Number(b.timeOrder || 0) || Number(a.id) - Number(b.id))
  if (activeFilter.value === 'main' || activeFilter.value === 'branch') return list.filter(item => item.lineType === activeFilter.value)
  if (activeFilter.value === 'bound') return list.filter(item => eventBindingCount(item.id) > 0)
  if (activeFilter.value === 'unbound') return list.filter(item => eventBindingCount(item.id) === 0)
  return list
})
const chapterGroups = computed(() => {
  const map = new Map<string, { key: string; title: string; events: TimelineEvent[] }>()
  for (const event of filteredEvents.value) {
    const key = String(event.chapterId || 'none')
    if (!map.has(key)) {
      map.set(key, { key, title: chapterTitle(event.chapterId), events: [] })
    }
    map.get(key)?.events.push(event)
  }
  return Array.from(map.values())
})

const flattenChapters = (volumes: JsonRecord[]): ChapterOption[] => {
  const list: ChapterOption[] = []
  for (const volume of volumes) {
    for (const chapter of Array.isArray(volume?.children) ? volume.children : []) {
      list.push({ id: Number(chapter.id), title: chapter.title || `第${chapter.id}章` })
    }
  }
  return list
}

const flattenSettings = (folders: WorldSettingTreeFolder[]): WorldSetting[] => {
  const list: WorldSetting[] = []
  for (const folder of folders || []) {
    list.push(...(Array.isArray(folder.children) ? folder.children : []))
  }
  return list
}

const reload = async () => {
  if (!bookId.value) return
  loading.value = true
  try {
    const [eventRes, storylineRes, chapterRes, characterRes, settingRes] = await Promise.all([
      getTimelineEventListApi({ bookId: bookId.value }),
      getStorylineListApi({ bookId: bookId.value }),
      getBookTreeApi({ bookId: Number(bookId.value) }),
      getCharacterListApi({ bookId: String(bookId.value), page: 1, size: 500 }),
      getWorldSettingTreeApi({ bookId: bookId.value }),
    ])
    events.value = Array.isArray(eventRes.data) ? eventRes.data : []
    storylines.value = Array.isArray(storylineRes.data?.storylines) ? storylineRes.data.storylines : []
    storyNodes.value = Array.isArray(storylineRes.data?.nodes) ? storylineRes.data.nodes : []
    bindings.value = Array.isArray(storylineRes.data?.bindings) ? storylineRes.data.bindings : []
    chapters.value = flattenChapters(Array.isArray(chapterRes.data) ? chapterRes.data : [])
    characters.value = Array.isArray(characterRes.data?.list) ? characterRes.data.list : []
    settings.value = flattenSettings(Array.isArray(settingRes.data) ? settingRes.data : [])
    if (selectedEventId.value && !events.value.some(item => item.id === selectedEventId.value)) {
      selectedEventId.value = events.value[0]?.id || null
    }
  } catch (error) {
    console.error('加载时间线失败:', error)
    showApiError(error, '加载时间线失败')
  } finally {
    loading.value = false
  }
}

const openCreateModal = (anchor?: PlotSelectionDetail | null) => {
  editingEvent.value = null
  pendingAnchor.value = anchor || null
  eventModalVisible.value = true
}

const openEditModal = (event: TimelineEvent) => {
  editingEvent.value = event
  pendingAnchor.value = null
  eventModalVisible.value = true
}

const selectEvent = (event: TimelineEvent) => {
  selectedEventId.value = event.id
  selectedStoryNodeId.value = ''
}

const handleEventSave = async (payload: { event: TimelineEventPayload; parallelEvents: Array<{ title: string; lineType: TimelineLineType; summary: string }> }) => {
  try {
    let saved: TimelineEvent
    if (payload.event.id) {
      const { data } = await updateTimelineEventApi({ ...payload.event, id: payload.event.id })
      saved = data
    } else {
      const { data } = await addTimelineEventApi({
        ...payload.event,
        bookId: bookId.value,
        chapterId: payload.event.chapterId || (pendingAnchor.value?.chapterId ? String(pendingAnchor.value.chapterId) : ''),
        summary: payload.event.summary || pendingAnchor.value?.anchorText || '',
      })
      saved = data
    }
    for (const item of payload.parallelEvents || []) {
      if (!item.title.trim()) continue
      await addTimelineEventApi({
        bookId: bookId.value,
        title: item.title,
        lineType: item.lineType,
        summary: item.summary,
        timeLabel: payload.event.timeLabel,
        timeOrder: Number(payload.event.timeOrder || saved.timeOrder || 0) + 1,
        chapterId: payload.event.chapterId,
      })
    }
    if (pendingAnchor.value && !payload.event.id) {
      await addPlotBindingApi({
        bookId: bookId.value,
        timelineEventId: String(saved.id),
        chapterId: pendingAnchor.value.chapterId ? String(pendingAnchor.value.chapterId) : '',
        anchorStart: pendingAnchor.value.anchorStart ?? null,
        anchorEnd: pendingAnchor.value.anchorEnd ?? null,
        anchorText: pendingAnchor.value.anchorText || '',
        anchorLabel: pendingAnchor.value.anchorLabel || '',
      })
    }
    selectedEventId.value = saved.id
    eventModalVisible.value = false
    pendingAnchor.value = null
    await reload()
    ElMessage.success('时间节点已保存')
  } catch (error) {
    console.error('保存时间节点失败:', error)
    showApiError(error, '保存时间节点失败')
  }
}

const deleteEvent = async (event: TimelineEvent) => {
  try {
    await inkConfirm(`确定删除时间节点「${event.title}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await deleteTimelineEventApi({ ids: [event.id] })
    if (selectedEventId.value === event.id) selectedEventId.value = null
    await reload()
    ElMessage.success('时间节点已删除')
  } catch (error) {
    if (error === 'cancel') return
    showApiError(error, '删除时间节点失败')
  }
}

const startDrag = (event: TimelineEvent) => {
  draggedEventId.value = event.id
}

const dropOnEvent = async (target: TimelineEvent) => {
  const sourceId = draggedEventId.value
  draggedEventId.value = null
  if (!sourceId || sourceId === target.id) return
  const sorted = [...events.value].sort((a, b) => Number(a.timeOrder || 0) - Number(b.timeOrder || 0) || Number(a.id) - Number(b.id))
  const sourceIndex = sorted.findIndex(item => item.id === sourceId)
  const targetIndex = sorted.findIndex(item => item.id === target.id)
  if (sourceIndex < 0 || targetIndex < 0) return
  const [source] = sorted.splice(sourceIndex, 1)
  sorted.splice(targetIndex, 0, source)
  sorted.forEach((item, index) => {
    item.timeOrder = (index + 1) * 10
  })
  events.value = sorted
  try {
    await saveTimelineEventOrderApi({
      bookId: bookId.value,
      orders: sorted.map(item => ({ id: item.id, timeOrder: item.timeOrder })),
    })
    ElMessage.success('时间顺序已保存')
  } catch (error) {
    showApiError(error, '保存时间顺序失败')
    await reload()
  }
}

const bindSelectedStoryNode = async () => {
  if (!selectedEvent.value || !selectedStoryNodeId.value) {
    ElMessage.warning('请选择故事节点')
    return
  }
  try {
    await addPlotBindingApi({
      bookId: bookId.value,
      timelineEventId: String(selectedEvent.value.id),
      storylineNodeId: selectedStoryNodeId.value,
      chapterId: selectedEvent.value.chapterId || '',
    })
    selectedStoryNodeId.value = ''
    await reload()
    ElMessage.success('已关联故事节点')
  } catch (error) {
    showApiError(error, '关联故事节点失败')
  }
}

const handlePlotSelection = (event: Event) => {
  const detail = (event as CustomEvent<PlotSelectionDetail>).detail
  if (!detail || String(detail.bookId || '') !== String(bookId.value || '')) return
  if (detail.type !== 'bind-timeline') return
  if (selectedEvent.value) {
    addPlotBindingApi({
      bookId: bookId.value,
      timelineEventId: String(selectedEvent.value.id),
      chapterId: detail.chapterId ? String(detail.chapterId) : '',
      anchorStart: detail.anchorStart ?? null,
      anchorEnd: detail.anchorEnd ?? null,
      anchorText: detail.anchorText || '',
      anchorLabel: detail.anchorLabel || '',
    })
      .then(() => {
        ElMessage.success('已绑定到时间节点')
        return reload()
      })
      .catch(error => showApiError(error, '绑定时间节点失败'))
    return
  }
  activeView.value = 'timeline'
  openCreateModal(detail)
}

const jumpSelectedAnchor = () => {
  const anchor = selectedAnchor.value
  if (!anchor) {
    ElMessage.warning('当前节点未绑定正文锚点')
    return
  }
  window.dispatchEvent(new CustomEvent('ew-writing-plot-anchor-jump', {
    detail: {
      chapterId: anchor.chapterId,
      anchorStart: anchor.anchorStart,
      anchorEnd: anchor.anchorEnd,
      anchorText: anchor.anchorText,
    },
  }))
}

const buildTimelineText = () => events.value.map(item => `${item.timeLabel || '未设置'} | ${item.title} | ${item.summary || ''}`).join('\n')
const buildStorylineText = () => storyNodes.value.map(item => `${item.title} | ${item.summary || ''}`).join('\n')

const extractFromChapter = async () => {
  if (!store.activeChapterId || !store.activeChapterTextContent.trim()) {
    ElMessage.warning('请先打开有正文的章节')
    return
  }
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiLoading.extract = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'timeline_ai',
      sceneLabel: '时间线分析',
      modelCode,
      messages: buildStructuredJsonMessages({
        task: promptText('structured-analysis', 'timelineExtract'),
        materials: {
          '本章': store.activeChapterTitle || '',
          '本章目标': store.activeChapterSummary || '',
          '已有故事线': storylines.value.map(item => item.title).join('、'),
          '章节正文': store.activeChapterTextContent,
        },
        shape: promptText('structured-analysis', 'timelineShape'),
        limit: 5,
      }),
    })
    const parsed = parseAiJson(data, ['events'])
    aiSuggestions.value = (Array.isArray(parsed?.events) ? parsed.events : []).map((item: JsonRecord, index: number) => ({
      id: `${Date.now()}-${index}`,
      title: String(item?.title || `时间节点${index + 1}`).slice(0, 80),
      summary: String(item?.summary || '').slice(0, 240),
      timeLabel: String(item?.timeLabel || ''),
      lineType: item?.lineType === 'branch' ? 'branch' : 'main',
    }))
    if (!aiSuggestions.value.length) ElMessage.warning('AI 暂无可用时间节点')
  } catch (error) {
    console.error('提取时间节点失败:', error)
    showApiError(error, '提取时间节点失败')
  } finally {
    aiLoading.extract = false
  }
}

const fillGap = async () => {
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiLoading.gap = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'timeline_ai',
      sceneLabel: '时间线分析',
      modelCode,
      messages: buildStructuredJsonMessages({
        task: promptText('structured-analysis', 'timelineFill'),
        materials: {
          '现有时间线': buildTimelineText(),
          '故事节点': buildStorylineText(),
        },
        shape: promptText('structured-analysis', 'timelineShape'),
        limit: 5,
      }),
    })
    const parsed = parseAiJson(data, ['events'])
    aiSuggestions.value = (Array.isArray(parsed?.events) ? parsed.events : []).map((item: JsonRecord, index: number) => ({
      id: `${Date.now()}-gap-${index}`,
      title: String(item?.title || `补全节点${index + 1}`).slice(0, 80),
      summary: String(item?.summary || item?.reason || '').slice(0, 240),
      timeLabel: String(item?.timeLabel || ''),
      lineType: item?.lineType === 'branch' ? 'branch' : 'main',
    }))
    if (!aiSuggestions.value.length) ElMessage.warning('AI 暂无补全建议')
  } catch (error) {
    console.error('补全时间线失败:', error)
    showApiError(error, '补全时间线失败')
  } finally {
    aiLoading.gap = false
  }
}

const checkConflict = async () => {
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiLoading.conflict = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'timeline_ai',
      sceneLabel: '时间线分析',
      modelCode,
      messages: buildStructuredJsonMessages({
        task: promptText('structured-analysis', 'timelineCheck'),
        materials: {
          '现有时间线': buildTimelineText(),
          '故事节点': buildStorylineText(),
        },
        shape: promptText('structured-analysis', 'timelineIssueShape'),
      }),
    })
    const parsed = parseAiJson(data, ['issues'])
    conflictIssues.value = (Array.isArray(parsed?.issues) ? parsed.issues : []).map((item: JsonRecord, index: number) => ({
      id: `${Date.now()}-issue-${index}`,
      title: String(item?.title || `矛盾点${index + 1}`).slice(0, 80),
      message: String(item?.message || item?.description || '').slice(0, 240),
      suggestion: String(item?.suggestion || '').slice(0, 240),
    }))
    if (!conflictIssues.value.length) ElMessage.success('未发现明显时间矛盾')
  } catch (error) {
    console.error('检测时间矛盾失败:', error)
    showApiError(error, '检测时间矛盾失败')
  } finally {
    aiLoading.conflict = false
  }
}

const acceptSuggestion = async (item: AiSuggestion) => {
  try {
    const { data } = await addTimelineEventApi({
      bookId: bookId.value,
      title: item.title,
      lineType: item.lineType,
      summary: item.summary,
      timeLabel: item.timeLabel || '',
      chapterId: store.activeChapterId ? String(store.activeChapterId) : '',
    })
    item.accepted = true
    selectedEventId.value = data.id
    await reload()
    ElMessage.success('AI 建议已采纳')
  } catch (error) {
    showApiError(error, '采纳时间节点失败')
  }
}

const clearSuggestions = () => {
  aiSuggestions.value = []
  conflictIssues.value = []
}

const eventBindingCount = (eventId: number) => bindings.value.filter(item => String(item.timelineEventId || '') === String(eventId)).length
const chapterTitle = (id?: string | number | null) => chapters.value.find(item => String(item.id) === String(id))?.title || '未绑定章节'
const lineLabel = (value?: TimelineLineType) => value === 'branch' ? '支线' : '主线'

watch(bookId, reload, { immediate: true })

onMounted(() => {
  window.addEventListener('ew-writing-plot-selection', handlePlotSelection as EventListener)
})

onBeforeUnmount(() => {
  window.removeEventListener('ew-writing-plot-selection', handlePlotSelection as EventListener)
})
</script>

<style scoped lang="scss">
.timeline-panel {
  --line-main: color-mix(in srgb, var(--ink-accent) 68%, var(--ink-main));
  --line-branch: color-mix(in srgb, var(--ink-warning) 60%, var(--ink-main));
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  color: var(--ink-main);
}

.panel-header {
  height: 40px;
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-glass-bg) 70%, transparent);

  .panel-title {
    font-size: calc(14px * var(--ui-font-scale, 1));
    font-weight: 700;
    color: var(--ink-main);
  }

  .panel-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .action-icon {
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-sec);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.2s ease, color 0.2s ease;

    &:hover {
      background: var(--ui-glass-bg);
      color: var(--ink-main);
    }
  }
}

.timeline-subtabs,
.timeline-toolbar,
.filter-tabs,
.toolbar-actions,
.detail-title,
.section-head,
.suggestion-title {
  display: flex;
  align-items: center;
}

.timeline-subtabs {
  padding: 10px 16px;
  gap: 6px;
  border-bottom: 1px solid var(--ui-border);

  button {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--ui-glass-bg) 54%, transparent);
    color: var(--ink-sec);
    cursor: pointer;

    &.active {
      background: color-mix(in srgb, var(--ink-accent) 14%, var(--ui-glass-bg));
      color: var(--ink-main);
      border-color: color-mix(in srgb, var(--ink-accent) 38%, var(--ui-border));
    }
  }
}

.timeline-toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
}

.filter-tabs {
  gap: 6px;

  button {
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;

    &.active {
      background: color-mix(in srgb, var(--ink-accent) 14%, transparent);
      color: var(--ink-main);
      border-color: color-mix(in srgb, var(--ink-accent) 36%, var(--ui-border));
    }
  }
}

.toolbar-actions {
  flex-wrap: wrap;
  gap: 8px;

  .ink-btn-action {
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}

.sort-select {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-glass-bg);
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.timeline-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 30%);
}

.timeline-main {
  min-width: 0;
  overflow: auto;
  padding: 12px;
}

.timeline-axis-list {
  position: relative;
}

.time-row {
  display: grid;
  grid-template-columns: 24px 34px minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
  margin-bottom: 10px;
  cursor: pointer;

  &.active .time-card {
    border-color: color-mix(in srgb, var(--ink-accent) 60%, var(--ui-border));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink-accent) 16%, transparent);
  }
}

.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-sec);
  cursor: grab;
}

.axis-mark {
  position: relative;
  display: flex;
  justify-content: center;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: -12px;
    width: 2px;
    background: color-mix(in srgb, var(--ink-accent) 34%, var(--ui-border));
  }

  span {
    position: relative;
    z-index: 1;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--bg-main);
    border: 2px solid var(--line-main);
    color: var(--ink-main);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.time-card,
.event-tile,
.chapter-group,
.timeline-detail {
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-glass-bg) 82%, transparent);
}

.time-card {
  padding: 12px;
  border-left: 3px solid var(--line-main);

  .line-branch & {
    border-left-color: var(--line-branch);
  }

  h3 {
    margin: 6px 0;
    font-size: calc(15px * var(--ui-font-scale, 1));
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: var(--ink-sec);
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.55;
  }
}

.card-top,
.card-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  em {
    font-style: normal;
  }
}

.card-meta {
  margin-top: 8px;
  flex-wrap: wrap;
  justify-content: flex-start;
}

.timeline-card-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.event-tile {
  padding: 12px;
  border-top: 3px solid var(--line-main);
  cursor: pointer;

  &.line-branch {
    border-top-color: var(--line-branch);
  }

  &.active {
    border-color: color-mix(in srgb, var(--ink-accent) 60%, var(--ui-border));
  }

  span,
  em {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-style: normal;
  }

  h3 {
    margin: 6px 0;
    font-size: calc(14px * var(--ui-font-scale, 1));
  }

  p {
    margin: 0 0 8px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.5;
  }

  div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
}

.chapter-relation-list {
  display: grid;
  gap: 10px;
}

.chapter-group {
  padding: 12px;

  h3 {
    margin: 0 0 8px;
    font-size: calc(14px * var(--ui-font-scale, 1));
  }
}

.chapter-event {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  min-height: 32px;
  border-top: 1px solid var(--ui-border);
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;

  strong {
    color: var(--ink-main);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  em {
    font-style: normal;
  }
}

.timeline-detail {
  min-width: 0;
  overflow: auto;
  padding: 12px;
  border-width: 0 0 0 1px;
  border-radius: 0;
  background: color-mix(in srgb, var(--ui-glass-bg) 76%, transparent);

  &.side {
    min-width: 220px;
  }
}

.detail-title {
  justify-content: space-between;
  margin-bottom: 12px;

  span {
    font-weight: 700;
  }

  div {
    display: flex;
    gap: 6px;
  }

  button {
    width: 28px;
    height: 28px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;
  }
}

.detail-field {
  display: block;
  margin-bottom: 12px;

  span {
    display: block;
    margin-bottom: 5px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  strong,
  p {
    margin: 0;
    color: var(--ink-main);
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.55;
  }
}

.detail-section {
  margin-top: 14px;
}

.section-head {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  button {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px;
    border: 1px solid var(--ui-border);
    border-radius: 5px;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
  }
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;

  span {
    max-width: 100%;
    padding: 4px 7px;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.delete-node-btn {
  width: 100%;
  height: 32px;
  margin-top: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--ink-warning) 38%, var(--ui-border));
  border-radius: 6px;
  background: transparent;
  color: var(--ink-warning);
  cursor: pointer;
}

.detail-empty,
.timeline-state {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ink-sec);
  text-align: center;
}

.timeline-state button {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  cursor: pointer;
}

.suggestion-area {
  max-height: 190px;
  overflow: auto;
  border-top: 1px solid var(--ui-border);
  padding: 10px 12px;
}

.suggestion-title {
  justify-content: space-between;
  color: var(--ink-sec);
  font-size: calc(13px * var(--ui-font-scale, 1));

  button {
    border: 0;
    background: transparent;
    color: var(--ink-accent);
    cursor: pointer;
  }
}

.suggestion-card,
.issue-card {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-glass-bg);

  p {
    margin: 4px 0 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  em {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-style: normal;
  }

  > div {
    min-width: 0;
  }

  button {
    flex-shrink: 0;
    white-space: nowrap;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--ink-accent) 14%, transparent);
    color: var(--ink-main);
    cursor: pointer;
  }
}

@media (max-width: 900px) {
  .timeline-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .timeline-detail {
    border-top: 1px solid var(--ui-border);
    border-left: 0;
    max-height: 320px;
  }

  .toolbar-actions,
  .filter-tabs {
    width: 100%;
  }
}
</style>
