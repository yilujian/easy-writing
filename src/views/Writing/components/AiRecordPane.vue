<template>
  <section class="ai-record-pane">
    <!-- 统计卡 -->
    <div class="summary-grid">
      <div class="summary-card">
        <span class="summary-icon total"><i class="fa-solid fa-file-lines"></i></span>
        <span class="summary-info">
          <span class="label">总次数</span>
          <strong>{{ formatNumber(summary.total) }}</strong>
        </span>
      </div>
      <div class="summary-card">
        <span class="summary-icon success"><i class="fa-solid fa-circle-check"></i></span>
        <span class="summary-info">
          <span class="label">成功</span>
          <strong>{{ formatNumber(summary.successTotal) }}</strong>
        </span>
      </div>
      <div class="summary-card">
        <span class="summary-icon fail"><i class="fa-solid fa-circle-xmark"></i></span>
        <span class="summary-info">
          <span class="label">失败</span>
          <strong>{{ formatNumber(summary.failTotal) }}</strong>
        </span>
      </div>
      <div class="summary-card">
        <span class="summary-icon cost"><i class="fa-solid fa-coins"></i></span>
        <span class="summary-info">
          <span class="label">Token 用量</span>
          <strong>{{ formatNumber(summary.inputTokens + summary.outputTokens) }}</strong>
        </span>
      </div>
    </div>

    <!-- 筛选条 -->
    <div class="record-toolbar">
      <div class="toolbar-field">
        <span class="field-label">类型</span>
        <div class="segmented">
          <button
            v-for="option in recordTypeOptions"
            :key="option.value"
            type="button"
            class="segment-btn"
            :class="{ active: query.recordType === option.value }"
            @click="setRecordType(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div class="toolbar-field">
        <span class="field-label">状态</span>
        <div class="segmented">
          <button
            v-for="option in statusOptions"
            :key="option.value"
            type="button"
            class="segment-btn"
            :class="[option.tone, { active: query.status === option.value }]"
            @click="setStatus(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <el-select
        v-model="query.scene"
        class="scene-select"
        size="default"
        clearable
        filterable
        placeholder="全部功能"
        @change="searchRecords"
      >
        <el-option-group v-for="group in sceneGroups" :key="group.title" :label="group.title">
          <el-option
            v-for="item in group.items"
            :key="item.scene"
            :label="item.label"
            :value="item.scene"
          />
        </el-option-group>
      </el-select>
      <el-input
        v-model="query.keyWord"
        class="keyword-input"
        clearable
        placeholder="关键词"
        @clear="searchRecords"
        @keyup.enter="searchRecords"
      >
        <template #prefix>
          <i class="fa-solid fa-magnifying-glass"></i>
        </template>
      </el-input>
      <div class="date-range">
        <el-date-picker
          v-model="query.startTime"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="开始日期"
          class="date-picker"
          @change="searchRecords"
        />
        <span class="range-sep">~</span>
        <el-date-picker
          v-model="query.endTime"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="结束日期"
          class="date-picker"
          @change="searchRecords"
        />
      </div>
      <button class="ink-btn ink-btn-outline refresh-btn" type="button" :disabled="loading" @click="searchRecords">
        <i v-if="loading" class="fa-solid fa-spinner fa-spin"></i>
        <i v-else class="fa-solid fa-rotate-right"></i>
        刷新
      </button>
    </div>

    <!-- 记录表：表头固定，仅记录行滚动 -->
    <div class="record-table">
      <div class="record-head">
        <span>信息</span>
        <span>模型</span>
        <span>创建时间</span>
        <span>耗时</span>
        <span class="col-cost">Token</span>
      </div>

      <div class="record-body custom-scroll">
        <!-- 骨架屏：占位行与真实行等高，分页切换时列表高度稳定、分页器不跳动 -->
        <template v-if="loading">
          <div v-for="n in skeletonCount" :key="`sk-${n}`" class="record-row skeleton-row">
            <span class="record-info">
              <span class="sk-block sk-icon"></span>
              <span class="sk-block sk-line" style="width: 55%"></span>
            </span>
            <span><span class="sk-block sk-line" style="width: 72%"></span></span>
            <span><span class="sk-block sk-line" style="width: 82%"></span></span>
            <span><span class="sk-block sk-line" style="width: 60%"></span></span>
            <span class="sk-cost"><span class="sk-block sk-line" style="width: 64%"></span></span>
          </div>
        </template>
        <div v-else-if="!records.length" class="empty-state">暂无 AI 记录</div>
        <template v-else>
          <div v-for="record in records" :key="recordKey(record)" class="record-group">
            <!-- 点一行展开：看这次调用发给模型的完整输入、模型的输出与错误原文 -->
            <div
              class="record-row"
              :class="{ failed: record.status === 0, expanded: expandedKey === recordKey(record) }"
              role="button"
              tabindex="0"
              :aria-expanded="expandedKey === recordKey(record)"
              @click="toggleDetail(record)"
              @keydown.enter.prevent="toggleDetail(record)"
              @keydown.space.prevent="toggleDetail(record)"
            >
              <span class="record-info">
                <!-- 不加载供应商临时链接（易过期/防盗链），统一用类型图标 -->
                <span class="record-icon">
                  <i :class="record.recordType === 'image' ? 'fa-solid fa-image' : 'fa-solid fa-file-lines'"></i>
                </span>
                <span class="record-name">
                  <span class="name-line">
                    <strong>{{ record.sceneLabel || record.scene || 'AI记录' }}</strong>
                    <em class="status-pill" :class="statusClass(record.status)">{{ statusLabel(record.status) }}</em>
                    <i class="fa-solid fa-chevron-down row-chevron" aria-hidden="true"></i>
                  </span>
                  <span v-if="record.status === 0 && record.errorMsg" class="error-line">{{ record.errorMsg }}</span>
                  <span v-else class="preview-line">{{ record.outputPreview || record.inputPreview || '' }}</span>
                </span>
              </span>

              <span class="record-model">{{ record.modelName || record.modelCode || '-' }}</span>
              <span class="record-time">{{ record.createTime || '-' }}</span>
              <span class="record-duration">{{ formatDuration(record.duration) }}</span>

              <!-- 供应商响应带 usage 时是真实值，流式/生图按字数估算 -->
              <span class="record-cost">{{ formatNumber(record.inputTokens + record.outputTokens) }}</span>
            </div>

            <div v-if="expandedKey === recordKey(record)" class="record-detail">
              <p v-if="record.status === 0 && record.errorMsg" class="detail-error">
                <i class="fa-solid fa-circle-exclamation"></i>
                {{ record.errorMsg }}
              </p>
              <div class="detail-grid">
                <div class="detail-block">
                  <div class="detail-head">
                    <span>输入<small>（发给模型的内容，账本最多留 2000 字）</small></span>
                    <button type="button" class="detail-copy" :disabled="!record.input" @click.stop="copyText(record.input)">复制</button>
                  </div>
                  <pre>{{ record.input || '（空）' }}</pre>
                </div>
                <div class="detail-block">
                  <div class="detail-head">
                    <span>输出</span>
                    <button type="button" class="detail-copy" :disabled="!record.output" @click.stop="copyText(record.output)">复制</button>
                  </div>
                  <pre>{{ record.output || (record.status === 0 ? '（调用失败，没有输出）' : '（空）') }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div v-if="pagination.total > pagination.size" class="pagination-row">
      <el-pagination
        small
        background
        layout="prev, pager, next, sizes"
        :page-sizes="[10, 20, 30, 50]"
        :current-page="pagination.page"
        :page-size="pagination.size"
        :total="pagination.total"
        @current-change="changePage"
        @size-change="changeSize"
      />
    </div>

  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { showApiError } from '@/utils/api-error'
import type {
  AiRecordListItem,
  AiRecordPageQuery,
  AiRecordSummary,
  AiRecordStatus,
  AiRecordType,
} from '@/types/ai-record'
// 开源版：账本由请求层自动落在本机（storage/local-ai-records），这里只读
import {
  getLocalAiRecordPage as getAiRecordPageApi,
  getLocalAiRecordSummary as getAiRecordSummaryApi,
  getLocalAiRecordSceneOptions,
} from '@/storage/local-ai-records'

interface RecordSceneGroup {
  title: string
  items: Array<{ scene: string; label: string }>
}

const recordTypeOptions: Array<{ label: string; value: AiRecordType }> = [
  { label: '全部类型', value: '' },
  { label: '文字 AI', value: 'text' },
  { label: '生图 AI', value: 'image' },
]

const statusOptions: Array<{ label: string; value: AiRecordStatus; tone?: string }> = [
  { label: '全部状态', value: '' },
  { label: '成功', value: '1', tone: 'tone-success' },
  { label: '失败', value: '0', tone: 'tone-fail' },
  { label: '生成中', value: '2' },
]

const records = ref<AiRecordListItem[]>([])
const loading = ref(false)
/** 当前展开详情的那一行；翻页、刷新后收起 */
const expandedKey = ref('')
const recordKey = (record: AiRecordListItem) => `${record.recordType}-${record.id}`
const toggleDetail = (record: AiRecordListItem) => {
  const key = recordKey(record)
  expandedKey.value = expandedKey.value === key ? '' : key
}
const copyText = async (text?: string) => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择文本')
  }
}
// 骨架行数跟随当前列表高度，翻页时保持等高；首次加载按页大小占位
const skeletonCount = computed(() => records.value.length || Math.min(pagination.size, 10))
const summary = reactive<AiRecordSummary>({
  total: 0,
  successTotal: 0,
  failTotal: 0,
  runningTotal: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
})
const pagination = reactive({
  page: 1,
  size: 10,
  total: 0,
})
const query = reactive<AiRecordPageQuery>({
  page: 1,
  size: 10,
  recordType: '',
  status: '',
  scene: '',
  keyWord: '',
  startTime: '',
  endTime: '',
})

