<template>
  <div class="statistics-page">
    <p class="count-mode-note">统计口径：{{ wordCounter.label.value }}<span v-if="hasMissingCounts"> · 部分旧记录无法补算，缺失值显示「—」</span></p>
    <section class="statistics-grid">
      <article class="fusion-card today-overview">
        <div class="card-title">今日概览</div>
        <div class="overview-main">
          <div class="date-mark">{{ currentDate }}</div>
          <div class="total-words">
            <span>今日总字数</span>
            <strong>{{ fmt(todayWords) }}</strong>
            <em>字</em>
          </div>
        </div>

        <div class="source-split">
          <div class="source-card source-card--manual">
            <div class="source-label">
              古法码字
            </div>
            <div class="source-value">{{ fmt(manualWords) }}<span>字</span></div>
            <div class="source-ratio">{{ sourceRatio(manualWords) }}</div>
          </div>
          <div class="source-card source-card--ai">
            <div class="source-label">
              AI码字
            </div>
            <div class="source-value">{{ fmt(aiWords) }}<span>字</span></div>
            <div class="source-ratio">{{ sourceRatio(aiWords) }}</div>
          </div>
        </div>
        <p class="overview-note">
          <i class="fa-solid fa-asterisk"></i>
          占比基于今日总字数统计
        </p>
      </article>

      <article class="fusion-card trend-card">
        <div class="trend-head">
          <el-radio-group v-model="trendPeriod" size="small" class="ink-radio-group">
            <el-radio-button label="7">7天</el-radio-button>
            <el-radio-button label="15">15天</el-radio-button>
            <el-radio-button label="30">30天</el-radio-button>
          </el-radio-group>
          <div class="trend-summary">
            <span>{{ trendLabel }}古法 <strong>{{ fmt(trendManualTotal) }}</strong> 字</span>
            <span>{{ trendLabel }}AI码字 <strong>{{ fmt(trendAiTotal) }}</strong> 字</span>
            <span>{{ trendLabel }}累计 <strong>{{ fmt(trendTotalWords) }}</strong> 字</span>
          </div>
        </div>
        <div class="legend-row" aria-hidden="true">
          <span class="legend-item legend-item--manual">古法码字</span>
          <span class="legend-item legend-item--ai">AI码字</span>
        </div>
        <div class="chart-area">
          <div ref="trendChartRef" class="trend-echarts"></div>
          <div v-if="trendLoading" class="chart-state">
            <i class="fa-solid fa-spinner fa-spin"></i>
            加载中...
          </div>
          <div v-else-if="!trendList.length" class="chart-state">暂无趋势数据</div>
        </div>
      </article>

      <article class="fusion-card calendar-card">
        <div class="calendar-head">
          <div class="calendar-title">
            <i class="fa-regular fa-calendar"></i>
            码字日历
          </div>
          <div class="month-switch">
            <button type="button" class="icon-btn" @click="prevMonth" aria-label="上个月">
              <i class="fa-solid fa-chevron-left"></i>
            </button>
            <strong>{{ monthLabel }}</strong>
            <button type="button" class="icon-btn" :disabled="!canNextMonth" @click="nextMonth" aria-label="下个月">
              <i class="fa-solid fa-chevron-right"></i>
            </button>
          </div>
          <div class="book-filter">
            <span>书籍</span>
            <el-select v-model="selectedBook" size="small" class="ink-select" popper-class="ink-select-popper">
              <el-option v-for="opt in bookOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
          </div>
        </div>

        <div class="month-stats">
          <div class="month-stat month-stat--manual">
            <div class="month-stat-heading">
              <i class="fa-solid fa-feather-pointed"></i>
              <span>古法码字</span>
            </div>
            <div class="month-stat-values">
              <div class="month-stat-line">
                <span>本月累计</span>
                <strong>{{ fmt(calendarManualTotal) }}</strong>
                <em>字</em>
              </div>
              <div class="month-stat-line">
                <span>日均</span>
                <strong>{{ fmt(calendarManualAvg) }}</strong>
                <em>字</em>
              </div>
            </div>
          </div>
          <div class="month-stat month-stat--ai">
            <div class="month-stat-heading">
              <i class="fa-solid fa-robot"></i>
              <span>AI码字</span>
            </div>
            <div class="month-stat-values">
              <div class="month-stat-line">
                <span>本月累计</span>
                <strong>{{ fmt(calendarAiTotal) }}</strong>
                <em>字</em>
              </div>
              <div class="month-stat-line">
                <span>日均</span>
                <strong>{{ fmt(calendarAiAvg) }}</strong>
                <em>字</em>
              </div>
            </div>
          </div>
          <div class="month-stat month-stat--total">
            <div class="month-stat-heading">
              <span>合计</span>
            </div>
            <div class="month-stat-values">
              <div class="month-stat-line">
                <span>本月累计</span>
                <strong>{{ fmt(calendarTotalWords) }}</strong>
                <em>字</em>
              </div>
              <div class="month-stat-line">
                <span>日均</span>
                <strong>{{ fmt(calendarAvgWords) }}</strong>
                <em>字</em>
              </div>
            </div>
          </div>
        </div>

        <div class="calendar-grid">
          <div v-for="week in weekDays" :key="week" class="week-label">{{ week }}</div>
          <div
            v-for="cell in calendarCells"
            :key="cell.key"
            class="day-cell"
            :class="{ 'is-empty': cell.empty, 'is-today': cell.isToday, 'has-data': cell.hasData }"
            :title="cell.title"
          >
            <template v-if="!cell.empty">
              <span class="day-num">{{ cell.day }}</span>
              <span v-if="cell.manualWords === null || cell.manualWords" class="day-source day-source--manual">
                <i class="fa-solid fa-feather-pointed"></i>
                {{ fmt(cell.manualWords) }}
              </span>
              <span v-if="cell.aiWords === null || cell.aiWords" class="day-source day-source--ai">
                <i class="fa-solid fa-robot"></i>
                {{ fmt(cell.aiWords) }}
              </span>
            </template>
          </div>
        </div>
        <div v-if="calendarLoading" class="calendar-loading">
          <i class="fa-solid fa-spinner fa-spin"></i>
          加载日历...
        </div>
      </article>

      <article class="fusion-card progress-card">
        <div class="progress-block progress-block--manual">
          <div class="progress-title">
            <i class="fa-solid fa-feather-pointed"></i>
            古法码字进度
          </div>
          <div class="progress-content">
            <div class="ring" :style="ringStyle(manualProgress, 'manual')">
              <span>{{ manualWords === null ? '—' : `${manualProgress}%` }}</span>
            </div>
            <div class="progress-info">
              <div><span>今日进度</span><strong>{{ manualWords === null ? '—' : `${manualProgress}%` }}</strong></div>
              <div><span>目标</span><strong>{{ fmt(manualTargetWords) }} 字</strong></div>
              <div><span>已完成</span><strong>{{ fmt(manualWords) }} 字</strong></div>
            </div>
          </div>
          <div class="line-progress">
            <span :style="{ width: `${manualProgress}%` }"></span>
          </div>
          <p>本月累计 {{ fmt(calendarManualTotal) }} 字 / 月目标 {{ fmt(manualMonthTarget) }} 字</p>
        </div>

        <div class="progress-block progress-block--ai">
          <div class="progress-title">
            <i class="fa-solid fa-robot"></i>
            AI码字进度
          </div>
          <div class="progress-content">
            <div class="ring" :style="ringStyle(aiProgress, 'ai')">
              <span>{{ aiWords === null ? '—' : `${aiProgress}%` }}</span>
            </div>
            <div class="progress-info">
              <div><span>今日进度</span><strong>{{ aiWords === null ? '—' : `${aiProgress}%` }}</strong></div>
              <div><span>目标</span><strong>{{ fmt(aiTargetWords) }} 字</strong></div>
              <div><span>已完成</span><strong>{{ fmt(aiWords) }} 字</strong></div>
            </div>
          </div>
          <div class="line-progress">
            <span :style="{ width: `${aiProgress}%` }"></span>
          </div>
          <p>本月累计 {{ fmt(calendarAiTotal) }} 字 / 月目标 {{ fmt(aiMonthTarget) }} 字</p>
        </div>

        <div class="total-summary">
          <div><span>每日目标</span><strong>{{ fmt(targetWords) }} 字</strong></div>
          <div><span>今日总字数</span><strong>{{ fmt(todayWords) }} 字</strong></div>
          <div><span>本月累计</span><strong>{{ fmt(calendarTotalWords) }} 字</strong></div>
        </div>

        <button class="ink-btn ink-btn-primary plan-button" type="button" @click="openSettings">
          {{ targetWords > 0 ? '修改计划' : '设置计划' }}
        </button>
      </article>
    </section>

    <EwModal
      v-model:visible="settingsVisible"
      title="设置每日码字计划"
      width="380px"
      custom-class="plan-settings-modal"
    >
      <div class="settings-body">
        <label class="settings-field">
          <span>古法码字目标</span>
          <el-input-number
            v-model="manualTargetInput"
            :min="0"
            :step="100"
            :max="50000"
            controls-position="right"
            style="width: 100%;"
          />
        </label>
        <label class="settings-field">
          <span>AI码字目标</span>
          <el-input-number
            v-model="aiTargetInput"
            :min="0"
            :step="100"
            :max="50000"
            controls-position="right"
            style="width: 100%;"
          />
        </label>
        <p class="settings-tip">每日目标会分别用于古法码字和AI码字进度。</p>
      </div>
      <template #footer>
        <button type="button" class="ink-btn ink-btn-outline" @click="settingsVisible = false" :disabled="saving">
          取消
        </button>
        <button type="button" class="ink-btn ink-btn-primary" @click="handleSaveTarget" :disabled="saving">
          <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
          保存
        </button>
      </template>
    </EwModal>
  </div>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { echarts, type EChartsInstance, type EChartsOption } from '@/utils/echarts'
