<template>
  <div class="setting-character-wrap">
    <div ref="gridRef" class="setting-character-grid">
      <article v-for="character in characters" :key="character.id" class="setting-character-card">
        <div class="setting-character-avatar" aria-hidden="true">
          <i class="fa-solid fa-user"></i>
        </div>
        <div class="setting-character-body">
          <div class="setting-character-head">
            <WorkflowInlineEdit
              class="setting-character-name"
              compact
              :model-value="character.name"
              @update:model-value="updateCharacter(character.id, { name: $event })"
            />
            <span v-if="character.badge" class="setting-character-badge">{{ character.badge }}</span>
            <span class="setting-character-actions">
              <button
                type="button"
                :aria-label="`让 AI 调整${character.name}`"
                title="让 AI 调整这一条"
                @click="$emit('adjust', character.id)"
              >
                <i class="fa-solid fa-wand-magic-sparkles"></i>
              </button>
              <button
                type="button"
                :aria-label="`删除${character.name}`"
                title="删除这张角色卡"
                @click="removeCharacter(character.id)"
              >
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </span>
          </div>

          <div class="setting-character-field">
            <span class="setting-field-label">别名</span>
            <CharacterAliasesInput
              :model-value="character.aliases" :name="character.name"
              :character-id="character.id" :characters="characters"
              @update:model-value="updateCharacter(character.id, { aliases: $event })" />
          </div>
          <div class="setting-character-field">
            <span class="setting-field-label">身份</span>
            <WorkflowInlineEdit
              block
              :model-value="character.identity"
              @update:model-value="updateCharacter(character.id, { identity: $event })"
            />
          </div>
          <div class="setting-character-field">
            <span class="setting-field-label">背景</span>
            <WorkflowInlineEdit
              block
              multiline
              :rows="2"
              :model-value="character.background"
              @update:model-value="updateCharacter(character.id, { background: $event })"
            />
          </div>

          <div class="setting-character-divider"></div>

          <div class="setting-character-field">
            <span class="setting-field-label">关键词</span>
            <WorkflowInlineEdit
              block
              :model-value="character.keywords"
              @update:model-value="updateCharacter(character.id, { keywords: $event })"
            />
          </div>
          <div class="setting-character-field">
            <span class="setting-field-label">动机</span>
            <WorkflowInlineEdit
              block
              :model-value="character.motivation"
              @update:model-value="updateCharacter(character.id, { motivation: $event })"
            />
          </div>
        </div>
      </article>
    </div>

  </div>
</template>

<script setup lang="ts">
import CharacterAliasesInput from '@/components/CharacterAliasesInput.vue'
import { normalizeCharacterAliases } from '@/utils/character-aliases'
import { nextTick, ref, watch } from 'vue'
import WorkflowInlineEdit from '../WorkflowInlineEdit.vue'
import { createNewSettingCharacter } from '../../workflow-adapter'
import type { WorkflowSettingCharacter } from '../../types'

const props = defineProps<{ characters: WorkflowSettingCharacter[] }>()
const emit = defineEmits<{
  (event: 'update', characters: WorkflowSettingCharacter[]): void
  (event: 'adjust', id: string): void
}>()

const gridRef = ref<HTMLElement | null>(null)
// 新卡追加在网格末尾，而滚动容器是外层面板——不主动滚过去，矮屏幕上根本看不到。
// 数据由父级回流，所以等 props 真的变长再滚，而不是 emit 之后就滚。
let pendingScrollToEnd = false

watch(
  () => props.characters.length,
  async (next, prev) => {
    if (!pendingScrollToEnd || next <= prev) return
    pendingScrollToEnd = false
    await nextTick()
    gridRef.value?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
)

const updateCharacter = (id: string, payload: Partial<WorkflowSettingCharacter>) => {
  emit('update', props.characters.map(item => {
    if (item.id !== id) return item
    const updated = { ...item, ...payload }
    return { ...updated, aliases: normalizeCharacterAliases(updated.name, updated.aliases) }
  }))
}

const removeCharacter = (id: string) => {
  emit('update', props.characters.filter(item => item.id !== id))
}

const addCharacter = () => {
  pendingScrollToEnd = true
  emit('update', [...props.characters, createNewSettingCharacter()])
}

// 新增入口移到了页签行（吸顶常驻），这里只对外提供动作
defineExpose({ addItem: addCharacter })
</script>
