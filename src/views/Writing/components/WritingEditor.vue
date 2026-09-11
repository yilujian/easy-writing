<template>
  <main class="writing-editor" ref="containerRef">
    <!-- 特效容器 -->
    <div class="particles-container" ref="particlesContainerRef"></div>

    <!-- 工具栏 -->
    <div
      class="editor-toolbar border-gradient-b"
      :class="{
        'compact-mode': isCompactMode,
        'toolbar-icon-only-mode': isToolbarIconOnlyMode,
      }"
    >
      <div ref="toolbarScrollRef" class="toolbar-scroll">
        <div class="toolbar-group">
          <SmartPopover ref="fontPopoverRef" :width="320" placement="bottom-start">
            <template #trigger>
              <el-tooltip
                content="字体"
                placement="bottom"
                :disabled="!isToolbarIconOnlyMode"
              >
                <button class="toolbar-btn">
                  <i class="fa-solid fa-font"></i>
                  <span class="btn-text">字体</span>
                </button>
              </el-tooltip>
            </template>
            <FontSettingPanel />
          </SmartPopover>
          <el-dropdown @command="handleThemeChange" trigger="click">
            <div class="dropdown-trigger">
              <el-tooltip
                content="背景"
                placement="bottom"
                :disabled="!isToolbarIconOnlyMode"
              >
                <button class="toolbar-btn">
                  <i class="fa-solid fa-shirt"></i>
                  <span class="btn-text">背景</span>
                </button>
              </el-tooltip>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="theme in themeStore.themes"
                  :key="theme.value"
                  :command="theme.value"
                  :class="{
                    'is-active': themeStore.currentTheme === theme.value,
                  }"
                >
                  <i :class="theme.icon" style="margin-right: 8px"></i>
                  {{ theme.label }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="toolbar-divider"></div>
        <div class="toolbar-group">
          <el-tooltip content="撤销" placement="bottom">
            <button
              class="toolbar-btn"
              @click="handleUndo"
              :disabled="workflowLocked || !canUndo"
            >
              <i class="fa-solid fa-rotate-left"></i>
            </button>
          </el-tooltip>
          <el-tooltip content="重做" placement="bottom">
            <button
              class="toolbar-btn"
              @click="handleRedo"
              :disabled="workflowLocked || !canRedo"
            >
              <i class="fa-solid fa-rotate-right"></i>
            </button>
          </el-tooltip>
        </div>
        <div class="toolbar-divider"></div>
        <div class="toolbar-group">
          <el-tooltip
            content="排版"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button
              class="toolbar-btn"
              :disabled="workflowLocked"
              @click="handleFormat"
            >
              <i class="fa-solid fa-indent"></i>
              <span class="btn-text">排版</span>
            </button>
          </el-tooltip>
          <SmartPopover
            v-if="!workflowMode"
            ref="prefPopoverRef"
            :width="320"
            placement="bottom-start"
          >
            <template #trigger>
              <el-tooltip
                content="偏好"
                placement="bottom"
                :disabled="!isToolbarIconOnlyMode"
              >
                <button class="toolbar-btn">
                  <i class="fa-solid fa-gear"></i>
                  <span class="btn-text">偏好</span>
                </button>
              </el-tooltip>
            </template>
            <PreferenceSettingPanel />
          </SmartPopover>
        </div>
        <div class="toolbar-actions">
          <el-tooltip
            content="全屏"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button class="toolbar-btn" type="button" @click="toggleFullscreen">
              <i
                :class="
                  isFullscreen ? 'fa-solid fa-compress' : 'fa-solid fa-expand'
                "
              ></i>
              <span class="btn-text">{{
                isFullscreen ? '退出全屏' : '全屏'
              }}</span>
            </button>
          </el-tooltip>
          <el-tooltip
            content="查找"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button
              class="toolbar-btn"
              ref="findBtnRef"
              @click="toggleFindReplace"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
              <span class="btn-text">查找</span>
            </button>
          </el-tooltip>
          <el-tooltip
            v-if="!workflowMode"
            content="取名"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button
              class="toolbar-btn"
              :disabled="workflowLocked"
              @click="openNameGenerator"
            >
              <i class="fa-solid fa-signature"></i>
              <span class="btn-text">取名</span>
            </button>
          </el-tooltip>
          <el-tooltip
            v-if="!workflowMode"
            content="画师"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button
              class="toolbar-btn"
              :disabled="workflowLocked"
              @click="openArtistModal"
            >
              <i class="fa-regular fa-image"></i>
              <span class="btn-text">画师</span>
            </button>
          </el-tooltip>
          <el-tooltip
            content="历史版本"
            placement="bottom"
            :disabled="!isToolbarIconOnlyMode"
          >
            <button
              class="toolbar-btn"
              type="button"
              :disabled="!hasActiveChapter"
              @click="openChapterHistory"
            >
              <i class="fa-solid fa-clock-rotate-left"></i>
              <span class="btn-text">历史</span>
            </button>
          </el-tooltip>
        </div>
      </div>
    </div>

    <!-- 编辑区域 -->
    <div
      ref="editorScrollRef"
      class="editor-content"
      :class="{ 'has-ruler': rulerStyle !== 'none' }"
      @scroll="handleEditorScroll"
    >
      <div
        class="editor-area-wrapper"
        :style="{ ...editorAreaStyle, ...editorVars }"
      >
        <!-- 章节标题 -->
        <input
          v-if="hasActiveChapter"
          class="chapter-title-input"
          v-model="chapterTitleModel"
          :disabled="workflowLocked"
          placeholder="请输入章节标题"
        />

        <!-- Tiptap 编辑器 -->
        <div
          class="editor-wrapper"
          :class="[
            rulerClass,
            {
              'paragraph-gap': isParagraphGap,
              'webkit-caret-fix': webkitCaretEnabled,
            },
          ]"
          @contextmenu.prevent="onContextMenu"
          @mouseover="handleEntityMouseOver"
          @mouseout="handleEntityMouseOut"
        >
          <EditorContent :editor="editor" class="editor-content-area" />
          <div
            v-show="webkitCaretVisible"
            class="webkit-editor-caret"
            :style="webkitCaretStyle"
          ></div>

          <Teleport to="body">
            <div
              v-if="bubbleMenuAllowed && quickPolishToolbarEnabled && isBubbleMenuVisible && editor"
              ref="bubbleMenuRef"
              class="custom-bubble-menu"
              :class="{ 'is-visible': isBubbleMenuAnimating }"
              :style="bubbleMenuStyle"
            >
              <EditorBubbleMenu
                :editor="editor"
                :book-id="bookId || ''"
                :chapter-id="activeChapterId || ''"
                :chapter-title="activeChapterTitle || ''"
                :chapter-summary="activeChapterSummary || ''"
                :mode="bubbleMenuMode"
                @done="handleAiDone"
                @add-to-chat="handleAddToChat"
                @loading="handleAiTaskLoading"
                @bind-storyline="handlePlotBindingAction('bind-storyline')"
                @bind-timeline="handlePlotBindingAction('bind-timeline')"
                @create-plot-node="handlePlotBindingAction('create-plot-node')"
              />
            </div>
          </Teleport>

          <!-- AI Review 浮窗 -->
          <AiReviewWidget
            v-if="bubbleMenuAllowed && isReviewing && editor"
            :editor="editor"
            :original-text="reviewData.original"
            :current-range="reviewData.range"
            @close="handleReviewClose"
          />

          <!-- 目录还在拉取时不能断言"没有章节"：那会儿只是还不知道有没有 -->
          <div v-if="props.booting" class="editor-empty-hint is-loading">
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            正在打开作品…
          </div>
          <div v-else-if="!hasActiveChapter" class="editor-empty-hint">
            <i class="fa-regular fa-note-sticky"></i>
            请选择左侧章节开始创作
          </div>
        </div>
      </div>
    </div>

    <!-- AI 局部修改预览卡：脱离文档流的悬浮面板，固定定位贴在选中段下方并随滚动跟随 -->
    <Teleport v-if="polishSession" to="body">
      <div
        ref="polishCardRef"
        class="issue-polish-card"
        :style="polishCardStyle"
        @mousedown.stop
        @click.stop
      >
        <div class="issue-polish-head">
          <strong><i class="fa-solid fa-wand-magic-sparkles"></i> AI 局部修改预览</strong>
          <em>仅修改本段</em>
          <span>不会修改其他段落，确认后才替换原文</span>
          <span v-if="polishSession.navTotal > 1" class="issue-polish-nav">
            <button
              type="button"
              :disabled="polishSession.loading"
              aria-label="上一处"
              @click="stepPolishTarget(-1)"
            >
              ‹
            </button>
            {{ polishSession.navCurrent + 1 }}/{{ polishSession.navTotal }} 处
            <button
              type="button"
              :disabled="polishSession.loading"
              aria-label="下一处"
              @click="stepPolishTarget(1)"
            >
              ›
            </button>
          </span>
        </div>
        <div class="issue-polish-block">
          <small>原文</small>
          <p>
            <template v-for="(segment, segmentIndex) in polishOriginalSegments" :key="segmentIndex">
              <mark v-if="segment.hit">{{ segment.text }}</mark>
              <template v-else>{{ segment.text }}</template>
            </template>
          </p>
        </div>
        <div class="issue-polish-block is-result">
          <small>AI 修改后</small>
          <p v-if="polishSession.loading" class="issue-polish-loading">
            <i class="fa-solid fa-spinner fa-spin"></i> 正在改写…
          </p>
          <p v-else-if="polishSession.error" class="issue-polish-error">{{ polishSession.error }}</p>
          <p v-else>{{ polishSession.polished }}</p>
        </div>
        <button
          type="button"
          class="issue-polish-extra-toggle"
          @click="polishSession.extraOpen = !polishSession.extraOpen"
        >
          补充修改要求
        </button>
        <textarea
          v-if="polishSession.extraOpen"
          v-model="polishSession.extraText"
          class="issue-polish-extra-input"
          rows="2"
          maxlength="500"
          placeholder="例如：保留机油味的意象，句子再短一点"
        ></textarea>
        <div class="issue-polish-actions">
          <button type="button" @click="closeIssuePolish">取消</button>
          <button type="button" :disabled="polishSession.loading" @click="runPolishRequest">
            再改一次
          </button>
          <button
            type="button"
            class="is-primary"
            :disabled="polishSession.loading || !polishSession.polished"
            @click="applyIssuePolish"
          >
            替换此段
          </button>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="entityHoverVisible && activeEntityGroup"
        class="entity-hover-card ink-popover-panel"
        :style="entityHoverStyle"
        @mouseenter="keepEntityHover"
        @mouseleave="scheduleHideEntityHover"
      >
        <div class="entity-hover-header">
          <div class="entity-hover-heading">
            <span class="entity-hover-title">{{ activeEntityGroup.name }}</span>
            <span
              v-if="activeEntityGroup.items.length > 1"
              class="entity-hover-count"
            >
              {{ activeEntityGroup.items.length }}条关联
            </span>
          </div>
          <button
            type="button"
            class="entity-hover-action"
            @click.stop="dismissActiveEntityGroup"
          >
            取消绑定
          </button>
        </div>
        <div class="entity-hover-list">
          <div
            v-for="item in activeEntityItems"
            :key="`${item.kind}-${item.id}`"
            class="entity-hover-item"
          >
            <div class="entity-hover-meta">
              <span class="entity-hover-kind" :class="`is-${item.kind}`">{{
                getEntityKindText(item.kind)
              }}</span>
              <span v-if="item.label" class="entity-hover-label">{{
                item.label
              }}</span>
            </div>
            <p v-if="item.summary" class="entity-hover-summary">
              {{ item.summary }}
            </p>
            <p v-else class="entity-hover-summary is-empty">暂无详情</p>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 查找替换弹窗 -->
    <FindReplaceModal
      v-model="showFindReplace"
      :editor="editor"
      :initial-position="findModalPosition"
      :read-only="workflowLocked"
    />

    <!-- 取名弹窗 -->
    <NameGeneratorModal
      v-if="!workflowMode && !workflowLocked"
      v-model:visible="showNameGenerator"
      :book-id="bookId"
      @insert="handleInsertName"
    />

    <!-- 画师弹窗 -->
    <ArtistModal
      v-if="!workflowMode && !workflowLocked"
      v-model:visible="showArtistModal"
      :book-id="bookId"
    />

    <ChapterHistoryModal
      v-model:visible="showChapterHistory"
      :chapter-id="Number(activeChapterId) || null"
      :chapter-title="activeChapterTitle || ''"
      :book-id="props.bookId"
      :restore-disabled="workflowLocked"
      @restored="handleHistoryRestored"
    />

    <!-- 底部状态栏 -->
    <div
      ref="statusBarRef"
      class="editor-status-bar"
      :class="{
        'compact-mode': isCompactMode,
        'status-tight-mode': isStatusTightMode,
        'status-icon-only-mode': isStatusIconOnlyMode,
      }"
    >
      <div ref="statusCenterRef" class="status-center">
        <span
          v-if="saveStatusIconMeta"
          class="save-status-icon"
          :class="[chapterSaveState, { 'is-ai-thinking': isAiThinking }]"
          :title="saveStatusIconMeta.label"
          :aria-label="saveStatusIconMeta.label"
          role="status"
        >
          <i :class="saveStatusIconMeta.icon"></i>
          <span class="save-status-label">{{ saveStatusIconMeta.label }}</span>
        </span>
      </div>
      <div ref="statusRightRef" class="status-right">
        <button
          v-if="!workflowMode"
          class="sync-now-btn"
          type="button"
          :disabled="workflowLocked || !hasActiveChapter || isManualSyncing"
          title="保存到本机"
          @click="syncCurrentChapterNow"
        >
          <i v-if="isManualSyncing" class="fa-solid fa-spinner fa-spin"></i>
          <i v-else class="fa-solid fa-rotate"></i>
          <span class="sync-btn-label">本地保存</span>
        </button>
        <el-popover
          v-if="!workflowMode"
          placement="top-start"
          :width="280"
          trigger="click"
          popper-class="ai-config-popper"
          :popper-options="aiConfigPopperOptions"
        >
          <template #reference>
            <button
              class="ai-status-btn"
              type="button"
              :disabled="workflowLocked"
              :class="{
                'is-active': aiConfig.enabled,
                'is-thinking': isAiThinking,
              }"
              :title="aiStatusText"
            >
              <i v-if="isAiThinking" class="fa-solid fa-spinner fa-spin"></i>
              <i v-else class="fa-solid fa-wand-magic-sparkles"></i>
              <span>{{ aiStatusText }}</span>
              <i class="fa-solid fa-angle-up arrow"></i>
            </button>
          </template>
          <div class="ai-config-panel">
            <div class="panel-header">
              <span>AI 补全设置</span>
              <small>让自动补全更懂你</small>
            </div>
            <div class="config-item">
              <span class="label">自动补全</span>
              <el-switch v-model="aiConfig.enabled" size="small" />
            </div>
            <div class="panel-divider"></div>
            <div class="config-item column">
              <span class="label">选择模型</span>
              <ModelChip v-model="autocompleteModelOverride" group-code="text_assist" />
            </div>
            <div class="config-desc">
              快捷键触发 <code class="key-tag">{{ aiShortcutTip }}</code>
            </div>
          </div>
        </el-popover>
        <button
          v-if="!workflowMode"
          class="plan-entry"
          type="button"
          :class="{ 'is-empty': planProgress <= 0 }"
          :title="`计划：剩 ${planRemainingText}`"
          @click="planStore.togglePanel"
        >
          <svg
            class="plan-mini-progress"
            viewBox="0 0 24 24"
            role="presentation"
          >
            <circle class="track" cx="12" cy="12" r="9" />
            <circle
              class="progress"
              cx="12"
              cy="12"
              r="9"
              :style="planMiniCircleStyle"
            />
          </svg>
          <span class="plan-text"
            >计划：剩 <strong>{{ planRemainingText }}</strong></span
          >
        </button>
        <el-tooltip
          placement="top"
          :disabled="false"
          :content="sensitiveTooltipText || `敏感词：${sensitiveStatusValue}`"
        >
          <span
            class="divider sensitive-status"
            :class="{ 'has-risk': sensitiveMatchCount > 0 }"
            :aria-label="`敏感词：${sensitiveStatusValue}`"
          >
            <i class="fa-solid fa-shield-halved"></i>
            <span class="status-label">敏感词:</span>
            <strong>{{ sensitiveStatusValue }}</strong>
          </span>
        </el-tooltip>
        <el-tooltip placement="top">
          <template #content>
            <div>含标点：{{ chapterWordCount }} 字</div>
            <div>不含标点：{{ countTextWords(editorStore.activeChapterTextContent) }} 字</div>
          </template>
          <span class="divider word-count-status" tabindex="0" :aria-label="`本章${wordCounter.label.value}：${displayedChapterWords}`">
            <i class="fa-solid fa-align-left"></i><span class="status-label">本章:</span>
            <strong>{{ displayedChapterWords }}</strong>
          </span>
        </el-tooltip>
      </div>
    </div>

    <WritingPlanPanel v-if="!workflowMode" />

  </main>
