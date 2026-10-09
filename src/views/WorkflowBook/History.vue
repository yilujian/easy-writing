<template>
  <!-- 整页不滚动：返回栏 / 统计卡 / 筛选栏固定，只有列表区滚动并滚动分页 -->
  <div class="wf-history">
    <header class="wf-history__bar">
      <button class="wf-btn wf-btn--ghost" type="button" @click="goBack">
        <i class="fa-solid fa-arrow-left"></i>
        返回
      </button>
      <button class="wf-btn wf-btn--primary" type="button" @click="createWorkflow">
        <i class="fa-solid fa-plus"></i>
        创建工作流
      </button>
    </header>

    <section class="wf-history__stats">
      <button
        v-for="card in statCards"
        :key="card.key"
        class="wf-stat"
        :class="[`wf-stat--${card.key}`, { 'is-active': query.status === card.status }]"
        type="button"
        @click="setStatus(card.status)"
      >
        <span class="wf-stat__icon"><i :class="card.icon"></i></span>
        <span class="wf-stat__label">{{ card.label }}</span>
        <strong class="wf-stat__value">{{ card.value }}</strong>
      </button>
    </section>

    <section class="wf-history__filter">
      <el-input
        v-model="query.keyword"
        class="ink-select wf-filter-control"
        placeholder="搜索方案标题"
        clearable
        @keyup.enter="reload"
      >
        <template #prefix><i class="fa-solid fa-magnifying-glass"></i></template>
      </el-input>
      <el-select
        v-model="query.status"
        class="ink-select wf-filter-control"
        popper-class="ink-select-popper"
        placeholder="全部状态"
        @change="reload"
      >
        <el-option label="全部状态" value="" />
        <el-option label="生成中" value="generating" />
        <el-option label="已暂停" value="paused" />
        <el-option label="需要处理" value="attention" />
        <el-option label="已完成" value="completed" />
        <el-option label="已停止" value="canceled" />
        <el-option label="草稿" value="draft" />
      </el-select>
      <el-select
        v-model="query.hasBook"
        class="ink-select wf-filter-control"
        popper-class="ink-select-popper"
        placeholder="全部方案"
        @change="reload"
      >
        <el-option label="全部方案" value="" />
        <el-option label="已建书" value="1" />
        <el-option label="未建书" value="0" />
      </el-select>
      <button class="wf-btn wf-btn--ghost" type="button" :disabled="loading" @click="reload">
        <i class="fa-solid fa-rotate-right" :class="{ 'fa-spin': loading }"></i>
        刷新
      </button>
    </section>

    <main ref="listRef" class="wf-history__list">
      <div v-if="loading" class="wf-empty">正在加载历史记录...</div>
      <div v-else-if="!records.length" class="wf-empty">
        <i class="fa-regular fa-folder-open"></i>
        <strong>暂无工作流记录</strong>
        <p>创建工作流后，可以在这里修改设定、查看自动生文进度和处理待确认事项。</p>
        <button class="wf-btn wf-btn--primary" type="button" @click="createWorkflow">创建工作流</button>
      </div>

      <template v-else>
        <article
          v-for="item in records"
          :key="item.runId"
          class="wf-row"
          :class="`wf-tone--${resolveStatusTone(item.displayStatus)}`"
        >
          <div class="wf-row__status">
            <span class="wf-row__status-icon"><i :class="resolveStatusIcon(item.displayStatus)"></i></span>
            <em>{{ resolveStatusLabel(item) }}</em>
          </div>

          <div class="wf-row__main">
            <h2 :title="item.title">{{ item.title }}</h2>
            <div class="wf-row__meta">
              <span><i class="fa-solid fa-book-open"></i>{{ resolveStepLabel(item.currentStep) }}</span>
              <!-- 空 modelCode=跟随默认，不是"未选择"：展示默认实际落到的模型，如实反映生成用了什么 -->
              <span><i class="fa-solid fa-wand-magic-sparkles"></i>{{ item.modelCode || (item.effectiveModelCode ? `默认 · ${item.effectiveModelCode}` : '跟随默认模型') }}</span>
              <span><i class="fa-regular fa-clock"></i>{{ formatMonthDayTime(item.updateTime) }}</span>
            </div>
            <p v-if="item.errorMessage && item.displayStatus === 'attention'" class="wf-row__error">
              {{ item.errorMessage }}
            </p>
          </div>

          <!-- 步骤生成（灵感/大纲/设定）没有百分比，只有起止：用不定长进度条 -->
          <div v-if="isStepGenerating(item)" class="wf-row__progress">
            <strong class="wf-row__progress-label">{{ resolveStepTaskLabel(item.stepTask?.step) }}</strong>
            <span class="wf-bar wf-bar--indeterminate"><i></i></span>
          </div>
          <div v-else class="wf-row__progress">
            <strong>{{ resolveProgress(item) }}%</strong>
            <span class="wf-bar"><i :style="{ width: `${resolveProgress(item)}%` }"></i></span>
          </div>

          <div class="wf-row__stats">
            <span>
              已生成 {{ formatNumber(item.generatedWords) }} 字 ·
              <template v-if="item.chapterPlanningMode === 'dynamic'">
                已完成 {{ item.finishedChapters || 0 }} 章 · 动态规划
              </template>
              <template v-else>
                {{ item.finishedChapters || 0 }}/{{ item.totalChapters || 0 }} 章
              </template>
            </span>
            <em v-if="item.bookId" class="wf-badge-book" :title="item.bookTitle || ''">已建书</em>
          </div>

          <div class="wf-row__actions">
            <button
              v-if="hasAction(item, 'openBook') && item.bookId && !hasAction(item, 'resume')"
              class="wf-btn wf-btn--book"
              type="button"
              @click="openBook(item)"
            >
              进入作品
            </button>
            <button
              v-if="hasAction(item, 'review')"
              class="wf-btn wf-btn--primary"
              type="button"
              @click="openBook(item)"
            >
              处理本章
            </button>
            <!-- 已建书且可续跑：两个意图拆成两个按钮——「进入作品」纯打开书不触发续跑，
                 「继续生文」保留原打开并续跑链路，主次样式区分避免误触 -->
            <button
              v-if="hasAction(item, 'resume') && item.bookId"
              class="wf-btn wf-btn--ghost"
              type="button"
              @click="enterBook(item)"
            >
              进入作品
            </button>
            <button
              v-if="hasAction(item, 'resume') && item.bookId"
              class="wf-btn wf-btn--primary"
              type="button"
              :disabled="actionId === item.runId"
              @click="continueWriting(item)"
            >
              {{ actionId === item.runId ? '正在启动…' : '继续生文' }}
            </button>
            <button
              v-if="hasAction(item, 'pause')"
              class="wf-btn wf-btn--ghost"
              type="button"
              :disabled="actionId === item.runId"
              @click="pauseGenerate(item)"
            >
              暂停生成
            </button>
            <button
              v-if="hasAction(item, 'cancel')"
              class="wf-btn wf-btn--ghost"
              type="button"
              :disabled="actionId === item.runId"
              @click="cancelGeneration(item)"
            >
              {{ isStepGenerating(item) ? '取消生成' : '停止自动生成' }}
            </button>
            <button
              v-if="hasAction(item, 'editSettings')"
              class="wf-btn"
              :class="isEditPrimary(item) ? 'wf-btn--primary' : 'wf-btn--ghost'"
              type="button"
              @click="editSettings(item)"
            >
              {{ resolveEditSettingsLabel(item) }}
            </button>
            <button
              v-if="hasAction(item, 'delete')"
              class="wf-btn wf-btn--danger"
              type="button"
              :disabled="actionId === item.runId"
              @click="removeRun(item)"
            >
              删除
            </button>
          </div>
        </article>

        <!-- 滚动到底自动加载下一页；到底后换成结束提示 -->
        <div v-if="hasMore" ref="sentinelRef" class="wf-more">
          <i class="fa-solid fa-spinner fa-spin"></i>
          加载中…
        </div>
        <p v-else-if="records.length >= PAGE_SIZE" class="wf-more wf-more--end">没有更多了</p>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { formatMonthDayTime } from '@/utils/format'
