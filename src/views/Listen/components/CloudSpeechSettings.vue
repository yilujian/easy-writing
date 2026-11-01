<template>
  <div class="cloud-speech-settings">
    <label class="speech-field">
      <span>语音服务</span>
      <el-select :model-value="draft.provider" popper-class="ink-select-popper" @change="chooseProvider">
        <el-option v-for="provider in providers" :key="provider.id" :value="provider.id" :label="provider.label" />
      </el-select>
    </label>
    <p class="speech-hint">{{ providerMeta.hint }}</p>
    <label v-if="profiles.length" class="speech-field">
      <span>已保存的配置</span>
      <el-select :model-value="draft.id" popper-class="ink-select-popper" @change="chooseProfile">
        <el-option v-for="profile in profiles" :key="profile.id" :value="profile.id" :label="profile.name" />
      </el-select>
    </label>
    <button type="button" class="ink-btn ink-btn-outline speech-add" @click="addProfile">新增一套配置</button>
    <label class="speech-field"><span>配置名称</span><el-input v-model="draft.name" maxlength="80" placeholder="例如：日常听书、备用服务、本地 TTS" /></label>

    <div class="speech-fields">
      <template v-if="draft.provider === 'tencent'">
        <label class="speech-field"><span>SecretId</span><el-input v-model="draft.secretId" autocomplete="off" placeholder="腾讯云 API 密钥中的 SecretId" /></label>
        <label class="speech-field"><span>SecretKey</span><el-input v-model="draft.secretKey" type="password" show-password autocomplete="off" placeholder="腾讯云 API 密钥中的 SecretKey" /></label>
      </template>
      <template v-else-if="draft.provider === 'xfyun'">
        <label class="speech-field"><span>APPID</span><el-input v-model="draft.appId" autocomplete="off" placeholder="在线语音合成应用的 APPID" /></label>
        <label class="speech-field"><span>APIKey</span><el-input v-model="draft.apiKey" type="password" show-password autocomplete="off" placeholder="在线语音合成 APIKey" /></label>
        <label class="speech-field"><span>APISecret</span><el-input v-model="draft.secretKey" type="password" show-password autocomplete="off" placeholder="在线语音合成 APISecret" /></label>
      </template>
      <template v-else>
        <label v-if="draft.provider === 'aliyun'" class="speech-field">
          <span>服务地域</span>
          <el-select v-model="draft.baseUrl" popper-class="ink-select-popper">
            <el-option label="中国内地（北京）" value="https://dashscope.aliyuncs.com" />
            <el-option label="新加坡" value="https://dashscope-intl.aliyuncs.com" />
          </el-select>
        </label>
        <label v-else class="speech-field"><span>服务地址</span><el-input v-model="draft.baseUrl" placeholder="https://api.example.com/v1" /></label>
        <label class="speech-field"><span>API Key{{ draft.provider === 'openai' ? '（本地服务可留空）' : '' }}</span><el-input v-model="draft.apiKey" type="password" show-password autocomplete="off" placeholder="语音服务的 API Key" /></label>
        <label class="speech-field"><span>语音模型</span><el-input v-model="draft.model" :placeholder="draft.provider === 'aliyun' ? 'qwen3-tts-flash' : 'tts-1'" /></label>
      </template>
      <label class="speech-field">
        <span>{{ draft.provider === 'tencent' ? '音色 ID（VoiceType）' : '音色 ID' }}</span>
        <el-input v-model="draft.voice" :placeholder="voicePlaceholder" />
      </label>
      <label v-if="draft.provider === 'openai' || draft.provider === 'tencent'" class="speech-field">
        <span>音频格式</span>
        <el-select v-model="draft.format" popper-class="ink-select-popper">
          <el-option label="MP3" value="mp3" /><el-option label="WAV" value="wav" />
        </el-select>
      </label>
    </div>
    <details class="speech-advanced">
      <summary>自定义接口与高级配置</summary>
      <div class="speech-fields">
        <label class="speech-field"><span>完整接口地址（可选）</span><el-input v-model="draft.endpoint" :placeholder="defaultEndpoint" /></label>
        <label class="speech-field"><span>请求超时（秒）</span><el-input-number v-model="timeoutSeconds" :min="5" :max="300" :step="5" controls-position="right" /></label>
        <label v-if="draft.provider === 'tencent'" class="speech-field"><span>签名域名（代理场景，可选）</span><el-input v-model="draft.signingHost" placeholder="留空则使用接口地址的域名" /></label>
      </div>
      <label v-if="draft.provider !== 'xfyun'" class="speech-field"><span>附加请求头（JSON）</span><el-input v-model="draft.headers" type="textarea" :rows="3" placeholder='例如：{"X-Custom-Header":"value"}' /></label>
      <label class="speech-field"><span>{{ draft.provider === 'xfyun' ? '附加 business 参数（JSON）' : '附加请求参数（JSON）' }}</span><el-input v-model="draft.extraParams" type="textarea" :rows="3" placeholder="按服务商文档填写 JSON 对象，通常留空" /></label>
      <p class="speech-hint">地址留空使用厂商预设；自定义地址须兼容所选接口协议。正文、音色、格式和鉴权由上方配置生成，其他参数会合入请求。</p>
    </details>
    <p class="speech-hint">{{ voiceHint }}</p>
    <p v-if="activeLabel" class="speech-active">当前使用：{{ activeLabel }}{{ dirty ? ' · 有未保存的修改' : '' }}</p>
    <p v-else class="speech-active">填写后保存，即可用于听书。</p>
    <div class="speech-actions">
      <button type="button" class="ink-btn ink-btn-primary" :disabled="saving || previewing" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
      <button type="button" class="ink-btn ink-btn-outline" :disabled="store.isPlaying || saving" @click="preview">{{ previewing ? '停止试听' : '连接测试与试听' }}</button>
      <span v-if="message" class="speech-result" :class="{ 'is-error': failed }" role="status">{{ message }}</span>
    </div>
    <p class="speech-hint">测试使用当前填写的配置；密钥保存在本机，正文仅发送给所选语音服务。费用以服务商规则为准。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { SPEECH_PROVIDERS, defaultSpeechProfile, speechEndpoint } from '@/config/speech'