</template>

<script setup lang="ts">
import { workflowContentVersion } from '@/utils/workflow-local-draft'
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { markWritingSnapshotProvider } from '@/storage/local-backup-service'
import { EditorContent, Editor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import type { EditorView } from 'prosemirror-view'
import { ElMessage } from 'element-plus'
// 组件引入
import EditorBubbleMenu from './EditorBubbleMenu.vue'
import AiReviewWidget from './AiReviewWidget.vue'
import SmartPopover from '@/components/SmartPopover.vue'
import FontSettingPanel from './FontSettingPanel.vue'
import PreferenceSettingPanel from './PreferenceSettingPanel.vue'
import FindReplaceModal from './FindReplaceModal.vue'
import NameGeneratorModal from './NameGeneratorModal.vue'
import ArtistModal from './ArtistModal.vue'
import WritingPlanPanel from './WritingPlanPanel.vue'
import ChapterHistoryModal from './ChapterHistoryModal.vue'

// Store 引入
import {
  useWritingEditorStore,
  type ChapterSaveState,
} from '@/stores/writing-editor'
import { useThemeStore } from '@/stores/theme'
import { useWritingPlanStore } from '@/stores/writing-plan'
import { useAiChatStore } from '@/stores/ai-chat'
import ModelChip from '@/components/ModelChip.vue'
import { storeToRefs } from 'pinia'

// 扩展引入
import AICopilotExtension from '../extends/AICopilotExtension'
import PersistentSelectionExtension from '../extends/SelectionExtension'
import AiReviewExtension from '../extends/AiReviewExtension'
import FindReplace from '../extends/FindReplaceExtension'
import SensitiveExtension from '../extends/SensitiveExtension'
import EntityHighlightExtension, {
  type EntityHighlightItem,
} from '../extends/EntityHighlightExtension'
import IssueHighlightExtension, {
  type IssueHighlightItem,
} from '../extends/IssueHighlightExtension'

import { formatEditorContent } from '@/utils/editor'
import { isWorkflowChapterManualEditable } from '../composables/useWorkflowWritingSession'
import { markdownToPlainText } from '@/utils/markdown'
import {
  isAiShortcut,
  isFindShortcut,
  isSaveShortcut,
  isAddToChatShortcut,
} from '@/utils/platform'
import { showApiError } from '@/utils/api-error'
import {
  buildChapterStorageKey,
  getWritingStorage,
  isTauriRuntime,
  type LocalChapterDraft,
  type StoredLocalChapterDraft,
} from '@/storage'
import { recordChapterLoadJournal, recordWriteJournal } from '@/storage/write-journal'
import { maybeCaptureLocalVersion } from '@/storage/local-version-service'
import { getLocalLibraryStorage, LOCAL_USER_ID } from '@/storage/local-library'
import { useSensitiveCheck } from '../composables/useSensitiveCheck'
import { useEditorChrome } from '../composables/useEditorChrome'
import { useEditorFullscreen } from '../composables/useEditorFullscreen'
import { useEditorTypography } from '../composables/useEditorTypography'
import { useWebKitCaret } from '../composables/useWebKitCaret'
import { useBubbleMenu } from '../composables/useBubbleMenu'
import { useEntityHighlights } from '../composables/useEntityHighlights'
import { useIssuePolish } from '../composables/useIssuePolish'
import { useAiAutocomplete } from '../composables/useAiAutocomplete'
import { useTypingFeedback } from '../composables/useTypingFeedback'
import {
  countDeletedCharsFromTransaction,
  countInsertedCharsFromTransaction,
} from '../editor-utils/transaction-words'
import {
  EMPTY_EDITOR_DOC,
  buildPlainTextPasteSlice,
  normalizeEditorContentPayload,
  normalizePlainTextRows,
  plainTextToTiptapJson,
} from '../editor-utils/content-normalize'
import { primeChapterWords, recordAiWordsAdded, recordChapterWords } from '@/storage/local-write-stats'
import { useWordCount } from '@/composables/use-word-count'
import { countWords, countTextWords } from '@/utils/word-count'

// 编辑器样式 Store
const editorStore = useWritingEditorStore()
const wordCounter = useWordCount()
const displayedChapterWords = computed(() => wordCounter.mode.value === 'text' ? countTextWords(editorStore.activeChapterTextContent) : editorStore.chapterWordCount)
const {
  fontFamily,
  fontBold,
  fontSize,
  fontLineHeight,
  contentWidth,
  isParagraphGap,
  rulerStyle,
  alignMode,
  fontColor,
  typingSound,
  typingEffect,
  quickPolishToolbarEnabled,
  activeChapterId,
  activeChapterTitle,
  activeChapterSummary,
  chapterWordCount,
  chapterSaveState,
  chapterSaveMessage,
  writingScrollRatio,
  writingScrollSource,
} = storeToRefs(editorStore)

const planStore = useWritingPlanStore()
const {
  targetWords: planTargetWords,
  todayWords: planTodayWords,
  planProgress,
} = storeToRefs(planStore)

const {
  measuredLineHeightPx,
  normalizePixel,
  getBaseLineHeightPx,
  editorVars,
  editorAreaStyle,
  rulerClass,
} = useEditorTypography({
  fontFamily,
  fontBold,
  fontSize,
  fontLineHeight,
  contentWidth,
  isParagraphGap,
  rulerStyle,
  alignMode,
  fontColor,
})

const aiChatStore = useAiChatStore()
const writingStorage = getWritingStorage()
const localLibrary = getLocalLibraryStorage()

const showArtistModal = ref(false)
const isManualSyncing = ref(false)

const saveStatusIconMeta = computed<{ icon: string; label: string } | null>(
  () => {
    if (isAiThinking.value)
      return { icon: 'fa-solid fa-spinner fa-spin', label: 'AI正在思考' }
    if (!chapterSaveMessage.value && chapterSaveState.value === 'idle')
      return null

    // 底部保存状态以图标表达，避免长文案挤压右侧操作。
    const state: ChapterSaveState = chapterSaveState.value
    // 工作流流式正文只保存为本地预览，不沿用普通编辑器的云端上传文案。
    if (workflowMode.value && workflowPreviewActive.value) {
      if (
        state === 'local_saved'
        || state === 'local_only'
        || state === 'synced'
        || state === 'success'
      )
        return {
          icon: 'fa-solid fa-hard-drive',
          label: '生成草稿已保存本机',
        }
      if (state === 'error')
        return {
          icon: 'fa-solid fa-circle-exclamation',
          label: '生成草稿保存失败',
        }
      return {
        icon: 'fa-solid fa-spinner fa-spin',
        label: '自动生文中',
      }
    }
    if (state === 'saving' || state === 'syncing')
      return { icon: 'fa-solid fa-spinner fa-spin', label: '正在上传' }
    if (state === 'local_saved' || state === 'pending')
      return { icon: 'fa-solid fa-cloud-arrow-up', label: '等待云端保存' }
    if (state === 'synced' || state === 'success')
      return { icon: 'fa-solid fa-circle-check', label: '已完成' }
    if (state === 'offline')
      return { icon: 'fa-solid fa-clock', label: '离线保存' }
    if (state === 'local_only')
      return { icon: 'fa-solid fa-hard-drive', label: '本地保存' }
    if (state === 'error')
      return { icon: 'fa-solid fa-circle-exclamation', label: '云端保存失败' }
    if (state === 'conflict')
      return { icon: 'fa-solid fa-circle-exclamation', label: '版本冲突' }
    if (state === 'dirty')
      return { icon: 'fa-solid fa-cloud-arrow-up', label: '等待保存' }
    return null
  },
)

const planRemainingText = computed(() => {
  if (!planStore.todayWordsAvailable) return '—'
  const target = planTargetWords.value || 0
  if (!target) return '未设置'
  const diff = Math.max(target - (planTodayWords.value || 0), 0)
  return `${diff.toLocaleString()} 字`
})

const planMiniCircleStyle = computed(() => {
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const ratio = Math.min(Math.max(planProgress.value, 0), 100) / 100
  return {
    strokeDasharray: `${circumference}`,
    strokeDashoffset: `${circumference * (1 - ratio)}`,
  }
})

// ==========================================
// 打字特效与音效（逻辑在 useTypingFeedback 组合式，实例化在 editor 声明之后）
// ==========================================
const particlesContainerRef = ref<HTMLElement | null>(null)

// 容器引用和响应式布局
const containerRef = ref<HTMLElement | null>(null)
const toolbarScrollRef = ref<HTMLElement | null>(null)
const statusBarRef = ref<HTMLElement | null>(null)
const statusCenterRef = ref<HTMLElement | null>(null)
const statusRightRef = ref<HTMLElement | null>(null)
const editorScrollRef = ref<HTMLElement | null>(null)
const isCompactMode = ref(false)
const isStatusTightMode = ref(false)
// 程序同步滚动时忽略自身 scroll 事件，避免双向同步回环。
let isApplyingEditorScroll = false
let resizeObserver: ResizeObserver | null = null

const {
  isToolbarIconOnlyMode,
  isStatusIconOnlyMode,
  updateToolbarMode,
  updateStatusBarMode,
  disposeChromeMeasure,
} = useEditorChrome({
  toolbarScrollRef,
  statusBarRef,
  statusCenterRef,
  statusRightRef,
})

const { isFullscreen, toggleFullscreen } = useEditorFullscreen()

const getScrollRatio = (el: HTMLElement) => {
  const maxScrollTop = el.scrollHeight - el.clientHeight
  return maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 0
}

const handleEditorScroll = () => {
  const el = editorScrollRef.value
  if (!el || isApplyingEditorScroll) return
  hideEntityHover()
  editorStore.setWritingScrollRatio(getScrollRatio(el), 'editor')
  if (isBubbleMenuVisible.value) {
    updateBubbleMenuPosition()
  }
}

const syncEditorScroll = () => {
  const el = editorScrollRef.value
  if (!el || writingScrollSource.value === 'editor') return
  const maxScrollTop = el.scrollHeight - el.clientHeight
  isApplyingEditorScroll = true
  el.scrollTop = maxScrollTop > 0 ? maxScrollTop * writingScrollRatio.value : 0
  window.setTimeout(() => {
    isApplyingEditorScroll = false
  }, 80)
}

watch([writingScrollRatio, writingScrollSource], () => {
  requestAnimationFrame(syncEditorScroll)
})

onMounted(() => {
  preloadSamples()

  if (containerRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 右侧面板挤压时按实际可见宽度切换工具栏与状态栏。
        isCompactMode.value = entry.contentRect.width < 1180
        isStatusTightMode.value = entry.contentRect.width < 760
        nextTick(() => {
          updateToolbarMode()
          updateStatusBarMode()
        })
      }
    })
    resizeObserver.observe(containerRef.value)
  }
  nextTick(() => {
    updateToolbarMode()
    updateStatusBarMode()
  })

  window.addEventListener(
    'ew-writing-plot-anchor-jump',
    handlePlotAnchorJump as EventListener,
  )
})

