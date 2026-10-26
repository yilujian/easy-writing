<template>
  <section class="settings-pane listening-pane">
    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-headphones"></i>
        <strong>朗读引擎</strong>
      </div>
      <p class="hint-line">
        系统朗读离线、免费，音色取决于电脑；云端朗读音质更好，需要自备支持 /audio/speech 的模型。
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
          <span>不联网 · 免费 · 立即使用</span>
        </button>
        <button
          type="button"
          class="engine-card"
          :class="{ active: store.settings.engine === 'openai-speech' }"
          :aria-pressed="store.settings.engine === 'openai-speech'"
          @click="setEngine('openai-speech')"
        >
          <i class="fa-solid fa-cloud"></i>
          <strong>云端朗读</strong>
          <span>音质更好 · 按字符计费</span>
        </button>
      </div>
      <p v-if="!store.engineAvailable && store.settings.engine === 'system'" class="warn-line">
        当前系统没有可用的朗读语音。可安装系统语音包，或改用云端朗读。
      </p>
    </section>

    <section v-if="store.settings.engine === 'system'" class="settings-card">
      <div class="settings-card-title between">
        <div>
          <i class="fa-solid fa-microphone-lines"></i>
          <strong>系统音色</strong>
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
        尚未发现系统语音。Windows 可在“设置 → 时间和语言 → 语言和区域 → 中文 → 语言选项 → 语音包”安装。
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
      <div class="settings-card-title">
        <i class="fa-solid fa-cloud"></i>
        <strong>云端朗读模型</strong>
      </div>
      <p v-if="!audioModels.length" class="hint-line">
        还没有朗读模型。请到「模型管理」添加模型，使用场景选择“朗读（听书）”，接口需支持 /audio/speech。
      </p>
      <template v-else>
        <label class="field-row">
          <span>模型</span>
          <select :value="store.settings.cloudModelCode" @change="setCloudModel">
            <option value="">请选择</option>
            <option v-for="model in audioModels" :key="model.code" :value="model.code">
              {{ model.name || model.modelCode }}
            </option>
          </select>
        </label>
        <label class="field-row">
          <span>音色</span>
          <input
            :value="store.settings.cloudVoice"
            type="text"
            maxlength="80"
            placeholder="alloy、nova、FunAudioLLM/CosyVoice2-0.5B:alex…"
            @change="setCloudVoice"
          />
        </label>
        <button
          type="button"
          class="ink-btn ink-btn-outline compact-btn"
          :disabled="store.isPlaying || previewing"
          @click="preview"
        >
          {{ previewing ? '试听中…' : '试听当前音色' }}
        </button>
        <p class="hint-line">使用云端朗读时，章节正文会发送给你配置的模型服务商，并按字符计费。</p>
      </template>
      <button type="button" class="ink-btn ink-btn-outline compact-btn" @click="goModels">
        前往模型管理
      </button>
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
        <select :value="store.settings.chapterGapMs" @change="setGap">
          <option :value="0">立即</option>
          <option :value="800">0.8 秒</option>
          <option :value="2000">2 秒</option>
        </select>
      </label>
      <label class="field-row">
        <span>下次进入默认定时</span>
        <select :value="store.settings.sleepTimerDefault" @change="setSleepDefault">
          <option v-for="option in sleepOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
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
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useListeningStore } from '@/stores/listening'
import { useAiModelStore } from '@/stores/ai-model'
import { LISTEN_SLEEP_OPTIONS } from '@/config/listening'
import { formatListeningDiagnostics } from '@/storage/listening-diagnostics'
import { previewListeningVoice } from '@/listening/preview'
import { isAbortError, type TtsVoice } from '@/listening/engine/types'
import type { SleepTimerMode } from '@/types/listening'
import { useSettingsCenterCtx } from '../settings-context'

const store = useListeningStore()
const aiModelStore = useAiModelStore()
const router = useRouter()
const ctx = useSettingsCenterCtx()
const sleepOptions = LISTEN_SLEEP_OPTIONS

const systemVoices = computed<TtsVoice[]>(() => store.voices.filter(voice => voice.engine === 'system'))
const audioModels = computed(() => aiModelStore.modelsFor('audiobook'))
const previewing = ref(false)
let previewController: AbortController | null = null

const stopPreview = () => {
  previewController?.abort()
  previewController = null
  previewing.value = false
}

onMounted(async () => {
  try {
    if (!aiModelStore.groups.audiobook) await aiModelStore.loadGroup('audiobook')
    ensureCloudModel()
    await store.refreshVoices()
    await store.refreshCacheStats()
  } catch (error) {
    console.warn('加载听书设置失败', error)
  }
})

const ensureCloudModel = () => {
  if (store.settings.cloudModelCode) return
  const preferred = aiModelStore.effectiveModelCode('audiobook') || audioModels.value[0]?.code
  if (!preferred) return
  const model = audioModels.value.find(item => item.code === preferred)
  store.updateSettings({
    cloudModelCode: preferred,
    cloudVoice: model?.ttsVoice || store.settings.cloudVoice,
    cloudFormat: model?.ttsFormat === 'wav' ? 'wav' : store.settings.cloudFormat
  })
}

const setEngine = async (engine: 'system' | 'openai-speech') => {
  if (engine === 'openai-speech') {
    try {
      if (!aiModelStore.groups.audiobook) await aiModelStore.loadGroup('audiobook')
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '加载朗读模型失败')
      return
    }
    ensureCloudModel()
  }
  store.updateSettings({ engine })
}

const setVoice = (id: string, name: string) => {
  store.updateSettings({ voiceId: id, voiceName: name })
}

const setCloudModel = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value
  const model = audioModels.value.find(item => item.code === value)
  store.updateSettings({
    cloudModelCode: value,
    cloudVoice: model?.ttsVoice || store.settings.cloudVoice,
    cloudFormat: model?.ttsFormat === 'wav' ? 'wav' : 'mp3'
  })
}

const setCloudVoice = (event: Event) => {
  store.updateSettings({ cloudVoice: (event.target as HTMLInputElement).value })
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

const setGap = (event: Event) => {
  store.updateSettings({ chapterGapMs: Number((event.target as HTMLSelectElement).value) as 0 | 800 | 2000 })
}

const setSleepDefault = (event: Event) => {
  store.updateSettings({ sleepTimerDefault: (event.target as HTMLSelectElement).value as SleepTimerMode })
}

const goModels = () => {
  ctx.close()
  void router.push('/aiModels')
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
    font-size: 14px;
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
  font-size: 12px;
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
    font-size: 17px;
  }

  strong {
    font-size: 13px;
  }

  span {
    color: var(--ink-sec);
    font-size: 11px;
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
    font-size: 13px;
  }

  .voice-meta {
    color: var(--ink-sec);
    font-size: 10px;
  }

  i {
    position: absolute;
    top: 9px;
    right: 10px;
    color: var(--listen-accent-text);
    font-size: 11px;
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
  font-size: 12px;

  select,
  input[type='text'] {
    width: min(300px, 60%);
    height: 32px;
    padding: 0 9px;
    border: 1px solid color-mix(in srgb, var(--ink-main) 14%, transparent);
    border-radius: 7px;
    background: var(--surface-1);
    color: var(--ink-main);
    font: inherit;
    outline: none;

    &:focus {
      border-color: var(--ink-accent);
    }
  }
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
  font-size: 12px;

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
  font-size: 12px;
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

    select,
    input[type='text'] {
      width: 100%;
    }
  }
}
</style>
