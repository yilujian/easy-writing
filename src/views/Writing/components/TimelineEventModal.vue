<template>
  <EwModal
    v-model:visible="dialogVisible"
    :title="form.id ? '编辑时间节点' : '新增时间节点'"
    width="720px"
    max-height="calc(100vh - 48px)"
    custom-class="timeline-event-modal-shell"
    :close-on-click-modal="false"
    draggable
  >
    <div class="timeline-event-modal">
      <div class="event-form-grid">
        <label class="form-field wide">
          <span>事件标题</span>
          <input v-model.trim="form.title" class="ink-input" maxlength="80" placeholder="例如：主角第一次进入宗门" />
        </label>
        <label class="form-field">
          <span>时间标记</span>
          <input v-model.trim="form.timeLabel" class="ink-input" maxlength="80" placeholder="例如：第七日 / 春末" />
        </label>
        <label class="form-field">
          <span>时间排序</span>
          <el-input-number v-model="form.timeOrder" :min="0" :step="10" controls-position="right" class="ink-number" />
        </label>
        <label class="form-field">
          <span>所属线型</span>
          <el-select v-model="form.lineType" class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in lineOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </label>
        <label class="form-field">
          <span>关联故事线</span>
          <el-select v-model="form.storylineId" clearable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in storylines" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field">
          <span>章节</span>
          <el-select v-model="form.chapterId" clearable filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in chapters" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field">
          <span>地点</span>
          <input v-model.trim="form.location" class="ink-input" maxlength="160" placeholder="事件发生地点" />
        </label>
        <label class="form-field">
          <span>冲突强度</span>
          <el-rate v-model="form.conflictLevel" :max="5" />
        </label>
        <label class="form-field wide">
          <span>关联角色</span>
          <el-select v-model="form.characterIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in characters" :key="item.id" :label="item.name" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>关联设定</span>
          <el-select v-model="form.settingIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in settings" :key="item.id" :label="item.name" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>关联事件</span>
          <el-select v-model="form.relatedEventIds" multiple filterable class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="item in selectableEvents" :key="item.id" :label="item.title" :value="String(item.id)" />
          </el-select>
        </label>
        <label class="form-field wide">
          <span>事件概述</span>
          <textarea v-model.trim="form.summary" class="ink-textarea" rows="3" placeholder="这件事发生了什么" />
        </label>
        <label class="form-field">
          <span>前因</span>
          <textarea v-model.trim="form.cause" class="ink-textarea" rows="3" placeholder="为什么发生" />
        </label>
        <label class="form-field">
          <span>后果</span>
          <textarea v-model.trim="form.effect" class="ink-textarea" rows="3" placeholder="带来什么变化" />
        </label>
        <label class="form-field wide">
          <span>备注</span>
          <textarea v-model.trim="form.note" class="ink-textarea" rows="2" placeholder="可记录伏笔、矛盾点、待补充信息" />
        </label>
      </div>

      <div class="parallel-section">
        <div class="section-title">
          <span>并列事件</span>
          <button class="ink-btn-action" type="button" @click="addParallelEvent">
            <i class="fa-solid fa-plus"></i>
            添加
          </button>
        </div>
        <div v-if="!parallelEvents.length" class="parallel-empty">同一时间点没有并列事件</div>
        <div v-for="(item, index) in parallelEvents" :key="index" class="parallel-row">
          <input v-model.trim="item.title" class="ink-input" maxlength="80" placeholder="并列事件标题" />
          <el-select v-model="item.lineType" class="ink-select" popper-class="ink-select-popper" fit-input-width>
            <el-option v-for="option in lineOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <button class="row-icon-btn danger" type="button" title="移除" @click="parallelEvents.splice(index, 1)">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>

      <div class="event-preview">
        <div class="preview-pin" :class="`line-${form.lineType}`"></div>
        <div class="preview-body">
          <div class="preview-meta">{{ form.timeLabel || '未设置时间' }} · {{ lineLabel(form.lineType) }}</div>
          <div class="preview-title">{{ form.title || '未命名事件' }}</div>
          <p>{{ form.summary || '保存后会作为时间线节点展示，可在侧栏或工作台继续编辑。' }}</p>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="ink-btn ink-btn-outline" type="button" @click="dialogVisible = false">取消</button>
      <button class="ink-btn ink-btn-primary" type="button" @click="handleSave">
        <i class="fa-solid fa-floppy-disk"></i>
        保存节点
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import type { Character, WorldSetting } from '@/types'
import type { Storyline, TimelineEvent, TimelineEventPayload, TimelineLineType } from '@/types/plot'

