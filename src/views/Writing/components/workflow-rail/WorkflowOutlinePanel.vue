<template>
  <section class="workflow-outline-panel" aria-label="大纲">
    <div class="outline-toolbar">
      <span class="outline-toolbar-hint">卷纲、章纲、细纲都可以直接修改</span>
      <button
        type="button"
        class="outline-toolbar-refresh"
        :disabled="loading"
        title="刷新大纲"
        aria-label="刷新大纲"
        @click="manualRefresh"
      >
        <i class="fa-solid fa-arrows-rotate" :class="{ 'fa-spin': loading }"></i>
      </button>
    </div>

    <div class="outline-scroll custom-scroll">
      <div v-if="initialLoading" class="outline-skeleton">
        <el-skeleton :rows="6" animated />
      </div>

      <div v-else-if="loadError && !volumes.length" class="outline-state is-error">
        <i class="fa-solid fa-circle-exclamation"></i>
        <span>{{ loadError }}</span>
        <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" @click="manualRefresh">
          重新加载
        </button>
      </div>

      <div v-else-if="!volumes.length" class="outline-state">
        <i class="fa-regular fa-folder-open"></i>
        <span>还没有卷章结构，工作流建书完成后会自动出现。</span>
      </div>

      <template v-else>
        <section v-for="volume in volumes" :key="volume.id" class="outline-volume">
          <!-- 卷头：卷名 + 章数 + 行内编辑 -->
          <header class="outline-volume-head">
            <button
              type="button"
              class="outline-caret"
              :class="{ open: isVolumeExpanded(volume.id) }"
              :aria-label="isVolumeExpanded(volume.id) ? '收起本卷' : '展开本卷'"
              @click="toggleVolume(volume.id)"
            >
              <i class="fa-solid fa-chevron-right"></i>
            </button>
            <template v-if="editingVolumeId !== volume.id">
              <strong class="outline-volume-title" :title="volume.title">{{ volume.title || '未命名卷' }}</strong>
              <span class="outline-volume-count">{{ volume.chapters.length }} 章</span>
              <button
                type="button"
                class="outline-row-action"
                title="编辑卷名与卷纲"
                aria-label="编辑卷名与卷纲"
                @click="beginVolumeEdit(volume)"
              >
                <i class="fa-solid fa-pen"></i>
              </button>
            </template>
          </header>

          <!-- 卷编辑态 / 卷纲展示 -->
          <div v-if="editingVolumeId === volume.id" class="outline-inline-edit">
            <input
              v-model="volumeDraft.title"
              class="ink-input"
              type="text"
              maxlength="60"
              placeholder="卷名"
            >
            <textarea
              v-model="volumeDraft.summary"
              class="ink-input outline-inline-textarea"
              rows="3"
              maxlength="1000"
              placeholder="卷纲：本卷的主要剧情走向与目标"
            ></textarea>
            <div class="outline-inline-actions">
              <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" :disabled="volumeSaving" @click="cancelVolumeEdit">
                取消
              </button>
              <button type="button" class="ink-btn ink-btn-primary ink-btn-sm" :disabled="volumeSaving" @click="saveVolumeEdit(volume)">
                <i v-if="volumeSaving" class="fa-solid fa-spinner fa-spin"></i>
                保存
              </button>
            </div>
          </div>
          <p
            v-else
            class="outline-volume-summary"
            :class="{ 'is-empty': !volume.summary }"
            :title="volume.summary ? '点击编辑卷纲' : ''"
            @click="beginVolumeEdit(volume)"
          >
            {{ volume.summary || '暂无卷纲，点击补充' }}
          </p>

          <!-- 章列表 -->
          <div v-show="isVolumeExpanded(volume.id)" class="outline-chapters">
            <article
              v-for="chapter in volume.chapters"
              :key="chapter.id"
              class="outline-chapter"
              :class="{
                active: selectedChapterId === chapter.id,
                'is-writing': isChapterWriting(chapter),
              }"
            >
              <div
                class="outline-chapter-row"
                role="button"
                tabindex="0"
                @click="selectChapter(chapter)"
                @keydown.enter.prevent="selectChapter(chapter)"
              >
                <div class="outline-chapter-main">
                  <div class="outline-chapter-titleline">
                    <strong :title="chapter.title">{{ formatChapterDisplayTitle(chapter) }}</strong>
                    <span v-if="chapterTag(chapter)" class="outline-tag" :class="`is-${chapterTag(chapter)!.kind}`">
                      <em v-if="chapterTag(chapter)!.kind === 'writing'" class="outline-tag-dot"></em>
                      {{ chapterTag(chapter)!.text }}
                    </span>
                    <i
                      v-if="isChapterLocked(chapter)"
                      class="fa-solid fa-lock outline-lock"
                      title="已手动修改，AI 不再覆盖"
                    ></i>
                  </div>
                  <p class="outline-chapter-summary" :class="{ 'is-empty': !chapter.summary }">
                    {{ chapter.summary || '暂无章纲' }}
                  </p>
                </div>
                <div class="outline-chapter-actions" @click.stop>
                  <button
                    type="button"
                    class="outline-row-action"
                    title="在编辑器中打开本章"
                    aria-label="在编辑器中打开本章"
                    @click="openChapterInEditor(chapter)"
                  >
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                  </button>
                  <button
                    type="button"
                    class="outline-row-action"
                    :disabled="isChapterWriting(chapter)"
                    :title="isChapterWriting(chapter) ? '本章正在生成，暂不可编辑' : '编辑章名与章纲'"
                    aria-label="编辑章名与章纲"
                    @click="beginChapterEdit(chapter)"
                  >
                    <i class="fa-solid fa-pen"></i>
                  </button>
                  <i
                    class="fa-solid fa-chevron-down outline-chapter-caret"
                    :class="{ open: selectedChapterId === chapter.id }"
                  ></i>
                </div>
              </div>

              <!-- 章元信息编辑态 -->
              <div v-if="editingChapterId === chapter.id" class="outline-inline-edit is-chapter">
                <input
                  v-model="chapterDraft.title"
                  class="ink-input"
                  type="text"
                  maxlength="60"
                  placeholder="章名"
                >
                <textarea
                  v-model="chapterDraft.summary"
                  class="ink-input outline-inline-textarea"
                  rows="2"
                  maxlength="500"
                  placeholder="一句话章纲：本章推进什么剧情"
                ></textarea>
                <div class="outline-inline-actions">
                  <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" :disabled="chapterSaving" @click="cancelChapterEdit">
                    取消
                  </button>
                  <button type="button" class="ink-btn ink-btn-primary ink-btn-sm" :disabled="chapterSaving" @click="saveChapterEdit(chapter)">
                    <i v-if="chapterSaving" class="fa-solid fa-spinner fa-spin"></i>
                    保存
                  </button>
                </div>
              </div>

              <!-- 选中章的细纲卡片 -->
              <div v-else-if="selectedChapterId === chapter.id" class="outline-beats-card">
                <div class="outline-beats-head">
                  <strong>本章细纲</strong>
                  <span v-if="detailLoading" class="outline-beats-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    正在读取
                  </span>
                  <span v-else-if="isChapterWriting(chapter)" class="outline-beats-frozen">
                    <i class="fa-solid fa-pen-fancy"></i>
                    生成中，暂不可修改
                  </span>
                </div>

                <template v-if="!outlineEditable">
                  <p class="outline-beats-empty">AI 写到本章时自动生成</p>
                  <button
                    v-if="!isChapterWriting(chapter)"
                    type="button"
                    class="ink-btn ink-btn-ghost ink-btn-sm outline-beats-manual"
                    @click="startManualOutline"
                  >
                    <i class="fa-solid fa-pen-nib"></i>
                    手动编写细纲
                  </button>
                </template>

                <template v-else>
                  <ol class="outline-beats-list">
                    <li v-for="(beat, index) in beatsDraft.beats" :key="index">
                      <span class="outline-beat-index">{{ index + 1 }}</span>
                      <input
                        class="ink-input outline-beat-input"
                        type="text"
                        :value="beat"
                        :maxlength="OUTLINE_BEAT_MAX_LEN"
                        :disabled="isChapterWriting(chapter)"
                        placeholder="这一拍谁做什么、冲突如何推进"
                        @input="updateBeat(index, ($event.target as HTMLInputElement).value)"
                      >
                      <button
                        type="button"
                        class="outline-beat-remove"
                        :disabled="isChapterWriting(chapter)"
                        title="删除这一拍"
                        aria-label="删除这一拍"
                        @click="removeBeat(index)"
                      >
                        <i class="fa-solid fa-xmark"></i>
                      </button>
                    </li>
                  </ol>

                  <button
                    type="button"
                    class="outline-beat-add"
                    :disabled="isChapterWriting(chapter) || beatsDraft.beats.length >= OUTLINE_MAX_BEATS"
                    @click="addBeat"
                  >
                    <i class="fa-solid fa-plus"></i>
                    新增一拍
                  </button>

                  <div class="outline-endhook">
                    <span class="outline-endhook-label">
                      <i class="fa-solid fa-anchor"></i>
                      章末钩子
                    </span>
                    <input
                      v-model="beatsDraft.endHook"
                      class="ink-input outline-beat-input"
                      type="text"
                      :maxlength="OUTLINE_BEAT_MAX_LEN"
                      :disabled="isChapterWriting(chapter)"
                      placeholder="最后停在哪个悬念上"
                    >
                  </div>

                  <div v-if="outlineDirty && !isChapterWriting(chapter)" class="outline-beats-actions">
                    <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" :disabled="outlineSaving" @click="resetOutlineDraft(chapter)">
                      还原
                    </button>
                    <button type="button" class="ink-btn ink-btn-primary ink-btn-sm" :disabled="outlineSaving" @click="saveOutline(chapter)">
                      <i v-if="outlineSaving" class="fa-solid fa-spinner fa-spin"></i>
                      {{ outlineSaving ? '正在保存' : '保存细纲' }}
                    </button>
                  </div>

                  <p class="outline-beats-note">
                    {{ OUTLINE_MIN_BEATS }}–{{ OUTLINE_MAX_BEATS }} 拍、每拍不超过 {{ OUTLINE_BEAT_MAX_LEN }} 字；保存后 AI 写本章时按此执行，不再自动覆盖。
                  </p>
                </template>
              </div>
            </article>

            <p v-if="!volume.chapters.length && !volume.plannedChapters.length" class="outline-empty-volume">
              本卷暂无章节
            </p>
          </div>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { extractApiErrorMessage } from '@/utils/api-error'
