<template>
  <div class="character-aliases-input">
    <el-select
      :model-value="normalizeCharacterAliases(name, modelValue)"
      class="ink-select"
      popper-class="ink-select-popper"
      multiple
      filterable
      allow-create
      default-first-option
      :reserve-keyword="false"
      :disabled="disabled"
      aria-label="角色别名"
      placeholder="输入别名后按回车"
      @update:model-value="emit('update:modelValue', normalizeCharacterAliases(name, $event))"
    >
      <el-option v-for="alias in modelValue || []" :key="alias" :label="alias" :value="alias" />
    </el-select>
    <p v-if="conflicts.length" class="alias-conflicts" role="status">
      {{ conflicts.join('；') }}。正文中遇到这些称呼时会保留候选角色。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { buildCharacterNameIndex, getCharacterNames, normalizeCharacterAliases, type CharacterNames } from '@/utils/character-aliases'

const props = defineProps<{
  modelValue?: string[]
  name: string
  characterId?: string | number | null
  characters: CharacterNames[]
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const conflicts = computed(() => {
  const others = props.characters.filter(item => String(item.id) !== String(props.characterId))
  const index = buildCharacterNameIndex(others)
  return getCharacterNames({ name: props.name, aliases: props.modelValue })
    .filter(name => index.has(name))
    .map(name => `「${name}」也用于${index.get(name)!.map(item => `「${item.name}」`).join('、')}`)
})
</script>

<style scoped>
.character-aliases-input { min-width: 0; width: 100%; }
.character-aliases-input :deep(.el-select) { width: 100%; }
.alias-conflicts { margin: 6px 0 0; color: var(--ink-main); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
