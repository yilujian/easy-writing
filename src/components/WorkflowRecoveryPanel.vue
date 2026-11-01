<template>
  <section v-if="visibleDrafts.length || loadError" class="workflow-recovery" aria-label="生成进度与恢复草稿">
    <p v-if="loadError" role="alert">{{ loadError }}</p>
    <article v-for="draft in visibleDrafts" :key="draft.id" class="workflow-recovery__item">
      <div class="workflow-recovery__head">
        <strong>{{ draft.label }}</strong>
        <span>{{ running(draft) ? '正在生成' : draft.complete ? '结果待接回' : '未完成草稿' }}</span>
      </div>
      <p aria-live="polite">{{ describe(draft) }}</p>
      <p v-if="draft.persistenceError" class="workflow-recovery__warning" role="alert">
        {{ draft.persistenceError }}
      </p>
      <button
        v-if="canResume && draft.taskId && draft.key.startsWith('step:') && !running(draft)"
        type="button"
        class="ink-btn ink-btn-ghost ink-btn-sm"
        :disabled="busy"
        @click="$emit('resume', draft)"
      >
        重试此步骤
      </button>
      <template v-if="draft.content || draft.rawResponse">
        <div class="workflow-recovery__actions">
          <details>
            <summary>查看已接收的草稿</summary>
            <pre>{{ (draft.content || draft.rawResponse || '').slice(0, 20000) }}</pre>
            <small v-if="(draft.content || draft.rawResponse || '').length > 20000"
              >预览只展示前 20000 字，导出包含全部内容。</small
            >
          </details>
          <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" @click="exportDraft(draft)">
            导出草稿
          </button>
        </div>
        <small v-if="!running(draft)">{{
          draft.key.startsWith('content:')
            ? '正文可通过“继续生成”接续，原稿和已完成章节保留。'
            : '重试相同要求时会沿用这份草稿；草稿尚未作为正式结果采用。'
        }}</small>
      </template>
    </article>
    <button
      v-if="drafts.length > 3"
      class="ink-btn ink-btn-ghost ink-btn-sm"
      type="button"
      @click="showAll = !showAll"
    >
      {{ showAll ? '收起较早草稿' : `查看其余 ${drafts.length - 3} 份草稿` }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { WorkflowAiDraft } from '@/types/workflow-ai'
import { isWorkflowAiRunning, readWorkflowAiDrafts } from '@/utils/workflow-ai'
import { saveBlobFile } from '@/utils/download'

const props = defineProps<{ runId: number; draftKey?: string; canResume?: boolean; busy?: boolean }>()
defineEmits<{ (event: 'resume', draft: WorkflowAiDraft): void }>()
const drafts = ref<WorkflowAiDraft[]>([])
const showAll = ref(false)
const now = ref(Date.now())
const loadError = ref('')
const visibleDrafts = computed(() => (showAll.value ? drafts.value : drafts.value.slice(0, 3)))
const running = (draft: WorkflowAiDraft) =>
  draft.status === 'running' && isWorkflowAiRunning(draft.runId, draft.key, draft.id)
const describe = (draft: WorkflowAiDraft) => {
  if (!running(draft))
    return draft.content || draft.rawResponse
      ? `已保留 ${(draft.content || draft.rawResponse || '').length} 字${draft.rawResponse ? '原始响应' : ''}${draft.error ? ` · ${draft.error}` : ''}`
      : draft.error || '上次生成已中断，尚未收到正文，可重试生成。'
  const seconds = Math.max(0, Math.floor((now.value - draft.startedAt) / 1000))
  const progress =
    draft.phase === 'thinking'
      ? '模型正在思考'
      : draft.content
        ? `已接收 ${draft.content.length} 字，正在保存草稿`
        : draft.rawResponse?.trim()
          ? '正在接收完整结果，原始响应已暂存'
          : '等待模型返回内容'
  return `${progress} · 已等待 ${seconds} 秒，可随时停止`
}
let loading = false
let disposed = false
const refresh = async () => {
  now.value = Date.now()
  if (loading) return
  if (!props.runId) {
    drafts.value = []
    return
  }
  const runId = props.runId
  loading = true
  try {
    const records = await readWorkflowAiDrafts(runId)
    if (!disposed && runId === props.runId) {
      drafts.value = records.filter(
        record => record.status !== 'applied' && !record.key.startsWith('generation:') && (!props.draftKey || record.key === props.draftKey)
      )
      loadError.value = ''
    }
  } catch {
    loadError.value = '暂时无法读取恢复草稿，请检查本地存储后重试。'
  } finally {
    loading = false
  }
}
const exportDraft = async (draft: WorkflowAiDraft) => {
  try {
    await saveBlobFile(
      new Blob([draft.content || draft.rawResponse || ''], { type: 'text/plain;charset=utf-8' }),
      `易创-${draft.label.replace(/[\\/:*?"<>|]/g, '-')}-恢复草稿-${Math.abs(draft.id)}.txt`
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导出草稿失败')
  }
}
let timer: ReturnType<typeof setInterval> | undefined
watch(
  () => [props.runId, props.draftKey],
  () => {
    drafts.value = []
    void refresh()
  }
)
onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 1500)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(timer)
})
</script>

<style scoped>
.workflow-recovery {
  margin: 12px 0;
  padding: 14px 16px;
  border: 1px solid var(--divider);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.workflow-recovery__item + .workflow-recovery__item {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--divider);
}
.workflow-recovery__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.workflow-recovery__head span,
.workflow-recovery small {
  color: var(--ink-sec);
}
.workflow-recovery p {
  margin: 8px 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.workflow-recovery__warning {
  color: var(--state-danger);
}
.workflow-recovery__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: start;
  gap: 10px;
  margin: 10px 0;
}
.workflow-recovery details {
  flex: 1;
  min-width: 150px;
}
.workflow-recovery summary {
  cursor: pointer;
  padding: 5px 0;
}
.workflow-recovery button {
  color: var(--ink-main);
  background: var(--surface-2);
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
  cursor: pointer;
}
.workflow-recovery button:disabled {
  opacity: 0.5;
  cursor: default;
}
.workflow-recovery button:focus-visible,
.workflow-recovery summary:focus-visible {
  outline: 2px solid var(--ink-accent);
  outline-offset: 3px;
}
.workflow-recovery pre {
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.6;
}
</style>