import type { JsonRecord } from '@/types/json'
import EwModal from '@/components/EwModal/index.vue'
import { getLocalLibraryStorage } from '@/storage/local-library'
import {
  getStatsCalendar,
  getStatsOverview,
  getStatsTrend,
  setStatsTargets,
  type LocalStatsCalendar,
  type LocalStatsDayItem,
  type LocalStatsOverview,
  type LocalStatsTrend
} from '@/storage/local-write-stats'

const wordCounter = useWordCount()

const localLibrary = getLocalLibraryStorage()

// 图表主色随主题走（暗夜模式下原硬编码 #9a4a10 对比度差）；调用时读取，随主题重绘生效
const manualColor = () => readCssVar('--ink-accent') || '#7A3028'
const aiColor = () => readCssVar('--chart-ai') || '#A66A2E'
const weekDays = ['一', '二', '三', '四', '五', '六', '日']

const trendPeriod = ref('7')
const selectedBook = ref('all')
const bookOptions = ref<Array<{ label: string; value: string }>>([{ label: '全部作品', value: 'all' }])
const settingsVisible = ref(false)
const manualTargetInput = ref(0)
const aiTargetInput = ref(0)
const saving = ref(false)
const overviewLoading = ref(false)
const trendLoading = ref(false)
const calendarLoading = ref(false)
const overview = ref<LocalStatsOverview | null>(null)
const trendData = ref<LocalStatsTrend | null>(null)
const calendarData = ref<LocalStatsCalendar | null>(null)
const currentMonth = ref(dayjs().startOf('month'))
const trendChartRef = ref<HTMLDivElement | null>(null)
let trendChart: EChartsInstance | null = null
let trendResizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

