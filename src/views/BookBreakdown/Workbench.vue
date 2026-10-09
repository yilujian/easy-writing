<template>
  <div class="workbench-page">
    <header class="workbench-header">
      <div class="book-info">
        <button class="back-btn ink-btn ink-btn-outline" type="button" @click="handleBack">
          <i class="fa-solid fa-arrow-left"></i>
          返回
        </button>
        <div class="book-icon">
          <i class="fa-solid fa-book-open"></i>
        </div>
        <div class="book-meta">
          <div class="book-title">{{ bookTitle }}</div>
          <div class="book-sub" v-if="!initialLoading && !loadError">
            作者：{{ bookAuthor }} · {{ progressText }} · 总章数 {{ totalCount }}
          </div>
          <div class="book-sub" v-else>
            {{ initialLoading ? '正在加载工作台数据...' : '数据加载失败' }}
          </div>
        </div>
        <div class="book-tags" v-if="!initialLoading && !loadError">
          <span v-for="tag in bookTags" :key="tag" class="book-tag">{{ tag }}</span>
        </div>
      </div>

      <div class="header-actions" v-if="!initialLoading && !loadError">
        <button
          v-if="canShowReportButton"
          class="ink-btn ink-btn-outline"
          type="button"
          :disabled="reportGenerating"
          @click="handleBookReport"
        >
          <i v-if="reportGenerating" class="fa-solid fa-spinner fa-spin"></i>
          <i v-else class="fa-solid fa-book-open-reader"></i>
          {{ bookReport ? '查看全书报告' : '生成全书报告' }}
        </button>
        <!-- 开源版：PDF/Word 依赖服务端排版，导出改为 Markdown 客户端生成 -->
        <button class="ink-btn ink-btn-outline" type="button" @click="handleExport">
          <i class="fa-solid fa-download"></i>
          导出 Markdown
        </button>
        <button class="ink-btn ink-btn-primary" type="button" :disabled="running" @click="handleContinue">
          <i v-if="running" class="fa-solid fa-spinner fa-spin"></i>
          <i v-else class="fa-solid fa-robot"></i>
          继续拆解
        </button>
      </div>
    </header>

    <!-- 初次加载：骨架/加载态，避免停留在空白工作台 -->
    <section v-if="initialLoading" class="workbench-state">
      <div class="state-icon loading">
        <i class="fa-solid fa-spinner fa-spin"></i>
      </div>
      <div class="state-title">正在加载拆书工作台...</div>
      <div class="state-desc">正在拉取项目详情与章节目录，请稍候</div>
    </section>

    <!-- 加载失败：错误态 + 重试入口 -->
    <section v-else-if="loadError" class="workbench-state">
      <div class="state-icon error">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <div class="state-title">拆书数据加载失败</div>
      <div class="state-desc">可能是网络波动或服务暂时不可用，请稍后重试</div>
      <button class="ink-btn ink-btn-primary" type="button" @click="bootstrapWorkbench">
        <i class="fa-solid fa-rotate-right"></i>
        重试
      </button>
    </section>

    <section v-else class="split-view">
      <aside class="col-chapter">
        <div class="col-header">
          <div class="col-title">
            <span>目录</span>
            <span class="col-count">{{ doneCount }}/{{ totalCount }}</span>
          </div>
          <div class="filter-group">
            <button
              v-for="item in filterOptions"
              :key="item.value"
              type="button"
              class="filter-chip"
              :class="{ active: filterStatus === item.value }"
              @click="filterStatus = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <div class="chapter-list" @scroll="closeContextMenu">
          <div
            v-for="chapter in filteredChapters"
            :key="chapter.id"
            class="chapter-item"
            :class="{ active: chapter.id === selectedChapterId, 'is-failed': resolveChapterStatus(chapter) === 'failed' }"
            @click="handleSelectChapter(chapter.id)"
            @contextmenu.prevent="openContextMenu($event, chapter)"
          >
            <div class="chap-row">
              <span class="chap-name">{{ chapter.title }}</span>
              <span class="chap-status" :class="resolveChapterStatus(chapter)">
                <i :class="statusIcon(resolveChapterStatus(chapter))"></i>
                {{ statusLabel(resolveChapterStatus(chapter)) }}
              </span>
            </div>
            <div v-if="resolveChapterStatus(chapter) === 'failed'" class="chap-failed">
              <span class="chap-error">{{ chapter.errorMessage || '拆解失败，请重试' }}</span>
              <button type="button" class="chap-retry" :disabled="running" @click.stop="handleBreakdownChapter(Number(chapter.id))">
                <i class="fa-solid fa-rotate-right"></i> 重试
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="contextMenu.visible"
          ref="menuRef"
          class="chapter-menu"
          :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
        >
          <button type="button" class="menu-item" @click="handleMenuBreakdown">
            拆解本章
          </button>
          <button type="button" class="menu-item danger" @click="handleMenuDelete">
            删除本章
          </button>
        </div>

        <div class="batch-bar">
          <div class="batch-meta">
            <span>{{ batchSummaryText }}</span>
          </div>
          <button
            class="ink-btn ink-btn-primary"
            type="button"
            :disabled="running || retryableCount === 0"
            @click="handleBatch"
          >
            <i class="fa-solid fa-bolt"></i>
            {{ batchActionLabel }}
          </button>
        </div>
      </aside>

      <div class="col-reader">
        <div class="reader-header">
          <div>
            <div class="reader-title">{{ currentChapter?.title }}</div>
            <div class="reader-sub">已拆解节点：{{ insightList.length }} 个</div>
          </div>
          <div class="reader-actions">
            <button v-if="activeInsightId" class="ink-btn ink-btn-outline" type="button" @click="resetHighlight">
              取消高亮
            </button>
          </div>
        </div>

        <div class="reader-content">
          <p
            v-for="para in currentParagraphs"
            :key="para.id"
            class="reader-paragraph"
            :class="{
              highlight: activeInsightId !== null && para.insightId === activeInsightId,
              active: activeInsightId !== null && para.insightId === activeInsightId
            }"
            @click="para.insightId && selectInsight(para.insightId)"
          >
            {{ para.text }}
          </p>
        </div>
      </div>

      <aside class="col-insight">
        <div class="insight-header">
          <div class="insight-title">
            <i class="fa-solid fa-feather-pointed"></i>
            解析面板
          </div>
          <div class="insight-sub">
            节点 {{ insightList.length }} · 细纲 {{ chapterSummary ? '已生成' : '未生成' }}
          </div>
        </div>
        <div class="insight-body">
          <div class="insight-pane">
            <!-- 黄金三章深拆（前三章）：开篇钩子/人设/核心困境 + 原文锚点 -->
            <template v-if="goldenAnalysis">
              <div class="pane-title golden-title">
                <i class="fa-solid fa-crown"></i>
                黄金三章深拆
              </div>
              <div class="dim-list golden-list">
                <div v-if="goldenAnalysis.hook300" class="dim-item">
                  <span class="dim-key">前300字钩子</span>
                  <span class="dim-desc">{{ goldenAnalysis.hook300 }}</span>
                </div>
                <div v-if="goldenAnalysis.characterEstablish" class="dim-item">
                  <span class="dim-key">人设立住判定</span>
                  <span class="dim-desc">{{ goldenAnalysis.characterEstablish }}</span>
                </div>
                <div v-if="goldenAnalysis.coreDilemma" class="dim-item">
                  <span class="dim-key">核心困境</span>
                  <span class="dim-desc">{{ goldenAnalysis.coreDilemma }}</span>
                </div>
                <div v-for="(anchor, i) in goldenAnalysis.anchors || []" :key="`g-${i}`" class="dim-item anchor-item">
                  <span class="dim-key">原文锚点</span>
                  <span class="dim-desc">「{{ anchor.quote }}」—— {{ anchor.comment }}</span>
                </div>
              </div>
            </template>

            <div class="pane-title">剧情细纲</div>
            <div v-if="chapterSummary" class="summary-block">
              <div class="summary-title">本章细纲</div>
              <div class="summary-text">{{ chapterSummary }}</div>
            </div>
            <div class="pane-title">关键节点拆解</div>
            <div class="insight-cards">
              <button
                v-for="card in insightList"
                :key="card.id"
                type="button"
                class="insight-card"
                :class="{ active: card.id === activeInsightId }"
                @click="selectInsight(card.id)"
              >
                <div class="card-head">
                  <span>{{ card.title }}</span>
                  <span class="card-range">{{ card.range }}</span>
                </div>
                <div class="card-text">{{ card.text }}</div>
                <div class="tag-row">
                  <span v-for="tag in card.tags" :key="tag.text" class="tag" :class="tag.tone">
                    {{ tag.text }}
                  </span>
                </div>
              </button>
            </div>

            <template v-if="rhythmList.length">
              <div class="pane-title">爽点节奏</div>
              <div class="dim-list">
                <div v-for="(item, i) in rhythmList" :key="`r-${i}`" class="dim-item">
                  <span class="dim-key">{{ item.label }}<em v-if="item.value">·{{ item.value }}</em></span>
                  <span class="dim-desc">{{ item.desc }}</span>
                </div>
              </div>
            </template>

            <template v-if="settingList.length">
              <div class="pane-title">世界观设定</div>
              <div class="dim-list">
                <div v-for="(item, i) in settingList" :key="`s-${i}`" class="dim-item">
                  <span class="dim-key">{{ item.name }}<em v-if="item.type">·{{ item.type }}</em></span>
                  <span class="dim-desc">{{ item.desc }}</span>
                </div>
              </div>
            </template>

            <template v-if="relationList.length">
              <div class="pane-title">人物关系</div>
              <div class="dim-list">
                <div v-for="(item, i) in relationList" :key="`rel-${i}`" class="dim-item">
                  <span class="dim-key">{{ item.from }} → {{ item.to }}<em>{{ item.relation }}</em></span>
                  <span class="dim-desc">{{ item.desc }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </aside>
    </section>

    <!-- 全书汇总报告：大纲反推 / 人物弧线 / 伏笔账本 / 爽点曲线 / 编辑手记 -->
    <el-drawer v-model="reportVisible" title="全书拆解报告" size="62%">
      <div v-if="bookReport" class="report-body">
        <template v-if="bookReport.editorNotes">
          <div class="pane-title">编辑手记</div>
          <p class="report-notes">{{ bookReport.editorNotes }}</p>
        </template>

        <template v-if="(bookReport.outlineRecovery || []).length">
          <div class="pane-title">大纲反推</div>
          <div class="dim-list">
            <div v-for="(item, i) in bookReport.outlineRecovery" :key="`o-${i}`" class="dim-item">
              <span class="dim-key">{{ item.stage }}<em v-if="item.chapters">·{{ item.chapters }}章</em></span>
              <span class="dim-desc">{{ item.goal }}{{ item.payoff ? `；兑现：${item.payoff}` : '' }}</span>
            </div>
          </div>
        </template>

        <template v-if="(bookReport.characterArcs || []).length">
          <div class="pane-title">人物弧线</div>
          <div class="dim-list">
            <div v-for="(item, i) in bookReport.characterArcs" :key="`c-${i}`" class="dim-item">
              <span class="dim-key">{{ item.name }}<em v-if="(item.keyChapters || []).length">·关键章 {{ (item.keyChapters || []).join('/') }}</em></span>
              <span class="dim-desc">{{ item.arc }}</span>
            </div>
          </div>
        </template>

        <template v-if="(bookReport.foreshadowLedger || []).length">
          <div class="pane-title">伏笔账本</div>
          <div class="dim-list">
            <div v-for="(item, i) in bookReport.foreshadowLedger" :key="`f-${i}`" class="dim-item">
              <span class="dim-key">
                第{{ item.plantChapter }}章埋设
                <em v-if="item.status === 'recovered'">→ 第{{ item.payoffChapter }}章回收</em>
                <em v-else class="pending-mark">未回收</em>
              </span>
              <span class="dim-desc">{{ item.item }}</span>
            </div>
          </div>
        </template>

        <template v-if="(bookReport.pacingCurve || []).length">
          <div class="pane-title">爽点强度曲线（1-5）</div>
          <div class="pacing-curve">
            <div
              v-for="point in bookReport.pacingCurve"
              :key="`p-${point.chapterNo}`"
              class="pacing-bar"
              :title="`第${point.chapterNo}章 ${point.label || ''}（${point.score}）`"
            >
              <span class="pacing-fill" :style="{ height: `${point.score * 20}%` }"></span>
            </div>
          </div>
        </template>

        <template v-if="(bookReport.reusableTechniques || []).length">
          <div class="pane-title">可复用技巧</div>
          <ol class="report-techniques">
            <li v-for="(item, i) in bookReport.reusableTechniques" :key="`t-${i}`">{{ item }}</li>
          </ol>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import type {
  BreakdownBillingConfig,
  BreakdownChapterDetail,
  BreakdownChapterItem,
  BreakdownProjectDetail
} from '@/types/breakdown'
// 开源版：拆书数据与拆解全走本地（IndexedDB + 本地模型直连），导出为 Markdown
import {
  deleteLocalBreakdownChapter as deleteBreakdownChapterApi,
  estimateLocalBreakdown as estimateBreakdownApi,
  exportLocalBreakdownMarkdown,
  getLocalBreakdownChapterDetail as getBreakdownChapterDetailApi,
  getLocalBreakdownChapterList as getBreakdownChapterListApi,
  getLocalBreakdownDetail as getBreakdownDetailApi,
} from '@/storage/local-breakdown'
import {
  continueLocalBreakdown as continueBreakdownApi,
  generateLocalBreakdownReport as generateBreakdownReportApi,
} from '@/utils/local-breakdown-engine'
import { saveBlobFile } from '@/utils/download'
import { showApiError } from '@/utils/api-error'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId || 0))