import { extractApiErrorMessage, isCanceledRequest } from '@/utils/api-error'
// 开源版：历史与任务控制（暂停/取消/继续生文）全部走本地引擎
import type {
  WorkflowAvailableAction,
  WorkflowHistoryRecord,
  WorkflowHistoryStats,
} from '@/types/workflow'
import { deleteLocalWorkflow as deleteWorkflowApi } from '@/storage/local-workflow'
import { getLocalWorkflowHistory as getWorkflowHistoryApi } from '@/storage/local-workflow-history'
import {
  cancelLocalWorkflowTask as cancelWorkflowTaskApi,
  generateLocalWorkflowBook as generateWorkflowBookApi,
  pauseLocalWorkflowTask as pauseWorkflowTaskApi,
  resumeLocalWorkflowTask as resumeWorkflowTaskApi,
} from '@/utils/local-workflow-control'

const PAGE_SIZE = 10
// 服务端 history 接口对 size 的硬上限，静默刷新一次最多能覆盖这么多条
const MAX_REFRESH_SIZE = 50

const router = useRouter()
const loading = ref(false)
const loadingMore = ref(false)
const actionId = ref(0)
const records = ref<WorkflowHistoryRecord[]>([])
const EMPTY_STATS: WorkflowHistoryStats = {
  all: 0,
  generating: 0,
  paused: 0,
  attention: 0,
  completed: 0,
  canceled: 0,
}
const stats = ref<WorkflowHistoryStats>({ ...EMPTY_STATS })
const total = ref(0)
const page = ref(1)
const query = reactive({
  keyword: '',
  status: '',
  hasBook: '',
})

