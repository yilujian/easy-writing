<template>
  <EwModal
    v-model:visible="visibleProxy"
    title="AI 封面工坊"
    width="min(1280px, 94vw)"
    height="min(860px, 90vh)"
    :close-on-click-modal="true"
    custom-class="ai-create-cover-modal"
  >
    <div class="cover-workshop">
      <aside class="control-panel">
        <div class="mode-tabs" role="tablist" aria-label="封面制作步骤">
          <button
            class="mode-tab"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'gen'"
            :class="{ active: activeTab === 'gen' }"
            @click="activeTab = 'gen'"
          >
            AI 生图配置
          </button>
          <button
            class="mode-tab"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'text'"
            :class="{ active: activeTab === 'text' }"
            @click="activeTab = 'text'"
          >
            文字排版与应用
          </button>
        </div>

        <div class="config-body">
          <AICoverGeneratePanel
            v-if="activeTab === 'gen'"
            v-model:prompt="imageForm.prompt"
            v-model:style="imageForm.style"
            v-model:tone="imageForm.tone"
            v-model:image-model="imageModelOverride"
            :style-options="styleOptions"
            :tone-options="toneOptions"
            :generating="generating"
            :prompt-polishing="promptPolishing"
            @polish="handlePromptPolish"
            @generate="handleGenerate"
          />

          <AICoverLayoutPanel
            v-else
            v-model:selected-book-id="selectedBookId"
            v-model:title-enabled="layoutForm.titleEnabled"
            v-model:author-enabled="layoutForm.authorEnabled"
            v-model:title="layoutForm.title"
            v-model:author="layoutForm.author"
            v-model:font="layoutForm.font"
            v-model:font-size="layoutForm.fontSize"
            v-model:text-color="layoutForm.textColor"
            v-model:vertical="layoutForm.effects.vertical"
            v-model:shadow="layoutForm.effects.shadow"
            v-model:stroke="layoutForm.effects.stroke"
            :book-options="bookOptions"
            :book-loading="bookLoading"
            :font-options="fontOptions"
            :text-color-options="textColorOptions"
            :normalized-text-color="normalizedTextColor"
            @select-color="setTextColor"
            @normalize-color="normalizeTextColorInput"
            @reset="resetLayout"
          />
        </div>
      </aside>

      <section class="preview-panel">
        <div class="preview-stage-label">
          {{ activeTab === 'gen' ? '画面预览' : '排版预览' }}
        </div>

        <div ref="bookRef" class="book-mockup">
          <div class="bg-img" :class="{ loading: generating }" :style="previewStyle">
            <div v-if="generating" class="state-info">
              <i class="fa-solid fa-spinner fa-spin"></i>
              <span>正在生成封面</span>
            </div>
            <div v-else-if="!hasPreview" class="state-info">
              <i class="fa-regular fa-image"></i>
              <span>生成后将在这里预览</span>
            </div>
          </div>

          <div
            v-if="showTitleOverlay"
            ref="titleRef"
            class="text-layer title-layer"
            :class="{ active: activeLayer === 'title' && activeTab === 'text', dragging: draggingLayer === 'title' }"
            :style="titleStyle"
            @mousedown.stop.prevent="startDrag('title', $event)"
          >
            <span class="layer-text">{{ previewTitle }}</span>
            <button
              v-if="activeLayer === 'title' && activeTab === 'text'"
              class="resize-handle"
              type="button"
              aria-label="调整标题框大小"
              @mousedown.stop.prevent="startTitleResize"
            ></button>
          </div>
          <div
            v-if="showAuthorOverlay"
            ref="authorRef"
            class="text-layer author-layer"
            :class="{ active: activeLayer === 'author' && activeTab === 'text', dragging: draggingLayer === 'author' }"
            :style="authorStyle"
            @mousedown.stop.prevent="startDrag('author', $event)"
          >
            {{ previewAuthor }}
          </div>
        </div>

        <div class="preview-mode-hint">
          <i class="fa-solid" :class="activeTab === 'gen' ? 'fa-image' : 'fa-font'"></i>
          <span v-if="activeTab === 'gen'">此处只预览 AI 生成的原图</span>
          <span v-else-if="hasTextOverlay">拖动封面上的文字可调整位置</span>
          <span v-else>当前为纯画面，未叠加标题或作者名</span>
        </div>

        <div class="preview-toolbar">
          <button v-if="activeTab === 'text'" class="tool-btn" type="button" @click="resetLayout">
            <i class="fa-solid fa-rotate-left"></i>
            恢复原图
          </button>
          <button class="tool-btn" type="button" @click="openHistory">
            <i class="fa-regular fa-clock"></i>
            历史
          </button>
          <button class="tool-btn" type="button" :disabled="!hasPreview || downloadingCover" @click="downloadPreview">
            <i v-if="downloadingCover" class="fa-solid fa-spinner fa-spin"></i>
            <i v-else class="fa-solid fa-download"></i>
            下载
          </button>
          <button class="tool-btn" type="button" :disabled="!hasPreview || previewRendering" @click="openMergedPreview">
            <i v-if="previewRendering" class="fa-solid fa-spinner fa-spin"></i>
            <i v-else class="fa-solid fa-eye"></i>
            预览大图
          </button>
          <span class="divider"></span>
          <button
            class="tool-btn apply-btn"
            type="button"
            :disabled="!hasPreview || applying || activeTab !== 'text'"
            @click="handleApply"
          >
            <i v-if="applying" class="fa-solid fa-spinner fa-spin"></i>
            <i v-else class="fa-solid fa-check"></i>
            应用封面
          </button>
        </div>

        <ElImageViewer
          v-if="previewZoomVisible && previewZoomUrl"
          :url-list="[previewZoomUrl]"
          :initial-index="0"
          :z-index="5000"
          hide-on-click-modal
          teleported
          @close="closeMergedPreview"
        />

        <transition name="fade">
          <div v-if="historyVisible" class="history-panel">
            <div class="history-header">
              <div class="history-title">
                <div class="t1">封面记录</div>
                <div class="t2">共 {{ historyTotal || historyList.length }} 张</div>
              </div>
              <button class="icon-btn" type="button" aria-label="关闭封面记录" @click="historyVisible = false">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div class="history-body">
              <div v-if="historyLoading" class="history-empty">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span>加载中...</span>
              </div>
              <div v-else-if="!historyList.length" class="history-empty">
                <i class="fa-regular fa-image"></i>
                <span>暂无封面记录</span>
              </div>
              <div v-else class="history-list">
                <button v-for="item in historyList" :key="item.id" class="history-item" type="button" @click="applyHistory(item)">
                  <div class="history-thumb">
                    <img
                      v-if="item.imageUrl && !brokenThumbs[item.id]"
                      :src="item.imageUrl"
                      alt="封面预览"
                      @error="brokenThumbs[item.id] = true"
                    />
                    <div v-else class="thumb-empty">{{ item.imageUrl ? '图片已失效' : '未生成' }}</div>
                  </div>
                  <div class="history-meta">
                    <div class="meta-title">{{ item.title || '封面生成' }}</div>
                    <div class="meta-time">{{ formatHistoryTime(item.createTime) }}</div>
                    <div v-if="item.errorMsg" class="meta-error">{{ item.errorMsg }}</div>
                  </div>
                </button>
              </div>
            </div>
            <div v-if="historyList.length < historyTotal" class="history-footer">
              <button class="ink-btn ink-btn-outline" type="button" :disabled="historyLoading" @click="loadHistory(false)">
                <i v-if="historyLoading" class="fa-solid fa-spinner fa-spin"></i>
                加载更多
              </button>
            </div>
          </div>
        </transition>
      </section>
    </div>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import dayjs from 'dayjs'
