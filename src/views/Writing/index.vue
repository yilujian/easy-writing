<template>
  <div class="writing-page">
    <!-- 背景层 -->
    <div class="ink-bg-container">
      <img :src="themeStore.currentSkinObj.img" class="ink-bg-image" alt="" @error="(e) => ((e.target as HTMLElement).style.visibility = 'hidden')">
    </div>
    <div class="paper-texture"></div>

    <!-- 主体应用容器 -->
    <div class="app-container">
      <!-- 顶部导航栏 -->
      <WritingHeader
:book-title="bookData.title" :book-tags="bookData.tags" :chapter-words="bookData.chapterWords"
        :total-words="bookData.totalWords" :text-total-words="bookData.textTotalWords" :workflow-mode="isWorkflowPageMode" @request-exit="handleWorkflowExit" />

      <!-- 中间主体布局 -->
      <div class="main-layout">
        <!-- 左侧边栏 -->
        <WritingSidebar
          @catalog-loading="catalogLoading = $event"
          :before-switch-chapter="handleBeforeSwitchChapter"

          :workflow-mode="isWorkflowPageMode"
          :workflow-run-id="isWorkflowAutoGen ? workflowRunId : 0"
          :workflow-task-id="isWorkflowAutoGen ? workflowTaskId : 0"
          :workflow-structure-locked="workflowStructureLocked"
          :workflow-restore-pending="workflowTaskStatusPending"
          :workflow-restore-locked-chapter-id="workflowRestoreLockedChapterId"
          :workflow-stopped="workflowControlState === 'stopped'"
        />

        <!-- 中间编辑器 -->
        <WritingEditor
          ref="writingEditorRef"
          :book-id="bookData.id"
          :entity-highlights="entityHighlights"
          :issue-highlights="issueHighlightItems"
          :workflow-mode="isWorkflowPageMode"
          :workflow-locked="workflowCurrentChapterLocked"

          :booting="isBooting"
          @issue-selected="handleIssueSelected"
          @issue-polished="handleIssuePolished"
        />

        <!-- 工作流模式使用右缘图标工具栏＋展开面板，普通编辑模式保留原工具栏。 -->
        <WorkflowSideRail
          v-if="isWorkflowPageMode"
          :book-id="bookData.id"
          :run="workflowRun"
          :state="workflowEntryError ? 'unavailable' : workflowControlState"
          :task="workflowTask"
          :logs="workflowLogs"
          :stage-text="workflowStageText"
          :writing-scene="workflowWritingScene"
          :action-pending="workflowControlPending || workflowResumePreparing"
          :config-saving="workflowConfigUpdating"
          :has-content="workflowHasContent"
          :workflow-run-id="isWorkflowAutoGen ? workflowRunId : 0"
          :workflow-task-id="isWorkflowAutoGen ? workflowTaskId : 0"
          :dismissed-issue-keys="dismissedIssueKeys"
          :active-issue-key="activeIssueKey"
          :polished-issue-keys="polishedIssueKeys"
          @lore-updated="handleLoreUpdated"
          @pause="pauseWorkflowGeneration"
          @resume="handleWorkflowResume"
          @stop="stopWorkflowGeneration"
          @review="handleWorkflowReview"
          @plot-outline-review="handleWorkflowPlotOutlineReview"
          @edit-review="focusWorkflowReviewEditor"
          @update-config="updateWorkflowRuntimeConfig"
          @locate-issue="handleLocateIssue"
          @dismiss-issue="handleDismissIssue"
          @restore-dismissed-issues="handleRestoreDismissedIssues"
          @polish-issue="handlePolishIssue"
        />
        <WritingRightPanel
          v-else
          :book-id="bookData.id"
          :book-title="bookData.title"

          @lore-updated="handleLoreUpdated"
        />
      </div>
    </div>

    <!-- 自爆模式三层遮罩传送到 body：写作页挂在 MainLayout 的 .app-container（z-index: 10）里，
         这里的 99999 只在那个层叠上下文内有效，出不去；工具栏弹层（SmartPopover）本来就传送到 body、
         z-index 2000，会压在遮罩上面。传送出去后三层与弹层同级，按自身 z-index 正常盖住一切。 -->
    <Teleport to="body">
      <div v-if="!workflowSafetyLocked" class="explosion-layer" ref="explosionLayerRef" :class="{ active: isExploded }">
        <div ref="flashRef" class="flash-bang"></div>
      </div>
    </Teleport>

    <!-- 爆炸后警示文字 -->
    <Teleport to="body">
      <div v-if="!workflowSafetyLocked" class="post-blast-msg" v-show="showPostBlastMsg">
        <span class="msg-text">{{ postBlastMessage }}</span><span class="cursor-blink"></span>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="!workflowSafetyLocked" class="warning-overlay" :class="{ show: isWarning }">
        <div class="warning-title">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <div>系统即将自毁</div>
        </div>
        <div class="countdown-text">{{ countdownValue }}</div>
        <div class="warning-tips">
          快写点什么！！！
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { calcLocalBookStats } from '@/storage/local-library-utils'
import type { JsonRecord } from '@/types/json'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useThemeStore } from '@/stores/theme'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { storeToRefs } from 'pinia'
import WritingHeader from './components/WritingHeader.vue'
import WritingSidebar from './components/WritingSidebar.vue'
import WritingEditor from './components/WritingEditor.vue'
import WritingRightPanel from './components/WritingRightPanel.vue'
// 工作流侧栏已换为右缘图标工具栏形态；旧 WorkflowWritingSidePanel 文件保留备回退。
import WorkflowSideRail from './components/workflow-rail/WorkflowSideRail.vue'
import { getLocalLibraryStorage, isLocalEntityId } from '@/storage/local-library'
import type { WorkflowQualityIssue, WorkflowTask } from '@/types/workflow'
// 开源版：工作流状态与段落润色全部走本地引擎
import {
  getLocalWorkflowInfo as getWorkflowInfoApi,
  getLocalWorkflowTaskStatus as getWorkflowTaskStatusApi,
} from '@/storage/local-workflow'
import { polishLocalWorkflowParagraph as polishWorkflowParagraphApi } from '@/utils/local-workflow-control'
import {
  listLocalCharacters,
  getLocalWorldSettingTree,
} from '@/storage/local-reference'
import type { Book, Character, WorldSetting, WorldSettingTreeFolder } from '@/types'
import type { EntityHighlightItem } from './extends/EntityHighlightExtension'
import type { IssueHighlightItem } from './extends/IssueHighlightExtension'
import { useWorkflowWritingSession } from './composables/useWorkflowWritingSession'
import { countWords } from '@/utils/word-count'

interface WritingEditorExpose {
  hasUnsavedChanges: () => boolean
  ensurePersisted: (options?: { silent?: boolean }) => Promise<boolean>
  snapshotLocalDraft: () => Promise<boolean>
  getContentVersion: () => number
  applyWorkflowGeneratedText: (text: string) => void
  settleWorkflowGeneratedText: (chapterId: number) => Promise<boolean>
  focusEditor: () => void
  locateIssueHighlight: (issueKey: string) => boolean
  startIssuePolish: (input: {
    issueKey: string
    label: string
    quotes?: string[]
    request: (args: {
      paragraphText: string
      prevParagraph?: string
      nextParagraph?: string
      extraRequirement?: string
    }) => Promise<string>
  }) => boolean
  ensureWorkflowContentPersisted: (
    options?: {
      expectedChapterId?: number
      persistedCandidateVersion?: number
    },
  ) => Promise<{
    ok: boolean
    contentVersion?: number
    message?: string
  }>
}

const route = useRoute()
const router = useRouter()
const themeStore = useThemeStore()
const editorStore = useWritingEditorStore()
const { selfDestructMode, chapterWordCount } = storeToRefs(editorStore)
const writingEditorRef = ref<WritingEditorExpose | null>(null)
const localLibrary = getLocalLibraryStorage()
// 开源版全部作品都是本地书（负 ID）；正 ID 是旧云端作品路径，进入前会被拦回书架
const isLocalBookRoute = computed(() => isLocalEntityId(route.params.bookId as string))
const isLocalWriting = computed(() => isLocalBookRoute.value)

const readQueryNumber = (value: unknown) => {
  const raw = Array.isArray(value) ? value[0] : value
  const num = Number(raw || 0)
  // 本地实体 id 是负数，非零即有效（服务端时代只认正数的老校验会拒掉本地书）
  return Number.isFinite(num) && num !== 0 ? num : 0
}