const sceneGroups = ref<RecordSceneGroup[]>([])

// 场景目录从本机账本聚合：每次刷新同步，新的功能用过一次就会出现在筛选里
const loadSceneGroups = async () => {
  try {
    const { data } = await getLocalAiRecordSceneOptions()
    sceneGroups.value = data
  } catch {
    // 筛选降级为不可选，不影响列表加载
  }
}

onMounted(() => {
  void loadRecords(1)
  void loadSceneGroups()
})

const setRecordType = (value: AiRecordType) => {
  if (query.recordType === value) return
  query.recordType = value
  searchRecords()
}

const setStatus = (value: AiRecordStatus) => {
  if (query.status === value) return
  query.status = value
  searchRecords()
}

const searchRecords = () => {
  void loadRecords(1)
}

const changePage = (page: number) => {
  void loadRecords(page)
}

const changeSize = (size: number) => {
  pagination.size = size
  query.size = size
  void loadRecords(1)
}

const loadRecords = async (page = pagination.page) => {
  loading.value = true
  try {
    const payload = buildQuery(page)
    const [pageRes, summaryRes] = await Promise.all([
      getAiRecordPageApi(payload),
      getAiRecordSummaryApi(stripPageQuery(payload)),
    ])
    records.value = pageRes.data?.list || []
    expandedKey.value = ''
    pagination.page = pageRes.data?.pagination?.page || page
    pagination.size = pageRes.data?.pagination?.size || payload.size
    pagination.total = pageRes.data?.pagination?.total || 0
    Object.assign(summary, summaryRes.data || {})
  } catch (error) {
    showApiError(error, '加载 AI 记录失败')
  } finally {
    loading.value = false
  }
}

