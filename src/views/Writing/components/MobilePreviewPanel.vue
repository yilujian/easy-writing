<template>
  <div class="panel-content mobile-preview-panel">
    <div class="panel-header">
      <div class="panel-title">
        <span>{{ title }}</span>
        <small>{{ sizeText }}</small>
      </div>
      <div class="panel-actions">
        <i class="fa-solid fa-xmark action-icon" @click="$emit('close')"></i>
      </div>
    </div>

    <div class="preview-body">
      <div class="preview-stack">
        <div class="preview-stage">
          <div class="phone-shell" :style="phoneStyle">
            <div class="phone-screen" :class="`screen-${previewScreenType}`" :style="screenStyle">
              <div class="screen-cutout" :class="previewScreenType"></div>
              <div class="mobile-status">
                <span>{{ currentTime }}</span>
                <div class="status-icons">
                  <i class="fa-solid fa-signal"></i>
                  <i class="fa-solid fa-battery-three-quarters"></i>
                </div>
              </div>

              <div ref="scrollRef" class="reader-scroll" :style="readerStyle" @scroll="handlePreviewScroll">
                <template v-if="activeChapterId">
                  <h1>{{ activeChapterTitle || '未命名章节' }}</h1>
                  <div v-if="paragraphs.length" class="reader-content">
                    <p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p>
                  </div>
                  <div v-else class="preview-empty">
                    <i class="fa-regular fa-note-sticky"></i>
                    <span>当前章节暂无正文</span>
                  </div>
                </template>
                <div v-else class="preview-empty">
                  <i class="fa-regular fa-note-sticky"></i>
                  <span>请选择章节开始预览</span>
                </div>
              </div>

              <div class="reader-footer">
                <span>{{ chapterWordCount.toLocaleString() }} 字</span>
                <span>{{ scrollProgress }}%</span>
              </div>
            </div>
          </div>
        </div>

        <div class="preview-controls">
          <div class="display-row">
            <span>屏幕形态</span>
            <div class="screen-type-row">
              <button
                v-for="item in screenTypeOptions"
                :key="item.value"
                type="button"
                :class="{ active: previewScreenType === item.value }"
                @click="previewScreenType = item.value"
              >
                <i :class="item.icon"></i>
                {{ item.label }}
              </button>
            </div>
          </div>
          <div class="size-row">
            <span>手机宽度</span>
            <strong>{{ sizeText }}</strong>
          </div>
          <el-slider
            v-model="previewWidth"
            :min="WRITING_MOBILE_PREVIEW_MIN_WIDTH"
            :max="WRITING_MOBILE_PREVIEW_MAX_WIDTH"
            :step="5"
            :show-tooltip="false"
            class="preview-slider"
          />
          <div class="preset-row">
            <button
              v-for="item in presetWidths"
              :key="item"
              type="button"
              :class="{ active: previewWidth === item }"
              @click="previewWidth = item"
            >
              {{ item }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { MobilePreviewScreenType } from '@/stores/writing-editor'
import {
  useWritingEditorStore,
  WRITING_MOBILE_PREVIEW_MAX_WIDTH,
  WRITING_MOBILE_PREVIEW_MIN_WIDTH
} from '@/stores/writing-editor'

defineProps<{
  title: string
}>()

defineEmits<{
  (e: 'close'): void
}>()

const store = useWritingEditorStore()
const {
  activeChapterId,
  activeChapterTitle,
  activeChapterTextContent,
  chapterWordCount,
  mobilePreviewWidth,
  mobilePreviewScreenType,
  fontFamily,
  fontSize,
  fontBold,
  fontColor,
  fontLineHeight,
  writingScrollRatio,
  writingScrollSource
} = storeToRefs(store)

const screenTypeOptions: Array<{ value: MobilePreviewScreenType; label: string; icon: string }> = [
  { value: 'notch', label: '刘海屏', icon: 'fa-solid fa-grip-lines' },
  { value: 'island', label: '灵动岛', icon: 'fa-solid fa-minus' },
  { value: 'hole', label: '挖孔屏', icon: 'fa-solid fa-circle-dot' }
]
const presetWidths = [320, 375, 390, 430]
const scrollRef = ref<HTMLElement | null>(null)
const scrollProgress = ref(0)
const currentTime = ref('')
let timeTimer = 0
// 程序同步滚动时忽略自身 scroll 事件，避免双向同步回环。
let isApplyingPreviewScroll = false

const previewWidth = computed({
  get: () => mobilePreviewWidth.value,
  set: (value: number) => store.setMobilePreviewWidth(value)
})

const previewScreenType = computed({
  get: () => mobilePreviewScreenType.value,
  set: (value: MobilePreviewScreenType) => store.setMobilePreviewScreenType(value)
})

const sizeText = computed(() => `${previewWidth.value}px / ${previewWidth.value * 2}稿`)
const phoneStyle = computed(() => ({
  width: `${previewWidth.value + 18}px`,
  // 按常见 375x812 阅读屏比例计算机身高度。
  height: `${Math.round(previewWidth.value * (812 / 375) + 18)}px`
}))
const screenStyle = computed(() => ({ width: `${previewWidth.value}px` }))
// 阅读正文与编辑器共用字体设置；状态栏、页脚及手机外框保留自身样式。
const readerStyle = computed(() => ({
  fontFamily: fontFamily.value,
  fontSize: `${fontSize.value}px`,
  fontWeight: fontBold.value ? '700' : '400',
  color: fontColor.value || 'var(--preview-reader-text)',
  lineHeight: String(fontLineHeight.value)
}))
const paragraphs = computed(() =>
  activeChapterTextContent.value
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
)

const updateCurrentTime = () => {
  const date = new Date()
  currentTime.value = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const scheduleTimeUpdate = () => {
  updateCurrentTime()
  const now = new Date()
  // 对齐系统分钟边界，保证状态栏只显示真实时分。
  timeTimer = window.setTimeout(scheduleTimeUpdate, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()))
}

const updateScrollProgress = () => {
  const el = scrollRef.value
  if (!el || el.scrollHeight <= el.clientHeight) {
    scrollProgress.value = 0
    return
  }
  scrollProgress.value = Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100)
}

