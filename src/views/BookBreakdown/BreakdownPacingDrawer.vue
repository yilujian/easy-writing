<template>
  <el-drawer
    :model-value="visible"
    title="节奏与对比"
    size="62%"
    @update:model-value="value => emit('update:visible', value)"
    @opened="load"
    @closed="disposeCharts"
  >
    <div class="pacing-body">
      <p v-if="!desktop" class="pacing-note">节奏数据需要在桌面客户端生成。</p>
      <template v-else>
        <section class="pacing-coverage">
          <div>
            <strong
              >已生成章节卡 {{ summary?.indexedChapters ?? 0 }} / {{ summary?.totalChapters ?? 0 }} 章</strong
            >
            <small
              >章节卡和你自己作品的记忆索引是同一套结构：事件、钩子、爽点、新信息、线索。每章调用一次“Agent
              索引”模型，在后台进行。</small
            >
          </div>
          <button
            class="ink-btn ink-btn-primary ink-btn-sm"
            type="button"
            :disabled="busy || !missing"
            @click="build"
          >
            <i class="fa-solid fa-layer-group"></i>{{ missing ? `生成缺少的 ${missing} 章` : '章节卡已齐' }}
          </button>
        </section>
        <p v-if="notice" class="pacing-note">{{ notice }}</p>
        <p v-if="error" class="pacing-note is-error">{{ error }}</p>

        <template v-if="profile && summary && summary.indexedChapters">
          <div class="pacing-kpis">
            <div>
              <span>每章爽点</span><strong>{{ summary.payoffsPerChapter }}</strong>
            </div>
            <div>
              <span>章末留钩子</span><strong>{{ Math.round(summary.endHookRate * 100) }}%</strong>
            </div>
            <div>
              <span>最长爽点空窗</span><strong>{{ summary.longestPayoffGap.length }} 章</strong>
            </div>
            <div>
              <span>伏笔平均回收</span
              ><strong>{{
                profile.threads.averagePayoffDistance == null
                  ? '—'
                  : `${Math.round(profile.threads.averagePayoffDistance)} 章后`
              }}</strong>
            </div>
          </div>

          <div class="pacing-title">每章爽点强度（1–5）</div>
          <div ref="profileChartRef" class="pacing-chart" role="img" :aria-label="profileChartLabel"></div>

          <div class="pacing-columns">
            <div>
              <div class="pacing-title">章末钩子类型</div>
              <ul class="pacing-bars">
                <li v-for="item in summary.endHookTypes" :key="item.type">
                  <span>{{ item.type }}</span
                  ><i :style="{ width: share(item.count, summary.endHookTypes) }"></i
                  ><em>{{ item.count }}</em>
                </li>
                <li v-if="!summary.endHookTypes.length" class="pacing-muted">没有提取到章末钩子</li>
              </ul>
            </div>
            <div>
              <div class="pacing-title">爽点类型</div>
              <ul class="pacing-bars">
                <li v-for="item in summary.payoffTypes" :key="item.type">
                  <span>{{ item.type }}</span
                  ><i :style="{ width: share(item.count, summary.payoffTypes) }"></i><em>{{ item.count }}</em>
                </li>
                <li v-if="!summary.payoffTypes.length" class="pacing-muted">没有提取到爽点</li>
              </ul>
            </div>
          </div>

          <div class="pacing-title">开篇三章</div>
          <ol class="pacing-opening">
            <li v-for="item in profile.opening" :key="item.no">
              <strong>第 {{ item.no }} 章</strong>
              <span>{{ item.oneLine }}</span>
              <small
                >{{ item.payoffTypes.length ? `爽点：${item.payoffTypes.join('、')}` : '无爽点'
                }}{{ item.endHook ? ` · 章末${item.endHook.type}钩` : ' · 章末无钩子' }}</small
              >
            </li>
          </ol>

          <template v-if="profile.recipes.length">
            <div class="pacing-title">可复用配方</div>
            <div v-for="recipe in profile.recipes" :key="recipe.id" class="pacing-recipe">
              <header>
                <strong>{{ recipe.title }}</strong>
                <button class="pacing-link" type="button" @click="removeRecipe(recipe.id)">删除</button>
              </header>
              <p v-for="(step, index) in recipe.steps" :key="index">
                <b>{{ step.position }}</b
                >{{ step.tasks }}
              </p>
            </div>
          </template>

          <div class="pacing-title">与我的书对比</div>
          <div class="pacing-compare-bar">
            <el-select
              v-model="bookId"
              class="ink-select"
              popper-class="ink-select-popper"
              placeholder="选择你的作品"
              aria-label="选择对比的作品"
              filterable
            >
              <el-option v-for="book in books" :key="book.value" :label="book.label" :value="book.value" />
            </el-select>
            <button
              class="ink-btn ink-btn-outline ink-btn-sm"
              type="button"
              :disabled="!bookId || busy"
              @click="runCompare"
            >
              对比节奏
            </button>
          </div>
          <template v-if="comparison">
            <ul class="pacing-findings">
              <li v-for="item in comparison.findings" :key="item">{{ item }}</li>
            </ul>
            <div
              v-if="comparison.mine.summary.indexedChapters && comparison.benchmark.summary.indexedChapters"
              ref="compareChartRef"
              class="pacing-chart"
              role="img"
              aria-label="我的作品与对标书逐章爽点强度对比"
            ></div>
            <details class="pacing-table">
              <summary>查看逐章数据</summary>
              <table>
                <thead>
                  <tr>
                    <th>章</th>
                    <th>我的书·爽点</th>
                    <th>我的书·章末钩</th>
                    <th>对标书·爽点</th>
                    <th>对标书·章末钩</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in tableRows" :key="row.no">
                    <td>{{ row.no }}</td>
                    <td>{{ row.mine }}</td>
                    <td>{{ row.mineHook }}</td>
                    <td>{{ row.theirs }}</td>
                    <td>{{ row.theirsHook }}</td>
                  </tr>
                </tbody>
              </table>
            </details>
          </template>
        </template>
        <p v-else-if="profile" class="pacing-note">
          还没有章节卡。生成后这里会出现逐章爽点曲线、钩子与爽点类型分布和开篇模式，也能和你自己的书对比节奏。
        </p>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { uiChartFontSize } from '@/utils/ui-typography'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useUiPreferencesStore } from '@/stores/ui-preferences'
