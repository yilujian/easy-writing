<template>
  <WorkflowAdjustDrawer
    :visible="visible"
    :run-id="runId"
    recovery-key="step:outline_adjust"
    :phase="phase"
    input-title="按要求调整大纲"
    generating-title="正在生成调整候选"
    candidate-title="调整候选"
    generating-text="AI 正在按要求调整大纲…"
    generating-note="生成期间可以继续查看当前大纲，暂时无法编辑"
    stop-note="停止后当前大纲保持不变，不会产生候选"
    apply-note="应用后成为当前大纲，原内容进入历史记录"
    :request-summary="requestSummary"
    :submit-enabled="Boolean(instruction.trim())"
    :model-name="modelName"
    :percent="percent"
    :stages="stages"
    :candidate="candidate"
    :error-message="errorMessage"
    @close="$emit('close')"
    @submit="submit"
    @stop="$emit('stop')"
    @discard="$emit('discard')"
    @regenerate="$emit('regenerate')"
    @apply="$emit('apply')"
  >
    <template #form>
      <section class="adjust-drawer-field">
        <h4>调整范围</h4>
        <div class="adjust-drawer-chips">
          <button
            v-for="option in scopeOptions"
            :key="option.value"
            type="button"
            :class="{ active: scope === option.value }"
            @click="selectScope(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <p class="adjust-drawer-note">
          <i class="fa-solid fa-circle-info"></i>
          {{ scopeEffectText }}
        </p>
      </section>

      <section class="adjust-drawer-field">
        <h4>调整要求</h4>
        <div class="adjust-drawer-textarea">
          <textarea
            v-model="instruction"
            :maxlength="INSTRUCTION_MAX"
            rows="9"
            placeholder="例如：保留父亲失踪线索，把前两卷冲突提前；减少校园日常，强化地下武者世界的压迫感。"
          ></textarea>
          <em>{{ instruction.length }} / {{ INSTRUCTION_MAX }}</em>
        </div>
      </section>

      <section v-if="availablePreserveOptions.length" class="adjust-drawer-field">
        <h4>
          保留项
          <small>可多选</small>
        </h4>
        <div class="adjust-drawer-preserve">
          <label
            v-for="option in availablePreserveOptions"
            :key="option.key"
            :class="{ active: preserve.includes(option.key) }"
          >
            <input
              type="checkbox"
              :checked="preserve.includes(option.key)"
              @change="togglePreserve(option.key)"
            />
            <i :class="preserve.includes(option.key) ? 'fa-solid fa-square-check' : 'fa-regular fa-square'"></i>
            <span>
              <strong>{{ option.label }}</strong>
              <small>{{ option.desc }}</small>
            </span>
          </label>
        </div>
      </section>

      <section v-if="volumeTitleToggleVisible" class="adjust-drawer-switch-row">
        <span>允许调整卷名</span>
        <button
          type="button"
          class="adjust-drawer-switch"
          :class="{ on: allowVolumeTitleChange }"
          role="switch"
          :aria-checked="allowVolumeTitleChange"
          @click="allowVolumeTitleChange = !allowVolumeTitleChange"
        >
          <i></i>
        </button>
      </section>
    </template>
  </WorkflowAdjustDrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import WorkflowAdjustDrawer from './WorkflowAdjustDrawer.vue'
import type {
  WorkflowOutlineAdjustCandidate,
  WorkflowAdjustPhase,
  WorkflowOutlineAdjustRequest,
  WorkflowOutlineAdjustScope,
  WorkflowAdjustStage,
  WorkflowOutlinePreserveKey,
} from '../types'

const INSTRUCTION_MAX = 500

const props = withDefaults(defineProps<{
  runId?: number
  visible: boolean
  phase: WorkflowAdjustPhase
  modelName?: string
  percent?: number
  stages?: WorkflowAdjustStage[]
  candidate?: WorkflowOutlineAdjustCandidate | null
  errorMessage?: string
}>(), {
  modelName: '',
  runId: 0,
  percent: 0,
  stages: () => [],
  candidate: null,
  errorMessage: '',
})

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'generate', payload: WorkflowOutlineAdjustRequest): void
  (event: 'stop'): void
  (event: 'discard'): void
  (event: 'regenerate'): void
  (event: 'apply'): void
}>()

const scopeOptions: Array<{ value: WorkflowOutlineAdjustScope; label: string }> = [
  { value: 'all', label: '整体大纲' },
  { value: 'title', label: '推荐书名' },
  { value: 'storyHook', label: '故事亮点' },
  { value: 'world', label: '世界概览' },
  { value: 'volumes', label: '分卷概览' },
]