import { ElImageViewer, ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import type { AiImageHistoryItem } from '@/types/ai-image'
import type { Book } from '@/types'
// 开源版：生图/记录/书单/封面回写全走本地（BYOK 图片模型 + IndexedDB）
import {
  generateLocalAiImage as generateAiImageApi,
  getLocalAiImageHistory as getAiImageHistoryApi,
} from '@/storage/local-ai-images'
import {
  queryLocalBookPage as queryBookApi,
  updateLocalBookData as updateBookApi,
} from '@/storage/local-book-bridge'
import { buildCoverPromptEnhanceMessages } from '@/config/ai-prompts'
import { requestLocalChatCompletion } from '@/utils/local-ai-client'
import { useAiModelStore } from '@/stores/ai-model'
import { showApiError } from '@/utils/api-error'
import { saveBlobFile } from '@/utils/download'
import { canDisplayImageDirectly, fetchImageBlob, getImageObjectSource } from '@/utils/image-proxy'
import AICoverGeneratePanel from './ai-cover/AICoverGeneratePanel.vue'
import AICoverLayoutPanel from './ai-cover/AICoverLayoutPanel.vue'
import type {
  CoverChoiceOption,
  CoverFontOption,
  CoverGenerationForm,
  CoverLayoutState,
  CoverTabKey,
} from './ai-cover/types'

const props = defineProps<{
  visible: boolean
  bookId?: number
  bookTitle?: string
  /** Agent 封面方案带进来的画面描述与风格；作者已经填了内容时不覆盖 */
  initialPrompt?: string
  initialStyle?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'apply', payload: { coverUrl: string; layout: CoverLayoutState }): void
}>()


const visibleProxy = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
})

const activeTab = ref<CoverTabKey>('gen')
const generating = ref(false)
const previewUrl = ref('')
const previewZoomVisible = ref(false)
const previewZoomUrl = ref('')
const previewRendering = ref(false)
const activeLayer = ref<'title' | 'author'>('title')
const bookRef = ref<HTMLElement | null>(null)
const titleRef = ref<HTMLElement | null>(null)
const authorRef = ref<HTMLElement | null>(null)
const historyVisible = ref(false)
const historyList = ref<AiImageHistoryItem[]>([])
// 历史缩略图破图标记：加载失败的条目转占位文案（图片链接可能过期失效）
const brokenThumbs = reactive<Record<string | number, boolean>>({})
const historyLoading = ref(false)
const historyPage = ref(1)
const historyTotal = ref(0)
const historySize = 8
const bookOptions = ref<Book[]>([])
const bookLoading = ref(false)
const selectedBookId = ref('')
const promptPolishing = ref(false)
const applying = ref(false)
const downloadingCover = ref(false)
const minTitleBoxSize = { width: 48, height: 56 }
const textLayerPadding = { x: 6, y: 4 }

// 拖动层状态
const dragState = ref<{
  layer: 'title' | 'author'
  offsetX: number
  offsetY: number
  width: number
  height: number
} | null>(null)
const resizeState = ref<{
  startX: number
  startY: number
  startWidth: number
  startHeight: number
} | null>(null)
const hasDragged = reactive({ title: false, author: false })
const hasResized = reactive({ title: false })
const defaultNegativePrompt = '水印, watermark, logo, 标志, 签名, frame, lowres, blurry, deformed, bad anatomy, extra fingers'
const previewBaseSize = { width: 225, height: 400 }
const coverImageSize = '768x1152'

const styleOptions: CoverChoiceOption[] = [
  { label: '自动匹配', value: '' },
  { label: '水墨玄幻', value: '水墨玄幻' },
  { label: '赛博修仙', value: '赛博修仙' },
  { label: '悬疑惊悚', value: '悬疑惊悚' },
  { label: '古言唯美', value: '古言唯美' },
  { label: '都市写实', value: '都市写实' },
  { label: '二次元', value: '二次元' }
]

const toneOptions: CoverChoiceOption[] = [
  { label: '暖色', value: '暖色', color: '#b06935' },
  { label: '冷色', value: '冷色', color: '#2c3e50' },
  { label: '明亮', value: '明亮', color: '#ffffff' },
  { label: '暗黑', value: '暗黑', color: '#1d1e22' },
  { label: '清新', value: '清新', color: '#67c23a' }
]

