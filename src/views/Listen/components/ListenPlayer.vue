<template>
  <footer class="listen-player">
    <div class="player-progress-row">
      <span class="player-time player-state" role="status" aria-live="polite">{{ playbackStatusLabel }}</span>
      <input
        class="listen-range"
        type="range"
        min="0"
        :max="Math.max(0, store.totalSegments - 1)"
        step="1"
        :value="store.segmentIndex"
        :disabled="!store.script?.segments.length || store.status === 'loading'"
        aria-label="章节内朗读进度"
        :aria-valuenow="store.totalSegments ? store.segmentIndex : 0"
        :aria-valuetext="progressAriaLabel"
        @change="handleSeek"
      />
      <span class="player-time">{{
        store.totalSegments ? `${store.segmentIndex + 1} / ${store.totalSegments}` : '—'
      }}</span>
    </div>

    <div class="player-main">
      <div class="player-chapter">
        <button type="button" class="player-text-btn" title="打开章节目录" @click="emit('open-chapters')">
          <i class="fa-solid fa-list-ul"></i>
          <span>{{ store.currentChapter?.title || '选择章节' }}</span>
        </button>
        <small>{{ volumeLabel }}</small>
      </div>

      <div class="player-controls" role="group" aria-label="播放控制">
        <button
          type="button"
          class="player-icon-btn"
          title="上一章"
          aria-label="上一章"
          :disabled="!store.canPrevChapter || store.status === 'loading'"
          @click="store.prevChapter()"
        >
          <i class="fa-solid fa-backward-fast"></i>
        </button>
        <button
          type="button"
          class="player-icon-btn"
          title="上一句"
          aria-label="上一句"
          aria-keyshortcuts="ArrowLeft"
          :disabled="!store.canPrevSegment || store.status === 'loading'"
          @click="store.prevSegment()"
        >
          <i class="fa-solid fa-backward-step"></i>
        </button>
        <button
          type="button"
          class="player-play-btn"
          :title="store.isPlaying ? '暂停' : '播放'"
          :aria-label="store.isPlaying ? '暂停' : '播放'"
          aria-keyshortcuts="Space"
          :disabled="store.status === 'loading' || store.status === 'empty' || !store.hasSession"
          @click="store.toggle()"
        >
          <i v-if="store.status === 'loading'" class="fa-solid fa-spinner fa-spin"></i>
          <i v-else-if="store.status === 'buffering'" class="fa-solid fa-circle-notch fa-spin"></i>
          <i v-else :class="store.isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play'"></i>
        </button>
        <button
          type="button"
          class="player-icon-btn"
          title="下一句"
          aria-label="下一句"
          aria-keyshortcuts="ArrowRight"
          :disabled="!store.canNextSegment || store.status === 'loading'"
          @click="store.nextSegment()"
        >
          <i class="fa-solid fa-forward-step"></i>
        </button>
        <button
          type="button"
          class="player-icon-btn"
          title="下一章"
          aria-label="下一章"
          :disabled="!store.canNextChapter || store.status === 'loading'"
          @click="store.nextChapter()"
        >
          <i class="fa-solid fa-forward-fast"></i>
        </button>
      </div>

      <div class="player-tools">
        <div class="player-tool" title="语速">
          <el-select :model-value="store.settings.rate" class="player-rate-select" size="small" aria-label="语速" popper-class="ink-select-popper" @change="handleRate">
            <template #prefix><i class="fa-solid fa-gauge-high" aria-hidden="true"></i></template>
            <el-option v-for="rate in rateOptions" :key="rate" :value="rate" :label="`${formatRate(rate)}x`" />
          </el-select>
        </div>
        <button
          type="button"
          class="player-icon-btn"
          title="音色与朗读设置"
          aria-label="音色与朗读设置"
          @click="emit('open-voice')"
        >
          <i class="fa-solid fa-microphone-lines"></i>
        </button>
        <div class="player-tool" title="睡眠定时">
          <el-select :model-value="store.sleepMode" class="player-sleep-select" size="small" aria-label="睡眠定时" popper-class="ink-select-popper" @change="handleSleep">
            <template #prefix><i class="fa-solid fa-moon" aria-hidden="true"></i></template>
            <el-option v-for="option in sleepOptions" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </div>
      </div>
    </div>

    <div class="player-footer">
      <span>{{ store.book?.title || '听书' }}</span>
      <span v-if="store.sleepRemainingMs > 0">定时剩余 {{ sleepRemainingLabel }}</span>
      <span v-else-if="store.sleepMode === 'chapter'">本章结束后暂停</span>
      <span class="player-book-progress">
        本章 {{ Math.round(store.chapterProgress * 100) }}% · 全书 {{ Math.round(store.bookProgress * 100) }}%
      </span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { LISTEN_RATE_OPTIONS, LISTEN_SLEEP_OPTIONS } from '@/config/listening'
import { useListeningStore } from '@/stores/listening'
import type { SleepTimerMode } from '@/types/listening'

