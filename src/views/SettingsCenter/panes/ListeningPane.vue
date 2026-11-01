<template>
  <section class="settings-pane listening-pane">
    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-headphones"></i>
        <strong>朗读引擎</strong>
      </div>
      <p class="hint-line">
        系统朗读仅显示普通话音色；云端朗读可单独配置腾讯云、阿里云百炼、讯飞或兼容服务。
      </p>
      <div class="engine-grid">
        <button
          type="button"
          class="engine-card"
          :class="{ active: store.settings.engine === 'system' }"
          :aria-pressed="store.settings.engine === 'system'"
          @click="setEngine('system')"
        >
          <i class="fa-solid fa-laptop"></i>
          <strong>系统朗读</strong>
          <span>系统普通话 · 无服务商密钥</span>
        </button>
        <button
          type="button"
          class="engine-card"
          :class="{ active: store.settings.engine === 'cloud' }"
          :aria-pressed="store.settings.engine === 'cloud'"
          @click="setEngine('cloud')"
        >
          <i class="fa-solid fa-cloud"></i>
          <strong>云端朗读</strong>
          <span>多家服务 · 自备账号</span>
        </button>
      </div>
      <p v-if="!store.engineAvailable && store.settings.engine === 'system'" class="warn-line">
        当前系统没有可用的普通话音色。请安装普通话语音包，或改用云端朗读。
      </p>
    </section>

    <section v-if="store.settings.engine === 'system'" class="settings-card">
      <div class="settings-card-title between">
        <div>
          <i class="fa-solid fa-microphone-lines"></i>
          <strong>普通话音色</strong>
        </div>
        <div class="card-head-actions">
          <button
            type="button"
            class="ink-btn ink-btn-outline compact-btn"
            :disabled="store.isPlaying || previewing"
            @click="preview"
          >
            {{ previewing ? '试听中…' : '试听' }}
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline compact-btn"
            :disabled="store.voicesLoading"
            @click="store.refreshVoices()"
          >
            {{ store.voicesLoading ? '加载中…' : '刷新音色' }}
          </button>
        </div>
      </div>
      <p v-if="!systemVoices.length" class="hint-line">
        未发现普通话音色，请在系统语音设置中安装普通话语音包。
      </p>
      <div v-else class="voice-grid">
        <button
          v-for="voice in systemVoices"
          :key="voice.id"
          type="button"
          class="voice-card"
          :class="{ active: voice.id === store.settings.voiceId }"
          :aria-pressed="voice.id === store.settings.voiceId"
          @click="setVoice(voice.id, voice.name)"
        >
          <span class="voice-name">{{ voice.name }}</span>
          <span class="voice-meta">{{ voice.lang }}{{ voice.local ? ' · 本地' : ' · 在线' }}</span>
          <i v-if="voice.id === store.settings.voiceId" class="fa-solid fa-check"></i>
        </button>
      </div>
    </section>

    <section v-else class="settings-card">
      <div class="settings-card-title"><i class="fa-solid fa-cloud"></i><strong>云端语音服务</strong></div>
      <CloudSpeechSettings />
    </section>

    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-sliders"></i>
        <strong>播放偏好</strong>
      </div>
      <label class="range-row">
        <span
          >语速 <em>{{ store.settings.rate.toFixed(2) }}x</em></span
        >
        <input type="range" min="0.5" max="2" step="0.05" :value="store.settings.rate" @change="setRate" />
      </label>
      <label class="range-row">
        <span
          >音量 <em>{{ Math.round(store.settings.volume * 100) }}%</em></span
        >
        <input type="range" min="0" max="1" step="0.05" :value="store.settings.volume" @input="setVolume" />
      </label>
      <div class="toggle-grid">
        <label class="toggle-row">
          <input type="checkbox" :checked="store.settings.autoNextChapter" @change="setAutoNext" />
          <span>自动播放下一章</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" :checked="store.settings.readChapterTitle" @change="setReadTitle" />
          <span>朗读章节标题</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" :checked="store.settings.cacheEnabled" @change="setCacheEnabled" />
          <span>缓存云端朗读音频</span>
        </label>
      </div>
      <label class="field-row">
        <span>章节间隔</span>
        <el-select :model-value="store.settings.chapterGapMs" aria-label="章节间隔" popper-class="ink-select-popper" @change="setGap">
          <el-option :value="0" label="立即" />
          <el-option :value="800" label="0.8 秒" />
          <el-option :value="2000" label="2 秒" />
        </el-select>
      </label>
      <label class="field-row">
        <span>下次进入默认定时</span>
        <el-select :model-value="store.settings.sleepTimerDefault" aria-label="下次进入默认定时" popper-class="ink-select-popper" @change="setSleepDefault">
          <el-option v-for="option in sleepOptions" :key="option.value" :value="option.value" :label="option.label" />
        </el-select>
      </label>
    </section>

    <section class="settings-card">
      <div class="settings-card-title between">
        <div>
          <i class="fa-solid fa-database"></i>
          <strong>朗读缓存</strong>
        </div>
        <button type="button" class="ink-btn ink-btn-outline compact-btn" @click="clearCache">清理</button>
      </div>
      <p class="hint-line">
        当前缓存 {{ store.cacheCount }} 段，占用
        {{ formatBytes(store.cacheBytes) }}。只保存云端朗读音频，不进入作品备份。
      </p>
    </section>

    <section class="settings-card">
      <div class="settings-card-title between">
        <div>
          <i class="fa-solid fa-stethoscope"></i>
          <strong>诊断</strong>
        </div>
        <button type="button" class="ink-btn ink-btn-outline compact-btn" @click="copyDiagnostics">
          复制诊断信息
        </button>
      </div>
      <p class="hint-line">只记录朗读引擎、章节和错误码，不记录正文与 API Key；不会自动上传。</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useListeningStore } from '@/stores/listening'
