<template>
  <section class="workflow-task-panel">
    <div class="workflow-task-scroll custom-scroll">
      <WorkflowRecoveryPanel v-if="task?.runId" :run-id="Number(task.runId)" />
      <section v-if="outlineWarnings.length" class="workflow-outline-warning">
        <div class="workflow-section-title">
          <span>
            <i class="fa-solid fa-circle-exclamation"></i>
            章节标题提醒
          </span>
          <span>{{ outlineWarnings.length }}</span>
        </div>
        <p>部分章节标题重复，可继续生成，也可以在目录中修改。</p>
        <ul>
          <li v-for="warning in outlineWarnings" :key="`${warning.chapterId}-${warning.title}`">
            <span>第 {{ warning.chapterNo }} 章</span>
            <strong :title="warning.title">{{ warning.title }}</strong>
          </li>
        </ul>
      </section>

      <section v-if="qualityNotice" class="workflow-review">
        <div class="workflow-section-title">
          <span>
            <i class="fa-solid fa-triangle-exclamation"></i>
            {{ qualityNotice.requiresAction ? '本章需要确认' : '本章检查结果' }}
          </span>
          <button
            type="button"
            class="ink-btn ink-btn-ghost ink-btn-sm workflow-icon-button"
            :aria-label="reviewCollapsed ? '展开本章检查结果' : '收起本章检查结果'"
            @click="reviewCollapsed = !reviewCollapsed"
          >
            <i :class="reviewCollapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up'"></i>
          </button>
        </div>

        <template v-if="!reviewCollapsed">
          <strong class="workflow-review-chapter">
            {{ qualityNotice.chapterTitle || `第 ${qualityNotice.chapterNo} 章` }}
          </strong>
          <div class="workflow-review-meta">
            <span>模型：{{ qualityNotice.modelCode || '未记录' }}</span>
            <span>内容审稿：{{ criticStatusLabel }}</span>
            <span v-if="qualityNotice.createdAt">{{ formatReviewTime(qualityNotice.createdAt) }}</span>
          </div>
          <p v-if="qualityNotice.critic?.status === 'unavailable'" class="workflow-review-unavailable">
            正文完整性检查已完成，内容审稿本次未完成；正文仍已保存，可正常查看和编辑。
          </p>
          <section
            v-for="group in reviewGroups"
            :key="group.key"
            class="workflow-review-group"
            :class="{ 'is-blocking': group.blocking }"
          >
            <div class="workflow-review-group-title">
              <strong>{{ group.label }}</strong>
              <span>{{ group.issues.length }}</span>
            </div>
            <ul class="workflow-review-problems">
              <li
                v-for="(issue, index) in group.issues"
                :key="`${issue.code}-${index}`"
                class="workflow-issue-card"
                :class="[
                  `issue-card-${issueLevel(issue)}`,
                  { 'is-focused': activeIssueKey && activeIssueKey === issueKey(issue) },
                ]"
              >
                <small>
                  <em class="workflow-issue-level" :class="`issue-chip-${issueLevel(issue)}`">
                    {{ issueLevelLabel(issue) }}
                  </em>
                  <em
                    v-if="polishedIssueKeySet.has(issueKey(issue))"
                    class="workflow-issue-polished"
                  >
                    已修改
                  </em>
                  {{ issueSourceLabel(issue.source) }}
                  · {{ issueDimensionLabel(issue.dimension) }}
                  <template v-if="issue.paragraphs?.length">
                    · 命中 {{ issue.paragraphs.length }} 段
                  </template>
                </small>
                <strong>{{ issue.message }}</strong>
                <blockquote v-if="issue.quotes?.length" class="workflow-issue-quote">
                  <p v-for="(quote, quoteIndex) in issue.quotes.slice(0, 2)" :key="quoteIndex">
                    “{{ quote }}”
                  </p>
                </blockquote>
                <span v-if="showIssueEvidence(issue)">依据：{{ issue.evidence }}</span>
                <span v-if="showIssueFix(issue)">处理建议：{{ issue.fix }}</span>
                <div class="workflow-issue-actions">
                  <button
                    v-if="issue.paragraphs?.length"
                    type="button"
                    class="workflow-issue-polish-btn"
                    @click="emit('polishIssue', issueKey(issue))"
                  >
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    AI 修改此段
                  </button>
                  <button
                    v-if="issue.paragraphs?.length"
                    type="button"
                    @click="emit('locateIssue', issueKey(issue))"
                  >
                    <i class="fa-solid fa-location-crosshairs"></i>
                    定位原文
                  </button>
                  <button
                    v-if="!issue.blocking"
                    type="button"
                    @click="emit('dismissIssue', issueKey(issue))"
                  >
                    <i class="fa-regular fa-eye-slash"></i>
                    忽略
                  </button>
                </div>
                <p v-if="issue.paragraphs?.length" class="workflow-issue-polish-hint">
                  仅发送并修改对应段落，不会重写全文
                </p>
              </li>
            </ul>
          </section>
          <p v-if="dismissedIssueCount > 0" class="workflow-issue-dismissed">
            已忽略 {{ dismissedIssueCount }} 条建议
            <button type="button" @click="emit('restoreDismissedIssues')">恢复显示</button>
          </p>
          <p v-if="qualityNotice.requiresAction" class="workflow-review-hint">
            正文已经保存，是否重写由你决定，当前内容不会被遮挡或丢失。
          </p>
          <p v-else class="workflow-review-hint">
            没有发现需要暂停生成的问题；普通建议仅供参考。
          </p>
          <div v-if="qualityNotice.requiresAction" class="workflow-review-feedback">
            <button
              type="button"
              class="workflow-feedback-toggle"
              :aria-expanded="feedbackExpanded"
              @click="feedbackExpanded = !feedbackExpanded"
            >
              <span>
                <i class="fa-solid fa-pen-nib"></i>
                补充要求（选填）
              </span>
              <span class="workflow-feedback-toggle-meta">
                <em v-if="!feedbackExpanded && reviewFeedback.trim()">已填写</em>
                <i :class="feedbackExpanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'"></i>
              </span>
            </button>
            <template v-if="feedbackExpanded">
              <div class="workflow-feedback-input">
                <textarea
                  v-model="reviewFeedback"
                  :maxlength="REVIEW_FEEDBACK_MAX"
                  rows="3"
                  placeholder="例如：打斗收短一点，多写心理"
                ></textarea>
                <em>{{ reviewFeedback.length }} / {{ REVIEW_FEEDBACK_MAX }}</em>
              </div>
              <label class="workflow-feedback-rule">
                <input v-model="reviewFeedbackToRules" type="checkbox" />
                <i :class="reviewFeedbackToRules ? 'fa-solid fa-square-check' : 'fa-regular fa-square'"></i>
                <span>同时加入写作规则（以后每章都遵守）</span>
              </label>
              <p class="workflow-feedback-hint">补充要求只随下方重写操作提交；重写正文会保留章纲，重写剧情会先让你确认新章纲。</p>
            </template>
          </div>
          <div v-if="qualityNotice.requiresAction" class="workflow-action-stack">
            <button
              type="button"
              class="ink-btn ink-btn-primary"
              :disabled="actionPending"
              @click="emit('review', 'accept')"
            >
              <i v-if="actionPending" class="fa-solid fa-spinner fa-spin"></i>
              {{ actionPending ? '正在处理' : '接受本章并继续' }}
            </button>
            <button
              type="button"
              class="ink-btn ink-btn-outline"
              :disabled="actionPending"
              @click="emit('editReview')"
            >
              在正文中修改
            </button>
            <button
              type="button"
              class="ink-btn ink-btn-outline"
              :disabled="actionPending"
              @click="submitRewriteReview('content')"
            >
              保留章纲并重写正文
            </button>
            <button
              type="button"
              class="ink-btn ink-btn-outline"
              :disabled="actionPending"
              @click="submitRewriteReview('plot')"
            >
              重写剧情与正文
            </button>
          </div>
          <button
            v-if="!qualityNotice.requiresAction"
            type="button"
            class="ink-btn ink-btn-outline"
            @click="$emit('editReview')"
          >
            在正文中修改
          </button>
        </template>
      </section>

      <section v-if="plotOutlineReview" class="workflow-review">
        <div class="workflow-section-title">
          <span>
            <i class="fa-solid fa-diagram-project"></i>
            确认剧情章纲
          </span>
        </div>
        <strong class="workflow-review-chapter">
          {{ plotOutlineReview.chapterTitle || '新章纲' }}
        </strong>
        <p class="workflow-review-hint">
          {{ plotOutlineReview.chapterSummary || '新章纲没有有效摘要，请丢弃后重试。' }}
        </p>
        <p class="workflow-review-hint">确认后才会生成新正文；丢弃会恢复原章纲与原正文。</p>
        <div class="workflow-action-stack">
          <button
            type="button"
            class="ink-btn ink-btn-primary"
            :disabled="actionPending"
            @click="emit('plotOutlineReview', 'accept')"
          >
            确认章纲并生成正文
          </button>
          <button
            type="button"
            class="ink-btn ink-btn-outline"
            :disabled="actionPending"
            @click="emit('plotOutlineReview', 'discard')"
          >
            丢弃新章纲
          </button>
        </div>
      </section>

      <section class="workflow-status-section">
        <div class="workflow-section-title">
          <span>状态</span>
          <span class="workflow-status" :class="`is-${state}`">
            <i :class="statusIcon"></i>
            {{ statusLabel }}
          </span>
        </div>

        <p v-if="statusDetail" class="workflow-status-detail">{{ statusDetail }}</p>
        <p v-if="state === 'failed'" class="workflow-state-message is-error">
          {{ task?.errorMessage || '自动生成已中断，已生成正文和断点仍然保留。' }}
        </p>
        <p v-else-if="state === 'recovering'" class="workflow-state-message">
          生成通道正在恢复，正文与断点不会清空。
        </p>
        <p v-else-if="state === 'initializing'" class="workflow-state-message">
          正在连接自动生文任务，状态同步完成后可进行操作。
        </p>
        <p v-else-if="state === 'unavailable'" class="workflow-state-message">
          暂时无法获取任务状态，系统会继续自动重连。
        </p>
        <p v-else-if="state === 'done' && hasRemainingChapters" class="workflow-state-message">
          仍有未完成章节，可继续生成。
        </p>

        <div class="workflow-progress-meta">
          <span>{{ progressLabel }}</span>
          <strong>{{ progress }}%</strong>
        </div>
        <div
          class="workflow-progress"
          role="progressbar"
          aria-label="全书生成进度"
          :aria-valuenow="progress"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span :style="{ width: `${progress}%` }"></span>
        </div>

        <dl class="workflow-task-meta">
          <div>
            <dt>已保存</dt>
            <dd>{{ savedWords.toLocaleString() }} 字</dd>
          </div>
          <div>
            <dt>全书进度</dt>
            <dd v-if="chapterPlanningMode === 'dynamic'">已完成 {{ finishedChapters }} 章 · 动态规划</dd>
            <dd v-else>{{ finishedChapters }} / {{ totalChapters }} 章</dd>
          </div>
          <div>
            <dt>当前模型</dt>
            <dd :title="currentModelTitle">{{ currentModelLabel }}</dd>
          </div>
          <div>
            <dt>上次保存</dt>
            <dd>{{ lastSavedTime }}</dd>
          </div>
        </dl>
      </section>

      <section class="workflow-control-section">
        <div class="workflow-section-title">
          <span>自动生成</span>
        </div>
        <div class="workflow-action-stack">
          <button
            v-if="canResume"
            type="button"
            class="ink-btn ink-btn-primary"
            :disabled="actionPending"
            @click="$emit('resume')"
          >
            <i :class="actionPending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'"></i>
            {{ actionPending ? '正在处理' : '继续生成' }}
          </button>
          <button
            v-if="canPause"
            type="button"
            class="ink-btn ink-btn-primary"
            :disabled="actionPending"
            @click="$emit('pause')"
          >
            <i :class="actionPending ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-pause'"></i>
            暂停生成
          </button>
          <button
            v-if="canStop"
            type="button"
            class="ink-btn ink-btn-outline"
            :disabled="actionPending"
            @click="$emit('stop')"
          >
            停止自动生成
          </button>
          <p v-if="state === 'paused' || state === 'failed'" class="workflow-control-hint">
            已有正文和章节断点均已保留；继续时从当前断点衔接。
          </p>
          <p v-else-if="state === 'stopped'" class="workflow-control-hint">
            自动生成已停止，已有正文可正常编辑；仍有未完成章节时可继续生成。
          </p>
          <p v-else-if="state === 'initializing' || state === 'unavailable'" class="workflow-control-hint">
            任务状态确认前，暂停、继续和结束操作暂不可用。
          </p>
        </div>
      </section>

      <section class="workflow-record-section">
        <button class="workflow-record-toggle" type="button" @click="logsExpanded = !logsExpanded">
          <strong>生成记录</strong>
          <span>
            {{ logs.length }} 条
            <i :class="logsExpanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'"></i>
          </span>
        </button>
        <ol v-if="logsExpanded" class="workflow-log-list">
          <li v-for="(log, index) in logs" :key="`${log.time}-${index}`">
            <time>{{ log.time }}</time>
            <span>{{ log.text }}</span>
          </li>
          <li v-if="!logs.length" class="is-empty">暂无生成记录</li>
        </ol>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import WorkflowRecoveryPanel from '@/components/WorkflowRecoveryPanel.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type {
  WorkflowQualityIssue,
  WorkflowQualityNotice,
  WorkflowQualityReview,
  WorkflowReviewAction,
  WorkflowReviewFeedback,
  WorkflowTask,
} from '@/types/workflow'
import type {
  WorkflowControlLog,
  WorkflowControlState,
} from '../composables/useWorkflowWritingSession'

