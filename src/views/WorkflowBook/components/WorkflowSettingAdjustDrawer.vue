<template>
  <WorkflowAdjustDrawer
    :visible="visible"
    :run-id="runId"
    recovery-key="step:setting_adjust"
    :phase="phase"
    input-title="按要求调整设定"
    generating-title="正在生成调整候选"
    candidate-title="调整候选"
    generating-text="AI 正在按要求调整设定…"
    generating-note="生成期间可以继续查看当前设定，暂时无法编辑"
    stop-note="停止后当前设定保持不变，不会产生候选"
    apply-note="应用后成为当前设定，原内容进入历史记录"
    :request-summary="requestSummary"
    :submit-enabled="submitEnabled"
    :submit-disabled-tip="submitDisabledTip"
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

      <!-- 目标是可选的：点一个就只改他，不点就是改整组，再点一次取消 -->
      <section v-if="supportsTarget" class="adjust-drawer-field">
        <h4>
          {{ targetFieldLabel }}
          <small>可选，不选则调整全部</small>
        </h4>
        <div v-if="targetOptions.length" class="adjust-drawer-chips">
          <button
            v-for="option in targetOptions"
            :key="option.id"
            type="button"
            :class="{ active: targetId === option.id }"
            @click="toggleTarget(option.id)"
          >
            {{ option.label }}
          </button>
        </div>
        <p v-else class="adjust-drawer-note">
          <i class="fa-solid fa-circle-info"></i>
          当前设定里还没有可选的{{ groupNoun }}
        </p>
      </section>

      <section class="adjust-drawer-field">
        <h4>调整要求</h4>
        <div class="adjust-drawer-textarea">
          <textarea
            v-model="instruction"
            :maxlength="INSTRUCTION_MAX"
            rows="9"
            :placeholder="placeholder"
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
    </template>
  </WorkflowAdjustDrawer>
</template>

<script setup lang="ts">
/**
 * 第四步「按要求调整设定」抽屉。
 *
 * 骨架来自 WorkflowAdjustDrawer，这里只负责范围、目标、要求、保留项这段表单，
 * 以及把它们组装成一个请求。比大纲多的是「单条目」范围——只改某个角色 /
 * 某条剧情线，服务端会保证同组其余条目一个字都不动。
 */
import { computed, ref, watch } from 'vue'
import WorkflowAdjustDrawer from './WorkflowAdjustDrawer.vue'
import type {
  WorkflowAdjustPhase,
  WorkflowAdjustStage,
  WorkflowSettingAdjustCandidate,
  WorkflowSettingAdjustRequest,
  WorkflowSettingAdjustScope,
  WorkflowSettingPreserveKey,
} from '../types'

const INSTRUCTION_MAX = 500

/** 界面上可选的范围：只有「哪一部分」，不含单条目 */
type SettingAdjustGroupScope = 'all' | 'worldCards' | 'core' | 'characters' | 'storylines'

const props = withDefaults(defineProps<{
  runId?: number
  visible: boolean
  phase: WorkflowAdjustPhase
  /** 供单条目范围选择目标，只取 id 与展示名 */
  characters?: Array<{ id: string; name: string }>
  storylines?: Array<{ id: string; title: string }>
  modelName?: string
  percent?: number
  stages?: WorkflowAdjustStage[]
  candidate?: WorkflowSettingAdjustCandidate | null
  errorMessage?: string
}>(), {
  characters: () => [],
  storylines: () => [],
  modelName: '',
  runId: 0,
  percent: 0,
  stages: () => [],
  candidate: null,
  errorMessage: '',
})

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'generate', payload: WorkflowSettingAdjustRequest): void
  (event: 'stop'): void
  (event: 'discard'): void
  (event: 'regenerate'): void
  (event: 'apply'): void
}>()

/**
 * 调整范围只描述「改设定的哪一部分」，不掺「整组还是某一条」。
 *
 * 后者由下面的目标选择表达：点了某个角色就只改他，不点就是改整组。
 * 把两个维度拉平成 7 个按钮既占地方，「可增删」这类状态说明也塞不进标签。
 */
