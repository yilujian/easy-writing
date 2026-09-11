<template>
          <div class="progress-card fusion-card">
            <div v-if="progressLoading" class="progress-skeleton">
              <div class="skeleton skeleton-line lg"></div>
              <div class="skeleton skeleton-line sm"></div>
              <div class="skeleton skeleton-bar"></div>
              <div class="skeleton skeleton-line lg"></div>
              <div class="skeleton skeleton-line sm"></div>
              <div class="skeleton skeleton-bar"></div>
              <div class="skeleton skeleton-btn"></div>
            </div>
            <template v-else>
            <div class="progress-block">
              <div class="progress-block-head">
                <span class="progress-block-title"><i class="fa-solid fa-shield-halved"></i> 古法码字进度</span>
                <span class="progress-block-update">{{ progress.manualUpdatedAt }}</span>
              </div>
              <div class="progress-number">
                <span class="progress-current">{{ formatNumber(progress.manual) }}</span>
                <span class="progress-unit">/ {{ formatNumber(progress.manualTarget) }} 字</span>
              </div>
              <div class="progress-block-sub manual">已完成古法码字目标 {{ progress.manual === null ? '—' : `${manualPercent}%` }}</div>
              <div class="progress-track">
                <div class="progress-fill manual" :style="{ width: manualPercent + '%' }"></div>
              </div>
            </div>

            <div class="progress-block">
              <div class="progress-block-head">
                <span class="progress-block-title"><i class="fa-solid fa-robot"></i> AI码字进度</span>
                <span class="progress-block-update">{{ progress.aiUpdatedAt }}</span>
              </div>
              <div class="progress-number">
                <span class="progress-current">{{ formatNumber(progress.ai) }}</span>
                <span class="progress-unit">/ {{ formatNumber(progress.aiTarget) }} 字</span>
              </div>
              <div class="progress-block-sub ai">AI辅助生成占比 {{ aiRatio === null ? '—' : `${aiRatio}%` }}</div>
              <div class="progress-track">
                <div class="progress-fill ai" :style="{ width: aiPercent + '%' }"></div>
              </div>
            </div>

            <div class="progress-notes">
              <span class="note-item success">
                <i class="fa-solid fa-circle-check"></i>
                连续创作 {{ progress.streak }} 天
              </span>
            </div>

            <button class="ink-btn ink-btn-primary progress-action" type="button" @click="handleEnterWritingMode">
              <i class="fa-solid fa-pen-nib"></i>
              进入写作模式
            </button>
            </template>
          </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWordCount } from '@/composables/use-word-count'
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Book } from '@/types'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { getStatsOverview, getStatsStreak } from '@/storage/local-write-stats'
import { getSortedBooks } from '../home-format'

const wordCounter = useWordCount()
const router = useRouter()
const localLibrary = getLocalLibraryStorage()

const progress = ref({
  manual: 0 as number | null,
  manualTarget: 0,
  manualUpdatedAt: '未更新',
  ai: 0 as number | null,
  aiTarget: 0,
  aiUpdatedAt: '未更新',
  streak: 0
})
// 首屏拉取期间显示骨架，避免闪现 0 值
const progressLoading = ref(true)

const manualPercent = computed(() => {
  if (progress.value.manual === null || !progress.value.manualTarget) return 0
  return Math.min(100, Math.round((progress.value.manual / progress.value.manualTarget) * 100))
})
const aiPercent = computed(() => {
  if (progress.value.ai === null || !progress.value.aiTarget) return 0
  return Math.min(100, Math.round((progress.value.ai / progress.value.aiTarget) * 100))
})
// AI辅助生成占比 = AI字数 / 总字数，与进度条(AI/目标)是不同口径
const aiRatio = computed(() => {
  if (progress.value.manual === null || progress.value.ai === null) return null
  const total = progress.value.manual + progress.value.ai
  if (!total) return 0
  return Math.round((progress.value.ai / total) * 100)
})

const formatNumber = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN')

const fetchProgress = () => {
  progressLoading.value = true
  try {
    const overview = getStatsOverview()
    progress.value = {
      manual: overview.manualWords,
      manualTarget: overview.manualTargetWords || 4000,
      manualUpdatedAt: '本地作品',
      ai: overview.aiWords,
      aiTarget: overview.aiTargetWords || 4000,
      aiUpdatedAt: 'AI 产出',
      streak: getStatsStreak()
    }
  } finally {
    progressLoading.value = false
  }
}