const props = withDefaults(defineProps<{
  state: WorkflowControlState
  task: WorkflowTask | null
  logs: WorkflowControlLog[]
  modelCode?: string
  modelName?: string
  stageText?: string
  writingScene?: number
  actionPending?: boolean
  /** 用户已忽略的建议键（父级持久化）：卡片与正文标注同源过滤 */
  dismissedIssueKeys?: string[]
  /** 正文里当前选中段对应的建议键：卡片联动加边框 */
  activeIssueKey?: string
  /** 本次会话已执行过"AI 修改此段"的建议键：卡片打"已修改"标 */
  polishedIssueKeys?: string[]
}>(), {
  modelCode: '',
  modelName: '',
  stageText: '',
  writingScene: 0,
  actionPending: false,
  dismissedIssueKeys: () => [],
  activeIssueKey: '',
  polishedIssueKeys: () => [],
})

const emit = defineEmits<{
  (event: 'pause'): void
  (event: 'resume'): void
  (event: 'stop'): void
  (event: 'review', action: WorkflowReviewAction, feedback?: WorkflowReviewFeedback): void
  (event: 'plotOutlineReview', action: 'accept' | 'discard'): void
  (event: 'editReview'): void
  (event: 'locateIssue', issueKey: string): void
  (event: 'dismissIssue', issueKey: string): void
  (event: 'restoreDismissedIssues'): void
  (event: 'polishIssue', issueKey: string): void
}>()