const projectDetail = ref<BreakdownProjectDetail | null>(null)
const chapterList = ref<BreakdownChapterItem[]>([])
const selectedChapterId = ref<number | null>(null)
const chapterDetail = ref<BreakdownChapterDetail | null>(null)
const running = ref(false)
const pageActive = ref(true)
const leaveNotified = ref(false)
// 初次加载工作台数据的加载态与失败态（失败时提供重试入口）
const initialLoading = ref(true)
const loadError = ref(false)
const billingConfig = ref<BreakdownBillingConfig>({
  pointRate: 1,
  tokenUnitChars: 4,
  tokenUnitSize: 1000
})
const batchEstimate = ref({
  chapterIds: [] as number[],
  chapterCount: 0,
  words: 0,
  cost: 0,
  pointRate: 1
})
const projectPollTimer = ref<number | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  chapter: null as BreakdownChapterItem | null
})

const bookTitle = computed(() => projectDetail.value?.title || '未命名作品')
const bookAuthor = computed(() => projectDetail.value?.author || '未知作者')
const bookTags = computed(() => {
  const tags = projectDetail.value?.tags || []
  return tags.length ? tags : ['未设置标签']
})

const currentChapter = computed(() => chapterList.value.find((item) => item.id === selectedChapterId.value))
const totalCount = computed(() => Number(projectDetail.value?.chapterCount || chapterList.value.length))
const doneCount = computed(() => chapterList.value.filter((item) => item.status === 'done').length)
const retryableCount = computed(() => chapterList.value.filter((item) => item.status === 'wait' || item.status === 'failed').length)
const hasRunningJob = computed(() => {
  if (running.value) return true
  return (
    projectDetail.value?.status === 'processing' ||
    Number(projectDetail.value?.statusSummary?.processing || 0) > 0 ||
    chapterList.value.some((item) => item.status === 'processing')
  )
})
const progressText = computed(() => {
  const progress = Math.round(Number(projectDetail.value?.progress || 0))
  const status = projectDetail.value?.status || 'wait'
  if (status === 'done') return '已完成'
  if (status === 'failed') return `失败 · 已完成 ${progress}%`
  if (status === 'wait') return '排队中'
  return `拆解中 ${progress}%`
})

