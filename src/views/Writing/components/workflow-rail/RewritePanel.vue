<template>
  <section class="rail-form-panel rewrite-panel" aria-label="重写本章">
    <div class="rail-form-body custom-scroll">
      <!-- 无章节可重写 -->
      <div v-if="flow.phase === 'input' && !activeChapterId" class="rail-form-empty">
        <i class="fa-solid fa-rotate"></i>
        <strong>暂无可重写的章节</strong>
        <span>先在左侧目录打开一章，再回到这里发起重写。</span>
      </div>

      <!-- 输入阶段 -->
      <template v-else-if="flow.phase === 'input'">
        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>重写本章</strong>
            <span>按你的意见重新生成本章正文，生成后先对比再决定是否应用。</span>
          </div>

          <p class="rewrite-chapter">
            <i class="fa-regular fa-file-lines"></i>
            {{ chapterTitle || '当前章节' }}
          </p>

          <p v-if="!canRewrite" class="rewrite-blocked">
            <i class="fa-solid fa-circle-info"></i>
            {{ disabledReason }}
          </p>

          <p v-if="flow.errorMessage" class="rewrite-error">
            <i class="fa-solid fa-circle-exclamation"></i>
            {{ flow.errorMessage }}
          </p>

          <div class="rewrite-mode" role="radiogroup" aria-label="重写范围">
            <button
              type="button"
              role="radio"
              :aria-checked="rewriteMode === 'content'"
              :class="{ active: rewriteMode === 'content' }"
              :disabled="!canRewrite"
              @click="rewriteMode = 'content'"
            >
              <strong>只重写正文</strong>
              <span>保留当前标题、章纲和详细细纲</span>
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="rewriteMode === 'plot'"
              :class="{ active: rewriteMode === 'plot' }"
              :disabled="!canRewrite"
              @click="rewriteMode = 'plot'"
            >
              <strong>重写剧情</strong>
              <span>先生成新章纲，确认后再写正文</span>
            </button>
          </div>

          <label class="rewrite-field-label" for="rewrite-instruction">补充要求（选填）</label>
          <div class="rail-textarea-wrap">
            <textarea
              id="rewrite-instruction"
              v-model="instruction"
              class="ink-input rail-textarea rewrite-textarea"
              rows="5"
              :maxlength="INSTRUCTION_MAX"
              :disabled="!canRewrite"
              placeholder="例如：打斗收短一点，多写心理"
            ></textarea>
            <span class="rail-textarea-count">{{ instruction.length }} / {{ INSTRUCTION_MAX }}</span>
          </div>

          <label
            class="rewrite-rule-check"
            :class="{ 'is-disabled': !canRewrite || !instruction.trim() }"
          >
            <input
              v-model="addToRules"
              type="checkbox"
              :disabled="!canRewrite || !instruction.trim()"
            />
            <i :class="addToRules && instruction.trim() ? 'fa-solid fa-square-check' : 'fa-regular fa-square'"></i>
            <span>同时加入写作规则（以后每章都遵守）</span>
          </label>
        </section>
      </template>

      <!-- 剧情重写先确认新章纲 -->
      <template v-else-if="flow.phase === 'outline'">
        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>确认新章纲</strong>
            <span>确认后才会生成正文；丢弃会恢复原章纲与原正文。</span>
          </div>
          <article class="rewrite-outline-card">
            <strong>{{ flow.outlineTitle || flow.chapterTitle || '新章纲' }}</strong>
            <p>{{ flow.outlineSummary || '新章纲没有有效摘要，请丢弃后重试。' }}</p>
          </article>
        </section>
      </template>

      <!-- 生成中阶段 -->
      <template v-else-if="flow.phase === 'generating'">
        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>
              <i class="fa-solid fa-circle-notch fa-spin rewrite-spin"></i>
              正在重写
            </strong>
            <span>{{ flow.chapterTitle || '当前章节' }}</span>
          </div>

          <div class="rewrite-progress-meta">
            <span>{{ flow.statusMessage || 'AI 正在按要求重写本章…' }}</span>
            <strong>{{ flow.progress }}%</strong>
          </div>
          <div
            class="rewrite-progress"
            role="progressbar"
            aria-label="重写进度"
            :aria-valuenow="flow.progress"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${flow.progress}%` }"></span>
          </div>

          <details v-if="flow.instruction" class="rewrite-request-summary" open>
            <summary>本次要求</summary>
            <p>{{ flow.instruction }}</p>
            <p v-if="flow.addToRules" class="rewrite-request-rule">
              <i class="fa-solid fa-square-check"></i>
              已同时加入写作规则
            </p>
          </details>
        </section>
      </template>

      <!-- 候选对比阶段 -->
      <template v-else>
        <section class="rail-form-section">
          <div class="rail-form-section-title">
            <strong>
              重写候选
              <em class="rewrite-badge">未应用</em>
            </strong>
            <span>{{ flow.chapterTitle || '当前章节' }}</span>
          </div>

          <div class="rewrite-view-switch" role="tablist" aria-label="候选对比视图">
            <button
              v-for="option in VIEW_OPTIONS"
              :key="option.value"
              type="button"
              role="tab"
              :aria-selected="viewMode === option.value"
              :class="{ active: viewMode === option.value }"
              @click="viewMode = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <div v-if="viewMode === 'compare'" class="rewrite-compare">
            <article class="rewrite-compare-card">
              <header>
                <strong>原稿</strong>
                <span>{{ originalWords.toLocaleString() }} 字</span>
              </header>
              <p>{{ originalExcerpt || '（无内容）' }}</p>
            </article>
            <article class="rewrite-compare-card is-candidate">
              <header>
                <strong>候选</strong>
                <span>{{ candidateWords.toLocaleString() }} 字</span>
              </header>
              <p>{{ candidateExcerpt || '（无内容）' }}</p>
            </article>
          </div>
          <div v-else class="rewrite-fulltext custom-scroll">
            <p v-for="(paragraph, index) in fullTextParagraphs" :key="index">{{ paragraph }}</p>
            <p v-if="!fullTextParagraphs.length" class="is-empty">（无内容）</p>
          </div>

          <details v-if="flow.instruction" class="rewrite-request-summary">
            <summary>本次要求</summary>
            <p>{{ flow.instruction }}</p>
          </details>
        </section>
      </template>
    </div>

    <footer v-if="flow.phase === 'input' && activeChapterId" class="rail-form-footer">
      <p class="rail-form-footer-hint">生成一次重写候选；当前正文自动留存历史版本，不会丢失。</p>
      <button
        type="button"
        class="ink-btn ink-btn-primary rewrite-footer-btn"
        :disabled="!canRewrite || submitting"
        @click="submitRewrite"
      >
        <i :class="submitting ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"></i>
        {{ submitting ? '正在提交' : '生成重写候选' }}
      </button>
    </footer>
    <footer v-else-if="flow.phase === 'generating'" class="rail-form-footer">
      <p class="rail-form-footer-hint">停止后正文保持不变，不会产生候选。</p>
      <button
        type="button"
        class="ink-btn ink-btn-outline rewrite-footer-btn"
        :disabled="actionPending"
        @click="stopRewrite"
      >
        <i class="fa-solid fa-stop"></i>
        停止重写
      </button>
    </footer>
    <footer v-else-if="flow.phase === 'outline'" class="rail-form-footer">
      <p class="rail-form-footer-hint">此时尚未生成或覆盖新正文。</p>
      <div class="rail-form-footer-actions">
        <button
          type="button"
          class="ink-btn ink-btn-outline"
          :disabled="actionPending"
          @click="discardOutline"
        >
          丢弃新章纲
        </button>
        <button
          type="button"
          class="ink-btn ink-btn-primary"
          :disabled="actionPending"
          @click="acceptOutline"
        >
          确认章纲并生成正文
        </button>
      </div>
    </footer>
    <footer v-else-if="flow.phase === 'candidate'" class="rail-form-footer">
      <p class="rail-form-footer-hint">应用后候选成为本章正文；丢弃则恢复原正文，两种选择都保留历史版本。</p>
      <div class="rail-form-footer-actions">
        <button
          type="button"
          class="ink-btn ink-btn-outline"
          :disabled="actionPending"
          @click="discardCandidate"
        >
          丢弃
        </button>
        <button
          type="button"
          class="ink-btn ink-btn-primary"
          :disabled="actionPending"
          @click="applyCandidate"
        >
          <i v-if="actionPending" class="fa-solid fa-spinner fa-spin"></i>
          应用候选
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
/**
 * 单章重写面板（批次三 3A 用户意见回流）。
 *
 * 三段式交互与 WorkflowBook 的调整抽屉同构：输入要求 → 生成中 → 候选对比。
 * 服务端契约：POST /writing/workflow/chapter/rewrite 发起（响应含 taskId），
 * 进度轮询复用既有 /writing/workflow/task/status，应用与丢弃走
 * /writing/workflow/chapter/rewrite/apply|discard（携带候选正文版本做乐观锁）。
 *
 * 流程状态放在模块级：面板随工具栏收起会被卸载，进行中的重写不能因此丢失；
 * 重新挂载或激活后继续接管同一任务的轮询。
 */
import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { WorkflowTask, WorkflowChapterRewriteMode } from '@/types/workflow'
// 开源版：单章重写走本地引擎（候选生成在本进程后台跑，轮询与应用语义不变）
import { getLocalWorkflowTaskStatus as getWorkflowTaskStatusApi } from '@/storage/local-workflow'
import {
  applyLocalWorkflowChapterRewrite as applyWorkflowChapterRewriteApi,
  cancelLocalWorkflowTask as cancelWorkflowTaskApi,
  confirmLocalPlotRewriteOutline as confirmWorkflowPlotRewriteOutlineApi,
  discardLocalWorkflowChapterRewrite as discardWorkflowChapterRewriteApi,
  rewriteLocalWorkflowChapter as rewriteWorkflowChapterApi,
} from '@/utils/local-workflow-control'
import { getLocalChapterDetailById as getChapterDetailApi } from '@/storage/local-book-bridge'
import {
  isWorkflowChapterManualEditable,
  useWorkflowWritingSessionSnapshot,
} from '../../composables/useWorkflowWritingSession'
import { countWords } from '@/utils/word-count'

const props = defineProps<{
  chapterId: number | null
  chapterTitle: string
}>()

const INSTRUCTION_MAX = 500
const POLL_INTERVAL_MS = 4000
const EXCERPT_LENGTH = 160
/** 重写任务完成态：停机等确认或直接成功都视为候选就绪。 */
const REWRITE_DONE_STATUSES = new Set(['review_required', 'succeeded'])
const REWRITE_FAILED_STATUSES = new Set(['failed', 'interrupted', 'canceled'])

const VIEW_OPTIONS = [
  { value: 'compare', label: '摘要对比' },
  { value: 'original', label: '原稿全文' },
  { value: 'candidate', label: '候选全文' },
] as const

type RewritePhase = 'input' | 'generating' | 'outline' | 'candidate'
type RewriteViewMode = (typeof VIEW_OPTIONS)[number]['value']

interface RewriteFlowState {
  phase: RewritePhase
  /** 任务终态：succeeded=已自动确认，review_required=待人工确认 */
  taskStatus: string
  chapterId: number
  chapterTitle: string
  taskId: number
  instruction: string
  addToRules: boolean
  rewriteMode: WorkflowChapterRewriteMode
  progress: number
  statusMessage: string
  originalText: string
  originalVersion: number
  candidateText: string
  candidateVersion: number
  errorMessage: string
  outlineTitle: string
  outlineSummary: string
}

const createFlowState = (): RewriteFlowState => ({
  taskStatus: '',
  phase: 'input',
  chapterId: 0,
  chapterTitle: '',
  taskId: 0,
  instruction: '',
  addToRules: false,
  rewriteMode: 'content',
  progress: 0,
  statusMessage: '',
  originalText: '',
  originalVersion: 0,
  candidateText: '',
  candidateVersion: 0,
  errorMessage: '',
  outlineTitle: '',
  outlineSummary: '',
})

// 模块级流程状态：面板卸载重挂后仍能接管进行中的重写任务。
const flow = reactive<RewriteFlowState>(createFlowState())
// 输入草稿同样跨挂载保留，切换工具栏不丢已填写的要求。
const instruction = ref('')
const addToRules = ref(false)
const rewriteMode = ref<WorkflowChapterRewriteMode>('content')

const resetFlow = (keepError = '') => {
  Object.assign(flow, createFlowState())
  flow.errorMessage = keepError
}

const submitting = ref(false)
const actionPending = ref(false)
const viewMode = ref<RewriteViewMode>('compare')

const snapshot = useWorkflowWritingSessionSnapshot()

const activeChapterId = computed(() => Number(props.chapterId || 0))
const chapterTitle = computed(() => String(props.chapterTitle || '').trim())

// 与编辑器段落改写共用同一套解禁判定：停机等确认或无进行中生成任务时可重写。
/**
 * 书级互斥（与服务端 rewrite 守卫同口径）：排队/生成中/待确认任务存在时，
 * 服务端会拒绝新的重写任务——提前置灰并说明，而不是让用户点了才吃 409。
 * 注意它比"手动编辑解禁"更严：待确认时可以改正文，但不能再起生成任务。
 */
const REWRITE_BUSY_STATUSES = ['queued', 'running', 'review_required']
const bookBusyForRewrite = computed(
  () => snapshot.enabled && REWRITE_BUSY_STATUSES.includes(String(snapshot.taskStatus || ''))
)

const canRewrite = computed(
  () =>
    activeChapterId.value !== 0 &&
    !bookBusyForRewrite.value &&
    isWorkflowChapterManualEditable(activeChapterId.value)
)

const disabledReason = computed(() => {
  if (!snapshot.enabled || !snapshot.taskStatus) {
    return '工作流任务状态确认中，确认完成后可发起重写。'
  }
  if (String(snapshot.taskStatus) === 'review_required') {
    return '有章节正等待确认，请先在"任务"面板处理（接受/重写/停止）后再发起重写。'
  }
  if (['generating', 'recovering'].includes(snapshot.controlState)) {
    return '自动生成进行中，本章暂不能重写；等本轮生成停下后再来。'
  }
  return '本章是当前任务的断点章节，继续生成或停止任务后可重写。'
})

const countPlainWords = (value: string) => countWords(value)
const buildExcerpt = (value: string) => {
  const text = value.trim()
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text
}

const originalWords = computed(() => countPlainWords(flow.originalText))
const candidateWords = computed(() => countPlainWords(flow.candidateText))
const originalExcerpt = computed(() => buildExcerpt(flow.originalText))
const candidateExcerpt = computed(() => buildExcerpt(flow.candidateText))

const fullTextParagraphs = computed(() => {
  const text = viewMode.value === 'original' ? flow.originalText : flow.candidateText
  return text
    .split(/\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
})

let pollTimer: number | null = null

const stopPolling = () => {
  if (pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

const notifyChapterContentRefresh = () => {
  if (!flow.chapterId) return
  // 打开着本章的编辑器需要主动重载正文；目录字数等元信息一并补刷。
  window.dispatchEvent(
    new CustomEvent('ew-writing-chapter-content-refresh', {
      detail: { chapterId: flow.chapterId },
    })
  )
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
}

const failFlow = (message: string) => {
  stopPolling()
  const instructionDraft = flow.instruction
  resetFlow(message)
  // 失败后回到输入阶段并保留原要求，方便修改后重试。
  if (instructionDraft && !instruction.value) instruction.value = instructionDraft
}

const resolveCandidate = async (task: WorkflowTask) => {
  stopPolling()
  try {
    const { data: detail } = await getChapterDetailApi({ id: flow.chapterId })
    flow.candidateText = String(detail?.textContent || '')
    // 候选版本优先取任务回带的质检快照，缺省回落章节详情的当前版本。
    flow.candidateVersion = Number(
      task.payload?.qualityReview?.contentVersion || detail?.contentVersion || 0
    )
    flow.phase = 'candidate'
    flow.statusMessage = ''
    viewMode.value = 'compare'
    notifyChapterContentRefresh()
  } catch {
    failFlow('候选已生成，但读取候选正文失败；可刷新页面后在章节历史中查看。')
  }
}

const syncRewriteTask = async () => {
  if (!flow.taskId || flow.phase !== 'generating') {
    stopPolling()
    return
  }
  try {
    const { data } = await getWorkflowTaskStatusApi(flow.taskId)
    if (Number(data.id) !== flow.taskId || flow.phase !== 'generating') return
    flow.progress = Math.max(0, Math.min(100, Math.round(Number(data.progress || 0))))
    if (data.currentChapterTitle) {
      flow.statusMessage = `正在重写《${data.currentChapterTitle}》`
    }
    const status = String(data.status || '')
    if (status === 'review_required' && data.payload?.plotOutlineReview) {
      stopPolling()
      flow.taskStatus = status
      flow.outlineTitle = String(data.payload.plotOutlineReview.chapterTitle || '')
      flow.outlineSummary = String(data.payload.plotOutlineReview.chapterSummary || '')
      flow.phase = 'outline'
      return
    }
    if (REWRITE_DONE_STATUSES.has(status)) {
      // succeeded=无阻断已自动确认（应用即无操作）；review_required=待人工确认
      flow.taskStatus = status
      await resolveCandidate(data)
      return
    }
    if (REWRITE_FAILED_STATUSES.has(status)) {
      failFlow(
        String(data.errorMessage || '') ||
          (status === 'canceled' ? '重写已停止，正文保持不变。' : '重写任务失败，正文保持不变。')
      )
    }
  } catch {
    // 单次轮询失败静默跳过，下一轮继续；任务本身在服务端持续执行。
  }
}

const startPolling = () => {
  stopPolling()
  void syncRewriteTask()
  pollTimer = window.setInterval(() => void syncRewriteTask(), POLL_INTERVAL_MS)
}

const submitRewrite = async () => {
  const chapterId = activeChapterId.value
  if (!chapterId || !canRewrite.value || submitting.value || flow.phase !== 'input') return
  submitting.value = true
  try {
    // 先捕获当前正文作为对比基线；重写完成后与候选并排展示。
    const { data: detail } = await getChapterDetailApi({ id: chapterId })
    const originalText = String(detail?.textContent || '')
    const originalVersion = Number(detail?.contentVersion || 0)
    const instructionText = instruction.value.trim().slice(0, INSTRUCTION_MAX)
    const { data } = await rewriteWorkflowChapterApi({
      chapterId,
      mode: rewriteMode.value,
      ...(instructionText ? { instruction: instructionText } : {}),
      ...(instructionText && addToRules.value ? { addToRules: true } : {}),
    })
    const taskId = Number(data?.task?.id || data?.taskId || data?.id || 0)
    if (!taskId) throw new Error('重写任务未返回任务标识')
    resetFlow()
    flow.phase = 'generating'
    flow.chapterId = chapterId
    flow.chapterTitle = chapterTitle.value || String(data?.currentChapterTitle || '')
    flow.taskId = taskId
    flow.instruction = instructionText
    flow.addToRules = Boolean(instructionText) && addToRules.value
    flow.rewriteMode = rewriteMode.value
    flow.originalText = originalText
    flow.originalVersion = originalVersion
    startPolling()
  } catch (error) {
    const message = String(error?.message || '发起重写失败')
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

const acceptOutline = async () => {
  if (actionPending.value || flow.phase !== 'outline') return
  actionPending.value = true
  try {
    await confirmWorkflowPlotRewriteOutlineApi({
      taskId: flow.taskId,
      action: 'accept',
    })
    flow.phase = 'generating'
    flow.taskStatus = 'queued'
    flow.statusMessage = '章纲已确认，正在生成正文…'
    startPolling()
  } catch (error) {
    ElMessage.error(String(error?.message || '确认新章纲失败'))
  } finally {
    actionPending.value = false
  }
}

const discardOutline = async () => {
  if (actionPending.value || flow.phase !== 'outline') return
  actionPending.value = true
  try {
    await confirmWorkflowPlotRewriteOutlineApi({
      taskId: flow.taskId,
      action: 'discard',
      contentVersion: flow.originalVersion,
    })
    ElMessage.success('已丢弃新章纲，恢复原章纲与原正文')
    notifyChapterContentRefresh()
    resetFlow()
  } catch (error) {
    ElMessage.error(String(error?.message || '丢弃新章纲失败'))
  } finally {
    actionPending.value = false
  }
}

const stopRewrite = async () => {
  if (!flow.taskId || actionPending.value) return
  actionPending.value = true
  try {
    await cancelWorkflowTaskApi({ taskId: flow.taskId })
    // 终态由轮询确认；这里立即再同步一次，尽快回到输入阶段。
    await syncRewriteTask()
  } catch (error) {
    ElMessage.error(String(error?.message || '停止重写失败'))
  } finally {
    actionPending.value = false
  }
}

const applyCandidate = async () => {
  if (actionPending.value || flow.phase !== 'candidate') return
  actionPending.value = true
  try {
    // 无阻断的候选服务端已自动确认落库；仅待确认态需要走 review accept。
    if (flow.taskStatus === 'review_required') {
      await applyWorkflowChapterRewriteApi({
        taskId: flow.taskId,
        contentVersion: flow.candidateVersion,
      })
    }
    ElMessage.success('已应用重写候选')
    notifyChapterContentRefresh()
    instruction.value = ''
    addToRules.value = false
    resetFlow()
  } catch (error) {
    ElMessage.error(String(error?.message || '应用重写候选失败'))
  } finally {
    actionPending.value = false
  }
}

const discardCandidate = async () => {
  if (actionPending.value || flow.phase !== 'candidate') return
  actionPending.value = true
  try {
    await discardWorkflowChapterRewriteApi({
      taskId: flow.taskId,
      contentVersion: flow.candidateVersion,
    })
    ElMessage.success('已丢弃候选，正文恢复原版本')
    notifyChapterContentRefresh()
    const instructionDraft = flow.instruction
    resetFlow()
    // 丢弃后保留上次要求，便于调整后再试一版。
    if (instructionDraft) instruction.value = instructionDraft
  } catch (error) {
    ElMessage.error(String(error?.message || '丢弃重写候选失败'))
  } finally {
    actionPending.value = false
  }
}

const resumePollingIfNeeded = () => {
  if (flow.phase === 'generating' && flow.taskId && pollTimer === null) startPolling()
}

// 面板被切走或收起时任务仍在服务端执行；重新挂载/激活后接管轮询。
onMounted(resumePollingIfNeeded)
onActivated(resumePollingIfNeeded)
onBeforeUnmount(stopPolling)
</script>

<style scoped lang="scss">
@use './rail-form';

.rewrite-chapter {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--ink-accent) 7%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;

  i {
    color: var(--ink-accent);
  }
}

.rewrite-blocked {
  margin: 0 0 12px;
  padding: 9px 10px;
  border-radius: 7px;
  color: var(--state-warning-on);
  background: var(--state-warning-surface);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.rewrite-error {
  margin: 0 0 12px;
  padding: 9px 10px;
  border-radius: 7px;
  color: var(--state-danger-on);
  background: var(--state-danger-surface);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.rewrite-field-label {
  display: block;
  margin-bottom: 6px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.rewrite-textarea {
  min-height: 108px;
}

.rewrite-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;

  button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 9px 10px;
    border: 1px solid var(--ink-line);
    border-radius: 7px;
    color: var(--ink-main);
    background: transparent;
    text-align: left;
    cursor: pointer;

    &.active {
      border-color: var(--ink-accent);
      background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
    }

    span {
      color: var(--ink-sec);
      font-size: calc(11px * var(--ui-font-scale, 1));
      line-height: 1.45;
    }
  }
}

.rewrite-outline-card {
  padding: 12px;
  border: 1px solid var(--ink-line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-accent) 5%, transparent);

  p {
    margin: 8px 0 0;
    color: var(--ink-sec);
    line-height: 1.7;
  }
}

.rewrite-rule-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 10px;
  color: var(--ink-main);
  cursor: pointer;
  font-size: calc(12px * var(--ui-font-scale, 1));

  &.is-disabled {
    color: var(--ink-sec);
    cursor: not-allowed;
    opacity: 0.7;
  }

  input {
    position: absolute;
    width: 1px;
    height: 1px;
    clip: rect(0 0 0 0);
    overflow: hidden;
  }

  i {
    color: var(--ink-accent);
    font-size: calc(14px * var(--ui-font-scale, 1));
  }
}

.rewrite-spin {
  margin-right: 6px;
  color: var(--ink-accent);
}

.rewrite-badge {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--state-warning-on);
  background: var(--state-warning-surface);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-style: normal;
  font-weight: 600;
  vertical-align: 1px;
}

.rewrite-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: var(--ink-main);
    font-variant-numeric: tabular-nums;
  }
}

.rewrite-progress {
  height: 4px;
  overflow: hidden;
  margin-bottom: 14px;
  border-radius: 999px;
  background: var(--progress-track-bg, color-mix(in srgb, var(--ink-main) 10%, transparent));

  span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--ink-accent);
    transition: width 0.25s ease;
  }
}

.rewrite-request-summary {
  margin: 0 0 4px;
  padding: 8px 10px;
  border: 1px solid var(--divider);
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));

  summary {
    color: var(--ink-sec);
    cursor: pointer;
    font-weight: 600;
  }

  p {
    margin: 8px 0 0;
    color: var(--ink-main);
    line-height: 1.7;
    white-space: pre-wrap;
  }
}

.rewrite-request-rule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-accent) !important;
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.rewrite-view-switch {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-main) 6%, transparent);

  button {
    min-height: 26px;
    padding: 0 4px;
    border: 0;
    border-radius: 6px;
    color: var(--ink-sec);
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: calc(12px * var(--ui-font-scale, 1));

    &.active {
      color: var(--ink-main);
      background: var(--input-bg, rgb(255 255 255 / 55%));
      box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
      font-weight: 600;
    }
  }
}

.rewrite-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.rewrite-compare-card {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--divider);
  border-radius: 8px;

  &.is-candidate {
    border-color: color-mix(in srgb, var(--ink-accent) 45%, transparent);
    background: color-mix(in srgb, var(--ink-accent) 6%, transparent);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 6px;
    font-size: calc(12px * var(--ui-font-scale, 1));

    span {
      color: var(--ink-tertiary, var(--ink-sec));
      font-size: calc(11px * var(--ui-font-scale, 1));
      font-variant-numeric: tabular-nums;
    }
  }

  p {
    margin: 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.7;
    word-break: break-all;
  }
}

.rewrite-fulltext {
  max-height: 320px;
  overflow-y: auto;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--divider);
  border-radius: 8px;

  p {
    margin: 0 0 10px;
    color: var(--ink-main);
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.8;

    &:last-child {
      margin-bottom: 0;
    }

    &.is-empty {
      color: var(--ink-sec);
    }
  }
}

.rewrite-footer-btn {
  width: 100%;
  min-height: 36px;
  margin: 0;
}
</style>