const statCards = computed(() => [
  { key: 'all', label: '全部方案', value: stats.value.all, status: '', icon: 'fa-solid fa-folder' },
  { key: 'running', label: '生成中', value: stats.value.generating, status: 'generating', icon: 'fa-solid fa-rocket' },
  { key: 'completed', label: '已完成', value: stats.value.completed, status: 'completed', icon: 'fa-regular fa-circle-check' },
  { key: 'interrupted', label: '需要处理', value: stats.value.attention, status: 'attention', icon: 'fa-solid fa-triangle-exclamation' },
])

const hasMore = computed(() => records.value.length < total.value)

const buildQuery = (nextPage: number, size: number) => ({
  page: nextPage,
  size,
  keyword: query.keyword.trim(),
  status: query.status,
  hasBook: query.hasBook,
})

// —— 列表加载：首屏 + 滚动分页 ——
const reload = async () => {
  loading.value = true
  page.value = 1
  try {
    const { data } = await getWorkflowHistoryApi(buildQuery(1, PAGE_SIZE))
    records.value = data?.list || []
    stats.value = data?.stats || { ...EMPTY_STATS }
    total.value = Number(data?.pagination?.total || 0)
    ensureHistoryPolling()
  } catch (error) {
    // 请求被取消（组件卸载/路由切换）不算失败，不打扰用户
    if (isCanceledRequest(error)) return
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '工作流历史加载失败'))
  } finally {
    loading.value = false
  }
}

const loadMore = async () => {
  if (loading.value || loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const nextPage = page.value + 1
    const { data } = await getWorkflowHistoryApi(buildQuery(nextPage, PAGE_SIZE))
    const rows = data?.list || []
    // 去重兜底：轮询期间上游顺序可能变动，避免同一条 run 被追加两次
    const seen = new Set(records.value.map(item => item.runId))
    records.value = [...records.value, ...rows.filter(item => !seen.has(item.runId))]
    total.value = Number(data?.pagination?.total || total.value)
    page.value = nextPage
    if (data?.stats) stats.value = data.stats
    ensureHistoryPolling()
  } catch (error) {
    if (isCanceledRequest(error)) return
    if (!error?.__handled) ElMessage.error(extractApiErrorMessage(error, '加载更多失败'))
  } finally {
    loadingMore.value = false
    // 重新观察哨兵：内容没撑满可视区时，IntersectionObserver 不会二次触发
    await nextTick()
    reobserveSentinel()
  }
}

// 静默刷新只覆盖已加载窗口的前 MAX_REFRESH_SIZE 条（接口 size 上限），
// 其余尾部保留上一次的值，避免为了刷进度把整个列表重新拉一遍。
const refreshLoaded = async () => {
  if (!records.value.length) return
  const size = Math.min(MAX_REFRESH_SIZE, records.value.length)
  try {
    const { data } = await getWorkflowHistoryApi(buildQuery(1, size))
    const head = data?.list || []
    const seen = new Set<number>()
    records.value = [...head, ...records.value.slice(size)].filter(item => {
      if (seen.has(item.runId)) return false
      seen.add(item.runId)
      return true
    })
    stats.value = data?.stats || stats.value
    total.value = Number(data?.pagination?.total || total.value)
    ensureHistoryPolling()
  } catch {
    // 轮询失败不打扰用户，下个周期重试
  }
}

