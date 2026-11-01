<template>
  <section class="breakdown-task-card" :class="`is-${view.status}`" :data-task-id="view.id" :aria-label="`${kindLabel}任务`">
    <header class="task-head">
      <strong>《{{ view.title }}》 · {{ view.scope }}</strong>
      <span class="task-status" :class="view.status" role="status">{{ view.statusLabel }}</span>
    </header>
    <div
      class="task-bar"
      role="progressbar"
      :aria-valuenow="view.percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="`已完成 ${view.percent}%`"
    >
      <span :style="{ width: `${view.percent}%` }" :class="{ 'is-active': view.active }"></span>
    </div>
    <p class="task-numbers">
      <span v-for="(item, index) in view.numbers" :key="index">{{ item }}</span>
    </p>
    <p v-if="view.active && view.current" class="task-current" aria-live="polite">
      <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>{{ view.current }}
    </p>
    <p v-else-if="view.hint" class="task-hint">{{ view.hint }}</p>
    <p v-if="view.error" class="task-error">{{ view.error }}</p>
    <div v-if="view.status === 'completed' && view.summary.length" class="task-summary">
      <strong>{{ view.summaryTitle }}</strong>
      <p v-for="(line, index) in view.summary" :key="index">{{ line }}</p>
    </div>
    <footer class="task-actions">
      <button
        v-if="view.actions.pause"
        type="button"
        class="ink-btn ink-btn-outline ink-btn-sm"
        :disabled="busy"
        @click="control('pause')"
      >
        暂停
      </button>
      <button
        v-if="view.actions.resume"
        type="button"
        class="ink-btn ink-btn-primary ink-btn-sm"
        :disabled="busy"
        @click="control('resume')"
      >
        {{ view.actions.retry ? '重试' : '继续' }}
      </button>
      <button v-if="view.actions.cancel" type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="cancel">
        取消
      </button>
      <label v-if="view.actions.autoContinue" class="task-toggle">
        <input type="checkbox" :checked="view.autoContinue" :disabled="busy" @change="toggleAuto" />
        <span>完成后自动让 Agent 接着说</span>
      </label>
      <button
        v-if="view.actions.continueNow"
        type="button"
        class="ink-btn ink-btn-primary ink-btn-sm"
        @click="$emit('continue', view)"
      >
        让 Agent 接着说
      </button>
      <button
        v-if="view.result"
        type="button"
        class="ink-btn ink-btn-outline ink-btn-sm task-report"
        :aria-pressed="opened"
        @click="$emit('open-result', { kind: view.kind, id: view.result.id })"
      >
        {{ opened ? '已在右侧打开' : view.result.label }}
      </button>
    </footer>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { controlTask, setTaskAutoContinue, type PiTaskAction, type PiTaskKind, type PiTaskView } from '@/agent-pi/tasks'

const props = defineProps<{ view: PiTaskView; opened?: boolean }>()
defineEmits<{ (event: 'open-result', result: { kind: PiTaskKind; id: string }): void; (event: 'continue', view: PiTaskView): void }>()
const KIND_LABELS: Record<PiTaskKind, string> = { breakdown: '拆书', distillation: '蒸馏', batch: '批量写作', cover: '封面' }
const kindLabel = computed(() => KIND_LABELS[props.view.kind])
const busy = ref(false)
async function control(action: PiTaskAction) {
  busy.value = true
  try {
    await controlTask(props.view.kind, props.view.id, action)
  } catch (error) {
    ElMessage.error(String(error instanceof Error ? error.message : error))
  } finally {
    busy.value = false
  }
}
async function cancel() {
  try {
    await inkConfirm(props.view.cancelText, props.view.cancelTitle, {
      confirmButtonText: props.view.cancelTitle,
      cancelButtonText: '继续',
      type: 'warning'
    })
  } catch {
    return
  }
  await control('cancel')
}
async function toggleAuto(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  try {
    await setTaskAutoContinue(props.view.kind, props.view.id, checked)
  } catch (error) {
    ElMessage.error(String(error instanceof Error ? error.message : error))
  }
}
</script>
<style scoped>
.breakdown-task-card {
  margin: 14px 0;
  padding: 16px 18px 14px;
  border: 1px solid var(--divider, #ddd9d1);
  border-radius: 12px;
  color: var(--ink-main, #241f1b);
  background: var(--popover-bg, #fcfbf7);
  font-size: calc(0.875rem * var(--ui-font-scale, 1));
  line-height: 1.7;
}
.task-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.task-head strong {
  overflow-wrap: anywhere;
}
.task-status {
  flex-shrink: 0;
  padding: 1px 10px;
  border-radius: 999px;
  font-size: calc(0.75rem * var(--ui-font-scale, 1));
  color: var(--ink-sec, #655e56);
  background: var(--overlay-hover, rgba(36, 31, 27, 0.06));
}
.task-status.running,
.task-status.pausing,
.task-status.waiting {
  color: var(--ink-accent, #7a3028);
  background: var(--accent-soft, #f1e3df);
}
.task-status.completed {
  color: var(--state-success-on, #2f6b3c);
  background: var(--state-success-surface, #e6f1e7);
}
.task-bar {
  position: relative;
  height: 6px;
  margin: 12px 0 8px;
  border-radius: 999px;
  background: var(--overlay-hover, rgba(36, 31, 27, 0.08));
  overflow: hidden;
}
.task-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--ink-accent, #7a3028);
  transition: width 0.6s ease;
}
.task-bar > span.is-active::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.35) 50%, transparent 100%);
  animation: task-shimmer 1.6s linear infinite;
}
@keyframes task-shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}
.task-numbers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  color: var(--ink-sec, #655e56);
  font-size: calc(0.8125rem * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}
.task-current {
  margin: 8px 0 0;
  color: var(--ink-main, #241f1b);
}
.task-current > i {
  margin-right: 8px;
  color: var(--ink-accent, #7a3028);
  font-size: calc(0.75rem * var(--ui-font-scale, 1));
}
.task-hint {
  margin: 8px 0 0;
  color: var(--ink-sec, #655e56);
  font-size: calc(0.8125rem * var(--ui-font-scale, 1));
}
.task-error {
  margin: 8px 0 0;
  color: var(--ink-accent, #7a3028);
}
.task-summary {
  margin-top: 10px;
}
.task-summary > strong {
  display: block;
  margin-bottom: 2px;
}
.task-summary > p {
  margin: 4px 0;
}
.task-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 12px;
}
.task-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-sec, #655e56);
  font-size: calc(0.8125rem * var(--ui-font-scale, 1));
  cursor: pointer;
}
.task-toggle > input {
  accent-color: var(--ink-accent, #7a3028);
}
.task-report {
  margin-left: auto;
}
button:focus-visible {
  outline: 2px solid var(--ink-accent, #7a3028);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .task-bar > span,
  .task-bar > span.is-active::after {
    transition: none;
    animation: none;
  }
}
</style>
