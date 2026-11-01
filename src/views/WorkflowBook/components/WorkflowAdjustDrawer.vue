<template>
  <Transition name="adjust-drawer">
    <aside v-if="visible" class="adjust-drawer" role="dialog" :aria-label="inputTitle">
      <header class="adjust-drawer__head">
        <div class="adjust-drawer__heading">
          <div class="adjust-drawer__title">
            <strong>{{ headText }}</strong>
            <template v-if="phase === 'candidate'">
              <span class="adjust-drawer-badge is-done">已生成</span>
              <span class="adjust-drawer-badge">未应用</span>
            </template>
          </div>
        </div>
        <button type="button" aria-label="关闭" @click="$emit('close')">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>

      <div class="adjust-drawer__body">
        <WorkflowRecoveryPanel v-if="runId" :run-id="runId" :draft-key="recoveryKey" />
        <!-- 1. 输入调整要求：各步骤的表单差异都收在这个插槽里 -->
        <template v-if="phase === 'input'">
          <slot name="form"></slot>

          <p v-if="errorMessage" class="adjust-drawer-error">
            <i class="fa-solid fa-circle-exclamation"></i>
            {{ errorMessage }}
          </p>

          <p class="adjust-drawer-cost">
            <i class="fa-solid fa-circle-info"></i>
            将使用 {{ modelName || '当前模型' }}，生成一次调整候选
          </p>
        </template>

        <!-- 2. 正在生成候选 -->
        <template v-else-if="phase === 'generating'">
          <section class="adjust-drawer-progress">
            <div class="adjust-drawer-progress__head">
              <i class="fa-solid fa-circle-notch fa-spin"></i>
              <span>{{ generatingText }}</span>
            </div>
            <div class="adjust-drawer-progress__bar">
              <div class="adjust-drawer-progress__value" :style="{ width: `${clampedPercent}%` }"></div>
            </div>
            <em>{{ clampedPercent }}%</em>
          </section>

          <ol class="adjust-drawer-stages">
            <li v-for="(stage, index) in stages" :key="stage.key" :class="`is-${stage.status}`">
              <span class="adjust-drawer-stages__dot">
                <i v-if="stage.status === 'done'" class="fa-solid fa-check"></i>
                <i v-else-if="stage.status === 'running'" class="fa-solid fa-circle-notch fa-spin"></i>
              </span>
              <span class="adjust-drawer-stages__no">{{ index + 1 }}</span>
              <span class="adjust-drawer-stages__label">{{ stage.label }}</span>
              <span class="adjust-drawer-stages__status">{{ stageStatusText(stage.status) }}</span>
            </li>
          </ol>

          <details class="adjust-drawer-summary" open>
            <summary>本次要求</summary>
            <p>{{ requestSummary }}</p>
          </details>

          <p class="adjust-drawer-note">
            <i class="fa-solid fa-circle-info"></i>
            {{ generatingNote }}
          </p>
        </template>

        <!-- 3. 候选对比 -->
        <template v-else>
          <section v-if="candidate" class="adjust-drawer-candidate">
            <div class="adjust-drawer-candidate__head">
              <strong>{{ candidate.changes.length }} 处主要调整</strong>
            </div>
            <div v-if="candidate.tags.length" class="adjust-drawer-tags">
              <span v-for="tag in candidate.tags" :key="tag">{{ tag }}</span>
            </div>

            <p v-if="candidate.manualEditCount > 0" class="adjust-drawer-warning">
              <i class="fa-solid fa-triangle-exclamation"></i>
              你手动改过 {{ candidate.manualEditCount }} 处，整体重生的候选会一并覆盖，应用前请先确认。
            </p>

            <article
              v-for="(change, index) in candidate.changes"
              :key="change.key"
              class="adjust-drawer-change"
            >
              <div class="adjust-drawer-change__head">
                <span>{{ index + 1 }}</span>
                <strong>{{ change.label }}</strong>
              </div>
              <dl>
                <div>
                  <dt>原内容</dt>
                  <dd>{{ displayChangeText(change.before, change.key) }}</dd>
                </div>
                <div>
                  <dt>候选内容</dt>
                  <dd class="is-next">{{ displayChangeText(change.after, change.key) }}</dd>
                </div>
              </dl>
              <button
                v-if="change.before.length > PREVIEW_LENGTH || change.after.length > PREVIEW_LENGTH"
                type="button"
                class="adjust-drawer-change__toggle"
                :aria-expanded="expandedKeys.has(change.key)"
                :aria-label="`${expandedKeys.has(change.key) ? '收起' : '展开全文'}：${change.label}`"
                @click="toggleChange(change.key)"
              >
                {{ expandedKeys.has(change.key) ? '收起' : '展开全文' }}
              </button>
            </article>

            <p
              class="adjust-drawer-consistency"
              :class="{ 'is-failed': !candidate.consistency.passed }"
            >
              <i :class="candidate.consistency.passed ? 'fa-solid fa-circle-check' : 'fa-solid fa-triangle-exclamation'"></i>
              {{ candidate.consistency.message }}
            </p>

            <!-- 软提示：与大纲对不上不拦截应用，改名本身可能就是用户本意 -->
            <p
              v-for="warning in candidate.consistency.warnings || []"
              :key="warning"
              class="adjust-drawer-warning"
            >
              <i class="fa-solid fa-triangle-exclamation"></i>
              {{ warning }}
            </p>

            <details class="adjust-drawer-summary">
              <summary>查看本次要求与保留项</summary>
              <p>{{ requestSummary }}</p>
            </details>
          </section>
        </template>
      </div>

      <footer class="adjust-drawer__foot">
        <template v-if="phase === 'input'">
          <button class="adjust-drawer-btn" type="button" @click="$emit('close')">取消</button>
          <button
            class="adjust-drawer-btn is-primary"
            type="button"
            :disabled="!submitEnabled"
            :title="submitEnabled ? '' : submitDisabledTip"
            @click="$emit('submit')"
          >
            生成调整候选
          </button>
        </template>

        <template v-else-if="phase === 'generating'">
          <button class="adjust-drawer-btn is-danger is-block" type="button" @click="$emit('stop')">
            <i class="fa-solid fa-stop"></i>
            停止生成
          </button>
          <p class="adjust-drawer-foot-note">{{ stopNote }}</p>
        </template>

        <template v-else>
          <div class="adjust-drawer-foot-actions">
            <button class="adjust-drawer-btn" type="button" @click="$emit('discard')">废弃</button>
            <button class="adjust-drawer-btn is-outline" type="button" @click="$emit('regenerate')">再生成一版</button>
            <button class="adjust-drawer-btn is-primary" type="button" @click="$emit('apply')">应用候选</button>
          </div>
          <p class="adjust-drawer-foot-note">{{ applyNote }}</p>
        </template>
      </footer>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 「按要求调整」抽屉的公共外壳。
 *
 * 大纲调整与设定调整的骨架完全一致：头部状态、生成进度与阶段、候选差异列表、
 * 底部三按钮。真正不同的只有「填要求」那段表单——范围选项、保留项、目标选择器，
 * 所以那部分交给 form 插槽，由各步骤自己提供并自行组装请求。
 */
