<template>
  <div class="listen-page" :class="{ 'is-focus': focusMode }">
    <div class="listen-bg" aria-hidden="true">
      <img :src="themeStore.currentSkinObj.img" alt="" @error="hideBrokenBackground" />
      <span class="listen-bg-wash"></span>
    </div>

    <header class="listen-header">
      <button type="button" class="listen-back" title="返回书架" @click="goBack">
        <i class="fa-solid fa-chevron-left"></i>
        <span>书架</span>
      </button>

      <div class="listen-book-head">
        <div class="listen-book-cover">
          <img
            v-if="store.book?.coverUrl && !coverBroken"
            :src="store.book.coverUrl"
            alt=""
            @error="hideBrokenCover"
          />
          <span v-else>{{ (store.book?.title || '书').slice(0, 1) }}</span>
        </div>
        <div class="listen-book-copy">
          <h1>{{ store.book?.title || '听书' }}</h1>
          <p>
            {{ store.currentChapter?.volumeTitle || '本地作品' }}
            <span v-if="store.currentChapter">· 第 {{ store.chapterIndex + 1 }} 章</span>
          </p>
        </div>
      </div>

      <div class="listen-header-actions">
        <span v-if="store.isPlaying" class="listen-live" aria-label="正在播放">
          <i class="fa-solid fa-wave-square"></i>
          播放中
        </span>
        <button
          type="button"
          class="listen-header-btn"
          title="进入专注模式"
          aria-label="进入专注模式"
          @click="focusMode = !focusMode"
        >
          <i :class="focusMode ? 'fa-solid fa-compress' : 'fa-solid fa-expand'"></i>
        </button>
        <button
          type="button"
          class="listen-header-btn"
          title="打开朗读设置"
          aria-label="打开朗读设置"
          @click="openPanel('voice')"
        >
          <i class="fa-solid fa-sliders"></i>
        </button>
        <button type="button" class="listen-header-btn with-text" title="回到写作页" @click="goWriting">
          <i class="fa-solid fa-pen-nib"></i>
          去写作
        </button>
      </div>
    </header>

    <button
      v-if="focusMode"
      type="button"
      class="listen-focus-exit"
      title="退出专注模式"
      aria-label="退出专注模式"
      @click="focusMode = false"
    >
      <i class="fa-solid fa-compress"></i>
    </button>

    <div
      v-if="store.script?.segments.length && !store.engineAvailable && !store.voicesLoading"
      class="listen-engine-warning"
      role="status"
    >
      <i class="fa-solid fa-triangle-exclamation"></i>
      <span>{{ engineWarning }}</span>
      <button type="button" @click="openPanel('voice')">去设置</button>
    </div>

    <main class="listen-main">
      <div
        v-if="store.status === 'loading' && !store.script"
        class="listen-status-card"
        role="status"
        aria-busy="true"
      >
        <i class="fa-solid fa-spinner fa-spin"></i>
        <strong>正在准备这一章…</strong>
        <span>读取正文、切分句子，马上开始</span>
      </div>

      <div v-else-if="store.status === 'error'" class="listen-status-card is-error" role="alert">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <strong>这一章暂时听不了</strong>
        <span>{{ store.error || '朗读服务没有返回结果' }}</span>
        <div class="status-actions">
          <button type="button" class="ink-btn ink-btn-primary" @click="retry">重试</button>
          <button type="button" class="ink-btn ink-btn-outline" @click="openPanel('chapters')">换一章</button>
        </div>
      </div>

      <div v-else-if="store.status === 'empty'" class="listen-status-card" role="status">
        <i class="fa-regular fa-file-lines"></i>
        <strong>{{ emptyStateTitle }}</strong>
        <span>{{ emptyStateMessage }}</span>
        <div class="status-actions">
          <button
            v-if="store.canNextChapter"
            type="button"
            class="ink-btn ink-btn-primary"
            @click="store.nextChapter()"
          >
            下一章
          </button>
          <button type="button" class="ink-btn ink-btn-outline" @click="openPanel('chapters')">
            打开目录
          </button>
        </div>
      </div>

      <ListenTranscript
        v-else
        :script="store.script"
        :segment-index="store.segmentIndex"
        :status="store.status"
        :chapter-finished="store.chapterFinished"
        @seek="handleSeek"
      />

      <div
        v-if="store.chapterFinished && store.status === 'paused'"
        class="listen-ended is-chapter"
        role="status"
      >
        <i class="fa-solid fa-circle-check"></i>
        <div>
          <strong>本章听完</strong>
          <span>点击继续，将从下一章开头播放。</span>
        </div>
        <button type="button" class="ink-btn ink-btn-outline" @click="store.play()">继续下一章</button>
      </div>

      <div v-if="store.status === 'ended'" class="listen-ended" role="status">
        <i class="fa-solid fa-feather-pointed"></i>
        <div>
          <strong>全书听完</strong>
          <span>已到最后一章的最后一句。</span>
        </div>
        <button type="button" class="ink-btn ink-btn-outline" @click="restartBook">重听第一章</button>
      </div>
    </main>

    <ListenPlayer @open-chapters="openPanel('chapters')" @open-voice="openPanel('voice')" />

    <ListenSidePanel :open="sidePanelOpen" :initial-tab="sidePanelTab" @close="sidePanelOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import { useListeningStore } from '@/stores/listening'
