<template>
  <Transition name="listen-panel-fade">
    <div v-if="open" class="listen-panel-mask" @click.self="emit('close')" @keydown="handlePanelKeydown">
      <aside
        ref="panelRef"
        class="listen-panel"
        role="dialog"
        aria-modal="true"
        aria-label="听书设置与目录"
        tabindex="-1"
      >
        <header class="listen-panel-head">
          <div class="listen-panel-tabs" role="tablist">
            <button
              type="button"
              id="listen-tab-chapters"
              role="tab"
              aria-controls="listen-panel-chapters"
              :aria-selected="tab === 'chapters'"
              :tabindex="tab === 'chapters' ? 0 : -1"
              :class="{ active: tab === 'chapters' }"
              @click="selectTab('chapters')"
              @keydown.left.prevent="selectTab('voice', true)"
              @keydown.right.prevent="selectTab('voice', true)"
            >
              <i class="fa-solid fa-list-ul"></i>
              目录
            </button>
            <button
              type="button"
              id="listen-tab-voice"
              role="tab"
              aria-controls="listen-panel-voice"
              :aria-selected="tab === 'voice'"
              :tabindex="tab === 'voice' ? 0 : -1"
              :class="{ active: tab === 'voice' }"
              @click="selectTab('voice')"
              @keydown.left.prevent="selectTab('chapters', true)"
              @keydown.right.prevent="selectTab('chapters', true)"
            >
              <i class="fa-solid fa-sliders"></i>
              朗读设置
            </button>
          </div>
          <button type="button" class="listen-panel-close" aria-label="关闭" @click="emit('close')">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </header>

        <div
          v-if="tab === 'chapters'"
          id="listen-panel-chapters"
          class="listen-chapter-body"
          role="tabpanel"
          aria-labelledby="listen-tab-chapters"
        >
          <p v-if="!store.chapters.length" class="panel-empty">这本书还没有章节</p>
          <section v-for="group in volumeGroups" :key="group.title" class="chapter-group">
            <h3>{{ group.title }}</h3>
            <button
              v-for="chapter in group.chapters"
              :key="chapter.id"
              type="button"
              class="chapter-row"
              :class="{ active: chapter.id === store.currentChapter?.id }"
              :aria-current="chapter.id === store.currentChapter?.id ? 'true' : undefined"
              :aria-label="`${chapter.title}${finishedSet.has(chapter.id) ? '，已听完' : ''}${chapter.id === store.currentChapter?.id ? '，当前章节' : ''}`"
              @click="selectChapter(chapter)"
            >
              <span class="chapter-index">{{ chapter.sortNo || chapter.id }}</span>
              <span class="chapter-title">{{ chapter.title }}</span>
              <i
                v-if="finishedSet.has(chapter.id)"
                class="fa-solid fa-check chapter-done"
                title="已听完"
                aria-hidden="true"
              ></i>
              <i
                v-if="chapter.id === store.currentChapter?.id"
                class="fa-solid fa-volume-high"
                aria-hidden="true"
              ></i>
            </button>
          </section>
        </div>

        <div
          v-else
          id="listen-panel-voice"
          class="listen-voice-body"
          role="tabpanel"
          aria-labelledby="listen-tab-voice"
        >
          <section class="panel-section">
            <h3>朗读引擎</h3>
            <div class="engine-switch">
              <button
                type="button"
                :class="{ active: store.settings.engine === 'system' }"
                :aria-pressed="store.settings.engine === 'system'"
                @click="setEngine('system')"
              >
                <i class="fa-solid fa-laptop"></i>
                系统朗读
                <small>离线 · 免费</small>
              </button>
              <button
                type="button"
                :class="{ active: store.settings.engine === 'cloud' }"
                :aria-pressed="store.settings.engine === 'cloud'"
                @click="setEngine('cloud')"
              >
                <i class="fa-solid fa-cloud"></i>
                云端朗读
                <small>多家服务 · 自备账号</small>
              </button>
            </div>
            <p v-if="!store.engineAvailable && store.settings.engine === 'system'" class="panel-warning">
              当前系统没有可用的普通话音色。请安装普通话语音包，或配置云端朗读。
            </p>
          </section>

          <section v-if="store.settings.engine === 'system'" class="panel-section">
            <div class="panel-section-title">
              <h3>普通话音色</h3>
              <span class="panel-head-actions">
                <button
                  type="button"
                  class="panel-link"
                  :disabled="store.isPlaying || previewing"
                  @click="preview"
                >
                  {{ previewing ? '试听中…' : '试听' }}
                </button>
                <button
                  type="button"
                  class="panel-link"
                  :disabled="store.voicesLoading"
                  @click="store.refreshVoices()"
                >
                  {{ store.voicesLoading ? '加载中…' : '刷新' }}
                </button>
              </span>
            </div>
            <p v-if="!store.voices.length" class="panel-empty">尚未发现普通话音色</p>
            <div v-else class="voice-list">
              <button
                v-for="voice in systemVoices"
                :key="voice.id"
                type="button"
                class="voice-row"
                :class="{ active: voice.id === store.settings.voiceId }"
                :aria-pressed="voice.id === store.settings.voiceId"
                @click="setVoice(voice.id, voice.name)"
              >
                <span>
                  <strong>{{ voice.name }}</strong>
                  <small>{{ voice.lang }}{{ voice.local ? ' · 本地' : ' · 在线' }}</small>
                </span>
                <i v-if="voice.id === store.settings.voiceId" class="fa-solid fa-check"></i>
              </button>
            </div>
          </section>

          <section v-else class="panel-section">
            <div class="panel-section-title"><h3>云端语音服务</h3></div>
            <CloudSpeechSettings v-if="open && tab === 'voice'" />
          </section>

          <section class="panel-section">
            <h3>播放</h3>
            <label class="panel-range">
              <span
                >语速 <em>{{ store.settings.rate.toFixed(2) }}x</em></span
              >
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                :value="store.settings.rate"
                @change="setRate"
              />
            </label>
            <label class="panel-range">
              <span
                >音量 <em>{{ Math.round(store.settings.volume * 100) }}%</em></span
              >
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="store.settings.volume"
                @input="setVolume"
              />
            </label>
            <label class="panel-check">
              <input type="checkbox" :checked="store.settings.autoNextChapter" @change="setAutoNext" />
              <span>自动播放下一章</span>
            </label>
            <label class="panel-check">
              <input type="checkbox" :checked="store.settings.readChapterTitle" @change="setReadTitle" />
              <span>朗读章节标题</span>
            </label>
            <label class="panel-field">
              <span>章节间隔</span>
              <el-select :model-value="store.settings.chapterGapMs" aria-label="章节间隔" popper-class="ink-select-popper" @change="setGap">
                <el-option :value="0" label="立即" />
                <el-option :value="800" label="0.8 秒" />
                <el-option :value="2000" label="2 秒" />
              </el-select>
            </label>
          </section>

          <section class="panel-section">
            <div class="panel-section-title">
              <h3>朗读缓存</h3>
              <button type="button" class="panel-link" @click="clearCache">清理</button>
            </div>
            <p class="panel-hint">
              {{ store.cacheCount }} 段 ·
              {{ formatBytes(store.cacheBytes) }}；仅缓存云端朗读音频，不进入作品备份。
            </p>
          </section>

          <section class="panel-section">
            <div class="panel-section-title">
              <h3>诊断</h3>
              <button type="button" class="panel-link" @click="copyDiagnostics">复制</button>
            </div>
            <p class="panel-hint">只记录引擎、章节和错误码，不记录正文与 API Key。</p>
          </section>
        </div>
      </aside>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useListeningStore } from '@/stores/listening'