const getScrollRatio = (el: HTMLElement) => {
  const maxScrollTop = el.scrollHeight - el.clientHeight
  return maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 0
}

const handlePreviewScroll = () => {
  const el = scrollRef.value
  updateScrollProgress()
  if (!el || isApplyingPreviewScroll) return
  store.setWritingScrollRatio(getScrollRatio(el), 'preview')
}

const syncPreviewScroll = () => {
  const el = scrollRef.value
  if (!el || writingScrollSource.value === 'preview') return
  const maxScrollTop = el.scrollHeight - el.clientHeight
  isApplyingPreviewScroll = true
  el.scrollTop = maxScrollTop > 0 ? maxScrollTop * writingScrollRatio.value : 0
  updateScrollProgress()
  window.setTimeout(() => {
    isApplyingPreviewScroll = false
  }, 80)
}

const schedulePreviewLayout = () => {
  requestAnimationFrame(() => {
    syncPreviewScroll()
    updateScrollProgress()
  })
}

watch([activeChapterId, activeChapterTextContent, previewWidth, readerStyle], schedulePreviewLayout, { flush: 'post' })

watch([writingScrollRatio, writingScrollSource], () => {
  requestAnimationFrame(syncPreviewScroll)
})

onMounted(() => {
  scheduleTimeUpdate()
  schedulePreviewLayout()
  // 内置/导入字体加载完成后会重新排版，需要同步更新阅读进度。
  void document.fonts?.ready.then(schedulePreviewLayout)
  document.fonts?.addEventListener('loadingdone', schedulePreviewLayout)
})

onBeforeUnmount(() => {
  window.clearTimeout(timeTimer)
  document.fonts?.removeEventListener('loadingdone', schedulePreviewLayout)
})
</script>

<style scoped lang="scss">
.mobile-preview-panel {
  --preview-phone-frame: #22242b;
  --preview-phone-shadow: 0 18px 46px rgba(0, 0, 0, 0.22);
  --preview-cutout-bg: #17181d;
  --preview-reader-bg: color-mix(in srgb, var(--bg-main) 86%, #ffffff);
  --preview-reader-title: var(--ink-main);
  --preview-reader-text: var(--ink-main);
  --preview-reader-muted: var(--ink-sec);
  --preview-reader-footer-border: color-mix(in srgb, var(--ink-main) 8%, transparent);
  width: 100%;
  height: calc(100vh - var(--desktop-titlebar-height, 0px) - 56px);
  max-height: calc(100vh - var(--desktop-titlebar-height, 0px) - 56px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  color: var(--ink-main);
  background: var(--panel-bg);

}

:global(.theme-dark .mobile-preview-panel) {
  --preview-phone-frame: #0f1116;
  --preview-phone-shadow: 0 18px 52px rgba(0, 0, 0, 0.5);
  --preview-cutout-bg: #050506;
  --preview-reader-bg: color-mix(in srgb, var(--bg-main) 84%, #0f1116);
  --preview-reader-footer-border: rgba(255, 255, 255, 0.08);
}

.preview-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 24px 0 32px;

  &::-webkit-scrollbar {
    display: none;
  }
}

.preview-stack {
  width: 100%;
  flex: 0 0 auto;
}

.panel-header {
  height: 52px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--panel-header-bg);
}

.panel-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;

  small {
    color: var(--ink-sec);
    font-size: 11px;
    font-weight: 400;
  }
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--ink-sec);

  .action-icon {
    cursor: pointer;
    transition: color 0.2s ease;

    &:hover {
      color: var(--ink-main);
    }
  }
}

