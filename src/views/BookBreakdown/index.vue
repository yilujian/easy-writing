<template>
  <div class="breakdown-page">
    <section class="hero">
      <div class="hero-text">
        <h1>AI 深度拆书 · 洞察爆款逻辑</h1>
        <p>上传本地小说，AI 自动提取大纲、分析节奏爽点、总结人物关系</p>
      </div>

      <button class="hero-badge" type="button" @click="historyVisible = true">
        <i class="fa-solid fa-clock-rotate-left"></i>
        拆书历史
      </button>
    </section>

    <section
      class="upload-card fusion-card"
      :class="[viewState, { dragging: isDragging }]"
      @dragover.prevent="handleDragOver"
      @dragleave="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <input
        ref="fileInputRef"
        type="file"
        class="file-input"
        accept=".txt"
        @change="handleFileChange"
      />

      <transition name="fade-up" mode="out-in">
        <div v-if="viewState === 'idle'" key="idle" class="upload-idle" @click="triggerPick">
          <div class="icon-circle">
            <i class="fa-solid fa-cloud-arrow-up"></i>
          </div>
          <div class="upload-title">点击或拖拽文件到此处</div>
          <div class="upload-hint">支持 .txt 格式，单文件最大 50MB，本地解析不上传</div>
          <div class="upload-actions">
            <button type="button" class="ink-btn ink-btn-primary">
              选择文件
            </button>
            <span class="upload-tip">支持自动识别目录与章节结构</span>
          </div>
        </div>

        <div v-else-if="viewState === 'processing'" key="processing" class="upload-processing">
          <div class="file-card">
            <i class="fa-regular fa-file-lines"></i>
            <span>{{ currentFileLabel }}</span>
          </div>

          <div class="progress-container">
            <div class="ink-bar-bg">
              <div class="ink-bar-fill" :style="{ width: `${progress}%` }"></div>
            </div>
            <div class="progress-meta">
              <span>{{ statusText }}</span>
              <span>{{ progress }}%</span>
            </div>
          </div>

          <div class="wait-tip" :class="{ show: waitTipVisible }">
            <i class="fa-solid fa-mug-hot"></i>
            全书在本机解析章节结构，创建后进入工作台发起 AI 拆解。
          </div>

          <button type="button" class="ink-btn ink-btn-outline ink-btn-sm upload-cancel-btn" @click="cancelUpload">
            <i class="fa-solid fa-xmark"></i>
            取消上传
          </button>
        </div>

        <div v-else key="success" class="upload-success">
          <div class="result-left">
            <div class="book-cover-icon">
              <i class="fa-solid fa-book-open"></i>
            </div>
            <div class="book-title">{{ analysisResult.title }}</div>
            <div class="book-author">{{ analysisResult.author }}</div>
            <div class="book-progress">
              <span>{{ resultStageLabel }}</span>
              <span>{{ analysisResult.progress }}</span>
            </div>
          </div>
          <div class="result-right">
            <div class="result-desc">{{ resultDescription }}</div>

            <div class="data-grid">
              <div v-for="item in stats" :key="item.label" class="data-item">
                <div class="data-label">{{ item.label }}</div>
                <div class="data-val" :class="item.tone">{{ item.value }}</div>
              </div>
            </div>

            <div class="tags-row">
              <span v-for="tag in analysisResult.tags" :key="tag" class="ai-tag">{{ tag }}</span>
            </div>

            <div class="result-actions">
              <button class="ink-btn ink-btn-primary" type="button" @click="goWorkbench">
                进入拆解工作台
                <i class="fa-solid fa-arrow-right"></i>
              </button>
              <button class="ink-btn ink-btn-outline" type="button" @click="resetUpload">
                重新上传
              </button>
            </div>
          </div>
        </div>
      </transition>
    </section>

    <EwModal
      :visible="historyVisible"
      title="拆书历史"
      width="860px"
      :close-on-click-modal="true"
      custom-class="breakdown-history-modal"
      @update:visible="historyVisible = $event"
    >
      <div class="history-modal">
        <div class="history-toolbar">
          <div class="history-summary">
            共 {{ historyList.length }} 条记录
          </div>
          <!-- <button class="ink-btn ink-btn-outline" type="button" @click="historyVisible = false">
            关闭
          </button> -->
        </div>

        <div v-if="historyLoading && !historyList.length" class="history-empty">
          <i class="fa-solid fa-spinner fa-spin"></i>
          正在加载拆书记录...
        </div>

        <div v-else-if="!historyList.length" class="history-empty">
          暂无拆书记录
        </div>

        <div v-else class="history-list">
          <button
            v-for="item in historyList"
            :key="item.id"
            class="history-item"
            type="button"
            @click="openHistoryItem(item)"
          >
            <div class="history-icon">
              <i class="fa-solid fa-clock-rotate-left"></i>
            </div>
            <div class="history-content">
              <div class="history-title">
                <span class="title-text">{{ item.title }}</span>
                <span class="title-meta">{{ item.author }}</span>
              </div>
              <div class="history-meta">
                <span class="history-status" :class="item.status">{{ statusLabel(item.status) }}</span>
                <span class="history-progress">{{ item.progress }}</span>
                <span class="history-time">{{ item.time }}</span>
              </div>
              <div class="history-tags">
                <span v-for="tag in item.tags" :key="tag">#{{ tag }}</span>
              </div>
            </div>
            <div class="history-actions">
              <button class="history-delete" type="button" @click.stop="handleDeleteHistory(item)">
                删除
              </button>
              <span class="history-action">
                进入工作台
                <i class="fa-solid fa-arrow-right"></i>
              </span>
            </div>
          </button>
        </div>
      </div>
    </EwModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import EwModal from '@/components/EwModal/index.vue'