interface ChapterOption {
  id: number
  title: string
}

interface ParallelEventDraft {
  title: string
  lineType: TimelineLineType
  summary: string
}

const props = defineProps<{
  visible: boolean
  bookId?: string | number
  event?: TimelineEvent | null
  storylines: Storyline[]
  chapters: ChapterOption[]
  characters: Character[]
  settings: WorldSetting[]
  events: TimelineEvent[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', payload: { event: TimelineEventPayload; parallelEvents: ParallelEventDraft[] }): void
}>()

const lineOptions: Array<{ label: string; value: TimelineLineType }> = [
  { label: '主线', value: 'main' },
  { label: '支线', value: 'branch' },
]

const dialogVisible = computed({
  get: () => props.visible,
  set: value => emit('update:visible', value),
})

const form = reactive<TimelineEventPayload>({
  bookId: '',
  title: '',
  lineType: 'main',
  timeLabel: '',
  timePoint: '',
  timeOrder: 10,
  storylineId: '',
  chapterId: '',
  location: '',
  summary: '',
  cause: '',
  effect: '',
  conflictLevel: 3,
  characterIds: [],
  settingIds: [],
  relatedEventIds: [],
  note: '',
})

const parallelEvents = ref<ParallelEventDraft[]>([])

const selectableEvents = computed(() => props.events.filter(item => item.id !== form.id))

const cloneIds = (value?: string[]) => Array.isArray(value) ? value.map(String) : []

const resetForm = () => {
  Object.assign(form, {
    id: undefined,
    bookId: props.bookId || '',
    title: '',
    lineType: 'main',
    timeLabel: '',
    timePoint: '',
    timeOrder: 10,
    storylineId: '',
    chapterId: '',
    location: '',
    summary: '',
    cause: '',
    effect: '',
    conflictLevel: 3,
    characterIds: [],
    settingIds: [],
    relatedEventIds: [],
    note: '',
  })
  parallelEvents.value = []
}

watch(
  () => [props.event, props.visible, props.bookId] as const,
  () => {
    if (!props.visible) return
    if (!props.event) {
      resetForm()
      return
    }
    Object.assign(form, {
      id: props.event.id,
      bookId: props.event.bookId || props.bookId || '',
      title: props.event.title || '',
      lineType: props.event.lineType || 'main',
      timeLabel: props.event.timeLabel || '',
      timePoint: props.event.timePoint || '',
      timeOrder: Number(props.event.timeOrder || 0),
      storylineId: props.event.storylineId ? String(props.event.storylineId) : '',
      chapterId: props.event.chapterId ? String(props.event.chapterId) : '',
      location: props.event.location || '',
      summary: props.event.summary || '',
      cause: props.event.cause || '',
      effect: props.event.effect || '',
      conflictLevel: Number(props.event.conflictLevel || 3),
      characterIds: cloneIds(props.event.characterIds),
      settingIds: cloneIds(props.event.settingIds),
      relatedEventIds: cloneIds(props.event.relatedEventIds),
      note: props.event.note || '',
    })
    parallelEvents.value = []
  },
  { immediate: true }
)

const lineLabel = (lineType?: TimelineLineType) => {
  return lineOptions.find(item => item.value === lineType)?.label || '主线'
}

const addParallelEvent = () => {
  parallelEvents.value.push({
    title: '',
    lineType: form.lineType || 'branch',
    summary: '',
  })
}

const clearEmpty = (value?: string | number | null) => {
  const text = String(value ?? '').trim()
  return text ? text : undefined
}

const handleSave = () => {
  if (!props.bookId) {
    ElMessage.warning('请先选择作品')
    return
  }
  if (!String(form.title || '').trim()) {
    ElMessage.warning('请填写事件标题')
    return
  }
  if (!String(form.timeLabel || '').trim()) {
    ElMessage.warning('请填写时间标记')
    return
  }
  emit('save', {
    event: {
      ...form,
      bookId: props.bookId,
      storylineId: clearEmpty(form.storylineId),
      chapterId: clearEmpty(form.chapterId),
      timeOrder: Number(form.timeOrder || 0),
      conflictLevel: Number(form.conflictLevel || 3),
      characterIds: cloneIds(form.characterIds as string[]),
      settingIds: cloneIds(form.settingIds as string[]),
      relatedEventIds: cloneIds(form.relatedEventIds as string[]),
    },
    parallelEvents: parallelEvents.value.filter(item => item.title.trim()),
  })
}
</script>

<style scoped lang="scss">
.timeline-event-modal {
  color: var(--ink-main);
}

.event-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;

  span {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  &.wide {
    grid-column: 1 / -1;
  }
}

.ink-input,
.ink-textarea {
  width: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  font: inherit;
  outline: none;
  transition: border-color 0.2s ease, background 0.2s ease;

  &:focus {
    border-color: var(--ink-accent);
    background: color-mix(in srgb, var(--ui-glass-bg) 82%, var(--bg-main));
  }
}

.ink-input {
  height: 34px;
  padding: 0 10px;
}

.ink-textarea {
  resize: vertical;
  min-height: 72px;
  padding: 9px 10px;
  line-height: 1.6;
}

.ink-select,
.ink-number {
  width: 100%;
}

:deep(.ink-number .el-input__wrapper) {
  background: var(--ui-glass-bg);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  border-radius: 6px;
}

:deep(.ink-number .el-input__wrapper.is-focus) {
  box-shadow: inset 0 0 0 1px var(--ink-accent);
}

:deep(.ink-number .el-input__inner) {
  color: var(--ink-main);
  -webkit-text-fill-color: var(--ink-main);
  font: inherit;
}

:deep(.ink-number .el-input-number__decrease),
:deep(.ink-number .el-input-number__increase) {
  background: color-mix(in srgb, var(--ui-glass-bg) 76%, var(--bg-main));
  border-color: var(--ui-border);
  color: var(--ink-sec);

  &:hover {
    color: var(--ink-accent);
  }
}

.parallel-section {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-glass-bg) 78%, transparent);
}

.section-title,
.parallel-row,
.event-preview {
  display: flex;
  align-items: center;
}

.section-title {
  justify-content: space-between;
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 700;
}

.parallel-empty {
  padding: 10px 0 2px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.parallel-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 128px 34px;
  gap: 8px;
  margin-top: 10px;
}

.parallel-row .ink-select {
  width: 128px;
}

.row-icon-btn {
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;

  &:hover {
    border-color: var(--ink-accent);
    background: var(--btn-outline-hover-bg);
  }
}

.danger:hover {
  color: var(--ink-warning);
  border-color: var(--ink-warning);
}

.event-preview {
  margin-top: 16px;
  align-items: stretch;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-main);
}

.preview-pin {
  width: 5px;
  background: var(--line-main);

  &.line-main { background: color-mix(in srgb, var(--ink-main) 64%, var(--ink-accent)); }
  &.line-branch { background: color-mix(in srgb, var(--ink-accent) 62%, var(--ink-warning)); }
}

.preview-body {
  min-width: 0;
  padding: 12px;

  p {
    margin: 6px 0 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.7;
  }
}

.preview-meta {
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.preview-title {
  margin-top: 4px;
  color: var(--ink-main);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 700;
}

@media (max-width: 760px) {
  .event-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