// —— 滚动分页：以列表容器为 root 观察底部哨兵 ——
const listRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

const reobserveSentinel = () => {
  const sentinel = sentinelRef.value
  if (!observer || !sentinel) return
  observer.unobserve(sentinel)
  observer.observe(sentinel)
}

watch([sentinelRef, listRef], ([sentinel, list]) => {
  observer?.disconnect()
  observer = null
  if (!sentinel || !list) return
  observer = new IntersectionObserver(
    entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore()
    },
    { root: list, rootMargin: '240px' }
  )
  observer.observe(sentinel)
})

// —— 生成中任务的进度轮询 ——
let historyTimer: ReturnType<typeof setInterval> | null = null
const stopHistoryPolling = () => {
  if (historyTimer) {
    clearInterval(historyTimer)
    historyTimer = null
  }
}
const ensureHistoryPolling = () => {
  const hasRunning = records.value.some(item => item.displayStatus === 'generating')
  if (hasRunning && !historyTimer) historyTimer = setInterval(() => void refreshLoaded(), 5000)
  else if (!hasRunning) stopHistoryPolling()
}

const setStatus = (status: string) => {
  query.status = status
  void reload()
}

// 返回上一个工作流页面（通常是带 runId 的草稿），无历史栈时回到工作流主页。
const goBack = () => {
  if (window.history.length > 1) router.back()
  else void router.push('/workflowBook')
}

// ?new=1 强制新建：否则会被「恢复上次未完成的 run」逻辑接管，点了创建却回到旧流程
const createWorkflow = () => {
  void router.push({ path: '/workflowBook', query: { new: '1' } })
}

const editSettings = (item: WorkflowHistoryRecord) => {
  void router.push({ path: '/workflowBook', query: { id: String(item.runId) } })
}

// 纯进入作品：不带 workflow 续跑参数，写作页不会拉起自动生文面板
const enterBook = (item: WorkflowHistoryRecord) => {
  if (!item.bookId) return
  void router.push({ path: `/writing/${item.bookId}` })
}

const openBook = (item: WorkflowHistoryRecord) => {
  if (!item.bookId) return
  const activeTask = item.activeTask
  const workflowTaskId = Number(
    activeTask?.id && (
      ['queued', 'running', 'paused', 'interrupted', 'review_required', 'failed', 'canceled'].includes(activeTask.status) ||
      (
        activeTask.status === 'succeeded' &&
        Number(item.finishedChapters || 0) < Number(item.totalChapters || 0)
      )
    )
      ? activeTask.id
      : 0
  )
  const queryParams = workflowTaskId
    ? { from: 'workflow', runId: String(item.runId), taskId: String(workflowTaskId) }
    : {}
  void router.push({ path: `/writing/${item.bookId}`, query: queryParams })
}

// 已有任务先恢复；没有任务时创建新任务，再进入自动生文页。
const continueWriting = async (item: WorkflowHistoryRecord) => {
  if (!item.bookId || actionId.value) return
  actionId.value = item.runId
  try {
    if (item.activeTask?.id) {
      await resumeWorkflowTaskApi({ taskId: item.activeTask.id })
      openBook(item)
      return
    }
    const { data } = await generateWorkflowBookApi({ runId: item.runId })
    if ('conflict' in data) {
      ElMessage.warning(data.message || '当前有自动生文任务正在运行')
      await refreshLoaded()
      return
    }
    if (!data.bookId) throw new Error('工作流未返回书籍ID')
    await router.push({
      path: `/writing/${data.bookId}`,
      query: {
        from: 'workflow',
        runId: String(data.runId || item.runId),
        taskId: String(data.id),
      },
    })
  } catch (error) {
    ElMessage.error(error?.message || '继续生成失败')
  } finally {
    actionId.value = 0
  }
}

const pauseGenerate = async (item: WorkflowHistoryRecord) => {
  if (!item.activeTask?.id) return
  actionId.value = item.runId
  try {
    await pauseWorkflowTaskApi({ taskId: item.activeTask.id })
    ElMessage.success('已提交暂停请求')
    await refreshLoaded()
  } catch (error) {
    ElMessage.error(error?.message || '暂停生成失败')
  } finally {
    actionId.value = 0
  }
}