.preview-controls {
  flex: 0 0 auto;
  padding: 14px 16px 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--panel-bg);
}

.display-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  color: var(--ink-sec);
  font-size: 12px;

  > span {
    flex: 0 0 56px;
  }
}

.screen-type-row {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;

  button {
    height: 30px;
    border: 1px solid var(--input-border);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--ink-sec);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;

    i {
      margin-right: 5px;
      font-size: 11px;
    }

    &:hover,
    &.active {
      color: var(--ink-main);
      border-color: var(--ink-accent);
      background: var(--nav-active-bg);
    }
  }
}

.size-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--ink-sec);
  font-size: 12px;

  strong {
    color: var(--ink-main);
    font-size: 13px;
    font-weight: 600;
  }
}

.preview-slider {
  --el-slider-main-bg-color: var(--ink-accent);
  --el-slider-runway-bg-color: var(--ui-border);
  margin: 0;
}

.preset-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;

  button {
    height: 28px;
    border: 1px solid var(--input-border);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--ink-sec);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;

    &:hover,
    &.active {
      color: var(--ink-main);
      border-color: var(--ink-accent);
      background: var(--nav-active-bg);
    }
  }
}

.preview-stage {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  overflow: visible;
  padding: 22px 20px 16px;
  background:
    radial-gradient(circle at top, color-mix(in srgb, var(--ink-accent) 8%, transparent), transparent 34%),
    var(--panel-bg);
}

.phone-shell {
  flex: 0 0 auto;
  padding: 9px;
  border-radius: 34px;
  background: var(--preview-phone-frame);
  box-shadow: var(--preview-phone-shadow);
  position: relative;
}

.screen-cutout {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  background: var(--preview-cutout-bg);
  z-index: 3;

  &.notch {
    top: 0;
    width: 118px;
    height: 28px;
    border-radius: 0 0 18px 18px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08);

    &::before {
      content: '';
      position: absolute;
      left: 50%;
      bottom: 9px;
      width: 38px;
      height: 4px;
      transform: translateX(-50%);
      border-radius: 999px;
      background: #3b3d45;
    }

    &::after {
      content: '';
      position: absolute;
      right: 22px;
      bottom: 7px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #242833;
      box-shadow: inset 0 0 0 2px #111318;
    }
  }

  &.island {
    top: 10px;
    width: 92px;
    height: 26px;
    border-radius: 999px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08);

    &::before {
      content: '';
      position: absolute;
      left: 15px;
      top: 8px;
      width: 43px;
      height: 4px;
      border-radius: 999px;
      background: #2d3038;
    }

    &::after {
      content: '';
      position: absolute;
      right: 14px;
      top: 7px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #262b38;
      box-shadow: inset 0 0 0 2px #0f1116;
    }
  }

  &.hole {
    top: 10px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.35),
      0 0 0 1px rgba(255, 255, 255, 0.14),
      inset 0 0 0 4px #0f1116;

    &::before {
      content: '';
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      background: #252b38;
    }

    &::after {
      content: '';
      position: absolute;
      top: 4px;
      left: 5px;
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.18);
    }
  }
}

.phone-screen {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 27px;
  background: var(--preview-reader-bg);
  color: var(--preview-reader-text);
}

.mobile-status,
.reader-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--preview-reader-muted);
  font-size: 11px;
}

.mobile-status {
  height: 34px;
  padding: 0 18px;
}

.screen-notch {
  .mobile-status {
    height: 36px;
    padding: 0 22px;
  }
}

.screen-island {
  .mobile-status {
    height: 40px;
    padding: 0 20px;
  }
}

.screen-hole {
  .mobile-status {
    height: 38px;
    padding: 0 20px;
  }
}

.status-icons {
  display: flex;
  align-items: center;
  gap: 6px;
}

.reader-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 26px 18px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  h1 {
    margin: 0 0 24px;
    color: inherit;
    font-size: 21px;
    line-height: 1.35;
    font-weight: 700;
  }
}

.reader-content {
  p {
    margin: 0 0 18px;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
    text-indent: 2em;
    letter-spacing: 0;
    word-break: break-word;
  }
}

.preview-empty {
  height: 100%;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--preview-reader-muted);
  font-size: 13px;

  i {
    font-size: 24px;
  }
}

.reader-footer {
  height: 34px;
  padding: 0 18px;
  border-top: 1px solid var(--preview-reader-footer-border);
}
</style>