const toNumber = (value: unknown) => {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num : 0
}

const fmt = (value: unknown) => value == null ? '—' : Math.round(toNumber(value)).toLocaleString()

const activeBookId = computed(() => {
  return selectedBook.value === 'all' ? undefined : selectedBook.value
})

const currentDate = computed(() => dayjs().format('MM/DD'))
const todayDate = computed(() => dayjs().format('YYYY-MM-DD'))
const monthLabel = computed(() => currentMonth.value.format('YYYY年M月'))
const monthParam = computed(() => currentMonth.value.format('YYYY-MM'))
const canNextMonth = computed(() => currentMonth.value.isBefore(dayjs().startOf('month'), 'month'))

const targetWords = computed(() => toNumber(overview.value?.targetWords))
const manualTargetWords = computed(() => toNumber(overview.value?.manualTargetWords))
const aiTargetWords = computed(() => toNumber(overview.value?.aiTargetWords))
const todayWords = computed(() => overview.value?.todayWords ?? null)
const manualWords = computed(() => overview.value?.manualWords ?? null)
const aiWords = computed(() => overview.value?.aiWords ?? null)

const sourceRatio = (value: number | null) => {
  if (value === null || todayWords.value === null) return '—'
  if (!todayWords.value) return '0%'
  return `${Math.round((value / todayWords.value) * 1000) / 10}%`
}