onBeforeUnmount(() => {
  window.removeEventListener(
    'ew-writing-plot-anchor-jump',
    handlePlotAnchorJump as EventListener,
  )

  if (resizeObserver) {
    resizeObserver.disconnect()
  }
})

// 主题 Store
const themeStore = useThemeStore()

// 主题切换处理
const handleThemeChange = (theme: string) => {
  themeStore.switchTheme(theme)
}

// 排版处理
const handleFormat = () => {
  if (!editor.value || workflowLocked.value) return
  formatEditorContent(editor.value)
}

// Props
const props = defineProps<{
  bookId?: string | number
  entityHighlights?: EntityHighlightItem[]
  /** 审稿建议正文标注：按段落下标三级着色，由父级按当前章过滤后传入 */
  issueHighlights?: IssueHighlightItem[]
  workflowMode?: boolean
  workflowLocked?: boolean
  /** 作品详情 / 目录还在拉取。此时不能显示「请选择左侧章节」——还不知道有没有章节 */
  booting?: boolean
}>()
const emit = defineEmits<{
  /** 正文里选中/取消选中命中段（右侧卡片联动加边框） */
  (event: 'issueSelected', issueKeys: string[]): void
  /** 某条建议的段落已被 AI 改写替换（卡片打"已修改"标） */
  (event: 'issuePolished', issueKey: string): void
}>()

const workflowMode = computed(() => props.workflowMode === true)
const workflowLocked = computed(() => props.workflowLocked === true)

// 批次三 3A 段落改写解禁：气泡菜单、AI 润色等主动改稿入口的统一判定。
// 普通模式沿用原有 workflowLocked 判定（关联任务生成本章时仍锁定）；
// 工作流模式下由会话快照决定——停机等确认或无进行中生成任务时解禁，
// 生成中（含断点半成品章）维持禁用，workflowLocked 继续覆盖状态未知与恢复锁定期。
const workflowManualEditUnlocked = computed(
  () =>
    !workflowLocked.value &&
    (!workflowMode.value ||
      isWorkflowChapterManualEditable(Number(activeChapterId.value || 0)))
)

// 气泡菜单（AI润色/绑定/更多）只属于普通写作模式：工作流生书页的改稿入口
// 统一走确认面板（AI 修改此段/定位原文），选中文本不再弹旧气泡（2026-07-30 用户定案）。
const bubbleMenuAllowed = computed(
  () => !workflowMode.value && workflowManualEditUnlocked.value
)

interface EnsurePersistedOptions {
  silent?: boolean
}

interface WorkflowContentPersistResult {
  ok: boolean
  contentVersion?: number
  message?: string
}

interface WorkflowContentPersistOptions {
  expectedChapterId?: number
  persistedCandidateVersion?: number
}

interface WritingEditorExpose {
  hasUnsavedChanges: () => boolean
  ensurePersisted: (options?: EnsurePersistedOptions) => Promise<boolean>
  snapshotLocalDraft: () => Promise<boolean>
  getContentVersion: () => number
  applyWorkflowGeneratedText: (text: string) => void
  settleWorkflowGeneratedText: (chapterId: number) => Promise<boolean>
  focusEditor: () => void
  /** 审稿建议"定位原文"：滚动到命中段并闪烁；多段命中时轮巡 */
  locateIssueHighlight: (issueKey: string) => boolean
  /** 审稿建议"AI 修改此段"：选中命中段并打开局部修改预览卡 */
  startIssuePolish: (input: {
    issueKey: string
    label: string
    quotes?: string[]
    request: (args: {
      paragraphText: string
      prevParagraph?: string
      nextParagraph?: string
      extraRequirement?: string
    }) => Promise<string>
  }) => boolean
  ensureWorkflowContentPersisted: (
    options?: WorkflowContentPersistOptions,
  ) => Promise<WorkflowContentPersistResult>
}

// ==========================================
// 1. 基础数据
// ==========================================
const hasActiveChapter = computed(() => !!activeChapterId.value)

const suppressAutoSave = ref(false)
// 输入法组词进行中。此时文档里是拼音而不是最终汉字，任何落盘都会存下半成品。
const isComposingInput = ref(false)
const chapterContentReady = ref(false)
// 编辑器里这份正文究竟属于哪一章。
//
// 「当前章节 ID」和「编辑器里的正文」来自两条不同的更新链路：前者在用户点击时
// 立刻翻转，后者要等 loadChapterContent 走完网络与本地库才会被替换。任何在这个
// 空档里落盘的快照，都会把上一章的正文写进新章的 storageKey——轻则新章莫名其妙
// 出现别人的内容，重则被判成"本地脏稿 vs 云端"冲突，弹出左右两栏是不同章节的对话框。
// 因此正文就绪时记下它的归属，落盘前必须与当前章一致。
const readyChapterId = ref(0)
const markChapterReady = (chapterId: number) => {
  readyChapterId.value = Number(chapterId) || 0
  chapterContentReady.value = true
  // 码字统计：已有章节在加载完成时焊上字数基线，保证接下来的输入按净增记账
  if (readyChapterId.value) {
    primeChapterWords(
      resolveCurrentBookId(),
      readyChapterId.value,
      countWords(readEditorText()),
      countTextWords(readEditorText()),
    )
  }
  // 正文整体替换会让旧的建议标注随替换事务失效；内容就绪后按当前建议重挂。
  void nextTick(() => applyIssueHighlights())
}
const clearChapterReady = () => {
  readyChapterId.value = 0
  chapterContentReady.value = false
}
const lastChapterSaveError = ref('')
const currentChapterStorageUserId = ref('')
const localDraftTimer = ref<number | null>(null)
const lastSavedContent = ref('')
const lastSavedTitle = ref('')
const lastSavedContentJson = ref<unknown>(null)
const currentChapterVersion = ref(0)
const currentChapterLocalVersion = ref(0)
// 自动生文流式快照是只读预览，不能被本地同步服务当成用户手稿上传。
const workflowPreviewActive = ref(false)
let currentSavePromise: Promise<boolean> | null = null
// 云端保存未完成时延后本地快照，避免旧版本号覆盖刚同步的章节版本。
let pendingLocalDraftSnapshot = false

const resolveCurrentBookId = () => {
  const raw = props.bookId
  if (raw === undefined || raw === null || raw === '') return ''
  return String(raw)
}

const resolveCurrentChapterId = () => {
  // 本地实体是负数 id，非零即有效
  const raw = Number(activeChapterId.value || 0)
  return Number.isFinite(raw) && raw !== 0 ? raw : 0
}

/**
 * 草稿存储键里的 userId。
 *
 * 这个值一旦漂移，同一章就会被写到另一条记录上，旧记录再也读不回来——
 * 表现就是"编辑完丢稿"。所以只允许两种取值：
 * - 本地书：恒为 guest，不随登录态变化（登录后的归属由认领流程显式迁移 storageKey）
 * - 云端书：真实用户 ID
 * 拿不到真实 ID 时宁可回落 guest，也绝不用 token 派生的临时身份：
 * token 一刷新就变，那段时间写入的内容会永久孤儿化。
 */