/** 补充要求与单章重写共用同一上限，与服务端契约保持一致。 */
const REVIEW_FEEDBACK_MAX = 500

const reviewCollapsed = ref(false)
const logsExpanded = ref(true)
const feedbackExpanded = ref(false)
const reviewFeedback = ref('')
const reviewFeedbackToRules = ref(false)
const stageStartedAt = ref(0)
const stageClock = ref(Date.now())
let stageClockTimer: ReturnType<typeof setInterval> | null = null

const stopStageClock = () => {
  if (stageClockTimer) clearInterval(stageClockTimer)
  stageClockTimer = null
}

const startStageClock = () => {
  stageStartedAt.value = Date.now()
  stageClock.value = stageStartedAt.value
  stopStageClock()
  stageClockTimer = setInterval(() => {
    stageClock.value = Date.now()
  }, 1000)
}

watch(
  () => [props.stageText, props.state] as const,
  ([stageText, state], previous) => {
    const previousStage = previous?.[0] || ''
    if (state === 'generating' && stageText) {
      if (stageText !== previousStage || !stageStartedAt.value) startStageClock()
      return
    }
    stageStartedAt.value = 0
    stopStageClock()
  },
  { immediate: true }
)

onBeforeUnmount(stopStageClock)

// 用户意见随「保留版本并重写」回流；勾选写作规则但没写内容时视为未提意见。
const submitRewriteReview = (rewriteMode: 'content' | 'plot') => {
  const feedback = reviewFeedback.value.trim()
  emit('review', 'rewrite', {
    ...(feedback ? { feedback } : {}),
    ...(feedback && reviewFeedbackToRules.value ? { feedbackToRules: true } : {}),
    rewriteMode,
  })
}
const currentModelLabel = computed(() => props.modelName || props.modelCode || '获取中')
const currentModelTitle = computed(() =>
  props.modelName && props.modelCode && props.modelName !== props.modelCode
    ? `${props.modelName}（${props.modelCode}）`
    : currentModelLabel.value
)