// 开源版：目录树与卷章读写走本地书库（本地卷章自带 planMeta 细纲）
import {
  getLocalWorkflowBookTree as getBookTreeApi,
  getLocalChapterDetailById as getChapterDetailApi,
  updateLocalChapterData as updateChapterApi,
  updateLocalVolumeData as updateVolumeApi,
} from '@/storage/local-book-bridge'
import type { WorkflowTask } from '@/types/workflow'
import type { WorkflowControlState } from '../../composables/useWorkflowWritingSession'
import {
  OUTLINE_BEAT_MAX_LEN,
  OUTLINE_MAX_BEATS,
  OUTLINE_MIN_BEATS,
  formatChapterDisplayTitle,
  isOutlineUserLocked,
  normalizeExpandedOutline,
  normalizeOutlineVolumes,
  type ExpandedOutlineDraft,
  type OutlineChapterNode,
  type OutlineVolumeNode,
} from './outline-model'

/** 目录刷新事件的去抖间隔：生成中章名事件较密，合并成一次拉取 */
const CATALOG_REFRESH_DEBOUNCE_MS = 600
/** 面板重新激活时超过该时长才补拉一次，避免频繁切页签反复请求 */
const ACTIVATE_REFRESH_STALE_MS = 15000
/** 目录刷新事件名：与左侧目录树共用同一条通知通道 */
const CATALOG_REFRESH_EVENT = 'ew-writing-catalog-refresh'
const OPEN_CHAPTER_EVENT = 'ew-writing-open-chapter'