watch(wordCounter.mode, fetchProgress)

const goCreateBook = () => {
  router.push({ path: '/myBooks', query: { create: '1' } })
}

const handleEnterWritingMode = async () => {
  try {
    const list = await localLibrary.listLocalBooks({ sortBy: 'updateTime', sortOrder: 'DESC' })
    const recentBook = getSortedBooks(list as Book[])[0]
    if (recentBook?.id) {
      router.push({ name: 'Writing', params: { bookId: recentBook.id } })
      return
    }
    goCreateBook()
  } catch (error) {
    console.error('获取最近作品失败:', error)
  }
}

fetchProgress()
</script>

<style scoped lang="scss">
.progress-card {
  position: relative;
  overflow: hidden;
  padding: 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 15px;
  min-width: 0;
}

.progress-card::after {
  content: '码字';
  position: absolute;
  right: -12px;
  top: -28px;
  font-size: 140px;
  font-family: "Ma Shan Zheng", "Noto Serif SC", "Songti SC", SimSun, serif;
  color: color-mix(in srgb, var(--ink-main) 14%, transparent);
  pointer-events: none;
  user-select: none;
  transform-origin: 70% 40%;
  transition: opacity 0.5s ease, transform 0.8s ease, filter 0.8s ease;
  opacity: 0.35;
}

.progress-card:hover::after {
  opacity: 0.85;
  transform: scale(1.12) rotate(-4deg);
  filter: drop-shadow(0 6px 14px color-mix(in srgb, var(--ink-main) 18%, transparent));
}

.progress-number {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.progress-current {
  font-size: 32px;
  font-weight: 700;
  color: var(--ink-main);
  font-family: "Noto Serif SC", "Songti SC", SimSun, serif;
  line-height: 1.05;
}

.progress-unit {
  font-size: 14px;
  color: var(--ink-sec);
}

.progress-notes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
}

.note-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--btn-ghost-bg);
  border: 1px solid var(--ui-border);
}

.note-item.success {
  color: var(--ink-positive);
}

.progress-track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--divider);
  background: color-mix(in srgb, var(--ink-main) 12%, transparent);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--ink-main), var(--ink-accent));
  border-radius: 999px;
  transition: width 0.4s ease;
}

.progress-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.progress-block-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-main);
}

.progress-block-title i {
  color: var(--ink-sec);
}

.progress-block-update {
  font-size: 12px;
  color: var(--ink-sec);
  margin-left: 12px;
  white-space: nowrap;
}

.progress-block .progress-current {
  font-size: 30px;
}

.progress-block-sub {
  font-size: 12px;
}

.progress-block-sub.manual {
  color: var(--ink-positive);
}

.progress-block-sub.ai {
  color: var(--ink-accent);
}

.progress-block .progress-track {
  flex: none;
  width: 100%;
}

.progress-fill.manual {
  background: var(--ink-positive);
}

.progress-fill.ai {
  background: var(--ink-accent);
}

.progress-action {
  width: 100%;
  height: 40px;
  justify-content: center;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 12px;
  box-shadow: 0 8px 18px rgba(28, 25, 23, 0.15);
}

.progress-action i {
  margin-right: 8px;
}

.skeleton {
  position: relative;
  overflow: hidden;
  background: color-mix(in srgb, var(--ink-main) 8%, transparent);
  border-radius: 8px;
}

.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg,
      transparent,
      color-mix(in srgb, var(--bg-main) 55%, transparent),
      transparent);
  animation: skeletonShimmer 1.4s ease-in-out infinite;
}

@keyframes skeletonShimmer {
  100% {
    transform: translateX(100%);
  }
}

.progress-skeleton {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0;
}

.progress-skeleton .skeleton-line {
  height: 14px;
}

.progress-skeleton .skeleton-line.lg {
  width: 58%;
  height: 26px;
}

.progress-skeleton .skeleton-line.sm {
  width: 40%;
}

.progress-skeleton .skeleton-bar {
  height: 6px;
  border-radius: 999px;
}

.progress-skeleton .skeleton-btn {
  height: 40px;
  border-radius: 8px;
  margin-top: 4px;
}

@media (max-width: 720px) {
  .progress-action {
    width: 100%;
    justify-content: center;
  }
}

@media (max-width: 540px) {
  .progress-card {
    padding: 18px;
  }
}
</style>
