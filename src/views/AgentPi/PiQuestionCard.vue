<template>
  <section class="pi-question-card" :aria-label="spec.question" :aria-busy="busy">
    <h3>{{ spec.question }}</h3>
    <p v-if="spec.description" class="pi-question-desc">{{ spec.description }}</p>

    <div v-if="plan" class="pi-plan" aria-label="拆书范围">
      <div>
        <small>参考书</small><strong>《{{ plan.title }}》</strong>
      </div>
      <div>
        <small>范围</small><strong>{{ plan.scope }} · {{ plan.chapterCount }} 章</strong>
      </div>
      <div v-if="plan.reusable">
        <small>已有结果</small><strong>{{ plan.reusable }} 章</strong>
      </div>
      <div>
        <small>模型</small><strong>{{ plan.model }}</strong>
      </div>
      <div v-if="plan.estimatedTokens">
        <small>粗估用量</small><strong>{{ formatTokens(plan.estimatedTokens) }}</strong>
      </div>
      <div v-if="plan.estimatedMinutes?.length">
        <small>粗估时间</small><strong>{{ plan.estimatedMinutes.join('–') }} 分钟</strong>
      </div>
      <p v-if="plan.chapters?.length" class="pi-plan-chapters">
        {{ plan.chapters.join('、')
        }}<template v-if="plan.chapterCount > plan.chapters.length"> 等 {{ plan.chapterCount }} 章</template>
      </p>
    </div>

    <div v-if="batch" class="pi-plan" aria-label="批量写作目标">
      <div>
        <small>作品</small><strong>《{{ batch.title }}》</strong>
      </div>
      <div>
        <small>范围</small><strong>{{ batch.scope }} · {{ batch.goals.length }} 章</strong>
      </div>
      <div>
        <small>模型</small><strong>{{ batch.model }}</strong>
      </div>
      <ol class="pi-plan-goals">
        <li v-for="(goal, i) in batch.goals" :key="i">{{ goal }}</li>
      </ol>
    </div>
    <div v-if="cover" class="pi-plan" aria-label="封面简报">
      <div v-if="cover.summary">
        <small>简报</small><strong>{{ cover.summary }}</strong>
      </div>
      <div v-if="cover.style">
        <small>风格</small><strong>{{ cover.style }}</strong>
      </div>
      <div v-if="cover.size">
        <small>尺寸</small><strong>{{ cover.size }}</strong>
      </div>
      <div v-if="cover.model">
        <small>模型</small><strong>{{ cover.model }}</strong>
      </div>
      <p v-if="cover.prompt" class="pi-plan-chapters">{{ cover.prompt }}</p>
    </div>
    <div v-if="script" class="pi-plan" aria-label="技能脚本">
      <div>
        <small>技能</small><strong>{{ script.skill }}</strong>
      </div>
      <div>
        <small>脚本</small><strong>{{ script.script }}</strong>
      </div>
      <div v-if="script.args.length">
        <small>参数</small><strong>{{ script.args.join(' ') }}</strong>
      </div>
      <p v-if="script.reason" class="pi-plan-chapters">{{ script.reason }}</p>
    </div>

    <div
      v-if="optionGrid && spec.options.length"
      class="pi-question-options"
      role="group"
      :aria-label="spec.multiple ? '可以选多项' : '选择一项'"
    >
      <template v-for="option in spec.options" :key="option.id">
        <button
          type="button"
          class="pi-question-option"
          :class="{ 'is-selected': selected.includes(option.id), 'is-multi': spec.multiple }"
          :aria-pressed="selected.includes(option.id)"
          :disabled="busy"
          @click="toggle(option.id)"
        >
          <span class="pi-question-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
          <span class="pi-question-option-text"
            ><strong>{{ option.title }}</strong
            ><small v-if="option.description">{{ option.description }}</small></span
          >
        </button>
        <label v-if="option.input && selected.includes(option.id)" class="pi-question-option-input">
          <span>{{ option.input.label || option.title }}</span>
          <input
            class="ink-input"
            type="text"
            :value="inputs[option.id] || ''"
            :placeholder="option.input.placeholder || ''"
            :aria-label="option.input.label || option.title"
            :disabled="busy"
            @input="inputs[option.id] = ($event.target as HTMLInputElement).value"
            @keydown="onInputKeydown"
            @vue:mounted="focusInput"
          />
        </label>
      </template>
    </div>
    <div
      v-else-if="spec.kind === 'confirm'"
      class="pi-question-choices"
      role="group"
      :aria-label="spec.question"
    >
      <button
        v-for="(option, index) in spec.options"
        :key="option.id"
        type="button"
        class="pi-question-choice"
        :class="{ 'is-primary': index === 0 }"
        :disabled="busy"
        @click="submit([option.id])"
      >
        <strong>{{ option.title }}</strong
        ><small v-if="option.description">{{ option.description }}</small>
      </button>
    </div>
    <label v-if="spec.allowFreeText || !spec.options.length" class="pi-question-free">
      <span>{{ spec.options.length ? '也可以直接写你的想法' : '你的回答' }}</span>
      <textarea
        ref="inputBox"
        v-model="freeText"
        class="ink-input"
        :rows="spec.multiline ? 5 : 2"
        :placeholder="spec.placeholder || '写下你的回答'"
        :aria-label="spec.question"
        :disabled="busy"
        @keydown="onInputKeydown"
      ></textarea>
    </label>
    <div class="pi-question-footer">
      <span class="pi-question-hint">{{ hint }}</span>
      <div class="pi-question-actions">
        <button type="button" class="pi-text-link" :disabled="busy" @click="$emit('cancel')">
          取消本次选择
        </button>
        <template v-if="spec.kind === 'choice'">
          <button
            type="button"
            class="ink-btn ink-btn-sm"
            :class="{ 'ink-btn-primary': defaultAction === 'pause' }"
            :disabled="busy || !ready"
            @click="submit(selected, 'pause')"
          >
            保存回答并暂停
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-sm"
            :class="{ 'ink-btn-primary': defaultAction === 'continue' }"
            :disabled="busy || !ready"
            @click="submit(selected, 'continue')"
          >
            提交回答
          </button>
        </template>
        <button
          v-else-if="optionGrid || !spec.options.length"
          type="button"
          class="ink-btn ink-btn-primary ink-btn-sm"
          :disabled="busy || !ready"
          @click="submit()"
        >
          {{ busy ? '提交中…' : '确认并继续' }}
        </button>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { formatTokens } from '@/writing-service/reference-book'