const scopeOptions: Array<{ value: SettingAdjustGroupScope; label: string }> = [
  { value: 'all', label: '整份设定' },
  { value: 'worldCards', label: '世界卡' },
  { value: 'core', label: '核心体系' },
  { value: 'characters', label: '角色' },
  { value: 'storylines', label: '剧情线' },
]

/** 支持"缩小到某一条"的范围，以及它对应的单条目 scope 与称呼 */
const TARGET_SCOPES = {
  characters: { itemScope: 'character' as const, noun: '角色' },
  storylines: { itemScope: 'storyline' as const, noun: '剧情线' },
}

// 保留项只在「范围本身约束不住模型」时才出现：
// - 整份设定：模型会同时动多个部分，需要逐项钉住；
// - 单一分区（角色 / 核心体系 / 世界卡）：只保留本分区内部仍有分歧的那一项；
// - 单条目：范围已经把其余条目全部锁死，再问保留是多余的。
const preserveOptions: Array<{
  key: WorkflowSettingPreserveKey
  label: string
  desc: string
  scopes: WorkflowSettingAdjustScope[]
}> = [
  {
    key: 'characterCount',
    label: '角色数量',
    desc: '不许增删，只改已有角色',
    scopes: ['all', 'characters'],
  },
  {
    key: 'storylineCount',
    label: '剧情线数量',
    desc: '不许增删，只改已有阶段',
    scopes: ['all', 'storylines'],
  },
  {
    key: 'protagonist',
    label: '主角设定',
    desc: '主角那一条整体保持原样',
    scopes: ['all', 'characters'],
  },
  {
    key: 'cultivationRealms',
    label: '境界体系',
    desc: '境界表不变，大纲与正文里的境界名才不会失效',
    scopes: ['all', 'core'],
  },
  {
    key: 'worldRules',
    label: '世界规则',
    desc: '世界规则卡不改，已有情节的硬约束保持有效',
    scopes: ['all', 'worldCards'],
  },
]

const scope = ref<SettingAdjustGroupScope>('all')
const targetId = ref('')
const instruction = ref('')
const preserve = ref<WorkflowSettingPreserveKey[]>(['protagonist', 'cultivationRealms'])

// 当前范围能不能缩小到某一条
const supportsTarget = computed(() => scope.value in TARGET_SCOPES)
const groupNoun = computed(
  () => TARGET_SCOPES[scope.value as keyof typeof TARGET_SCOPES]?.noun || ''
)
const targetFieldLabel = computed(() => `指定${groupNoun.value}`)
// 真的缩小到了某一条
const hasTarget = computed(() => supportsTarget.value && Boolean(targetId.value))

const targetOptions = computed(() => {
  if (scope.value === 'characters') {
    return props.characters.map(item => ({ id: item.id, label: item.name || '未命名角色' }))
  }
  if (scope.value === 'storylines') {
    return props.storylines.map(item => ({ id: item.id, label: item.title || '未命名剧情线' }))
  }
  return []
})

const availablePreserveOptions = computed(() => {
  // 已经缩小到某一条时，范围本身就锁死了其余内容，再问保留是多余的。
  if (hasTarget.value) return []
  return preserveOptions.filter(option => option.scopes.includes(scope.value))
})

// 「能不能增删」是当前勾选状态的结果，不是范围的固有属性，所以只出现在提示里，
// 不进按钮标签——否则标签要么写死、要么加括号，两种都难看。
const scopeEffectText = computed(() => {
  if (hasTarget.value) {
    const name = targetOptions.value.find(item => item.id === targetId.value)?.label || '这一条'
    return `本次只改动「${name}」，其他${groupNoun.value}与设定其余部分原样保留。`
  }
  if (scope.value === 'all') return '本次可能同时改动设定的多个部分，可在下面钉住不希望被改的内容。'
  if (supportsTarget.value) {
    const countKey = scope.value === 'characters' ? 'characterCount' : 'storylineCount'
    const countLabel = scope.value === 'characters' ? '角色数量' : '剧情线数量'
    return preserve.value.includes(countKey)
      ? `本次改动全部${groupNoun.value}，勾了「${countLabel}」所以不会增删。`
      : `本次改动全部${groupNoun.value}，可以让 AI 新增或删除；不想变动数量就勾下面的「${countLabel}」。`
  }
  const label = scopeOptions.find(item => item.value === scope.value)?.label || ''
  return `本次只改动「${label}」，设定其余部分原样保留。`
})