const resolveCurrentUserId = () => {
  // 开源版为本地单用户，身份恒为 guest；键规则不能再变，否则旧记录失联
  return LOCAL_USER_ID
}

const resolveChapterStorageUserId = () =>
  currentChapterStorageUserId.value || resolveCurrentUserId()

const buildCurrentDraftSnapshot = () => {
  const chapterId = resolveCurrentChapterId()
  const bookId = resolveCurrentBookId()
  if (!chapterContentReady.value || !chapterId || !bookId || !editor.value)
    return null
  // 只允许保存「编辑器里这份正文本来就属于的那一章」。对不上说明切章过程中有
  // 一次落盘挤了进来，这一份写下去就是串章覆盖，宁可丢掉这次快照——正文还在
  // 编辑器里，下一次 markDraftDirty 会重新排队。
  if (readyChapterId.value !== chapterId) {
    recordWriteJournal({
      at: Date.now(),
      op: 'guard',
      backend: isTauriRuntime() ? 'sqlite' : 'indexeddb',
      storageKey: buildChapterStorageKey(
        resolveChapterStorageUserId(),
        bookId,
        chapterId
      ),
      chars: 0,
      ok: false,
      reason: `chapter drift: editor=${readyChapterId.value}`,
    })
    return null
  }
  const now = Date.now()
  return {
    userId: resolveChapterStorageUserId(),
    bookId,
    chapterId,
    title: activeChapterTitle.value || '',
    textContent: readEditorText(),
    contentJson: editor.value.getJSON(),
    localVersion: 0,
    remoteVersion: Number(currentChapterVersion.value || 0),
    baseRemoteVersion: Number(currentChapterVersion.value || 0),
    baseTitle: lastSavedTitle.value || '',
    baseTextContent: lastSavedContent.value || '',
    baseContentJson: lastSavedContentJson.value ?? null,
    dirty: !workflowPreviewActive.value,
    conflict: false,
    localOnly: true,
    workflowPreview: workflowPreviewActive.value,
    updatedAt: now,
  } as LocalChapterDraft
}

const chapterTitleModel = computed({
  get: () => activeChapterTitle.value,
  set: (val: string) => {
    if (workflowLocked.value) return
    editorStore.setChapterTitle(val)
    if (!suppressAutoSave.value) {
      markDraftDirty()
    }
  },
})
const canUndo = ref(false)
const canRedo = ref(false)
const handleEditorPaste = (view: EditorView, event: ClipboardEvent) => {
  if (workflowLocked.value) {
    event.preventDefault()
    return true
  }
  const text = event.clipboardData?.getData('text/plain')
  if (!text) return false

  event.preventDefault()
  const plainText = markdownToPlainText(text)
  if (!plainText) return true

  // 复用文档级的行归一化：去段首缩进空格（缩进由排版样式负责）、滤掉空行，
  // 避免多段粘贴时在段落之间插入空段落。
  const rows = normalizePlainTextRows(plainText)
  if (!rows.length) return true

  // 正文只插入无标记段落，粘贴事务保留 paste 标识供现有统计链路识别。
  if (rows.length === 1) {
    // 单行：纯内联插入，贴在光标处不换行（有选区时替换选区）
    view.dispatch(
      view.state.tr
        .insertText(rows[0])
        .setMeta('uiEvent', 'paste')
        .scrollIntoView(),
    )
    return true
  }
  view.dispatch(
    view.state.tr
      .replaceSelection(buildPlainTextPasteSlice(view, rows))
      .setMeta('uiEvent', 'paste')
      .scrollIntoView(),
  )
  return true
}

// ==========================================
// 2. AI 配置
// ==========================================
// ==========================================
// 3. 编辑器初始化
// ==========================================
const editor = ref<Editor>()
const readEditorText = (target: Editor | undefined = editor.value) => {
  return target?.getText?.({ blockSeparator: '\n' }) || ''
}

const {
  webkitCaretEnabled,
  webkitCaretVisible,
  webkitCaretStyle,
  hideWebKitCaret,
  scheduleWebKitCaretUpdate,
} = useWebKitCaret({
  editor,
  rulerStyle,
  fontFamily,
  fontBold,
  fontSize,
  fontLineHeight,
  measuredLineHeightPx,
  getBaseLineHeightPx,
  normalizePixel,
})

const {
  entityHoverVisible,
  entityHoverStyle,
  activeEntityGroup,
  activeEntityItems,
  getEntityKindText,
  clearEntityHoverTimer,
  hideEntityHover,
  keepEntityHover,
  scheduleHideEntityHover,
  applyEntityHighlights,
  dismissActiveEntityGroup,
  handleEntityMouseOver,
  handleEntityMouseOut,
} = useEntityHighlights({
  editor,
  entityHighlights: () => props.entityHighlights,
  bookId: () => props.bookId,
})

const {
  applyIssueHighlights,
  locateIssueHighlight,
  polishSession,
  polishCardStyle,
  polishCardRef,
  polishOriginalSegments,
  closeIssuePolish,
  runPolishRequest,
  startIssuePolish,
  stepPolishTarget,
  applyIssuePolish,
  invalidatePolishOnManualEdit,
  handleIssueHighlightClick,
} = useIssuePolish({
  editor,
  issueHighlights: () => props.issueHighlights,
  onIssueSelected: keys => emit('issueSelected', keys),
  onIssuePolished: issueKey => emit('issuePolished', issueKey),
})

const {
  aiConfig,
  autocompleteModelOverride,
  aiShortcutTip,
  aiStatusText,
  isAiThinking,
  abortAiRequests,
  setAiBusy,
  fetchAiSuggestion,
  cancelAiSuggestion,
  triggerAiShortcut,
} = useAiAutocomplete({
  editor,
  workflowMode,
  workflowLocked,
  workflowManualEditUnlocked,
  chapterContentReady,
  activeChapterId,
  activeChapterTitle,
  activeChapterSummary,
  onDraftDirty: () => markDraftDirty(),
  onSelectionMenu: () => updateBubbleMenuPosition(),
  onAiTextInserted: text => recordAiInsert(countWords(text), countTextWords(text)),
})

const {
  triggerTypingSound,
  triggerTypingFeedback,
  unlockAudioByUserGesture,
  ensureAudioContextReady,
  preloadSamples,
  disposeAudioContext,
} = useTypingFeedback({
  typingSound,
  typingEffect,
  editor,
  particlesContainerRef,
})

// 敏感词校对（状态与调度在组合式内，编辑器只消费状态栏展示值）
const {
  sensitiveMatchCount,
  sensitiveStatusValue,
  sensitiveTooltipText,
  resetSensitiveState,
  runSensitiveCheck,
  scheduleSensitiveCheck,
} = useSensitiveCheck({
  editor,
  activeChapterId,
  readEditorText: () => readEditorText(),
})

watch(
  () => [
    saveStatusIconMeta.value?.label || '',
    isManualSyncing.value ? 'syncing' : 'idle',
    aiStatusText.value,
    planRemainingText.value,
    sensitiveStatusValue.value,
    sensitiveTooltipText.value,
    chapterWordCount.value,
  ],
  () => nextTick(updateStatusBarMode),
)

watch(
  () => isFullscreen.value,
  () => nextTick(updateToolbarMode),
)

watch(wordCounter.mode, async () => {
  await ensurePersisted()
  await planStore.fetchSummary()
})
const lastPlanWordCount = ref(0)
let editorKeydownTarget: HTMLElement | null = null
let editorKeydownHandler: ((e: KeyboardEvent) => void) | null = null
let editorBeforeInputHandler: ((e: InputEvent) => void) | null = null
let editorCompositionStartHandler: (() => void) | null = null
let editorCompositionEndHandler: (() => void) | null = null
let lastEditorKeydownAt = 0
// 最近一次"可信的用户输入意图"时间戳：由浏览器原生 beforeinput（isTrusted）刷新。
// 覆盖一切不产生 keydown 的输入路径——输入法快捷短语面板、鼠标点选候选词、
// 语音输入、手写板、触摸键盘；AI 程序化 insertContent 不触发 trusted beforeinput，
// 不会被误计为手动码字。
let lastEditorTrustedInputAt = 0
watch(
  () => props.issueHighlights,
  () => {
    applyIssueHighlights()
  },
  { deep: true },
)

// 字体/偏好面板（SmartPopover）：新手引导"展开面板演示"需要程序化开合
const fontPopoverRef = ref<InstanceType<typeof SmartPopover> | null>(null)
const prefPopoverRef = ref<InstanceType<typeof SmartPopover> | null>(null)
const bubbleMenuMode = computed(() =>
  editorStore.rightPanelActiveTool === 'timeline' ||
  editorStore.rightPanelActiveTool === 'storyline'
    ? 'plot-binding'
    : 'ai',
)
const pendingAnchorJump = ref<{
  chapterId?: string | number | null
  anchorStart?: number | null
  anchorEnd?: number | null
  anchorText?: string
} | null>(null)

// 查找替换弹窗
const showFindReplace = ref(false)
// 取名弹窗
const showNameGenerator = ref(false)
const showChapterHistory = ref(false)

const openNameGenerator = () => {
  if (workflowLocked.value) return
  showNameGenerator.value = true
}

const openArtistModal = () => {
  if (workflowLocked.value) return
  showArtistModal.value = true
}

const openChapterHistory = () => {
  showChapterHistory.value = true
}

const findBtnRef = ref<HTMLElement | null>(null)
const findModalPosition = ref<{ x: number; y: number } | undefined>(undefined)

const toggleFindReplace = () => {
  if (showFindReplace.value) {
    showFindReplace.value = false
    return
  }

  if (findBtnRef.value) {
    const rect = findBtnRef.value.getBoundingClientRect()
    // Calculate position: centered below the button
    // Assuming modal width is ~340px (from CSS)
    const modalWidth = 340
    // rect.left + rect.width / 2 is the center of the button
    // we want that to be the center of the modal
    let x = rect.left + rect.width / 2 - modalWidth / 2
    const y = rect.bottom + 10 // 10px gap

    // Boundary checks
    if (x < 10) x = 10
    if (x + modalWidth > window.innerWidth - 10)
      x = window.innerWidth - modalWidth - 10

    findModalPosition.value = { x, y }
  } else {
    // Fallback default
    findModalPosition.value = { x: window.innerWidth - 420, y: 100 }
  }

  showFindReplace.value = true
}

// AI 补全设置弹层贴视口边缘时留 12px 空隙（按钮在状态栏最左侧时尤其需要）
const aiConfigPopperOptions = {
  modifiers: [{ name: 'preventOverflow', options: { padding: 12 } }],
}

// Review 状态
const isReviewing = ref(false)
const reviewData = ref({
  original: '',
  range: { from: 0, to: 0 },
  // 本次改写已记入 AI 账的净增字数，点「废弃」时按它回冲
  aiDelta: 0,
  textAiDelta: 0,
})

// AI 插字记账：净增记 AI 并抬基线，自动落盘就不会把这批字记成手写；负数=回冲
const recordAiInsert = (wordDelta: number, textWordDelta: number) => {
  const bookId = String(props.bookId || '')
  const chapterId = Number(activeChapterId.value || 0)
  if (!bookId || !chapterId) return
  recordAiWordsAdded(bookId, chapterId, wordDelta, textWordDelta)
}

const {
  isBubbleMenuVisible,
  isBubbleMenuAnimating,
  bubbleMenuStyle,
  bubbleMenuRef,
  updateBubbleMenuPosition,
} = useBubbleMenu({ editor, bubbleMenuAllowed, isReviewing })