import ListenPlayer from './components/ListenPlayer.vue'
import ListenTranscript from './components/ListenTranscript.vue'
import ListenSidePanel from './components/ListenSidePanel.vue'

const route = useRoute()
const router = useRouter()
const themeStore = useThemeStore()
const store = useListeningStore()

const focusMode = ref(false)
const coverBroken = ref(false)
const sidePanelOpen = ref(false)
const sidePanelTab = ref<'chapters' | 'voice'>('chapters')

const engineWarning = computed(() => {
  if (store.settings.engine === 'openai-speech') {
    return store.settings.cloudModelCode
      ? store.error || '当前云端朗读模型不可用，请检查模型配置或网络。'
      : '还没有配置云端朗读模型，请先选择支持 /audio/speech 的模型。'
  }
  return '当前没有可用的系统语音。请安装系统语音包，或换用云端朗读。'
})

const emptyStateTitle = computed(() => {
  if (!store.chapters.length) return '这本书还没有章节'
  if (store.error.includes('连续多章')) return '已暂停自动播放'
  return '这一章还没有正文'
})

const emptyStateMessage = computed(() => {
  if (!store.chapters.length) return '先创建章节并写入正文，再回来听书。'
  return store.error || (store.canNextChapter ? '写完再来听，或者先听下一章。' : '写完这一章后再来听。')
})

const bookId = () => String(route.params.bookId || '')
const queryChapterId = () => {
  const value = route.query.chapterId
  const id = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(id) && id ? id : null
}

const load = async () => {
  await store.openBook(bookId(), queryChapterId())
}

const openPanel = (tab: 'chapters' | 'voice') => {
  sidePanelTab.value = tab
  sidePanelOpen.value = true
}

const goBack = () => {
  void router.push('/myBooks')
}

const goWriting = () => {
  const id = store.book?.id
  if (!id) return
  void router.push(`/writing/${id}`)
}

const retry = async () => {
  if (store.script) {
    void store.play()
    return
  }
  if (store.hasSession) await store.reloadCurrent()
  else await store.openBook(bookId(), queryChapterId())
  if (store.status === 'paused') void store.play()
}

const handleSeek = (index: number) => {
  const wasPlaying = store.isPlaying
  store.seekSegment(index)
  if (!wasPlaying) void store.play()
}

const restartBook = async () => {
  await store.selectChapter(0)
  void store.play()
}

const hideBrokenCover = () => {
  coverBroken.value = true
}

const hideBrokenBackground = (event: Event) => {
  const element = event.target as HTMLImageElement
  element.style.visibility = 'hidden'
}

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (sidePanelOpen.value) sidePanelOpen.value = false
    else if (focusMode.value) focusMode.value = false
    else goBack()
    return
  }
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, button, [role="button"], [contenteditable="true"]')) return
  if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault()
    store.toggle()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    store.prevSegment()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    store.nextSegment()
  } else if (event.shiftKey && event.key === 'ArrowUp') {
    event.preventDefault()
    store.updateSettings({ volume: Math.min(1, store.settings.volume + 0.05) })
  } else if (event.shiftKey && event.key === 'ArrowDown') {
    event.preventDefault()
    store.updateSettings({ volume: Math.max(0, store.settings.volume - 0.05) })
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await load()
  if (route.query.panel === 'voice') {
    sidePanelTab.value = 'voice'
    sidePanelOpen.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  // 页面没有全局悬浮控制；离开时连尚未完成的加载/自动播放意图一起取消。
  store.suspend()
})

watch(
  () => store.book?.coverUrl,
  () => {
    coverBroken.value = false
  }
)

watch(
  [() => route.params.bookId, () => route.query.chapterId],
  async ([value, chapterId], [previous, previousChapterId]) => {
    if (
      String(value || '') === String(previous || '') &&
      String(Array.isArray(chapterId) ? chapterId[0] : chapterId || '') ===
        String(Array.isArray(previousChapterId) ? previousChapterId[0] : previousChapterId || '')
    )
      return
    await load()
  }
)
</script>

<style scoped lang="scss">
.listen-page {
  position: relative;
  z-index: 10;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-main);
  color: var(--ink-main);
  --listen-accent-text: color-mix(in srgb, var(--ink-accent) 60%, var(--ink-main));
}

.listen-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.16;
    filter: saturate(0.75);
  }
}

.listen-bg-wash {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--surface-1) 72%, transparent), transparent 52%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-main) 72%, transparent), var(--bg-main) 82%);
}