import type { BreakdownProjectSummary } from '@/types/breakdown'
// 开源版：拆书全走本地——TXT 本机解析、拆解走本地模型、记录存 IndexedDB
import {
  createLocalBreakdownProject,
  deleteLocalBreakdownProject as deleteBreakdownProjectApi,
  getLocalBreakdownHistory as getBreakdownHistoryApi,
} from '@/storage/local-breakdown'

type AnalysisResult = {
  projectId: number
  title: string
  author: string
  wordCount: string
  chapterCount: string
  characterCount: string
  mood: string
  tags: string[]
  progress: string
  status: 'wait' | 'done' | 'processing' | 'failed'
}

type HistoryItem = {
  id: number
  title: string
  author: string
  progress: string
  time: string
  status: 'wait' | 'done' | 'processing' | 'failed'
  tags: string[]
}

const router = useRouter()
const fileInputRef = ref<HTMLInputElement | null>(null)
const historyVisible = ref(false)

const viewState = ref<'idle' | 'processing' | 'success'>('idle')
const progress = ref(0)
const statusText = ref('正在本地解析章节结构...')
const waitTipVisible = ref(true)
const isDragging = ref(false)
const currentFile = ref<File | null>(null)
// 解析中断标记：用户点"取消"时置位，解析完成后按它决定是否丢弃结果
const uploadController = ref<AbortController | null>(null)

const analysisResult = ref<AnalysisResult>({
  projectId: 0,
  title: '斗破苍穹',
  author: '天蚕土豆',
  wordCount: '532 万字',
  chapterCount: '1,642 章',
  characterCount: '128 人',
  mood: '热血 / 逆袭',
  tags: ['退婚流', '异火', '炼药师', '莫欺少年穷'],
  progress: '待拆解',
  status: 'wait'
})

const historyList = ref<HistoryItem[]>([])
const historyLoading = ref(false)

const stats = computed(() => [
  { label: '总字数', value: analysisResult.value.wordCount, tone: '' },
  { label: '章节数', value: analysisResult.value.chapterCount, tone: '' },
  { label: '主要角色', value: analysisResult.value.characterCount, tone: '' },
  { label: '情感基调', value: analysisResult.value.mood, tone: 'accent' }
])

const resultStageLabel = computed(() => {
  if (analysisResult.value.status === 'done') return '拆解完成'
  if (analysisResult.value.status === 'failed') return '拆解失败'
  if (analysisResult.value.status === 'processing') return '后台拆解中'
  return '项目已创建'
})

const resultDescription = computed(() => {
  if (analysisResult.value.status === 'done') {
    return 'AI 已完成拆解，当前结果来自真实项目状态。'
  }
  if (analysisResult.value.status === 'failed') {
    return '拆解任务已中断，可进入工作台查看失败章节并重试。'
  }
  if (analysisResult.value.status === 'processing') {
    return '项目已进入后台拆解，您可以离开当前页面，稍后回到历史或工作台继续查看真实进度。'
  }
  return '项目已创建，您可以直接进入工作台发起拆解，也可以稍后在拆书历史中继续处理。'
})