const clearLocalDraftTimer = () => {
  if (localDraftTimer.value) {
    window.clearTimeout(localDraftTimer.value)
    localDraftTimer.value = null
  }
}

// ---------------------------------------------------------------------------
// 编辑器全文级状态同步（字数/预览文本/敏感词），从每击键节流到 300ms。
// 消费方全是展示层（状态栏字数、侧栏、手机预览）；保存与 AI 路径都直接读
// 编辑器实例，不吃这里的延迟。窗口内只挂一个定时器，触发时读"当下"全文。
// ---------------------------------------------------------------------------
const EDITOR_STATE_SYNC_MS = 300
let editorStateSyncTimer: number | null = null

const clearEditorStateSyncTimer = () => {
  if (editorStateSyncTimer) {
    window.clearTimeout(editorStateSyncTimer)
    editorStateSyncTimer = null
  }
}

const flushEditorStateSync = () => {
  clearEditorStateSyncTimer()
  const ed = editor.value
  if (!ed || !chapterContentReady.value) return
  const text = readEditorText(ed)
  const words = countWords(text)
  editorStore.setActiveChapterTextContent(text)
  editorStore.setChapterWordCount(words)
  editorStore.syncLocalSessionWords(words)
  scheduleSensitiveCheck(text)
}

const scheduleEditorStateSync = () => {
  if (editorStateSyncTimer) return
  editorStateSyncTimer = window.setTimeout(() => {
    editorStateSyncTimer = null
    flushEditorStateSync()
  }, EDITOR_STATE_SYNC_MS)
}

/**
 * 本地快照：所有模式都留，不再看是否上云。
 *
 * 原来只在不上云的模式下留，理由是「云端模式服务端已有历史」——这个前提不成立。
 * 服务端只在 runPostProcess !== false 时落档，也就是只在手动保存/冲突处理时；
 * 自动保存传的是 false，服务端不写。于是云端模式下靠自动保存写作的用户，
 * 云端不写、本地也关着，两边都没有历史。
 *
 * 两套机制的粒度本就是互补的：云端是「显式覆盖前留一份」（稀疏、事件驱动），
 * 本地是「每 5 分钟或 200 字留一份」（连续、时间驱动）。关掉本地这一路，
 * 丢的不是冗余，是唯一一条连续粒度的历史，云端保存失败时更是一份都没有。
 *
 * 成本有界：每章最多 20 版，且受节流约束。
 */
const captureLocalVersion = (draft: StoredLocalChapterDraft) => {
  // 自动生文的流式预览不是用户手稿，且每个分片都在变，留版本只会灌满一串垃圾快照。
  if (workflowPreviewActive.value || draft.workflowPreview) return
  // 正文能被后续输入修正，快照不能——组词期间一律不留版本。
  if (isComposingInput.value) return
  void maybeCaptureLocalVersion(draft)
}

const snapshotLocalDraft = async () => {
  // 工作流流式片段由服务端 checkpoint 负责恢复，不能写进普通本地草稿表。
  // 否则候选正文落云后，这份旧片段会被同步器误判成“用户本地修改”，每次重写
  // 都会制造一次假冲突。用户在待确认态真正输入时 markDraftDirty 会先关闭预览态，
  // 仍会按普通草稿规则保存，不影响人工改稿保护。
  if (workflowMode.value && workflowPreviewActive.value) return true
  const snapshot = buildCurrentDraftSnapshot()
  if (!snapshot) return false
  try {
    const saved = await writingStorage.saveChapterLocal(snapshot)
    if (String(activeChapterId.value) === String(saved.chapterId)) {
      currentChapterLocalVersion.value = workflowContentVersion(saved)
    }
    captureLocalVersion(saved)
    await updateLocalChapterMeta(snapshot)
    lastSavedContent.value = snapshot.textContent
    lastSavedTitle.value = snapshot.title
    lastSavedContentJson.value = saved.contentJson
    editorStore.setChapterWordCount(countWords(snapshot.textContent))
    editorStore.setChapterSaveState('local_only', '仅本地保存')
    return true
  } catch (error) {
    console.error('保存本地草稿失败:', error)
    editorStore.setChapterSaveState('error', '本地保存失败')
    return false
  }
}

// 上次看到的章节数，用来区分「内容变了」和「结构变了」。
const lastKnownChapterCount = new Map<string, number>()

// 目录元信息必须跟着这份草稿的归属走。取当前章会在切章途中把 A 章的字数和
// 标题写到 B 章的目录项上——正文没坏，但目录显示的是另一章的数据。
const updateLocalChapterMeta = async (draft: LocalChapterDraft) => {
  const bookId = String(draft.bookId || '')
  const chapterId = Number(draft.chapterId || 0)
  if (!bookId || !chapterId) return
  const wordCount = countWords(draft.textContent)
  // 本地码字统计记账：按章节字数基线求净增，喂首页进度与统计页
  recordChapterWords(bookId, chapterId, wordCount, countTextWords(draft.textContent))
  const book = await localLibrary.updateLocalChapterContentMeta({
    bookId,
    chapterId,
    title: draft.title,
    wordCount,
  })
  // 以前这里发的是 ew-local-book-updated，接收方会「重新加载作品详情 + 重建整棵目录树」。
  // 而它挂在每次落盘上——本地模式下打字每 160ms 就重建一次目录，卡顿的主因。
  // 目录里会变的两个字段（当前章标题、字数）侧边栏本来就在响应式地就地更新，
  // 只有书籍总字数需要通知，发一个轻量事件即可，不必碰目录。
  if (!book) return
  window.dispatchEvent(
    new CustomEvent('ew-writing-book-words', {
      detail: { bookId, wordCount: Number(book.wordCount || 0), textWordCount: book.textWordCount },
    }),
  )
  // 章节数变了才是真的结构变化（增删章），这时才值得重载详情与目录。
  const chapterCount = Number(book.chapterCount || 0)
  if (lastKnownChapterCount.get(bookId) !== chapterCount) {
    lastKnownChapterCount.set(bookId, chapterCount)
    window.dispatchEvent(new CustomEvent('ew-local-book-updated', { detail: { bookId } }))
  }
}

const queueLocalDraftSnapshot = () => {
  if (
    suppressAutoSave.value ||
    !hasActiveChapter.value ||
    !chapterContentReady.value ||
    // 组词期间落盘存的是拼音；compositionend 会再调一次 markDraftDirty 补上。
    isComposingInput.value
  )
    return
  if (currentSavePromise) {
    pendingLocalDraftSnapshot = true
    return
  }
  clearLocalDraftTimer()
  localDraftTimer.value = window.setTimeout(() => {
    localDraftTimer.value = null
    if (currentSavePromise) {
      pendingLocalDraftSnapshot = true
      return
    }
    void snapshotLocalDraft()
  }, 160)
}

const hasUnsavedChanges = () => {
  if (!editor.value || !activeChapterId.value || !chapterContentReady.value)
    return false
  const text = readEditorText()
  const title = activeChapterTitle.value
  return text !== lastSavedContent.value || title !== lastSavedTitle.value
}

const markDraftDirty = () => {
  if (workflowLocked.value || !chapterContentReady.value) return
  workflowPreviewActive.value = false
  editorStore.setChapterSaveState('local_only', '仅本地保存')
  queueLocalDraftSnapshot()
}

const saveChapterContent = async (
  silent = false,
  options?: { forceSync?: boolean; runPostProcess?: boolean; saveHistory?: boolean },
) => {
  if (currentSavePromise) {
    return await currentSavePromise
  }
  // 识别期与当前生成章只接收工作流快照，普通草稿保存不得覆盖服务端生成正文。
  if (workflowLocked.value) return true
  if (!editor.value || !activeChapterId.value || !chapterContentReady.value)
    return false
  clearLocalDraftTimer()

  const text = readEditorText()
  const title = activeChapterTitle.value

  if (!silent && !text && !title) return true
  if (
    text === lastSavedContent.value &&
    title === lastSavedTitle.value &&
    !options?.forceSync
  ) {
    editorStore.setChapterSaveState('local_only', '仅本地保存')
    return true
  }

  // 整个函数体必须包在 try/finally 里：currentSavePromise 是「同一时刻只允许一次
  // 保存」的互斥锁，任何一条出口漏掉释放，锁就永久卡住——之后 queueLocalDraftSnapshot
  // 会被 `if (currentSavePromise)` 一直挡在门外，saveChapterContent 也只会返回那个
  // 陈旧 promise 的结果，用户表现为"从某一刻起再也没保存过、切章内容回退"。
  // 历史 bug：释放只写在云端分支的 finally 里，而「仅本地」模式永远在到达它之前
  // 就 return 了，于是首次保存之后本地模式的落盘全部失效。
  currentSavePromise = (async () => {
    try {
      lastChapterSaveError.value = ''
      const snapshot = buildCurrentDraftSnapshot()
      if (!snapshot) return false
      editorStore.setChapterSaveState('local_only', '仅本地保存')
      const localDraft = await writingStorage
        .saveChapterLocal(snapshot)
        .catch((error) => {
          console.error('保存本地草稿失败:', error)
          editorStore.setChapterSaveState('error', '本地保存失败')
          return null
        })
      if (!localDraft) return false
      if (String(activeChapterId.value) === String(localDraft.chapterId)) {
        currentChapterLocalVersion.value = workflowContentVersion(localDraft)
      }
      captureLocalVersion(localDraft)

      const wordLen = countWords(text)
      editorStore.setChapterWordCount(wordLen)
      await updateLocalChapterMeta(snapshot)
      lastSavedContent.value = text
      lastSavedTitle.value = title
      lastSavedContentJson.value = localDraft.contentJson
      editorStore.setChapterSaveState('local_only', '仅本地保存')
      return true
    } finally {
      // 无论从哪条出口离开都要释放锁，并补跑保存期间被压下的那次快照。
      currentSavePromise = null
      const shouldFlushLocalDraft = pendingLocalDraftSnapshot
      pendingLocalDraftSnapshot = false
      if (shouldFlushLocalDraft) {
        queueLocalDraftSnapshot()
      }
    }
  })()

  return await currentSavePromise
}

const ensurePersisted = async (options?: EnsurePersistedOptions) => {
  if (workflowLocked.value) return true
  if (!hasUnsavedChanges()) return true
  return await saveChapterContent(options?.silent !== false)
}

let latestChapterRequestId = 0

/** 本次章节加载是否已被更晚的一次切章取代；每个 await 之后都必须检查 */
const isStaleChapterRequest = (requestId: number) =>
  requestId !== latestChapterRequestId

const planVisibilityHandler = () => {
  planStore.setPageActive(!document.hidden)
}
const planFocusHandler = () => planStore.setPageActive(true)
const planBlurHandler = () => planStore.setPageActive(false)
const beforeUnloadHandler = () => {
  planStore.flushReport(true)
  if (hasUnsavedChanges()) {
    void snapshotLocalDraft()
  }
}

const localSnapshotRequestHandler = async () => {
  planStore.flushReport(true)
  const success = hasActiveChapter.value ? await snapshotLocalDraft() : true
  window.dispatchEvent(
    new CustomEvent('ew-writing-local-snapshot-done', { detail: { success } }),
  )
}