const placeholder = computed(() => (
  hasTarget.value
    ? '例如：把动机从复仇改成守护，保留他与主角的师徒关系，语气更阴沉。'
    : '例如：把力量体系的代价写得更重；增加一条与主角对立的暗线。'
))

const submitEnabled = computed(() => Boolean(instruction.value.trim()))
const submitDisabledTip = '请先填写调整要求'

const requestSummary = computed(() => {
  const source = props.candidate?.request || currentRequest()
  const group = toGroupScope(source.scope)
  const parts = [scopeOptions.find(item => item.value === group)?.label || '整份设定']
  if (source.targetId) {
    const target = targetOptions.value.find(item => item.id === source.targetId)
    parts.push(target?.label || source.targetId)
  }
  const preserveLabels = source.preserve
    .map(key => preserveOptions.find(item => item.key === key)?.label)
    .filter(Boolean)
  if (preserveLabels.length) parts.push(`保留${preserveLabels.join('、')}`)
  if (source.instruction.trim()) parts.push(source.instruction.trim())
  return parts.join(' · ')
})

/** 服务端的单条目 scope 反查回它所属的组，供表单回填与摘要展示 */
function toGroupScope(value: WorkflowSettingAdjustScope): SettingAdjustGroupScope {
  const hit = Object.entries(TARGET_SCOPES).find(
    ([, config]) => config.itemScope === value
  )
  return (hit?.[0] as SettingAdjustGroupScope) || (value as SettingAdjustGroupScope)
}

function currentRequest(): WorkflowSettingAdjustRequest {
  // 选了目标就是单条目，没选就是整组——服务端的两个 scope 在这里合并成一个选择。
  const target = TARGET_SCOPES[scope.value as keyof typeof TARGET_SCOPES]
  return {
    scope: hasTarget.value && target ? target.itemScope : scope.value,
    targetId: hasTarget.value ? targetId.value : '',
    instruction: instruction.value.trim(),
    // 范围切换后被隐藏的保留项不应继续随请求提交。
    preserve: preserve.value.filter(key => (
      availablePreserveOptions.value.some(option => option.key === key)
    )),
  }
}

const selectScope = (value: SettingAdjustGroupScope) => {
  scope.value = value
  // 换了范围，上一次选的目标多半已经不属于当前列表，直接清掉重选。
  targetId.value = ''
}

/** 再点一次取消选择，回到「调整全部」 */
const toggleTarget = (id: string) => {
  targetId.value = targetId.value === id ? '' : id
}

const togglePreserve = (key: WorkflowSettingPreserveKey) => {
  preserve.value = preserve.value.includes(key)
    ? preserve.value.filter(item => item !== key)
    : [...preserve.value, key]
}

const submit = () => {
  if (!submitEnabled.value) return
  emit('generate', currentRequest())
}

// 抽屉关闭不清空草稿，只有候选回来时才回填成候选自身的请求，
// 避免「再生成一版」时带着已被改过的表单。
watch(() => props.candidate, next => {
  if (next?.request) {
    scope.value = toGroupScope(next.request.scope)
    targetId.value = next.request.targetId
    instruction.value = next.request.instruction
    preserve.value = [...next.request.preserve]
  }
})

/** 从外部直接指定要调整的条目（角色卡 / 剧情线卡上的按钮） */
const openForTarget = (kind: 'character' | 'storyline', id: string) => {
  scope.value = toGroupScope(kind)
  targetId.value = id
}

defineExpose({
  restoreRequest: (request: WorkflowSettingAdjustRequest) => {
    scope.value = toGroupScope(request.scope)
    targetId.value = request.targetId
    instruction.value = request.instruction
    preserve.value = [...request.preserve]
  },
  openForTarget,
  // 应用之后只清掉已生效的要求，范围和保留项保留：
  // 连着调几轮是常态，每次都要重选范围很烦。
  resetDraft: () => {
    instruction.value = ''
  },
})
</script>
