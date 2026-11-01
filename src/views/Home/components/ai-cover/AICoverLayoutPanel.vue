<template>
  <div class="cover-layout-panel">
    <div class="cover-field">
      <div class="field-heading">
        <label class="field-label">封面绑定</label>
        <span class="optional-mark">可不选</span>
      </div>
      <el-select
        v-model="selectedBookId"
        clearable
        placeholder="选择书籍绑定（可不选）"
        :disabled="bookLoading"
        class="ink-select"
        popper-class="ink-select-popper"
      >
        <el-option label="不绑定书籍" value="" />
        <el-option
          v-for="item in bookOptions"
          :key="item.id"
          :label="item.title || `书籍#${item.id}`"
          :value="String(item.id)"
        />
      </el-select>
      <span class="field-help">绑定后，“应用封面”会直接更新该作品的封面。</span>
    </div>

    <div class="overlay-section">
      <label class="switch-heading" data-testid="title-overlay-toggle">
        <span>
          <strong>叠加封面标题</strong>
          <small>由编辑器排版，不依赖生图模型写字</small>
        </span>
        <el-switch v-model="titleEnabled" size="small" aria-label="叠加封面标题" />
      </label>

      <div v-if="titleEnabled" class="overlay-fields">
        <div class="cover-field">
          <label class="field-label" for="cover-title">封面标题</label>
          <textarea
            id="cover-title"
            v-model="title"
            class="ink-input title-input"
            rows="3"
            maxlength="120"
            placeholder="输入封面标题，支持手动换行"
          ></textarea>
          <div class="field-help title-help">
            <span>可在右侧封面上拖动标题框并调整大小</span>
            <span>{{ title.length }}/120</span>
          </div>
        </div>
      </div>
    </div>

    <div class="overlay-section">
      <label class="switch-heading" data-testid="author-overlay-toggle">
        <span>
          <strong>叠加作者名</strong>
          <small>关闭后不会写入最终封面</small>
        </span>
        <el-switch v-model="authorEnabled" size="small" aria-label="叠加作者名" />
      </label>
      <div v-if="authorEnabled" class="overlay-fields">
        <input v-model="author" type="text" class="ink-input" maxlength="30" placeholder="输入作者名" />
      </div>
    </div>

    <template v-if="titleEnabled || authorEnabled">
      <div class="cover-field">
        <label class="field-label">文字方向</label>
        <div class="two-choice-grid">
          <button type="button" class="choice-button" :class="{ active: !vertical }" @click="vertical = false">横向排版</button>
          <button type="button" class="choice-button" :class="{ active: vertical }" @click="vertical = true">竖向排版</button>
        </div>
      </div>

      <div class="cover-field">
        <label class="field-label">字体选择</label>
        <div class="two-choice-grid">
          <button
            v-for="item in fontOptions"
            :key="item.value"
            type="button"
            class="choice-button"
            :class="{ active: font === item.value }"
            :style="{ fontFamily: item.family }"
            @click="font = item.value"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="cover-field">
        <div class="field-heading">
          <label class="field-label" for="cover-font-size">标题字号</label>
          <span class="optional-mark">{{ fontSize }}</span>
        </div>
        <input id="cover-font-size" v-model.number="fontSize" type="range" class="size-slider" min="26" max="90" />
      </div>

      <div class="cover-field">
        <label class="field-label">文字颜色</label>
        <div class="color-row">
          <button
            v-for="item in textColorOptions"
            :key="item.value"
            type="button"
            class="color-button"
            :class="{ active: normalizedTextColor === item.value }"
            :title="item.label"
            @click="emit('select-color', item.value)"
          >
            <span :style="{ background: item.color }"></span>
          </button>
          <input
            type="color"
            class="native-color-input"
            :value="normalizedTextColor"
            aria-label="自定义文字颜色"
            @input="emitColorInput"
          />
          <input v-model.trim="textColor" type="text" class="ink-input color-input" maxlength="7" @blur="emit('normalize-color')" />
        </div>
      </div>

      <div class="cover-field">
        <label class="field-label">文字效果</label>
        <div class="effect-row">
          <el-checkbox v-model="shadow">投影</el-checkbox>
          <el-checkbox v-model="stroke">描边</el-checkbox>
        </div>
      </div>
    </template>

    <button class="ink-btn ink-btn-outline reset-button" type="button" @click="emit('reset')">
      <i class="fa-solid fa-rotate-left"></i>
      恢复为纯画面
    </button>
  </div>
</template>

<script setup lang="ts">
import type { CoverBookOption, CoverChoiceOption, CoverFontOption } from './types'

defineProps<{
  bookOptions: CoverBookOption[]
  bookLoading: boolean
  fontOptions: CoverFontOption[]
  textColorOptions: CoverChoiceOption[]
  normalizedTextColor: string
}>()

const emit = defineEmits<{
  (event: 'reset'): void
  (event: 'select-color', value: string): void
  (event: 'normalize-color'): void
}>()

const selectedBookId = defineModel<string>('selectedBookId', { required: true })
const titleEnabled = defineModel<boolean>('titleEnabled', { required: true })
const authorEnabled = defineModel<boolean>('authorEnabled', { required: true })
const title = defineModel<string>('title', { required: true })
const author = defineModel<string>('author', { required: true })
const font = defineModel<string>('font', { required: true })
const fontSize = defineModel<number>('fontSize', { required: true })
const textColor = defineModel<string>('textColor', { required: true })
const vertical = defineModel<boolean>('vertical', { required: true })
const shadow = defineModel<boolean>('shadow', { required: true })
const stroke = defineModel<boolean>('stroke', { required: true })

const emitColorInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null
  if (target) emit('select-color', target.value)
}
</script>

<style scoped lang="scss">
.cover-layout-panel {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cover-field,
.overlay-fields {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.field-heading,
.switch-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.field-label,
.switch-heading strong {
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.optional-mark,
.field-help,
.switch-heading small {
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.overlay-section {
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--input-bg) 82%, transparent);
}

.switch-heading > span {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.overlay-fields {
  padding-top: 12px;
}

.title-input {
  min-height: 82px;
}

.title-help {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.two-choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.choice-button {
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

.size-slider {
  width: 100%;
  accent-color: var(--ink-accent);
}

.color-row,
.effect-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.color-button {
  display: inline-flex;
  padding: 2px;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;

  span {
    width: 23px;
    height: 23px;
    border: 1px solid var(--ui-border);
    border-radius: 50%;
  }

  &.active {
    border-color: var(--ink-accent);
  }
}

.native-color-input {
  width: 31px;
  height: 31px;
  padding: 2px;
  border: 1px solid var(--input-border);
  border-radius: 7px;
  background: var(--input-bg);
}

.color-input {
  width: 92px;
}

.reset-button {
  width: 100%;
  min-height: 40px;
  margin-top: auto;
}
</style>