const totalChapters = computed(() => Math.max(0, Number(props.task?.totalChapters || 0)))
const finishedChapters = computed(() => Math.max(0, Number(props.task?.finishedChapters || 0)))
const chapterPlanningMode = computed(() => props.task?.chapterPlanningMode || 'fixed')
// 全书章节统计存在时按已完成章节计算，旧任务缺少统计字段才回落内部进度。
const progress = computed(() =>
  totalChapters.value > 0
    ? Math.round((Math.min(finishedChapters.value, totalChapters.value) / totalChapters.value) * 100)
    : Math.max(0, Math.min(100, Math.round(Number(props.task?.progress || 0))))
)
const savedWords = computed(() =>
  Math.max(
    Number(props.task?.totalGeneratedWords || 0),
    Number(props.task?.generatedWords || 0),
    Number(props.task?.checkpoint?.wordCount || 0),
  )
)
const qualityReview = computed<WorkflowQualityReview | null>(() =>
  props.state === 'review_required' ? props.task?.payload?.qualityReview || null : null
)
const plotOutlineReview = computed(() =>
  props.state === 'review_required'
    ? props.task?.payload?.plotOutlineReview || null
    : null
)
const qualityNotice = computed<WorkflowQualityNotice | null>(() =>
  qualityReview.value || props.task?.payload?.qualitySuggestions || null
)
const outlineWarnings = computed(() => props.task?.payload?.outlineWarnings || [])
/** 建议唯一键：与服务端质检去重口径一致（source:code:message） */
const issueKey = (issue: WorkflowQualityIssue) =>
  `${issue.source}:${issue.code}:${issue.message}`