const removeRun = async (item: WorkflowHistoryRecord) => {
  try {
    await inkConfirm('删除后该工作流方案不可恢复，已生成书籍不会被删除。', '删除工作流', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    actionId.value = item.runId
    await deleteWorkflowApi({ id: item.runId })
    ElMessage.success('已删除工作流')
    await reload()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除失败')
  } finally {
    actionId.value = 0
  }
}

const hasAction = (item: WorkflowHistoryRecord, action: WorkflowAvailableAction) =>
  item.availableActions.includes(action)

const isStepGenerating = (item: WorkflowHistoryRecord) =>
  Boolean(item.stepTask?.id) && ['queued', 'running'].includes(item.stepTask?.status || '')

const isStepFailed = (item: WorkflowHistoryRecord) =>
  Boolean(item.stepTask?.id) && ['failed', 'interrupted'].includes(item.stepTask?.status || '')

const resolveEditSettingsLabel = (item: WorkflowHistoryRecord) => {
  if (isStepFailed(item)) return '返回重试'
  if (isStepGenerating(item)) return '查看进度'
  return item.bookId ? '修改设定' : '继续编辑'
}

const isEditPrimary = (item: WorkflowHistoryRecord) => !item.bookId

const STEP_TASK_LABELS: Record<string, string> = {
  inspiration: '正在生成灵感',
  outline: '正在生成大纲',
  setting: '正在生成设定',
}
const resolveStepTaskLabel = (step?: string) => STEP_TASK_LABELS[String(step || '')] || '正在生成'

const cancelGeneration = async (item: WorkflowHistoryRecord) => {
  const stepGenerating = isStepGenerating(item)
  const taskId = stepGenerating ? item.stepTask?.id : item.activeTask?.id
  if (!taskId) return
  try {
    await inkConfirm(
      stepGenerating
        ? '确定取消当前生成吗？已完成的内容会保留。'
        : '停止后，已生成的书籍和正文都会保留，可以继续手动编辑。',
      stepGenerating ? '取消生成' : '停止自动生成',
      {
        confirmButtonText: stepGenerating ? '取消生成' : '停止生成',
        cancelButtonText: '继续等待',
        type: 'warning',
      }
    )
  } catch {
    return
  }
  actionId.value = item.runId
  try {
    await cancelWorkflowTaskApi({ taskId })
    ElMessage.success(stepGenerating ? '已取消当前生成' : '已停止自动生成')
    await refreshLoaded()
  } catch (error) {
    ElMessage.error(error?.message || (stepGenerating ? '取消生成失败' : '停止自动生成失败'))
  } finally {
    actionId.value = 0
  }
}

const resolveStatusTone = (status: string) => {
  if (status === 'generating') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'attention' || status === 'paused') return 'alert'
  if (status === 'canceled') return 'muted'
  return 'draft'
}

const resolveStatusIcon = (status: string) => {
  const icons: Record<string, string> = {
    generating: 'fa-solid fa-feather-pointed',
    completed: 'fa-regular fa-circle-check',
    attention: 'fa-solid fa-triangle-exclamation',
    paused: 'fa-solid fa-circle-pause',
    canceled: 'fa-solid fa-ban',
  }
  return icons[status] || 'fa-solid fa-hourglass-half'
}

const resolveStatusLabel = (item: WorkflowHistoryRecord) => {
  const requestedAction = item.activeTask?.requestedAction || item.stepTask?.requestedAction
  if (requestedAction === 'pause') return '正在暂停'
  if (requestedAction === 'cancel') return '正在停止'
  const labels: Record<string, string> = {
    generating: '生成中',
    completed: '已完成',
    paused: '已暂停',
    attention: '需要处理',
    canceled: '已停止',
    draft: '草稿',
  }
  return labels[item.displayStatus] || '草稿'
}

const resolveStepLabel = (step: string) => {
  const labels: Record<string, string> = {
    MODE_SELECT: '灵感输入',
    BASE_CONFIG: '基础配置',
    OUTLINE_GENERATE: '生成大纲',
    SETTING_GENERATE: '生成设定',
  }
  return labels[step] || '工作流'
}