import CloudSpeechSettings from './CloudSpeechSettings.vue'
import { formatListeningDiagnostics } from '@/storage/listening-diagnostics'
import { previewListeningVoice } from '@/listening/preview'
import { isAbortError, type TtsVoice } from '@/listening/engine/types'
import type { ListenChapterRef } from '@/types/listening'

const props = defineProps<{
  open: boolean
  initialTab?: 'chapters' | 'voice'
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

const store = useListeningStore()
const tab = ref<'chapters' | 'voice'>(props.initialTab || 'chapters')
const previewing = ref(false)
let previewController: AbortController | null = null

const stopPreview = () => {
  previewController?.abort()
  previewController = null
  previewing.value = false
}

const panelRef = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

const scrollCurrentChapterIntoView = () => {
  panelRef.value
    ?.querySelector<HTMLElement>('.chapter-row[aria-current="true"]')
    ?.scrollIntoView({ block: 'center' })
}

const selectTab = async (value: 'chapters' | 'voice', focus = false) => {
  tab.value = value
  if (!focus) return
  await nextTick()
  panelRef.value?.querySelector<HTMLElement>(`#listen-tab-${value}`)?.focus()
}

const focusableElements = () => {
  if (!panelRef.value) return []
  return [
    ...panelRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]'
    )
  ].filter(element => element.tabIndex >= 0)
}

const handlePanelKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    panelRef.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async value => {
    if (!value) {
      stopPreview()
      const target = returnFocus
      returnFocus = null
      await nextTick()
      if (target?.isConnected) target.focus()
      return
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    tab.value = props.initialTab || 'chapters'
    void store.refreshCacheStats()
    await nextTick()
    panelRef.value?.querySelector<HTMLElement>(`#listen-tab-${tab.value}`)?.focus()
    if (tab.value === 'chapters') scrollCurrentChapterIntoView()
  }
)

watch(
  () => props.initialTab,
  value => {
    if (props.open && value) {
      tab.value = value
    }
  }
)

watch(tab, async value => {
  if (value === 'chapters') {
    stopPreview()
    await nextTick()
    scrollCurrentChapterIntoView()
    return
  }

})

const volumeGroups = computed(() => {
  const groups: Array<{ title: string; chapters: ListenChapterRef[] }> = []
  for (const chapter of store.chapters) {
    let group = groups[groups.length - 1]
    if (!group || group.title !== chapter.volumeTitle) {
      group = { title: chapter.volumeTitle, chapters: [] }
      groups.push(group)
    }
    group.chapters.push(chapter)
  }
  return groups
})

const systemVoices = computed<TtsVoice[]>(() => store.voices.filter(voice => voice.engine === 'system'))
const finishedSet = computed(() => new Set(store.finishedChapterIds))

const selectChapter = (chapter: ListenChapterRef) => {
  if (chapter.id === store.currentChapter?.id) {
    emit('close')
    return
  }
  const index = store.chapters.findIndex(item => item.id === chapter.id)
  if (index >= 0) void store.selectChapter(index)
  emit('close')
}

const setEngine = (engine: 'system' | 'cloud') => {
  stopPreview()
  store.updateSettings({ engine })
}

const setVoice = (id: string, name: string) => {
  store.updateSettings({ voiceId: id, voiceName: name })
}

const setRate = (event: Event) => {
  store.updateSettings({ rate: Number((event.target as HTMLInputElement).value) })
}

const setVolume = (event: Event) => {
  store.updateSettings({ volume: Number((event.target as HTMLInputElement).value) })
}

const setAutoNext = (event: Event) => {
  store.updateSettings({ autoNextChapter: (event.target as HTMLInputElement).checked })
}

const setReadTitle = (event: Event) => {
  store.updateSettings({ readChapterTitle: (event.target as HTMLInputElement).checked })
}

const setGap = (value: unknown) => {
  if ([0, 800, 2000].includes(Number(value))) store.updateSettings({ chapterGapMs: Number(value) as 0 | 800 | 2000 })
}

const clearCache = async () => {
  const cleared = await store.clearCache()
  if (cleared) ElMessage.success('朗读缓存已清理')
  else ElMessage.error('朗读缓存清理失败，请稍后重试')
}

const preview = async () => {
  if (previewing.value) return
  const controller = new AbortController()
  previewController = controller
  previewing.value = true
  try {
    await previewListeningVoice(store.settings, controller.signal)
  } catch (error) {
    if (!isAbortError(error)) ElMessage.error(error instanceof Error ? error.message : '试听失败')
  } finally {
    if (previewController === controller) {
      previewController = null
      previewing.value = false
    }
  }
}

const copyDiagnostics = async () => {
  try {
    await navigator.clipboard.writeText(formatListeningDiagnostics())
    ElMessage.success('诊断信息已复制')
  } catch {
    ElMessage.error('复制失败，请检查剪贴板权限')
  }
}

