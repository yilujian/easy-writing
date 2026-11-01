<template>
          <section class="settings-pane">
            <section class="settings-section-block">
              <div class="number-title"><span>1</span><strong>主题风格</strong></div>
              <div class="theme-card-grid">
                <button
                  v-for="theme in themeStore.themes"
                  :key="theme.value"
                  type="button"
                  class="theme-choice-card"
                  :class="{ active: selectedTheme === theme.value }"
                  @click="selectedTheme = theme.value"
                >
                  <span class="theme-preview" :class="`theme-preview-${theme.value}`"></span>
                  <strong>{{ theme.label }}</strong>
                  <small>{{ getThemeDescription(theme.value) }}</small>
                  <i v-if="selectedTheme === theme.value" class="fa-solid fa-check selected-check"></i>
                </button>
              </div>
            </section>

            <section class="settings-section-block">
              <div class="number-title"><span>2</span><strong>界面字号</strong></div>
              <div class="settings-card thin ui-font-setting">
                <label id="ui-font-size-label" class="setting-label">界面文字大小</label>
                <p class="ui-font-description">调整菜单、侧栏、工具栏和弹窗的文字大小，正文字号保持独立。</p>
                <div class="ui-font-control">
                  <el-slider
                    v-model="uiDraft.uiFontSize"
                    :min="MIN_UI_FONT_SIZE"
                    :max="MAX_UI_FONT_SIZE"
                    :step="1"
                    :show-tooltip="false"
                    aria-label="界面文字大小"
                  />
                  <output aria-live="polite">{{ uiDraft.uiFontSize }}px</output>
                  <button
                    type="button"
                    class="ink-btn ink-btn-outline ink-btn-sm"
                    :disabled="uiDraft.uiFontSize === DEFAULT_UI_FONT_SIZE"
                    @click="uiDraft.uiFontSize = DEFAULT_UI_FONT_SIZE"
                  >默认</button>
                </div>
                <div class="ui-font-preview" :style="{ fontSize: `${uiDraft.uiFontSize}px` }">界面文字预览 · 易创，让写作更舒适</div>
              </div>
            </section>

            <section class="settings-section-block">
              <div class="number-title"><span>3</span><strong>阅读与排版</strong></div>
              <div class="appearance-form-grid">
                <div class="settings-card thin">
                  <div class="font-choice-heading">
                    <span class="setting-label">字体选择</span>
                    <FontImportButton @click="showFontImport = true" />
                  </div>
                  <div class="option-row four">
                    <button
                      v-for="item in fontOptions"
                      :key="item.value"
                      type="button"
                      class="settings-option-btn"
                      :class="{ active: editorDraft.fontFamily === item.value }"
                      @click="editorDraft.fontFamily = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                  <el-select
                    v-if="importedFonts.length"
                    v-model="selectedImportedFont"
                    class="imported-font-select"
                    popper-class="settings-select-popper"
                    placeholder="已导入字体"
                    aria-label="已导入字体"
                    fit-input-width
                  >
                    <el-option v-for="font in importedFonts" :key="font.id" :value="font.value" :label="font.name" />
                  </el-select>
                </div>
                <div class="settings-card thin">
                  <span class="setting-label">正文字号</span>
                  <div class="slider-row">
                    <span>A-</span>
                    <el-slider v-model="editorDraft.fontSize" :min="14" :max="22" :step="1" />
                    <strong>{{ editorDraft.fontSize }}px</strong>
                  </div>
                </div>
                <div class="settings-card thin">
                  <span class="setting-label">行宽选择</span>
                  <div class="option-row three">
                    <button
                      v-for="item in contentWidthOptions"
                      :key="item.value"
                      type="button"
                      class="settings-option-btn"
                      :class="{ active: editorDraft.contentWidth === item.value }"
                      @click="editorDraft.contentWidth = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </div>
                <div class="settings-card thin">
                  <span class="setting-label">行距</span>
                  <div class="slider-row">
                    <span><i class="fa-solid fa-list"></i></span>
                    <el-slider v-model="editorDraft.fontLineHeight" :min="1.4" :max="2.2" :step="0.05" />
                    <strong>{{ editorDraft.fontLineHeight.toFixed(2) }}</strong>
                  </div>
                </div>
                <div class="settings-card thin">
                  <span class="setting-label">正文对齐方式</span>
                  <div class="option-row four">
                    <button
                      v-for="item in alignOptions"
                      :key="item.value"
                      type="button"
                      class="settings-icon-btn"
                      :class="{ active: editorDraft.alignMode === item.value }"
                      :title="item.label"
                      @click="editorDraft.alignMode = item.value"
                    >
                      <i :class="item.icon"></i>
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <FontImportModal
              v-if="showFontImport"
              v-model:visible="showFontImport"
              @imported="editorDraft.fontFamily = $event"
            />
          </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import FontImportButton from '@/components/FontImportButton.vue'