const props = defineProps<{
  bookId: string | number
  /** 已校验的工作流身份；缺省时退回普通视图目录 */
  runId?: number
  taskId?: number
  task: WorkflowTask | null
  state: WorkflowControlState
}>()

const bookIdNum = computed(() => Number(props.bookId) || 0)
// 本地实体 id 是负数：非零即有效
const useWorkflowView = computed(
  () => Number(props.runId || 0) !== 0 && Number(props.taskId || 0) !== 0
)

// ---------- 树数据 ----------
const volumes = ref<OutlineVolumeNode[]>([])
const loading = ref(false)
const loadError = ref('')
const lastLoadedAt = ref(0)
let loadRevision = 0

const initialLoading = computed(() => loading.value && !volumes.value.length && !loadError.value)

/** 卷折叠状态：未记录视为展开（新卷默认展开） */
const volumeExpanded = reactive<Record<number, boolean>>({})
const isVolumeExpanded = (volumeId: number) => volumeExpanded[volumeId] !== false
const toggleVolume = (volumeId: number) => {
  volumeExpanded[volumeId] = !isVolumeExpanded(volumeId)
}

const findChapter = (chapterId: number): OutlineChapterNode | null => {
  for (const volume of volumes.value) {
    const found = volume.chapters.find(chapter => chapter.id === chapterId)
    if (found) return found
  }
  return null
}