const fontOptions: CoverFontOption[] = [
  { label: '宋体', value: 'song', family: '"Songti SC", "Noto Serif SC", serif' },
  { label: '黑体', value: 'hei', family: '"PingFang SC", "Noto Sans SC", sans-serif' },
  { label: '楷体', value: 'kai', family: '"Kaiti SC", "STKaiti", serif' },
  { label: '书法', value: 'ma', family: '"Ma Shan Zheng", "Kaiti SC", cursive' }
]

const textColorOptions: CoverChoiceOption[] = [
  { label: '月白', value: '#ffffff', color: '#ffffff' },
  { label: '夜墨', value: '#111111', color: '#111111' },
  { label: '赭石', value: '#b06935', color: '#b06935' },
  { label: '绯红', value: '#d44d4d', color: '#d44d4d' },
  { label: '青蓝', value: '#1677ff', color: '#1677ff' }
]

const getDefaultPositions = (vertical: boolean) => {
  const { width, height } = previewBaseSize
  return {
    title: {
      x: vertical ? Math.round(width * 0.42) : Math.round(width * 0.12),
      y: Math.round(height * 0.12)
    },
    author: {
      x: Math.round(width * 0.38),
      y: Math.round(height * 0.78)
    }
  }
}

const getDefaultTitleBox = (vertical: boolean) => ({
  width: vertical ? 118 : 170,
  height: vertical ? 270 : 118
})

const imageForm = reactive<CoverGenerationForm>({
  prompt: '',
  style: '',
  tone: '',
})

const defaultLayout: CoverLayoutState = {
  titleEnabled: false,
  authorEnabled: false,
  title: '',
  author: '',
  font: fontOptions[0].value,
  fontSize: 40,
  textColor: textColorOptions[0].value,
  titleBox: getDefaultTitleBox(true),
  effects: {
    shadow: true,
    stroke: false,
    vertical: true
  },
  positions: getDefaultPositions(true)
}

const layoutForm = reactive<CoverLayoutState>({
  titleEnabled: defaultLayout.titleEnabled,
  authorEnabled: defaultLayout.authorEnabled,
  title: defaultLayout.title,
  author: defaultLayout.author,
  font: defaultLayout.font,
  fontSize: defaultLayout.fontSize,
  textColor: defaultLayout.textColor,
  titleBox: {
    width: defaultLayout.titleBox.width,
    height: defaultLayout.titleBox.height
  },
  effects: {
    shadow: defaultLayout.effects.shadow,
    stroke: defaultLayout.effects.stroke,
    vertical: defaultLayout.effects.vertical
  },
  positions: getDefaultPositions(defaultLayout.effects.vertical)
})

const compactTitle = (value: string) => String(value || '').replace(/\s+/g, ' ').trim()
const normalizeHexColor = (value: string, fallback = defaultLayout.textColor) => {
  const raw = String(value || '').trim()
  const normalized = raw.startsWith('#') ? raw : `#${raw}`
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    const [, r, g, b] = normalized
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return fallback
}

const activeFont = computed(() => fontOptions.find((item) => item.value === layoutForm.font) ?? fontOptions[0])
const hasPreview = computed(() => Boolean(previewUrl.value))
const previewTitle = computed(() => layoutForm.title.trim() || '请输入标题')
const previewAuthor = computed(() => (layoutForm.author.trim() ? `${layoutForm.author} 著` : '请输入作者名'))
const showTitleOverlay = computed(() => activeTab.value === 'text' && layoutForm.titleEnabled)
const showAuthorOverlay = computed(() => activeTab.value === 'text' && layoutForm.authorEnabled)
const hasTextOverlay = computed(() => layoutForm.titleEnabled || layoutForm.authorEnabled)
const draggingLayer = computed(() => dragState.value?.layer ?? null)
const normalizedTextColor = computed(() => normalizeHexColor(layoutForm.textColor))
const titleLineHeight = computed(() => Math.round(layoutForm.fontSize * 1.18))
const selectedBook = computed(() => bookOptions.value.find((item) => String(item.id) === selectedBookId.value))
const boundBookId = computed(() => {
  const value = Number(selectedBookId.value)
  // 本地书 id 是负数，非零即有效
  return Number.isFinite(value) && value !== 0 ? value : undefined
})
const isBoundToBook = computed(() => Boolean(boundBookId.value))
const recordTitle = computed(() => {
  if (selectedBook.value?.title) return selectedBook.value.title
  return compactTitle(layoutForm.title) || '封面生成'
})
// 本弹窗临时覆盖模型：空值 = 跟随「AI 模型」页的全局默认；选择不回写全局
const imageModelOverride = ref('')

const titleStyle = computed<CSSProperties>(() => ({
  fontFamily: activeFont.value.family,
  fontSize: `${layoutForm.fontSize}px`,
  color: normalizedTextColor.value,
  writingMode: layoutForm.effects.vertical ? 'vertical-rl' : 'horizontal-tb',
  textShadow: layoutForm.effects.shadow ? '0 2px 10px rgba(0, 0, 0, 0.6)' : 'none',
  WebkitTextStroke: layoutForm.effects.stroke ? '1px rgba(0, 0, 0, 0.45)' : 'none',
  left: `${layoutForm.positions.title.x}px`,
  top: `${layoutForm.positions.title.y}px`,
  width: `${layoutForm.titleBox.width}px`,
  height: `${layoutForm.titleBox.height}px`,
  lineHeight: `${titleLineHeight.value}px`,
  textAlign: 'center'
}))

const authorStyle = computed<CSSProperties>(() => ({
  fontFamily: activeFont.value.family,
  color: normalizedTextColor.value,
  fontSize: '14px',
  opacity: '0.85',
  textShadow: layoutForm.effects.shadow ? '0 1px 6px rgba(0, 0, 0, 0.45)' : 'none',
  WebkitTextStroke: layoutForm.effects.stroke ? '0.6px rgba(0, 0, 0, 0.35)' : 'none',
  left: `${layoutForm.positions.author.x}px`,
  top: `${layoutForm.positions.author.y}px`
}))