import { ElMessage } from 'element-plus'
import { writingCommand } from '@/writing-service/client'
import { isTauriRuntime } from '@/storage'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { inkConfirm } from '@/utils/ink-confirm'
import { echarts, type EChartsInstance, type EChartsOption } from '@/utils/echarts'

interface CurvePoint {
  no: number
  title: string
  indexed: boolean
  oneLine?: string
  payoffPeak?: number
  payoffTypes?: string[]
  endHook?: { type: string; strength?: number | null } | null
}
interface TypeCount {
  type: string
  count: number
}
interface PacingSummary {
  indexedChapters: number
  totalChapters: number
  payoffsPerChapter: number
  endHookRate: number
  longestPayoffGap: { length: number; from: number; to: number }
  endHookTypes: TypeCount[]
  payoffTypes: TypeCount[]
}
interface Recipe {
  id: string
  title: string
  steps: Array<{ position: string; tasks: string }>
}
interface Profile {
  summary: PacingSummary
  curve: CurvePoint[]
  opening: Array<{ no: number; oneLine: string; payoffTypes: string[]; endHook: { type: string } | null }>
  threads: { averagePayoffDistance: number | null }
  recipes: Recipe[]
}
interface Comparison {
  findings: string[]
  mine: { summary: PacingSummary; curve: CurvePoint[] }
  benchmark: { title?: string; summary: PacingSummary; curve: CurvePoint[] }
}