import FontImportModal from '@/components/FontImportModal.vue'
import { importedFonts } from '@/composables/use-imported-fonts'
import { useThemeStore } from '@/stores/theme'
import { WENKAI_FONT_FAMILY } from '@/config/editor-fonts'
import type { SettingsOption } from '@/types/settings-center'
import { DEFAULT_UI_FONT_SIZE, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE } from '@/utils/ui-typography'
import { useSettingsCenterCtx } from '../settings-context'

const ctx = useSettingsCenterCtx()
const { editorDraft, uiDraft, selectedTheme } = ctx
const themeStore = useThemeStore()
const showFontImport = ref(false)

const selectedImportedFont = computed({
  get: () => importedFonts.value.some((font) => font.value === editorDraft.fontFamily) ? editorDraft.fontFamily : '',
  set: (value: string) => { editorDraft.fontFamily = value },
})

const fontOptions: Array<SettingsOption> = [
  { label: '思源宋体', value: '"Noto Serif SC", "Songti SC", SimSun, serif' },
  { label: '系统黑体', value: 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Arial, PingFang SC, Microsoft YaHei' },
  { label: '仿宋', value: 'FangSong, STFangsong, "Noto Serif SC", serif' },
  { label: '霞鹜文楷', value: WENKAI_FONT_FAMILY },
]

const contentWidthOptions = [
  { label: '窄', value: 52 },
  { label: '标准', value: 60 },
  { label: '宽', value: 72 },
]

const alignOptions: Array<SettingsOption<'left' | 'center' | 'justify'>> = [
  { label: '左对齐', value: 'left', icon: 'fa-solid fa-align-left' },
  { label: '居中', value: 'center', icon: 'fa-solid fa-align-center' },
  { label: '两端对齐', value: 'justify', icon: 'fa-solid fa-align-justify' },
]

const getThemeDescription = (theme: string) => {
  if (theme === 'yellow') return '信笺雅致，书香古韵'
  if (theme === 'green') return '自然柔和，舒缓护眼'
  if (theme === 'dark') return '深色沉浸，静谧专注'
  return '清爽通透，专注创作'
}
</script>

<style scoped lang="scss">
.ui-font-setting { min-width: 0; }
.ui-font-description { margin: 0 0 12px; color: var(--ink-sec); font-size: calc(13px * var(--ui-font-scale, 1)); line-height: 1.6; }
.ui-font-control {
  display: flex;
  align-items: center;
  gap: 16px;
  max-width: 520px;
  :deep(.el-slider) { flex: 1; min-width: 60px; }
  output { min-width: 3.5em; text-align: right; color: var(--ink-main); font-variant-numeric: tabular-nums; }
  button { flex-shrink: 0; }
}
.ui-font-preview { margin-top: 12px; padding: 12px 16px; border-radius: 6px; background: var(--input-bg); color: var(--ink-main); line-height: 1.7; overflow-wrap: anywhere; }
.font-choice-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;

  .setting-label { margin-bottom: 0; }
}

.imported-font-select { margin-top: 10px; }
</style>