const loadTree = async () => {
  if (!bookIdNum.value) return
  const revision = ++loadRevision
  loading.value = true
  try {
    const request = useWorkflowView.value
      ? {
          bookId: bookIdNum.value,
          viewMode: 'workflow' as const,
          runId: Number(props.runId),
          taskId: Number(props.taskId),
        }
      : { bookId: bookIdNum.value, viewMode: 'normal' as const }
    const { data } = await getBookTreeApi(request, { loading: false })
    if (revision !== loadRevision) return
    volumes.value = normalizeOutlineVolumes(data || [])
    loadError.value = ''
    lastLoadedAt.value = Date.now()
    // 选中章被删除/过滤后收起细纲卡片
    if (selectedChapterId.value && !findChapter(selectedChapterId.value)) {
      selectedChapterId.value = null
      resetOutlineState()
    }
  } catch (error) {
    if (revision !== loadRevision) return
    loadError.value = extractApiErrorMessage(error, '大纲加载失败')
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

const manualRefresh = () => {
  void loadTree()
}

// ---------- 刷新调度：编辑中不打断，编辑结束后补拉 ----------
let refreshTimer: number | null = null
const pendingRefresh = ref(false)

const scheduleReload = () => {
  if (hasUnsavedEdits.value) {
    pendingRefresh.value = true
    return
  }
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void loadTree()
  }, CATALOG_REFRESH_DEBOUNCE_MS)
}

const handleCatalogRefreshEvent = () => scheduleReload()

// ---------- 当前写作章 ----------
const writingChapterId = computed(() => {
  const busy = ['queued', 'running'].includes(String(props.task?.status || ''))
  return busy ? Number(props.task?.currentChapterId || 0) : 0
})

const isChapterWriting = (chapter: OutlineChapterNode) =>
  writingChapterId.value !== 0 && chapter.id === writingChapterId.value

const chapterTag = (chapter: OutlineChapterNode): { text: string; kind: string } | null => {
  if (isChapterWriting(chapter)) return { text: '写作中', kind: 'writing' }
  if (chapter.workflowStatus === 'review_required') return { text: '待确认', kind: 'review' }
  if (chapter.workflowStatus === 'incomplete') return { text: '未完成', kind: 'incomplete' }
  return null
}

/** 手改锁定：服务端标记 + 本次会话内刚保存过的章 */
const localLockedIds = reactive(new Set<number>())
const isChapterLocked = (chapter: OutlineChapterNode) =>
  isOutlineUserLocked(chapter.planMeta) || localLockedIds.has(chapter.id)

// ---------- 卷行内编辑 ----------
const editingVolumeId = ref<number | null>(null)
const volumeDraft = reactive({ title: '', summary: '' })
const volumeSaving = ref(false)

const beginVolumeEdit = (volume: OutlineVolumeNode) => {
  editingVolumeId.value = volume.id
  volumeDraft.title = volume.title
  volumeDraft.summary = volume.summary
}

const cancelVolumeEdit = () => {
  editingVolumeId.value = null
}

const saveVolumeEdit = async (volume: OutlineVolumeNode) => {
  if (volumeSaving.value) return
  const title = volumeDraft.title.trim()
  if (!title) {
    ElMessage.warning('卷名不能为空')
    return
  }
  volumeSaving.value = true
  try {
    const summary = volumeDraft.summary.trim()
    await updateVolumeApi({ id: volume.id, title, summary })
    volume.title = title
    volume.summary = summary
    editingVolumeId.value = null
    ElMessage.success('卷信息已保存')
    window.dispatchEvent(new CustomEvent(CATALOG_REFRESH_EVENT))
  } catch (error) {
    ElMessage.error(extractApiErrorMessage(error, '卷信息保存失败'))
  } finally {
    volumeSaving.value = false
  }
}