const workflowRunId = computed(() => readQueryNumber(route.query.runId))
const workflowTaskId = computed(() => readQueryNumber(route.query.taskId))
const workflowEntryRequested = computed(() => route.query.from === 'workflow')
const buildWorkflowIdentity = (
  bookId: string | number,
  runId: number,
  taskId: number,
) => `${String(bookId || '')}:${Number(runId || 0)}:${Number(taskId || 0)}`
const currentWorkflowIdentity = computed(() =>
  buildWorkflowIdentity(
    String(route.params.bookId || ''),
    workflowRunId.value,
    workflowTaskId.value,
  )
)
const validatedWorkflowIdentity = ref('')
const linkedWorkflowRunId = ref(0)
const linkedWorkflowTask = ref<WorkflowTask | null>(null)
// 自动生文会话只有在服务端确认工作流、任务和当前作品归属一致后才会启动。
const isWorkflowAutoGen = computed(
  () =>
    workflowEntryRequested.value
    && workflowRunId.value !== 0
    && workflowTaskId.value !== 0
    && validatedWorkflowIdentity.value === currentWorkflowIdentity.value
)
const workflowEntryGuarded = ref(!isLocalBookRoute.value)
const workflowEntryError = ref(false)
const workflowResumePreparing = ref(false)
const workflowResumeContentLocked = ref(false)
const isWorkflowPageMode = computed(
  () =>
    workflowEntryRequested.value
    || isWorkflowAutoGen.value
)
const workflowSafetyLocked = computed(
  () => isWorkflowPageMode.value || workflowEntryGuarded.value
)
const WORKFLOW_STRUCTURE_BUSY_STATUSES = new Set([
  'queued',
  'running',
  'review_required',
])
const WORKFLOW_CONTENT_BUSY_STATUSES = new Set(['queued', 'running'])
const isWorkflowChapterStructureTaskActive = (task?: WorkflowTask | null) =>
  Boolean(
    task &&
      ['book_generate', 'chapter_generate'].includes(String(task.bizType || '')) &&
      WORKFLOW_STRUCTURE_BUSY_STATUSES.has(String(task.status || ''))
  )
const ordinaryWorkflowStructureLocked = computed(
  () =>
    !isWorkflowPageMode.value &&
    isWorkflowChapterStructureTaskActive(linkedWorkflowTask.value)
)
const workflowStructureLocked = computed(
  () =>
    ordinaryWorkflowStructureLocked.value ||
    (isWorkflowPageMode.value &&
      isWorkflowChapterStructureTaskActive(workflowTask.value))
)
let workflowEntryRevision = 0
const lastRenderedWorkflowCheckpointKey = ref('')
const lastCatalogWorkflowCheckpointId = ref(0)
const lastLoadedWorkflowCandidateKey = ref('')
const workflowRenderedWords = ref(0)
const workflowRenderedChapterId = ref(0)
const workflowCurrentChapterBaseWords = ref(0)
const workflowSnapshotCache = new Map<number, string>()
const workflowRenderedSnapshots = new Map<number, string>()
// 自动跟随生成章节；用户手动切到其他章节后关闭，避免每次 token 把视图强行切回生成章。
const workflowAutoFollow = ref(true)
// 标记由自动跟随触发的章节切换，区分用户的手动切换。
let workflowAutoSwitching = false
// 同一时刻只允许一个工作流切章请求，后续流式帧只更新目标章缓存。
let workflowSwitchingChapterId = 0
const countPlainWords = (value: unknown) =>
  countWords(typeof value === 'string' ? value : String(value ?? ''))

const getVisibleWorkflowChapterId = () => workflowRenderedChapterId.value || Number(editorStore.activeChapterId || 0)

// 返回工作流只保存当前可见内容，生成任务继续在后台运行，暂停由用户主动控制。
const handleWorkflowExit = async () => {
  await writingEditorRef.value?.snapshotLocalDraft()
  if (!(await ensureWritingPersisted())) return
  void router.push('/workflowBook')
}

// 强制关闭浏览器/标签页时自动保存草稿
const handleBeforeUnload = () => {
  if (!isWorkflowPageMode.value) return
  void writingEditorRef.value?.snapshotLocalDraft()
}

// 目录树用本地草稿校正过字数后会把全书总数推过来：
// 顶部「总字数」原本取服务端值，「仅本地」模式下那个数字永远是旧的。
const handleBookWordsEvent = (event: Event) => {
  const detail = (event as CustomEvent<{ bookId?: string | number; wordCount?: number; textWordCount?: number | null }>).detail || {}
  if (String(detail.bookId || '') !== String(bookData.value.id || '')) return
  const wordCount = Number(detail.wordCount)
  if (!Number.isFinite(wordCount) || wordCount < 0) return
  bookData.value.totalWords = wordCount
  bookData.value.textTotalWords = detail.textWordCount ?? null
}

const resetWritingSelection = () => {
  editorStore.setActiveChapter()
  editorStore.setChapterWordCount(0)
}

resetWritingSelection()

// ==========================================
// 自爆模式逻辑
// ==========================================
const isWarning = ref(false)
const isExploded = ref(false)
const countdownValue = ref(3)
const flashRef = ref<HTMLElement | null>(null)
const explosionLayerRef = ref<HTMLElement | null>(null)
// 爆炸后文字
const postBlastMessage = ref('')
const showPostBlastMsg = ref(false)
let typeWriterTimer: ReturnType<typeof setInterval> | undefined

const WARNING_MSGS = [
  "集中注意力！！！",
  "别发呆，动起来！",
  "你的灵感正在流失...",
  "想不想完本了？",
  "天道酬勤！",
  "系统已接管，立即写作！",
  "再不写，这就是结局。"
]

let inactivityTimer: ReturnType<typeof setTimeout> | undefined
let countdownTimer: ReturnType<typeof setInterval> | undefined
let explosionFinalizeTimer: ReturnType<typeof setTimeout> | null = null
let audioCtx: AudioContext | null = null

const initAudioContext = () => {
  if (!audioCtx && typeof window !== 'undefined') {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      audioCtx = new AudioContextClass()
    }
  }
  // 如果已存在但被挂起，尝试恢复
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
}

// 获取自爆时间限制 (ms)
const getBoomTimeLimit = () => {
  switch (selfDestructMode.value) {
    case '10s': return 10 * 1000
    case '20s': return 20 * 1000
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    default: return 0
  }
}

// 音效辅助函数
const playBeep = () => {
  initAudioContext()
  if (!audioCtx) return
  const osc = audioCtx.createOscillator()
  osc.frequency.value = 800
  osc.connect(audioCtx.destination)
  osc.start()
  osc.stop(audioCtx.currentTime + 0.1)
}

const playExplosionSound = () => {
  initAudioContext()
  if (!audioCtx) return
  const t = audioCtx.currentTime
  const bufferSize = audioCtx.sampleRate * 3
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1

  const noise = audioCtx.createBufferSource()
  noise.buffer = buffer
  const noiseFilter = audioCtx.createBiquadFilter()
  noiseFilter.type = 'lowpass'
  noiseFilter.frequency.setValueAtTime(1000, t)
  noiseFilter.frequency.exponentialRampToValueAtTime(10, t + 2.5)
  const noiseGain = audioCtx.createGain()
  noiseGain.gain.setValueAtTime(2, t)
  noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 3)

  noise.connect(noiseFilter)
  noiseFilter.connect(noiseGain)
  noiseGain.connect(audioCtx.destination)
  noise.start(t)
}

// 恢复现场
const recoverFromExplosion = () => {
  isExploded.value = false
  hidePostBlastMessage()
  document.body.classList.remove('broken-screen')
  // 修复提示音
  initAudioContext()
  if (audioCtx) {
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator(); osc.frequency.setValueAtTime(300, t);
    osc.frequency.linearRampToValueAtTime(600, t + 0.2);
    const gain = audioCtx.createGain(); gain.gain.setValueAtTime(0.1, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.2);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.2);
  }
}

// 显示打字机警示文字
const showPostBlastMessage = () => {
  const text = WARNING_MSGS[Math.floor(Math.random() * WARNING_MSGS.length)]
  postBlastMessage.value = ''
  showPostBlastMsg.value = true

  let i = 0
  if (typeWriterTimer) clearInterval(typeWriterTimer)

  typeWriterTimer = setInterval(() => {
    postBlastMessage.value += text.charAt(i)
    i++
    if (i >= text.length) clearInterval(typeWriterTimer)
  }, 150)
}

const hidePostBlastMessage = () => {
  if (typeWriterTimer) clearInterval(typeWriterTimer)
  showPostBlastMsg.value = false
  postBlastMessage.value = ''
}