// 预览背景实际使用的地址：第三方图床地址在桌面端会被 CSP img-src 拦截，
// 需经代理取回 blob 再用 objectURL；平台域/data:/blob: 直接使用。
const previewDisplayUrl = ref('')
let previewObjectUrl = ''
let previewLoadSeq = 0

const releasePreviewObjectUrl = () => {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl)
    previewObjectUrl = ''
  }
}

watch(previewUrl, async (url) => {
  const seq = ++previewLoadSeq
  releasePreviewObjectUrl()
  previewDisplayUrl.value = ''
  if (!url) return
  if (canDisplayImageDirectly(url)) {
    previewDisplayUrl.value = url
    return
  }
  try {
    const blob = await fetchImageBlob(url)
    if (seq !== previewLoadSeq) return
    previewObjectUrl = URL.createObjectURL(blob)
    previewDisplayUrl.value = previewObjectUrl
  } catch (error) {
    console.error('load cover preview failed', error)
    // 兜底回退原始地址（网页端可能仍可展示；桌面端将由 CSP 拦截为空白）
    if (seq === previewLoadSeq) {
      previewDisplayUrl.value = url
    }
  }
})

const previewStyle = computed<CSSProperties>(() => ({
  backgroundImage: previewDisplayUrl.value ? `url(${previewDisplayUrl.value})` : 'none'
}))

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const setTextColor = (color: string) => {
  layoutForm.textColor = normalizeHexColor(color)
}

const normalizeTextColorInput = () => {
  layoutForm.textColor = normalizedTextColor.value
}

const updateLayerPosition = (layer: 'title' | 'author', left: number, top: number) => {
  if (layer === 'title') {
    layoutForm.positions.title.x = left
    layoutForm.positions.title.y = top
  } else {
    layoutForm.positions.author.x = left
    layoutForm.positions.author.y = top
  }
}

const handleDragMove = (event: MouseEvent) => {
  if (!dragState.value || !bookRef.value) return
  const { layer, offsetX, offsetY, width, height } = dragState.value
  const bookRect = bookRef.value.getBoundingClientRect()
  const maxLeft = Math.max(0, bookRect.width - width)
  const maxTop = Math.max(0, bookRect.height - height)
  const nextLeft = clamp(event.clientX - bookRect.left - offsetX, 0, maxLeft)
  const nextTop = clamp(event.clientY - bookRect.top - offsetY, 0, maxTop)
  updateLayerPosition(layer, Math.round(nextLeft), Math.round(nextTop))
}

const stopDrag = () => {
  if (!dragState.value) return
  dragState.value = null
  window.removeEventListener('mousemove', handleDragMove)
  window.removeEventListener('mouseup', stopDrag)
}

const startDrag = (layer: 'title' | 'author', event: MouseEvent) => {
  if (activeTab.value !== 'text') return
  if (layer === 'title' && !layoutForm.titleEnabled) return
  if (layer === 'author' && !layoutForm.authorEnabled) return
  stopDrag()
  stopTitleResize()
  const target = layer === 'title' ? titleRef.value : authorRef.value
  if (!bookRef.value || !target) return
  const targetRect = target.getBoundingClientRect()
  dragState.value = {
    layer,
    offsetX: event.clientX - targetRect.left,
    offsetY: event.clientY - targetRect.top,
    width: targetRect.width,
    height: targetRect.height
  }
  activeLayer.value = layer
  hasDragged[layer] = true
  window.addEventListener('mousemove', handleDragMove)
  window.addEventListener('mouseup', stopDrag)
}

const updateTitleBoxSize = (width: number, height: number) => {
  const maxWidth = Math.max(minTitleBoxSize.width, previewBaseSize.width - layoutForm.positions.title.x)
  const maxHeight = Math.max(minTitleBoxSize.height, previewBaseSize.height - layoutForm.positions.title.y)
  layoutForm.titleBox.width = Math.round(clamp(width, minTitleBoxSize.width, maxWidth))
  layoutForm.titleBox.height = Math.round(clamp(height, minTitleBoxSize.height, maxHeight))
}

const handleTitleResizeMove = (event: MouseEvent) => {
  if (!resizeState.value) return
  const nextWidth = resizeState.value.startWidth + event.clientX - resizeState.value.startX
  const nextHeight = resizeState.value.startHeight + event.clientY - resizeState.value.startY
  updateTitleBoxSize(nextWidth, nextHeight)
}

const stopTitleResize = () => {
  if (!resizeState.value) return
  resizeState.value = null
  window.removeEventListener('mousemove', handleTitleResizeMove)
  window.removeEventListener('mouseup', stopTitleResize)
}

const startTitleResize = (event: MouseEvent) => {
  if (activeTab.value !== 'text' || !layoutForm.titleEnabled) return
  stopDrag()
  stopTitleResize()
  activeLayer.value = 'title'
  hasResized.title = true
  resizeState.value = {
    startX: event.clientX,
    startY: event.clientY,
    startWidth: layoutForm.titleBox.width,
    startHeight: layoutForm.titleBox.height
  }
  window.addEventListener('mousemove', handleTitleResizeMove)
  window.addEventListener('mouseup', stopTitleResize)
}

const buildCoverPrompt = () => {
  const base = imageForm.prompt.trim()
  if (!base) return ''
  const tone = toneOptions.find((item) => item.value === imageForm.tone)?.label || ''
  const style = imageForm.style?.trim() || ''
  const segments = [base]
  if (style && !base.includes(style)) {
    segments.push(`${style}风格`)
  }
  if (tone && !base.includes(tone)) {
    segments.push(`${tone}色调`)
  }
  return segments.join('，')
}

