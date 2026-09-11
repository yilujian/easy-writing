<template>
  <header class="writing-header border-gradient-b">
    <div class="header-left">
      <button class="exit-btn" @click="handleExit">
        <i class="fa-solid fa-chevron-left"></i> {{ workflowMode ? '返回工作流' : '退出' }}
      </button>
      <div class="divider"></div>
      <div v-if="isTitleLoading" class="book-title-skeleton" aria-label="作品加载中"></div>
      <h1 v-else class="book-title">{{ bookTitle }}</h1>
      <div class="book-tags">
        <span v-for="tag in bookTags" :key="tag" class="tag tag-style">{{ tag }}</span>
      </div>
    </div>

    <div class="header-right">
      <div class="stats-group">
        <span class="stat-item">
          <i class="fa-solid fa-chart-simple"></i> 本章: {{ displayChapterWords }}
        </span>
        <span class="stat-text">总字数: {{ wordCounter.format(wordCounter.value({wordCount: totalWords, textWordCount: textTotalWords})) }}</span>
        <i class="fa-regular fa-circle-question help-icon"></i>
      </div>
    </div>
  </header>

  <EwModal
    v-model:visible="exitConfirmVisible"
    title="确定要离开书房？"
    width="420px"
    :show-close="false"
  >
    <div class="exit-summary">
      <p class="exit-highlight">
        <span>本次码字</span>
        <strong>{{ sessionWordsDisplay }}</strong>
        <span>字</span>
      </p>

      <div class="exit-plan">
        <div class="plan-row">
          <span>今日计划进度</span>
          <strong>{{ planProgressDisplay }}</strong>
        </div>
        <p class="plan-tip">{{ planStatusText }}</p>
      </div>
    </div>
    <template #footer>
      <div class="exit-actions">
        <button type="button" class="ink-btn ink-btn-outline" @click="exitConfirmVisible = false">
          继续创作
        </button>
        <button type="button" class="ink-btn ink-btn-primary" @click="confirmExit">
          <i class="fa-solid fa-right-from-bracket"></i>
          退出书籍
        </button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { countTextWords } from '@/utils/word-count'
const wordCounter = useWordCount()
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { useWritingPlanStore } from '@/stores/writing-plan'
import { storeToRefs } from 'pinia'
import EwModal from '@/components/EwModal/index.vue'

interface Props {
  bookTitle?: string
  bookTags?: string[]
  chapterWords?: number
  totalWords?: number
  textTotalWords?: number | null
  workflowMode?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  bookTitle: '万古神帝',
  bookTags: () => ['长篇', '第一人称', '男频'],
  chapterWords: 0,
  totalWords: 2685,
  textTotalWords: null,
  workflowMode: false
})

const emit = defineEmits<{
  (event: 'request-exit'): void
}>()

const router = useRouter()
const writingStore = useWritingEditorStore()
const planStore = useWritingPlanStore()
const { chapterWordCount, localSessionWords } = storeToRefs(writingStore)
const { planProgress, targetWords, remainingWords } = storeToRefs(planStore)

const exitConfirmVisible = ref(false)

// 书名拉回来之前，标题位一直是「加载中...」这个占位串。直接显示它既丑又像出错了，
// 换成骨架条：位置、高度都占住，加载完原地替换成真书名，不跳版。
const isTitleLoading = computed(() => !props.bookTitle || props.bookTitle === '加载中...')

const displayChapterWords = computed(() => {
  if (wordCounter.mode.value === 'text') return countTextWords(writingStore.activeChapterTextContent)
  if (typeof chapterWordCount.value === 'number') {
    return chapterWordCount.value
  }
  return props.chapterWords ?? 0
})

const sessionWordsDisplay = computed(() =>
  (wordCounter.mode.value === 'text' ? Math.max(0, countTextWords(writingStore.activeChapterTextContent) - writingStore.localSessionBaseTextWordCount) : Math.max(0, localSessionWords.value || 0)).toLocaleString()
)

const planProgressDisplay = computed(() => {
  const value = Number(planProgress.value) || 0
  return `${Math.min(100, Math.max(0, value)).toFixed(0)}%`
})

const planStatusText = computed(() => {
  if (!(targetWords.value || 0)) {
    return '还没有设置今日计划，设定目标更有动力哦。'
  }
  const remaining = remainingWords.value || 0
  if (remaining <= 0) {
    return '今日计划已完成，太棒了！'
  }
  return `距离目标还差 ${remaining.toLocaleString()} 字，继续冲刺吧！`
})

const handleExit = async () => {
  // 工作流自动生成模式下，返回由父页面统一做"是否保存"二次确认
  if (props.workflowMode) {
    emit('request-exit')
    return
  }
  exitConfirmVisible.value = true
  try {
    await planStore.flushReport(true)
    await planStore.fetchSummary()
  } catch (error) {
    console.error('refresh writing plan summary failed', error)
  }
}

