<template>
  <Teleport to="body">
    <div v-if="visible" class="desktop-update-overlay" @keydown="handleKeydown">
      <section
        ref="dialogRef"
        tabindex="-1"
        class="desktop-update-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
      >
        <div class="desktop-update-layout">
          <div class="desktop-update-main">
            <div class="desktop-update-head">
              <div class="desktop-update-icon">
                <i :class="headIcon"></i>
              </div>
              <div>
                <p class="desktop-update-eyebrow">{{ releaseNotesOnly ? '更新完成' : '客户端更新' }}</p>
                <h2 id="desktop-update-title">{{ title }}</h2>
                <p class="desktop-update-subtitle">{{ subtitle }}</p>
              </div>
            </div>

            <div v-if="state.info" class="version-row">
              <span>{{ state.info.currentVersion || '当前版本' }}</span>
              <i class="fa-solid fa-arrow-right-long"></i>
              <strong>{{ state.info.version }}</strong>
              <small v-if="displayDate">{{ displayDate }}</small>
            </div>

            <div v-if="state.info || releaseNotesOnly" class="release-notes">
              <div class="release-notes-title">更新内容</div>
              <div class="release-notes-body">{{ releaseNotes }}</div>
            </div>

            <div v-if="!releaseNotesOnly && state.phase !== 'available'" class="update-progress" aria-live="polite">
              <div class="progress-meta">
                <span>{{ state.message }}</span>
                <strong v-if="progressPercent !== null">{{ progressPercent }}%</strong>
              </div>
              <div
                class="progress-track"
                :class="{ 'is-indeterminate': progressPercent === null && ['checking', 'downloading'].includes(state.phase) }"
              >
                <div class="progress-fill" :style="{ width: progressPercent === null ? '38%' : `${progressPercent}%` }"></div>
              </div>
              <div v-if="downloadText" class="progress-size">{{ downloadText }}</div>
            </div>

            <div v-if="state.error" class="update-error">
              <i class="fa-solid fa-circle-exclamation"></i>
              <span>{{ state.error }}</span>
            </div>

            <div class="desktop-update-actions">
              <template v-if="state.phase === 'available' && !releaseNotesOnly">
                <button class="ink-btn" type="button" @click="$emit('close')">稍后再说</button>
                <button class="ink-btn ink-btn-primary" type="button" @click="confirmUpdate">立即更新</button>
              </template>
              <button v-else-if="releaseNotesOnly" class="ink-btn ink-btn-primary" type="button" @click="$emit('close')">
                知道了
              </button>
              <template v-else-if="state.phase === 'error'">
                <button class="ink-btn" type="button" @click="$emit('close')">稍后再说</button>
                <button class="ink-btn ink-btn-primary" type="button" @click="$emit('retry')">重新检查</button>
              </template>
              <button v-else-if="state.phase === 'installed'" class="ink-btn ink-btn-primary" type="button" @click="$emit('restart')">
                重启应用
              </button>
              <button v-else class="ink-btn ink-btn-primary" type="button" disabled>
                {{ state.phase === 'checking' ? '检查中...' : '更新中...' }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { DesktopUpdateSnapshot } from '@/utils/desktop-update'
import { inkConfirm } from '@/utils/ink-confirm'

const props = defineProps<{
  visible: boolean
  state: DesktopUpdateSnapshot
  releaseNotesOnly?: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'retry'): void
  (event: 'update'): void
  (event: 'restart'): void
}>()

const dialogRef = ref<HTMLElement | null>(null)
let updateConfirmationOpen = false
const confirmUpdate = async () => {
  if (updateConfirmationOpen || !props.visible || props.releaseNotesOnly || props.state.phase !== 'available') return
  updateConfirmationOpen = true
  try {
    await inkConfirm('确认后将开始下载更新，安装前会保存并备份作品。更新开始后无法取消，安装时应用可能退出，是否继续？', '确认更新', {
      confirmButtonText: '确认更新',
      cancelButtonText: '暂不更新',
      type: 'warning',
      closeOnClickModal: false,
      modalClass: 'desktop-update-confirm-overlay',
    })
    if (props.visible && !props.releaseNotesOnly && props.state.phase === 'available') emit('update')
  } catch {
    // 取消、关闭或按 Escape 时保留更新说明，不开始下载。
  } finally {
    updateConfirmationOpen = false
  }
}
let previousFocus: HTMLElement | null = null
watch(() => props.visible, async visible => {
  if (visible) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    dialogRef.value?.focus()
  } else if (previousFocus?.isConnected) {
    previousFocus.focus()
  }
})
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && (props.releaseNotesOnly || ['available', 'error'].includes(props.state.phase))) {
    event.preventDefault()
    emit('close')
  }
  if (event.key !== 'Tab') return
  const buttons = Array.from(dialogRef.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (!first) {
    event.preventDefault()
    dialogRef.value?.focus()
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.value)) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.value)) {
    event.preventDefault()
    first.focus()
  }
}