const props = defineProps<{ visible: boolean; projectId: number; bookTitle: string }>()
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()
const desktop = isTauriRuntime()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const profile = ref<Profile | null>(null)
const comparison = ref<Comparison | null>(null)
const books = ref<Array<{ label: string; value: string }>>([])
const bookId = ref('')
const profileChartRef = ref<HTMLElement>()
const compareChartRef = ref<HTMLElement>()
let profileChart: EChartsInstance | null = null
let compareChart: EChartsInstance | null = null
let unlistenIndex: (() => void) | undefined
let reloadTimer: ReturnType<typeof setTimeout> | undefined

const summary = computed(() => profile.value?.summary || null)
const missing = computed(() =>
  summary.value ? summary.value.totalChapters - summary.value.indexedChapters : 0
)
const profileChartLabel = computed(
  () => `《${props.bookTitle}》逐章爽点强度，共 ${summary.value?.indexedChapters ?? 0} 章有章节卡`
)
const share = (count: number, list: TypeCount[]) =>
  `${Math.max(6, Math.round((count / Math.max(1, ...list.map(item => item.count))) * 100))}%`
const hookText = (point?: CurvePoint) =>
  !point?.indexed
    ? '未索引'
    : point.endHook
      ? `${point.endHook.type}${point.endHook.strength ? `·${point.endHook.strength}` : ''}`
      : '无'
const tableRows = computed(() => {
  const mine = comparison.value?.mine.curve || []
  const theirs = comparison.value?.benchmark.curve || []
  return Array.from({ length: Math.max(mine.length, theirs.length) }, (_, index) => ({
    no: index + 1,
    mine: mine[index]?.indexed ? mine[index].payoffPeak : mine[index] ? '未索引' : '—',
    mineHook: mine[index] ? hookText(mine[index]) : '—',
    theirs: theirs[index]?.indexed ? theirs[index].payoffPeak : theirs[index] ? '未索引' : '—',
    theirsHook: theirs[index] ? hookText(theirs[index]) : '—'
  }))
})

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
function baseOption(): Pick<EChartsOption, 'grid' | 'yAxis' | 'textStyle'> {
  const sec = css('--ink-sec', '#655E56')
  return {
    grid: { left: 36, right: 16, top: 28, bottom: 28 },
    textStyle: { color: sec, fontSize: uiChartFontSize(11) },
    yAxis: {
      type: 'value',
      min: 0,
      max: 5,
      interval: 1,
      axisLabel: { color: sec, fontSize: uiChartFontSize(11) },
      splitLine: { lineStyle: { color: css('--ui-border', 'rgba(0,0,0,0.08)'), width: 1, type: 'solid' } }
    }
  }
}
function tooltip(): EChartsOption['tooltip'] {
  return {
    trigger: 'axis',
    backgroundColor: css('--popover-bg', '#fcfbf7'),
    borderColor: css('--ui-border', 'rgba(0,0,0,0.08)'),
    textStyle: { color: css('--ink-main', '#241F1B'), fontSize: uiChartFontSize(12) },
    axisPointer: { type: 'line', lineStyle: { color: css('--ui-border', 'rgba(0,0,0,0.12)') } }
  }
}
function renderProfile() {
  if (!profileChartRef.value || !profile.value) return
  profileChart ??= echarts.init(profileChartRef.value, undefined, { renderer: 'canvas' })
  const points = profile.value.curve
  const accent = css('--ink-accent', '#7A3028')
  profileChart.setOption(
    {
      ...baseOption(),
      tooltip: {
        ...tooltip(),
        formatter: (params: unknown) => {
          const point = points[(params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0]
          if (!point) return ''
          if (!point.indexed) return `第 ${point.no} 章 ${point.title}<br/>还没有章节卡`
          return `第 ${point.no} 章 ${point.title}<br/>爽点强度 ${point.payoffPeak}${
            point.payoffTypes?.length ? `（${point.payoffTypes.join('、')}）` : '（无爽点）'
          }<br/>章末钩子：${hookText(point)}`
        }
      },
      xAxis: {
        type: 'category',
        data: points.map(point => String(point.no)),
        axisLabel: { color: css('--ink-sec', '#655E56'), fontSize: uiChartFontSize(11) },
        axisLine: { lineStyle: { color: css('--ui-border', 'rgba(0,0,0,0.12)') } },
        axisTick: { show: false }
      },
      series: [
        {
          name: '爽点强度',
          type: 'bar',
          barMaxWidth: 24,
          itemStyle: { color: accent, borderRadius: [4, 4, 0, 0] },
          data: points.map(point => (point.indexed ? point.payoffPeak || 0 : null))
        }
      ]
    },
    true
  )
}
function renderCompare() {
  if (!compareChartRef.value || !comparison.value) return
  compareChart ??= echarts.init(compareChartRef.value, undefined, { renderer: 'canvas' })
  const { mine, benchmark } = comparison.value
  const length = Math.max(mine.curve.length, benchmark.curve.length)
  const value = (list: CurvePoint[], index: number) =>
    list[index]?.indexed ? list[index].payoffPeak || 0 : null
  const accent = css('--ink-accent', '#7A3028')
  const context = css('--ink-sec', '#655E56')
  const surface = css('--bg-main', '#F2F0EA')
  // 强调式：我的书是主角（强调色实线），对标书是参照（灰色虚线），不靠两种颜色区分
  compareChart.setOption(
    {
      ...baseOption(),
      grid: { left: 36, right: 16, top: 40, bottom: 28 },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 18,
        itemHeight: 2,
        textStyle: { color: css('--ink-main', '#241F1B'), fontSize: uiChartFontSize(12) }
      },
      tooltip: tooltip(),
      xAxis: {
        type: 'category',
        data: Array.from({ length }, (_, index) => `第${index + 1}章`),
        axisLabel: { color: context, fontSize: uiChartFontSize(11) },
        axisLine: { lineStyle: { color: css('--ui-border', 'rgba(0,0,0,0.12)') } },
        axisTick: { show: false }
      },
      series: [
        {
          name: `对标《${comparison.value.benchmark.title || props.bookTitle}》`,
          type: 'line',
          connectNulls: false,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { color: context, width: 2, type: 'dashed', cap: 'round', join: 'round' },
          itemStyle: { color: context, borderColor: surface, borderWidth: 2 },
          data: Array.from({ length }, (_, index) => value(benchmark.curve, index))
        },
        {
          name: '我的书',
          type: 'line',
          connectNulls: false,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { color: accent, width: 2, cap: 'round', join: 'round' },
          itemStyle: { color: accent, borderColor: surface, borderWidth: 2 },
          data: Array.from({ length }, (_, index) => value(mine.curve, index))
        }
      ]
    } as EChartsOption,
    true
  )
}