import type { PiQuestionAnswer, PiQuestionSpec } from '@/types/agent-pi'

const props = defineProps<{ spec: PiQuestionSpec; busy?: boolean }>()
const emit = defineEmits<{ (event: 'answer', answer: PiQuestionAnswer): void; (event: 'cancel'): void }>()
const selected = ref<string[]>(props.spec.defaultOptionId ? [props.spec.defaultOptionId] : [])
const freeText = ref('')
const inputs = reactive<Record<string, string>>({})
const inputBox = ref<HTMLTextAreaElement>()
const plan = computed(() => (props.spec.card?.type === 'breakdown-plan' ? props.spec.card.plan : null))
const script = computed(() => (props.spec.card?.type === 'skill-script' ? props.spec.card : null))
const cover = computed(() => (props.spec.card?.type === 'cover-brief' ? props.spec.card : null))
const batch = computed(() => (props.spec.card?.type === 'batch-plan' ? props.spec.card : null))
const optionGrid = computed(
  () =>
    props.spec.kind === 'choice' ||
    props.spec.multiple ||
    props.spec.allowFreeText ||
    props.spec.options.some(o => o.input)
)
const missingInput = (ids: string[]) =>
  ids.some(id => props.spec.options.find(o => o.id === id)?.input && !inputs[id]?.trim())
const ready = computed(
  () => !missingInput(selected.value) && (selected.value.length > 0 || !!freeText.value.trim())
)
const defaultAction = computed(() => props.spec.afterAnswer || 'continue')
const hint = computed(() => {
  if (!optionGrid.value && props.spec.options.length) return '点击选项即可确认。'
  if (missingInput(selected.value)) return '填好所选项的内容再提交。'
  return props.spec.kind === 'choice'
    ? `Enter ${defaultAction.value === 'pause' ? '保存并暂停' : '提交回答'}，Shift + Enter 换行。`
    : 'Enter 提交，Shift + Enter 换行。'
})
const focusInput = (vnode: { el?: HTMLInputElement | null }) => vnode.el?.focus({ preventScroll: true })
function toggle(id: string) {
  selected.value = props.spec.multiple
    ? selected.value.includes(id)
      ? selected.value.filter(item => item !== id)
      : [...selected.value, id]
    : selected.value[0] === id
      ? []
      : [id]
}
function submit(ids = selected.value, nextAction = defaultAction.value) {
  if (props.busy || missingInput(ids) || (!ids.length && !freeText.value.trim())) return
  const chosen = props.spec.options.filter(option => ids.includes(option.id))
  const filled = Object.fromEntries(
    chosen
      .filter(option => option.input && inputs[option.id]?.trim())
      .map(option => [option.id, inputs[option.id].trim()])
  )
  emit('answer', {
    selected: chosen.map(option => option.title),
    selectedIds: chosen.map(option => option.id),
    ...(props.spec.kind === 'choice' ? { nextAction } : {}),
    ...(freeText.value.trim() ? { text: freeText.value.trim() } : {}),
    ...(Object.keys(filled).length ? { inputs: filled } : {})
  })
}
function onInputKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (ready.value) submit()
}
onMounted(() => {
  if (!props.spec.options.length) inputBox.value?.focus({ preventScroll: true })
})
</script>