const filterStatus = ref<'all' | 'done' | 'wait' | 'failed'>('all')
const filterOptions: Array<{ label: string; value: 'all' | 'done' | 'wait' | 'failed' }> = [
  { label: '全部', value: 'all' },
  { label: '已拆', value: 'done' },
  { label: '待拆', value: 'wait' },
  { label: '失败', value: 'failed' }
]

const activeInsightId = ref<number | null>(null)

const insightList = computed(() => chapterDetail.value?.analysis?.outline || [])
const chapterSummary = computed(() => chapterDetail.value?.analysis?.summary || '')
const rhythmList = computed(() => chapterDetail.value?.analysis?.rhythm || [])
const settingList = computed(() => chapterDetail.value?.analysis?.setting || [])
const relationList = computed(() => chapterDetail.value?.analysis?.relations || [])
// 黄金三章深拆产物（前三章才有）
const goldenAnalysis = computed(() => chapterDetail.value?.analysis?.golden || null)

// ---- 全书汇总报告 ----
const reportVisible = ref(false)
const reportGenerating = ref(false)
const bookReport = computed(() => projectDetail.value?.report || null)
const canShowReportButton = computed(
  () => Boolean(projectDetail.value?.canGenerateReport) || Boolean(bookReport.value)
)

const handleBookReport = async () => {
  if (bookReport.value) {
    reportVisible.value = true
    return
  }
  const projectId = Number(projectDetail.value?.id || 0)
  if (!projectId || reportGenerating.value) return
  try {
    await inkConfirm(
      '将基于全部已拆解章节生成全书报告（大纲反推/人物弧线/伏笔账本/爽点曲线/编辑手记），本地模型生成约需 1-2 分钟。',
      '生成全书报告',
      { confirmButtonText: '开始生成', cancelButtonText: '取消', type: 'info' }
    )
  } catch {
    return
  }
  reportGenerating.value = true
  try {
    await generateBreakdownReportApi({ projectId })
    await refreshDetailOnly()
    reportVisible.value = true
    ElMessage.success('全书报告已生成')
  } catch (error) {
    showApiError(error, '生成全书报告失败')
  } finally {
    reportGenerating.value = false
  }
}