const percent = (value: number | null, target: number) => {
  if (value === null || !target) return 0
  return Math.min(100, Math.round((value / target) * 100))
}

const manualProgress = computed(() => percent(manualWords.value, manualTargetWords.value))
const aiProgress = computed(() => percent(aiWords.value, aiTargetWords.value))

const trendList = computed(() => (trendData.value?.list || []) as LocalStatsDayItem[])
const trendDays = computed(() => Math.min(Math.max(Number(trendPeriod.value) || 7, 1), 30))
const trendLabel = computed(() => `${trendDays.value}日`)
const trendManualTotal = computed(() => trendData.value?.totalManualWords ?? null)
const trendAiTotal = computed(() => trendData.value?.totalAiWords ?? null)
const trendTotalWords = computed(() => trendData.value?.totalWords ?? null)

const calendarList = computed(() => (calendarData.value?.list || []) as LocalStatsDayItem[])
const calendarTotalWords = computed(() => calendarData.value?.monthTotalWords ?? null)
const calendarManualTotal = computed(() => calendarData.value?.monthManualWords ?? null)
const calendarAiTotal = computed(() => calendarData.value?.monthAiWords ?? null)
const calendarAvgWords = computed(() => calendarData.value?.monthAvgWords ?? null)
const calendarManualAvg = computed(() => calendarData.value?.monthManualAvgWords ?? null)
const calendarAiAvg = computed(() => calendarData.value?.monthAiAvgWords ?? null)
const manualMonthTarget = computed(() => manualTargetWords.value * currentMonth.value.daysInMonth())
const aiMonthTarget = computed(() => aiTargetWords.value * currentMonth.value.daysInMonth())

const calendarMap = computed(() => {
  const map = new Map<string, LocalStatsDayItem>()
  for (const item of calendarList.value) map.set(item.date, item)
  return map
})

const calendarCells = computed(() => {
  const start = currentMonth.value.startOf('month')
  const firstDow = (start.day() + 6) % 7
  const days = start.daysInMonth()
  const cells: Array<{
    key: string
    empty: boolean
    day?: number
    manualWords?: number | null
    aiWords?: number | null
    hasData?: boolean
    isToday?: boolean
    title?: string
  }> = []
  for (let index = 0; index < firstDow; index += 1) {
    cells.push({ key: `empty-${index}`, empty: true })
  }
  for (let day = 1; day <= days; day += 1) {
    const date = start.date(day).format('YYYY-MM-DD')
    const record = calendarMap.value.get(date)
    const manual = record ? record.manualWords : 0
    const ai = record ? record.aiWords : 0
    const total = manual === null || ai === null ? null : manual + ai
    cells.push({
      key: date,
      empty: false,
      day,
      manualWords: manual,
      aiWords: ai,
      hasData: total === null || total > 0,
      isToday: date === todayDate.value,
      title: `${date}\n古法码字：${fmt(manual)} 字\nAI码字：${fmt(ai)} 字\n合计：${fmt(total)} 字`
    })
  }
  return cells
})

const readCssVar = (name: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name)
  return String(value || '').trim()
}