onBeforeUnmount(stopPreview)

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped lang="scss">
.listen-panel-mask {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: flex;
  justify-content: flex-end;
  background: rgb(15 14 12 / 38%);
  backdrop-filter: blur(2px);
}

.listen-panel {
  width: min(440px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-main);
  color: var(--ink-main);
  border-left: 1px solid var(--ui-border);
  box-shadow: -18px 0 50px rgb(0 0 0 / 16%);

  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--ink-accent);
    outline-offset: 2px;
  }
}

.listen-panel-head {
  min-height: 64px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
}

.listen-panel-tabs {
  flex: 1;
  display: flex;
  gap: 6px;

  button {
    flex: 1;
    height: 36px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font: inherit;

    &.active {
      border-color: color-mix(in srgb, var(--ink-accent) 28%, transparent);
      background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
      color: var(--listen-accent-text);
    }
  }
}

.listen-panel-close {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;

  &:hover {
    background: color-mix(in srgb, var(--ink-main) 8%, transparent);
  }
}

.listen-chapter-body,
.listen-voice-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 16px 40px;
}

.chapter-group {
  margin-bottom: 18px;

  h3 {
    margin: 0 0 8px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 500;
    letter-spacing: 0.08em;
  }
}

.chapter-row {
  width: 100%;
  min-height: 42px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 9px;
  font: inherit;
  text-align: left;

  &:hover {
    background: color-mix(in srgb, var(--ink-main) 5%, transparent);
  }

  &.active {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
    color: var(--listen-accent-text);
  }

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  .chapter-done {
    color: var(--state-success, #4f7a5a);
  }
}

.chapter-index {
  min-width: 24px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.chapter-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.panel-section {
  padding: 16px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 9%, transparent);

  h3 {
    margin: 0 0 10px;
    font-size: calc(14px * var(--ui-font-scale, 1));
    font-weight: 600;
  }
}

.panel-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h3 {
    margin-bottom: 8px;
  }
}

.panel-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.panel-link {
  border: 0;
  background: transparent;
  color: var(--listen-accent-text);
  cursor: pointer;
  font-size: calc(12px * var(--ui-font-scale, 1));

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}

.engine-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;

  button {
    padding: 11px 10px;
    border: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, var(--surface-1) 70%, transparent);
    color: var(--ink-main);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    font: inherit;
    text-align: left;

    small {
      color: var(--ink-sec);
      font-size: calc(10px * var(--ui-font-scale, 1));
      line-height: 1.4;
    }

    &.active {
      border-color: color-mix(in srgb, var(--ink-accent) 38%, transparent);
      background: color-mix(in srgb, var(--ink-accent) 9%, transparent);
    }
  }
}

.panel-warning,
.panel-hint,
.panel-empty {
  margin: 8px 0 0;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.panel-warning {
  color: var(--listen-accent-text);
}

.voice-list {
  display: grid;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.voice-row {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font: inherit;
  text-align: left;

  span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
    font-weight: 500;
  }
  small {
    color: var(--ink-sec);
    font-size: calc(10px * var(--ui-font-scale, 1));
  }

  &:hover {
    background: color-mix(in srgb, var(--ink-main) 5%, transparent);
  }
  &.active {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
    color: var(--listen-accent-text);
  }
}

.panel-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  .el-select { width: 100%; }

}

.panel-range {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  span {
    display: flex;
    justify-content: space-between;
  }

  em {
    color: var(--ink-main);
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }

  input {
    width: 100%;
    accent-color: var(--ink-accent);
  }
}

.panel-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));

  input {
    accent-color: var(--ink-accent);
  }
}

.listen-panel-fade-enter-active,
.listen-panel-fade-leave-active {
  transition: opacity 180ms ease;
}

.listen-panel-fade-enter-from,
.listen-panel-fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .listen-panel {
    width: 100%;
    border-left: 0;
  }

  .listen-panel-head,
  .listen-chapter-body,
  .listen-voice-body {
    padding-left: 12px;
    padding-right: 12px;
  }

  .engine-switch {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .listen-panel-fade-enter-active,
  .listen-panel-fade-leave-active {
    transition: none;
  }
}
</style>