const loadChapterContent = async (chapterId: number) => {
  const requestId = ++latestChapterRequestId
  suppressAutoSave.value = true
  workflowPreviewActive.value = false
  currentChapterLocalVersion.value = 0
  clearChapterReady()
  clearEditorStateSyncTimer()
  // 切章即掐掉在途的续写/补全流，旧章的产物不该再消耗与插入
  abortAiRequests()
  editorStore.setActiveChapterTextContent('')
  clearLocalDraftTimer()
  pendingLocalDraftSnapshot = false
  try {
    if (isStaleChapterRequest(requestId)) return
    const bookId = resolveCurrentBookId()
    const userId = resolveChapterStorageUserId()
    const localDraft = await writingStorage.getChapterByIdentity(
      userId,
      bookId,
      chapterId,
    )
    // 取证：把"打开这一章时用什么键去读、读到没有、读到多少字"落盘。
    // 与保存侧的 save 行对照，就能直接看出是没写、写失败、还是读写用了不同的键。
    recordChapterLoadJournal({
      backend: isTauriRuntime() ? 'sqlite' : 'indexeddb',
      storageKey: buildChapterStorageKey(userId, bookId, chapterId),
      chars: String(localDraft?.textContent || '').length,
      found: Boolean(localDraft),
      detail: `title=${JSON.stringify(
        String(localDraft?.title || activeChapterTitle.value || '').slice(0, 20)
      )}`,
    })
    // 每个 await 之后都要确认这次加载还是最新的一次。
    // 来回切章会并发多个 loadChapterContent，而本地库两次读的完成顺序没有保证
    //（Windows 上 SQLite 打开与读取的耗时抖动明显更大，乱序返回很常见）。
    // 少了这道守卫，后返回的旧请求会用上一章的正文覆盖编辑器，而它自己的
    // nextTick 因 requestId 不匹配而早退——状态仍指向新章，于是下一次保存
    // 会把上一章的文本写进新章的 storageKey，造成不可逆的串章覆盖。
    if (isStaleChapterRequest(requestId)) return

    const title = localDraft?.title || activeChapterTitle.value || ''
    currentChapterVersion.value = Number(localDraft?.remoteVersion || localDraft?.baseRemoteVersion || 0)
    currentChapterLocalVersion.value = workflowContentVersion(localDraft)
    editorStore.setChapterTitle(title)
    editorStore.resetLocalSessionWords()
    createEditorInstance(localDraft?.contentJson ?? localDraft?.textContent ?? EMPTY_EDITOR_DOC)
    nextTick(() => {
      if (isStaleChapterRequest(requestId)) return
      const text = readEditorText()
      lastSavedContent.value = text
      lastSavedTitle.value = title
      lastSavedContentJson.value = localDraft?.contentJson ?? null
      currentChapterStorageUserId.value = LOCAL_USER_ID
      markChapterReady(chapterId)
      const wordCount = countWords(text)
      editorStore.setChapterWordCount(wordCount)
      editorStore.resetLocalSessionWords(wordCount, countTextWords(text))
      editorStore.setChapterSaveState('local_only', '仅本地保存')
      suppressAutoSave.value = false
    })
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ERR_CANCELED') {
      if (!isStaleChapterRequest(requestId)) {
        suppressAutoSave.value = false
      }
      return
    }
    if (!isStaleChapterRequest(requestId)) {
      console.error('加载章节内容失败:', error)
      showApiError(error, '加载章节内容失败')
      editorStore.setChapterSaveState('error', '加载失败')
      suppressAutoSave.value = false
    }
  }
}

watch(
  () => chapterWordCount.value,
  (count) => {
    if (suppressAutoSave.value) {
      lastPlanWordCount.value = count || 0
      return
    }
    lastPlanWordCount.value = count || 0
  },
)

watch(
  () => activeChapterId.value,
  (chapterId, prevId) => {
    if (!chapterId) {
      // 清空章节时废弃仍在返回中的旧章节请求。
      latestChapterRequestId += 1
      resetAiReviewState()
      hideEntityHover()
      clearChapterReady()
      currentChapterStorageUserId.value = ''
      lastSavedContent.value = ''
      lastSavedTitle.value = ''
      lastSavedContentJson.value = null
      currentChapterVersion.value = 0
      currentChapterLocalVersion.value = 0
      pendingLocalDraftSnapshot = false
      editorStore.setActiveChapterTextContent('')
      editorStore.setChapterWordCount(0)
      editorStore.setChapterSaveState('idle', '')
      resetSensitiveState()
      return
    }
    if (chapterId !== prevId) {
      resetAiReviewState()
      hideEntityHover()
      clearChapterReady()
      currentChapterStorageUserId.value = ''
      pendingLocalDraftSnapshot = false
      resetSensitiveState()
      loadChapterContent(chapterId)
    }
  },
  { immediate: true },
)

watch([activeChapterId, chapterContentReady], () => {
  applyAnchorJump()
})

watch(
  workflowMode,
  (enabled) => {
    if (!enabled) return
    // 自动生文模式只展示生成结果，关闭普通写作辅助的悬浮态。
    cancelAiSuggestion()
    isBubbleMenuVisible.value = false
    isBubbleMenuAnimating.value = false
    isReviewing.value = false
    showNameGenerator.value = false
    showArtistModal.value = false
    hideEntityHover()
  },
  { immediate: true },
)

// 解禁态收回时（如恢复生成、任务重新入队）立刻收起主动改稿的悬浮 UI，
// 与 workflowLocked 观察器互补：它只覆盖「当前章被锁」，这里覆盖会话级禁用。
watch(workflowManualEditUnlocked, unlocked => {
  if (unlocked) return
  cancelAiSuggestion()
  isBubbleMenuVisible.value = false
  isBubbleMenuAnimating.value = false
})

watch(workflowLocked, locked => {
  editor.value?.setEditable(!locked)
  if (locked) {
    // 工作流识别或生成锁定期间，终止所有可能回写正文的普通编辑器异步入口。
    cancelAiSuggestion()
    clearLocalDraftTimer()
    clearEditorStateSyncTimer()
    isBubbleMenuVisible.value = false
    isBubbleMenuAnimating.value = false
    resetAiReviewState()
    showNameGenerator.value = false
    showArtistModal.value = false
    return
  }
  if (!editor.value) return
  // 解锁后重新读取命令状态，避免流式快照未触发 update 导致按钮仍保持灰色。
  canUndo.value = editor.value.can().undo()
  canRedo.value = editor.value.can().redo()
})

// 创建编辑器实例
const createEditorInstance = (content: unknown) => {
  const oldEditor = editor.value
  editor.value = undefined

  if (oldEditor) {
    oldEditor.destroy()
  }
  if (editorKeydownTarget && editorKeydownHandler) {
    editorKeydownTarget.removeEventListener(
      'keydown',
      editorKeydownHandler as unknown as EventListener,
    )
  }
  if (editorKeydownTarget && editorBeforeInputHandler) {
    editorKeydownTarget.removeEventListener(
      'beforeinput',
      editorBeforeInputHandler as unknown as EventListener,
    )
  }
  if (editorKeydownTarget && editorCompositionStartHandler) {
    editorKeydownTarget.removeEventListener(
      'compositionstart',
      editorCompositionStartHandler as unknown as EventListener,
    )
  }
  if (editorKeydownTarget && editorCompositionEndHandler) {
    editorKeydownTarget.removeEventListener(
      'compositionend',
      editorCompositionEndHandler as unknown as EventListener,
    )
  }
  if (editorKeydownTarget) {
    editorKeydownTarget.removeEventListener(
      'click',
      handleIssueHighlightClick as unknown as EventListener,
    )
  }
  polishSession.value = null
  editorKeydownTarget = null
  editorKeydownHandler = null
  editorBeforeInputHandler = null
  editorCompositionStartHandler = null
  editorCompositionEndHandler = null
  isComposingInput.value = false
  lastEditorKeydownAt = 0
  lastEditorTrustedInputAt = 0

  const sanitizedContent = normalizeEditorContentPayload(content)

  nextTick(() => {
    const ed = new Editor({
      extensions: [
        StarterKit,
        CharacterCount,
        Placeholder.configure({
          placeholder: () =>
            workflowMode.value
              ? '自动生文中，正文将随生成进度同步...'
              : '开始创作，或按快捷键召唤 AI...',
          emptyEditorClass: 'is-editor-empty',
        }),
        AICopilotExtension.configure({
          // 工作流生书正文只能由工作流与确认面板改写，普通实时续写补全始终关闭。
          enabled: () =>
            !workflowMode.value && workflowManualEditUnlocked.value,
          onFetchSuggestion: fetchAiSuggestion,
          onCancelRequest: cancelAiSuggestion,
          onAcceptSuggestion: text => recordAiInsert(countWords(text), countTextWords(text)),
          debounceMin: 1200,
          debounceMax: 1800,
          minRequestInterval: 8000,
          minChangedChars: 12,
          rateLimitCooldown: 60000,
        }),
        PersistentSelectionExtension,
        AiReviewExtension,
        FindReplace,
        EntityHighlightExtension,
        IssueHighlightExtension,
        SensitiveExtension,
      ],
      content: sanitizedContent,
      editable: !workflowLocked.value,
      editorProps: {
        attributes: { class: 'prosemirror-content' },
        handlePaste: handleEditorPaste,
        handleKeyDown: (_view, event) => {
          const key = String(event.key || '').toLowerCase()
          const isHistoryShortcut =
            (event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')
          if (!workflowLocked.value || !isHistoryShortcut) return false
          // 生成锁定期间拦截 Tiptap 自带历史快捷键，避免绕过工具栏禁用状态。
          event.preventDefault()
          return true
        },
      },
    })

    ed.on('selectionUpdate', ({ transaction }) => {
      // 事务要真正传进来，查找跳转（scrolledToMatch）的气泡抑制才生效
      updateBubbleMenuPosition({ transaction })
      scheduleWebKitCaretUpdate()
    })
    ed.on('focus', () => {
      scheduleWebKitCaretUpdate()
      void ensureAudioContextReady()
    })
    ed.on('blur', () => {
      hideWebKitCaret()
      scheduleHideEntityHover()
    })
    ed.on('update', ({ transaction }) => {
      // 全文读取+字数统计是 O(全章) 的开销，万字章每击键跑两遍会拖输入手感。
      // 这里只做 O(本次改动) 的事，全文级同步（字数/预览文本/敏感词）节流到 300ms。
      scheduleEditorStateSync()
      invalidatePolishOnManualEdit()
      if (!suppressAutoSave.value) {
        markDraftDirty()

        // 用户输入来源判定：keydown 窗口 + 可信 beforeinput 窗口二选一。
        // 后者覆盖不产生 keydown 的输入法提交（快捷短语/鼠标点候选/语音/手写），
        // 修复这类输入整段漏记的问题；AI 程序化插入两个信号都不会有，不误计。
        //（注意：ProseMirror 的 uiEvent meta 只有 paste/cut/drop，
        //  不存在 'input'/'compositionend'，别再依赖它判定输入法。）
        const now = Date.now()
        const uiEvent = transaction?.getMeta?.('uiEvent')
        const isKeyboardRecent = now - lastEditorKeydownAt <= 1500
        const isTrustedInputRecent = now - lastEditorTrustedInputAt <= 1500
        const isUserSourceRecent = isKeyboardRecent || isTrustedInputRecent
        const isPasteDrop = uiEvent === 'paste' || uiEvent === 'drop'
        const isCut = uiEvent === 'cut'
        const insertedChars = transaction?.docChanged
          ? countInsertedCharsFromTransaction(transaction)
          : 0
        const isKeyboardEdit = isUserSourceRecent && !isPasteDrop
        const isUserTextInput =
          insertedChars > 0 &&
          !isPasteDrop &&
          !isCut &&
          isUserSourceRecent
        if (
          transaction?.docChanged &&
          (isUserTextInput || isKeyboardEdit || isCut || isPasteDrop)
        ) {
          if (isUserTextInput) {
            triggerTypingFeedback()
            planStore.notifyTyping()
            planStore.addWords(insertedChars, countInsertedCharsFromTransaction(transaction, 'text'))
          }

          // 删除：无论是键盘删除、剪切、还是粘贴覆盖造成的删除，都需要回退净字数
          const deletedChars = countDeletedCharsFromTransaction(transaction)
          if (deletedChars > 0) {
            planStore.addWords(-deletedChars, -countDeletedCharsFromTransaction(transaction, 'text'))
          }
        }
      }
      canUndo.value = ed.can().undo()
      canRedo.value = ed.can().redo()
      scheduleWebKitCaretUpdate()
    })

    editor.value = ed
    editorStore.setActiveChapterTextContent(readEditorText(ed))
    applyEntityHighlights()
    applyIssueHighlights()
    scheduleWebKitCaretUpdate()
    void runSensitiveCheck(readEditorText(ed))

    editorKeydownTarget = ed.view.dom as unknown as HTMLElement
    editorKeydownHandler = (evt: KeyboardEvent) => {
      if (suppressAutoSave.value || !ed.isEditable) return
      // 过滤组合键和纯修饰键，避免误判为“键盘输入”来源
      if (evt.ctrlKey || evt.metaKey || evt.altKey) return
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(evt.key))
        return
      lastEditorKeydownAt = Date.now()
      void ensureAudioContextReady()
      // 删除不会进入“新增字符”事务分支，直接按真实删除键播放一次声音。
      // 剪切/撤销等组合键已在上方过滤，程序化删除也不会产生 keydown。
      if (evt.key === 'Backspace' || evt.key === 'Delete') {
        triggerTypingSound()
      }
    }
    editorKeydownTarget.addEventListener(
      'keydown',
      editorKeydownHandler as unknown as EventListener,
    )
    editorBeforeInputHandler = (evt: InputEvent) => {
      if (suppressAutoSave.value) return
      // 只认浏览器派发的真实用户输入（输入法各路径均在此列）；
      // 粘贴/拖放有独立的 uiEvent 判定与计数策略，这里不给它们续窗口，
      // 撤销/重做与程序化插入不产生 trusted beforeinput，天然排除。
      if (!evt.isTrusted) return
      const inputType = String(evt.inputType || '')
      if (inputType.startsWith('insertFrom') || inputType.startsWith('history')) return
      lastEditorTrustedInputAt = Date.now()
    }
    editorKeydownTarget.addEventListener(
      'beforeinput',
      editorBeforeInputHandler as unknown as EventListener,
    )
    // 中文输入法组词期间，拼音会先以真实文本进入文档（"这是" 打到一半是 "zhe'shi"）。
    // 落盘只要撞进这个窗口，存下去的就是拼音——正文本身随组词结束会被替换掉，
    // 但历史快照是不可变的，会把那串拼音永久留在版本列表里。
    // 所以组词期间不落盘，组词结束再补一次。
    editorCompositionStartHandler = () => {
      isComposingInput.value = true
    }
    editorCompositionEndHandler = () => {
      isComposingInput.value = false
      if (!suppressAutoSave.value) markDraftDirty()
    }
    editorKeydownTarget.addEventListener(
      'compositionstart',
      editorCompositionStartHandler as unknown as EventListener,
    )
    editorKeydownTarget.addEventListener(
      'compositionend',
      editorCompositionEndHandler as unknown as EventListener,
    )
    // 审稿标注段的点击选中（含点空白取消）；预览卡内的点击已被卡片自行拦截。
    editorKeydownTarget.addEventListener(
      'click',
      handleIssueHighlightClick as unknown as EventListener,
    )

    canUndo.value = ed.can().undo()
    canRedo.value = ed.can().redo()
  })
}