.listen-header {
  position: relative;
  z-index: 2;
  min-height: 72px;
  padding: 10px clamp(16px, 3vw, 32px);
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 10%, transparent);
  background: color-mix(in srgb, var(--surface-1) 64%, transparent);
  backdrop-filter: blur(12px);
}

.listen-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;
  font: inherit;
  font-size: 13px;

  &:hover {
    border-color: color-mix(in srgb, var(--ink-main) 14%, transparent);
    color: var(--ink-main);
  }
}

.listen-book-head {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
}

.listen-book-cover {
  width: 38px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ink-accent) 12%, var(--surface-1));
  color: var(--listen-accent-text);
  font-family: 'Noto Serif SC', serif;
  font-size: 19px;
  box-shadow: 0 3px 10px rgb(0 0 0 / 12%);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.listen-book-copy {
  min-width: 0;

  h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: 'Noto Serif SC', 'Songti SC', serif;
    font-size: clamp(16px, 1.5vw, 20px);
    font-weight: 600;
  }

  p {
    margin: 3px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-sec);
    font-size: 11px;
  }
}

.listen-header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.listen-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
  color: var(--listen-accent-text);
  font-size: 11px;
  letter-spacing: 0.08em;

  i {
    animation: listen-live 1.2s ease-in-out infinite alternate;
  }
}

@keyframes listen-live {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 1;
  }
}

.listen-header-btn {
  height: 34px;
  min-width: 34px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  font-size: 12px;

  &:hover {
    border-color: color-mix(in srgb, var(--ink-main) 14%, transparent);
    color: var(--ink-main);
  }

  &.with-text {
    border-color: color-mix(in srgb, var(--ink-main) 14%, transparent);
    color: var(--ink-main);
  }
}

.listen-back:focus-visible,
.listen-header-btn:focus-visible,
.listen-focus-exit:focus-visible,
.listen-engine-warning button:focus-visible {
  outline: 2px solid var(--ink-accent);
  outline-offset: 2px;
}

.listen-focus-exit {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 6;
  width: 36px;
  height: 36px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 14%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--surface-1) 80%, transparent);
  color: var(--ink-sec);
  cursor: pointer;

  &:hover {
    color: var(--listen-accent-text);
  }
}

.listen-engine-warning {
  position: relative;
  z-index: 2;
  min-height: 38px;
  padding: 7px clamp(16px, 3vw, 32px);
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-accent) 22%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 8%, var(--bg-main));
  color: var(--ink-sec);
  font-size: 12px;

  i {
    color: var(--listen-accent-text);
  }

  button {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--listen-accent-text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  span {
    min-width: 0;
  }
}

.listen-main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.listen-status-card {
  margin: auto;
  width: min(420px, calc(100vw - 48px));
  padding: 30px 28px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 82%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  box-shadow: 0 20px 60px rgb(0 0 0 / 8%);

  > i {
    margin-bottom: 4px;
    color: var(--listen-accent-text);
    font-size: 26px;
  }

  strong {
    font-family: 'Noto Serif SC', serif;
    font-size: 18px;
  }

  span {
    color: var(--ink-sec);
    font-size: 12px;
    line-height: 1.7;
  }

  &.is-error > i {
    color: var(--listen-accent-text);
  }
}

.status-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}

.listen-ended {
  position: absolute;
  left: 50%;
  bottom: 132px;
  z-index: 4;
  transform: translateX(-50%);
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 24%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 14px 40px rgb(0 0 0 / 12%);

  > i {
    color: var(--listen-accent-text);
    font-size: 18px;
  }

  div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  strong {
    font-size: 13px;
  }
  span {
    color: var(--ink-sec);
    font-size: 11px;
  }

  &.is-chapter {
    border-color: color-mix(in srgb, var(--state-success, #4f7a5a) 34%, transparent);

    > i {
      color: var(--state-success, #4f7a5a);
    }
  }
}

.is-focus {
  .listen-header {
    min-height: 0;
    height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-bottom: 0;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
  }
}

@media (max-width: 760px) {
  .listen-header {
    min-height: 62px;
    gap: 10px;
  }

  .listen-back span,
  .listen-header-btn.with-text,
  .listen-live {
    display: none;
  }

  .listen-book-cover {
    width: 30px;
    height: 38px;
  }

  .listen-ended {
    bottom: 170px;
    width: calc(100vw - 32px);
    justify-content: space-between;
  }
}

@media (max-width: 480px) {
  .listen-header {
    padding-inline: 10px;
  }

  .listen-back,
  .listen-header-btn,
  .listen-focus-exit {
    min-width: 40px;
    min-height: 40px;
  }

  .listen-book-cover {
    display: none;
  }

  .listen-engine-warning {
    align-items: flex-start;
    flex-wrap: wrap;
    padding-block: 8px;

    button {
      margin-left: 24px;
    }
  }

  .listen-status-card {
    width: calc(100vw - 24px);
    padding: 24px 18px;
  }

  .listen-ended {
    bottom: 184px;
    flex-wrap: wrap;

    button {
      margin-left: auto;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .listen-live i {
    animation: none;
  }
}
</style>