const refreshDetailOnly = async () => {
  const projectId = Number(projectDetail.value?.id || 0)
  if (!projectId) return
  try {
    const res = await getBreakdownDetailApi(projectId)
    projectDetail.value = res.data
  } catch {
    // 静默
  }
}

const filteredChapters = computed(() => {
  if (filterStatus.value === 'all') return chapterList.value
  return chapterList.value.filter((item) => item.status === filterStatus.value)
})

const currentParagraphs = computed(() => chapterDetail.value?.paragraphs || [])

const formatWords = (words: number) => {
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`
  return `${words} 字`
}

const batchActionCount = computed(() => Math.min(Number(batchEstimate.value.chapterCount || 0), 5))
const batchActionLabel = computed(() => {
  const count = batchActionCount.value
  return count > 0 ? `批量拆解后 ${count} 章` : '批量拆解后 5 章'
})
const batchSummaryText = computed(() => {
  const count = Number(batchEstimate.value.chapterCount || 0)
  if (!count) return '暂无可拆章节'
  return `本次将拆 ${count} 章 · 约 ${formatWords(batchEstimate.value.words)}`
})

const canRequest = () => pageActive.value && Boolean(projectId.value)

const refreshBatchEstimate = async () => {
  if (!canRequest()) return
  try {
    const { data } = await estimateBreakdownApi({ projectId: projectId.value, count: 5 })
    if (!pageActive.value) return
    batchEstimate.value = {
      chapterIds: data.chapterIds || [],
      chapterCount: Number(data.chapterCount || 0),
      words: Number(data.words || 0),
      cost: Number(data.cost || 0),
      pointRate: Number(data.pointRate || billingConfig.value.pointRate || 1)
    }
  } catch (error) {
    if (!pageActive.value) return
    batchEstimate.value = {
      chapterIds: [],
      chapterCount: 0,
      words: 0,
      cost: 0,
      pointRate: Number(billingConfig.value.pointRate || 1)
    }
  }
}

const loadProject = async () => {
  if (!canRequest()) {
    ElMessage.warning('未选择拆书项目')
    router.push('/bookBreakdown')
    return
  }
  initialLoading.value = true
  loadError.value = false
  try {
    const [detailRes, chaptersRes] = await Promise.all([
      getBreakdownDetailApi(projectId.value),
      getBreakdownChapterListApi(projectId.value)
    ])
    projectDetail.value = detailRes.data
    billingConfig.value = detailRes.data.billing || billingConfig.value
    const chapters = chaptersRes.data || []
    chapterList.value = chapters
    await refreshBatchEstimate()
    if (chapters.length) {
      selectedChapterId.value = chapters[0].id
    }
  } catch (error) {
    // 初次加载失败：切到错误态，模板展示重试入口，避免停留在空工作台。
    loadError.value = true
    ElMessage.error('获取拆书数据失败')
  } finally {
    initialLoading.value = false
  }
}

// 初次加载 / 失败后重试：拉数据并按需重启后台进度轮询
const bootstrapWorkbench = () => {
  void loadProject().then(() => {
    startProjectPolling()
  })
}

const loadChapterDetail = async (id: number) => {
  if (!id || !canRequest()) return
  try {
    const { data } = await getBreakdownChapterDetailApi(id)
    if (!pageActive.value) return
    chapterDetail.value = data
    activeInsightId.value = data.analysis?.outline?.[0]?.id || null
  } catch (error) {
    chapterDetail.value = null
  }
}

watch(selectedChapterId, (val) => {
  if (val) loadChapterDetail(val)
})

const refreshChapters = async () => {
  if (!canRequest()) return
  const { data } = await getBreakdownChapterListApi(projectId.value)
  if (!pageActive.value) return
  chapterList.value = data
  await refreshBatchEstimate()
}

const refreshProject = async () => {
  if (!canRequest()) return
  const { data } = await getBreakdownDetailApi(projectId.value)
  if (!pageActive.value) return
  projectDetail.value = data
  billingConfig.value = data.billing || billingConfig.value
}

const confirmConsume = async (count: number) => {
  try {
    const { data: estimate } = await estimateBreakdownApi({ projectId: projectId.value, count })
    if (!estimate.chapterCount) {
      ElMessage.info('暂无待拆章节')
      return null
    }
    await inkConfirm(
      `本次将用本地模型拆解约 ${formatWords(estimate.words)}（${estimate.chapterCount} 章），确认继续？`,
      '发起拆解',
      {
        type: 'warning',
        confirmButtonText: '确认拆解',
        cancelButtonText: '取消'
      }
    )
    return estimate
  } catch (error) {
    return null
  }
}

const selectInsight = (id: number) => {
  activeInsightId.value = id
}

const resetHighlight = () => {
  activeInsightId.value = null
}

const handleSelectChapter = (chapterId: number) => {
  const nextId = Number(chapterId)
  if (!nextId) return
  if (selectedChapterId.value === nextId) return
  selectedChapterId.value = nextId
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollChapterStatus = async (chapterIds: number[], maxRounds = 30) => {
  if (!canRequest() || !chapterIds.length) return false
  for (let i = 0; i < maxRounds; i += 1) {
    await sleep(2000)
    if (!canRequest()) return false
    try {
      const [{ data }, { data: project }] = await Promise.all([
        getBreakdownChapterListApi(projectId.value),
        getBreakdownDetailApi(projectId.value)
      ])
      if (!pageActive.value) return false
      chapterList.value = data
      projectDetail.value = project
      const done = data
        .filter((item) => chapterIds.includes(item.id))
        .every((item) => item.status === 'done' || item.status === 'failed')
      if (done) return true
    } catch (error) {
      // 忽略单次轮询异常
    }
  }
  return false
}

const resolveChapterStatus = (chapter: BreakdownChapterItem) => {
  return chapter.status
}

const openContextMenu = async (event: MouseEvent, chapter: BreakdownChapterItem) => {
  const { clientX, clientY } = event
  contextMenu.value = {
    visible: true,
    x: clientX,
    y: clientY,
    chapter
  }
  handleSelectChapter(chapter.id)
  await nextTick()
  const menuEl = menuRef.value
  if (!menuEl) return
  const rect = menuEl.getBoundingClientRect()
  const maxX = window.innerWidth - rect.width - 12
  const maxY = window.innerHeight - rect.height - 12
  contextMenu.value = {
    ...contextMenu.value,
    x: Math.max(12, Math.min(contextMenu.value.x, maxX)),
    y: Math.max(12, Math.min(contextMenu.value.y, maxY))
  }
}

const closeContextMenu = () => {
  if (!contextMenu.value.visible) return
  contextMenu.value = {
    visible: false,
    x: 0,
    y: 0,
    chapter: null
  }
}

const statusLabelMap: Record<BreakdownChapterItem['status'], string> = {
  done: '已拆',
  processing: '拆解中',
  wait: '待拆',
  failed: '失败'
}

const statusIconMap: Record<BreakdownChapterItem['status'], string> = {
  done: 'fa-solid fa-check',
  processing: 'fa-solid fa-spinner fa-spin',
  wait: 'fa-regular fa-clock',
  failed: 'fa-solid fa-circle-exclamation'
}

const statusLabel = (status: BreakdownChapterItem['status']) => statusLabelMap[status]
const statusIcon = (status: BreakdownChapterItem['status']) => statusIconMap[status]

const stopProjectPolling = () => {
  if (projectPollTimer.value) {
    window.clearInterval(projectPollTimer.value)
    projectPollTimer.value = null
  }
}

const startProjectPolling = () => {
  stopProjectPolling()
  if (!projectId.value || !hasRunningJob.value) return
  projectPollTimer.value = window.setInterval(() => {
    void Promise.all([refreshProject(), refreshChapters()])
  }, 3000)
}

const safeFilename = (name: string) => String(name || 'breakdown').replace(/[/:*?"<>|]/g, '_')

const formatExportDate = (date: Date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}


const handleExport = async () => {
  if (!projectId.value) return
  if (doneCount.value <= 0) {
    ElMessage.warning('还没有已拆解的章节，先拆解后再导出')
    return
  }
  try {
    const filename = `${safeFilename(bookTitle.value)}-拆书报告-${formatExportDate(new Date())}.md`
    const blob = await exportLocalBreakdownMarkdown({ projectId: projectId.value })
    const saved = await saveBlobFile(blob, filename)
    if (!saved) return
    ElMessage.success('已导出 Markdown 报告')
  } catch (error) {
    ElMessage.error(String(error?.message || '导出失败，请稍后重试'))
  }
}

const handleContinue = async () => {
  if (running.value || !projectId.value) return
  // 若正看着某一待拆/失败章，"继续拆解"就拆这一章，符合直觉；否则拆下一个待拆章。
  const selected = chapterList.value.find(item => Number(item.id) === Number(selectedChapterId.value))
  if (selected && ['wait', 'failed'].includes(resolveChapterStatus(selected))) {
    await handleBreakdownChapter(Number(selected.id))
    return
  }
  const estimate = await confirmConsume(1)
  if (!estimate) return
  running.value = true
  try {
    const { data: result } = await continueBreakdownApi({ projectId: projectId.value, count: 1, async: 1 })
    const chapterIds = result.chapterIds || []
    await Promise.all([refreshProject(), refreshChapters()])
    startProjectPolling()
    const finished = await pollChapterStatus(chapterIds)
    await Promise.all([refreshChapters(), refreshProject()])
    startProjectPolling()
    if (selectedChapterId.value) {
      await loadChapterDetail(selectedChapterId.value)
    }
    if (finished) {
      ElMessage.success('拆解完成')
    } else {
      ElMessage.info('拆解仍在进行，请稍后刷新查看')
    }
  } catch (error) {
    ElMessage.error('拆解失败，请稍后重试')
  } finally {
    running.value = false
  }
}

const handleBreakdownChapter = async (chapterId: number) => {
  if (!projectId.value || !chapterId) return
  let estimate: Awaited<ReturnType<typeof estimateBreakdownApi>>['data']
  try {
    const res = await estimateBreakdownApi({
      projectId: projectId.value,
      chapterIds: [chapterId]
    })
    estimate = res.data
    if (!estimate.chapterCount) {
      ElMessage.info('暂无待拆章节')
      return
    }
    await inkConfirm(
      `本次将用本地模型拆解约 ${formatWords(estimate.words)}（${estimate.chapterCount} 章），确认继续？`,
      '发起拆解',
      {
        type: 'warning',
        confirmButtonText: '确认拆解',
        cancelButtonText: '取消'
      }
    )
  } catch (error) {
    return
  }
  try {
    const { data: result } = await continueBreakdownApi({
      projectId: projectId.value,
      chapterIds: [chapterId],
      async: 1
    })
    const chapterIds = result.chapterIds || [chapterId]
    await Promise.all([refreshProject(), refreshChapters()])
    startProjectPolling()
    const finished = await pollChapterStatus(chapterIds)
    await Promise.all([refreshChapters(), refreshProject()])
    startProjectPolling()
    if (selectedChapterId.value) {
      await loadChapterDetail(selectedChapterId.value)
    }
    if (finished) {
      ElMessage.success('拆解完成')
    } else {
      ElMessage.info('拆解仍在进行，请稍后刷新查看')
    }
  } catch (error) {
    ElMessage.error('拆解失败，请稍后重试')
  }
}

const handleDeleteChapter = async (chapterId: number) => {
  if (!projectId.value || !chapterId) return
  await inkConfirm('删除后无法恢复，确认删除该章节？', '删除章节', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消'
  })
  try {
    await deleteBreakdownChapterApi({ id: chapterId })
    await Promise.all([refreshChapters(), refreshProject()])
    if (selectedChapterId.value === chapterId) {
      selectedChapterId.value = chapterList.value[0]?.id || null
    }
    ElMessage.success('章节已删除')
  } catch (error) {
    ElMessage.error('删除失败，请稍后重试')
  }
}

const handleMenuBreakdown = async () => {
  const chapter = contextMenu.value.chapter
  closeContextMenu()
  if (!chapter) return
  await handleBreakdownChapter(chapter.id)
}

const handleMenuDelete = async () => {
  const chapter = contextMenu.value.chapter
  closeContextMenu()
  if (!chapter) return
  await handleDeleteChapter(chapter.id)
}

const handleBatch = async () => {
  if (running.value || !projectId.value || retryableCount.value === 0) return
  const estimate = await confirmConsume(5)
  if (!estimate) return
  running.value = true
  try {
    const { data: result } = await continueBreakdownApi({ projectId: projectId.value, count: 5, async: 1 })
    const chapterIds = result.chapterIds || []
    await Promise.all([refreshProject(), refreshChapters()])
    startProjectPolling()
    const finished = await pollChapterStatus(chapterIds)
    await Promise.all([refreshChapters(), refreshProject()])
    startProjectPolling()
    if (selectedChapterId.value) {
      await loadChapterDetail(selectedChapterId.value)
    }
    if (finished) {
      ElMessage.success('批量拆解完成')
    } else {
      ElMessage.info('拆解仍在进行，请稍后刷新查看')
    }
  } catch (error) {
    ElMessage.error('拆解失败，请稍后重试')
  } finally {
    running.value = false
  }
}

const handleBack = () => {
  router.push('/bookBreakdown')
}

onMounted(() => {
  bootstrapWorkbench()
  document.addEventListener('click', closeContextMenu)
})

watch(
  hasRunningJob,
  (runningNow) => {
    if (runningNow) {
      startProjectPolling()
    } else {
      stopProjectPolling()
    }
  },
  { immediate: true }
)

onBeforeRouteLeave(() => {
  if (!leaveNotified.value && hasRunningJob.value) {
    leaveNotified.value = true
    ElMessage.info('拆解仍在后台进行，稍后可在拆书历史中查看进度')
  }
})

onBeforeUnmount(() => {
  pageActive.value = false
  stopProjectPolling()
  document.removeEventListener('click', closeContextMenu)
})
</script>

<style scoped lang="scss">
.workbench-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 16px 40px;
  min-height: 100%;
  height: 100%;
  overflow: hidden;
  // background: var(--bg-main);
  --chart-grid-color: color-mix(in srgb, var(--ink-main) 6%, transparent);
}

.workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-radius: 16px;
  background: var(--card-bg, var(--ui-glass-bg));
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow);
}

.book-info {
  display: flex;
  align-items: center;
  gap: 14px;
}

.back-btn {
  padding: 6px 12px;
  font-size: 12px;
}

.book-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink-accent) 15%, transparent);
  color: var(--ink-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.book-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-title {
  font-size: 18px;
  font-weight: 600;
  font-family: 'Noto Serif SC', serif;
}

.book-sub {
  font-size: 12px;
  color: var(--ink-sec);
}

.book-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.book-tag {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);
  color: var(--ink-accent);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.split-view {
  flex: 1;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 360px;
  gap: 0;
  min-height: 0;
  // background: var(--card-bg, var(--ui-glass-bg));
  border-radius: 16px;
  border: 1px solid var(--ui-border);
  overflow: hidden;
  box-shadow: var(--ui-shadow);
}

/* 初次加载 / 加载失败占位（替换三栏工作台区域） */
.workbench-state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 24px;
  text-align: center;
  border-radius: 16px;
  border: 1px solid var(--ui-border);
  background: var(--card-bg, var(--ui-glass-bg));
  box-shadow: var(--ui-shadow);
}

.workbench-state .state-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  color: var(--ink-accent);
}

.workbench-state .state-icon.error {
  background: var(--state-danger-surface, rgba(198, 62, 46, 0.12));
  color: var(--state-danger, var(--state-danger));
}

.workbench-state .state-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink-main);
}

.workbench-state .state-desc {
  font-size: 13px;
  color: var(--ink-sec);
}

.workbench-state .ink-btn {
  margin-top: 6px;
}

.col-chapter {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel-bg);
  border-right: 1px solid var(--ui-border);
  position: relative;
}

.col-header {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-bottom: 1px solid var(--ui-border);
}

.col-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
}

.col-count {
  font-size: 12px;
  color: var(--ink-sec);
}

.filter-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.filter-chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--tag-border);
  background: var(--tag-bg);
  color: var(--ink-sec);
  cursor: pointer;
}

.filter-chip.active {
  color: var(--ink-accent);
  border-color: color-mix(in srgb, var(--ink-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
}

.chapter-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.chapter-item {
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: transparent;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--ink-main);
  border-bottom: 1px solid var(--ui-border);
  cursor: pointer;
  transition: background 0.2s ease;
}

.chap-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chapter-item:hover,
.chapter-item.active {
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
}

.chapter-item.is-failed {
  background: color-mix(in srgb, var(--state-danger) 5%, transparent);
}

.chap-failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chap-error {
  flex: 1;
  font-size: 11px;
  color: var(--el-color-danger, var(--state-danger));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chap-retry {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 6px;
  border: 1px solid var(--el-color-danger, var(--state-danger));
  background: transparent;
  color: var(--el-color-danger, var(--state-danger));
  cursor: pointer;
}

.chap-retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chap-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chap-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--ink-sec);
}

.chap-status.done {
  color: var(--ink-positive);
}

.chap-status.processing {
  color: var(--ink-warning);
}

.chap-status.failed {
  color: var(--state-danger);
}

.chapter-menu {
  position: fixed;
  z-index: 10;
  min-width: 140px;
  padding: 6px;
  border-radius: 10px;
  background: var(--card-bg, var(--ui-glass-bg));
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chapter-menu .menu-item {
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--ink-main);
  cursor: pointer;
}

.chapter-menu .menu-item:hover {
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
}

.chapter-menu .menu-item.danger {
  color: var(--state-danger);
}

.batch-bar {
  padding: 16px;
  border-top: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--panel-bg);
}

.batch-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink-sec);
}

.cost {
  font-weight: 600;
  color: var(--ink-main);
}

.col-reader {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--panel-bg);
}

.reader-header {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--ui-border);
}

.reader-title {
  font-size: 16px;
  font-weight: 600;
}

.reader-sub {
  font-size: 12px;
  color: var(--ink-sec);
}

.reader-content {
  flex: 1;
  min-height: 0;
  padding: 26px 40px;
  overflow-y: auto;
  font-size: 15px;
  line-height: 1.8;
  color: var(--ink-main);
}

.reader-paragraph {
  margin-bottom: 16px;
  text-indent: 2em;
}

.reader-paragraph.highlight {
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  border-bottom: 2px solid color-mix(in srgb, var(--ink-accent) 30%, transparent);
  cursor: pointer;
}

.reader-paragraph.active {
  background: color-mix(in srgb, var(--ink-accent) 22%, transparent);
  border-bottom-color: var(--ink-accent);
}

.col-insight {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--panel-bg);
  border-left: 1px solid var(--ui-border);
}

.insight-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--ui-border);
  background: linear-gradient(120deg, color-mix(in srgb, var(--ink-accent) 12%, transparent), color-mix(in srgb, var(--ink-accent) 2%, transparent));
}

.insight-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-main);
}

.insight-title i {
  color: var(--ink-accent);
}

.insight-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-sec);
}

.insight-body {
  flex: 1;
  padding: 16px 18px;
  overflow-y: auto;
}

.pane-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}

.summary-block {
  margin-bottom: 14px;
}

.summary-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--ink-main);
}

.summary-text {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--panel-bg);
  border: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ink-sec);
  line-height: 1.6;
}

.dim-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.dim-item {
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--panel-bg);
  border: 1px solid var(--ui-border);
}

.dim-key {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-main);
  margin-bottom: 4px;
}

.dim-key em {
  margin-left: 6px;
  font-style: normal;
  font-weight: 400;
  font-size: 11px;
  color: var(--ink-sec);
}

.dim-desc {
  font-size: 12px;
  color: var(--ink-sec);
  line-height: 1.6;
}

.insight-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.insight-card {
  padding: 14px;
  text-align: left;
  border-radius: 12px;
  border: 1px solid var(--ui-border);
  background: var(--card-bg);
  // 原生 button 默认字色是黑色，标题行没单独指定颜色时会在深色主题下看不见
  color: var(--ink-main);
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.insight-card.active {
  border-color: color-mix(in srgb, var(--ink-accent) 40%, transparent);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--ink-accent) 16%, transparent);
}

.card-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-main);
  margin-bottom: 6px;
}

.card-range {
  font-size: 11px;
  color: var(--ink-sec);
}

.card-text {
  font-size: 12px;
  color: var(--ink-sec);
  line-height: 1.6;
}

.tag-row {
  margin-top: 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);
  color: var(--tag-color, var(--ink-sec));
}

.tag.hot {
  background: var(--state-danger-surface);
  color: var(--state-danger);
}

.tag.key {
  background: color-mix(in srgb, var(--ink-accent) 16%, transparent);
  color: var(--ink-accent);
}

@include content-max(1200px, 1200px) {
  .split-view {
    grid-template-columns: 220px minmax(0, 1fr);
    grid-template-rows: auto auto;
  }

  .col-insight {
    grid-column: 1 / -1;
    grid-row: 2;
    border-left: none;
    border-top: 1px solid var(--ui-border);
  }
}

@include content-max(900px, 900px) {
  .workbench-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .split-view {
    grid-template-columns: 1fr;
  }

  .col-chapter {
    border-right: none;
    border-bottom: 1px solid var(--ui-border);
  }

  .reader-content {
    padding: 20px 24px;
  }
}

/* 黄金三章深拆 */
.golden-title i {
  margin-right: 6px;
  color: var(--ink-warning);
}

.golden-list .anchor-item .dim-desc {
  font-style: italic;
}

/* 全书汇总报告抽屉 */
.report-body {
  padding: 0 4px 24px;

  .pane-title {
    margin: 18px 0 10px;
    font-size: 15px;
    font-weight: 700;
    color: var(--ink-main);
  }

  .dim-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .dim-item {
    display: grid;
    gap: 4px;
    padding: 8px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--card-bg);
  }

  .dim-key {
    font-weight: 600;
    color: var(--ink-main);
    font-size: 13px;

    em {
      margin-left: 6px;
      font-style: normal;
      color: var(--ink-sec);
      font-weight: 400;
    }

    .pending-mark {
      color: var(--state-danger);
    }
  }

  .dim-desc {
    color: var(--ink-sec);
    font-size: 13px;
    line-height: 1.7;
  }
}

.report-notes {
  margin: 0;
  padding: 12px 14px;
  border-left: 3px solid var(--ink-accent);
  border-radius: 0 8px 8px 0;
  background: var(--card-bg);
  color: var(--ink-sec);
  line-height: 1.8;
  font-size: 13px;
}

.pacing-curve {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 96px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--card-bg);
  overflow-x: auto;
}

.pacing-bar {
  position: relative;
  flex: 1 0 6px;
  max-width: 14px;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.pacing-fill {
  width: 100%;
  border-radius: 2px 2px 0 0;
  background: var(--ink-accent);
  opacity: 0.75;
}

.report-techniques {
  margin: 0;
  padding-left: 20px;
  color: var(--ink-sec);
  font-size: 13px;
  line-height: 2;
}
</style>