/** 三级等级映射：红=阻断需确认，橙=非阻断高级别，蓝=非阻断低级别 */
const issueLevel = (issue: WorkflowQualityIssue) =>
  issue.blocking ? 'blocking' : issue.severity === 'high' ? 'advise' : 'polish'

const issueLevelLabel = (issue: WorkflowQualityIssue) =>
  issue.blocking ? '需确认' : issue.severity === 'high' ? '建议修改' : '可优化'

const dismissedIssueKeySet = computed(
  () => new Set(props.dismissedIssueKeys || [])
)
const polishedIssueKeySet = computed(
  () => new Set(props.polishedIssueKeys || [])
)
const dismissedIssueCount = computed(() =>
  (qualityNotice.value?.issues || []).filter(
    issue => !issue.blocking && dismissedIssueKeySet.value.has(issueKey(issue))
  ).length
)

const reviewGroups = computed(() => {
  const issues = (qualityNotice.value?.issues || []).filter(
    // 阻断问题不允许忽略（本章就是因为它停机的），只过滤非阻断建议
    issue => issue.blocking || !dismissedIssueKeySet.value.has(issueKey(issue))
  )
  return [
    {
      key: 'blocking',
      label: '需要确认的问题',
      blocking: true,
      issues: issues.filter(issue => issue.blocking),
    },
    {
      key: 'suggestions',
      label: '修改建议',
      blocking: false,
      issues: issues.filter(issue => !issue.blocking),
    },
  ].filter(group => group.issues.length)
})
const criticStatusLabel = computed(() => {
  const status = qualityNotice.value?.critic?.status
  if (status === 'available') return '已完成'
  if (status === 'partial') return '部分完成'
  if (status === 'unavailable') return '未完成'
  return '未记录'
})
const issueDimensionLabels: Record<string, string> = {
  integrity: '正文完整性',
  content: '正文内容',
  setting: '设定一致性',
  timeline: '时间线',
  continuity: '剧情承接',
  character: '人物一致性',
  logic: '情节逻辑',
  content_boundary: '内容边界',
}
const issueSourceLabel = (source: WorkflowQualityIssue['source']) =>
  source === 'rule' ? '正文检查' : '内容审稿'