// ---------- 章行内编辑（章名 + 一行章纲） ----------
const editingChapterId = ref<number | null>(null)
const chapterDraft = reactive({ title: '', summary: '' })
const chapterSaving = ref(false)

const beginChapterEdit = (chapter: OutlineChapterNode) => {
  if (isChapterWriting(chapter)) return
  editingChapterId.value = chapter.id
  chapterDraft.title = chapter.title
  chapterDraft.summary = chapter.summary
}

const cancelChapterEdit = () => {
  editingChapterId.value = null
}

/** 保存后回读一次详情：outlineSource 是否翻成 user 以服务端为准，不在客户端猜 */
const refreshChapterMetaFromServer = async (chapterId: number) => {
  try {
    const { data } = await getChapterDetailApi({ id: chapterId })
    const node = findChapter(chapterId)
    if (!node || !data) return
    node.title = String(data.title ?? node.title)
    node.summary = String(data.summary ?? node.summary)
    node.planMeta =
      data.planMeta && typeof data.planMeta === 'object' && !Array.isArray(data.planMeta)
        ? data.planMeta
        : null
    if (selectedChapterId.value === chapterId && !outlineDirty.value) {
      applyOutlineFromMeta(node.planMeta)
    }
  } catch {
    // 回读失败不影响已保存结果，下次目录刷新会补齐
  }
}

const saveChapterEdit = async (chapter: OutlineChapterNode) => {
  if (chapterSaving.value) return
  const title = chapterDraft.title.trim()
  if (!title) {
    ElMessage.warning('章名不能为空')
    return
  }
  chapterSaving.value = true
  try {
    const summary = chapterDraft.summary.trim()
    await updateChapterApi({ id: chapter.id, title, summary })
    chapter.title = title
    chapter.summary = summary
    editingChapterId.value = null
    ElMessage.success('章节信息已保存')
    window.dispatchEvent(new CustomEvent(CATALOG_REFRESH_EVENT))
    void refreshChapterMetaFromServer(chapter.id)
  } catch (error) {
    ElMessage.error(extractApiErrorMessage(error, '章节信息保存失败'))
  } finally {
    chapterSaving.value = false
  }
}

// ---------- 细纲（逐拍）编辑 ----------
const selectedChapterId = ref<number | null>(null)
const detailLoading = ref(false)
const beatsDraft = reactive<ExpandedOutlineDraft>({ beats: [], beatScenes: null, endHook: '' })
/** 章上已有细纲，或用户点了"手动编写细纲" */
const outlineReady = ref(false)
const manualEditing = ref(false)
const outlineBaseline = ref('')
const outlineSaving = ref(false)

const outlineEditable = computed(() => outlineReady.value || manualEditing.value)
const outlineFingerprint = () => JSON.stringify([beatsDraft.beats, beatsDraft.endHook])
const outlineDirty = computed(
  () => outlineEditable.value && outlineFingerprint() !== outlineBaseline.value
)

const hasUnsavedEdits = computed(
  () => editingVolumeId.value !== null || editingChapterId.value !== null || outlineDirty.value
)

const resetOutlineState = () => {
  beatsDraft.beats = []
  beatsDraft.beatScenes = null
  beatsDraft.endHook = ''
  outlineReady.value = false
  manualEditing.value = false
  outlineBaseline.value = outlineFingerprint()
}

const applyOutlineFromMeta = (planMeta: JsonRecord | null) => {
  const outline = normalizeExpandedOutline(planMeta?.expandedOutline)
  if (outline) {
    beatsDraft.beats = [...outline.beats]
    beatsDraft.beatScenes = outline.beatScenes ? [...outline.beatScenes] : null
    beatsDraft.endHook = outline.endHook
    outlineReady.value = true
  } else {
    beatsDraft.beats = []
    beatsDraft.beatScenes = null
    beatsDraft.endHook = ''
    outlineReady.value = false
  }
  manualEditing.value = false
  outlineBaseline.value = outlineFingerprint()
}