const handlePromptPolish = async () => {
  if (promptPolishing.value) return
  const prompt = imageForm.prompt.trim()
  if (!prompt) {
    ElMessage.warning('请先输入画面描述')
    return
  }
  promptPolishing.value = true
  try {
    // 已绑定书籍时带上书名与题材：润色画面描述能贴合本书调性
    const boundBook = bookOptions.value.find(book => Number(book.id) === Number(boundBookId.value))
    const modelCode = await useAiModelStore().ensureTextModel()
    if (!modelCode) throw new Error('还没有可用的文本模型，请先到「模型管理」添加')
    const data = await requestLocalChatCompletion({
      scene: 'cover_prompt_polish',
      sceneLabel: '封面描述润色',
      modelCode,
      messages: buildCoverPromptEnhanceMessages({
        prompt,
        style: imageForm.style || '自动匹配',
        tone: imageForm.tone || '自动匹配',
        bookInfo: boundBook ? `《${boundBook.title}》${boundBook.category || ''}` : '',
      }),
    })
    const nextPrompt = String(data || '').trim()
    if (!nextPrompt) {
      throw new Error('AI 暂无返回内容')
    }
    imageForm.prompt = nextPrompt.slice(0, 200)
    ElMessage.success('已完成润色')
  } catch (error) {
    showApiError(error, '润色失败')
  } finally {
    promptPolishing.value = false
  }
}

// 取图逻辑统一收敛到 utils/image-proxy：平台域直取，第三方经服务端代理
const getCanvasImageSource = (url: string) => getImageObjectSource(url)

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    if (!url.startsWith('data:') && !url.startsWith('blob:')) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })

type DrawTextBoxOptions = {
  width: number
  height: number
  fontSize: number
  fontFamily: string
  color: string
  vertical?: boolean
  shadow?: boolean
  stroke?: boolean
  opacity?: number
  lineHeight?: number
  shadowBlur?: number
  shadowOffsetY?: number
  fontWeight?: number | string
  letterSpacing?: number
  align?: 'left' | 'center'
}

const measureLineWidth = (ctx: CanvasRenderingContext2D, text: string, letterSpacing: number) => {
  const chars = [...text]
  if (!chars.length) return 0
  return chars.reduce((total, char, index) => {
    return total + ctx.measureText(char).width + (index < chars.length - 1 ? letterSpacing : 0)
  }, 0)
}

const drawCanvasLine = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: Pick<DrawTextBoxOptions, 'stroke' | 'letterSpacing'>
) => {
  let cursorX = x
  const chars = [...text]
  chars.forEach((char, index) => {
    if (options.stroke) ctx.strokeText(char, cursorX, y)
    ctx.fillText(char, cursorX, y)
    cursorX += ctx.measureText(char).width + (index < chars.length - 1 ? options.letterSpacing || 0 : 0)
  })
}

const wrapHorizontalText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number
) => {
  const lines: string[] = []
  text.replace(/\r\n/g, '\n').split('\n').forEach((paragraph) => {
    if (!paragraph) {
      lines.push('')
      return
    }
    let current = ''
    let currentWidth = 0
    ;[...paragraph].forEach((char) => {
      const charWidth = ctx.measureText(char).width
      const nextWidth = currentWidth + charWidth + (current ? letterSpacing : 0)
      if (current && nextWidth > maxWidth) {
        lines.push(current)
        current = char
        currentWidth = charWidth
        return
      }
      current += char
      currentWidth = nextWidth
    })
    lines.push(current)
  })
  return lines
}

const buildVerticalColumns = (text: string, maxCharsPerColumn: number) => {
  const columns: string[][] = [[]]
  const pushColumn = () => {
    if (columns[columns.length - 1].length) {
      columns.push([])
    }
  }

  text.replace(/\r\n/g, '\n').split('\n').forEach((paragraph, paragraphIndex, paragraphs) => {
    ;[...paragraph].forEach((char) => {
      const current = columns[columns.length - 1]
      if (current.length >= maxCharsPerColumn) {
        columns.push([char])
        return
      }
      current.push(char)
    })
    if (paragraphIndex < paragraphs.length - 1) {
      pushColumn()
    }
  })

  return columns.filter((column, index) => column.length || index === 0)
}

const drawTextBox = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: DrawTextBoxOptions
) => {
  if (!text || options.width <= 0 || options.height <= 0) return
  ctx.save()
  ctx.font = `${options.fontWeight || 400} ${options.fontSize}px ${options.fontFamily}`
  ctx.fillStyle = options.color
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.globalAlpha = options.opacity ?? 1
  if (options.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
    ctx.shadowBlur = options.shadowBlur || 0
    ctx.shadowOffsetY = options.shadowOffsetY || 0
  }
  if (options.stroke) {
    ctx.lineWidth = Math.max(1, options.fontSize * 0.04)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
  }

  const lineHeight = options.lineHeight || options.fontSize * 1.2
  const letterSpacing = options.letterSpacing || 0
  if (options.vertical) {
    const maxCharsPerColumn = Math.max(1, Math.floor(options.height / lineHeight))
    const maxColumns = Math.max(1, Math.floor(options.width / lineHeight))
    const columns = buildVerticalColumns(text, maxCharsPerColumn).slice(0, maxColumns)
    columns.forEach((column, columnIndex) => {
      const columnX = x + options.width - options.fontSize - columnIndex * lineHeight
      column.forEach((char, charIndex) => {
        const charY = y + charIndex * lineHeight
        if (options.stroke) ctx.strokeText(char, columnX, charY)
        ctx.fillText(char, columnX, charY)
      })
    })
    ctx.restore()
    return
  }

  const lines = wrapHorizontalText(ctx, text, options.width, letterSpacing)
  const maxLines = Math.max(1, Math.floor(options.height / lineHeight))
  lines.slice(0, maxLines).forEach((line, index) => {
    const lineWidth = measureLineWidth(ctx, line, letterSpacing)
    const lineX = options.align === 'center' ? x + Math.max(0, (options.width - lineWidth) / 2) : x
    drawCanvasLine(ctx, line, lineX, y + index * lineHeight, {
      stroke: options.stroke,
      letterSpacing
    })
  })
  ctx.restore()
}