// 统一收敛分页和筛选参数，避免前端传入用户范围。
const buildQuery = (page: number): AiRecordPageQuery => ({
  page,
  size: pagination.size,
  recordType: query.recordType || '',
  status: query.status || '',
  scene: query.scene?.trim() || '',
  keyWord: query.keyWord?.trim() || '',
  startTime: query.startTime || '',
  endTime: query.endTime || '',
})

const stripPageQuery = (payload: AiRecordPageQuery) => {
  const { page: _page, size: _size, ...rest } = payload
  return rest
}

const statusLabel = (status?: number) => {
  if (status === 1) return '成功'
  if (status === 2) return '生成中'
  return '失败'
}

const statusClass = (status?: number) => {
  if (status === 1) return 'success'
  if (status === 2) return 'running'
  return 'fail'
}

const formatDuration = (duration?: number) => {
  const value = Number(duration || 0)
  if (!value) return '-'
  if (value < 1000) return `${value}ms`
  return `${(value / 1000).toFixed(1)}s`
}

const formatNumber = (value?: number, fraction = 0) => {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  })
}

</script>

<style scoped lang="scss">
.ai-record-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ink-main);
  // 撑满外层填充容器，配合内部 record-body 实现"仅列表滚动"
  flex: 1;
  min-height: 0;
  height: 100%;
}

