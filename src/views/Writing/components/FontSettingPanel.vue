<!-- FontSettingPanel.vue - 字体排版设置面板 -->
<template>
  <div class="font-setting-panel">
    <!-- 字体选择行 -->
    <div class="setting-row">
      <span class="setting-label">字体</span>
      <div class="setting-controls">
        <el-select
          ref="fontSelect"
          v-model="fontFamily"
          class="ink-select"
          fit-input-width
          :teleported="true"
          popper-class="ink-select-popper"
        >
          <el-option :value="defaultFamily" label="默认" />
          <el-option :value="WENKAI_FONT_FAMILY" label="霞鹜文楷" />
          <el-option value="KaiTi, STKaiti, KaiTi_GB2312, serif" label="楷体" />
          <el-option value="SimSun, Songti SC, serif" label="宋体" />
          <el-option value="SimHei, Source Han Sans SC, Microsoft YaHei, sans-serif" label="黑体" />
          <el-option value="Arial, Helvetica, sans-serif" label="Arial" />
          <el-option value="Times New Roman, Times, serif" label="Times" />
          <el-option
            v-for="font in importedFonts"
            :key="font.id"
            :value="font.value"
            :label="font.name"
          />
          <template #footer>
            <FontImportButton @click="openFontImport" />
          </template>
        </el-select>
        <button
          class="icon-btn"
          :class="{ active: fontBold }"
          @click="fontBold = !fontBold"
          title="加粗"
        >
          <span class="bold-icon">B</span>
        </button>
        <el-color-picker
          v-model="fontColor"
          show-alpha
          :teleported="true"
          popper-class="color-picker-popper"
        />
      </div>
    </div>

    <!-- 字号 -->
    <div class="setting-row">
      <span class="setting-label">字号</span>
      <div class="setting-controls slider-row">
        <el-slider
          v-model="fontSize"
          :min="12"
          :max="28"
          :step="1"
          :show-tooltip="false"
        />
        <span class="value-text">{{ fontSize }}</span>
      </div>
    </div>

    <!-- 行高 -->
    <div class="setting-row">
      <span class="setting-label">行高</span>
      <div class="setting-controls slider-row">
        <el-slider
          v-model="fontLineHeight"
          :min="1.4"
          :max="3"
          :step="0.1"
          :show-tooltip="false"
        />
        <span class="value-text">{{ fontLineHeight.toFixed(1) }}</span>
      </div>
    </div>

    <!-- 行宽 -->
    <div class="setting-row">
      <span class="setting-label">行宽</span>
      <div class="setting-controls slider-row">
        <el-slider
          v-model="contentWidth"
          :min="30"
          :max="100"
          :step="1"
          :show-tooltip="false"
        />
        <span class="value-text">{{ contentWidth }}%</span>
      </div>
    </div>

    <!-- 段落设置 -->
    <div class="paragraph-settings" role="group" aria-label="段落设置">
      <div class="paragraph-setting">
        <span>段间自动空1行</span>
        <el-switch v-model="isParagraphGap" aria-label="段间自动空1行" />
      </div>
      <div class="paragraph-setting">
        <span>首行缩进2字符</span>
        <el-switch v-model="isFirstLineIndent" aria-label="首行缩进2字符" />
      </div>
    </div>

    <!-- 网格线设置 -->
    <div class="setting-section">
      <div class="section-title">网格线</div>
      <div class="ruler-options">
        <div
          class="ruler-option"
          :class="{ active: rulerStyle === 'none' }"
          @click="rulerStyle = 'none'"
        >
          <div class="ruler-preview none-preview">
            <div class="slash-line"></div>
          </div>
          <span class="ruler-label">无</span>
        </div>
        <div
          class="ruler-option"
          :class="{ active: rulerStyle === 'solid' }"
          @click="rulerStyle = 'solid'"
        >
          <div class="ruler-preview">
            <div class="solid-line"></div>
          </div>
          <span class="ruler-label">实线</span>
        </div>
        <div
          class="ruler-option"
          :class="{ active: rulerStyle === 'dashed' }"
          @click="rulerStyle = 'dashed'"
        >
          <div class="ruler-preview">
            <div class="dashed-line"></div>
          </div>
          <span class="ruler-label">虚线</span>
        </div>
      </div>
    </div>

    <!-- 重置按钮 -->
    <div class="setting-footer">
      <button class="reset-btn" @click="handleReset">
        重置为默认
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SelectInstance } from 'element-plus'
import { WENKAI_FONT_FAMILY } from '@/config/editor-fonts'
import { importedFonts } from '@/composables/use-imported-fonts'
import FontImportButton from '@/components/FontImportButton.vue'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { storeToRefs } from 'pinia'

const editorStore = useWritingEditorStore()
const emit = defineEmits<{ 'import-font': [] }>()
const fontSelect = ref<SelectInstance>()

const defaultFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Arial, PingFang SC, Microsoft YaHei'

// 使用 storeToRefs 获取响应式引用
const { fontBold, fontSize, fontLineHeight, contentWidth, isParagraphGap, isFirstLineIndent, rulerStyle } = storeToRefs(editorStore)

// 字体族需要特殊处理
const fontFamily = computed({
  get: () => editorStore.fontFamily,
  set: (val: string) => editorStore.setFontFamily(val)
})