const resolveProgress = (item: WorkflowHistoryRecord) => {
  if (item.displayStatus === 'completed') return 100
  if (item.totalChapters > 0) {
    return Math.round(
      (Math.min(item.finishedChapters, item.totalChapters) / item.totalChapters) * 100
    )
  }
  return Math.min(100, Math.max(0, Math.round(item.progress || 0)))
}

const formatNumber = (value: number) => Number(value || 0).toLocaleString('zh-CN')

onMounted(() => void reload())
onUnmounted(() => {
  stopHistoryPolling()
  observer?.disconnect()
})
</script>

<style scoped lang="scss">
.wf-history {
  --wf-accent: var(--ink-accent);
  --wf-blue: #2f6fd0;
  --wf-green: #2e9c62;
  --wf-red: #d1503c;
  --wf-line: var(--ui-border);
  --wf-surface: var(--card-bg);
  --wf-shadow: var(--card-shadow);

  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 6px 0 10px;
  overflow: hidden;
  color: var(--ink-main);
}

:global(.theme-dark .wf-history) {
  --wf-blue: #7aa7e8;
  --wf-green: #5cc48a;
  --wf-red: #e8796a;
}

/* ---------- 通用按钮 ---------- */
.wf-btn {
  flex: 0 0 auto;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-main);
  font: inherit;
  font-size: 14px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.18s, box-shadow 0.18s, background 0.18s, color 0.18s;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}

.wf-btn--primary {
  border-color: var(--wf-accent);
  background: var(--wf-accent);
  color: var(--on-inverse);

  &:hover:not(:disabled) {
    box-shadow: 0 6px 16px color-mix(in srgb, var(--wf-accent) 30%, transparent);
  }
}

.wf-btn--book {
  border-color: var(--wf-green);
  background: var(--wf-green);
  color: #fff;

  &:hover:not(:disabled) {
    box-shadow: 0 6px 16px color-mix(in srgb, var(--wf-green) 32%, transparent);
  }
}

.wf-btn--ghost {
  border-color: var(--btn-outline-border, var(--wf-line));
  background: var(--btn-outline-bg, var(--wf-surface));

  &:hover:not(:disabled) {
    border-color: var(--wf-accent);
    color: var(--wf-accent);
  }
}

.wf-btn--danger {
  padding: 0 10px;
  color: var(--wf-red);

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--wf-red) 10%, transparent);
  }
}

/* ---------- 顶部返回 / 创建 ---------- */
.wf-history__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

/* ---------- 统计卡 ---------- */
.wf-history__stats {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.wf-stat {
  min-width: 0;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--wf-line);
  border-radius: 12px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow);
  color: var(--ink-main);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.18s, box-shadow 0.18s;

  &:hover {
    box-shadow: var(--card-shadow-hover);
  }

  &.is-active {
    border-color: var(--wf-accent);
    background: color-mix(in srgb, var(--wf-accent) 4%, var(--wf-surface));
  }
}

.wf-stat__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 13%, transparent);
  font-size: 16px;
}

.wf-stat--all .wf-stat__icon { color: var(--wf-accent); }
.wf-stat--running .wf-stat__icon { color: var(--wf-blue); }
.wf-stat--completed .wf-stat__icon { color: var(--wf-green); }
.wf-stat--interrupted .wf-stat__icon { color: var(--wf-red); }

.wf-stat__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.wf-stat__value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
}

/* ---------- 筛选栏 ---------- */
.wf-history__filter {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 200px 200px auto;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--wf-line);
  border-radius: 12px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow);
}

.wf-filter-control {
  :deep(.el-input__wrapper),
  :deep(.el-select__wrapper) {
    min-height: 40px;
    border-radius: 8px;
  }
}

.wf-history__filter .wf-btn {
  height: 40px;
  padding: 0 20px;
}

/* ---------- 列表（唯一滚动区） ---------- */
.wf-history__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.wf-row {
  --wf-tone: var(--wf-accent);
  min-width: 0;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 250px 172px auto;
  align-items: center;
  gap: 20px;
  padding: 16px 18px;
  border: 1px solid var(--wf-line);
  border-radius: 12px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow);

  &:hover {
    border-color: color-mix(in srgb, var(--wf-accent) 38%, var(--wf-line));
    box-shadow: var(--card-shadow-hover);
  }
}