const buildTrendOption = () => {
  const main = readCssVar('--ink-main') || '#241F1B'
  const sec = readCssVar('--ink-sec') || '#655E56'
  const split = readCssVar('--ui-border') || 'rgba(0,0,0,0.08)'
  const panel = readCssVar('--ui-glass-bg') || 'rgba(255,255,255,0.95)'
  const xAxis = trendList.value.map(item => dayjs(item.date).format('MM/DD'))
  const manualSeries = trendList.value.map(item => item.manualWords)
  const aiSeries = trendList.value.map(item => item.aiWords)
  return {
    backgroundColor: 'transparent',
    grid: { left: 54, right: 24, top: 24, bottom: 34 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: panel,
      borderColor: split,
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: main, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: split } },
      formatter: (params: JsonRecord | JsonRecord[]) => {
        const rows: JsonRecord[] = Array.isArray(params) ? params : [params]
        const index = Number(rows[0]?.dataIndex || 0)
        const raw = trendList.value[index]
        return [
          `<div style="font-weight:700;margin-bottom:6px;color:${main}">${raw?.date || rows[0]?.axisValue || ''}</div>`,
          ...rows.map(row => {
            const color = row.seriesName === 'AI码字' ? aiColor() : manualColor()
            return `<div style="display:flex;align-items:center;gap:8px;min-width:150px;">
              <span style="width:8px;height:8px;border-radius:999px;background:${color};display:inline-block;"></span>
              <span style="color:${sec};">${row.seriesName}</span>
              <strong style="margin-left:auto;color:${main};">${fmt(row.data)} 字</strong>
            </div>`
          })
        ].join('')
      }
    },
    xAxis: {
      type: 'category',
      data: xAxis,
      boundaryGap: false,
      axisLabel: { color: sec, fontSize: 11 },
      axisLine: { lineStyle: { color: split } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: sec, fontSize: 11 },
      splitLine: { lineStyle: { color: split, type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        name: '古法码字',
        type: 'line',
        data: manualSeries,
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: manualColor(), width: 3 },
        itemStyle: { color: manualColor() },
        areaStyle: { color: manualColor(), opacity: 0.16 },
        emphasis: { focus: 'series' }
      },
      {
        name: 'AI码字',
        type: 'line',
        data: aiSeries,
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: aiColor(), width: 3 },
        itemStyle: { color: aiColor() },
        areaStyle: { color: aiColor(), opacity: 0.16 },
        emphasis: { focus: 'series' }
      }
    ],
    animationDuration: 420
  } as EChartsOption
}

const renderTrendChart = async () => {
  await nextTick()
  if (!trendChartRef.value) return
  if (!trendChart) trendChart = echarts.init(trendChartRef.value, undefined, { renderer: 'canvas' })
  trendChart.setOption(buildTrendOption(), true)
}

const fetchOverview = async () => {
  overviewLoading.value = true
  try {
    overview.value = getStatsOverview(todayDate.value, activeBookId.value)
  } finally {
    overviewLoading.value = false
  }
}

const fetchTrend = async () => {
  trendLoading.value = true
  try {
    trendData.value = getStatsTrend(trendDays.value, todayDate.value, activeBookId.value)
    await renderTrendChart()
  } finally {
    trendLoading.value = false
  }
}

const fetchCalendar = async () => {
  calendarLoading.value = true
  try {
    calendarData.value = getStatsCalendar(monthParam.value, activeBookId.value)
  } finally {
    calendarLoading.value = false
  }
}

const loadBooks = async () => {
  try {
    const list = await localLibrary.listLocalBooks()
    bookOptions.value = [
      { label: '全部作品', value: 'all' },
      ...list.filter(Boolean).map(book => ({ label: String(book.title || '未命名'), value: String(book.id) }))
    ]
  } catch (error) {
    console.error('load books failed', error)
  }
}

const refreshAll = async () => {
  await Promise.all([fetchOverview(), fetchTrend(), fetchCalendar()])
}

const hasMissingCounts = computed(() => wordCounter.mode.value === 'text' &&
  (todayWords.value === null || trendList.value.some(item => item.words === null) || calendarList.value.some(item => item.words === null)))
watch(wordCounter.mode, refreshAll)

const prevMonth = () => {
  currentMonth.value = currentMonth.value.subtract(1, 'month').startOf('month')
}

const nextMonth = () => {
  if (!canNextMonth.value) return
  currentMonth.value = currentMonth.value.add(1, 'month').startOf('month')
}

const ringStyle = (value: number, type: 'manual' | 'ai') => {
  const color = type === 'manual' ? manualColor() : aiColor()
  return {
    '--percent': `${Math.max(0, Math.min(100, value))}%`,
    '--ring-color': color
  } as Record<string, string>
}

const openSettings = () => {
  manualTargetInput.value = Math.max(0, Math.round(manualTargetWords.value))
  aiTargetInput.value = Math.max(0, Math.round(aiTargetWords.value))
  settingsVisible.value = true
}

const handleSaveTarget = async () => {
  const manual = Math.max(0, Math.round(manualTargetInput.value || 0))
  const ai = Math.max(0, Math.round(aiTargetInput.value || 0))
  saving.value = true
  try {
    setStatsTargets({ manual, ai })
    ElMessage.success('已保存')
    settingsVisible.value = false
    await refreshAll()
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadBooks()
  refreshAll()
  trendResizeObserver = new ResizeObserver(() => trendChart?.resize())
  if (trendChartRef.value) trendResizeObserver.observe(trendChartRef.value)
  themeObserver = new MutationObserver(() => renderTrendChart())
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
})