async function loadProfile() {
  try {
    profile.value = await writingCommand<Profile>('breakdown_profile', { projectId: String(props.projectId) })
    error.value = ''
    await nextTick()
    renderProfile()
  } catch (reason) {
    error.value = `读取节奏数据失败：${String(reason)}`
  }
}
async function load() {
  if (!desktop || !props.projectId) return
  await loadProfile()
  try {
    books.value = (await getLocalLibraryStorage().listLocalBooks())
      .filter(Boolean)
      .map(book => ({ label: String(book.title || '未命名'), value: String(book.id) }))
  } catch (reason) {
    console.warn('读取作品列表失败', reason)
  }
  if (!unlistenIndex) {
    const { listen } = await import('@tauri-apps/api/event')
    unlistenIndex = await listen<{ event: string; bookId?: string; summary?: { skipped?: string } }>(
      'agent-index',
      event => {
        if (event.payload.event === 'index_finished' && event.payload.summary?.skipped === 'no_model')
          notice.value = '还没有可用的文本模型，章节卡暂未生成。请先在模型管理中配置。'
        if (event.payload.bookId && event.payload.bookId !== `breakdown:${props.projectId}`) return
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => void loadProfile(), 800)
      }
    )
  }
}
async function build() {
  busy.value = true
  try {
    await inkConfirm(
      `将为 ${missing.value} 章生成章节卡，每章调用一次索引模型，在后台进行。继续吗？`,
      '生成章节卡',
      {
        confirmButtonText: '开始',
        cancelButtonText: '取消'
      }
    )
    const { queued } = await writingCommand<{ queued: number }>('index_rebuild', {
      bookId: `breakdown:${props.projectId}`,
      onlyMissing: true
    })
    notice.value = queued ? `已加入 ${queued} 章，生成进度会自动刷新。` : '章节卡已齐。'
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') ElMessage.error(String(reason))
  } finally {
    busy.value = false
  }
}
async function runCompare() {
  if (!bookId.value) return
  busy.value = true
  try {
    comparison.value = await writingCommand<Comparison>('breakdown_compare', {
      projectId: String(props.projectId),
      bookId: bookId.value
    })
    await nextTick()
    renderCompare()
  } catch (reason) {
    ElMessage.error(String(reason))
  } finally {
    busy.value = false
  }
}
async function removeRecipe(id: string) {
  try {
    await inkConfirm('删除这条配方？', '删除配方', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await writingCommand('delete_recipe', { id })
    await loadProfile()
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') ElMessage.error(String(reason))
  }
}
function disposeCharts() {
  profileChart?.dispose()
  compareChart?.dispose()
  profileChart = null
  compareChart = null
}
const uiPreferences = useUiPreferencesStore()
watch(() => uiPreferences.uiFontSize, () => { renderProfile(); renderCompare() }, { flush: 'post' })
const onResize = () => {
  profileChart?.resize()
  compareChart?.resize()
}
window.addEventListener('resize', onResize)
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  clearTimeout(reloadTimer)
  unlistenIndex?.()
  disposeCharts()
})
</script>

