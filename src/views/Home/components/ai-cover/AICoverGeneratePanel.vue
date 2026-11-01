<template>
  <div class="cover-config-panel">
    <div class="cover-field prompt-field">
      <div class="field-heading">
        <label class="field-label" for="cover-prompt">画面描述</label>
        <button class="assist-button" type="button" :disabled="promptPolishing || !prompt.trim()" @click="emit('polish')">
          <i v-if="promptPolishing" class="fa-solid fa-spinner fa-spin"></i>
          <i v-else class="fa-solid fa-wand-magic-sparkles"></i>
          AI 润色
        </button>
      </div>
      <textarea
        id="cover-prompt"
        v-model="prompt"
        class="ink-input cover-textarea"
        maxlength="200"
        placeholder="描述人物、场景、氛围和构图，例如：孤城残雪，衣袂翻飞的剑修立于城头，远处星河倒映……"
      ></textarea>
      <div class="field-help">
        <span>{{ prompt.length }}/200</span>
      </div>
    </div>

    <div class="cover-field">
      <label class="field-label">图片模型</label>
      <ModelChip v-model="imageModel" group-code="image_generation" />
    </div>

    <div class="cover-field">
      <div class="field-heading">
        <label class="field-label">视觉风格</label>
        <span class="optional-mark">可不选</span>
      </div>
      <div class="choice-grid style-grid">
        <button
          v-for="item in styleOptions"
          :key="item.value || 'auto'"
          type="button"
          class="choice-button"
          :class="{ active: style === item.value }"
          @click="style = item.value"
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <div class="cover-field">
      <div class="field-heading">
        <label class="field-label">色调倾向</label>
        <span class="optional-mark">可不选</span>
      </div>
      <div class="tone-options">
        <button type="button" class="auto-tone" :class="{ active: tone === '' }" @click="tone = ''">自动匹配</button>
        <button
          v-for="item in toneOptions"
          :key="item.value"
          type="button"
          class="tone-button"
          :class="{ active: tone === item.value }"
          :title="item.label"
          @click="tone = item.value"
        >
          <span class="tone-dot" :style="{ background: item.color }"></span>
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>

    <button class="ink-btn ink-btn-primary primary-action" type="button" :disabled="generating" @click="emit('generate')">
      <i v-if="generating" class="fa-solid fa-spinner fa-spin"></i>
      <i v-else class="fa-solid fa-wand-magic-sparkles"></i>
      {{ generating ? '正在生成' : '立即生成' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import ModelChip from '@/components/ModelChip.vue'
import type { CoverChoiceOption } from './types'

defineProps<{
  styleOptions: CoverChoiceOption[]
  toneOptions: CoverChoiceOption[]
  generating: boolean
  promptPolishing: boolean
}>()

const emit = defineEmits<{
  (event: 'polish'): void
  (event: 'generate'): void
}>()

const prompt = defineModel<string>('prompt', { required: true })
const style = defineModel<string>('style', { required: true })
const tone = defineModel<string>('tone', { required: true })
const imageModel = defineModel<string>('imageModel', { required: true })
</script>

<style scoped lang="scss">
.cover-config-panel {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cover-field {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.field-label {
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.optional-mark,
.field-help {
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.field-help {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  line-height: 1.5;
}

.cover-textarea {
  min-height: 118px;
  resize: vertical;
}

.assist-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--btn-ghost-bg);
  color: var(--ink-sec);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--ink-accent);
    border-color: var(--ink-accent);
  }
}

.choice-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.choice-button,
.auto-tone {
  min-height: 36px;
  border: 1px solid var(--input-border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--ink-sec);
  cursor: pointer;

  &:hover,
  &.active {
    color: var(--ink-main);
    border-color: var(--ink-accent);
  }

  &.active {
    background: var(--selection-bg-color);
    font-weight: 600;
  }
}

.tone-options {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.auto-tone {
  min-height: 30px;
  padding: 0 12px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.tone-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  cursor: pointer;

  &.active {
    color: var(--ink-main);
    font-weight: 600;
  }
}

.tone-dot {
  width: 24px;
  height: 24px;
  border: 1px solid var(--ui-border);
  border-radius: 50%;
  box-shadow: 0 0 0 2px transparent;
}

.tone-button.active .tone-dot {
  box-shadow: 0 0 0 2px var(--panel-bg), 0 0 0 4px var(--ink-accent);
}

.primary-action {
  width: 100%;
  min-height: 42px;
  margin-top: auto;
  border-radius: 999px;
}

@media (max-width: 760px) {
  .choice-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