const confirmDiscardOutline = async () => {
  try {
    await inkConfirm(
      '当前细纲有未保存的修改，离开后将丢失。',
      '放弃细纲修改',
      {
        confirmButtonText: '放弃修改',
        cancelButtonText: '继续编辑',
        type: 'warning',
      }
    )
    return true
  } catch {
    return false
  }
}

const loadChapterOutlineDetail = async (chapterId: number) => {
  detailLoading.value = true
  try {
    const { data } = await getChapterDetailApi({ id: chapterId })
    if (selectedChapterId.value !== chapterId) return
    const node = findChapter(chapterId)
    const planMeta =
      data?.planMeta && typeof data.planMeta === 'object' && !Array.isArray(data.planMeta)
        ? data.planMeta
        : null
    if (node) {
      node.planMeta = planMeta
      node.title = String(data?.title ?? node.title)
      node.summary = String(data?.summary ?? node.summary)
    }
    if (!outlineDirty.value) applyOutlineFromMeta(planMeta)
  } catch {
    // 详情读取失败时沿用目录树自带的 planMeta 快照
  } finally {
    if (selectedChapterId.value === chapterId) detailLoading.value = false
  }
}

const selectChapter = async (chapter: OutlineChapterNode) => {
  if (editingChapterId.value === chapter.id) return
  if (selectedChapterId.value === chapter.id) {
    if (outlineDirty.value && !(await confirmDiscardOutline())) return
    selectedChapterId.value = null
    resetOutlineState()
    return
  }
  if (outlineDirty.value && !(await confirmDiscardOutline())) return
  selectedChapterId.value = chapter.id
  // 先用目录树自带的 planMeta 立即渲染，再拉详情校准最新细纲
  applyOutlineFromMeta(chapter.planMeta)
  void loadChapterOutlineDetail(chapter.id)
}

const startManualOutline = () => {
  manualEditing.value = true
  if (!beatsDraft.beats.length) {
    beatsDraft.beats = Array.from({ length: OUTLINE_MIN_BEATS }, () => '')
    beatsDraft.beatScenes = null
  }
  outlineBaseline.value = outlineFingerprint()
}

const updateBeat = (index: number, value: string) => {
  beatsDraft.beats[index] = value
}

const removeBeat = (index: number) => {
  beatsDraft.beats.splice(index, 1)
  beatsDraft.beatScenes?.splice(index, 1)
}

const addBeat = () => {
  if (beatsDraft.beats.length >= OUTLINE_MAX_BEATS) return
  beatsDraft.beats.push('')
  beatsDraft.beatScenes?.push('')
}

const resetOutlineDraft = (chapter: OutlineChapterNode) => {
  applyOutlineFromMeta(chapter.planMeta)
}

const saveOutline = async (chapter: OutlineChapterNode) => {
  if (outlineSaving.value || selectedChapterId.value !== chapter.id) return
  if (isChapterWriting(chapter)) {
    ElMessage.warning('本章正在生成，暂不能修改细纲')
    return
  }
  // 空白拍自动剔除，场景标签按下标同步保留
  const kept: Array<{ beat: string; scene: string }> = []
  beatsDraft.beats.forEach((beat, index) => {
    const text = beat.trim().slice(0, OUTLINE_BEAT_MAX_LEN)
    if (!text) return
    kept.push({ beat: text, scene: beatsDraft.beatScenes?.[index] || '' })
  })
  if (kept.length < OUTLINE_MIN_BEATS) {
    ElMessage.warning(`细纲至少需要 ${OUTLINE_MIN_BEATS} 拍，AI 才能按拍执行`)
    return
  }
  const beats = kept.map(item => item.beat)
  const scenes = kept.map(item => item.scene)
  const previousOutline =
    chapter.planMeta?.expandedOutline &&
    typeof chapter.planMeta.expandedOutline === 'object' &&
    !Array.isArray(chapter.planMeta.expandedOutline)
      ? chapter.planMeta.expandedOutline
      : {}
  const expandedOutline: JsonRecord = {
    ...previousOutline,
    beats,
    endHook: beatsDraft.endHook.trim().slice(0, OUTLINE_BEAT_MAX_LEN),
  }
  if (scenes.some(Boolean)) {
    expandedOutline.beatScenes = scenes
  } else {
    delete expandedOutline.beatScenes
  }

  outlineSaving.value = true
  try {
    // 契约：planMeta 只传 expandedOutline 与 outlineSource，服务端做字段级合并
    await updateChapterApi({
      id: chapter.id,
      planMeta: { expandedOutline, outlineSource: 'user' },
    })
    chapter.planMeta = {
      ...(chapter.planMeta || {}),
      expandedOutline,
      outlineSource: 'user',
    }
    localLockedIds.add(chapter.id)
    beatsDraft.beats = [...beats]
    beatsDraft.beatScenes = scenes.some(Boolean) ? [...scenes] : null
    outlineReady.value = true
    manualEditing.value = false
    outlineBaseline.value = outlineFingerprint()
    ElMessage.success('细纲已保存，AI 写到本章时将按此执行')
  } catch (error) {
    ElMessage.error(extractApiErrorMessage(error, '细纲保存失败'))
  } finally {
    outlineSaving.value = false
  }
}