watch([trendPeriod], () => {
  fetchTrend()
})

watch([selectedBook], () => {
  refreshAll()
})

watch([currentMonth], () => {
  fetchCalendar()
})

onBeforeUnmount(() => {
  trendResizeObserver?.disconnect()
  themeObserver?.disconnect()
  trendChart?.dispose()
  trendResizeObserver = null
  themeObserver = null
  trendChart = null
})
</script>

<style scoped lang="scss">
.count-mode-note { color: var(--ink-sec); font-size: 13px; margin: 0 0 16px; }
.statistics-page {
  padding: 4px 14px 36px;
  min-height: calc(100vh - var(--desktop-titlebar-height, 0px) - 56px);
}

.statistics-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-template-rows: minmax(278px, auto) minmax(430px, auto);
  gap: 18px;
  width: 100%;
  min-width: 0;
}

.today-overview,
.trend-card,
.calendar-card,
.progress-card {
  padding: 24px;
  border-radius: 14px;
  min-width: 0;
  box-sizing: border-box;
}

.card-title,
.calendar-title,
.progress-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--ink-main);
}

.today-overview {
  grid-column: span 4;
  display: flex;
  flex-direction: column;
}

.overview-main {
  position: relative;
  min-height: 118px;
  padding-top: 8px;
}

.date-mark {
  position: absolute;
  top: 10px;
  left: 0;
  font-size: 34px;
  font-weight: 800;
  color: var(--ink-main);
  font-family: 'Segoe UI', system-ui, sans-serif;
}

.total-words {
  position: absolute;
  top: 42px;
  left: 50%;
  min-width: 190px;
  transform: translateX(-50%);
  text-align: center;

  span {
    display: block;
    font-size: 12px;
    color: var(--ink-sec);
    margin-bottom: 8px;
  }

  strong {
    font-size: 38px;
    line-height: 1;
    color: var(--ink-main);
  }

  em {
    margin-left: 6px;
    font-style: normal;
    font-size: 14px;
    color: var(--ink-sec);
  }
}

.source-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 2px;
}

.source-card {
  position: relative;
  min-width: 0;
  min-height: 104px;
  padding: 18px 18px 16px;
  border-radius: 10px;
  border: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-glass-bg) 82%, transparent);
  overflow: hidden;
  isolation: isolate;

  &::after {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 0;
    font-family: 'Font Awesome 6 Free';
    font-weight: 900;
    font-size: 42px;
    opacity: 0.48;
  }

  &--manual {
    border-color: rgba(154, 74, 16, 0.25);

    .source-label,
    .source-ratio {
      color: var(--ink-accent);
    }

    &::after {
      content: '\f56b';
      color: var(--ink-accent);
    }
  }

  &--ai {
    border-color: color-mix(in srgb, var(--chart-ai) 32%, transparent);

    .source-label,
    .source-ratio {
      color: var(--state-info);
    }

    &::after {
      content: '\f544';
      color: var(--state-info);
    }
  }
}

.source-label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  font-size: 15px;
  font-weight: 800;
  margin-bottom: 18px;
}

.source-value {
  position: relative;
  z-index: 1;
  font-size: 28px;
  font-weight: 800;
  color: var(--ink-main);
  white-space: nowrap;

  span {
    margin-left: 5px;
    font-size: 12px;
    color: var(--ink-sec);
    font-weight: 500;
  }
}

.source-ratio {
  position: relative;
  z-index: 1;
  margin-top: 6px;
  font-size: 13px;
  font-weight: 800;
}

.overview-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: auto 0 0;
  padding-top: 12px;
  font-size: 12px;
  color: var(--ink-sec);

  i {
    font-size: 7px;
    color: color-mix(in srgb, var(--ink-sec) 76%, transparent);
  }
}

.trend-card {
  grid-column: span 8;
  display: flex;
  flex-direction: column;
}

.trend-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.trend-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px 18px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-sec);

  strong {
    color: var(--ink-main);
    font-weight: 800;
  }
}