const renderCoverToDataUrl = async () => {
  if (!previewUrl.value) return ''
  let source: { url: string; revoke: boolean } | null = null
  try {
    await document.fonts?.ready
    source = await getCanvasImageSource(previewUrl.value)
    const image = await loadImage(source.url)
    const width = image.naturalWidth || previewBaseSize.width
    const height = image.naturalHeight || previewBaseSize.height
    const outputWidth = width
    const outputHeight = Math.round(outputWidth * (previewBaseSize.height / previewBaseSize.width)) || height
    const canvas = document.createElement('canvas')
    canvas.width = outputWidth
    canvas.height = outputHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''

    const scale = Math.max(outputWidth / width, outputHeight / height)
    const drawWidth = width * scale
    const drawHeight = height * scale
    const offsetX = (outputWidth - drawWidth) / 2
    const offsetY = (outputHeight - drawHeight) / 2
    ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)

    const textScale = outputWidth / previewBaseSize.width
    const fontFamily = activeFont.value.family
    // 只有用户明确开启的文字层才写入最终图片，纯画面不会被默认标题或作者污染。
    if (layoutForm.titleEnabled && layoutForm.title.trim()) {
      const titleX = (layoutForm.positions.title.x + textLayerPadding.x) * textScale
      const titleY = (layoutForm.positions.title.y + textLayerPadding.y) * textScale
      const titleWidth = Math.max(0, (layoutForm.titleBox.width - textLayerPadding.x * 2) * textScale)
      const titleHeight = Math.max(0, (layoutForm.titleBox.height - textLayerPadding.y * 2) * textScale)
      drawTextBox(ctx, layoutForm.title.trim(), titleX, titleY, {
        width: titleWidth,
        height: titleHeight,
        fontSize: layoutForm.fontSize * textScale,
        fontFamily,
        fontWeight: 700,
        color: normalizedTextColor.value,
        vertical: layoutForm.effects.vertical,
        shadow: layoutForm.effects.shadow,
        stroke: layoutForm.effects.stroke,
        lineHeight: titleLineHeight.value * textScale,
        letterSpacing: layoutForm.fontSize * textScale * 0.08,
        align: 'center',
        shadowBlur: 10 * textScale,
        shadowOffsetY: 2 * textScale
      })
    }

    if (layoutForm.authorEnabled && layoutForm.author.trim()) {
      drawTextBox(ctx, `${layoutForm.author.trim()} 著`, layoutForm.positions.author.x * textScale, layoutForm.positions.author.y * textScale, {
        width: Math.max(20, (previewBaseSize.width - layoutForm.positions.author.x - textLayerPadding.x) * textScale),
        height: 26 * textScale,
        fontSize: 14 * textScale,
        fontFamily,
        fontWeight: 500,
        color: normalizedTextColor.value,
        shadow: layoutForm.effects.shadow,
        stroke: layoutForm.effects.stroke,
        opacity: 0.85,
        lineHeight: 18 * textScale,
        shadowBlur: 6 * textScale,
        shadowOffsetY: 1 * textScale
      })
    }

    return canvas.toDataURL('image/png')
  } catch (error) {
    console.error('render cover failed', error)
    return ''
  } finally {
    try {
      if (source?.revoke && source.url.startsWith('blob:')) {
        URL.revokeObjectURL(source.url)
      }
    } catch {
      // ignore
    }
  }
}

const buildCoverImageUrl = async () => {
  const dataUrl = await renderCoverToDataUrl()
  if (!dataUrl) {
    throw new Error('封面合成失败')
  }
  return dataUrl
}

const closeMergedPreview = () => {
  previewZoomVisible.value = false
  previewZoomUrl.value = ''
}

const openMergedPreview = async () => {
  if (!previewUrl.value || previewRendering.value) return
  previewRendering.value = true
  try {
    previewZoomUrl.value = await buildCoverImageUrl()
    previewZoomVisible.value = true
  } catch (error) {
    showApiError(error, '预览失败')
  } finally {
    previewRendering.value = false
  }
}

const handleGenerate = async () => {
  if (generating.value) return
  const prompt = buildCoverPrompt()
  if (!prompt) {
    ElMessage.warning('请填写画面描述')
    return
  }
  generating.value = true
  previewUrl.value = ''
  try {
    const { data } = await generateAiImageApi({
      scene: 'cover',
      bookId: boundBookId.value,
      title: recordTitle.value,
      prompt,
      negativePrompt: defaultNegativePrompt,
      style: imageForm.style || undefined,
      size: coverImageSize,
      // 仅在弹窗临时选了模型时显式携带；空值由服务端按「全局默认 → 平台默认」解析
      model: imageModelOverride.value || undefined
    })
    const imageUrl = data?.imageUrl || ''
    if (!imageUrl) {
      throw new Error('图片生成失败')
    }
    previewUrl.value = imageUrl
    activeTab.value = 'text'
    if (historyVisible.value) {
      await loadHistory(true)
    }
  } catch (error) {
    showApiError(error, '生成失败')
  } finally {
    generating.value = false
  }
}

const loadBooks = async () => {
  if (bookLoading.value) return
  bookLoading.value = true
  try {
    const { data } = await queryBookApi({ page: 1, size: 100 })
    bookOptions.value = Array.isArray(data?.list) ? data.list : []
  } catch (error) {
    console.error('load books failed', error)
  } finally {
    bookLoading.value = false
  }
}

const resetLayout = () => {
  layoutForm.titleEnabled = false
  layoutForm.authorEnabled = false
  layoutForm.font = defaultLayout.font
  layoutForm.fontSize = defaultLayout.fontSize
  layoutForm.textColor = defaultLayout.textColor
  layoutForm.effects.shadow = defaultLayout.effects.shadow
  layoutForm.effects.stroke = defaultLayout.effects.stroke
  layoutForm.effects.vertical = defaultLayout.effects.vertical
  const defaultPositions = getDefaultPositions(layoutForm.effects.vertical)
  const defaultBox = getDefaultTitleBox(layoutForm.effects.vertical)
  layoutForm.positions.title.x = defaultPositions.title.x
  layoutForm.positions.title.y = defaultPositions.title.y
  layoutForm.positions.author.x = defaultPositions.author.x
  layoutForm.positions.author.y = defaultPositions.author.y
  layoutForm.titleBox.width = defaultBox.width
  layoutForm.titleBox.height = defaultBox.height
  hasDragged.title = false
  hasDragged.author = false
  hasResized.title = false
  activeLayer.value = 'title'
}