// ---------- 打开章节 ----------
const openChapterInEditor = (chapter: OutlineChapterNode) => {
  window.dispatchEvent(
    new CustomEvent(OPEN_CHAPTER_EVENT, { detail: { chapterId: chapter.id } })
  )
}

// ---------- 生命周期与刷新触发 ----------
watch(
  () => [Number(props.taskId || 0), writingChapterId.value, props.state] as const,
  () => scheduleReload()
)

watch(hasUnsavedEdits, dirty => {
  if (!dirty && pendingRefresh.value) {
    pendingRefresh.value = false
    scheduleReload()
  }
})

onMounted(() => {
  void loadTree()
  window.addEventListener(CATALOG_REFRESH_EVENT, handleCatalogRefreshEvent)
})

onActivated(() => {
  if (Date.now() - lastLoadedAt.value > ACTIVATE_REFRESH_STALE_MS) scheduleReload()
})

onBeforeUnmount(() => {
  window.removeEventListener(CATALOG_REFRESH_EVENT, handleCatalogRefreshEvent)
  if (refreshTimer) window.clearTimeout(refreshTimer)
})
</script>

<style scoped lang="scss">
.workflow-outline-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  color: var(--ink-main);
  background: transparent;
}

.outline-toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px 8px;
}

.outline-toolbar-hint {
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.outline-toolbar-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--ink-main);
    background: var(--btn-ghost-hover-bg);
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
}

.outline-scroll {
  flex: 1;
  min-height: 0;
  padding: 0 12px 16px;
  overflow-y: auto;
}

.outline-skeleton {
  padding: 12px 6px;
}

.outline-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 200px;
  padding: 24px 16px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: center;

  i {
    font-size: calc(22px * var(--ui-font-scale, 1));
    opacity: 0.75;
  }

  &.is-error {
    color: var(--state-danger-on);
  }
}

/* ---------- 卷 ---------- */
.outline-volume {
  margin-top: 10px;
  padding-bottom: 6px;

  & + & {
    border-top: 1px solid var(--divider);
    padding-top: 6px;
  }
}

.outline-volume-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 2px 4px;

  &:hover .outline-row-action {
    opacity: 1;
  }
}

.outline-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  transition: transform 0.2s ease, color 0.2s ease;

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
    transition: transform 0.2s ease;
  }

  &.open i {
    transform: rotate(90deg);
  }

  &:hover {
    color: var(--ink-main);
  }
}

.outline-volume-title {
  min-width: 0;
  overflow: hidden;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.outline-volume-count {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--tag-color);
  background: var(--tag-bg);
  font-size: calc(10px * var(--ui-font-scale, 1));
}

.outline-volume-summary {
  margin: 0 4px 6px 32px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.6;
  border-radius: 6px;
  padding: 2px 6px;
  cursor: pointer;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  transition: background 0.2s ease, color 0.2s ease;

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 6%, transparent);
  }

  &.is-empty {
    font-style: italic;
    opacity: 0.75;
  }
}

.outline-row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease, color 0.2s ease, background 0.2s ease;

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  &:hover:not(:disabled),
  &:focus-visible {
    opacity: 1;
    color: var(--ink-main);
    background: var(--btn-ghost-hover-bg);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
}