.legend-row {
  display: flex;
  gap: 28px;
  margin: 22px 0 4px;
  font-size: 12px;
  color: var(--ink-main);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  &::before {
    content: '';
    width: 22px;
    height: 3px;
    border-radius: 999px;
  }

  &--manual::before {
    background: var(--ink-accent);
  }

  &--ai::before {
    background: var(--state-info);
  }
}

.chart-area {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 210px;
}

.trend-echarts {
  position: absolute;
  inset: 0;
}

.chart-state,
.calendar-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-sec);
  background: color-mix(in srgb, var(--ui-glass-bg) 62%, transparent);
}

.calendar-card {
  grid-column: span 9;
  position: relative;
}

.calendar-head {
  display: grid;
  grid-template-columns: max-content minmax(120px, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 18px;
  min-width: 0;
}

.calendar-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  i {
    color: var(--ink-accent);
  }
}

.month-switch {
  display: flex;
  align-items: center;
  gap: 10px;

  strong {
    min-width: 92px;
    text-align: center;
    color: var(--ink-main);
  }
}

.icon-btn {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-main);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--ui-glass-bg-hover);
    color: var(--ink-accent);
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.book-filter {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-sec);
}

.month-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(236px, 1fr));
  gap: 12px;
  margin: 20px 0 18px;
}

.month-stat {
  display: grid;
  grid-template-columns: max-content minmax(112px, 1fr);
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 72px;
  padding: 12px 16px;
  border-radius: 10px;
  border: 1px solid rgba(120, 113, 108, 0.12);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(255, 252, 248, 0.74)),
    color-mix(in srgb, var(--ui-glass-bg) 86%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72), 0 8px 18px rgba(120, 113, 108, 0.05);
}

.month-stat-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  font-weight: 800;

  i {
    flex: 0 0 auto;
    font-size: 22px;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.month-stat-values {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.month-stat-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;

  span,
  em {
    font-size: 12px;
    font-style: normal;
    color: var(--ink-sec);
  }

  span {
    flex: 0 0 52px;
  }

  strong {
    flex: 1 0 auto;
    min-width: max-content;
    font-size: 14px;
    font-weight: 800;
    line-height: 1.1;
    color: var(--ink-main);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  em {
    flex: 0 0 auto;
  }
}

.month-stat--manual {
  color: var(--ink-accent);
  border-color: rgba(154, 74, 16, 0.16);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 249, 243, 0.76)),
    rgba(154, 74, 16, 0.035);
}

.month-stat--ai {
  color: var(--state-info);
  border-color: color-mix(in srgb, var(--chart-ai) 24%, transparent);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(246, 250, 255, 0.78)),
    color-mix(in srgb, var(--chart-ai) 5%, transparent);
}

.month-stat--total {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(250, 248, 245, 0.74)),
    color-mix(in srgb, var(--ui-glass-bg) 88%, transparent);

  .month-stat-heading {
    color: var(--ink-main);
  }
}

/* 暗夜主题：三张月度统计卡原为写死的白色渐变底，暗夜下与浅色文字融为一体——
   改深色渐变底并提亮各自的品类色 */