const openFontImport = () => {
  fontSelect.value?.blur()
  emit('import-font')
}

// 字体颜色需要特殊处理（可能为空）
const fontColor = computed({
  get: () => editorStore.fontColor,
  set: (val: string | null | undefined) => editorStore.setFontColor(val)
})

// 重置设置
const handleReset = () => {
  editorStore.resetToDefaultPreferences()
}
</script>

<style lang="scss" scoped>
.font-setting-panel {
  width: 100%;
  font-family: system-ui, -apple-system, sans-serif;
}

.setting-row {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
  gap: 12px;
}

.setting-label {
  width: max(36px, 2.5em);
  flex-shrink: 0;
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
}

.setting-controls {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.slider-row {
  gap: 12px;

  :deep(.el-slider) {
    flex: 1;

    .el-slider__runway {
      height: 4px;
      background-color: var(--progress-track-bg);
    }

    .el-slider__bar {
      height: 4px;
      background-color: var(--ink-accent);
    }

    .el-slider__button-wrapper {
      height: 20px;
      width: 20px;
      top: -10px;
    }

    .el-slider__button {
      width: 16px;
      height: 16px;
      border: 2px solid var(--ink-accent);
      background: var(--ui-glass-bg);
    }
  }
}

.value-text {
  width: max(40px, 3.3em);
  text-align: right;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  flex-shrink: 0;
}

/* 字体选择器 */
.font-select {
  width: 120px;
}

/* 加粗按钮 */
.icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;

  &:hover {
    border-color: var(--ink-accent);
    background: var(--input-focus-bg);
  }

  &.active {
    background: var(--ink-accent);
    border-color: var(--ink-accent);
    color: var(--on-inverse);
  }

  .bold-icon {
    font-weight: 700;
    font-size: calc(14px * var(--ui-font-scale, 1));
    color: var(--ink-main);
  }

  &.active .bold-icon {
    color: var(--on-inverse);
  }
}

/* 颜色选择器 */
:deep(.el-color-picker) {
  .el-color-picker__trigger {
    width: 32px;
    height: 32px;
    padding: 3px;
    border: 1px solid var(--input-border);
    border-radius: 6px;
    background: var(--input-bg);

    &:hover {
      border-color: var(--ink-accent);
    }
  }

  .el-color-picker__color {
    border: none;
    border-radius: 4px;
  }
}

/* 段落设置：文字与开关分列对齐 */
.paragraph-settings {
  padding: 8px 0;
  border-top: 1px solid var(--ui-border);
}

.paragraph-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: calc(36px * var(--ui-control-scale, 1));
  gap: 16px;
  color: var(--ink-sec);
  font-size: calc(13px * var(--ui-font-scale, 1));

  :deep(.el-switch) {
    flex-shrink: 0;
    --el-switch-on-color: var(--ink-accent);
    --el-switch-off-color: var(--input-border);
  }
}

@media (prefers-reduced-motion: reduce) {
  .paragraph-setting :deep(.el-switch__core),
  .paragraph-setting :deep(.el-switch__action) {
    transition: none;
  }
}

/* 网格线设置区域 */
.setting-section {
  // margin-top: 20px;
  // padding-top: 16px;
  border-top: 1px solid var(--ui-border);
}

.section-title {
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-bottom: 12px;
}

.ruler-options {
  display: flex;
  gap: 16px;
}

.ruler-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
}

.ruler-preview {
  width: 60px;
  height: 38px;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: var(--input-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  overflow: hidden;

  .ruler-option:hover & {
    border-color: var(--ink-sec);
  }

  .ruler-option.active & {
    border: 2px solid var(--ink-accent);
  }
}

.none-preview {
  position: relative;
}

.slash-line {
  width: 100%;
  height: 100%;
  background: linear-gradient(
    to top right,
    transparent calc(50% - 0.5px),
    var(--ink-sec),
    transparent calc(50% + 0.5px)
  );
  opacity: 0.4;
}

.solid-line {
  width: 80%;
  height: 1px;
  background: var(--ink-sec);
}

.dashed-line {
  width: 80%;
  height: 0;
  border-top: 2px dashed var(--ink-sec);
}

.ruler-label {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-top: 6px;
}

/* 底部重置按钮 */
.setting-footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--ui-border);
  display: flex;
  justify-content: flex-end;
}

.reset-btn {
  padding: 6px 16px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;

  &:hover {
    color: var(--ink-main);
    border-color: var(--ink-main);
    background: var(--input-focus-bg);
  }
}
</style>

<!-- 全局样式覆盖 Element Plus 弹出层 -->
<style lang="scss">
/* 字体选择下拉框弹出层样式 */
.font-select-popper {
  .el-select-dropdown__item {
    color: var(--ink-sec);
    font-size: calc(13px * var(--ui-font-scale, 1));

    &.hover,
    &:hover {
      background: var(--input-bg);
      color: var(--ink-main);
    }

    &.is-selected,
    &.selected {
      color: var(--ink-accent);
      font-weight: 600;
      background: transparent;
    }
  }
}

/* 颜色选择器弹出层样式 */
.color-picker-popper {
  background: var(--ui-glass-bg) !important;
  backdrop-filter: blur(16px);
  border: 1px solid var(--ui-border) !important;

  .el-color-picker__panel {
    background: transparent;
    border: none;
  }
}
</style>
