<template>
  <EwModal
    v-model:visible="visibleProxy"
    :title="activeMeta.title"
    width="min(1720px, 90vw)"
    height="min(1040px, 90vh)"
    custom-class="settings-center-modal"
    :close-on-click-modal="true"
    @open="loadSettings"
  >
    <template #header>
      <div class="settings-modal-title">
        <h2>{{ activeMeta.title }}</h2>
        <p>{{ activeMeta.description }}</p>
      </div>
    </template>

    <div class="settings-center-shell">
      <aside class="settings-center-nav">
        <div v-for="group in navGroups" :key="group.title" class="settings-nav-group">
          <span class="settings-nav-title">{{ group.title }}</span>
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="settings-nav-item"
            :class="{ active: activeSection === item.id }"
            @click="activeSection = item.id"
          >
            <i :class="item.icon"></i>
            <span>{{ item.label }}</span>
          </button>
        </div>
      </aside>

      <main class="settings-center-main">
        <div ref="paneScrollRef" class="settings-pane-scroll">
          <OverviewPane v-if="activeSection === 'overview'" />
          <WritingPane v-else-if="activeSection === 'writing'" />
          <MenuPane v-else-if="activeSection === 'menus'" />
          <AppearancePane v-else-if="activeSection === 'appearance'" />
          <SyncPane v-else-if="activeSection === 'sync'" />
          <SensitiveWordsPane v-else-if="activeSection === 'sensitive'" />
          <section v-else-if="activeSection === 'record'" class="settings-pane settings-pane--fill">
            <AiRecordPane />
          </section>
          <CachePane v-else />
        </div>
      </main>
    </div>

    <template #footer>
      <!-- AI 调用记录：只读，不适用草稿式保存 -->
      <div v-if="isInstantSection" class="settings-footer">
        <span class="footer-hint">{{ instantHint }}</span>
        <div class="footer-actions">
          <button type="button" class="ink-btn ink-btn-outline" @click="visibleProxy = false">关闭</button>
        </div>
      </div>
      <div v-else class="settings-footer">
        <button type="button" class="ink-btn ink-btn-outline" @click="restoreDefaults">
          恢复默认
        </button>
        <div class="footer-actions">
          <button type="button" class="ink-btn ink-btn-outline" @click="visibleProxy = false">取消</button>
          <button type="button" class="ink-btn ink-btn-primary" :disabled="saving" @click="saveSettings">
            <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
            保存设置
          </button>
        </div>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, nextTick, provide, reactive, ref, toRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import EwModal from '@/components/EwModal/index.vue'
import AiRecordPane from '@/views/Writing/components/AiRecordPane.vue'
import { useThemeStore } from '@/stores/theme'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { getLocalBackupService } from '@/storage/local-backup-service'
import {
  DEFAULT_LOCAL_WRITING_SETTINGS,
  isTauriRuntime,
  normalizeLocalWritingSettings,
  type LocalWritingSettings,
} from '@/storage'
import type { EditorPreferenceDraft, SettingsNavGroup, SettingsSectionId } from '@/types/settings-center'
import { SETTINGS_CENTER_CTX } from './settings-context'
import { defaultUiPreferences, useUiPreferencesStore } from '@/stores/ui-preferences'
import MenuPane from './panes/MenuPane.vue'
import OverviewPane from './panes/OverviewPane.vue'
import WritingPane from './panes/WritingPane.vue'
import AppearancePane from './panes/AppearancePane.vue'
import SyncPane from './panes/SyncPane.vue'
import SensitiveWordsPane from './panes/SensitiveWordsPane.vue'
import CachePane from './panes/CachePane.vue'