const currentFileLabel = computed(() => {
  const file = currentFile.value
  if (!file) return '正在读取文件...'
  const size = (file.size / (1024 * 1024)).toFixed(1)
  return `${file.name} (${size}MB)`
})

const triggerPick = () => {
  if (viewState.value !== 'idle') return
  fileInputRef.value?.click()
}

// 本地解析目前只认 TXT（docx/epub 解析依赖服务端，开源版收口到纯文本）
const MAX_UPLOAD_MB = 50
const ALLOWED_EXT = ['txt']
const validateUploadFile = (file: File): boolean => {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_EXT.includes(ext)) {
    ElMessage.error(`仅支持 ${ALLOWED_EXT.join(' / ')} 格式`)
    return false
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    ElMessage.error(`文件不能超过 ${MAX_UPLOAD_MB}MB`)
    return false
  }
  return true
}

const handleFileChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !validateUploadFile(file)) return
  startProcess(file)
}

const handleDragOver = () => {
  if (viewState.value !== 'idle') return
  isDragging.value = true
}

const handleDragLeave = () => {
  isDragging.value = false
}

const handleDrop = (event: DragEvent) => {
  isDragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (!file || !validateUploadFile(file)) return
  startProcess(file)
}

const projectProgressLabel = (result: Pick<BreakdownProjectSummary, 'status' | 'progress'>) => {
  if (result.status === 'wait') return '待拆解'
  if (result.status === 'done') return '已完成'
  if (result.status === 'failed') return '失败，可重试'
  return `拆解中 ${Math.round(Number(result.progress || 0))}%`
}

