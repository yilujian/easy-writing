<template>
  <div class="panel-content story-panel" :class="{ popout: panelMode === 'popout' }">
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

    <div class="story-subtabs">
      <button
v-for="item in storyTabs" :key="item.value" type="button" :class="{ active: activeTab === item.value }"
        @click="activeTab = item.value">
        {{ item.label }}
      </button>
    </div>

    <div class="story-body">
      <section v-if="activeTab === 'mindmap'" class="mindmap-shell">
        <Teleport to="body" :disabled="!fullscreen">
          <div class="mindmap-stage" :class="{ fullscreen }">
            <div class="mindmap-toolbar">
              <button class="ink-btn-action" type="button" @click="openCreateNode()">
                <i class="fa-solid fa-plus"></i>
                <span>新建节点</span>
              </button>
              <button class="ink-btn-action" type="button" :disabled="aiLoading" @click="generateStorylineSuggestions">
                <i :class="['fa-solid', aiLoading ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
                <span>AI生成</span>
              </button>
              <button class="ink-btn-action" type="button" @click="autoArrangeNodes">
                <i class="fa-solid fa-sitemap"></i>
                <span>自动整理</span>
              </button>
              <div class="zoom-group">
                <button type="button" @click="graphRef?.setZoom((graphRef?.zoom || 1) - 0.1)">-</button>
                <span>{{ Math.round((graphRef?.zoom || 1) * 100) }}%</span>
                <button type="button" @click="graphRef?.setZoom((graphRef?.zoom || 1) + 0.1)">+</button>
              </div>
              <button class="ink-btn-action" type="button" @click="graphRef?.fitCanvas(panelMode === 'side' ? 0.78 : 1)">
                <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                <span>适应画布</span>
              </button>
              <label class="mainline-check">
                <input v-model="onlyMainline" type="checkbox" />
                <span>仅看主线</span>
              </label>
              <button class="icon-action" type="button" :title="fullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
                <i :class="fullscreen ? 'fa-solid fa-compress' : 'fa-solid fa-expand'"></i>
              </button>
            </div>

            <div v-if="loading" class="plot-state">加载中...</div>
            <div v-else-if="!visibleNodes.length" class="plot-state">
              <i class="fa-regular fa-note-sticky"></i>
              <p>还没有故事节点</p>
              <button type="button" @click="openCreateNode()">新建第一个节点</button>
              <span class="plot-state-hint">也可右键画布空白处新建；从节点四周圆点拖线即可连接</span>
            </div>
            <GraphCanvas
              v-else
              ref="graphRef"
              :nodes="graphNodes"
              :edges="graphEdges"
              :node-width="180"
              :node-height="130"
              :selected-id="selectedNodeId"
              show-minimap
              @connect="handleGraphConnect"
              @connect-empty="handleGraphConnectEmpty"
              @node-moved="handleGraphNodeMoved"
              @node-click="id => (selectedNodeId = id)"
              @node-context="openGraphNodeMenu"
              @canvas-click="handleGraphCanvasClick"
              @canvas-context="openGraphCanvasMenu"
              @edge-context="openGraphEdgeMenu"
            >
              <template #node="{ node }">
                <div
                  v-if="nodeRecord(node.id)"
                  class="mind-card"
                  :class="`node-${nodeRecord(node.id)!.nodeType}`"
                  @dblclick.stop="openEditNode(nodeRecord(node.id)!)"
                >
                  <div class="node-top">
                    <span>{{ nodeTypeLabel(nodeRecord(node.id)!.nodeType) }}</span>
                    <em>{{ nodeStatusLabel(nodeRecord(node.id)!.status) }}</em>
                  </div>
                  <h3>{{ nodeRecord(node.id)!.title }}</h3>
                  <p>{{ nodeRecord(node.id)!.summary || '暂无摘要' }}</p>
                  <div class="node-meta">
                    <span>{{ chapterRangeText(nodeRecord(node.id)!) }}</span>
                    <span>{{ bindingCount(node.id) }}个绑定</span>
                  </div>
                </div>
              </template>
            </GraphCanvas>

            <GraphMenu
              v-if="graphMenu"
              :x="graphMenu.clientX"
              :y="graphMenu.clientY"
              :items="graphMenuItems"
              @select="handleGraphMenuSelect"
              @close="graphMenu = null"
            />
          </div>
        </Teleport>
      </section>

      <section v-else-if="activeTab === 'timeline'" class="story-timeline-view">
        <div v-if="!timelineEvents.length" class="plot-state">还没有关联时间节点</div>
        <article v-for="event in timelineEvents" :key="event.id" class="story-time-card" :class="`line-${event.lineType}`">
          <div class="time-dot"></div>
          <div>
            <span>{{ event.timeLabel || '未设置时间' }}</span>
            <h3>{{ event.title }}</h3>
            <p>{{ event.summary || '暂无摘要' }}</p>
            <em>{{ chapterTitle(event.chapterId) }}</em>
          </div>
        </article>
      </section>

      <section v-else class="binding-view">
        <div class="binding-head">
          <div>
            <strong>绑定关系</strong>
            <span>正文选区、故事节点、时间节点和章节路径的关联</span>
          </div>
          <button class="ink-btn-action" type="button" @click="reload">
            <i class="fa-solid fa-rotate"></i>
            <span>刷新</span>
          </button>
        </div>
        <div v-if="!bindingChains.length" class="plot-state">还没有正文绑定关系</div>
        <div v-for="chain in bindingChains" :key="chain.key" class="binding-chain">
          <article class="relation-card story-card">
            <span>故事节点</span>
            <strong>{{ chain.node?.title || '未绑定' }}</strong>
            <p>{{ chain.node?.summary || '暂无故事节点摘要' }}</p>
            <button v-if="chain.node" type="button" @click="openEditNode(chain.node)">编辑</button>
          </article>
          <i class="fa-solid fa-arrow-right"></i>
          <article class="relation-card time-card">
            <span>时间节点</span>
            <strong>{{ chain.event?.title || '未绑定' }}</strong>
            <p>{{ chain.event?.summary || '暂无时间节点摘要' }}</p>
          </article>
          <i class="fa-solid fa-arrow-right"></i>
          <article class="relation-card chapter-card">
            <span>章节路径</span>
            <strong>{{ chapterTitle(chain.chapterId) }}</strong>
            <p>{{ chain.anchorText || '未绑定正文锚点' }}</p>
            <button type="button" @click="jumpToAnchor(chain)">跳转定位</button>
          </article>
          <button class="unbind-btn" type="button" @click="unbindChain(chain)">
            <i class="fa-solid fa-link-slash"></i>
            <span>解除绑定</span>
          </button>
        </div>
      </section>
    </div>

    <section v-if="aiSuggestions.length" class="suggestion-area">
      <div class="suggestion-title">
        <span>AI 故事线建议</span>
        <button type="button" @click="aiSuggestions = []">清空</button>
      </div>
      <article v-for="item in aiSuggestions" :key="item.id" class="suggestion-card">
        <div>
          <strong>{{ item.title }}</strong>
          <p>{{ item.summary }}</p>
        </div>
        <button type="button" :disabled="item.accepted" @click="acceptStorySuggestion(item)">
          {{ item.accepted ? '已采纳' : '采纳' }}
        </button>
      </article>
    </section>

    <StorylineNodeModal
      v-model:visible="nodeModalVisible"
      :book-id="bookId"
      :node="editingNode"
      :storylines="storylines"
      :nodes="nodes"
      :chapters="chapters"
      :characters="characters"
      :settings="settings"
      :anchor="pendingAnchor"
      @save="handleNodeSave"
    />
  </div>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { promptText } from '@/storage/local-prompts'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { showApiError } from '@/utils/api-error'