const emit = defineEmits<{
  (event: 'open-chapters'): void
  (event: 'open-voice'): void
}>()

const store = useListeningStore()
const rateOptions = computed(() =>
  [...new Set([...LISTEN_RATE_OPTIONS, store.settings.rate])].sort((left, right) => left - right)
)
const sleepOptions = LISTEN_SLEEP_OPTIONS
const formatRate = (rate: number) => String(Number(rate.toFixed(2)))

const playbackStatusLabel = computed(() => {
  if (store.status === 'loading') return '加载中'
  if (store.status === 'buffering') return store.chapterFinished ? '准备下一章' : '准备语音'
  if (store.status === 'playing') return '正在朗读'
  if (store.status === 'error') return '播放出错'
  if (store.status === 'empty') return '暂无正文'
  if (store.status === 'ended') return '全书听完'
  if (store.chapterFinished) return '本章听完'
  return store.script ? '已暂停' : '未开始'
})

const progressAriaLabel = computed(() =>
  store.totalSegments
    ? `第 ${store.segmentIndex + 1} 句，共 ${store.totalSegments} 句，章节进度 ${Math.round(store.chapterProgress * 100)}%`
    : '暂无可朗读正文'
)

const volumeLabel = computed(() => store.currentChapter?.volumeTitle || '')

const sleepRemainingLabel = computed(() => {
  const total = Math.max(0, Math.round(store.sleepRemainingMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
})

const handleSeek = (event: Event) => {
  store.seekSegment(Number((event.target as HTMLInputElement).value))
}

const handleRate = (value: unknown) => {
  store.updateSettings({ rate: Number(value) })
}

const handleSleep = (value: unknown) => {
  if (sleepOptions.some(option => option.value === value)) store.setSleepTimer(value as SleepTimerMode)
}
</script>

<style scoped lang="scss">
.listen-player {
  position: relative;
  z-index: 3;
  padding: 10px clamp(18px, 3vw, 34px) 14px;
  border-top: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
  background: color-mix(in srgb, var(--surface-1) 90%, transparent);
  backdrop-filter: blur(14px);
  color: var(--ink-main);
}

.player-progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.player-time {
  min-width: 42px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: center;

  &.player-state {
    min-width: 70px;
    text-align: left;
  }
}

.listen-range {
  flex: 1;
  height: 4px;
  accent-color: var(--ink-accent);
  cursor: pointer;

  &:disabled {
    cursor: default;
    opacity: 0.4;
  }
}

.player-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 18px;
  margin-top: 4px;
}

.player-chapter {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  small {
    color: var(--ink-sec);
    font-size: calc(11px * var(--ui-font-scale, 1));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.player-text-btn {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  font: inherit;
  text-align: left;

  i {
    color: var(--listen-accent-text);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover span {
    color: var(--listen-accent-text);
  }
}

.player-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.player-icon-btn {
  width: 40px;
  height: 40px;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 160ms ease,
    color 160ms ease;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
    color: var(--listen-accent-text);
  }

  &:focus-visible {
    outline: 2px solid var(--ink-accent);
    outline-offset: 2px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.4;
  }
}

.player-play-btn {
  width: 52px;
  height: 52px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 36%, transparent);
  border-radius: 50%;
  background: var(--ink-accent);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(18px * var(--ui-font-scale, 1));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--ink-accent) 26%, transparent);
  transition:
    transform 160ms ease,
    box-shadow 160ms ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--ink-accent) 32%, transparent);
  }

  &:focus-visible {
    outline: 2px solid var(--ink-main);
    outline-offset: 3px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.7;
  }
}

.player-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.player-tool {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  i { font-size: calc(11px * var(--ui-font-scale, 1)); }
  .player-rate-select { width: calc(100px * var(--ui-font-scale, 1)); }
  .player-sleep-select { width: calc(138px * var(--ui-font-scale, 1)); }
}

.player-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 2px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));

  .player-book-progress {
    margin-left: auto;
  }
}

@media (max-width: 760px) {
  .player-main {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'chapter tools'
      'controls controls';
    row-gap: 6px;
  }

  .player-chapter {
    grid-area: chapter;
  }
  .player-controls {
    grid-area: controls;
    justify-content: center;
  }
  .player-tools {
    grid-area: tools;
  }
  .player-footer {
    display: none;
  }

}
@media (max-width: 480px) {
  .listen-player {
    padding: 8px 10px 10px;
  }

  .player-progress-row {
    gap: 7px;
  }

  .player-time.player-state {
    min-width: 62px;
  }

  .player-main {
    grid-template-columns: 1fr;
    grid-template-areas:
      'chapter'
      'controls'
      'tools';
  }

  .player-chapter {
    align-items: center;
  }

  .player-text-btn {
    max-width: 100%;
  }

  .player-tools {
    justify-content: center;
    flex-wrap: wrap;
  }

  .player-controls {
    gap: 5px;
  }
}
</style>