const handleApply = async () => {
  if (!previewUrl.value) {
    ElMessage.warning('请先生成封面')
    return
  }
  if (applying.value) return
  applying.value = true
  try {
    const dataUrl = await buildCoverImageUrl()
    const mergedUrl = await uploadMergedCover(dataUrl)
    if (isBoundToBook.value && boundBookId.value) {
      await updateBookApi({ id: boundBookId.value, coverUrl: mergedUrl })
      ElMessage.success('封面已应用到书籍')
    } else {
      ElMessage.success('封面已应用')
    }
    emit('apply', {
      coverUrl: mergedUrl,
      layout: layoutForm
    })
  } catch (error) {
    showApiError(error, '封面应用失败')
  } finally {
    applying.value = false
  }
}

const formatHistoryTime = (value?: string) => {
  if (!value) return '--'
  const date = dayjs(value)
  if (!date.isValid()) return value
  return date.format('MM/DD HH:mm')
}

const loadHistory = async (reset = true) => {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    const nextPage = reset ? 1 : historyPage.value + 1
    const { data } = await getAiImageHistoryApi({
      scene: 'cover',
      page: nextPage,
      size: historySize
    })
    const list = Array.isArray(data?.list) ? data.list : []
    historyTotal.value = Number(data?.pagination?.total || 0)
    historyPage.value = Number(data?.pagination?.page || nextPage)
    historyList.value = reset ? list : [...historyList.value, ...list]
  } catch (error) {
    console.error('load cover history failed', error)
  } finally {
    historyLoading.value = false
  }
}

const openHistory = () => {
  closeMergedPreview()
  historyVisible.value = !historyVisible.value
  if (historyVisible.value) {
    loadHistory(true)
  }
}

const applyHistory = (item: AiImageHistoryItem) => {
  if (!item?.imageUrl) return
  previewUrl.value = item.imageUrl
  activeTab.value = 'text'
  historyVisible.value = false
}

const safeFilename = (name: string) => String(name || 'cover').replace(/[\\/:*?"<>|]/g, '_')

const dataUrlToFile = (dataUrl: string, filename: string) => {
  const [meta, content] = dataUrl.split(',')
  if (!meta || !content) {
    throw new Error('封面合成失败')
  }
  const match = /data:(.*?);base64/.exec(meta)
  const mime = match?.[1] || 'image/png'
  const binary = atob(content)
  const len = binary.length
  const buffer = new Uint8Array(len)
  for (let i = 0; i < len; i += 1) {
    buffer[i] = binary.charCodeAt(i)
  }
  return new File([buffer], filename, { type: mime })
}

// 开源版没有图床：合成后的封面直接以 data URL 形式回写书籍 coverUrl（全本地展示）
const uploadMergedCover = async (dataUrl: string) => dataUrl

const downloadPreview = async () => {
  if (!previewUrl.value || downloadingCover.value) return
  downloadingCover.value = true
  try {
    const dataUrl = await buildCoverImageUrl()
    const date = dayjs().format('YYYYMMDD')
    const filename = safeFilename(`${recordTitle.value || 'cover'}-${date}.png`)
    const saved = await saveBlobFile(dataUrlToFile(dataUrl, filename), filename)
    if (saved) {
      ElMessage.success('下载成功')
    }
  } catch (error) {
    console.error('download cover failed', error)
    showApiError(error, '下载失败')
  } finally {
    downloadingCover.value = false
  }
}

onBeforeUnmount(() => {
  stopDrag()
  stopTitleResize()
  releasePreviewObjectUrl()
})

watch(
  () => props.visible,
  (val) => {
    if (val) {
      loadBooks()
      const nickname = '创作者'
      if (nickname && !layoutForm.author) {
        layoutForm.author = nickname
      }
      if (props.bookId && !selectedBookId.value) {
        selectedBookId.value = String(props.bookId)
      }
      if (props.initialPrompt && !imageForm.prompt.trim()) {
        imageForm.prompt = props.initialPrompt
      }
      if (props.initialStyle && !imageForm.style && styleOptions.some(option => option.value === props.initialStyle)) {
        imageForm.style = props.initialStyle
      }
      if (!selectedBookId.value && props.bookTitle) {
        const title = props.bookTitle.trim()
        if (title && !layoutForm.title) {
          layoutForm.title = title
        }
      }
    }
    if (!val) {
      closeMergedPreview()
      generating.value = false
      stopDrag()
      stopTitleResize()
      historyVisible.value = false
    }
  }
)

watch(selectedBook, (book) => {
  if (book?.title) {
    layoutForm.title = book.title
  }
})

watch(
  () => layoutForm.titleEnabled,
  (enabled) => {
    if (enabled) activeLayer.value = 'title'
    else if (layoutForm.authorEnabled) activeLayer.value = 'author'
  }
)

watch(
  () => layoutForm.authorEnabled,
  (enabled) => {
    if (enabled && !layoutForm.titleEnabled) activeLayer.value = 'author'
    else if (!enabled) activeLayer.value = 'title'
  }
)

watch(
  () => layoutForm.effects.vertical,
  (vertical) => {
    const defaults = getDefaultPositions(vertical)
    const defaultBox = getDefaultTitleBox(vertical)
    if (!hasDragged.title) {
      layoutForm.positions.title.x = defaults.title.x
      layoutForm.positions.title.y = defaults.title.y
    }
    if (!hasResized.title) {
      layoutForm.titleBox.width = defaultBox.width
      layoutForm.titleBox.height = defaultBox.height
    }
    updateTitleBoxSize(layoutForm.titleBox.width, layoutForm.titleBox.height)
    if (!hasDragged.author) {
      layoutForm.positions.author.x = defaults.author.x
      layoutForm.positions.author.y = defaults.author.y
    }
  }
)
</script>

<style scoped lang="scss">
:deep(.ai-create-cover-modal .ew-modal-body) {
  padding: 0 !important;
  overflow: hidden;
}

.cover-workshop {
  display: flex;
  height: 100%;
  min-height: 600px;
  background: color-mix(in srgb, var(--bg-main) 76%, var(--ui-glass-bg));
  color: var(--ink-main);
}

.control-panel {
  width: 460px;
  min-width: 460px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-glass-bg) 88%, var(--bg-main));
}