// 开源版：故事线数据走本地参考库（IndexedDB），函数形状对齐原服务端接口，调用点不动
import {
  getLocalBookTreeData as getBookTreeApi,
  listLocalCharacters as getCharacterListApi,
  getLocalWorldSettingTree as getWorldSettingTreeApi,
} from '@/storage/local-reference'
import {
  getLocalStorylineBundle as getStorylineListApi,
  addLocalStoryline as addStorylineApi,
  addLocalStorylineNode as addStorylineNodeApi,
  updateLocalStorylineNode as updateStorylineNodeApi,
  deleteLocalStorylineNodes as deleteStorylineNodeApi,
  saveLocalStorylineNodePositions as saveStorylineNodePositionApi,
  saveLocalStorylineNodeRelations as saveStorylineNodeRelationApi,
  addLocalPlotBinding as addPlotBindingApi,
  deleteLocalPlotBindings as deletePlotBindingApi,
} from '@/storage/local-reference-plot'
// 开源版：故事线 AI 走本地 BYOK 直连（结构化 JSON 输出）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildStructuredJsonMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import GraphCanvas from './graph/GraphCanvas.vue'
import GraphMenu, { type GraphMenuItem } from './graph/GraphMenu.vue'
import { parseAiJson } from '@/utils/ai-json'
import type { Character, WorldSetting, WorldSettingTreeFolder } from '@/types'
import type {
  PlotBinding,
  Storyline,
  StorylineNode,
  StorylineNodePayload,
  StorylineNodeRelation,
  StorylineNodeType,
  TimelineEvent,
} from '@/types/plot'
import StorylineNodeModal from './StorylineNodeModal.vue'