/* ---------- 行内编辑（卷/章共用） ---------- */
.outline-inline-edit {
  display: grid;
  gap: 8px;
  margin: 2px 4px 8px 32px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 24%, var(--ui-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink-accent) 4%, transparent);

  &.is-chapter {
    margin: 0 8px 10px;
  }
}

.outline-inline-textarea {
  resize: none;
  line-height: 1.6;
}

.outline-inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ---------- 章 ---------- */
.outline-chapters {
  display: grid;
  gap: 4px;
  margin-top: 2px;
}

.outline-chapter {
  border: 1px solid transparent;
  border-radius: 10px;
  transition: border-color 0.2s ease, background 0.2s ease;

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 5%, transparent);

    .outline-row-action {
      opacity: 1;
    }
  }

  &.active {
    border-color: color-mix(in srgb, var(--ink-accent) 28%, var(--ui-border));
    background: color-mix(in srgb, var(--ink-accent) 7%, transparent);
  }

  &.is-writing {
    border-color: color-mix(in srgb, var(--ink-accent) 38%, var(--ui-border));
  }

  &.is-planned {
    opacity: 0.8;

    .outline-chapter-row {
      cursor: default;
    }
  }
}

.outline-chapter-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  cursor: pointer;
}

.outline-chapter-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}

.outline-chapter-titleline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;

  strong {
    min-width: 0;
    overflow: hidden;
    font-size: calc(13px * var(--ui-font-scale, 1));
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.outline-lock {
  flex-shrink: 0;
  color: var(--ink-accent);
  font-size: calc(10px * var(--ui-font-scale, 1));
  opacity: 0.85;
}

.outline-tag {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  color: var(--tag-color);
  background: var(--tag-bg);

  &.is-writing {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &.is-review {
    color: var(--state-warning-on);
    background: var(--state-warning-surface);
  }
}

.outline-tag-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
  animation: outline-writing-pulse 1.6s ease-in-out infinite;
}

@keyframes outline-writing-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.3;
  }
}

.outline-chapter-summary {
  margin: 0;
  overflow: hidden;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.is-empty {
    font-style: italic;
    opacity: 0.75;
  }
}

.outline-chapter-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}

.outline-chapter-caret {
  margin-left: 2px;
  color: var(--ink-sec);
  font-size: calc(10px * var(--ui-font-scale, 1));
  transition: transform 0.2s ease;

  &.open {
    transform: rotate(180deg);
  }
}

.outline-empty-volume {
  margin: 4px 8px 8px 32px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-style: italic;
}

/* ---------- 细纲卡片 ---------- */
.outline-beats-card {
  margin: 0 8px 10px;
  padding: 10px 10px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink-sec) 4%, transparent);
}

.outline-beats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;

  strong {
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.outline-beats-loading,
.outline-beats-frozen {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.outline-beats-frozen {
  color: var(--state-warning-on);
}

.outline-beats-empty {
  margin: 2px 0 8px;
  color: var(--ink-sec);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-style: italic;
}

.outline-beats-manual {
  i {
    margin-right: 5px;
  }
}

.outline-beats-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 6px;

    &:hover .outline-beat-remove {
      opacity: 1;
    }
  }
}

.outline-beat-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--tag-color);
  background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.outline-beat-input {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.outline-beat-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease, color 0.2s ease, background 0.2s ease;

  i {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }

  &:hover:not(:disabled),
  &:focus-visible {
    opacity: 1;
    color: var(--state-danger-on);
    background: var(--state-danger-surface);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }
}

.outline-beat-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 8px;
  border: 1px dashed color-mix(in srgb, var(--ink-accent) 40%, var(--ui-border));
  border-radius: 7px;
  color: var(--ink-sec);
  background: transparent;
  font-size: calc(11px * var(--ui-font-scale, 1));
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--ink-accent);
    border-color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 6%, transparent);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}

.outline-endhook {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--divider);
}

.outline-endhook-label {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
  color: var(--ink-accent);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 700;

  i {
    font-size: calc(10px * var(--ui-font-scale, 1));
  }
}

.outline-beats-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.outline-beats-note {
  margin: 8px 0 2px;
  color: var(--ink-sec);
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 1.5;
  opacity: 0.85;
}
</style>