const confirmExit = async () => {
  exitConfirmVisible.value = false
  try {
    await planStore.flushReport(true)
  } catch (error) {
    console.error('flush writing plan failed', error)
  }
  router.push('/myBooks')
}
</script>

<style scoped lang="scss">
.writing-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
  z-index: 30;
  // 默认无背景，让背景图完全透过
  background: var(--header-bg, transparent);

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;

    .exit-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: var(--ink-sec);
      font-size: 14px;
      cursor: pointer;
      transition: color 0.3s ease;

      &:hover {
        color: var(--ink-main);
      }
    }

    .divider {
      width: 1px;
      height: 16px;
      background: var(--ink-main);
      opacity: 0.2;
    }

    .book-title {
      font-size: 20px;
      font-weight: bold;
      color: var(--ink-main);
      letter-spacing: 1px;
      margin: 0;
      text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
    }

    // 与 .book-title 同高，避免加载完成时整行高度跳动
    .book-title-skeleton {
      width: 140px;
      height: 20px;
      border-radius: 4px;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, currentColor 10%, transparent) 25%,
        color-mix(in srgb, currentColor 18%, transparent) 37%,
        color-mix(in srgb, currentColor 10%, transparent) 63%
      );
      background-size: 400% 100%;
      animation: ew-skeleton-sweep 1.4s ease infinite;
    }

    @keyframes ew-skeleton-sweep {
      0% {
        background-position: 100% 50%;
      }
      100% {
        background-position: 0 50%;
      }
    }

    .book-tags {
      display: flex;
      gap: 8px;

      .tag {
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 2px;
      }
    }

    .save-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--ink-sec);
      opacity: 0.7;
      font-family: system-ui, sans-serif;

      &:hover {
        opacity: 1;
        color: var(--ink-main);
        cursor: pointer;
      }

      &.saving {
        color: var(--ink-accent);
      }

      &.success {
        color: var(--state-success);
      }

      &.dirty {
        color: var(--state-warning);
      }

      &.saving {
        color: var(--ink-accent);
      }

      &.error {
        color: var(--state-danger);
      }

      .save-icon {
        transition: color 0.2s ease;
      }

      .saving-icon {
        background: linear-gradient(0deg, #7cc5ff 0%, #4f95ff 50%, #b7f0ff 100%);
        background-size: 100% 200%;
        background-clip: text;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: cloudUpload 1.4s linear infinite;
      }

      .pending-icon {
        color: var(--state-warning);
        animation: pendingGlow 1.2s ease-in-out infinite;
      }

      .synced-icon {
        color: var(--state-success);
      }

      .error-icon {
        color: var(--state-danger);
      }

      .muted-icon {
        color: var(--ink-sec);
      }
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 20px;

    .stats-group {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--ink-sec);
      padding-right: 20px;
      border-right: 1px solid var(--ink-main);
      // border-right-opacity: 0.1;
      height: 24px;

      .stat-item {
        display: flex;
        align-items: center;
        gap: 4px;

        i {
          opacity: 0.5;
        }
      }

      .help-icon {
        opacity: 0.5;
        cursor: pointer;
        transition: all 0.3s;

        &:hover {
          opacity: 1;
          color: var(--ink-main);
        }
      }
    }

    .tools-group {
      display: flex;
      align-items: center;
      gap: 16px;

      .tool-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        background: none;
        border: none;
        color: var(--ink-sec);
        font-size: 14px;
        cursor: pointer;
        transition: color 0.3s ease;

        &:hover {
          color: var(--ink-main);
        }
      }
    }

    .action-buttons {
      display: flex;
      gap: 8px;
    }
  }
}

.exit-summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--ink-main);

  .exit-highlight {
    margin: 0;
    font-size: 16px;
    display: flex;
    align-items: baseline;
    gap: 8px;

    strong {
      font-size: 28px;
      font-weight: 700;
      color: var(--ink-accent);
      font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    }
  }

  .exit-plan {
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--panel-bg);
    border: 1px solid var(--ui-border);
    display: flex;
    flex-direction: column;
    gap: 8px;

    .plan-row {
      display: flex;
      justify-content: space-between;
      align-items: center;

      strong {
        font-size: 18px;
        color: var(--ink-accent);
      }
    }

    .plan-tip {
      margin: 0;
      font-size: 13px;
      color: var(--ink-sec);
    }
  }
}

.exit-actions {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@keyframes cloudUpload {
  0% {
    background-position: 0 100%;
  }

  100% {
    background-position: 0 0%;
  }
}

@keyframes pendingGlow {
  0% {
    filter: drop-shadow(0 0 0 rgba(249, 115, 22, 0));
  }

  50% {
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--state-warning) 40%, transparent));
  }

  100% {
    filter: drop-shadow(0 0 0 rgba(249, 115, 22, 0));
  }
}

/* 暗色主题需要额外的 backdrop-filter */
// .theme-dark .writing-header {
//   backdrop-filter: blur(4px);
// }

// .theme-green .writing-header,
// .theme-yellow .writing-header {
//   backdrop-filter: blur(4px);
// }
</style>