const issueDimensionLabel = (dimension: string) =>
  issueDimensionLabels[dimension] || '内容问题'
const showIssueEvidence = (issue: WorkflowQualityIssue) =>
  Boolean(issue.evidence && issue.evidence !== issue.message)
const showIssueFix = (issue: WorkflowQualityIssue) =>
  Boolean(
    issue.fix &&
    issue.fix !== issue.message &&
    issue.fix !== issue.evidence
  )
const formatReviewTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
const canPause = computed(() =>
  Boolean(props.task) && ['generating', 'recovering'].includes(props.state)
)
const hasRemainingChapters = computed(() => Number(props.task?.remainingChapters || 0) > 0)
const canResume = computed(() =>
  Boolean(props.task) &&
  (
    props.task?.canResume === true ||
    (['failed', 'done', 'stopped'].includes(props.state) && hasRemainingChapters.value)
  )
)
const canStop = computed(() =>
  Boolean(props.task) && ['generating', 'recovering', 'review_required', 'paused', 'failed'].includes(props.state)
)

const statusLabel = computed(() => {
  if (props.state === 'done' && hasRemainingChapters.value) return '等待继续'
  return ({
    initializing: '正在连接',
    unavailable: '状态不可用',
    generating: '正在生成',
    recovering: '自动恢复中',
    review_required: '等待确认',
    paused: '已暂停',
    stopped: '已停止',
    failed: '生成中断',
    done: '全书已完成',
  }[props.state])
})

const statusIcon = computed(() => ({
  initializing: 'fa-solid fa-circle-notch fa-spin',
  unavailable: 'fa-solid fa-link-slash',
  generating: 'fa-solid fa-circle-notch fa-spin',
  recovering: 'fa-solid fa-rotate fa-spin',
  review_required: 'fa-solid fa-triangle-exclamation',
  paused: 'fa-solid fa-pause',
  stopped: 'fa-solid fa-square',
  failed: 'fa-solid fa-circle-exclamation',
  done: 'fa-solid fa-circle-check',
}[props.state]))

const progressLabel = computed(() => {
  if (props.task?.currentChapterTitle) return props.task.currentChapterTitle
  if (props.state === 'unavailable') return '任务状态暂不可用'
  if (props.state === 'initializing') return '正在连接任务'
  return '正在准备章节'
})

const statusDetail = computed(() => {
  if (props.stageText) {
    const elapsedSeconds = stageStartedAt.value
      ? Math.max(0, Math.floor((stageClock.value - stageStartedAt.value) / 1000))
      : 0
    if (props.state !== 'generating' || elapsedSeconds < 10) return props.stageText
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = elapsedSeconds % 60
    const elapsed = minutes
      ? `${minutes}分${String(seconds).padStart(2, '0')}秒`
      : `${seconds}秒`
    return `${props.stageText}（本阶段已进行 ${elapsed}）`
  }
  if (props.writingScene > 0) return `正在生成第 ${props.writingScene} 场`
  if (props.state === 'paused') {
    return props.task?.currentChapterTitle
      ? `暂停位置：${props.task.currentChapterTitle}`
      : '任务已停在安全断点'
  }
  return ''
})

const lastSavedTime = computed(() => {
  const source = props.task?.lastHeartbeatTime || props.task?.finishedAt
  if (!source) return '--'
  const date = new Date(source)
  if (Number.isNaN(date.getTime())) return String(source).slice(11, 19) || '--'
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
})

watch(
  () => qualityNotice.value?.chapterId,
  () => {
    reviewCollapsed.value = false
    // 换章后上一章的补充要求不再适用，输入与勾选一并复位。
    feedbackExpanded.value = false
    reviewFeedback.value = ''
    reviewFeedbackToRules.value = false
  }
)
</script>