<style scoped lang="scss">
.pacing-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.7;
}

.pacing-coverage {
  display: flex;
  > button {
    flex-shrink: 0;
    white-space: nowrap;
  }
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;

  > div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  small {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.pacing-note {
  margin: 0;
  color: var(--ink-sec);

  &.is-error {
    color: var(--state-danger, #b4453a);
  }
}

.pacing-muted {
  color: var(--ink-sec);
}

.pacing-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;

  > div {
    display: grid;
    gap: 2px;
    padding: 10px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
  }

  span {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  strong {
    font-size: calc(20px * var(--ui-font-scale, 1));
    font-weight: 600;
  }
}

.pacing-title {
  margin-top: 4px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.pacing-chart {
  width: 100%;
  height: 220px;
}

.pacing-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.pacing-bars {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: grid;
  gap: 6px;

  li {
    display: grid;
    grid-template-columns: 4em minmax(0, 1fr) 2em;
    align-items: center;
    gap: 8px;
  }

  i {
    display: block;
    height: 8px;
    border-radius: 0 4px 4px 0;
    background: var(--ink-accent, #7a3028);
  }

  em {
    font-style: normal;
    color: var(--ink-sec);
    font-variant-numeric: tabular-nums;
  }
}

.pacing-opening {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 6px;

  li > * {
    display: block;
  }

  small {
    color: var(--ink-sec);
  }
}

.pacing-recipe {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;

  header {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }

  p {
    margin: 2px 0;
  }

  b {
    margin-right: 8px;
    font-weight: 600;
  }
}

.pacing-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-sec);
  cursor: pointer;

  &:hover {
    color: var(--ink-main);
  }
}

.pacing-compare-bar {
  display: flex;
  gap: 10px;
  align-items: center;

  .el-select {
    width: 260px;
    max-width: 100%;
  }
}

.pacing-findings {
  margin: 0;
  padding-left: 1.2em;
  display: grid;
  gap: 4px;
}

.pacing-table {
  summary {
    cursor: pointer;
    color: var(--ink-sec);
  }

  table {
    width: 100%;
    margin-top: 8px;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  th,
  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--ui-border);
    text-align: left;
  }

  th {
    color: var(--ink-sec);
    font-weight: 400;
  }
}

@media (max-width: 720px) {
  .pacing-kpis,
  .pacing-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pacing-coverage {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