:global(.theme-dark .month-stat) {
  border-color: rgba(255, 255, 255, 0.1);
  background:
    linear-gradient(180deg, rgba(46, 42, 38, 0.94), rgba(38, 35, 32, 0.88)),
    color-mix(in srgb, var(--ui-glass-bg) 86%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 18px rgba(0, 0, 0, 0.28);
}

:global(.theme-dark .month-stat--manual) {
  color: #e8a06a;
  border-color: rgba(232, 160, 106, 0.28);
  background:
    linear-gradient(180deg, rgba(54, 43, 34, 0.94), rgba(42, 35, 29, 0.88)),
    rgba(154, 74, 16, 0.14);
}

:global(.theme-dark .month-stat--ai) {
  color: #7eb3f5;
  border-color: rgba(126, 179, 245, 0.28);
  background:
    linear-gradient(180deg, rgba(34, 42, 58, 0.94), rgba(28, 34, 46, 0.88)),
    color-mix(in srgb, var(--chart-ai) 16%, transparent);
}

:global(.theme-dark .month-stat--total) {
  background:
    linear-gradient(180deg, rgba(46, 43, 40, 0.94), rgba(37, 35, 32, 0.88)),
    color-mix(in srgb, var(--ui-glass-bg) 88%, transparent);
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}

.week-label,
.day-cell {
  min-width: 0;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
}

.week-label {
  padding: 9px 0;
  text-align: center;
  font-size: 12px;
  color: var(--ink-sec);
}

.day-cell {
  min-height: 68px;
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: color-mix(in srgb, var(--ui-glass-bg) 52%, transparent);

  &.is-empty {
    background: transparent;
    opacity: 0.32;
  }

  &.has-data {
    background: color-mix(in srgb, var(--ui-glass-bg) 76%, transparent);
  }

  &.is-today {
    outline: 1px solid var(--ink-accent);
    outline-offset: -2px;
    background: rgba(154, 74, 16, 0.05);
  }
}

.day-num {
  font-size: 13px;
  font-weight: 800;
  color: var(--ink-main);
  line-height: 1;
}

.day-source {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;

  i {
    width: 12px;
    font-size: 10px;
  }

  &--manual {
    color: var(--ink-accent);
  }

  &--ai {
    color: var(--state-info);
  }
}

.progress-card {
  grid-column: span 3;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.progress-block {
  padding-bottom: 16px;
  border-bottom: 1px dashed var(--ui-border);

  &--manual {
    --progress-color: var(--ink-accent);
  }

  &--ai {
    --progress-color: var(--state-info);
  }

  p {
    margin: 8px 0 0;
    font-size: 12px;
    text-align: right;
    color: var(--ink-sec);
  }
}

.progress-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--progress-color);
}

.progress-content {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  margin-top: 12px;
}

.ring {
  width: 76px;
  height: 76px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at center, var(--card-bg) 0 54%, transparent 55%),
    conic-gradient(var(--ring-color) var(--percent), color-mix(in srgb, var(--ring-color) 18%, var(--ui-border)) 0);

  span {
    font-size: 20px;
    font-weight: 800;
    color: var(--ink-main);
  }
}

.progress-info {
  display: grid;
  gap: 10px;
  min-width: 0;

  div {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 8px;
    align-items: baseline;
  }

  span {
    font-size: 12px;
    color: var(--ink-sec);
  }

  strong {
    min-width: 0;
    justify-self: end;
    color: var(--ink-main);
    text-align: right;
    white-space: nowrap;
  }
}

.line-progress {
  height: 6px;
  margin-top: 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--progress-color) 16%, var(--ui-border));
  overflow: hidden;

  span {
    display: block;
    height: 100%;
    max-width: 100%;
    border-radius: inherit;
    background: var(--progress-color);
  }
}

.total-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0;
  padding: 14px 0;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-glass-bg) 80%, transparent);
  border: 1px solid var(--ui-border);

  div {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0 8px;

    & + div {
      border-left: 1px solid var(--ui-border);
    }
  }

  span {
    font-size: 12px;
    color: var(--ink-sec);
  }

  strong {
    font-size: 15px;
    color: var(--ink-main);
    white-space: nowrap;
  }
}

.plan-button {
  width: 100%;
  margin-top: auto;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  span {
    font-size: 13px;
    color: var(--ink-main);
  }
}

.settings-tip {
  margin: 0;
  font-size: 12px;
  color: var(--ink-sec);
}

@media (max-width: 1500px) {
  .statistics-page {
    padding-inline: 12px;
  }

  .statistics-grid {
    grid-template-rows: minmax(270px, auto) minmax(420px, auto);
    gap: 16px;
  }

  .today-overview,
  .trend-card,
  .calendar-card,
  .progress-card {
    padding: 20px;
  }

  .overview-main {
    min-height: 112px;
  }

  .source-split {
    gap: 14px;
  }

  .source-card {
    min-height: 100px;
    padding: 16px 16px 14px;
  }

  .source-value {
    font-size: 26px;
  }

  .chart-area {
    min-height: 190px;
  }

  .progress-card {
    gap: 16px;
  }
}

@media (max-width: 1280px) {
  .source-split {
    grid-template-columns: 1fr;
  }

  .overview-note {
    margin-top: 10px;
  }

}

@media (max-width: 1180px) {
  .statistics-grid {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
  }

  .today-overview,
  .trend-card,
  .calendar-card,
  .progress-card {
    grid-column: auto;
  }

  .calendar-head {
    grid-template-columns: 1fr;
  }
}
</style>
