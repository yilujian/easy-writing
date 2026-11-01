<template>
  <EwModal
    v-model:visible="dialogVisible"
    :title="form.id ? '编辑节点' : '新建节点'"
    width="760px"
    max-height="calc(100vh - 48px)"
    custom-class="story-node-modal-shell"
    :close-on-click-modal="false"
    draggable
  >
    <div class="story-node-modal">
      <div class="node-form-grid">
        <label class="form-field wide">
          <span>节点名称</span>
          <input v-model.trim="form.title" class="ink-input" maxlength="80" placeholder="例如：梦境篡改主线" />
        </label>
        <label class="form-field">
          <span>节点类型</span>
          <el-select v-model="form.nodeType" class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in nodeTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </label>
        <label class="form-field">
          <span>所属故事线</span>
          <el-select v-model="form.storylineId" filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in storylines" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>事件摘要</span>
          <textarea v-model.trim="form.summary" class="ink-textarea" rows="4" placeholder="这个节点承载的剧情变化、目标或线索" />
        </label>
        <label class="form-field">
          <span>关联角色</span>
          <el-select v-model="form.characterIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in characters" :key="item.id" :label="item.name" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field">
          <span>关联地点</span>
          <input v-model.trim="form.location" class="ink-input" maxlength="80" placeholder="地点或场景" />
        </label>
        <label class="form-field">
          <span>关联章节</span>
          <el-select v-model="form.chapterIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in chapters" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field">
          <span>关联设定</span>
          <el-select v-model="form.settingIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in settings" :key="item.id" :label="item.name" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>绑定正文锚点</span>
          <div class="anchor-preview" :class="{ empty: !anchorText }">
            <i class="fa-solid fa-bookmark"></i>
            <span>{{ anchorText || '未绑定正文选区' }}</span>
          </div>
        </label>
        <label class="form-field">
          <span>前置节点</span>
          <el-select v-model="form.predecessorNodeIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in selectableNodes" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field">
          <span>后置节点</span>
          <el-select v-model="form.successorNodeIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in selectableNodes" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>标签</span>
          <input v-model.trim="tagText" class="ink-input" maxlength="120" placeholder="用空格或逗号分隔" />
        </label>
      </div>
    </div>
    <template #footer>
      <button class="ink-btn ink-btn-outline" type="button" @click="dialogVisible = false">取消</button>
      <button class="ink-btn ink-btn-outline" type="button" @click="handleSave('draft')">
        <i class="fa-regular fa-floppy-disk"></i>
        保存草稿
      </button>
      <button class="ink-btn ink-btn-primary" type="button" @click="handleSave('active')">
        <i class="fa-solid fa-diagram-project"></i>
        保存并更新导图
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import type { Character, WorldSetting } from '@/types'
import type { Storyline, StorylineNode, StorylineNodePayload, StorylineNodeStatus, StorylineNodeType } from '@/types/plot'

interface ChapterOption {
  id: number
  title: string
}

interface AnchorDraft {
  chapterId?: string | number | null
  anchorStart?: number | null
  anchorEnd?: number | null
  anchorText?: string
  anchorLabel?: string
}

const props = defineProps<{
  visible: boolean
  bookId?: string | number
  node?: StorylineNode | null
  storylines: Storyline[]
  nodes: StorylineNode[]
  chapters: ChapterOption[]
  characters: Character[]
  settings: WorldSetting[]
  anchor?: AnchorDraft | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', payload: StorylineNodePayload): void
}>()

const nodeTypeOptions: Array<{ label: string; value: StorylineNodeType }> = [
  { label: '情节点', value: 'plot' },
  { label: '人物节点', value: 'character' },
  { label: '线索节点', value: 'clue' },
  { label: '地点节点', value: 'location' },
  { label: '组织节点', value: 'organization' },
  { label: '目标节点', value: 'goal' },
  { label: '能力节点', value: 'ability' },
  { label: '转折节点', value: 'turning' },
  { label: '自定义', value: 'custom' },
]