.mode-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-bottom: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--panel-header-bg) 74%, transparent);
}

.mode-tab {
  position: relative;
  min-height: 54px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--ink-sec);
  font-family: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: pointer;

  &:hover {
    color: var(--ink-main);
  }

  &.active {
    color: var(--ink-accent);
    font-weight: 600;
  }

  &.active::after {
    content: '';
    position: absolute;
    right: 26%;
    bottom: 0;
    left: 26%;
    height: 3px;
    border-radius: 999px 999px 0 0;
    background: var(--ink-accent);
  }
}

.config-body {
  flex: 1;
  min-height: 0;
  padding: 20px 22px 24px;
  overflow-y: auto;
}

.preview-panel {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--bg-main) 86%, var(--ui-glass-bg));
  background-image: radial-gradient(color-mix(in srgb, var(--ui-border) 72%, transparent) 1px, transparent 1px);
  background-size: 24px 24px;
}

.preview-stage-label {
  position: absolute;
  top: 20px;
  left: 22px;
  padding: 5px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-glass-bg) 88%, transparent);
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  backdrop-filter: blur(10px);
}

.book-mockup {
  position: relative;
  width: 225px;
  height: 400px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-border) 78%, transparent);
  border-radius: 3px 8px 8px 3px;
  background: var(--input-bg);
  box-shadow: 0 24px 56px rgba(0, 0, 0, 0.2), -5px 0 10px rgba(0, 0, 0, 0.06);
}

.bg-img {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--input-bg);
  background-position: center;
  background-size: cover;
  color: var(--ink-sec);
  transition: opacity 0.2s ease;

  &.loading {
    opacity: 0.72;
  }
}

.state-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 16px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: center;

  i {
    font-size: calc(18px * var(--ui-font-scale, 1));
  }
}

.text-layer {
  position: absolute;
  z-index: 2;
  box-sizing: border-box;
  padding: 4px 6px;
  overflow: hidden;
  border: 1px dashed transparent;
  cursor: grab;
  line-height: 1.2;
  user-select: none;
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;

  &.active {
    border-color: var(--ink-accent);
    background: var(--overlay-active);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink-accent) 18%, transparent);
  }

  &.dragging {
    cursor: grabbing;
  }
}

.title-layer {
  font-weight: 700;
  letter-spacing: 0.08em;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
  text-orientation: mixed;
}

.author-layer {
  font-weight: 500;
  white-space: nowrap;
}

.layer-text {
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 11px;
  height: 11px;
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 50%;
  background: var(--ink-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
  cursor: nwse-resize;
  writing-mode: horizontal-tb;
}

.preview-mode-hint {
  position: absolute;
  bottom: 78px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: calc(100% - 36px);
  padding: 6px 11px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-glass-bg) 90%, transparent);
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
  transform: translateX(-50%);
  backdrop-filter: blur(10px);

  i {
    color: var(--ink-accent);
  }
}

.preview-toolbar {
  position: absolute;
  bottom: 24px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-glass-bg) 92%, transparent);
  box-shadow: var(--ui-shadow);
  transform: translateX(-50%);
  backdrop-filter: blur(14px);
  white-space: nowrap;
}

.tool-btn {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-sec);
  font-family: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--btn-ghost-bg);
    color: var(--ink-main);
  }

  &:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }
}

.divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--ui-border);
}

.apply-btn {
  color: var(--ink-accent);
  font-weight: 600;

  &:not(:disabled) {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  }
}

.history-panel {
  position: absolute;
  z-index: 4;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: 306px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--ui-glass-bg) 96%, var(--bg-main));
  box-shadow: var(--ui-shadow);
  backdrop-filter: blur(16px);
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 14px;
  border-bottom: 1px solid var(--ui-border);
}

.history-title {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .t1 {
    color: var(--ink-main);
    font-weight: 700;
  }

  .t2 {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;

  &:hover {
    background: var(--btn-ghost-bg);
    color: var(--ink-main);
  }
}

.history-body {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}

.history-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.history-item {
  width: 100%;
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--input-bg);
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: var(--ink-accent);
    background: var(--input-focus-bg);
  }
}

.history-thumb {
  width: 62px;
  height: 74px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--panel-bg);

  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }
}

.thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  text-align: center;
}

.history-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.meta-title {
  overflow: hidden;
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-time {
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.meta-error {
  max-height: 32px;
  overflow: hidden;
  color: var(--state-danger);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.35;
}

.history-footer {
  display: flex;
  justify-content: center;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--ui-border);
}

@media (max-width: 920px) {
  .cover-workshop {
    min-height: 0;
    flex-direction: column;
  }

  .control-panel {
    width: 100%;
    min-width: 0;
    max-height: 54%;
    border-right: none;
    border-bottom: 1px solid var(--ui-border);
  }

  .preview-panel {
    min-height: 340px;
    padding: 24px 0 116px;
  }

  .book-mockup {
    width: 180px;
    height: 320px;
    transform: scale(0.88);
  }

  .preview-mode-hint {
    bottom: 68px;
  }

  .preview-toolbar {
    bottom: 16px;
    max-width: calc(100% - 20px);
    overflow-x: auto;
  }

  .history-panel {
    width: min(92vw, 320px);
    right: auto;
    left: 50%;
    transform: translateX(-50%);
  }
}

@media (max-width: 620px) {
  .mode-tab {
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  .config-body {
    padding: 16px;
  }

  .preview-stage-label {
    display: none;
  }

  .tool-btn {
    padding: 0 6px;
  }
}
</style>