// 触发爆炸
const triggerExplosion = () => {
  if (workflowSafetyLocked.value) return
  isExploded.value = true
  isWarning.value = false

  // 1. 声音
  playExplosionSound()

  // 2. 视觉效果
  if (flashRef.value) {
    flashRef.value.animate([
      { opacity: 1 }, { opacity: 0 }
    ], { duration: 1500, easing: 'ease-out', fill: 'forwards' })
  }

  // 粒子
  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  const container = explosionLayerRef.value
  if (container) {
    for (let i = 0; i < 60; i++) {
      const spark = document.createElement('div')
      spark.className = 'blast-spark'
      const colors = ['#ffffff', '#fef08a', '#f97316', '#dc2626', '#000000']
      spark.style.background = colors[Math.floor(Math.random() * colors.length)]
      const size = Math.random() * 20 + 5
      spark.style.width = size + 'px'; spark.style.height = size + 'px'
      spark.style.left = cx + 'px'; spark.style.top = cy + 'px'
      container.appendChild(spark)

      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * 800 + 100

      spark.animate([
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`, opacity: 0 }
      ], {
        duration: 800 + Math.random() * 1000,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'forwards'
      }).onfinish = () => spark.remove()
    }
  }

  // 3. 震动
  document.body.style.animation = 'shake-chaos 0.8s ease-in-out both'

  // 4. 摧毁
  if (explosionFinalizeTimer) clearTimeout(explosionFinalizeTimer)
  explosionFinalizeTimer = setTimeout(() => {
    explosionFinalizeTimer = null
    if (workflowSafetyLocked.value) return
    document.body.style.animation = 'none'
    document.body.classList.add('broken-screen')
    showPostBlastMessage()
  }, 800)
}

// 开始倒计时
const startWarning = () => {
  if (workflowSafetyLocked.value || isWarning.value || isExploded.value) return
  isWarning.value = true
  countdownValue.value = 3
  playBeep()

  countdownTimer = setInterval(() => {
    countdownValue.value--
    if (countdownValue.value <= 0) {
      clearInterval(countdownTimer)
      triggerExplosion()
    } else {
      playBeep()
    }
  }, 1000)
}

// 重置倒计时
const resetInactivityTimer = () => {
  clearTimeout(inactivityTimer)
  clearInterval(countdownTimer)
  if (explosionFinalizeTimer) clearTimeout(explosionFinalizeTimer)
  inactivityTimer = undefined
  countdownTimer = undefined
  explosionFinalizeTimer = null

  if (workflowSafetyLocked.value) {
    // 自动生文是等待任务完成的场景，停用自爆表现但保留用户原有偏好。
    isWarning.value = false
    isExploded.value = false
    countdownValue.value = 3
    hidePostBlastMessage()
    document.body.classList.remove('broken-screen')
    document.body.style.animation = 'none'
    return
  }

  if (selfDestructMode.value === 'off') {
    if (isWarning.value) isWarning.value = false
    if (isExploded.value) recoverFromExplosion()
    return
  }

  // 如果正在倒计时，取消倒计时
  if (isWarning.value) {
    isWarning.value = false
  }

  // 如果已经爆炸，恢复
  if (isExploded.value) {
    recoverFromExplosion()
  }

  const limit = getBoomTimeLimit()
  if (limit > 0) {
    inactivityTimer = setTimeout(startWarning, limit)
  }
}

// 监听
watch(selfDestructMode, () => {
  resetInactivityTimer()
})

watch(workflowSafetyLocked, () => {
  // 进出自动生文模式时按当前场景重建计时，离开后恢复用户既有偏好。
  resetInactivityTimer()
})

// Activity listeners
const registerActivity = () => {
  resetInactivityTimer()
}

// 书籍数据
const bookData = ref({
  id: String(route.params.bookId || ''),
  title: '加载中...',
  tags: ['未分类'],
  chapterWords: 0,
  totalWords: 0,
  textTotalWords: null as number | null
})
const workflowHasContent = computed(() =>
  Number(bookData.value.totalWords || 0) > 0
  || Boolean(String(editorStore.activeChapterTextContent || '').trim())
)
// 进入作品页的加载态：书籍详情与目录是两条独立的请求，任意一条没回来就还在"开门"阶段。
// 编辑区的空态提示要等这段结束才能显示，否则会在目录还没到时先说「这本书没有章节」。
const catalogLoading = ref(true)
const isBooting = computed(
  () => catalogLoading.value || bookData.value.title === '加载中...'
)
const entityHighlights = ref<EntityHighlightItem[]>([])
let latestLoreRequestId = 0

const perspectiveLabels: Record<string, string> = {
  first: '第一人称',
  third: '第三人称'
}

const audienceLabels: Record<string, string> = {
  male: '男频',
  female: '女频',
  pub: '出版/全频'
}

const characterRoleLabels: Record<number, string> = {
  0: '主角',
  1: '配角',
  2: '反派',
  3: '路人'
}

const settingTypeLabels: Record<number, string> = {
  0: '地理位置',
  1: '势力宗门',
  2: '功法技能',
  3: '物品道具',
  4: '等级体系',
  5: '其他'
}

const normalizeSummary = (value: string, maxLength = 120) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text
}

const htmlToPlainText = (html?: string) => {
  const raw = String(html || '')
  if (!raw) return ''
  if (typeof document === 'undefined') {
    return normalizeSummary(raw.replace(/<[^>]+>/g, ' '))
  }
  const div = document.createElement('div')
  div.innerHTML = raw
  return normalizeSummary(div.textContent || div.innerText || '')
}

const buildCharacterSummary = (character: Character) => {
  const parts = [
    character.appearance ? `外貌：${character.appearance}` : '',
    character.personality ? `性格：${character.personality}` : '',
    character.background ? `背景：${character.background}` : '',
    character.ability ? `能力：${character.ability}` : ''
  ].filter(Boolean)
  return normalizeSummary(parts.join('；'))
}

const buildSettingSummary = (setting: WorldSetting) => {
  return htmlToPlainText(setting.detail)
}

const flattenWorldSettings = (folders: WorldSettingTreeFolder[]) => {
  const result: WorldSetting[] = []
  folders.forEach(folder => {
    result.push(...(folder.children || []))
  })
  return result
}

// 角色/设定名词高亮改读本地参考库（批 G 已本地化，工作流建书导入的设定直接可用）
const loadLoreHighlights = async (bookId?: string) => {
  const requestId = ++latestLoreRequestId
  const targetBookId = String(bookId || '').trim()
  if (!targetBookId || !isLocalEntityId(targetBookId)) {
    entityHighlights.value = []
    return
  }
  try {
    const [characterRes, settingRes] = await Promise.all([
      listLocalCharacters({ bookId: targetBookId, page: 1, size: 500 }),
      getLocalWorldSettingTree({ bookId: targetBookId })
    ])
    if (requestId !== latestLoreRequestId) return
    const characters = characterRes.data?.list || []
    const settings = flattenWorldSettings(settingRes.data || [])
    entityHighlights.value = [
      ...characters
        .filter(item => String(item.name || '').trim())
        .map(item => ({
          id: item.id,
          kind: 'character' as const,
          name: item.name,
          label: characterRoleLabels[Number(item.role)] || '角色',
          summary: buildCharacterSummary(item)
        })),
      ...settings
        .filter(item => String(item.name || '').trim())
        .map(item => ({
          id: item.id,
          kind: 'setting' as const,
          name: item.name,
          label: settingTypeLabels[Number(item.type)] || '其他',
          summary: buildSettingSummary(item)
        }))
    ]
  } catch (error) {
    if (requestId !== latestLoreRequestId) return
    entityHighlights.value = []
    console.error('加载角色设定高亮数据失败:', error)
  }
}

const buildBookTags = (book: Partial<Book>) => {
  if (Array.isArray(book.tags) && book.tags.length) {
    return book.tags.filter(Boolean) as string[]
  }
  if (typeof book.tags === 'string' && (book.tags as string).trim()) {
    return (book.tags as string).split(/[,，\s]+/).filter(Boolean)
  }
  const derived: string[] = []
  if (book.category) derived.push(book.category)
  if (book.perspective) derived.push(perspectiveLabels[book.perspective] || book.perspective)
  if (book.audience) derived.push(audienceLabels[book.audience] || book.audience)
  if (typeof book.status === 'number') {
    derived.push(book.status === 1 ? '已完结' : '连载中')
  }
  return derived.length ? derived : ['未分类']
}

const WORKFLOW_REOPENABLE_TASK_STATUSES = new Set([
  'queued',
  'running',
  'paused',
  'interrupted',
  'review_required',
  'failed',
  'canceled',
  'succeeded',
])

const readBookWorkflowRunId = (book: Book) => {
  const rawInstruction = book.globalInstruction
  if (!rawInstruction) return 0
  if (typeof rawInstruction === 'object') {
    return readQueryNumber(rawInstruction.workflowRunId)
  }
  try {
    const parsed = JSON.parse(rawInstruction) as Record<string, unknown>
    return readQueryNumber(parsed.workflowRunId)
  } catch {
    return 0
  }
}

const clearWorkflowRouteQuery = async () => {
  const query = { ...route.query }
  delete query.from
  delete query.runId
  delete query.taskId
  await router.replace({
    name: 'Writing',
    params: { bookId: String(route.params.bookId || '') },
    query,
  })
}

// 本地引擎的"工作流已删除"是普通 Error（无状态码），按消息判定
const isWorkflowRunUnavailableError = (error: { msg?: string; message?: string } | null) => {
  return /不存在|已删除|无权|不属于/.test(String(error?.msg || error?.message || ''))
}

const resolveWorkflowEntry = async (book: Book, revision: number) => {
  const associatedRunId = readBookWorkflowRunId(book)
  linkedWorkflowRunId.value = associatedRunId
  if (!workflowEntryRequested.value) {
    validatedWorkflowIdentity.value = ''
    linkedWorkflowTask.value = null
    if (revision === workflowEntryRevision) workflowEntryGuarded.value = false
    if (associatedRunId) {
      try {
        const { data: linkedRun } = await getWorkflowInfoApi(associatedRunId)
        if (
          revision === workflowEntryRevision &&
          Number(linkedRun.bookId || 0) === Number(book.id)
        ) {
          const linkedTask = linkedRun.activeTask || linkedRun.latestBookTask
          linkedWorkflowTask.value =
            linkedTask && isWorkflowChapterStructureTaskActive(linkedTask)
              ? linkedTask
              : null
        }
      } catch (error) {
        // 普通编辑入口不因工作流状态读取失败而锁死，写接口仍执行最终并发校验。
        console.warn('读取关联工作流状态失败:', error)
      }
    }
    return
  }
  const requestedRunId = workflowRunId.value
  const runId = requestedRunId
  if (!runId || !workflowTaskId.value) {
    validatedWorkflowIdentity.value = ''
    await clearWorkflowRouteQuery()
    if (revision === workflowEntryRevision) workflowEntryGuarded.value = false
    return
  }
  workflowEntryGuarded.value = true
  workflowEntryError.value = false
  try {
    const { data: run } = await getWorkflowInfoApi(runId)
    if (revision !== workflowEntryRevision || String(route.params.bookId || '') !== String(book.id)) return
    // 入口携带的任务必须单独验明归属，不能被书籍最近任务静默替换。
    const task = (await getWorkflowTaskStatusApi(workflowTaskId.value)).data
    linkedWorkflowTask.value = task
    if (revision !== workflowEntryRevision || String(route.params.bookId || '') !== String(book.id)) return
    const taskId = Number(task?.id || 0)
    const taskBindingMatches = Number(run.activeTaskId || 0)
      ? Number(run.activeTaskId) === taskId
      : (
          Number(run.latestBookTask?.id || 0) === taskId
          || (requestedRunId === Number(run.id) && workflowTaskId.value === taskId)
        )
    // 书籍、工作流、任务归属和可恢复状态必须完全对应，路由参数不能直接获得任务控制权。
    const shouldRestoreWorkflow =
      Number(run.id) === runId
      && (!associatedRunId || requestedRunId === associatedRunId)
      && Number(run.bookId || 0) === Number(book.id)
      && taskBindingMatches
      && Number(task?.runId || 0) === Number(run.id)
      && Number(task?.bookId || 0) === Number(book.id)
      && WORKFLOW_REOPENABLE_TASK_STATUSES.has(String(task?.status || ''))

    if (!shouldRestoreWorkflow) {
      validatedWorkflowIdentity.value = ''
      linkedWorkflowTask.value = null
      if (workflowEntryRequested.value) await clearWorkflowRouteQuery()
      workflowEntryGuarded.value = false
      return
    }
    const routeMatchesTask =
      workflowRunId.value === Number(run.id)
      && workflowTaskId.value === taskId
    validatedWorkflowIdentity.value = buildWorkflowIdentity(book.id, Number(run.id), taskId)
    if (!routeMatchesTask) {
      await router.replace({
        name: 'Writing',
        params: { bookId: String(book.id) },
        query: {
          ...route.query,
          from: 'workflow',
          runId: String(run.id),
          taskId: String(taskId),
        },
      })
    }
    if (revision !== workflowEntryRevision) return
    workflowEntryGuarded.value = false
  } catch (error) {
    if (revision !== workflowEntryRevision) return
    // 工作流已删除时保留书籍的普通编辑能力；网络或权限异常仍锁定，避免误放开控制权。
    if (isWorkflowRunUnavailableError(error)) {
      validatedWorkflowIdentity.value = ''
      linkedWorkflowTask.value = null
      workflowEntryError.value = false
      if (workflowEntryRequested.value) await clearWorkflowRouteQuery()
      if (revision === workflowEntryRevision) workflowEntryGuarded.value = false
      return
    }
    validatedWorkflowIdentity.value = ''
    workflowEntryError.value = true
    console.error('恢复工作流写作状态失败:', error)
    ElMessage.error('工作流状态读取失败，正文已暂时锁定，请刷新后重试')
  }
}

const loadBookDetail = async (
  bookId?: string,
  entryRevision = workflowEntryRevision,
  revalidateWorkflow = true,
) => {
  if (!bookId) return
  try {
    // 开源版只有本地书（openWritingBook 已把正 ID 拦回书架）
    const data = await localLibrary.getLocalBookDetail(bookId)
    if (!data || data.deletedAt) {
      ElMessage.warning('本地作品不存在')
      void router.replace('/myBooks')
      return
    }
    // 直接打开旧书也从正文计数汇总，不能依赖用户先进入书架触发缓存补算。
    const tree = await localLibrary.getLocalBookTree(bookId)
    if (entryRevision !== workflowEntryRevision) return
    const counts = calcLocalBookStats(tree.flatMap(volume => volume.children))
    bookData.value = {
      id: String(data.id),
      title: data.title || '未命名作品',
      tags: buildBookTags(data),
      chapterWords: bookData.value.chapterWords,
      totalWords: counts.wordCount,
      textTotalWords: counts.textWordCount
    }
    // 本地书同样要走工作流入口校验：路由带 from=workflow 时核对 run/任务/书的归属
    if (revalidateWorkflow) {
      await resolveWorkflowEntry(data, entryRevision)
    }
  } catch (error) {
    console.error('加载书籍详情失败:', error)
    // 之前失败只 console，标题一直卡在“加载中...”。明确告知用户并退出加载态，
    // 章节仍可从侧栏独立加载；用户可刷新重试。
    ElMessage.error('书籍信息加载失败，请刷新重试')
    if (bookData.value.title === '加载中...') {
      bookData.value = { ...bookData.value, title: '加载失败' }
    }
  }
}

const openWritingBook = async (bookId?: string) => {
  if (!bookId) return
  const idStr = String(bookId)
  // 正 ID 是旧云端作品，数据源已下线；直链/历史记录进来一律拦回书架，防止触发云端请求
  if (!isLocalEntityId(idStr)) {
    ElMessage.warning('云端作品已下线，请从书架打开本地作品')
    void router.replace('/myBooks')
    return
  }
  const entryRevision = ++workflowEntryRevision
  validatedWorkflowIdentity.value = ''
  linkedWorkflowRunId.value = 0
  linkedWorkflowTask.value = null
  workflowEntryGuarded.value = false
  workflowEntryError.value = false
  bookData.value.id = idStr
  await loadBookDetail(idStr, entryRevision)
  void loadLoreHighlights(idStr)
}

const ensureWritingPersisted = async () => {
  if (!writingEditorRef.value?.hasUnsavedChanges()) return true
  if (isWorkflowAutoGen.value && !workflowCurrentChapterLocked.value) {
    const result =
      await writingEditorRef.value?.ensureWorkflowContentPersisted()
    return result?.ok === true
  }
  return await writingEditorRef.value.ensurePersisted({ silent: true })
}

const refreshWorkflowBookState = () => {
  if (!bookData.value.id) return
  // 生成中的后台刷新只更新作品信息，不能重新进入工作流身份校验并中断当前会话。
  void loadBookDetail(bookData.value.id, workflowEntryRevision, false)
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
}

const getWorkflowCheckpointId = (task: WorkflowTask | null) => {
  const checkpoint = (task?.checkpoint || {}) as JsonRecord
  return Number(task?.checkpointId || checkpoint?.id || 0)
}

const isWorkflowTaskStreaming = (task: WorkflowTask | null) =>
  ['queued', 'running'].includes(String(task?.status || ''))

const syncWorkflowCheckpointContent = async (task: WorkflowTask | null, options: { force?: boolean } = {}) => {
  const checkpoint = (task?.checkpoint || {}) as JsonRecord
  const checkpointId = getWorkflowCheckpointId(task)
  const checkpointSeq = Number(checkpoint?.payload?.seq || 0)
  const chapterId = resolveWorkflowTaskChapterId(task)
  const contentText = String(checkpoint?.contentText || '')
  const checkpointKey = `${checkpointId}:${checkpointSeq}:${contentText.length}`
  if (task?.status === 'review_required') {
    // 待确认候选已经保存为真实章节。即使编辑器当前就在这一章，也必须主动
    // 重载云端候选并刷新本地基线；旧逻辑只在“未打开本章”时切章，当前章仍
    // 保留流式片段，下一次重写就会被误判为本地/云端冲突。
    const qualityReview = (
      task?.payload?.qualityReview ||
      task?.payload?.qualitySuggestions ||
      {}
    ) as JsonRecord
    const candidateVersion = Number(qualityReview?.contentVersion || 0)
    const candidateKey = `${chapterId}:${candidateVersion}`
    if (
      !chapterId ||
      !candidateVersion ||
      candidateKey === lastLoadedWorkflowCandidateKey.value
    )
      return
    lastLoadedWorkflowCandidateKey.value = candidateKey
    const refreshCandidate = () =>
      window.dispatchEvent(
        new CustomEvent('ew-writing-chapter-content-refresh', {
          detail: {
            chapterId,
            source: 'workflow_candidate',
            contentVersion: candidateVersion,
          },
        }),
      )
    if (Number(editorStore.activeChapterId || 0) === chapterId) {
      refreshCandidate()
      return
    }
    window.dispatchEvent(
      new CustomEvent('ew-writing-open-chapter', {
        detail: { chapterId },
      }),
    )
    void waitForWorkflowChapterActive(chapterId).then(switched => {
      if (switched) refreshCandidate()
    })
    return
  }
  if (task && !isWorkflowTaskStreaming(task)) {
    // 等待暂停状态传到编辑器，解除生成锁后再接收本地稿。
    await nextTick()
    // 暂停/恢复页面读取真实本地稿，旧 checkpoint 不得覆盖人工修改。
    try {
      if (await writingEditorRef.value?.settleWorkflowGeneratedText(chapterId)) {
        workflowSnapshotCache.delete(chapterId)
        workflowRenderedSnapshots.delete(chapterId)
      }
    } catch (error) {
      console.error('读取暂停章节失败', error)
    }
    return
  }
  if (!checkpointId) return
  if (!options.force && isWorkflowTaskStreaming(task) && (workflowSnapshotCache.size || workflowRenderedChapterId.value)) return

  // 仅在恢复、断线或非运行状态使用断点快照，避免轮询覆盖正在显示的实时正文。
  if (!chapterId || !contentText || checkpointKey === lastRenderedWorkflowCheckpointKey.value) return
  lastRenderedWorkflowCheckpointKey.value = checkpointKey
  await applyWorkflowGeneratedText(chapterId, contentText)
  if (checkpointId !== lastCatalogWorkflowCheckpointId.value) {
    lastCatalogWorkflowCheckpointId.value = checkpointId
    refreshWorkflowBookState()
  }
}

const waitForWorkflowChapterActive = async (chapterId: number) => {
  for (let index = 0; index < 12; index += 1) {
    if (editorStore.activeChapterId === chapterId) return true
    await new Promise(resolve => window.setTimeout(resolve, 150))
  }
  return editorStore.activeChapterId === chapterId
}

const updateWorkflowRenderedWords = (chapterId: number, text: string) => {
  const words = countPlainWords(text)
  if (workflowRenderedChapterId.value !== chapterId) {
    const taskTotalWords = Number(workflowTask.value?.totalGeneratedWords || 0)
    const taskChapterWords = Number(workflowTask.value?.generatedWords || 0)
    workflowRenderedChapterId.value = chapterId
    // 当前章实时字数单独计算，全书字数用进入本章前的累计值做基准。
    workflowCurrentChapterBaseWords.value =
      taskTotalWords > 0 && taskChapterWords > 0
        ? Math.max(0, taskTotalWords - taskChapterWords)
        : Math.max(0, Number(bookData.value.totalWords || 0) - countPlainWords(editorStore.activeChapterTextContent))
  }
  workflowRenderedWords.value = words
  bookData.value.chapterWords = words
  editorStore.setChapterWordCount(words)
  bookData.value.totalWords = Math.max(bookData.value.totalWords, workflowCurrentChapterBaseWords.value + words)
  if (workflowTask.value && Number(workflowTask.value.currentChapterId || 0) === chapterId) {
    workflowTask.value = {
      ...workflowTask.value,
      generatedWords: words,
      totalGeneratedWords: Math.max(
        Number(workflowTask.value.totalGeneratedWords || 0),
        workflowCurrentChapterBaseWords.value + words
      ),
    }
  }
}

const renderWorkflowSnapshot = (chapterId: number, text: string) => {
  if (!chapterId || editorStore.activeChapterId !== chapterId) return
  workflowRenderedSnapshots.set(chapterId, text)
  writingEditorRef.value?.applyWorkflowGeneratedText(text)
  updateWorkflowRenderedWords(chapterId, text)
}

const resetWorkflowSnapshotCache = () => {
  workflowSnapshotCache.clear()
  workflowRenderedSnapshots.clear()
  workflowRenderedWords.value = 0
  workflowRenderedChapterId.value = 0
  workflowCurrentChapterBaseWords.value = 0
  workflowSwitchingChapterId = 0
  workflowAutoSwitching = false
}

const applyVisibleWorkflowSnapshot = () => {
  const chapterId = Number(editorStore.activeChapterId || 0)
  const target = workflowSnapshotCache.get(chapterId)
  if (!chapterId || !target) return
  // 服务端已经是真流式快照，前端直接渲染最新帧，避免二次打字机造成卡顿和追赶。
  renderWorkflowSnapshot(chapterId, target)
  workflowSnapshotCache.delete(chapterId)
}

const flushWorkflowSnapshot = (chapterId = Number(editorStore.activeChapterId || 0)) => {
  if (!chapterId) return
  const target = workflowSnapshotCache.get(chapterId)
  if (!target) return
  renderWorkflowSnapshot(chapterId, target)
  workflowSnapshotCache.delete(chapterId)
}

const applyWorkflowGeneratedText = async (chapterId: number, text: string) => {
  if (!chapterId || !text) return
  let targetText = text
  // 切章等待期间只合并同一目标章的最新流式帧，避免旧帧在切换完成后回写。
  if (workflowSwitchingChapterId === chapterId) {
    workflowSnapshotCache.set(chapterId, targetText)
    return
  }
  if (editorStore.activeChapterId !== chapterId) {
    // 用户已手动切到其他章节：仅缓存目标文本，不强制切回；底栏进度仍随 token 更新。
    workflowSnapshotCache.set(chapterId, targetText)
    if (!workflowAutoFollow.value) {
      return
    }
    // 已有其他切章请求时保留本章缓存，等待后续流式帧再接管。
    if (workflowSwitchingChapterId) return
    flushWorkflowSnapshot()
    const sessionIdentity = validatedWorkflowIdentity.value
    workflowSwitchingChapterId = chapterId
    workflowAutoSwitching = true
    window.dispatchEvent(new CustomEvent('ew-writing-open-chapter', { detail: { chapterId } }))
    // 章节切换由侧栏异步处理，需等编辑器确认切到目标章节再写入生成快照。
    const switched = await waitForWorkflowChapterActive(chapterId)
    if (workflowSwitchingChapterId === chapterId) {
      workflowSwitchingChapterId = 0
      workflowAutoSwitching = false
    }
    if (!switched || sessionIdentity !== validatedWorkflowIdentity.value) return
    targetText = workflowSnapshotCache.get(chapterId) || targetText
  }
  if (editorStore.activeChapterId === chapterId) {
    const currentText =
      workflowRenderedSnapshots.get(chapterId) ||
      String(editorStore.activeChapterTextContent || '')
    // 出现修订差异时直接落地完整快照，避免旧正文残留。
    if (currentText && !targetText.startsWith(currentText)) {
      renderWorkflowSnapshot(chapterId, targetText)
      workflowSnapshotCache.delete(chapterId)
      updateWorkflowRenderedWords(chapterId, targetText)
      // 普通快照差异不代表发生了审校或定稿。
      return
    }
    workflowRenderedSnapshots.set(chapterId, currentText)
    workflowSnapshotCache.set(chapterId, targetText)
    applyVisibleWorkflowSnapshot()
  }
}

const shouldHoldVisibleWorkflowChapter = (incoming: WorkflowTask) => {
  const checkpoint = (incoming.checkpoint || {}) as JsonRecord
  const statusChapterId = Number(incoming.currentChapterId || checkpoint.chapterId || 0)
  const visibleChapterId = getVisibleWorkflowChapterId()
  return (
    visibleChapterId !== 0 &&
    statusChapterId !== 0 &&
    statusChapterId !== visibleChapterId &&
    !String(checkpoint.contentText || '') &&
    Number(incoming.generatedWords || 0) === 0 &&
    !['paused', 'review_required', 'failed', 'canceled', 'succeeded'].includes(incoming.status)
  )
}

const normalizeWorkflowTask = (incoming: WorkflowTask, current: WorkflowTask | null) => {
  if (!current || !shouldHoldVisibleWorkflowChapter(incoming)) return incoming
  // 服务端刚切到下一章且正文尚未产生时，保留上一章的可视信息，避免进度区闪回空状态。
  return {
    ...current,
    status: incoming.status,
    progress: incoming.progress,
    totalGeneratedWords: incoming.totalGeneratedWords,
    requestedAction: incoming.requestedAction,
    errorMessage: incoming.errorMessage,
    checkpoint: incoming.checkpoint,
  }
}

const handleWorkflowTaskSynced = (incoming: WorkflowTask) => {
  if (Number(incoming.totalGeneratedWords || 0) > 0) {
    bookData.value.totalWords = Math.max(bookData.value.totalWords, Number(incoming.totalGeneratedWords || 0))
  }
  const canUseCheckpoint =
    !isWorkflowTaskStreaming(incoming) ||
    (!workflowSnapshotCache.size && !workflowRenderedChapterId.value)
  if (!shouldHoldVisibleWorkflowChapter(incoming) && canUseCheckpoint) {
    void syncWorkflowCheckpointContent(incoming)
  }
  if (incoming.currentChapterId && !editorStore.activeChapterId) {
    window.dispatchEvent(new CustomEvent('ew-writing-open-chapter', {
      detail: { chapterId: Number(incoming.currentChapterId) },
    }))
  }
}

const handleWorkflowToken = (payload: JsonRecord) => {
  const chapterId = Number(payload.chapterId || 0)
  const text = String(payload.snapshot || payload.text || '')
  const liveWords = Number(payload.wordCount || 0)
  if (chapterId && liveWords > 0) {
    window.dispatchEvent(
      new CustomEvent('ew-writing-chapter-words', { detail: { chapterId, wordCount: liveWords, textWordCount: payload.textWordCount } })
    )
  }
  void applyWorkflowGeneratedText(chapterId, text)
}

const workflowSession = useWorkflowWritingSession({
  enabled: isWorkflowAutoGen,
  runId: workflowRunId,
  taskId: workflowTaskId,
  persistBeforeReview: async () => {
    const qualityReview = workflowTask.value?.payload?.qualityReview
    const chapterId = Number(qualityReview?.chapterId || 0)
    const candidateVersion = Number(qualityReview?.contentVersion || 0)
    if (!chapterId) {
      return {
        ok: false,
        message: '待确认章节不存在，请刷新工作流后重试',
      }
    }
    if (Number(editorStore.activeChapterId || 0) !== chapterId) {
      window.dispatchEvent(
        new CustomEvent('ew-writing-open-chapter', {
          detail: { chapterId },
        }),
      )
      const switched = await waitForWorkflowChapterActive(chapterId)
      if (!switched) {
        return {
          ok: false,
          message: '待确认章节未能打开，请刷新工作流后重试',
        }
      }
    }
    return (
      (await writingEditorRef.value?.ensureWorkflowContentPersisted(
        {
          expectedChapterId: chapterId,
          persistedCandidateVersion: candidateVersion,
        },
      )) || {
        ok: false,
        message: '编辑器尚未准备完成，请稍后重试',
      }
    )
  },
  normalizeTask: normalizeWorkflowTask,
  onTaskSynced: handleWorkflowTaskSynced,
  onToken: handleWorkflowToken,
  onCatalogUpdated: refreshWorkflowBookState,
  onBeforeStop: flushWorkflowSnapshot,
  onDone: () => {
    flushWorkflowSnapshot()
  },
  onNewTask: () => {
    lastRenderedWorkflowCheckpointKey.value = ''
    lastCatalogWorkflowCheckpointId.value = 0
    lastLoadedWorkflowCandidateKey.value = ''
    resetWorkflowSnapshotCache()
  },
})

const {
  task: workflowTask,
  run: workflowRun,
  configUpdating: workflowConfigUpdating,
  logs: workflowLogs,
  writingScene: workflowWritingScene,
  stageText: workflowStageText,
  controlState: workflowControlState,
  controlPending: workflowControlPending,
  appendLog: appendWorkflowLog,
  start: startWorkflowRealtime,
  stop: stopWorkflowRealtime,
  reset: resetWorkflowSession,
  pause: pauseWorkflowGeneration,
  continueGeneration: continueWorkflowGeneration,
  review: handleWorkflowReview,
  reviewPlotOutline: handleWorkflowPlotOutlineReview,
  updateRuntimeConfig: updateWorkflowRuntimeConfig,
  cancel: stopWorkflowGeneration,
} = workflowSession

const workflowTaskStatusPending = computed(
  () =>
    workflowEntryGuarded.value
    || (
      isWorkflowPageMode.value
      && ['initializing', 'unavailable'].includes(workflowControlState.value)
    )
)

const workflowCurrentChapterLocked = computed(() => {
  if (
    workflowTaskStatusPending.value ||
    workflowResumeContentLocked.value
  )
    return true
  const workflowModeLocked =
    isWorkflowAutoGen.value
    && WORKFLOW_CONTENT_BUSY_STATUSES.has(String(workflowTask.value?.status || ''))
    && Number(editorStore.activeChapterId || 0) === resolveWorkflowTaskChapterId(workflowTask.value)
  // 普通模式锁只在普通模式下生效：工作流页面里 linkedWorkflowTask 是进页时的
  // 一次性快照且不再刷新，任务转入"等待确认"后它仍停留在 running，若参与判定
  // 会把待确认章锁死（点"接受"被误报"仍在生成"）；工作流页面以 workflowTask 为准。
  const ordinaryModeLocked =
    !isWorkflowPageMode.value
    && WORKFLOW_CONTENT_BUSY_STATUSES.has(String(linkedWorkflowTask.value?.status || ''))
    && Number(editorStore.activeChapterId || 0) === resolveWorkflowTaskChapterId(linkedWorkflowTask.value)
  return workflowModeLocked || ordinaryModeLocked
})

const resolveWorkflowTaskChapterId = (task?: WorkflowTask | null) =>
  Number(
    task?.currentChapterId ||
      task?.payload?.chapterId ||
      task?.payload?.qualityReview?.chapterId ||
      task?.payload?.qualitySuggestions?.chapterId ||
      0
  )

const workflowRestoreLockedChapterId = computed(() => {
  const status = String(workflowTask.value?.status || '')
  // 历史恢复锁跟随真实生成章，不能因用户切换到其他章节而解除。
  if (isWorkflowAutoGen.value && WORKFLOW_CONTENT_BUSY_STATUSES.has(status)) {
    return resolveWorkflowTaskChapterId(workflowTask.value)
  }
  // 与内容锁同因：工作流页面里 linkedWorkflowTask 是不刷新的进页快照，
  // 只允许普通模式用它禁用历史恢复，工作流页面以上方 workflowTask 分支为准。
  return !isWorkflowPageMode.value
    && WORKFLOW_CONTENT_BUSY_STATUSES.has(String(linkedWorkflowTask.value?.status || ''))
    ? resolveWorkflowTaskChapterId(linkedWorkflowTask.value)
    : 0
})

watch(
  () => [
    String(workflowTask.value?.status || ''),
    Number(workflowTask.value?.currentChapterId || 0),
  ] as const,
  ([status, currentChapterId]) => {
    if (!workflowResumeContentLocked.value) return
    // 新任务确认生成章或提前结束后交回常规章节锁，排队期间保持整页只读。
    if (!['queued', 'running'].includes(status) || currentChapterId !== 0) {
      workflowResumeContentLocked.value = false
    }
  },
)

const focusWorkflowReviewEditor = () => {
  const chapterId = Number(
    workflowTask.value?.payload?.qualityReview?.chapterId ||
    workflowTask.value?.payload?.qualitySuggestions?.chapterId ||
    0
  )
  if (chapterId && chapterId !== Number(editorStore.activeChapterId || 0)) {
    window.dispatchEvent(new CustomEvent('ew-writing-open-chapter', { detail: { chapterId } }))
    window.setTimeout(() => writingEditorRef.value?.focusEditor(), 180)
    return
  }
  writingEditorRef.value?.focusEditor()
}

// ===== 审稿建议正文标注 + 忽略（等级三色：红=需确认/橙=建议修改/蓝=可优化）=====

/** 建议唯一键：与服务端质检去重、确认面板同一口径 */
const workflowIssueKey = (issue: WorkflowQualityIssue) =>
  `${issue.source}:${issue.code}:${issue.message}`

const reviewIssueContext = computed(() => {
  const payload = workflowTask.value?.payload
  const notice = payload?.qualityReview || payload?.qualitySuggestions || null
  if (!notice) return null
  return {
    chapterId: Number(notice.chapterId || 0),
    contentVersion: Number(notice.contentVersion || 0),
    issues: (notice.issues || []) as WorkflowQualityIssue[],
  }
})

// 忽略记录按"任务+章+正文版本"隔离存本地：重写出新版本后旧忽略自动失效。
const dismissedIssueKeys = ref<string[]>([])
const issueDismissStorageKey = computed(() => {
  const ctx = reviewIssueContext.value
  if (!ctx?.chapterId) return ''
  return `ew-issue-dismissed:${Number(workflowTask.value?.id || 0)}:${ctx.chapterId}:${ctx.contentVersion}`
})

watch(
  issueDismissStorageKey,
  key => {
    if (!key) {
      dismissedIssueKeys.value = []
      return
    }
    try {
      const raw = window.localStorage.getItem(key)
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      dismissedIssueKeys.value = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []
    } catch {
      dismissedIssueKeys.value = []
    }
  },
  { immediate: true },
)

const persistDismissedIssueKeys = () => {
  const key = issueDismissStorageKey.value
  if (!key) return
  try {
    if (dismissedIssueKeys.value.length) {
      window.localStorage.setItem(key, JSON.stringify(dismissedIssueKeys.value))
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // 本地存储失败只影响刷新后的忽略记忆，不阻断交互
  }
}

/** 选中态小签文案：非阻断建议按卡片顺序编号，阻断问题统一"需确认" */
const reviewIssueLabels = computed(() => {
  const labels = new Map<string, string>()
  const issues = reviewIssueContext.value?.issues || []
  let suggestionNo = 0
  for (const issue of issues) {
    if (issue.blocking) {
      labels.set(workflowIssueKey(issue), '需确认')
    } else {
      suggestionNo += 1
      labels.set(workflowIssueKey(issue), `建议 ${suggestionNo}`)
    }
  }
  return labels
})

const issueHighlightItems = computed<IssueHighlightItem[]>(() => {
  const ctx = reviewIssueContext.value
  if (!ctx?.chapterId) return []
  // 标注只属于待确认那一章：编辑器正在看别的章节时不挂
  if (Number(editorStore.activeChapterId || 0) !== ctx.chapterId) return []
  const dismissed = new Set(dismissedIssueKeys.value)
  return ctx.issues
    .filter(issue => issue.paragraphs?.length)
    .filter(issue => issue.blocking || !dismissed.has(workflowIssueKey(issue)))
    .map(issue => ({
      key: workflowIssueKey(issue),
      level: issue.blocking
        ? ('blocking' as const)
        : issue.severity === 'high'
          ? ('advise' as const)
          : ('polish' as const),
      label: reviewIssueLabels.value.get(workflowIssueKey(issue)),
      paragraphs: issue.paragraphs || [],
      quotes: issue.quotes,
    }))
})

// 正文选中段 ↔ 建议卡片联动；"已修改"记录只在本次会话内有效
const activeIssueKey = ref('')
const polishedIssueKeys = ref<string[]>([])

const handleIssueSelected = (issueKeys: string[]) => {
  activeIssueKey.value = issueKeys[0] || ''
}

const handleIssuePolished = (issueKey: string) => {
  if (!polishedIssueKeys.value.includes(issueKey)) {
    polishedIssueKeys.value = [...polishedIssueKeys.value, issueKey]
  }
}

const handlePolishIssue = (issueKey: string) => {
  const ctx = reviewIssueContext.value
  if (!ctx?.chapterId) return
  const issue = ctx.issues.find(item => workflowIssueKey(item) === issueKey)
  if (!issue) return
  const taskId = Number(workflowTask.value?.id || 0)
  if (!taskId) return
  const start = () =>
    writingEditorRef.value?.startIssuePolish({
      issueKey,
      label: reviewIssueLabels.value.get(issueKey) || '建议',
      quotes: issue.quotes,
      request: async args => {
        const { data } = await polishWorkflowParagraphApi({
          taskId,
          chapterId: ctx.chapterId,
          issueKey,
          paragraphText: args.paragraphText,
          prevParagraph: args.prevParagraph,
          nextParagraph: args.nextParagraph,
          extraRequirement: args.extraRequirement,
        })
        return String(data?.polished || '')
      },
    })
  if (Number(editorStore.activeChapterId || 0) !== ctx.chapterId) {
    window.dispatchEvent(
      new CustomEvent('ew-writing-open-chapter', { detail: { chapterId: ctx.chapterId } }),
    )
    window.setTimeout(() => start(), 450)
    return
  }
  start()
}

const handleLocateIssue = (issueKey: string) => {
  const ctx = reviewIssueContext.value
  if (!ctx?.chapterId) return
  if (Number(editorStore.activeChapterId || 0) !== ctx.chapterId) {
    // 正在看别的章：先切到待确认章，等正文与标注挂载后再定位
    window.dispatchEvent(
      new CustomEvent('ew-writing-open-chapter', { detail: { chapterId: ctx.chapterId } }),
    )
    window.setTimeout(() => writingEditorRef.value?.locateIssueHighlight(issueKey), 450)
    return
  }
  writingEditorRef.value?.locateIssueHighlight(issueKey)
}

const handleDismissIssue = (issueKey: string) => {
  if (dismissedIssueKeys.value.includes(issueKey)) return
  dismissedIssueKeys.value = [...dismissedIssueKeys.value, issueKey]
  persistDismissedIssueKeys()
}

const handleRestoreDismissedIssues = () => {
  dismissedIssueKeys.value = []
  persistDismissedIssueKeys()
}

const handleWorkflowResume = async () => {
  if (workflowResumePreparing.value || workflowControlPending.value) return
  workflowResumePreparing.value = true
  try {
    // 继续生成前必须等待用户在暂停期间的修改完整落盘，失败或冲突时不恢复任务。
    const persistResult =
      await writingEditorRef.value?.ensureWorkflowContentPersisted()
    if (!persistResult?.ok) {
      ElMessage.warning(
        persistResult?.message ||
          '正文尚未保存或存在版本冲突，处理完成后再继续生成'
      )
      return
    }
    // 正文确认落盘后锁住编辑器，避免创建后续任务期间又产生一份未提交修改。
    workflowResumeContentLocked.value = true
    await continueWorkflowGeneration()
  } finally {
    const status = String(workflowTask.value?.status || '')
    const currentChapterId = Number(workflowTask.value?.currentChapterId || 0)
    if (!['queued', 'running'].includes(status) || currentChapterId !== 0) {
      workflowResumeContentLocked.value = false
    }
    workflowResumePreparing.value = false
  }
}

const handleBeforeSwitchChapter = async () => {
  return await ensureWritingPersisted()
}

const handleLoreUpdated = () => {
  void loadLoreHighlights(bookData.value.id)
  if (isWorkflowAutoGen.value) {
    appendWorkflowLog('角色与世界设定已更新，将从下一章开始读取')
  }
}

const handleLocalBookUpdated = (event: Event) => {
  if (!isLocalWriting.value) return
  const detail = (event as CustomEvent<{ bookId?: string | number }>).detail || {}
  if (String(detail.bookId || '') !== String(bookData.value.id || '')) return
  void loadBookDetail(bookData.value.id)
  window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
}

watch(
  () => validatedWorkflowIdentity.value,
  (identity) => {
    resetWorkflowSession()
    lastRenderedWorkflowCheckpointKey.value = ''
    lastCatalogWorkflowCheckpointId.value = 0
    resetWorkflowSnapshotCache()
    workflowAutoFollow.value = true
    if (identity) startWorkflowRealtime()
  },
  { immediate: true }
)

// 用户手动切换章节时更新自动跟随：停留在生成章则跟随，切走则暂停跟随；返回时补上最新文本。
watch(
  () => editorStore.activeChapterId,
  (newId) => {
    if (!isWorkflowAutoGen.value || workflowAutoSwitching) return
    const genChapter = Number(workflowTask.value?.currentChapterId || 0)
    const active = Number(newId || 0)
    workflowAutoFollow.value = !genChapter || active === genChapter
    if (workflowAutoFollow.value && active && workflowSnapshotCache.has(active)) {
      applyVisibleWorkflowSnapshot()
    }
  }
)

const refreshOrdinaryWorkflowSafety = async () => {
  const runId = linkedWorkflowRunId.value
  const bookId = Number(bookData.value.id || 0)
  if (!runId || !bookId || isWorkflowPageMode.value) return
  try {
    const previousStatus = String(linkedWorkflowTask.value?.status || '')
    const previousChapterId = resolveWorkflowTaskChapterId(
      linkedWorkflowTask.value
    )
    const { data: run } = await getWorkflowInfoApi(runId)
    if (
      runId !== linkedWorkflowRunId.value ||
      bookId !== Number(bookData.value.id || 0) ||
      Number(run.bookId || 0) !== bookId
    )
      return
    const task = run.activeTask || run.latestBookTask
    linkedWorkflowTask.value =
      task && isWorkflowChapterStructureTaskActive(task) ? task : null
    if (
      previousStatus !== String(linkedWorkflowTask.value?.status || '') ||
      previousChapterId !==
        resolveWorkflowTaskChapterId(linkedWorkflowTask.value)
    ) {
      window.dispatchEvent(new CustomEvent('ew-writing-catalog-refresh'))
    }
  } catch (error) {
    console.warn('刷新关联工作流状态失败:', error)
  }
}

let ordinaryWorkflowSafetyTimer: ReturnType<typeof setTimeout> | null = null
let ordinaryWorkflowSafetyDisposed = false
const scheduleOrdinaryWorkflowSafetyRefresh = () => {
  if (ordinaryWorkflowSafetyTimer) clearTimeout(ordinaryWorkflowSafetyTimer)
  ordinaryWorkflowSafetyTimer = null
  if (
    ordinaryWorkflowSafetyDisposed ||
    !ordinaryWorkflowStructureLocked.value
  )
    return
  ordinaryWorkflowSafetyTimer = setTimeout(async () => {
    await refreshOrdinaryWorkflowSafety()
    scheduleOrdinaryWorkflowSafetyRefresh()
  }, 5000)
}

watch(ordinaryWorkflowStructureLocked, scheduleOrdinaryWorkflowSafetyRefresh)

onMounted(() => {
  ordinaryWorkflowSafetyDisposed = false
  // 写作页需要跟随桌面窗口收缩，覆盖全局页面最小宽度。
  document.body.classList.add('writing-page-shell')
  const currentId = route.params.bookId as string
  void openWritingBook(currentId)

  // 自爆模式监听
  window.addEventListener('keydown', registerActivity)
  window.addEventListener('click', registerActivity)
  window.addEventListener('ew-local-book-updated', handleLocalBookUpdated)
  window.addEventListener('ew-writing-book-words', handleBookWordsEvent)
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('focus', refreshOrdinaryWorkflowSafety)
  resetInactivityTimer()
})

watch(
  () => [
    route.params.bookId,
    route.query.from,
    route.query.runId,
    route.query.taskId,
  ] as const,
  ([newId]) => {
    if (!newId) return
    const idStr = String(newId)
    // 内部补齐为已经验证的规范工作流地址时无需重复请求。
    if (idStr === bookData.value.id && isWorkflowAutoGen.value) return
    if (idStr !== bookData.value.id) {
      resetWritingSelection()
    }
    void openWritingBook(idStr)
  }
)

watch(
  chapterWordCount,
  (count) => {
    bookData.value.chapterWords = count
  },
  { immediate: true }
)

onBeforeRouteLeave(async () => {
  return await ensureWritingPersisted()
})

onBeforeRouteUpdate(async (to, from) => {
  if (to.params.bookId === from.params.bookId) return true
  return await ensureWritingPersisted()
})

onBeforeUnmount(() => {
  ordinaryWorkflowSafetyDisposed = true
  latestLoreRequestId += 1
  window.removeEventListener('keydown', registerActivity)
  window.removeEventListener('click', registerActivity)
  window.removeEventListener('ew-local-book-updated', handleLocalBookUpdated)
  window.removeEventListener('ew-writing-book-words', handleBookWordsEvent)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('focus', refreshOrdinaryWorkflowSafety)
  if (ordinaryWorkflowSafetyTimer) clearTimeout(ordinaryWorkflowSafetyTimer)
  clearTimeout(inactivityTimer)
  clearInterval(countdownTimer)
  if (explosionFinalizeTimer) clearTimeout(explosionFinalizeTimer)
  if (typeWriterTimer) clearInterval(typeWriterTimer)
  stopWorkflowRealtime()
  resetWorkflowSnapshotCache()
  document.body.classList.remove('writing-page-shell')
  document.body.classList.remove('broken-screen')
  document.body.style.animation = 'none'
})
</script>

<style scoped lang="scss">
:global(body.writing-page-shell) {
  min-width: 0;
  overflow-x: hidden;
}

.writing-page {
  height: 100%;
  width: 100%;
  overflow: hidden;
  position: relative;
  font-family: "Noto Serif SC", "Songti SC", SimSun, serif;

  .main-layout {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow: hidden;
    position: relative;
  }
}

@media (max-width: 900px) {
  :global(body.web-runtime .writing-page .main-layout){
    width: 100%;
    min-width: 0;
  }
}

/* 背景层样式 */
.ink-bg-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.ink-bg-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}

.paper-texture {
  position: fixed;
  inset: 0;
  //background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  z-index: 1;
  pointer-events: none;
}

.app-container {
  position: relative;
  z-index: 10;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>

<style lang="scss">
/* --- 自爆模式样式 (Nuclear Boom) --- */

/* 震动动画 */
@keyframes shake-chaos {
  0% {
    transform: translate(0, 0) rotate(0deg);
  }

  10% {
    transform: translate(-8px, -12px) rotate(-3deg);
  }

  20% {
    transform: translate(12px, 8px) rotate(3deg);
  }

  30% {
    transform: translate(-15px, 5px) rotate(-5deg);
  }

  40% {
    transform: translate(15px, -5px) rotate(4deg);
  }

  50% {
    transform: translate(-5px, 15px) rotate(-2deg);
  }

  60% {
    transform: translate(5px, -15px) rotate(2deg);
  }

  70% {
    transform: translate(12px, 12px) rotate(-4deg);
  }

  80% {
    transform: translate(-12px, -12px) rotate(4deg);
  }

  90% {
    transform: translate(5px, 8px) rotate(-2deg);
  }

  100% {
    transform: translate(0, 0) rotate(0deg);
  }
}

/* 报废状态 */
.broken-screen {
  animation: none !important;
  transform: scale(0.98) rotate(2deg);
  /* 稍微缩小并歪斜 */
  filter: contrast(160%) grayscale(100%) sepia(50%) brightness(0.6) blur(0.5px);
  pointer-events: none;
}

/* 碎屏纹理叠加 */
.broken-screen::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 99999;
  opacity: 0.6;
  mix-blend-mode: overlay;
  pointer-events: none;
}

/* 爆炸层 */
.explosion-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 99999;
  display: none;
}

.explosion-layer.active {
  display: block;
}

/* 爆炸粒子 (火光) */
.blast-spark {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 0 10px 2px var(--state-warning);
  /* 金色发光 */
}

/* 全屏闪白 */
.flash-bang {
  position: fixed;
  inset: 0;
  background: white;
  z-index: 20001;
  opacity: 0;
  pointer-events: none;
}

/* 倒计时遮罩 */
.warning-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(153, 27, 27, 0.9);
  backdrop-filter: blur(8px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}

.warning-overlay.show {
  opacity: 1;
  pointer-events: auto;
}

.post-blast-msg {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 100000;
  /* 最高层级 */
  font-family: 'Courier New', Courier, monospace;
  /* 打字机字体 */
  font-size: 3rem;
  font-weight: bold;
  color: var(--state-danger);
  /* 鲜红 */
  text-shadow: 2px 2px 0px #000;
  white-space: nowrap;
  pointer-events: none;
}

.cursor-blink {
  display: inline-block;
  width: 10px;
  height: 3rem;
  background: var(--state-danger);
  vertical-align: bottom;
  animation: blink 1s infinite;
}

@keyframes blink {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0;
  }
}

.warning-title {
  color: var(--on-inverse);
  font-size: 2.25rem;
  font-weight: bold;
  letter-spacing: 0.1em;
  margin-bottom: 1.5rem;
  text-transform: uppercase;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;

  i {
    font-size: 3.75rem;
    margin-bottom: 1rem;
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
}

.countdown-text {
  font-size: 200px;
  font-weight: 900;
  color: var(--on-inverse);
  line-height: 1;
  text-shadow: 0 5px 15px rgba(0, 0, 0, 0.5);
}

.warning-tips {
  color: rgba(255, 255, 255, 0.8);
  margin-top: 2.5rem;
  font-size: 1.25rem;
  font-weight: bold;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 0.75rem 1.5rem;
  border-radius: 0.25rem;
}

@keyframes pulse {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: .5;
  }
}
</style>