<style scoped lang="scss">
.workflow-task-panel {
  height: 100%;
  min-width: 0;
  color: var(--ink-main);
  background: transparent;
}

.workflow-task-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 0 16px 24px;
}

.workflow-review,
.workflow-outline-warning,
.workflow-status-section,
.workflow-control-section,
.workflow-record-section {
  padding: 18px 0;
  border-bottom: 1px solid var(--divider);
}

.workflow-outline-warning {
  color: var(--state-warning-on);

  p {
    margin: 0 0 10px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.6;
  }

  ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px;
    padding: 7px 9px;
    border-radius: 7px;
    background: var(--state-warning-surface);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.workflow-record-section {
  border-bottom: 0;
}

.workflow-section-title,
.workflow-progress-meta,
.workflow-record-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.workflow-section-title {
  min-height: 28px;
  margin-bottom: 14px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 700;

  > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

}

.workflow-icon-button {
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
}

.workflow-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--ink-sec);
  background: var(--ui-bg-soft, color-mix(in srgb, var(--ink-main) 6%, transparent));
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;

  &.is-generating,
  &.is-recovering,
  &.is-unavailable {
    color: var(--state-warning-on);
    background: var(--state-warning-surface);
  }

  &.is-failed {
    color: var(--state-danger-on);
    background: var(--state-danger-surface);
  }

  &.is-review_required {
    color: var(--state-warning-on);
    background: var(--state-warning-surface);
  }
}

.workflow-status-detail,
.workflow-state-message,
.workflow-review-hint,
.workflow-control-hint {
  margin: 0 0 12px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.workflow-state-message {
  padding: 9px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--ink-accent) 7%, transparent);

  &.is-error {
    color: var(--state-danger-on);
    background: var(--state-danger-surface);
  }
}

.workflow-progress-meta {
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

.workflow-progress {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--progress-track-bg);

  span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--ink-accent);
    transition: width 0.25s ease;
  }
}

.workflow-task-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 16px;
  margin: 18px 0 0;

  div {
    min-width: 0;
  }

  dt {
    margin-bottom: 4px;
    color: var(--ink-tertiary, var(--ink-sec));
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  dd {
    margin: 0;
    overflow: hidden;
    color: var(--ink-main);
    font-size: calc(13px * var(--ui-font-scale, 1));
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.workflow-action-stack {
  display: grid;
  gap: 10px;

  .ink-btn {
    width: 100%;
    min-height: 40px;
    margin-left: 0;
  }
}

.workflow-review-chapter {
  display: block;
  margin-bottom: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.workflow-review-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 10px;
  margin-bottom: 10px;
  color: var(--ink-tertiary, var(--ink-sec));
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.workflow-review-unavailable {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 7px;
  color: var(--state-warning-on);
  background: var(--state-warning-surface);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.workflow-review-group {
  margin-bottom: 10px;
}

.workflow-review-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));

  span {
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 999px;
    text-align: center;
    background: color-mix(in srgb, var(--ink-main) 7%, transparent);
  }
}

.workflow-review-group.is-blocking .workflow-review-group-title {
  color: var(--state-danger-on);
}

.workflow-review-problems {
  display: grid;
  gap: 8px;
  margin: 0 0 10px;
  padding-left: 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;
  list-style: none;

  li {
    display: grid;
    gap: 2px;
  }

  small {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--ink-tertiary, var(--ink-sec));
    font-size: calc(11px * var(--ui-font-scale, 1));
    font-weight: 600;
  }
}

/* 建议卡片：左色条即等级色，与正文标注同一套颜色语义 */
.workflow-issue-card {
  padding: 8px 10px;
  border: 1px solid transparent;
  border-left: 3px solid var(--divider);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ink-main) 3%, transparent);

  &.is-focused {
    border-color: rgba(64, 158, 255, 0.55);
  }
}

.workflow-issue-polished {
  padding: 0 6px;
  border-radius: 4px;
  font-style: normal;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
  color: #4d8f3a;
  background: rgba(103, 194, 58, 0.14);
}

.workflow-issue-polish-btn {
  color: var(--state-info) !important;
}

.workflow-issue-polish-hint {
  margin: 2px 0 0;
  font-size: calc(10px * var(--ui-font-scale, 1));
  color: var(--ink-tertiary, var(--ink-sec));
}

