<template>
  <div class="pi-creation-editor">
    <p>{{ summary }}</p>
    <label class="pi-creation-field">
      <span>名字</span>
      <input class="ink-input" :value="fields.name" :disabled="disabled" maxlength="60" aria-label="技能名字" @input="change('name', ($event.target as HTMLInputElement).value)" />
    </label>
    <label class="pi-creation-field">
      <span>什么时候用</span>
      <textarea class="ink-input" rows="2" :value="fields.description" :disabled="disabled" aria-label="技能说明" @input="change('description', ($event.target as HTMLTextAreaElement).value)"></textarea>
    </label>
    <label class="pi-creation-field">
      <span>给 Agent 的说明</span>
      <textarea class="ink-input pi-skill-draft-body" rows="18" :value="fields.instructions" :disabled="disabled" spellcheck="false" aria-label="技能正文" @input="change('instructions', ($event.target as HTMLTextAreaElement).value)"></textarea>
    </label>
    <label v-for="(file, index) in fields.files" :key="file.path" class="pi-creation-field">
      <span>{{ file.path }}</span>
      <textarea class="ink-input" rows="6" :value="file.content" :disabled="disabled" spellcheck="false" :aria-label="file.path" @input="changeFile(index, ($event.target as HTMLTextAreaElement).value)"></textarea>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PiSkillDraft } from '@/types/agent-pi'
import { serializeSkillFields, skillDraftFields } from '@/agent-pi/skill-draft'
import { skillDisplayName } from '@/agent-pi/skills'

const props = defineProps<{ draft: PiSkillDraft; modelValue: string; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const fields = computed(() => skillDraftFields(props.modelValue))
const summary = computed(() => {
  const replaced = fields.value.replaceId ? skillDisplayName(fields.value.replaceId) : ''
  return replaced ? `替换技能「${replaced}」，采用后写进技能目录，输入 / 就能用。` : '新建技能，采用后写进技能目录，输入 / 就能用。'
})
function change(key: 'name' | 'description' | 'instructions', value: string) {
  emit('update:modelValue', serializeSkillFields({ ...fields.value, [key]: value }))
}
function changeFile(index: number, content: string) {
  const files = fields.value.files.map((file, i) => (i === index ? { ...file, content } : file))
  emit('update:modelValue', serializeSkillFields({ ...fields.value, files }))
}
</script>