import { migrateLegacySpeechProfiles, readSpeechProfiles, saveSpeechProfile } from '@/storage/speech-profiles'
import { validateSpeechProfile } from '@/listening/providers/synthesize'
import { CloudSpeechEngine } from '@/listening/engine/cloud-speech'
import { isAbortError } from '@/listening/engine/types'
import { useListeningStore } from '@/stores/listening'
import type { SpeechProfile, SpeechProvider } from '@/types/speech'

const store = useListeningStore()
const providers = SPEECH_PROVIDERS
const profiles = ref<SpeechProfile[]>([])
const message = ref('')
const failed = ref(false)
try { profiles.value = migrateLegacySpeechProfiles() } catch { message.value = '读取已有语音配置失败，请检查本地存储后重试'; failed.value = true }
const initial = profiles.value.find(profile => profile.id === store.settings.cloudProfileId) || profiles.value[0] || defaultSpeechProfile('tencent')
const draft = reactive<SpeechProfile>({ ...initial })
const savedSnapshot = ref(JSON.stringify(initial))
const unsavedDrafts = new Map<string, { profile: SpeechProfile; snapshot: string }>()
const dirty = computed(() => JSON.stringify(draft) !== savedSnapshot.value)
const saving = ref(false)
const previewing = ref(false)
let previewController: AbortController | null = null
const providerMeta = computed(() => providers.find(provider => provider.id === draft.provider)!)
const defaultEndpoint = computed(() => speechEndpoint({ ...draft, endpoint: '' }))
const timeoutSeconds = computed({ get: () => draft.timeoutMs / 1000, set: (value: number | undefined) => { draft.timeoutMs = (value || 60) * 1000 } })
const activeLabel = computed(() => profiles.value.find(profile => profile.id === store.settings.cloudProfileId)?.name || '')
const voicePlaceholder = computed(() => defaultSpeechProfile(draft.provider).voice)
const voiceHint = computed(() => ({
  tencent: '填写已开通的腾讯云音色数字 ID，例如 1001；不同音色的权限和价格可能不同。',
  aliyun: '填写模型支持的音色，例如 Cherry。',
  xfyun: '填写已开通的讯飞发音人，例如 xiaoyan。',
  openai: '填写服务商支持的音色名称或 ID，例如 alloy、nova。',
}[draft.provider]))
const stopPreview = () => { previewController?.abort(); previewController = null; previewing.value = false }
const setDraft = (profile: SpeechProfile) => {
  unsavedDrafts.set(draft.id, { profile: { ...draft }, snapshot: savedSnapshot.value })
  const cached = unsavedDrafts.get(profile.id)
  stopPreview(); Object.assign(draft, cached?.profile || profile); savedSnapshot.value = cached?.snapshot || JSON.stringify(profile); message.value = ''; failed.value = false
}
const chooseProvider = (value: unknown) => {
  const provider = providers.find(item => item.id === value)?.id as SpeechProvider | undefined
  if (provider) setDraft(profiles.value.find(profile => profile.provider === provider) || defaultSpeechProfile(provider))
}
const chooseProfile = (value: unknown) => {
  const profile = profiles.value.find(item => item.id === value)
  if (profile) setDraft(profile)
}
const addProfile = () => setDraft({ ...defaultSpeechProfile(draft.provider), id: `speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: `${providerMeta.value.label} · 新配置` })
const normalizedDraft = (): SpeechProfile => ({
  ...draft, enabled: true, apiKey: draft.apiKey.trim(), secretId: draft.secretId.trim(), secretKey: draft.secretKey.trim(),
  appId: draft.appId.trim(), model: draft.model.trim(), voice: draft.voice.trim(), baseUrl: draft.baseUrl.trim().replace(/\/$/, ''),
  name: draft.name.trim() || providerMeta.value.label, endpoint: draft.endpoint.trim(), signingHost: draft.signingHost.trim(),
})
const save = async () => {
  saving.value = true; message.value = ''; failed.value = false
  try {
    const profile = normalizedDraft()
    validateSpeechProfile(profile)
    const saved = await saveSpeechProfile(profile)
    profiles.value = readSpeechProfiles()
    Object.assign(draft, saved); savedSnapshot.value = JSON.stringify(saved)
    store.updateSettings({ cloudProfileId: saved.id, cloudConfigVersion: saved.updatedAt })
    await store.refreshVoices()
    message.value = '已保存并用于云端朗读'
  } catch (error) { message.value = error instanceof Error ? error.message : '保存失败'; failed.value = true }
  finally { saving.value = false }
}
const preview = async () => {
  if (previewing.value) { stopPreview(); return }
  const controller = new AbortController()
  previewController = controller; previewing.value = true; message.value = ''; failed.value = false
  const engine = new CloudSpeechEngine({ profile: normalizedDraft(), cacheEnabled: false })
  try {
    await engine.speak({ text: '这是普通话语音试听，愿你写作顺利。', voiceId: '', rate: store.settings.rate, pitch: 1, volume: store.settings.volume, signal: controller.signal })
    if (previewController === controller) message.value = '连接成功，试听完成'
  } catch (error) {
    if (previewController === controller && !isAbortError(error)) { message.value = error instanceof Error ? error.message : '试听失败'; failed.value = true }
  } finally {
    engine.stop()
    if (previewController === controller) { previewController = null; previewing.value = false }
  }
}
onBeforeUnmount(stopPreview)
</script>

<style scoped lang="scss">
.cloud-speech-settings { display: grid; gap: 14px; }
.speech-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 14px 20px; }
.speech-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: calc(13px * var(--ui-font-scale, 1)); color: var(--ink-main); }
.speech-field > .el-select { width: 100%; }
.speech-hint { margin: 0; color: var(--ink-sec); line-height: 1.6; font-size: calc(12px * var(--ui-font-scale, 1)); overflow-wrap: anywhere; }
.speech-active { margin: 0; color: var(--ink-main); font-size: calc(12px * var(--ui-font-scale, 1)); }
.speech-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.speech-result { font-size: calc(12px * var(--ui-font-scale, 1)); color: var(--ink-positive); }
.speech-result.is-error { color: var(--state-danger-text, var(--ink-accent)); }
.speech-advanced summary { cursor: pointer; font-size: calc(12px * var(--ui-font-scale, 1)); color: var(--ink-sec); margin-bottom: 8px; }
.speech-advanced > .speech-field, .speech-advanced > .speech-hint { margin-top: 14px; }
.speech-add { justify-self: start; }
</style>