import CloudSpeechSettings from '@/views/Listen/components/CloudSpeechSettings.vue'
import { LISTEN_SLEEP_OPTIONS } from '@/config/listening'
import { formatListeningDiagnostics } from '@/storage/listening-diagnostics'
import { previewListeningVoice } from '@/listening/preview'
import { isAbortError, type TtsVoice } from '@/listening/engine/types'
import type { SleepTimerMode } from '@/types/listening'

const store = useListeningStore()
const sleepOptions = LISTEN_SLEEP_OPTIONS

const systemVoices = computed<TtsVoice[]>(() => store.voices.filter(voice => voice.engine === 'system'))
const previewing = ref(false)
let previewController: AbortController | null = null

const stopPreview = () => {
  previewController?.abort()
  previewController = null
  previewing.value = false
}

onMounted(async () => {
  try {
    await store.refreshVoices()
    await store.refreshCacheStats()
  } catch (error) {
    console.warn('加载听书设置失败', error)
  }
})

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

const setCacheEnabled = (event: Event) => {
  store.updateSettings({ cacheEnabled: (event.target as HTMLInputElement).checked })
}

const setGap = (value: unknown) => {
  if ([0, 800, 2000].includes(Number(value))) store.updateSettings({ chapterGapMs: Number(value) as 0 | 800 | 2000 })
}

const setSleepDefault = (value: unknown) => {
  if (sleepOptions.some(option => option.value === value)) store.updateSettings({ sleepTimerDefault: value as SleepTimerMode })
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

onBeforeUnmount(stopPreview)

const copyDiagnostics = async () => {
  try {
    await navigator.clipboard.writeText(formatListeningDiagnostics())
    ElMessage.success('诊断信息已复制')
  } catch {
    ElMessage.error('复制失败，请检查剪贴板权限')
  }
}

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped lang="scss">
.listening-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
  --listen-accent-text: color-mix(in srgb, var(--ink-accent) 60%, var(--ink-main));
}

.settings-card {
  padding: 18px 20px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
}

.settings-card-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
  color: var(--ink-main);

  i {
    color: var(--listen-accent-text);
  }

  strong {
    font-size: calc(14px * var(--ui-font-scale, 1));
    font-weight: 600;
  }

  &.between {
    justify-content: space-between;

    > div {
      display: flex;
      align-items: center;
      gap: 9px;
    }
  }
}

.hint-line,
.warn-line {
  margin: 8px 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.7;
}

.warn-line {
  color: var(--listen-accent-text);
}

.engine-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.engine-card {
  min-height: 96px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 12%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  font: inherit;
  text-align: left;

  i {
    color: var(--listen-accent-text);
    font-size: calc(17px * var(--ui-font-scale, 1));
  }

  strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  span {
    color: var(--ink-sec);
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  &.active {
    border-color: color-mix(in srgb, var(--ink-accent) 42%, transparent);
    background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
  }
}

.voice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  margin-top: 10px;
}

.voice-card {
  position: relative;
  min-height: 52px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 10%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  font: inherit;
  text-align: left;

  .voice-name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  .voice-meta {
    color: var(--ink-sec);
    font-size: calc(10px * var(--ui-font-scale, 1));
  }

  i {
    position: absolute;
    top: 9px;
    right: 10px;
    color: var(--listen-accent-text);
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  &.active {
    border-color: color-mix(in srgb, var(--ink-accent) 36%, transparent);
    background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
  }
}

.field-row,
.range-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 12px 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  .el-select { width: min(300px, 60%); }

}

.field-row > span {
  flex: none;
  white-space: nowrap;
}

.range-row {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;

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

.toggle-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 18px;
  margin: 10px 0;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-main);
  font-size: calc(12px * var(--ui-font-scale, 1));

  input {
    accent-color: var(--ink-accent);
  }
}

.card-head-actions {
  display: inline-flex;
  gap: 8px;
}

.compact-btn {
  min-height: 30px;
  padding: 4px 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

@media (max-width: 900px) {
  .engine-grid,
  .voice-grid,
  .toggle-grid {
    grid-template-columns: 1fr;
  }

  .field-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;

    .el-select {
      width: 100%;
    }
  }
}
</style>