import { computed, ref, watch } from 'vue'
import WorkflowRecoveryPanel from '@/components/WorkflowRecoveryPanel.vue'
import type {
  WorkflowAdjustCandidateView,
  WorkflowAdjustPhase,
  WorkflowAdjustStage,
  WorkflowAdjustStageStatus,
} from '../types'

const props = withDefaults(defineProps<{
  runId?: number
  recoveryKey?: string
  visible: boolean
  phase: WorkflowAdjustPhase
  /** 输入阶段的标题，同时用作抽屉的无障碍名称 */
  inputTitle: string
  generatingTitle: string
  candidateTitle: string
  generatingText: string
  generatingNote: string
  stopNote: string
  applyNote: string
  requestSummary: string
  submitEnabled: boolean
  submitDisabledTip?: string
  modelName?: string
  percent?: number
  stages?: WorkflowAdjustStage[]
  candidate?: WorkflowAdjustCandidateView | null
  errorMessage?: string
}>(), {
  submitDisabledTip: '请先填写调整要求',
  runId: 0,
  recoveryKey: '',
  modelName: '',
  percent: 0,
  stages: () => [],
  candidate: null,
  errorMessage: '',
})

defineEmits<{
  (event: 'close'): void
  (event: 'submit'): void
  (event: 'stop'): void
  (event: 'discard'): void
  (event: 'regenerate'): void
  (event: 'apply'): void
}>()

const PREVIEW_LENGTH = 60
const expandedKeys = ref(new Set<string>())
const toggleChange = (key: string) => {
  if (expandedKeys.value.has(key)) expandedKeys.value.delete(key)
  else expandedKeys.value.add(key)
}
const displayChangeText = (text: string, key: string) => {
  if (!text) return '（空）'
  return !expandedKeys.value.has(key) && text.length > PREVIEW_LENGTH
    ? `${text.slice(0, PREVIEW_LENGTH)}…`
    : text
}
watch(() => props.candidate, () => expandedKeys.value.clear())

const clampedPercent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent))))

const headText = computed(() => {
  if (props.phase === 'generating') return props.generatingTitle
  if (props.phase === 'candidate') return props.candidateTitle
  return props.inputTitle
})

const stageStatusText = (status: WorkflowAdjustStageStatus) => (
  { pending: '等待中', running: '进行中', done: '已完成' }[status]
)
</script>
