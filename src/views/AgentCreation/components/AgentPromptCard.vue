<template>
  <div class="ac-choice-group ac-prompt-card">
    <div v-if="kind === 'compare' && compared.length" class="ac-prompt-compare">
      <article v-for="artifact in compared" :key="artifact.id">
        <header>
          <strong>{{ artifact.title }}</strong>
          <button class="ac-text-link" type="button" @click="store.openedArtifactId = artifact.id">
            展开全文
          </button>
        </header>
        <p>{{ excerpt(artifact.content) }}</p>
      </article>
    </div>

    <button
      v-if="message.choice?.skillReview"
      type="button"
      class="ac-button ink-btn ink-btn-outline"
      @click="viewSkill"
    >
      查看技能完整文件
    </button>
    <AgentSkillReview v-model:visible="reviewVisible" :preview="skillPreview" mode="view" />

    <AgentPromptSteps
      v-if="kind === 'steps' && steps.length"
      :message-id="message.id"
      :steps="steps"
      :draft="draft"
      :submitting="store.submitting"
      @update="store.updatePromptDraft"
      @submit="answer => store.answerPrompt(answer, message.id)"
    />

    <fieldset v-if="kind !== 'form' && kind !== 'confirm' && kind !== 'steps' && options.length">
      <legend class="ac-sr-only">{{ kind === 'multi' ? '可以选多项' : '选择一项' }}</legend>
      <label
        v-for="option in options"
        :key="option.id"
        class="ac-choice"
        :class="{ selected: draft.selectedIds.includes(option.id) }"
      >
        <input
          :type="kind === 'multi' ? 'checkbox' : 'radio'"
          :name="message.id"
          :value="option.id"
          :checked="draft.selectedIds.includes(option.id)"
          @change="toggle(option.id)"
        /><span
          ><strong>{{ option.title }}</strong
          ><small v-if="option.description">{{ option.description }}</small>
          <details v-if="option.preview" class="ac-prompt-preview" @click.stop>
            <summary>看示例</summary>
            <p>{{ option.preview }}</p>
          </details></span
        >
      </label>
    </fieldset>

    <div v-if="kind === 'form'" class="ac-prompt-form">
      <label v-for="field in fields" :key="field.key">
        <span
          >{{ field.label }}<em v-if="field.required" aria-hidden="true">*</em
          ><span v-if="field.required" class="ac-sr-only">（必填）</span></span
        >
        <el-select
          v-if="field.type === 'select' && field.options?.length"
          :model-value="draft.fields[field.key] || ''"
          class="ink-select"
          popper-class="ink-select-popper"
          :placeholder="field.placeholder || '请选择'"
          :aria-label="field.label"
          @update:model-value="(value: unknown) => setField(field.key, String(value || ''))"
        >
          <el-option v-for="item in field.options" :key="item" :label="item" :value="item" />
        </el-select>
        <textarea
          v-else-if="field.type === 'textarea'"
          class="ink-input"
          rows="3"
          :value="draft.fields[field.key] || ''"
          :placeholder="field.placeholder || ''"
          @input="setField(field.key, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <input
          v-else
          class="ink-input"
          :type="field.type === 'number' ? 'number' : 'text'"
          :value="draft.fields[field.key] || ''"
          :placeholder="field.placeholder || ''"
          @input="setField(field.key, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <label v-if="freeTextInCard" class="ac-prompt-free">
      <span>{{ kind === 'form' ? '补充说明（可选）' : '其他想法（可选）' }}</span>
      <textarea
        class="ink-input"
        rows="2"
        :value="draft.text"
        placeholder="没有合适的选项时，直接写你的想法"
        @input="setText(($event.target as HTMLTextAreaElement).value)"
      ></textarea>
    </label>

    <p v-if="otherPending" class="ac-step-note">
      还有 {{ otherPending }} 个问题待回答；也可以在输入框直接发送新的要求。
    </p>
    <div v-if="kind !== 'steps'" class="ac-choice-footer" :class="{ 'is-confirm': kind === 'confirm' }">
      <span v-if="hint">{{ hint }}</span>
      <div v-if="kind === 'confirm'" class="ac-actions">
        <button
          v-for="(option, index) in options"
          :key="option.id"
          class="ac-button ink-btn ink-btn-sm"
          :class="index === 0 ? 'ink-btn-primary' : 'ink-btn-outline'"
          :disabled="store.submitting"
          @click="submit([option.id])"
        >
          {{ option.title }}
        </button>
      </div>
      <button
        v-else
        class="ac-button ink-btn ink-btn-primary ink-btn-sm"
        :disabled="store.submitting || !ready"
        @click="submit(draft.selectedIds)"
      >
        {{
          kind === 'form'
            ? formEmpty
              ? '都交给 Agent 建议'
              : '提交'
            : kind === 'multi'
              ? '按所选继续'
              : '按此方向继续'
        }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { agentCommand } from '@/agent/client'
import AgentSkillReview from './AgentSkillReview.vue'
import type { AgentMessage, AgentPromptDraft, AgentSkillPreview } from '@/types/agent-creation'
import type { AuthorAnswer, AuthorPrompt, PromptOption } from '@/types/canon'
import { useAgentWorkspace } from '../use-agent-workspace'
import AgentPromptSteps from './AgentPromptSteps.vue'

const props = defineProps<{ message: AgentMessage }>()
const store = useAgentWorkspace()

const reviewVisible = ref(false)
const skillPreview = ref<AgentSkillPreview | null>(null)
async function viewSkill() {
  const review = props.message.choice?.skillReview
  if (!review) return
  try {
    const preview = await agentCommand<AgentSkillPreview>('skill_inspect', { id: review.id })
    const hash = review.action === 'run' ? preview.scriptHash : preview.revision
    if (hash !== review.hash) throw new Error('技能文件已变化，请取消当前确认并让 Agent 重新操作。')
    skillPreview.value = preview
    reviewVisible.value = true
  } catch (error) {
    ElMessage.error(String(error))
  }
}

/** 旧会话只有 choice 字段：当作单选卡 */
const prompt = computed<AuthorPrompt>(
  () =>
    props.message.prompt || {
      kind: 'choice',
      question: props.message.text,
      options: (props.message.choice?.options || []).map(o => ({
        id: o.id,
        title: o.title,
        description: o.description
      })),
      allowFreeText: true
    }
)
const kind = computed(() => prompt.value.kind)
const options = computed<PromptOption[]>(() => prompt.value.options || [])
const fields = computed(() => prompt.value.fields || [])
const steps = computed(() => prompt.value.steps || [])
const compared = computed(() =>
  (prompt.value.artifactIds || [])
    .map(id => store.artifacts.find(item => item.id === id))
    .filter((item): item is NonNullable<typeof item> => !!item)
)
/** 单选与对比卡的自由回答走下方输入框；多选与表单在卡片里补充 */
const freeTextInCard = computed(
  () =>
    kind.value !== 'steps' &&
    prompt.value.allowFreeText &&
    (kind.value === 'multi' || kind.value === 'form' || !options.value.length)
)
const hint = computed(() => {
  if (kind.value === 'multi') return '可以选多项。'
  // 必填由 Agent 逐项标注；留空的选填项会告诉 Agent 由它先给建议
  if (kind.value === 'form')
    return fields.value.some(field => field.required)
      ? '带 * 的必须填写；其余留空的，Agent 会先给建议。'
      : '都可以留空，留空的 Agent 会先给建议。'
  if (kind.value === 'confirm') return ''
  return prompt.value.allowFreeText ? '也可以在下方输入框直接说你的想法。' : ''
})

/** 同一轮里其余还没回答的卡 */
const pendingCards = computed(() =>
  (store.active?.messages || []).filter(item => item.choice?.status === 'pending')
)
const otherPending = computed(() => pendingCards.value.filter(item => item.id !== props.message.id).length)
const isLatestCard = computed(
  () => pendingCards.value[pendingCards.value.length - 1]?.id === props.message.id
)
const draft = computed<AgentPromptDraft>(() => {
  const saved = store.active?.promptDraft
  // 草稿按卡片区分；旧草稿没有 messageId，只属于最后一张卡
  if (saved && (saved.messageId ? saved.messageId === props.message.id : isLatestCard.value)) return saved
  const initial =
    props.message.choice?.defaultId ??
    (isLatestCard.value ? store.active?.choiceId : '') ??
    prompt.value.defaultOptionId ??
    ''
  return {
    messageId: props.message.id,
    selectedIds: kind.value === 'multi' || !initial ? [] : [initial],
    text: '',
    fields: Object.fromEntries(fields.value.map(field => [field.key, field.default || '']))
  }
})
const ready = computed(() => {
  const value = draft.value
  // 与宿主 check_answer 同一口径：表单只要求必填项；选填项全空也能交，等于“都交给 Agent 建议”
  if (kind.value === 'form')
    return fields.value.every(field => !field.required || String(value.fields[field.key] ?? '').trim())
  return value.selectedIds.length > 0 || !!value.text.trim()
})

/** 表单一项没填、也没写补充说明 */
const formEmpty = computed(
  () =>
    !draft.value.text.trim() &&
    fields.value.every(field => !String(draft.value.fields[field.key] ?? '').trim())
)
function save(next: Partial<AgentPromptDraft>) {
  store.updatePromptDraft({
    ...draft.value,
    ...next,
    fields: { ...draft.value.fields, ...(next.fields || {}) }
  })
}
function toggle(id: string) {
  const current = draft.value.selectedIds
  save({
    selectedIds:
      kind.value === 'multi'
        ? current.includes(id)
          ? current.filter(item => item !== id)
          : [...current, id]
        : [id]
  })
}
function setField(key: string, value: string) {
  save({ fields: { [key]: value } })
}
function setText(value: string) {
  save({ text: value })
}
function excerpt(text: string) {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > 220 ? `${plain.slice(0, 220)}…` : plain
}
async function submit(selectedIds: string[]) {
  const value = draft.value
  const answer: AuthorAnswer = { selectedIds }
  if (value.text.trim()) answer.text = value.text.trim()
  const filled = Object.fromEntries(
    Object.entries(value.fields)
      .map(([key, item]) => [key, String(item ?? '').trim()])
      .filter(([, item]) => item)
  )
  if (kind.value === 'form' && Object.keys(filled).length) answer.fields = filled
  await store.answerPrompt(answer, props.message.id)
}
</script>