.issue-card-blocking {
  border-left-color: rgba(245, 108, 108, 0.85);
}

.issue-card-advise {
  border-left-color: rgba(230, 162, 60, 0.85);
}

.issue-card-polish {
  border-left-color: rgba(64, 158, 255, 0.8);
}

.workflow-issue-level {
  padding: 0 6px;
  border-radius: 4px;
  font-style: normal;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
}

.issue-chip-blocking {
  color: var(--state-danger);
  background: rgba(245, 108, 108, 0.14);
}

.issue-chip-advise {
  color: #a05a00;
  background: rgba(230, 162, 60, 0.16);
}

.issue-chip-polish {
  color: var(--state-info);
  background: rgba(64, 158, 255, 0.13);
}

.workflow-issue-quote {
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink-main) 5%, transparent);
  color: var(--ink-main);

  p {
    margin: 0;
    line-height: 1.6;
  }
}

.workflow-issue-actions {
  display: flex;
  gap: 12px;
  margin-top: 4px;

  button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink-sec);
    font: inherit;
    font-size: calc(11px * var(--ui-font-scale, 1));
    cursor: pointer;

    &:hover {
      color: var(--ink-main);
    }
  }
}

.workflow-issue-dismissed {
  margin: 0 0 10px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  color: var(--ink-tertiary, var(--ink-sec));

  button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink-sec);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
}

.workflow-control-hint {
  margin: 0;
  text-align: center;
}

.workflow-review-feedback {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--panel-bg, color-mix(in srgb, var(--ink-main) 3%, transparent));
}

.workflow-feedback-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0;
  border: 0;
  color: var(--ink-main);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;

  > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  i {
    color: var(--ink-accent);
  }
}

.workflow-feedback-toggle-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-sec);

  em {
    padding: 1px 6px;
    border-radius: 999px;
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
    font-size: calc(11px * var(--ui-font-scale, 1));
    font-style: normal;
  }

  i {
    color: var(--ink-sec);
  }
}

.workflow-feedback-input {
  position: relative;

  textarea {
    display: block;
    width: 100%;
    padding: 8px 10px 20px;
    border: 1px solid var(--divider);
    border-radius: 7px;
    color: var(--ink-main);
    background: var(--input-bg, transparent);
    font: inherit;
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.6;
    resize: vertical;

    &:focus {
      border-color: var(--input-focus-border, var(--ink-accent));
      outline: none;
    }

    &::placeholder {
      color: var(--ink-tertiary, var(--ink-sec));
    }
  }

  em {
    position: absolute;
    right: 8px;
    bottom: 6px;
    color: var(--ink-tertiary, var(--ink-sec));
    font-size: calc(11px * var(--ui-font-scale, 1));
    font-style: normal;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
}

.workflow-feedback-rule {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-main);
  cursor: pointer;
  font-size: calc(12px * var(--ui-font-scale, 1));

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

.workflow-feedback-hint {
  margin: 0;
  color: var(--ink-tertiary, var(--ink-sec));
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.workflow-record-toggle {
  width: 100%;
  padding: 0;
  border: 0;
  color: var(--ink-main);
  background: transparent;
  cursor: pointer;
  font: inherit;

  strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  span {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.workflow-log-list {
  position: relative;
  display: grid;
  gap: 12px;
  margin: 16px 0 0;
  padding: 0 0 0 14px;
  list-style: none;

  &::before {
    position: absolute;
    top: 5px;
    bottom: 5px;
    left: 3px;
    width: 1px;
    background: var(--divider);
    content: '';
  }

  li {
    position: relative;
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 8px;
    color: var(--ink-sec);
    font-size: calc(11px * var(--ui-font-scale, 1));
    line-height: 1.55;

    &::before {
      position: absolute;
      top: 5px;
      left: -13px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--divider);
      content: '';
    }

    &:last-child::before {
      background: var(--ink-accent);
    }
  }

  time {
    font-variant-numeric: tabular-nums;
  }

  .is-empty {
    display: block;
  }
}

@media (max-width: 1180px) {
  .workflow-task-scroll {
    padding-inline: 14px;
  }
}
</style>