/* --- 统计卡 --- */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  flex-shrink: 0;
}

.summary-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--settings-control-bg, var(--surface-0));
}

.summary-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 50%;
  font-size: calc(17px * var(--ui-font-scale, 1));

  &.total {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &.success {
    color: var(--state-success-on);
    background: var(--state-success-surface);
  }

  &.fail {
    color: var(--state-danger-on);
    background: var(--state-danger-surface);
  }

  &.cost {
    color: var(--state-warning);
    background: linear-gradient(180deg, #fdf0d5, #fbe3ae);
  }
}

.summary-info {
  min-width: 0;

  .label {
    display: block;
    margin-bottom: 3px;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  strong {
    display: block;
    overflow: hidden;
    color: var(--ink-main);
    font-family: 'Noto Serif SC', serif;
    font-size: calc(20px * var(--ui-font-scale, 1));
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* --- 筛选条 --- */
.record-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--settings-control-bg, var(--surface-0));
  flex-shrink: 0;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-label {
  color: var(--settings-muted-color, var(--ink-sec));
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

// 分段切换：外层只是一条淡色轨道，没有边框；选中项是浮起的实心块。
// 筛选条本身已有一圈边框，这里再画边框就会出现套了两三层框的效果。
.segmented {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-main) 7%, transparent);
}

.segment-btn {
  padding: 4px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;

  &:hover {
    color: var(--ink-main);
  }

  &.tone-success {
    color: var(--state-success-on);
  }

  &.tone-fail {
    color: var(--state-danger-on);
  }

  &.active {
    color: var(--ink-accent);
    font-weight: 600;
    background: var(--input-bg);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ink-main) 16%, transparent);

    &.tone-success {
      color: var(--state-success-on);
      background: var(--state-success-surface);
    }

    &.tone-fail {
      color: var(--state-danger-on);
      background: var(--state-danger-surface);
    }
  }
}

.scene-select {
  width: 150px;
}

.keyword-input {
  width: 170px;
}

.date-range {
  display: flex;
  align-items: center;
  gap: 6px;

  .range-sep {
    color: var(--ink-sec);
  }
}

.date-picker {
  width: 140px;
}

.refresh-btn {
  height: 32px;
  margin-left: auto;
  white-space: nowrap;
}

/* --- 记录表 --- */
$record-columns: minmax(240px, 1.6fr) minmax(140px, 1fr) 168px 72px 110px;

.record-table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--settings-control-bg, var(--surface-0));
}

.record-head {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: $record-columns;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--ink-sec) 7%, transparent);
  color: var(--settings-muted-color, var(--ink-sec));
  font-size: calc(12px * var(--ui-font-scale, 1));

  .col-cost {
    text-align: right;
  }
}

/* 仅此区域滚动，头部与分页保持固定 */
.record-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.record-row {
  display: grid;
  grid-template-columns: $record-columns;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border-top: 1px solid var(--ui-border);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover,
  &.expanded {
    background: color-mix(in srgb, var(--ink-accent) 4%, transparent);
  }

  &:focus-visible {
    outline: 2px solid var(--ink-accent);
    outline-offset: -2px;
  }

  &.expanded .row-chevron {
    transform: rotate(180deg);
  }

  &.failed {
    background: color-mix(in srgb, var(--state-danger) 5%, transparent);
    box-shadow: inset 3px 0 0 var(--state-danger);

    &:hover {
      background: color-mix(in srgb, var(--state-danger) 8%, transparent);
    }
  }
}