const props = defineProps<{
  visible: boolean
  bookId?: string | number
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const uiPreferences = useUiPreferencesStore()
const uiDraft = reactive(defaultUiPreferences())
const themeStore = useThemeStore()
const editorStore = useWritingEditorStore()
const backupService = getLocalBackupService()
const desktopSupported = isTauriRuntime()

const visibleProxy = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const navGroups: SettingsNavGroup[] = [
  {
    title: '常规',
    items: [
      { id: 'overview', label: '总览', icon: 'fa-solid fa-table-cells-large' },
      { id: 'writing', label: '写作体验', icon: 'fa-regular fa-pen-to-square' },
      { id: 'menus', label: '菜单管理', icon: 'fa-solid fa-bars' },
      { id: 'appearance', label: '外观主题', icon: 'fa-solid fa-palette' },
      { id: 'sync', label: '保存与备份', icon: 'fa-solid fa-cloud-arrow-up' },
      { id: 'sensitive', label: '敏感词库', icon: 'fa-solid fa-shield-halved' },
    ],
  },
  {
    title: 'AI 设置',
    items: [
      { id: 'record', label: 'AI 调用记录', icon: 'fa-regular fa-clipboard' },
    ],
  },
  {
    title: '存储',
    items: [
      { id: 'cache', label: '存储空间', icon: 'fa-solid fa-database' },
    ],
  },
]

const sectionMeta: Record<SettingsSectionId, { title: string; description: string }> = {
  overview: { title: '设置中心', description: '统一管理写作体验、AI 能力与数据保存' },
  menus: { title: '菜单管理', description: '选择侧边栏中显示的功能入口' },
  writing: { title: '写作体验', description: '管理打字反馈、自爆挑战与写作辅助' },
  appearance: { title: '外观主题', description: '切换创作空间的主题、字体与排版' },
  sync: { title: '保存与备份', description: '管理本地自动保存、备份与版本保留策略' },
  sensitive: { title: '敏感词库', description: '管理写作台敏感词检查的内置词库与自定义词' },
  record: { title: 'AI 调用记录', description: '查看模型调用、工作流生成与会话记录' },
  cache: { title: '存储空间', description: '查看本地缓存占用并清理临时数据' },
}

const activeSection = ref<SettingsSectionId>('overview')
const paneScrollRef = ref<HTMLElement | null>(null)
const loading = ref(false)
const saving = ref(false)
const settingsDraft = ref<LocalWritingSettings>({ ...DEFAULT_LOCAL_WRITING_SETTINGS })
const selectedTheme = ref(themeStore.currentTheme)
const selectedSkin = ref(themeStore.currentSkin)

// 设置弹窗持有写作偏好草稿，保存前不污染编辑器持久化状态。
const editorDraft = reactive<EditorPreferenceDraft>({
  fontFamily: editorStore.fontFamily,
  fontSize: editorStore.fontSize,
  fontLineHeight: editorStore.fontLineHeight,
  contentWidth: editorStore.contentWidth,
  alignMode: editorStore.alignMode,
  entityHighlightEnabled: editorStore.entityHighlightEnabled,
  quickPolishToolbarEnabled: editorStore.quickPolishToolbarEnabled,
  typingSound: editorStore.typingSound,
  typingEffect: editorStore.typingEffect,
  selfDestructMode: editorStore.selfDestructMode,
})

provide(SETTINGS_CENTER_CTX, {
  settingsDraft,
  editorDraft,
  uiDraft,
  selectedTheme,
  selectedSkin,
  desktopSupported,
  loading,
  bookId: toRef(props, 'bookId'),
  navigate: (id: SettingsSectionId) => {
    activeSection.value = id
  },
  close: () => {
    visibleProxy.value = false
  },
})

const activeMeta = computed(() => sectionMeta[activeSection.value])

// 切换设置页签时重置内容滚动位置，避免新页面从上一页滚动偏移处开始显示。
watch(activeSection, async () => {
  await nextTick()
  if (paneScrollRef.value) paneScrollRef.value.scrollTop = 0
})

// AI 调用记录（只读）与敏感词库（改动即时生效）不适用底部「保存设置」草稿语义
const isInstantSection = computed(() => activeSection.value === 'record' || activeSection.value === 'sensitive')
const instantHint = computed(() => (activeSection.value === 'sensitive' ? '词库改动即时生效' : '本页为只读记录'))

const loadSettings = async () => {
  loading.value = true
  try {
    Object.assign(uiDraft, { hiddenMenus: [...uiPreferences.hiddenMenus], wordCountMode: uiPreferences.wordCountMode })
    const stored = await backupService.getSettings()
    settingsDraft.value = normalizeLocalWritingSettings(stored)
    selectedTheme.value = themeStore.currentTheme
    selectedSkin.value = themeStore.currentSkin
    Object.assign(editorDraft, {
      fontFamily: editorStore.fontFamily,
      fontSize: editorStore.fontSize,
      fontLineHeight: editorStore.fontLineHeight,
      contentWidth: editorStore.contentWidth,
      alignMode: editorStore.alignMode,
      entityHighlightEnabled: editorStore.entityHighlightEnabled,
      quickPolishToolbarEnabled: editorStore.quickPolishToolbarEnabled,
      typingSound: editorStore.typingSound,
      typingEffect: editorStore.typingEffect,
      selfDestructMode: editorStore.selfDestructMode,
    })
  } catch (error) {
    console.error('load settings center failed', error)
    ElMessage.error('读取设置失败')
  } finally {
    loading.value = false
  }
}

const saveSettings = async () => {
  saving.value = true
  try {
    const saved = await backupService.saveSettings(settingsDraft.value)
    settingsDraft.value = saved
    uiPreferences.save(uiDraft)
    applyEditorDraft()
    if (selectedTheme.value !== themeStore.currentTheme) themeStore.switchTheme(selectedTheme.value)
    if (selectedSkin.value !== themeStore.currentSkin) themeStore.switchSkin(selectedSkin.value)
    ElMessage.success('设置已保存')
    visibleProxy.value = false
  } catch (error) {
    console.error('save settings center failed', error)
    ElMessage.error('保存设置失败')
  } finally {
    saving.value = false
  }
}

const applyEditorDraft = () => {
  editorStore.setFontFamily(editorDraft.fontFamily)
  editorStore.setFontSize(editorDraft.fontSize)
  editorStore.setFontLineHeight(editorDraft.fontLineHeight)
  editorStore.setContentWidth(editorDraft.contentWidth)
  editorStore.setAlignMode(editorDraft.alignMode)
  editorStore.setEntityHighlightEnabled(editorDraft.entityHighlightEnabled)
  editorStore.setQuickPolishToolbarEnabled(editorDraft.quickPolishToolbarEnabled)
  editorStore.setTypingSound(editorDraft.typingSound)
  editorStore.setTypingEffect(editorDraft.typingEffect)
  editorStore.setSelfDestructMode(editorDraft.selfDestructMode)
}

const restoreDefaults = async () => {
  try {
    await inkConfirm('将菜单、字数统计、写作体验、外观与备份设置恢复为默认值？点击「保存设置」后生效。', '恢复默认', {
      confirmButtonText: '恢复默认',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  Object.assign(uiDraft, defaultUiPreferences())
  settingsDraft.value = { ...DEFAULT_LOCAL_WRITING_SETTINGS }
  Object.assign(editorDraft, {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Arial, PingFang SC, Microsoft YaHei',
    fontSize: 16,
    fontLineHeight: 1.8,
    contentWidth: 60,
    alignMode: 'left',
    entityHighlightEnabled: true,
    quickPolishToolbarEnabled: true,
    typingSound: 'typewriter',
    typingEffect: 'ripple',
    selfDestructMode: 'off',
  })
  selectedTheme.value = 'new'
  selectedSkin.value = themeStore.skinGroups[0]?.skins[0]?.name || selectedSkin.value
}
</script>

<style lang="scss">
/* 设置中心全部样式：非 scoped。
   弹窗内规则收敛在 .settings-center-modal 命名空间（父壳与分区子组件共用，
   scoped 无法穿透子组件 DOM）；下拉弹层传送到 body，规则放命名空间外。 */
.settings-center-modal {

  & {
    overflow: hidden;
    background: var(--bg-main) !important;
    border: 1px solid var(--ui-border);
    box-shadow: 0 26px 80px color-mix(in srgb, var(--ink-main) 22%, transparent);
    backdrop-filter: none !important;
  }

  .ew-modal-header {
    min-height: 82px;
    padding: 20px 28px 16px;
    align-items: flex-start;
    background: color-mix(in srgb, var(--surface-1) 72%, var(--bg-main));
  }

  .ew-modal-body {
    padding: 0;
    overflow: hidden;
  }

  .ew-modal-footer {
    padding: 14px 28px 20px;
    background: color-mix(in srgb, var(--surface-1) 72%, var(--bg-main));
  }

  .settings-modal-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;

    h2 {
      margin: 0;
      color: var(--ink-main);
      font-size: 24px;
      line-height: 1.25;
      font-family: "Noto Serif SC", serif;
    }

    p {
      margin: 0;
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 13px;
      line-height: 1.5;
    }
  }

  .settings-center-shell {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: 216px minmax(0, 1fr);
    background: var(--bg-main);
    color: var(--ink-main);
    overflow: hidden;
  }

  .settings-center-nav {
    padding: 30px 16px;
    border-right: 1px solid var(--ui-border);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 76%, var(--bg-main)), color-mix(in srgb, var(--surface-2) 62%, var(--bg-main))),
      var(--bg-main);
  }

  .settings-nav-group + .settings-nav-group {
    margin-top: 30px;
  }

  .settings-nav-title {
    display: block;
    margin: 0 12px 12px;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 12px;
    line-height: 1.4;
  }

  .settings-nav-item {
    width: 100%;
    height: 44px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    text-align: left;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease;

    i {
      width: 18px;
      text-align: center;
      color: var(--settings-muted-color, var(--ink-sec));
    }

    &:hover {
      border-color: var(--ui-border-hover);
      box-shadow: 0 8px 18px color-mix(in srgb, var(--ink-main) 8%, transparent);
    }

    &.active {
      border-color: color-mix(in srgb, var(--ink-accent) 30%, var(--ui-border));
      background: var(--nav-active-bg);
      color: var(--ink-accent);
      font-weight: 600;

      i {
        color: var(--ink-accent);
      }
    }
  }

  .settings-center-main {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 64%, var(--bg-main)), var(--bg-main)),
      var(--bg-main);
  }

  .settings-pane-scroll {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .settings-pane {
    padding: 26px 44px 34px;
  }

  /* 填充模式：pane 撑满可视高度，内部自行管理滚动（仅列表滚动，头部/分页固定） */
  .settings-pane--fill {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding-bottom: 26px;
  }

  .settings-card,
  .overview-status-card,
  .shortcut-card {
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--card-bg, var(--ui-glass-bg));
    box-shadow: 0 10px 28px color-mix(in srgb, var(--ink-main) 8%, transparent);
    backdrop-filter: blur(12px);
  }

  .overview-status-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }

  .overview-status-card {
    min-height: 136px;
    padding: 20px 22px;
    display: grid;
    grid-template-columns: 66px minmax(0, 1fr);
    align-items: center;
    gap: 16px;

    div {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    span,
    small {
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 12px;
    }

    strong {
      color: var(--ink-main);
      font-size: 18px;
      line-height: 1.3;
    }

    .mini-outline-btn {
      grid-column: 2;
      width: 120px;
    }
  }

  .status-icon,
  .cloud-badge,
  .cache-ring {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink-accent) 12%, var(--surface-1));
    color: var(--ink-accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;

    > i {
      font-size: 20px;
      line-height: 1;
    }

    > img {
      width: 36px;
      height: 36px;
      object-fit: contain;
      display: block;
    }

    &.sync {
      color: var(--state-success);
    }

    &.model {
      color: var(--state-info, var(--ink-accent));
    }
  }

  .model-status-icon {
    background: color-mix(in srgb, var(--bg-main) 74%, var(--surface-1));
  }

  .shortcut-grid {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }

  // 总览页快捷卡下面的「推荐调整」卡不匹配 .settings-card + .settings-card 规则，需单独给间距
  .shortcut-grid + .settings-card {
    margin-top: 24px;
  }

  .shortcut-card {
    min-height: 132px;
    padding: 20px 18px;
    color: var(--ink-main);
    cursor: pointer;
    text-align: left;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    grid-template-rows: 44px minmax(0, 1fr);
    align-content: start;
    column-gap: 14px;
    row-gap: 12px;
    transition: border-color 0.18s ease, box-shadow 0.18s ease;

    i {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--ink-accent) 10%, var(--surface-1));
      color: var(--ink-accent);
      font-size: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      grid-row: 1;
    }

    strong {
      align-self: center;
      font-size: 16px;
      line-height: 1.4;
    }

    span {
      grid-column: 1 / -1;
      align-self: start;
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 13px;
      line-height: 1.65;
    }

    &:hover {
      border-color: var(--ink-accent);
      box-shadow: 0 12px 28px color-mix(in srgb, var(--ink-accent) 16%, transparent);
    }
  }

  .settings-card {
    padding: 20px;

    &.thin {
      padding: 16px;
    }
  }

  .settings-card-title,
  .number-title {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink-main);

    i,
    span {
      color: var(--ink-accent);
    }

    strong {
      font-size: 16px;
      line-height: 1.4;
    }
  }

  .number-title {
    margin-bottom: 12px;

    span {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      background: var(--nav-active-bg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
    }
  }

  .settings-pane > .settings-section-block + .settings-section-block,
  .settings-pane > .settings-card + .settings-card,
  .settings-pane > .settings-section-block + .settings-card,
  .settings-pane > .settings-card + .settings-section-block {
    margin-top: 24px;
  }

  .recommend-list {
    margin-top: 12px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    border-radius: 8px;
    overflow: hidden;
  }

  .recommend-row,
  .switch-row {
    min-height: 58px;
    padding: 12px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    color: var(--ink-main);

    & + & {
      border-top: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    }

    // 只管行首那个文字 span：写成后代选择器会连 el-switch 内部的轨道 span 一起改掉，
    // 轨道被压成 0 宽、圆钮甩到轨道外（GitHub #1 的"开关超出边界"）
    > span {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    small {
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 12px;
      line-height: 1.5;
    }

    &.compact {
      min-height: 48px;
    }
  }

  .recommend-row > span {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-width: 138px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .menu-management {
    > .hint-line { margin: 0 0 18px; }
    .switch-row > span { flex-direction: row; align-items: center; gap: 12px; }
    .switch-row i { width: 20px; text-align: center; color: var(--ink-sec); }
  }

  .settings-two-col {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;

    > .settings-card {
      min-height: 226px;
    }
  }

  .setting-block {
    margin-top: 16px;
  }

  .setting-label {
    display: block;
    margin-bottom: 9px;
    color: var(--ink-main);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
  }

  .option-row {
    display: grid;
    gap: 10px;

    &.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    &.three {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    &.four {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  .settings-option-btn,
  .settings-icon-btn,
  .mini-outline-btn {
    min-height: 36px;
    border: 1px solid var(--input-border);
    border-radius: 7px;
    background: var(--settings-control-bg, var(--input-bg));
    color: var(--ink-main);
    cursor: pointer;
    font-size: 13px;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease;

    &:hover {
      border-color: var(--ui-border-hover);
      box-shadow: 0 8px 18px color-mix(in srgb, var(--ink-main) 8%, transparent);
    }

    &.active {
      border-color: var(--ink-accent);
      color: var(--ink-accent);
      box-shadow: inset 0 0 0 1px var(--ink-accent);
    }
  }

  .settings-icon-btn {
    min-width: 48px;
    font-size: 15px;
  }

  .mini-outline-btn {
    height: 32px;
    padding: 0 12px;
    color: var(--ink-accent);
  }

  /* 主题卡缩略图固定显示各自主题的盘面色（与 themes.scss 同源，值出自配色规范） */
  .theme-preview-new { --tp-bg: #F2F0EA; --tp-card: #FBFAF6; --tp-ink: #241F1B; --tp-accent: #7A3028; }
  .theme-preview-yellow { --tp-bg: #E9DFCC; --tp-card: #F7EEDC; --tp-ink: #34271F; --tp-accent: #8B4A2F; }
  .theme-preview-green { --tp-bg: #E5E6DB; --tp-card: #F2F1E7; --tp-ink: #263028; --tp-accent: #52634F; }
  .theme-preview-dark { --tp-bg: #171714; --tp-card: #22211D; --tp-ink: #ECE7DC; --tp-accent: #9F472F; }

  .theme-card-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }

  .theme-choice-card {
    position: relative;
    min-height: 182px;
    padding: 14px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--card-bg);
    color: var(--ink-main);
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 0.18s ease, box-shadow 0.18s ease;

    &:hover,
    &.active {
      border-color: var(--ink-accent);
      box-shadow: 0 12px 28px color-mix(in srgb, var(--ink-accent) 14%, transparent);
    }

    strong {
      margin-top: 4px;
      font-size: 15px;
    }

    small {
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 12px;
    }
  }

  .theme-preview {
    position: relative;
    height: 84px;
    border-radius: 7px;
    border: 1px solid var(--ui-border);
    overflow: hidden;
    background:
      radial-gradient(circle at 86% 18%, color-mix(in srgb, var(--tp-accent, var(--ink-accent)) 20%, transparent), transparent 22%),
      linear-gradient(90deg, color-mix(in srgb, var(--tp-accent, var(--ink-accent)) 16%, transparent), transparent),
      var(--tp-card, var(--surface-1));

    &::before {
      position: absolute;
      inset: 12px auto 12px 14px;
      width: 42px;
      border-radius: 8px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--tp-ink, var(--ink-main)) 18%, transparent), transparent),
        color-mix(in srgb, var(--tp-bg, var(--bg-main)) 78%, transparent);
      box-shadow:
        58px 4px 0 -18px color-mix(in srgb, var(--tp-ink, var(--ink-main)) 16%, transparent),
        58px 20px 0 -18px color-mix(in srgb, var(--tp-ink, var(--ink-main)) 10%, transparent),
        58px 36px 0 -18px color-mix(in srgb, var(--tp-ink, var(--ink-main)) 8%, transparent);
      content: '';
    }

    &::after {
      position: absolute;
      left: 14px;
      top: 10px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--state-danger);
      box-shadow:
        10px 0 0 var(--state-warning),
        20px 0 0 var(--state-success);
      opacity: 0.76;
      content: '';
    }

    &.theme-preview-yellow {
      filter: sepia(0.35);
    }

    &.theme-preview-green {
      filter: hue-rotate(58deg) saturate(0.65);
    }

    &.theme-preview-dark {
      background:
        radial-gradient(circle at 82% 18%, color-mix(in srgb, var(--ink-accent) 20%, transparent), transparent 24%),
        linear-gradient(90deg, color-mix(in srgb, var(--ink-main) 26%, transparent), transparent),
        var(--card-bg);
      filter: none;
    }
  }

  .selected-check {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--ink-accent);
    color: var(--btn-primary-color);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
  }

  .appearance-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(96px, auto);
    align-items: stretch;
    gap: 14px;
  }

  .slider-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 34px;
  }

  .sync-status-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(360px, 0.8fr);
    align-items: center;
    gap: 22px;
  }

  .sync-status-main,
  .cache-summary {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;

    span,
    small {
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 12px;
    }

    strong {
      font-size: 20px;
      line-height: 1.3;
    }
  }

  .backup-form-grid {
    margin-top: 14px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 180px 150px;
    gap: 12px;
  }

  .field-line {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;

    &.wide {
      grid-column: 1 / -1;
    }

    > span {
      color: var(--settings-muted-color, var(--ink-sec));
      font-size: 12px;
      font-weight: 600;
    }
  }

  .path-box {
    min-height: 34px;
    padding: 8px 10px;
    border: 1px solid var(--input-border);
    border-radius: 7px;
    background: var(--settings-control-bg, var(--input-bg));
    color: var(--ink-main);
    font-size: 12px;
    line-height: 1.5;
    word-break: break-all;
  }

  .action-row {
    margin-top: 14px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .error-line {
    margin: 10px 0 0;
    color: var(--state-danger);
    font-size: 12px;
  }

  .hint-line {
    margin: 10px 0 0;
    color: var(--ink-text-secondary, var(--el-text-color-secondary));
    font-size: 12px;
  }

  .settings-inline-select {
    width: 100%;
    min-width: 180px;
  }

  .cache-overview-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
  }

  .storage-backup-tip {
    margin-top: 16px;

    .action-row {
      justify-content: flex-start;
    }
  }

  .empty-state {
    min-height: 96px;
    border: 1px dashed var(--ui-border);
    border-radius: 8px;
    color: var(--settings-muted-color, var(--ink-sec));
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 13px;
    line-height: 1.7;
  }

  .settings-footer {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .footer-hint {
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: 12px;
  }

  .footer-actions {
    display: flex;
    gap: 12px;
  }

  .el-input__wrapper,
  .el-select__wrapper {
    min-height: 36px;
    border-radius: 7px;
    background: var(--input-bg);
    box-shadow: 0 0 0 1px var(--input-border) inset;
  }

  .el-input__wrapper.is-focus,
  .el-select__wrapper.is-focused {
    background: var(--input-focus-bg);
    box-shadow: 0 0 0 1px var(--input-focus-border) inset;
  }

  .el-switch {
    --el-switch-on-color: var(--ink-accent);
    --el-switch-off-color: color-mix(in srgb, var(--ink-sec) 26%, var(--input-bg));
    height: 24px;
    line-height: 24px;
  }

  .el-switch__core {
    min-width: 42px;
    height: 22px;
    border-radius: 999px;
  }

  .el-switch__action {
    width: 18px;
    height: 18px;
  }



  .el-slider__bar {
    background-color: var(--ink-accent);
  }

  .el-slider__button {
    border-color: var(--ink-accent);
  }

  @media (max-width: 1180px) {
    .settings-center-shell {
      grid-template-columns: 188px minmax(0, 1fr);
    }

    .overview-status-grid,
    .shortcut-grid,
    .theme-card-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .sync-status-card {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .sync-mode-box {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 820px) {
    & {
      width: calc(100vw - 24px) !important;
    }

    .ew-modal-header {
      min-height: auto;
      padding: 16px 18px 12px;
    }

    .ew-modal-footer {
      padding: 12px 18px 16px;
    }

    .settings-center-shell {
      height: 100%;
      grid-template-columns: 1fr;
      min-height: 0;
    }

    .settings-center-nav {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      padding: 14px;
      border-right: 0;
      border-bottom: 1px solid var(--ui-border);
    }

    .settings-nav-group + .settings-nav-group {
      margin-top: 0;
    }

    .settings-nav-title {
      margin-left: 0;
    }

    .settings-pane {
      padding: 18px;
    }

    .settings-two-col,
    .appearance-form-grid,
    .backup-form-grid,
    .cache-overview-card {
      grid-template-columns: 1fr;
    }

    .option-row.four,
    .option-row.three {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

}

/* 下拉弹层（teleport 到 body） */
.settings-select-popper {
  border: 1px solid var(--ui-border) !important;
  border-radius: 8px !important;
  background: var(--ui-glass-bg) !important;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink-main) 20%, transparent) !important;
  backdrop-filter: blur(18px);
  overflow: hidden;
}

.settings-select-popper .el-select-dropdown__list {
  padding: 6px !important;
}

.settings-select-popper .el-select-dropdown__item {
  height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  color: var(--ink-main);
}

.settings-select-popper .el-select-dropdown__item.hover,
.settings-select-popper .el-select-dropdown__item:hover {
  background: var(--nav-active-bg);
  color: var(--ink-accent);
}

.settings-select-popper .el-select-dropdown__item.is-selected {
  color: var(--ink-accent);
  font-weight: 600;
  background: var(--selection-bg-color);
}

.settings-select-popper .el-popper__arrow::before {
  background: var(--ui-glass-bg) !important;
  border-color: var(--ui-border) !important;
}
</style>
