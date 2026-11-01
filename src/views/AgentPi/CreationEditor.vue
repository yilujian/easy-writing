<template>
  <div class="pi-creation-editor">
    <p>{{ creationSummary(draft, modelValue) }}</p>
    <label v-for="(value, key) in fields" :key="key" class="pi-creation-field">
      <span>{{ spec.fields[key].label }}</span>
      <small v-if="draft.targetId">原值：{{ original(key) }}</small>
      <select
        v-if="draft.entity === 'book' && key === 'styleSkillId'"
        :value="value"
        :disabled="disabled"
        aria-label="默认文风技能"
        @change="change(key, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">跟随本书正文</option>
        <option v-for="skill in piSkills.filter(s => s.enabled)" :key="skill.id" :value="skill.id">
          {{ skillLabel(skill) }}
        </option>
      </select>
      <el-select
        v-else-if="spec.fields[key].reference || spec.fields[key].enum"
        :model-value="selectValue(value)"
        :disabled="disabled"
        :multiple="spec.fields[key].type === 'strings'"
        :clearable="!!spec.fields[key].nullable"
        :aria-label="spec.fields[key].label"
        @update:model-value="change(key, $event)"
      >
        <el-option
          v-for="option in options(key)"
          :key="String(option.value)"
          :value="option.value"
          :label="option.label"
        />
      </el-select>
      <el-input-number
        v-else-if="spec.fields[key].type === 'number'"
        :model-value="Number(value)"
        :disabled="disabled"
        :min="spec.fields[key].min"
        :max="spec.fields[key].max"
        :precision="0"
        :aria-label="spec.fields[key].label"
        @update:model-value="change(key, $event)"
      />
      <el-select
        v-else-if="draft.entity === 'book' && key === 'tags'"
        :model-value="value as string[]"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        :disabled="disabled"
        aria-label="标签"
        placeholder="输入标签后回车，可留空"
        @update:model-value="change(key, $event)"
      >
        <el-option v-for="tag in value as string[]" :key="tag" :label="tag" :value="tag" />
      </el-select>
      <el-input
        v-else-if="draft.entity === 'book' && key !== 'intro'"
        :model-value="String(value ?? '')"
        :readonly="disabled"
        :aria-label="spec.fields[key].label"
        :placeholder="spec.fields[key].required ? '请输入书名' : '未设定，可留空'"
        @update:model-value="change(key, $event)"
      />
      <el-input
        v-else
        :model-value="Array.isArray(value) ? value.join('\n') : String(value ?? '')"
        type="textarea"
        :autosize="{ minRows: draft.entity === 'book' ? 4 : 2, maxRows: 12 }"
        :readonly="disabled"
        :aria-label="spec.fields[key].label"
        :placeholder="spec.fields[key].type === 'strings' ? '每行一项' : ''"
        @update:model-value="
          change(key, spec.fields[key].type === 'strings' ? $event.split('\n').filter(Boolean) : $event)
        "
      />
    </label>
    <p v-if="referenceError" role="alert">{{ referenceError }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PiEntityDraft } from '@/types/agent-pi'
import { piSkills, skillLabel } from '@/agent-pi/skills'
import { entitySpecs, creationFormFields, creationSummary } from '@/agent-pi/creation'
import { readDoc } from '@/storage/local-reference-store'
import { getLocalLibraryStorage } from '@/storage/local-library'
const props = defineProps<{ draft: PiEntityDraft; modelValue: string; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const spec = computed(() => entitySpecs[props.draft.entity])
const fields = computed(() => creationFormFields(props.draft, props.modelValue))
const references = ref<Record<string, Array<{ id: string | number; title?: string; name?: string }>>>({})
const referenceError = ref('')
watch(
  () => props.draft.id,
  async id => {
    referenceError.value = ''
    references.value = {}
    if (!props.draft.bookId) return
    try {
      const [doc, tree] = await Promise.all([
        readDoc(props.draft.bookId),
        getLocalLibraryStorage().getLocalBookTree(props.draft.bookId)
      ])
      if (props.draft.id !== id) return
      references.value = {
        ...Object.fromEntries(Object.entries(doc).filter(([, value]) => Array.isArray(value))),
        chapters: tree.flatMap(v => v.children),
        outlineNodes: doc.outlineNodes.filter(v => v.nodeType === 0)
      }
    } catch {
      referenceError.value = '资料名称读取失败，请重新打开候选后核对目标。'
    }
  },
  { immediate: true }
)
function selectValue(value: unknown): string | number | string[] | undefined {
  return value == null ? undefined : (value as string | number | string[])
}
function options(key: string) {
  const field = spec.value.fields[key]
  if (field.enum) return field.enum.map((v, i) => ({ value: v, label: field.options?.[i] || String(v) }))
  const result = (references.value[field.reference || ''] || []).map(v => ({
    value: field.type === 'number' ? Number(v.id) : String(v.id),
    label: v.title || v.name || String(v.id)
  }))
  if (key === 'parentId') result.unshift({ value: '0', label: '根目录' })
  const values = Array.isArray(fields.value[key]) ? (fields.value[key] as unknown[]) : [fields.value[key]]
  for (const value of values)
    if (value != null && !result.some(o => String(o.value) === String(value)))
      result.push({ value: value as string | number, label: `未找到目标（${value}）` })
  return result
}
function change(key: string, value: unknown) {
  if (props.disabled) return
  const field = spec.value.fields[key]
  if (field.nullable && (value === '' || value === undefined)) value = null
  emit('update:modelValue', JSON.stringify({ ...fields.value, [key]: value }))
}
function original(key: string) {
  const value = props.draft.baseEntity?.[key]
  if (spec.value.fields[key].reference || spec.value.fields[key].enum) {
    const values = Array.isArray(value) ? value : [value]
    return (
      values
        .filter(v => v != null)
        .map(v => options(key).find(o => String(o.value) === String(v))?.label || String(v))
        .join('、') || '空'
    )
  }
  // 大纲原文按文本展示；不在确认面板执行存储中的 HTML。
  const text = Array.isArray(value) ? value.join('、') : String(value ?? '')
  return (spec.value.fields[key].format === 'plain_html' ? text.replace(/<[^>]*>/g, '') : text) || '空'
}
</script>
<style scoped>
.pi-creation-editor {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}
.pi-creation-editor > p {
  color: var(--pi-muted, var(--ink-sec));
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
}
/* Element Plus 在输入框旁创建无 class 的测量节点，不能继承全局 textarea 的最小高度。 */
.pi-creation-editor :deep(.el-textarea > textarea:not(.el-textarea__inner)) {
  min-height: 0;
}
.pi-creation-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 18px 0;
}
.pi-creation-field > span {
  font-weight: 600;
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.pi-creation-field small {
  color: var(--pi-muted, var(--ink-sec));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow: auto;
}
</style>