// ==========================================
// 4. 事件处理
// ==========================================
const handleUndo = () => {
  if (workflowLocked.value) return
  editor.value?.chain().focus().undo().run()
}

const handleRedo = () => {
  if (workflowLocked.value) return
  editor.value?.chain().focus().redo().run()
}

const handleHistoryRestored = async (chapterId: number) => {
  await loadChapterContent(chapterId)
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
}

const handleAiDone = (payload: {
  original: string
  from: number
  to: number
}) => {
  // 改写文本已进正文：净增部分记 AI（替换比原文短则不记也不扣）
  const insertedText = editor.value?.state.doc.textBetween(payload.from, payload.to, '\n') || ''
  const aiDelta = Math.max(0, countWords(insertedText) - countWords(payload.original))
  const textAiDelta = Math.max(0, countTextWords(insertedText) - countTextWords(payload.original))
  if (aiDelta || textAiDelta) recordAiInsert(aiDelta, textAiDelta)
  if (!workflowManualEditUnlocked.value) return
  isBubbleMenuVisible.value = false
  reviewData.value = {
    original: payload.original,
    range: { from: payload.from, to: payload.to },
    aiDelta,
    textAiDelta,
  }
  isReviewing.value = true
}

const handleReviewClose = async (action: 'accept' | 'discard') => {
  const { aiDelta, textAiDelta } = reviewData.value
  isReviewing.value = false
  reviewData.value = { original: '', range: { from: 0, to: 0 }, aiDelta: 0, textAiDelta: 0 }
  if (action === 'discard' && (aiDelta > 0 || textAiDelta > 0)) {
    // 正文已被浮窗恢复原样，把当时记的 AI 字数冲掉
    recordAiInsert(-aiDelta, -textAiDelta)
  }
  if (action === 'accept' && !workflowLocked.value) {
    await saveChapterContent(false)
  }
}

// 切章/清空章节时丢弃仍挂着的 AI 改写待审状态：否则悬浮窗会带着上一章的原文与
// 旧坐标，点“废弃”会把上一章文本插进新章的错误位置。
// 用函数声明（提升）以便 immediate 的切章 watch 在初始化阶段也能安全调用。
function resetAiReviewState() {
  if (!isReviewing.value && !reviewData.value.original) return
  isReviewing.value = false
  reviewData.value = { original: '', range: { from: 0, to: 0 }, aiDelta: 0, textAiDelta: 0 }
  try {
    editor.value?.commands.unsetAiReviewRange()
  } catch {
    // 高亮通常已随章节内容重置，清理失败忽略即可。
  }
}

const handleAddToChat = (payload: { content: string; range: string }) => {
  if (!workflowManualEditUnlocked.value) return
  if (workflowMode.value) {
    // 工作流侧栏没有妙笔对话面板，解禁后给明确提示而不是静默失败。
    ElMessage.warning('工作流创作模式暂不支持添加到妙笔对话')
    return
  }
  const text = payload?.content?.trim()
  if (!text) {
    ElMessage.warning('未检测到可添加的内容')
    return
  }
  aiChatStore.enqueueSelection({
    title: editorStore.activeChapterTitle || '当前章节',
    range: payload.range,
    content: text,
  })
  editorStore.setRightPanelActiveTool('magic')
  ElMessage.success('选区已添加到妙笔对话')
}

const buildSelectedPlotAnchor = () => {
  if (!editor.value) return null
  const { from, to, empty } = editor.value.state.selection
  if (empty || to <= from) return null
  const anchorText = editor.value.state.doc.textBetween(from, to, '\n').trim()
  if (!anchorText) return null
  return {
    bookId: props.bookId || '',
    chapterId: activeChapterId.value || '',
    chapterTitle: activeChapterTitle.value || '',
    anchorStart: from,
    anchorEnd: to,
    anchorText,
    anchorLabel: `${activeChapterTitle.value || '当前章节'} · ${anchorText.slice(0, 18)}`,
  }
}

const handlePlotBindingAction = (
  type: 'bind-storyline' | 'bind-timeline' | 'create-plot-node',
) => {
  if (!workflowManualEditUnlocked.value) return
  if (workflowMode.value) {
    // 工作流侧栏没有剧情线/时间线工具，解禁后给明确提示而不是静默失败。
    ElMessage.warning('工作流创作模式暂不支持剧情绑定')
    return
  }
  if (!props.bookId || !activeChapterId.value) {
    ElMessage.warning('请先打开章节')
    return
  }
  const anchor = buildSelectedPlotAnchor()
  if (!anchor) {
    ElMessage.warning('请先选中需要绑定的正文')
    return
  }
  window.dispatchEvent(
    new CustomEvent('ew-writing-plot-selection', {
      detail: { ...anchor, type },
    }),
  )
  editorStore.setRightPanelActiveTool(
    type === 'bind-timeline' ? 'timeline' : 'storyline',
  )
  isBubbleMenuVisible.value = false
}

// 命名器一键插入：把选中的名字插入当前光标处
const handleInsertName = (name: string) => {
  if (workflowMode.value || workflowLocked.value) return
  const text = String(name || '').trim()
  if (!text || !editor.value) return
  editor.value.chain().focus().insertContent(text).run()
  recordAiInsert(countWords(text), countTextWords(text))
  markDraftDirty()
  ElMessage.success(`已插入：${text}`)
}

const onContextMenu = (_e: MouseEvent) => {
  if (!editor.value || workflowMode.value || workflowLocked.value) return
  const { empty, from, to } = editor.value.state.selection
  if (!empty && to - from > 0) {
    updateBubbleMenuPosition()
  }
}

const applyAnchorJump = () => {
  const target = pendingAnchorJump.value
  if (!target || !editor.value || !chapterContentReady.value) return
  if (
    target.chapterId &&
    String(target.chapterId) !== String(activeChapterId.value || '')
  )
    return
  const from = Number(target.anchorStart || 0)
  const to = Number(target.anchorEnd || 0)
  const docSize = editor.value.state.doc.content.size
  if (from > 0 && to >= from && to <= docSize) {
    editor.value.chain().focus().setTextSelection({ from, to }).run()
    pendingAnchorJump.value = null
    isBubbleMenuVisible.value = false
    return
  }
  pendingAnchorJump.value = null
  ElMessage.warning('正文位置已变化，请在章节内手动定位锚点文本')
}

const handlePlotAnchorJump = (event: Event) => {
  const detail = (
    event as CustomEvent<{
      chapterId?: string | number | null
      anchorStart?: number | null
      anchorEnd?: number | null
      anchorText?: string
    }>
  ).detail
  if (!detail) return
  pendingAnchorJump.value = detail
  if (
    detail.chapterId &&
    String(detail.chapterId) !== String(activeChapterId.value || '')
  ) {
    window.dispatchEvent(
      new CustomEvent('ew-writing-open-chapter', {
        detail: { chapterId: Number(detail.chapterId) },
      }),
    )
    return
  }
  applyAnchorJump()
}

const handleAiTaskLoading = (value: boolean) => {
  setAiBusy(value)
}

const applyWorkflowGeneratedText = (value: string) => {
  if (!editor.value || !activeChapterId.value) return
  const contentJson = plainTextToTiptapJson(value)
  suppressAutoSave.value = true
  try {
    // 工作流生成中的正文是任务快照，预览时不进入普通手写自动保存队列。
    editor.value
      .chain()
      .setMeta('addToHistory', false)
      .setContent(contentJson, { emitUpdate: false })
      .run()
    const text = readEditorText()
    editorStore.setActiveChapterTextContent(text)
    editorStore.setChapterWordCount(countWords(text))
    lastSavedContent.value = text
    lastSavedTitle.value = activeChapterTitle.value
    lastSavedContentJson.value = contentJson
    workflowPreviewActive.value = true
    editorStore.setChapterSaveState('syncing', '自动生文中')
    // 流式帧只重置既有防抖，正文停止更新后再执行一次敏感词检查。
    scheduleSensitiveCheck(text)
  } finally {
    suppressAutoSave.value = false
    // 不写普通本地草稿：异常退出由服务端 checkpoint 恢复，避免机器生成片段
    // 与用户手稿共用本地同步通道。
  }
}

