<template>
  <div ref="scrollRef" class="listen-transcript" aria-label="朗读正文">
    <article v-if="script" class="listen-transcript-inner">
      <header class="transcript-head">
        <p class="transcript-eyebrow" role="status" aria-live="polite">{{ eyebrow }}</p>
        <h2
          :ref="element => titleSegment && setSegmentRef(titleSegment.index, element)"
          :class="{ 'is-active': titleSegment?.index === segmentIndex }"
          :role="titleSegment ? 'button' : undefined"
          :tabindex="titleSegment?.index === segmentIndex ? 0 : -1"
          :aria-current="titleSegment?.index === segmentIndex ? 'true' : undefined"
          :title="titleSegment ? '从章节标题开始播放' : undefined"
          @click="titleSegment && emit('seek', titleSegment.index)"
          @keydown.enter.prevent="titleSegment && emit('seek', titleSegment.index)"
          @keydown.space.prevent="titleSegment && emit('seek', titleSegment.index)"
          @keydown.down.prevent.stop="focusSegment((titleSegment?.index || 0) + 1)"
        >
          {{ script.title || '未命名章节' }}
        </h2>
      </header>
      <p v-for="(paragraph, paragraphIndex) in paragraphs" :key="paragraphIndex" class="transcript-paragraph">
        <span
          v-for="segment in paragraph"
          :key="segment.index"
          :ref="element => setSegmentRef(segment.index, element)"
          class="listen-sentence"
          :class="{
            'is-active': segment.index === segmentIndex,
            'is-read': segment.index < segmentIndex
          }"
          role="button"
          :tabindex="segment.index === segmentIndex ? 0 : -1"
          :aria-current="segment.index === segmentIndex ? 'true' : undefined"
          :title="`从这一句开始播放：${segment.displayText.slice(0, 24)}${segment.displayText.length > 24 ? '…' : ''}`"
          @click="emit('seek', segment.index)"
          @keydown.enter.prevent="emit('seek', segment.index)"
          @keydown.space.prevent="emit('seek', segment.index)"
          @keydown.up.prevent.stop="focusSegment(segment.index - 1)"
          @keydown.down.prevent.stop="focusSegment(segment.index + 1)"
          @keydown.home.prevent.stop="focusSegment(0)"
          @keydown.end.prevent.stop="focusSegment((script?.segments.length || 1) - 1)"
          >{{ segment.displayText }}</span
        >
      </p>
    </article>
    <div v-else class="transcript-placeholder" aria-hidden="true">
      <span></span><span></span><span></span><span></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, ref, watch } from 'vue'
import type { ChapterScript, ListenStatus, SpeechSegment } from '@/types/listening'

const props = defineProps<{
  script: ChapterScript | null
  segmentIndex: number
  status: ListenStatus
  chapterFinished?: boolean
}>()

const emit = defineEmits<{
  (event: 'seek', index: number): void
}>()

const scrollRef = ref<HTMLElement | null>(null)
const segmentRefs = new Map<number, HTMLElement>()

onBeforeUpdate(() => {
  segmentRefs.clear()
})

const setSegmentRef = (index: number, element: unknown) => {
  if (element instanceof HTMLElement) segmentRefs.set(index, element)
  else segmentRefs.delete(index)
}

const titleSegment = computed(() => {
  const first = props.script?.segments[0]
  return first?.kind === 'title' ? first : null
})

const eyebrow = computed(() => {
  if (props.chapterFinished) return '本章已听完 · 播放将继续下一章'
  if (props.status === 'playing' || props.status === 'buffering') return '正在朗读'
  if (props.status === 'paused') return '已暂停 · 点击句子可从那里继续'
  return '准备朗读'
})

const paragraphs = computed(() => {
  const map = new Map<number, SpeechSegment[]>()
  for (const segment of props.script?.segments || []) {
    if (segment.kind === 'title') continue
    const list = map.get(segment.paragraphIndex) || []
    list.push(segment)
    map.set(segment.paragraphIndex, list)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list)
})

const focusSegment = async (index: number) => {
  const total = props.script?.segments.length || 0
  if (!total) return
  const target = Math.min(total - 1, Math.max(0, index))
  await nextTick()
  const element = segmentRefs.get(target)
  element?.focus()
  element?.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  })
}

const scrollToActive = async () => {
  await nextTick()
  const element = segmentRefs.get(props.segmentIndex)
  if (!element) return
  element.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  })
}

watch(
  () => props.segmentIndex,
  () => {
    if (props.script) void scrollToActive()
  }
)

watch(
  () => props.script?.chapterId,
  () => {
    if (scrollRef.value) scrollRef.value.scrollTop = 0
  }
)
</script>

<style scoped lang="scss">
.listen-transcript {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(22px, 4vw, 56px) clamp(20px, 5vw, 72px) 128px;
  scroll-behavior: smooth;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink-main) 20%, transparent) transparent;
}

.listen-transcript-inner {
  width: min(760px, 100%);
  margin: 0 auto;
}

.transcript-head {
  margin-bottom: 26px;
  padding-bottom: 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);

  h2 {
    margin: 4px 0 0;
    color: var(--ink-main);
    font-family: 'Noto Serif SC', 'Songti SC', serif;
    font-size: clamp(24px, 3vw, 34px);
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: 0.02em;
    transition:
      background-color 180ms ease,
      box-shadow 180ms ease;
    border-radius: 4px;

    &[role='button'] {
      cursor: pointer;
    }

    &:focus-visible {
      outline: 2px solid var(--ink-accent);
      outline-offset: 3px;
    }

    &.is-active {
      background: color-mix(in srgb, var(--ink-accent) 14%, transparent);
      box-shadow: inset 3px 0 0 var(--ink-accent);
    }
  }
}

.transcript-eyebrow {
  margin: 0;
  color: var(--listen-accent-text);
  font-size: 12px;
  letter-spacing: 0.18em;
}

.transcript-paragraph {
  margin: 0 0 1.15em;
  color: var(--ink-main);
  font-family: 'LXGW WenKai', 'Noto Serif SC', 'Songti SC', serif;
  font-size: clamp(18px, 1.55vw, 22px);
  line-height: 2;
  text-align: justify;
  text-indent: 2em;
}

.listen-sentence {
  border-radius: 4px;
  padding: 2px 1px;
  cursor: pointer;
  transition:
    background-color 180ms ease,
    color 180ms ease,
    box-shadow 180ms ease;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  }

  &:focus-visible {
    outline: 2px solid var(--ink-accent);
    outline-offset: 2px;
  }

  &.is-read {
    color: color-mix(in srgb, var(--ink-main) 62%, transparent);
  }

  &.is-active {
    background: color-mix(in srgb, var(--ink-accent) 16%, transparent);
    box-shadow: inset 3px 0 0 var(--ink-accent);
    color: var(--ink-main);
  }
}

.transcript-placeholder {
  width: min(760px, 100%);
  margin: 32px auto 0;
  display: grid;
  gap: 16px;

  span {
    display: block;
    height: 18px;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--ink-main) 8%, transparent),
      color-mix(in srgb, var(--ink-main) 3%, transparent)
    );
    animation: listen-placeholder 1.4s ease-in-out infinite alternate;

    &:nth-child(2) {
      width: 88%;
    }
    &:nth-child(3) {
      width: 94%;
    }
    &:nth-child(4) {
      width: 62%;
    }
  }
}

@keyframes listen-placeholder {
  from {
    opacity: 0.55;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .listen-transcript {
    scroll-behavior: auto;
  }
  .transcript-placeholder span {
    animation: none;
  }
}
</style>