const title = computed(() => {
  if (props.releaseNotesOnly) return `已更新到 ${props.state.info?.version || '最新版本'}`
  if (props.state.phase === 'installed') return '更新已安装'
  if (props.state.phase === 'error') return props.state.info ? '更新失败' : '检查更新失败'
  if (props.state.phase === 'checking') return '正在检查更新'
  if (props.state.phase === 'preparing') return '正在保存作品'
  return `发现新版本 ${props.state.info?.version || ''}`
})

const subtitle = computed(() => {
  if (props.releaseNotesOnly) return '以下是本次版本更新内容。'
  if (props.state.phase === 'installed') return '请重启应用后继续使用新版本。'
  if (props.state.phase === 'error') return '可稍后重试，当前版本仍可继续使用。'
  if (props.state.phase === 'checking') return '正在连接更新服务。'
  if (props.state.phase === 'available') return '查看更新内容后，选择立即更新或稍后再说。'
  return '更新期间请保持应用开启，安装前会保存并备份作品。'
})

const headIcon = computed(() => {
  if (props.state.phase === 'error') return 'fa-solid fa-triangle-exclamation'
  if (props.state.phase === 'installed' || props.releaseNotesOnly) return 'fa-solid fa-circle-check'
  if (props.state.phase === 'checking') return 'fa-solid fa-spinner fa-spin'
  return 'fa-solid fa-cloud-arrow-down'
})

const progressPercent = computed(() => {
  const percent = props.state.progress?.percent
  return typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : null
})

const releaseNotes = computed(() => props.state.info?.body?.trim() || '本次更新暂无详细说明。')

const displayDate = computed(() => {
  const raw = props.state.info?.date?.trim()
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ')
})

const formatBytes = (value?: number) => {
  if (!value) return ''
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

const downloadText = computed(() => {
  const progress = props.state.progress
  if (!progress?.downloaded) return ''
  const downloaded = formatBytes(progress.downloaded)
  const total = formatBytes(progress.total)
  return total ? `${downloaded} / ${total}` : `已下载 ${downloaded}`
})
</script>

<style scoped lang="scss">
// 更新说明弹窗使用 20000，确认框必须显示在它上方。
:global(.desktop-update-confirm-overlay) {
  z-index: 20001 !important;
}

.desktop-update-overlay {
  position: fixed;
  inset: 0;
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(21, 18, 15, 0.48);
  backdrop-filter: blur(10px);
}

.desktop-update-card {
  outline: none;
  width: min(560px, calc(100vw - 48px));
  max-height: min(720px, calc(100vh - 48px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 26px;
  border: 1px solid var(--ui-border, rgba(128, 128, 128, 0.18));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-main) 94%, transparent);
  color: var(--ink-main);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.24);
}

.desktop-update-layout {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 22px;
}

.desktop-update-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.desktop-update-head {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.desktop-update-icon {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--ink-accent);
  background: var(--selection-bg-color);

  i {
    font-size: 18px;
  }
}

.desktop-update-eyebrow {
  margin: 0 0 4px;
  color: var(--ink-sec);
  font-size: 12px;
}

h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.25;
  font-weight: 700;
}

.desktop-update-subtitle {
  margin: 8px 0 0;
  color: var(--ink-sec);
  font-size: 13px;
  line-height: 1.6;
}

.version-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-main) 5%, transparent);
  font-size: 13px;

  span,
  strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  i {
    flex: 0 0 auto;
    color: var(--ink-sec);
    font-size: 12px;
  }

  strong {
    color: var(--ink-accent);
  }

  small {
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--ink-sec);
    font-size: 12px;
  }
}

.release-notes {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.release-notes-title {
  color: var(--ink-sec);
  font-size: 13px;
}

.release-notes-body {
  max-height: 220px;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid var(--ui-border, rgba(128, 128, 128, 0.18));
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-main) 80%, transparent);
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-wrap;
}

.update-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--ink-sec);
  font-size: 13px;

  strong {
    color: var(--ink-accent);
  }
}

.progress-track {
  position: relative;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--progress-track-bg, rgba(128, 128, 128, 0.18));
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--ink-accent);
  transition: width 0.2s ease;
}

.progress-track.is-indeterminate .progress-fill {
  position: absolute;
  left: -38%;
  animation: update-progress-slide 1.2s ease-in-out infinite;
}

.progress-size {
  color: var(--ink-sec);
  font-size: 12px;
}

.update-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--state-danger-surface);
  color: var(--state-danger-on);
  font-size: 13px;
}

.desktop-update-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: auto;

  .ink-btn {
    &:focus-visible {
      outline: 2px solid var(--ink-accent);
      outline-offset: 3px;
    }
    min-width: 112px;

    &:disabled {
      cursor: wait;
      opacity: 0.75;
    }
  }
}

@media (max-width: 720px), (max-height: 680px) {
  .desktop-update-overlay {
    align-items: flex-start;
    overflow-y: auto;
  }

  .desktop-update-card {
    width: min(560px, calc(100vw - 32px));
    max-height: none;
    margin: auto 0;
    padding: 20px;
  }
}

@keyframes update-progress-slide {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(360%);
  }
}
</style>