// 保留项都对应大纲里的真实字段，应用前可以逐项比对；
// 正在调整的对象自身不能同时要求保留，否则本次请求自相矛盾。
// 保留项只在「范围本身约束不住模型」时才出现：
// - 整体大纲：模型会同时动多个部分，需要逐项钉住；
// - 单一范围（书名 / 故事亮点 / 世界概览）：应用时只写这一个字段，其余字段根本不参与，
//   再问"要不要保留"是多余的，还会让人误以为不勾就会被改；
// - 分卷概览：范围内部仍有分歧（能否改卷数、能否改卷名），所以保留范围内的那一项。
const preserveOptions: Array<{
  key: WorkflowOutlinePreserveKey
  label: string
  desc: string
  scopes: WorkflowOutlineAdjustScope[]
}> = [
  {
    key: 'title',
    label: '当前书名',
    desc: '现在选中的书名保持原样',
    scopes: ['all'],
  },
  {
    key: 'storyHook',
    label: '故事主线',
    desc: '「故事亮点 / 核心冲突」整段不改',
    scopes: ['all'],
  },
  {
    key: 'worldItems',
    label: '世界规则',
    desc: '「世界概览」里的条目不增不删不改',
    scopes: ['all'],
  },
  {
    key: 'volumeCount',
    label: '分卷数量',
    desc: '卷数不变，只调整卷纲内容',
    scopes: ['all', 'volumes'],
  },
]

const scope = ref<WorkflowOutlineAdjustScope>('all')
const instruction = ref('')
const preserve = ref<WorkflowOutlinePreserveKey[]>(['title', 'volumeCount'])
const allowVolumeTitleChange = ref(true)

const availablePreserveOptions = computed(() => (
  preserveOptions.filter(option => option.scopes.includes(scope.value))
))
const scopeEffectText = computed(() => {
  if (scope.value === 'all') return '本次可能同时改动大纲的多个部分，可在下面钉住不希望被改的内容。'
  const label = scopeOptions.find(item => item.value === scope.value)?.label || ''
  return `本次只改动「${label}」，大纲其余部分原样保留。`
})
const volumeTitleToggleVisible = computed(() => ['all', 'volumes'].includes(scope.value))

const requestSummary = computed(() => {
  const source = props.candidate?.request || currentRequest()
  const scopeLabel = scopeOptions.find(item => item.value === source.scope)?.label || '整体大纲'
  const preserveLabels = source.preserve
    .map(key => preserveOptions.find(item => item.key === key)?.label)
    .filter(Boolean)
  const parts = [scopeLabel]
  if (preserveLabels.length) parts.push(`保留${preserveLabels.join('、')}`)
  if (source.instruction.trim()) parts.push(source.instruction.trim())
  return parts.join(' · ')
})

function currentRequest(): WorkflowOutlineAdjustRequest {
  return {
    scope: scope.value,
    instruction: instruction.value.trim(),
    // 范围切换后被隐藏的保留项不应继续随请求提交。
    preserve: preserve.value.filter(key => (
      availablePreserveOptions.value.some(option => option.key === key)
    )),
    allowVolumeTitleChange: volumeTitleToggleVisible.value ? allowVolumeTitleChange.value : false,
  }
}

const selectScope = (value: WorkflowOutlineAdjustScope) => {
  scope.value = value
}

const togglePreserve = (key: WorkflowOutlinePreserveKey) => {
  preserve.value = preserve.value.includes(key)
    ? preserve.value.filter(item => item !== key)
    : [...preserve.value, key]
}

const submit = () => {
  if (!instruction.value.trim()) return
  emit('generate', currentRequest())
}

// 抽屉关闭不清空草稿（设计要求：本次页面会话内保留用户刚输入的要求）；
// 只有候选被应用后才重置，避免下一次调整带着上一次已生效的要求。
watch(() => props.candidate, next => {
  if (next?.request) {
    scope.value = next.request.scope
    instruction.value = next.request.instruction
    preserve.value = [...next.request.preserve]
    allowVolumeTitleChange.value = next.request.allowVolumeTitleChange
  }
})

defineExpose({
  restoreRequest: (request: WorkflowOutlineAdjustRequest) => {
    scope.value = request.scope
    instruction.value = request.instruction
    preserve.value = [...request.preserve]
    allowVolumeTitleChange.value = request.allowVolumeTitleChange
  },
  // 应用之后只清掉已生效的要求，范围和保留项保留：
  // 连着调几轮是常态，每次都要重选范围很烦。
  resetDraft: () => {
    instruction.value = ''
  },
})
</script>