const formatWordCount = (value: number) => {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万字`
  return `${value} 字`
}

const formatChapterCount = (value: number) => `${value} 章`

const mapResult = (result: BreakdownProjectSummary) => {
  analysisResult.value = {
    projectId: result.id,
    title: result.title,
    author: result.author || '未知作者',
    wordCount: formatWordCount(result.wordCount || 0),
    chapterCount: formatChapterCount(result.chapterCount || 0),
    characterCount: `${result.characterCount || 0} 人`,
    mood: result.mood || '待分析',
    tags: result.tags && result.tags.length ? result.tags : ['大纲拆解', '节奏分析', '角色关系'],
    progress: projectProgressLabel(result),
    status: result.status
  }
}

const startProcess = async (file: File) => {
  currentFile.value = file
  viewState.value = 'processing'
  progress.value = 0
  statusText.value = '正在本地解析章节结构...'
  waitTipVisible.value = true

  // 本地解析很快，但仍保留"取消"：解析完成时若已取消，就把刚建的项目删掉
  const controller = new AbortController()
  uploadController.value = controller

  try {
    progress.value = 60
    const { data } = await createLocalBreakdownProject(file)
    if (controller.signal.aborted) {
      await deleteBreakdownProjectApi({ id: data.id }).catch(() => undefined)
      return
    }
    mapResult(data)
    progress.value = 100
    viewState.value = 'success'
  } catch (error) {
    if (controller.signal.aborted) return
    ElMessage.error(String(error?.message || '解析失败，请检查文件内容后重试'))
    resetUpload()
  } finally {
    if (uploadController.value === controller) uploadController.value = null
  }
}

// 取消解析：本地无网络请求，标记取消并回到初始态
const cancelUpload = () => {
  uploadController.value?.abort()
  uploadController.value = null
  resetUpload()
  ElMessage.info('已取消')
}

const resetUpload = () => {
  viewState.value = 'idle'
  progress.value = 0
  statusText.value = '正在本地解析章节结构...'
  waitTipVisible.value = true
  currentFile.value = null
  if (fileInputRef.value) fileInputRef.value.value = ''
}

const goWorkbench = () => {
  if (!analysisResult.value.projectId) {
    ElMessage.info('示例仅用于展示，请上传文件后进入工作台')
    return
  }
  router.push({
    path: '/bookBreakdown/workbench',
    query: {
      projectId: analysisResult.value.projectId
    }
  })
}

const openHistoryItem = (item: HistoryItem) => {
  historyVisible.value = false
  router.push({
    path: '/bookBreakdown/workbench',
    query: { projectId: item.id }
  })
}

const handleDeleteHistory = async (item: HistoryItem) => {
  try {
    await inkConfirm('删除后将无法恢复，确认删除该拆书记录？', '删除记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
    })
    await deleteBreakdownProjectApi({ id: item.id })
    await fetchHistory()
    ElMessage.success('已删除')
  } catch (error) {
    // 取消删除
  }
}

const statusLabel = (status: HistoryItem['status']) => {
  if (status === 'wait') return '待拆解'
  if (status === 'done') return '已完成'
  if (status === 'processing') return '拆解中'
  return '失败'
}

const fetchHistory = async () => {
  historyLoading.value = true
  try {
    const { data } = await getBreakdownHistoryApi()
    historyList.value = data.map((item) => ({
      id: item.id,
      title: item.title,
      author: item.author || '未知作者',
      progress: item.status === 'wait'
        ? '待拆解'
        : item.progress >= 100
          ? '已完成'
          : `已拆解 ${Math.round(item.progress)}%`,
      time: item.updateTime || item.createTime,
      status: item.status,
      tags: item.tags || []
    }))
  } catch (error) {
    historyList.value = []
  } finally {
    historyLoading.value = false
  }
}

watch(historyVisible, (val) => {
  if (val) fetchHistory()
})

onMounted(() => {
  fetchHistory()
})
</script>

<style scoped lang="scss">
.breakdown-page {
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 24px 10px 40px;
  min-height: 100%;
  // background: var(--bg-main);
}

.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 28px;
  border-radius: 18px;
  background: var(--card-bg, var(--ui-glass-bg));
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow);
}

.hero-text {
  h1 {
    font-size: 30px;
    font-family: 'Ma Shan Zheng', 'Noto Serif SC', serif;
    margin: 0 0 8px;
    color: var(--ink-main);
  }

  p {
    margin: 0;
    color: var(--ink-sec);
    font-size: 14px;
  }
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-accent);
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);
  white-space: nowrap;
  cursor: pointer;
  font-family: inherit;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.hero-badge:hover {
  transform: translateY(-1px);
  box-shadow: var(--ui-shadow);
}

.upload-card {
  border-radius: 20px;
  border: 2px dashed var(--ui-border);
  padding: 30px;
  min-height: 360px;
  background: var(--card-bg, var(--ui-glass-bg));
  transition: border-color 0.3s ease, transform 0.3s ease;
}

.upload-card:hover {
  border-color: var(--ink-accent);
  background: var(--card-bg-hover, var(--ui-glass-bg-hover));
  transform: translateY(-3px);
}

.upload-card.dragging {
  border-color: var(--ink-accent);
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
}

.file-input {
  display: none;
}

.upload-idle,
.upload-processing,
.upload-success {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.upload-idle {
  flex-direction: column;
  text-align: center;
  gap: 12px;
  cursor: pointer;
}

.icon-circle {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  color: var(--ink-accent);
  font-size: 32px;
  box-shadow: 0 10px 20px color-mix(in srgb, var(--ink-accent) 12%, transparent);
}

.upload-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--ink-main);
}

.upload-hint {
  font-size: 13px;
  color: var(--ink-sec);
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);
  padding: 6px 12px;
  border-radius: 999px;
}

.upload-actions {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}

.upload-tip {
  font-size: 12px;
  color: var(--ink-sec);
}

.upload-processing {
  flex-direction: column;
  gap: 18px;
}

.upload-cancel-btn {
  margin-top: 2px;
}

.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--panel-bg);
  color: var(--ink-sec);
}

.progress-container {
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ink-bar-bg {
  width: 100%;
  height: 8px;
  background: var(--progress-track-bg);
  border-radius: 999px;
  overflow: hidden;
}

.ink-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--ink-accent), color-mix(in srgb, var(--ink-accent) 40%, transparent));
  border-radius: 999px;
  transition: width 0.25s ease-out;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink-sec);
}

.wait-tip {
  opacity: 0;
  transform: translateY(6px);
  transition: all 0.3s ease;
  font-size: 12px;
  color: var(--ink-warning);
  background: var(--state-warning-surface);
  padding: 8px 14px;
  border-radius: 8px;
}

.wait-tip.show {
  opacity: 1;
  transform: translateY(0);
}

.upload-success {
  flex-direction: row;
  gap: 24px;
}

.result-left {
  width: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-radius: 16px;
  background: var(--panel-bg);
  border: 1px solid var(--ui-border);
}

.book-cover-icon {
  width: 110px;
  height: 110px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  color: var(--ink-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  border: 1px solid var(--tag-border);
}

.book-title {
  font-size: 16px;
  font-weight: 600;
}

.book-author {
  font-size: 12px;
  color: var(--ink-sec);
}

.book-progress {
  width: 100%;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink-sec);
}

.result-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.result-desc {
  font-size: 14px;
  color: var(--ink-sec);
}

.data-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.data-item {
  padding: 12px;
  border-radius: 12px;
  background: var(--panel-bg);
  border: 1px solid var(--ui-border);
}

.data-label {
  font-size: 12px;
  color: var(--ink-sec);
}

.data-val {
  font-size: 16px;
  font-weight: 600;
  color: var(--ink-main);

  &.accent {
    color: var(--state-danger);
  }
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-tag {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  color: var(--ink-accent);
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
}

.result-actions {
  display: flex;
  gap: 12px;
}


.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 16px;
  font-weight: 600;
  font-family: 'Noto Serif SC', serif;
}

.section-sub {
  font-size: 12px;
  color: var(--ink-sec);
}














.fade-up-enter-active,
.fade-up-leave-active {
  transition: all 0.3s ease;
}

.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

:deep(.breakdown-history-modal .ew-modal-body) {
  padding: 20px 24px;
}

.history-modal {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.history-summary {
  font-size: 12px;
  color: var(--ink-sec);
}

.history-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 30px 0;
  text-align: center;
  color: var(--ink-sec);
  font-size: 13px;

  i {
    color: var(--ink-accent);
  }
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-item {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--ui-border);
  background: var(--card-bg, var(--ui-glass-bg));
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.history-item:hover {
  border-color: var(--ink-accent);
  box-shadow: var(--card-shadow, 0 10px 20px rgba(0, 0, 0, 0.08));
}

.history-icon {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  color: var(--ink-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  border: 1px solid var(--tag-border);
}

.history-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.title-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-main);
}

.title-meta {
  font-size: 12px;
  color: var(--ink-sec);
}

.history-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--ink-sec);
}

.history-status {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);
  color: var(--ink-sec);
}

.history-status.done {
  color: var(--ink-positive);
}

.history-status.wait {
  color: var(--ink-sec);
}

.history-status.processing {
  color: var(--ink-warning);
}

.history-status.failed {
  color: var(--state-danger);
}

.history-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-sec);
}

.history-action {
  font-size: 12px;
  color: var(--ink-accent);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.history-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.history-delete {
  border: 1px solid var(--tag-border);
  background: var(--tag-bg);
  color: var(--ink-sec);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.history-delete:hover {
  color: var(--ink-accent);
  border-color: color-mix(in srgb, var(--ink-accent) 25%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
}

:global(.ink-confirm) {
  border-radius: 16px;
  border: 1px solid var(--ui-border);
  background: var(--card-bg, var(--ui-glass-bg));
  box-shadow: var(--ui-shadow);
}

:global(.ink-confirm .el-message-box__title) {
  font-size: 14px;
  color: var(--ink-main);
}

:global(.ink-confirm .el-message-box__message) {
  color: var(--ink-sec);
}

:global(.ink-confirm .el-button) {
  border-radius: 999px;
}

@include content-max(920px) {
  .upload-success {
    flex-direction: column;
  }

  .result-left {
    width: 100%;
    flex-direction: row;
    justify-content: flex-start;
    gap: 18px;
  }

}

@include content-max(680px) {
  .hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .upload-card {
    padding: 20px;
  }


  .data-grid {
    grid-template-columns: 1fr;
  }
}

.ai-pending-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--ink-sec);
  text-align: center;
  padding: 40px 20px;

  i {
    font-size: 40px;
    color: var(--ink-muted, var(--ink-sec));
  }

  h2 {
    margin: 0;
    font-size: 22px;
    color: var(--ink-main);
    font-family: var(--font-serif, inherit);
  }

  p {
    margin: 0;
    font-size: 14px;
    line-height: 1.8;
    max-width: 420px;
  }
}
</style>