/** 任务停驻后以本地稿件结束流式预览，保留作者正在编辑的内容。 */
const settleWorkflowGeneratedText = async (chapterId: number): Promise<boolean> => {
  if (Number(activeChapterId.value) !== chapterId || workflowLocked.value) return false
  const requestId = latestChapterRequestId
  if (!chapterContentReady.value) return false
  if (!workflowPreviewActive.value && hasUnsavedChanges()) return true
  const draft = await writingStorage.getChapterByIdentity(
    resolveChapterStorageUserId(), resolveCurrentBookId(), chapterId,
  )
  if (isStaleChapterRequest(requestId) || Number(activeChapterId.value) !== chapterId || workflowLocked.value) return false
  if (!workflowPreviewActive.value && hasUnsavedChanges()) return true
  if (!draft || draft.workflowPreview) return false
  if (readEditorText() !== draft.textContent) applyWorkflowGeneratedText(draft.textContent)
  workflowPreviewActive.value = false
  currentChapterVersion.value = Number(draft.remoteVersion || draft.baseRemoteVersion || 0)
  currentChapterLocalVersion.value = workflowContentVersion(draft)
  lastSavedContent.value = readEditorText()
  lastSavedTitle.value = activeChapterTitle.value
  lastSavedContentJson.value = draft.contentJson
  editorStore.setChapterSaveState('local_only', '已保存本机')
  return true
}

const focusEditor = () => {
  if (workflowLocked.value) return
  editor.value?.commands.focus()
}

const ensureWorkflowContentPersisted = async (
  options: WorkflowContentPersistOptions = {},
): Promise<WorkflowContentPersistResult> => {
  const expectedChapterId = Number(options.expectedChapterId || 0)
  const persistedCandidateVersion = Number(
    options.persistedCandidateVersion || 0,
  )
  if (expectedChapterId) {
    // 质量确认必须等待目标候选章完整载入，禁止拿当前可见的其他章节版本代替。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (
        Number(activeChapterId.value || 0) === expectedChapterId &&
        chapterContentReady.value
      ) {
        break
      }
      await new Promise(resolve => window.setTimeout(resolve, 100))
    }
    if (Number(activeChapterId.value || 0) !== expectedChapterId) {
      return {
        ok: false,
        message: '待确认章节未能打开，请刷新工作流后重试',
      }
    }
    if (!chapterContentReady.value) {
      return {
        ok: false,
        message: '待确认章节正文尚未加载完成，请稍后重试',
      }
    }
  }
  if (workflowLocked.value) {
    return { ok: false, message: '当前章节仍在生成，请等待候选正文完成' }
  }
  if (!hasActiveChapter.value) {
    return {
      ok: true,
      contentVersion: Number(persistedCandidateVersion || 0) || undefined,
    }
  }
  if (!chapterContentReady.value) return { ok: false, message: '正文尚未加载完成，请稍后重试' }
  const chapterId = Number(activeChapterId.value)
  const requestId = latestChapterRequestId
  try {
    if (workflowPreviewActive.value) await settleWorkflowGeneratedText(chapterId)
    if (isStaleChapterRequest(requestId) || chapterId !== Number(activeChapterId.value)) {
      return { ok: false, message: '当前章节已切换，请重新操作' }
    }
    // 从数据库确认本地版本，不能把 remoteVersion=0 当作未保存。
    if (!workflowPreviewActive.value && !hasUnsavedChanges()) {
      const draft = await writingStorage.getChapterByIdentity(
        resolveChapterStorageUserId(), resolveCurrentBookId(), chapterId,
      )
      if (isStaleChapterRequest(requestId) || chapterId !== Number(activeChapterId.value)) {
        return { ok: false, message: '当前章节已切换，请重新操作' }
      }
      if (draft && !draft.workflowPreview && draft.textContent === readEditorText() && draft.title === activeChapterTitle.value) {
        currentChapterLocalVersion.value = workflowContentVersion(draft)
        editorStore.setChapterSaveState('local_only', '已保存本机')
        return { ok: currentChapterLocalVersion.value > 0, contentVersion: currentChapterLocalVersion.value || undefined }
      }
      if (!draft && !readEditorText().trim()) return { ok: true }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '无法读取本地正文，请稍后重试' }
  }
  // 只有断点而尚无正式本地稿时，显式保存当前预览后才能继续。
  workflowPreviewActive.value = false
  // 若点击继续时上一轮自动保存仍在进行，等待后再补交期间产生的新内容，最多收敛三轮。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (workflowLocked.value || isStaleChapterRequest(requestId) || chapterId !== Number(activeChapterId.value))
      return { ok: false, message: '当前正文暂时无法保存或章节已切换，请稍后重试' }
    const targetText = readEditorText()
    const targetTitle = activeChapterTitle.value
    const saved = await saveChapterContent(false, {
      forceSync: true,
      runPostProcess: false,
    })
    const contentStable =
      readEditorText() === targetText &&
      activeChapterTitle.value === targetTitle
    if (
      saved &&
      // 本地落盘成功即终态（保存状态为 local_only）
      chapterSaveState.value === 'local_only' &&
      contentStable &&
      !workflowLocked.value &&
      !isStaleChapterRequest(requestId) &&
      chapterId === Number(activeChapterId.value)
    ) {
      return {
        ok: true,
        contentVersion: Number(currentChapterLocalVersion.value || 0) || undefined,
      }
    }
    const changedWhileSaving =
      !contentStable || chapterSaveState.value === 'local_saved'
    if (!changedWhileSaving) {
      return {
        ok: false,
        message:
          lastChapterSaveError.value ||
          '当前正文未能保存到本地，请稍后重试',
      }
    }
  }
  return { ok: false, message: '正文仍在变化，请稍后再次确认' }
}

const syncCurrentChapterNow = async () => {
  if (workflowLocked.value) return
  if (
    !hasActiveChapter.value ||
    !chapterContentReady.value ||
    isManualSyncing.value
  )
    return
  isManualSyncing.value = true
  editorStore.setChapterSaveState('local_only', '仅本地保存')
  try {
    await snapshotLocalDraft()
  } finally {
    isManualSyncing.value = false
  }
}

let keydownHandler: ((e: KeyboardEvent) => void) | null = null
// 章节正文在服务端被替换（单章重写候选生成/应用/丢弃）后，
// 当前打开的就是该章时需要主动重载，否则编辑器一直显示旧正文。
const chapterContentRefreshHandler = (event: Event) => {
  const detail =
    (
      event as CustomEvent<{
        chapterId?: number
        source?: string
        contentVersion?: number
      }>
    ).detail || {}
  const chapterId = Number(detail.chapterId || 0)
  if (!chapterId || chapterId !== Number(activeChapterId.value || 0)) return
  void loadChapterContent(chapterId)
}

// ==========================================
// 5. 生命周期
// ==========================================
watch(
  () => props.bookId,
  (bookId) => {
    if (!bookId) {
      planStore.teardown()
      return
    }
    planStore.bootstrap(bookId)
  },
  { immediate: true },
)

onMounted(() => {
  createEditorInstance(EMPTY_EDITOR_DOC)
  document.addEventListener('visibilitychange', planVisibilityHandler)
  window.addEventListener('focus', planFocusHandler)
  window.addEventListener('blur', planBlurHandler)
  window.addEventListener('beforeunload', beforeUnloadHandler)
  window.addEventListener(
    'ew-writing-chapter-content-refresh',
    chapterContentRefreshHandler as EventListener,
  )
  window.addEventListener(
    'ew-writing-local-snapshot-request',
    localSnapshotRequestHandler,
  )
  // 登记快照提供者：关窗备份据此判断是否需要等待编辑器应答
  markWritingSnapshotProvider(true)
  window.addEventListener('pointerdown', unlockAudioByUserGesture, true)
  window.addEventListener('keydown', unlockAudioByUserGesture, true)

  keydownHandler = (e: KeyboardEvent) => {
    // 1. AI 快捷键
    if (
      !workflowMode.value &&
      workflowManualEditUnlocked.value &&
      isAiShortcut(e)
    ) {
      e.preventDefault()
      void triggerAiShortcut()
      return
    }

    // 2. 查找替换快捷键
    if (isFindShortcut(e)) {
      e.preventDefault()
      if (editor.value) {
        const { from, to } = editor.value.state.selection
        if (from !== to) {
          const text = editor.value.state.doc.textBetween(from, to, ' ', ' ')
          editor.value.commands.setFindQuery(text)
          // 如果需要同步到 query ref，可以在这里处理，但现在是通过 watcher 双向绑定的
          // findInitialQuery.value = text
        }
      }
      showFindReplace.value = true
      return
    }

    // 3. 保存快捷键
    if (isSaveShortcut(e)) {
      e.preventDefault()
      if (workflowLocked.value) return
      saveChapterContent(false)
      return
    }

    // 4. 添加至对话 (Cmd + U / Ctrl + U)
    if (
      !workflowMode.value &&
      !workflowLocked.value &&
      isAddToChatShortcut(e)
    ) {
      e.preventDefault()
      if (!editor.value) return

      const view = editor.value.view
      const { from, to } = view.state.selection

      if (to - from > 0) {
        const selectedText = view.state.doc.textBetween(from, to, '\n')

        // 简单的行号/段落计算逻辑占位
        let range = ''
        const startLine = view.state.doc.resolve(from).index(0) + 1
        const endLine = view.state.doc.resolve(to).index(0) + 1
        range =
          startLine === endLine
            ? `第${startLine}段`
            : `${startLine}-${endLine}段`

        handleAddToChat({
          content: selectedText,
          range: range,
        })
      } else {
        // 未选中文本时，将当前章节全文添加至 AI 妙笔对话（复用 handleAddToChat，
        // 其内部已处理空内容守卫，并会打开妙笔面板给出反馈）
        handleAddToChat({
          content: readEditorText(),
          range: '全文',
        })
      }
      return
    }
  }

  window.addEventListener('keydown', keydownHandler)
})

defineExpose<WritingEditorExpose>({
  hasUnsavedChanges,
  ensurePersisted,
  snapshotLocalDraft,
  getContentVersion: () => Number(currentChapterLocalVersion.value || 0),
  applyWorkflowGeneratedText,
  settleWorkflowGeneratedText,
  focusEditor,
  locateIssueHighlight,
  startIssuePolish,
  ensureWorkflowContentPersisted,
})

onBeforeUnmount(() => {
  abortAiRequests()
  clearEntityHoverTimer()
  disposeChromeMeasure()
  if (keydownHandler) {
    window.removeEventListener('keydown', keydownHandler)
  }
  document.removeEventListener('visibilitychange', planVisibilityHandler)
  window.removeEventListener('focus', planFocusHandler)
  window.removeEventListener('blur', planBlurHandler)
  window.removeEventListener('beforeunload', beforeUnloadHandler)
  window.removeEventListener(
    'ew-writing-chapter-content-refresh',
    chapterContentRefreshHandler as EventListener,
  )
  window.removeEventListener(
    'ew-writing-local-snapshot-request',
    localSnapshotRequestHandler,
  )
  markWritingSnapshotProvider(false)
  window.removeEventListener('pointerdown', unlockAudioByUserGesture, true)
  window.removeEventListener('keydown', unlockAudioByUserGesture, true)
  disposeAudioContext()
  clearLocalDraftTimer()
  clearEditorStateSyncTimer()
  resetSensitiveState()
  suppressAutoSave.value = false
  editor.value?.destroy()
  planStore.teardown()
})
</script>

<!-- 全局样式：Tiptap 编辑器核心样式 -->
<style lang="scss">
@use '../index.scss' as *;
</style>

<!-- Scoped 样式：组件布局样式 -->
<!-- Scoped 样式按区拆到两个文件：外壳（气泡/工具栏/正文区/主题） + 状态栏 -->
<style scoped lang="scss" src="./writing-editor-shell.scss"></style>
<style scoped lang="scss" src="./writing-editor-statusbar.scss"></style>