interface ChapterOption {
  id: number
  title: string
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

interface BindingChain {
  key: string
  bindingIds: number[]
  node?: StorylineNode
  event?: TimelineEvent
  chapterId?: string | null
  anchorStart?: number | null
  anchorEnd?: number | null
  anchorText?: string
}

interface AiStorySuggestion {
  id: string
  title: string
  lineType: Storyline['lineType']
  summary: string
  accepted?: boolean
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

const storyTabs = [
  { label: '思维导图', value: 'mindmap' },
  { label: '时间轴', value: 'timeline' },
  { label: '绑定关系', value: 'binding' },
] as const

const activeTab = ref<(typeof storyTabs)[number]['value']>('mindmap')
const loading = ref(false)
const storylines = ref<Storyline[]>([])
const nodes = ref<StorylineNode[]>([])
const nodeRelations = ref<StorylineNodeRelation[]>([])
const timelineEvents = ref<TimelineEvent[]>([])
const bindings = ref<PlotBinding[]>([])
const chapters = ref<ChapterOption[]>([])
const characters = ref<Character[]>([])
const settings = ref<WorldSetting[]>([])
const selectedNodeId = ref<number | null>(null)
const nodeModalVisible = ref(false)
const editingNode = ref<StorylineNode | null>(null)
const pendingAnchor = ref<PlotSelectionDetail | null>(null)
const pendingParentNodeId = ref<number | null>(null)
const pendingSiblingNodeId = ref<number | null>(null)
const onlyMainline = ref(false)
const fullscreen = ref(false)
const aiLoading = ref(false)
const aiModelStore = useAiModelStore()
const aiSuggestions = ref<AiStorySuggestion[]>([])

const bookId = computed(() => props.bookId || '')
const panelMode = computed(() => props.panelMode || 'side')
const selectedNode = computed(() => nodes.value.find(item => item.id === selectedNodeId.value) || null)
const mainStorylineIds = computed(() => new Set(storylines.value.filter(item => item.lineType === 'main').map(item => String(item.id))))
const visibleNodes = computed(() => {
  if (!onlyMainline.value) return nodes.value
  return nodes.value.filter(item => mainStorylineIds.value.has(String(item.storylineId)))
})
const visibleNodeIds = computed(() => new Set(visibleNodes.value.map(item => String(item.id))))

const graphRef = ref<InstanceType<typeof GraphCanvas> | null>(null)
const graphMenu = ref<{
  type: 'canvas' | 'node' | 'edge' | 'connect-empty'
  clientX: number
  clientY: number
  pos?: { x: number; y: number }
  nodeId?: number
  edgeKey?: string
  fromId?: number
} | null>(null)
// 右键/拖线新建时暂存：目标位置与待连接的源节点，随本次弹窗保存消费
const pendingCreatePosition = ref<{ x: number; y: number } | null>(null)
const pendingLinkFromNodeId = ref<number | null>(null)

const graphNodes = computed(() => visibleNodes.value.map(node => ({
  id: Number(node.id),
  x: Number(node.positionX || 0),
  y: Number(node.positionY || 0),
})))

const edgeKeyOf = (relation: StorylineNodeRelation) =>
  `${relation.fromNodeId}|${relation.toNodeId}|${relation.relationType}`

const graphEdges = computed(() => nodeRelations.value
  .filter(item => visibleNodeIds.value.has(String(item.fromNodeId)) && visibleNodeIds.value.has(String(item.toNodeId)))
  .map(item => ({
    id: edgeKeyOf(item),
    from: Number(item.fromNodeId),
    to: Number(item.toNodeId),
    className: `line-${item.relationType}`,
  })))

const nodeRecord = (id: number) => nodes.value.find(item => Number(item.id) === Number(id)) || null

const graphMenuItems = computed<GraphMenuItem[]>(() => {
  if (!graphMenu.value) return []
  if (graphMenu.value.type === 'canvas') {
    return [{ key: 'create', label: '新建节点', icon: 'fa-solid fa-plus' }]
  }
  if (graphMenu.value.type === 'connect-empty') {
    return [{ key: 'create-link', label: '新建节点并连线', icon: 'fa-solid fa-link' }]
  }
  if (graphMenu.value.type === 'node') {
    return [
      { key: 'edit', label: '编辑节点', icon: 'fa-solid fa-pen' },
      { key: 'branch', label: '加分支', icon: 'fa-solid fa-code-branch' },
      { key: 'sibling', label: '加同级', icon: 'fa-solid fa-plus' },
      { key: 'delete-node', label: '删除节点', icon: 'fa-solid fa-trash-can', danger: true },
    ]
  }
  return [{ key: 'delete-edge', label: '删除连线', icon: 'fa-solid fa-link-slash', danger: true }]
})

const handleGraphCanvasClick = () => {
  selectedNodeId.value = null
  graphMenu.value = null
}

const openGraphCanvasMenu = (pos: { x: number; y: number }, client: { x: number; y: number }) => {
  graphMenu.value = { type: 'canvas', clientX: client.x, clientY: client.y, pos }
}

const openGraphNodeMenu = (id: number, _pos: { x: number; y: number }, client: { x: number; y: number }) => {
  selectedNodeId.value = id
  graphMenu.value = { type: 'node', clientX: client.x, clientY: client.y, nodeId: id }
}

const openGraphEdgeMenu = (id: string | number, client: { x: number; y: number }) => {
  graphMenu.value = { type: 'edge', clientX: client.x, clientY: client.y, edgeKey: String(id) }
}

const handleGraphMenuSelect = async (key: string) => {
  const current = graphMenu.value
  graphMenu.value = null
  if (!current) return
  if (key === 'create' && current.pos) {
    await openCreateNode()
    pendingCreatePosition.value = current.pos
  } else if (key === 'create-link' && current.pos && current.fromId) {
    await openCreateNode()
    pendingCreatePosition.value = current.pos
    pendingLinkFromNodeId.value = current.fromId
  } else if (key === 'edit' && current.nodeId) {
    const record = nodeRecord(current.nodeId)
    if (record) openEditNode(record)
  } else if (key === 'branch' && current.nodeId) {
    selectedNodeId.value = current.nodeId
    await openCreateBranch()
  } else if (key === 'sibling' && current.nodeId) {
    selectedNodeId.value = current.nodeId
    await openCreateSibling()
  } else if (key === 'delete-node' && current.nodeId) {
    const record = nodeRecord(current.nodeId)
    if (record) await deleteNode(record)
  } else if (key === 'delete-edge' && current.edgeKey) {
    await deleteRelationByKey(current.edgeKey)
  }
}

/** 端口拖线到节点：直接建 link 连线（同向重复拦下） */
const handleGraphConnect = async (fromId: number, toId: number) => {
  const exists = nodeRelations.value.some(
    item => String(item.fromNodeId) === String(fromId) && String(item.toNodeId) === String(toId)
  )
  if (exists) {
    ElMessage.info('这两个节点已有同向连线')
    return
  }
  try {
    nodeRelations.value = await saveNodeRelations([
      ...nodeRelations.value,
      { fromNodeId: String(fromId), toNodeId: String(toId), relationType: 'link', strength: 3 },
    ])
    ElMessage.success('连线已保存')
  } catch (error) {
    showApiError(error, '保存连线失败')
  }
}

const handleGraphConnectEmpty = (fromId: number, pos: { x: number; y: number }, client: { x: number; y: number }) => {
  graphMenu.value = { type: 'connect-empty', clientX: client.x, clientY: client.y, pos, fromId }
}

const deleteRelationByKey = async (key: string) => {
  const index = nodeRelations.value.findIndex(item => edgeKeyOf(item) === key)
  if (index < 0) return
  try {
    const next = nodeRelations.value.filter((_, i) => i !== index)
    nodeRelations.value = await saveNodeRelations(next)
    ElMessage.success('连线已删除')
  } catch (error) {
    showApiError(error, '删除连线失败')
  }
}

const handleGraphNodeMoved = async (id: number, pos: { x: number; y: number }) => {
  const node = nodeRecord(id)
  if (node) {
    node.positionX = pos.x
    node.positionY = pos.y
  }
  try {
    await saveStorylineNodePositionApi({
      bookId: bookId.value,
      positions: [{ id, positionX: pos.x, positionY: pos.y }],
    })
  } catch (error) {
    showApiError(error, '保存节点位置失败')
  }
}
const bindingChains = computed<BindingChain[]>(() => {
  const map = new Map<string, BindingChain>()
  for (const item of bindings.value) {
    const key = [
      item.chapterId || 'chapter',
      item.anchorStart ?? 'start',
      item.anchorEnd ?? 'end',
      item.anchorText || item.id,
    ].join(':')
    const current = map.get(key) || {
      key,
      bindingIds: [],
      chapterId: item.chapterId || null,
      anchorStart: item.anchorStart ?? null,
      anchorEnd: item.anchorEnd ?? null,
      anchorText: item.anchorText || '',
    }
    current.bindingIds.push(item.id)
    if (item.storylineNodeId) current.node = nodes.value.find(node => String(node.id) === String(item.storylineNodeId))
    if (item.timelineEventId) current.event = timelineEvents.value.find(event => String(event.id) === String(item.timelineEventId))
    map.set(key, current)
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
    const [storylineRes, chapterRes, characterRes, settingRes] = await Promise.all([
      getStorylineListApi({ bookId: bookId.value }),
      getBookTreeApi({ bookId: Number(bookId.value) }),
      getCharacterListApi({ bookId: String(bookId.value), page: 1, size: 500 }),
      getWorldSettingTreeApi({ bookId: bookId.value }),
    ])
    storylines.value = Array.isArray(storylineRes.data?.storylines) ? storylineRes.data.storylines : []
    nodes.value = Array.isArray(storylineRes.data?.nodes) ? storylineRes.data.nodes : []
    nodeRelations.value = Array.isArray(storylineRes.data?.nodeRelations) ? storylineRes.data.nodeRelations : []
    timelineEvents.value = Array.isArray(storylineRes.data?.timelineEvents) ? storylineRes.data.timelineEvents : []
    bindings.value = Array.isArray(storylineRes.data?.bindings) ? storylineRes.data.bindings : []
    chapters.value = flattenChapters(Array.isArray(chapterRes.data) ? chapterRes.data : [])
    characters.value = Array.isArray(characterRes.data?.list) ? characterRes.data.list : []
    settings.value = flattenSettings(Array.isArray(settingRes.data) ? settingRes.data : [])
    if (selectedNodeId.value && !nodes.value.some(item => item.id === selectedNodeId.value)) {
      selectedNodeId.value = nodes.value[0]?.id || null
    }
  } catch (error) {
    console.error('加载故事线失败:', error)
    showApiError(error, '加载故事线失败')
  } finally {
    loading.value = false
  }
}

const ensureDefaultStoryline = async () => {
  if (storylines.value.length) return storylines.value[0]
  const { data } = await addStorylineApi({
    bookId: bookId.value,
    title: '主线',
    lineType: 'main',
    status: 'active',
    importance: 5,
    summary: '作品核心故事线',
  })
  storylines.value = [data]
  return data
}

const openCreateNode = async (anchor?: PlotSelectionDetail | null) => {
  if (!bookId.value) return
  try {
    await ensureDefaultStoryline()
    editingNode.value = null
    pendingAnchor.value = anchor || null
    pendingParentNodeId.value = null
    pendingSiblingNodeId.value = null
    pendingCreatePosition.value = null
    pendingLinkFromNodeId.value = null
    nodeModalVisible.value = true
  } catch (error) {
    showApiError(error, '创建故事线失败')
  }
}

const openEditNode = (node: StorylineNode) => {
  editingNode.value = node
  pendingAnchor.value = null
  pendingParentNodeId.value = null
  pendingSiblingNodeId.value = null
  nodeModalVisible.value = true
}

const openCreateBranch = async () => {
  if (!selectedNode.value) return
  await openCreateNode()
  pendingParentNodeId.value = selectedNode.value.id
}

const openCreateSibling = async () => {
  if (!selectedNode.value) return
  await openCreateNode()
  pendingSiblingNodeId.value = selectedNode.value.id
}

const handleNodeSave = async (payload: StorylineNodePayload) => {
  try {
    let saved: StorylineNode
    const anchorPosition = pendingCreatePosition.value
      ? { x: Math.max(10, pendingCreatePosition.value.x - 90), y: Math.max(10, pendingCreatePosition.value.y - 65) }
      : nextNodePosition()
    // 弹窗对新建节点恒发 positionX/Y=0（表单默认值），不能当真实位置用：
    // 新建一律按锚点落位（右键/拖线的光标点，或递进式默认位）；编辑保留原位。
    const isEdit = Boolean(payload.id)
    const nextPayload = {
      ...payload,
      bookId: bookId.value,
      positionX: isEdit ? (payload.positionX ?? anchorPosition.x) : (Number(payload.positionX) || anchorPosition.x),
      positionY: isEdit ? (payload.positionY ?? anchorPosition.y) : (Number(payload.positionY) || anchorPosition.y),
      sortNo: payload.sortNo || nodes.value.length * 10 + 10,
    }
    if (payload.id) {
      const { data } = await updateStorylineNodeApi({ ...nextPayload, id: payload.id })
      saved = data
    } else {
      const { data } = await addStorylineNodeApi(nextPayload)
      saved = data
    }
    await saveRelationForNewNode(saved)
    if (pendingAnchor.value && !payload.id) {
      await addPlotBindingApi({
        bookId: bookId.value,
        storylineNodeId: String(saved.id),
        chapterId: pendingAnchor.value.chapterId ? String(pendingAnchor.value.chapterId) : '',
        anchorStart: pendingAnchor.value.anchorStart ?? null,
        anchorEnd: pendingAnchor.value.anchorEnd ?? null,
        anchorText: pendingAnchor.value.anchorText || '',
        anchorLabel: pendingAnchor.value.anchorLabel || '',
      })
    }
    selectedNodeId.value = saved.id
    nodeModalVisible.value = false
    pendingAnchor.value = null
    pendingCreatePosition.value = null
    await reload()
    ElMessage.success('故事节点已保存')
  } catch (error) {
    console.error('保存故事节点失败:', error)
    showApiError(error, '保存故事节点失败')
  }
}

const nextNodePosition = () => {
  const index = nodes.value.length
  if (!index) return { x: 300, y: 80 }
  return { x: 160 + (index % 3) * 260, y: 230 + Math.floor(index / 3) * 170 }
}

const saveRelationForNewNode = async (saved: StorylineNode) => {
  const relations = [...nodeRelations.value]
  if (pendingParentNodeId.value) {
    relations.push({ fromNodeId: String(pendingParentNodeId.value), toNodeId: String(saved.id), relationType: 'branch', strength: 3 })
  }
  if (pendingSiblingNodeId.value) {
    const sibling = nodes.value.find(item => item.id === pendingSiblingNodeId.value)
    if (sibling) {
      const parent = nodeRelations.value.find(item => String(item.toNodeId) === String(sibling.id))
      relations.push({
        fromNodeId: String(parent?.fromNodeId || sibling.id),
        toNodeId: String(saved.id),
        relationType: parent ? 'branch' : 'peer',
        strength: 3,
      })
    }
  }
  if (pendingLinkFromNodeId.value) {
    relations.push({
      fromNodeId: String(pendingLinkFromNodeId.value),
      toNodeId: String(saved.id),
      relationType: 'link',
      strength: 3,
    })
  }
  if (relations.length !== nodeRelations.value.length) {
    nodeRelations.value = await saveNodeRelations(relations)
  }
  pendingParentNodeId.value = null
  pendingSiblingNodeId.value = null
  pendingLinkFromNodeId.value = null
}

const saveNodeRelations = async (relations: StorylineNodeRelation[]) => {
  const { data } = await saveStorylineNodeRelationApi({
    bookId: bookId.value,
    relations: relations.map(item => ({
      fromNodeId: String(item.fromNodeId),
      toNodeId: String(item.toNodeId),
      relationType: item.relationType,
      description: item.description || '',
      strength: Number(item.strength || 3),
    })),
  })
  return data
}

const deleteNode = async (node: StorylineNode) => {
  try {
    await inkConfirm(`确定删除节点「${node.title}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await deleteStorylineNodeApi({ ids: [node.id] })
    selectedNodeId.value = null
    await reload()
    ElMessage.success('故事节点已删除')
  } catch (error) {
    if (error === 'cancel') return
    showApiError(error, '删除故事节点失败')
  }
}

const autoArrangeNodes = async () => {
  if (!nodes.value.length) return
  const roots = nodes.value.filter(node => !nodeRelations.value.some(rel => String(rel.toNodeId) === String(node.id)))
  const rootList = roots.length ? roots : [nodes.value[0]]
  const nextPositions = new Map<number, { x: number; y: number }>()
  const visited = new Set<number>()
  let row = 0
  const place = (node: StorylineNode, depth: number) => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const children = nodeRelations.value
      .filter(rel => String(rel.fromNodeId) === String(node.id))
      .map(rel => nodes.value.find(item => String(item.id) === String(rel.toNodeId)))
      .filter(Boolean) as StorylineNode[]
    const currentRow = row
    if (!children.length) row += 1
    children.forEach(child => place(child, depth + 1))
    const childRows = children.map(child => nextPositions.get(child.id)?.y || currentRow * 160)
    const y = childRows.length ? childRows.reduce((sum, item) => sum + item, 0) / childRows.length : currentRow * 160 + 80
    nextPositions.set(node.id, { x: depth * 270 + 80, y })
  }
  rootList.forEach(root => place(root, 0))
  nodes.value.forEach((node, index) => {
    const pos = nextPositions.get(node.id) || { x: (index % 4) * 260 + 80, y: Math.floor(index / 4) * 160 + 80 }
    node.positionX = Math.round(pos.x)
    node.positionY = Math.round(pos.y)
  })
  await saveStorylineNodePositionApi({
    bookId: bookId.value,
    positions: nodes.value.map(node => ({ id: node.id, positionX: node.positionX, positionY: node.positionY })),
  })
  ElMessage.success('导图已整理')
}

const toggleFullscreen = () => {
  fullscreen.value = !fullscreen.value
}

const closeFullscreenByKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && fullscreen.value) fullscreen.value = false
}

const generateStorylineSuggestions = async () => {
  if (aiLoading.value || !bookId.value) return
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  aiLoading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'storyline_ai',
      sceneLabel: '故事线生成',
      modelCode,
      messages: buildStructuredJsonMessages({
        task: promptText('structured-analysis', 'storylineSuggest'),
        materials: {
          '章节脉络': chapters.value.map(item => item.title).slice(0, 40).join('\n'),
          '主要角色': characters.value.map(item => item.name).slice(0, 30).join('、'),
          '时间线': timelineEvents.value.map(item => `${item.timeLabel || ''} ${item.title}`).join('\n'),
        },
        shape: promptText('structured-analysis', 'storylineShape'),
        limit: 5,
      }),
    })
    const parsed = parseAiJson(data, ['storylines'])
    aiSuggestions.value = (Array.isArray(parsed?.storylines) ? parsed.storylines : [])
      .map((item: JsonRecord, index: number) => ({
        id: `${Date.now()}-${index}`,
        title: String(item?.title || `故事线建议${index + 1}`).slice(0, 80),
        lineType: item?.lineType === 'branch' ? 'branch' : 'main',
        summary: String(item?.summary || item?.goal || '').slice(0, 240),
      }))
    if (!aiSuggestions.value.length) ElMessage.warning('AI 暂无可用建议')
  } catch (error) {
    console.error('生成故事线失败:', error)
    showApiError(error, '生成故事线失败')
  } finally {
    aiLoading.value = false
  }
}

const acceptStorySuggestion = async (item: AiStorySuggestion) => {
  try {
    const { data: storyline } = await addStorylineApi({
      bookId: bookId.value,
      title: item.title,
      lineType: item.lineType,
      status: 'active',
      importance: item.lineType === 'main' ? 5 : 3,
      summary: item.summary,
    })
    await addStorylineNodeApi({
      bookId: bookId.value,
      storylineId: String(storyline.id),
      title: item.title,
      nodeType: 'plot',
      status: 'active',
      summary: item.summary,
      positionX: nextNodePosition().x,
      positionY: nextNodePosition().y,
      sortNo: nodes.value.length * 10 + 10,
    })
    item.accepted = true
    await reload()
    ElMessage.success('AI 建议已采纳')
  } catch (error) {
    showApiError(error, '采纳建议失败')
  }
}

const handlePlotSelection = (event: Event) => {
  const detail = (event as CustomEvent<PlotSelectionDetail>).detail
  if (!detail || String(detail.bookId || '') !== String(bookId.value || '')) return
  if (detail.type === 'bind-timeline') return
  activeTab.value = detail.type === 'bind-storyline' ? 'binding' : 'mindmap'
  if (detail.type === 'bind-storyline' && selectedNode.value) {
    addPlotBindingApi({
      bookId: bookId.value,
      storylineNodeId: String(selectedNode.value.id),
      chapterId: detail.chapterId ? String(detail.chapterId) : '',
      anchorStart: detail.anchorStart ?? null,
      anchorEnd: detail.anchorEnd ?? null,
      anchorText: detail.anchorText || '',
      anchorLabel: detail.anchorLabel || '',
    })
      .then(() => {
        ElMessage.success('已绑定到故事节点')
        return reload()
      })
      .catch(error => showApiError(error, '绑定故事节点失败'))
    return
  }
  void openCreateNode(detail)
}

const jumpToAnchor = (chain: BindingChain) => {
  window.dispatchEvent(new CustomEvent('ew-writing-plot-anchor-jump', {
    detail: {
      chapterId: chain.chapterId,
      anchorStart: chain.anchorStart,
      anchorEnd: chain.anchorEnd,
      anchorText: chain.anchorText,
    },
  }))
}

const unbindChain = async (chain: BindingChain) => {
  if (!chain.bindingIds.length) return
  try {
    await deletePlotBindingApi({ ids: chain.bindingIds })
    await reload()
    ElMessage.success('绑定已解除')
  } catch (error) {
    showApiError(error, '解除绑定失败')
  }
}

const nodeTypeLabel = (value?: StorylineNodeType) => ({
  plot: '情节点',
  character: '人物节点',
  clue: '线索节点',
  location: '地点节点',
  organization: '组织节点',
  goal: '目标节点',
  ability: '能力节点',
  turning: '转折节点',
  custom: '自定义',
}[value || 'plot'] || '情节点')

const nodeStatusLabel = (value?: string) => value === 'draft' ? '草稿' : value === 'closed' ? '已完成' : '进行中'
const chapterTitle = (id?: string | number | null) => chapters.value.find(item => String(item.id) === String(id))?.title || '未绑定章节'
const chapterRangeText = (node: StorylineNode) => node.chapterIds?.length ? node.chapterIds.map(chapterTitle).slice(0, 2).join('、') : '章节未定'
const bindingCount = (nodeId: number) => bindings.value.filter(item => String(item.storylineNodeId || '') === String(nodeId)).length

watch(bookId, reload, { immediate: true })
watch(activeTab, value => {
  if (value !== 'mindmap') fullscreen.value = false
})
watch(fullscreen, value => {
  document.body.classList.toggle('storyline-mindmap-fullscreen', value)
})

onMounted(() => {
  window.addEventListener('ew-writing-plot-selection', handlePlotSelection as EventListener)
  window.addEventListener('keydown', closeFullscreenByKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('ew-writing-plot-selection', handlePlotSelection as EventListener)
  window.removeEventListener('keydown', closeFullscreenByKey)
  document.body.classList.remove('storyline-mindmap-fullscreen')
})
</script>

<style scoped lang="scss">
.story-panel {
  --node-main: color-mix(in srgb, var(--ink-accent) 72%, var(--ink-main));
  --node-branch: color-mix(in srgb, var(--ink-warning) 58%, var(--ink-main));
  --node-soft: color-mix(in srgb, var(--ui-glass-bg) 86%, transparent);
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  color: var(--ink-main);
  background: transparent;
}

:global(body.storyline-mindmap-fullscreen) {
  overflow: hidden;
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

.story-subtabs,
.mindmap-toolbar,
.binding-head,
.suggestion-title {
  display: flex;
  align-items: center;
}

.story-subtabs {
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

.story-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.mindmap-shell,
.story-timeline-view,
.binding-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mindmap-stage {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--ink-main);
  background: transparent;

  &.fullscreen {
    position: fixed;
    inset: var(--desktop-titlebar-height, 0px) 0 0 0;
    z-index: 10000;
    background: var(--bg-main);
  }
}

.mindmap-toolbar {
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);

  .ink-btn-action,
  .icon-action {
    height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}

.zoom-group {
  height: 30px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  overflow: hidden;

  button {
    width: 30px;
    height: 30px;
    border: 0;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
  }

  span {
    min-width: 48px;
    text-align: center;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.mainline-check {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-sec);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.icon-action {
  width: 30px;
  justify-content: center;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  cursor: pointer;
}


// 公共画布壳的注入：link 线型为虚线（Vue Flow 的边类名）
.mindmap-stage :deep(.vue-flow__edge.line-link .vue-flow__edge-path) {
  stroke-dasharray: 6 5;
}

// 节点卡内容（插槽在本组件作用域编译；定位/边框/端口由公共壳负责）
.mind-card {
  padding: 12px;
  border-top: 3px solid var(--node-main);
  border-radius: 8px 8px 0 0;
  min-height: 126px;

  h3 {
    margin: 8px 0 6px;
    font-size: calc(15px * var(--ui-font-scale, 1));
    line-height: 1.35;
  }

  p {
    margin: 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.55;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}

.plot-state-hint {
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0.75;
}

.node-top,
.node-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.node-top em {
  font-style: normal;
}

.plot-state {
  flex: 1;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ink-sec);
  text-align: center;

  i {
    font-size: calc(22px * var(--ui-font-scale, 1));
  }

  button {
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-glass-bg);
    color: var(--ink-main);
    cursor: pointer;
  }
}

.story-timeline-view {
  padding: 12px;
  overflow: auto;
}

.story-time-card {
  position: relative;
  margin-left: 20px;
  padding: 10px 12px 12px 18px;
  border-left: 2px solid color-mix(in srgb, var(--ink-accent) 58%, var(--ui-border));

  .time-dot {
    position: absolute;
    left: -7px;
    top: 18px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--bg-main);
    background: var(--ink-accent);
  }

  span,
  em {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-style: normal;
  }

  h3 {
    margin: 4px 0;
    font-size: calc(14px * var(--ui-font-scale, 1));
  }

  p {
    margin: 0 0 4px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.55;
  }
}

.binding-view {
  padding: 12px;
  overflow: auto;
}

.binding-head {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;

  strong,
  span {
    display: block;
  }

  span {
    margin-top: 4px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.binding-chain {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr) auto;
  align-items: stretch;
  gap: 8px;
  margin-bottom: 10px;

  > i {
    align-self: center;
    color: var(--ink-sec);
  }
}

.relation-card {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-glass-bg);

  span {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  p {
    margin: 5px 0 8px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.5;
  }

  button {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--ui-border);
    border-radius: 5px;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
  }
}

.unbind-btn {
  align-self: center;
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: transparent;
  color: var(--ink-sec);
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

.suggestion-card {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-glass-bg);

  > div {
    min-width: 0;
  }

  p {
    margin: 4px 0 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
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
  .binding-chain {
    grid-template-columns: minmax(0, 1fr);

    > i {
      display: none;
    }
  }

  .mind-node {
    width: 166px;
  }
}
</style>