const dialogVisible = computed({
  get: () => props.visible,
  set: value => emit('update:visible', value),
})

const form = reactive<StorylineNodePayload>({
  bookId: '',
  storylineId: '',
  title: '',
  nodeType: 'plot',
  status: 'active',
  summary: '',
  location: '',
  chapterIds: [],
  characterIds: [],
  settingIds: [],
  predecessorNodeIds: [],
  successorNodeIds: [],
  tags: [],
  positionX: 0,
  positionY: 0,
  sortNo: 0,
  payload: null,
})

const tagText = ref('')
const anchorText = computed(() => props.anchor?.anchorText || props.node?.payload?.anchor?.anchorText || '')
const selectableNodes = computed(() => props.nodes.filter(item => item.id !== form.id))

const cloneIds = (value?: string[]) => Array.isArray(value) ? value.map(String) : []
const parseTags = () => tagText.value.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean).slice(0, 12)

const resetForm = () => {
  Object.assign(form, {
    id: undefined,
    bookId: props.bookId || '',
    storylineId: props.storylines[0]?.id ? String(props.storylines[0].id) : '',
    title: props.anchor?.anchorText ? props.anchor.anchorText.slice(0, 24) : '',
    nodeType: 'plot',
    status: 'active',
    summary: props.anchor?.anchorText || '',
    location: '',
    chapterIds: props.anchor?.chapterId ? [String(props.anchor.chapterId)] : [],
    characterIds: [],
    settingIds: [],
    predecessorNodeIds: [],
    successorNodeIds: [],
    tags: [],
    positionX: 0,
    positionY: 0,
    sortNo: 0,
    payload: props.anchor ? { anchor: props.anchor } : null,
  })
  tagText.value = ''
}

watch(
  () => [props.visible, props.node, props.storylines.length, props.anchor] as const,
  () => {
    if (!props.visible) return
    if (!props.node) {
      resetForm()
      return
    }
    Object.assign(form, {
      id: props.node.id,
      bookId: props.node.bookId || props.bookId || '',
      storylineId: props.node.storylineId ? String(props.node.storylineId) : '',
      title: props.node.title || '',
      nodeType: props.node.nodeType || 'plot',
      status: props.node.status || 'active',
      summary: props.node.summary || '',
      location: props.node.location || '',
      chapterIds: cloneIds(props.node.chapterIds),
      characterIds: cloneIds(props.node.characterIds),
      settingIds: cloneIds(props.node.settingIds),
      predecessorNodeIds: cloneIds(props.node.predecessorNodeIds),
      successorNodeIds: cloneIds(props.node.successorNodeIds),
      tags: Array.isArray(props.node.tags) ? props.node.tags : [],
      positionX: Number(props.node.positionX || 0),
      positionY: Number(props.node.positionY || 0),
      sortNo: Number(props.node.sortNo || 0),
      payload: props.node.payload || null,
    })
    tagText.value = Array.isArray(props.node.tags) ? props.node.tags.join(' ') : ''
  },
  { immediate: true }
)

const handleSave = (status: StorylineNodeStatus) => {
  if (!String(form.title || '').trim()) {
    ElMessage.warning('请填写节点名称')
    return
  }
  if (!form.storylineId) {
    ElMessage.warning('请选择所属故事线')
    return
  }
  emit('save', {
    ...form,
    status,
    tags: parseTags(),
  })
}
</script>

<style scoped lang="scss">
.story-node-modal {
  color: var(--ink-main);
}

.node-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;

  &.wide {
    grid-column: 1 / -1;
  }

  > span {
    color: var(--ink-sec);
    font-size: calc(13px * var(--ui-font-scale, 1));
  }
}

.anchor-preview {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-glass-bg) 72%, transparent);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));

  &.empty {
    color: var(--ink-sec);
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

@media (max-width: 760px) {
  .node-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