.wf-tone--running { --wf-tone: var(--wf-blue); }
.wf-tone--done { --wf-tone: var(--wf-green); }
.wf-tone--alert { --wf-tone: var(--wf-red); }
.wf-tone--muted { --wf-tone: var(--ink-sec); }

.wf-row__status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  color: var(--wf-tone);

  em {
    font-style: normal;
    font-size: 12px;
    white-space: nowrap;
  }
}

.wf-row__status-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--wf-tone) 30%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--wf-tone) 9%, transparent);
  font-size: 17px;
}

.wf-row__main {
  min-width: 0;
  display: grid;
  gap: 8px;

  h2 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
  }
}

.wf-row__meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px 18px;
  color: var(--ink-sec);
  font-size: 13px;

  span {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    // 模型名可能很长；宁可省略也不要挤到换行，把行高撑破
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // 时间是定长且信息密度最高的一项，永远完整显示
  span:last-child {
    flex: 0 0 auto;
  }

  i {
    flex: 0 0 auto;
    color: var(--wf-accent);
    font-size: 12px;
  }
}

.wf-row__error {
  margin: 0;
  color: var(--wf-red);
  font-size: 13px;
  line-height: 1.5;
}

.wf-row__progress {
  min-width: 0;
  display: grid;
  gap: 10px;

  strong {
    font-size: 18px;
    font-weight: 600;
  }
}

.wf-bar {
  display: block;
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink-sec) 18%, transparent);

  // 进度条只区分「已完成=绿 / 已取消=灰 / 其余=主色橙」，
  // 不跟随状态色：中断行的图标是红的，但进度本身仍是可继续的橙色进度。
  i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--wf-accent);
    transition: width 0.3s ease;
  }
}

.wf-tone--done .wf-bar i { background: var(--wf-green); }
.wf-tone--muted .wf-bar i { background: var(--ink-sec); }

// 步骤生成没有真实百分比，用一段来回滑动的色块表示「在跑」，不谎报进度
.wf-bar--indeterminate i {
  width: 38%;
  animation: wf-bar-slide 1.3s ease-in-out infinite;
}

@keyframes wf-bar-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(263%); }
}

@media (prefers-reduced-motion: reduce) {
  .wf-bar--indeterminate i {
    width: 100%;
    animation: none;
    opacity: 0.55;
  }
}

// 和百分比同一套排版：状态色已由左侧状态圈承担，这里保持深墨色
.wf-row__progress-label {
  font-size: 15px;
  font-weight: 500;
}

.wf-row__stats {
  min-width: 0;
  display: grid;
  justify-items: start;
  gap: 8px;
  color: var(--ink-sec);
  font-size: 13px;
  line-height: 1.4;
}

.wf-badge-book {
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--wf-green) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--wf-green) 9%, transparent);
  color: var(--wf-green);
  font-style: normal;
  font-size: 12px;
}

.wf-row__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

/* ---------- 空态 / 加载更多 ---------- */
.wf-empty {
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--wf-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--wf-surface) 84%, transparent);
  color: var(--ink-sec);
  text-align: center;

  > i {
    color: var(--wf-accent);
    font-size: 26px;
  }

  strong {
    color: var(--ink-main);
    font-size: 16px;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

.wf-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 14px 0 4px;
  color: var(--ink-sec);
  font-size: 13px;
}

.wf-more--end {
  color: color-mix(in srgb, var(--ink-sec) 70%, transparent);
}

/* ---------- 响应式 ---------- */
@include content-max(1140px) {
  .wf-row {
    grid-template-columns: 68px minmax(0, 1fr) 180px 160px auto;
    gap: 16px;
  }
}

@include content-max(960px) {
  .wf-history__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wf-history__filter {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .wf-row {
    grid-template-columns: 68px minmax(0, 1fr);
    grid-template-areas:
      'status main'
      'progress progress'
      'stats actions';
    align-items: start;
    gap: 14px 16px;
  }

  .wf-row__status { grid-area: status; }
  .wf-row__main { grid-area: main; }
  .wf-row__progress { grid-area: progress; }
  .wf-row__stats { grid-area: stats; align-self: center; }

  .wf-row__actions {
    grid-area: actions;
    flex-wrap: wrap;
  }
}

@media (max-width: 720px) {
  .wf-history__stats {
    grid-template-columns: minmax(0, 1fr);
  }

  .wf-history__filter {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