.record-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.record-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 8px;
  color: var(--ink-accent);
  background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.record-name {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;

  .name-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  strong {
    overflow: hidden;
    font-size: calc(13px * var(--ui-font-scale, 1));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-line,
  .preview-line {
    overflow: hidden;
    font-size: calc(12px * var(--ui-font-scale, 1));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-line {
    color: var(--state-danger);
  }

  .preview-line {
    color: var(--settings-muted-color, var(--ink-sec));
  }

  .row-chevron {
    flex: 0 0 auto;
    font-size: calc(10px * var(--ui-font-scale, 1));
    color: var(--settings-muted-color, var(--ink-sec));
    transition: transform 0.18s ease;
  }
}

/* 展开的详情：输入输出并排，各自可滚动，不把列表撑得太长 */
.record-detail {
  padding: 0 14px 14px 58px;
  background: color-mix(in srgb, var(--ink-accent) 4%, transparent);
}

.detail-error {
  margin: 0 0 10px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--state-danger);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  line-height: 1.6;
  word-break: break-word;

  i {
    margin-top: 3px;
  }
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.detail-block {
  min-width: 0;

  pre {
    margin: 0;
    max-height: 280px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-glass-bg);
    color: var(--ink-main);
    font: inherit;
    font-size: calc(12.5px * var(--ui-font-scale, 1));
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;
  color: var(--ink-main);

  small {
    margin-left: 4px;
    font-weight: 400;
    color: var(--settings-muted-color, var(--ink-sec));
  }
}

.detail-copy {
  padding: 2px 8px;
  border: 1px solid var(--input-border);
  border-radius: 5px;
  background: transparent;
  color: var(--ink-accent);
  font-size: calc(11px * var(--ui-font-scale, 1));
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--ink-accent);
  }

  &:disabled {
    color: var(--settings-muted-color, var(--ink-sec));
    cursor: not-allowed;
  }
}

.record-model,
.record-time,
.record-duration {
  overflow: hidden;
  color: var(--ink-main);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-time,
.record-duration {
  color: var(--settings-muted-color, var(--ink-sec));
}

.record-cost {
  color: var(--ink-accent);
  font-weight: 600;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: right;
  white-space: nowrap;
}

.status-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 19px;
  padding: 0 7px;
  border-radius: 4px;
  font-style: normal;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: calc(19px * var(--ui-font-scale, 1));

  &.success {
    color: var(--state-success-on);
    background: var(--state-success-surface);
  }

  &.fail {
    color: var(--state-danger-on);
    background: var(--state-danger-surface);
  }

  &.running {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }
}

.empty-state {
  padding: 34px 12px;
  color: var(--settings-muted-color, var(--ink-sec));
  text-align: center;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/* --- 骨架屏 --- */
.skeleton-row {
  pointer-events: none;

  &:hover {
    background: transparent;
  }
}

.sk-block {
  display: inline-block;
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ink-sec) 12%, transparent) 25%,
    color-mix(in srgb, var(--ink-sec) 22%, transparent) 40%,
    color-mix(in srgb, var(--ink-sec) 12%, transparent) 60%
  );
  background-size: 300% 100%;
  animation: sk-shimmer 1.2s ease-in-out infinite;
}

.sk-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 8px;
}

.sk-line {
  height: 13px;
}

.sk-cost {
  text-align: right;
}

@keyframes sk-shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: 0% 0;
  }
}

.pagination-row {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  overflow-x: auto;
}

@media (max-width: 1100px) {
  .record-head {
    display: none;
  }

  .record-detail {
    padding-left: 14px;
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }

  .record-row {
    grid-template-columns: minmax(0, 1fr) 96px;

    .record-model,
    .record-time,
    .record-duration {
      display: none;
    }
  }
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
