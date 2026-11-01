<template>
  <EwModal
    v-model:visible="visibleProxy"
    :title="`${chapterTitle || '当前章节'} · 历史版本`"
    width="min(1360px, 92vw)"
    height="min(900px, 86vh)"
    resizable
    :resize-min-width="720"
    :resize-min-height="480"
    :body-style="{ overflow: 'hidden' }"
  >
    <div class="chapter-history-modal">
      <div class="history-list">
        <div v-if="loading" class="history-empty">加载中...</div>
        <div v-else-if="!historyList.length" class="history-empty">暂无历史版本</div>
        <button
          v-for="item in historyList"
          :key="item.id"
          type="button"
          class="history-item"
          :class="{ active: activeHistoryId === item.id }"
          @click="activeHistoryId = item.id"
        >
          <div class="history-title-row">
            <strong>{{ item.versionName || '未命名版本' }}</strong>
            <span class="history-words">{{ item.wordCount }} 字</span>
          </div>
          <div class="history-meta">
            <span>{{ sourceLabel(item) }}</span>
            <span>{{ item.createTime }}</span>
          </div>
          <div v-if="item.contentVersion || item.modelCode" class="history-version-meta">
            <span v-if="item.contentVersion">正文 v{{ item.contentVersion }}</span>
            <span v-if="item.modelCode">{{ item.modelCode }}</span>
          </div>
          <div class="history-remark">{{ item.remark || '无备注' }}</div>
          <div class="history-preview">{{ item.preview || '无内容预览' }}</div>
        </button>
      </div>

      <div class="history-detail">
        <div class="detail-header">
          <div class="detail-title">{{ detailTitle }}</div>
          <div class="detail-actions">
            <div class="view-switch">
              <button
                type="button"
                :class="{ active: viewMode === 'preview' }"
                @click="viewMode = 'preview'"
              >
                内容预览
              </button>
              <button
                type="button"
                :class="{ active: viewMode === 'diff' }"
                @click="viewMode = 'diff'"
              >
                与当前对比
              </button>
            </div>
            <button
              class="ink-btn ink-btn-primary"
              type="button"
              :disabled="restoreDisabled || !currentHistory || restoring"
              :title="restoreDisabled ? '暂停生成后才能恢复历史版本' : '恢复此版本'"
              @click="handleRestore"
            >
              {{ restoring ? '恢复中...' : '恢复此版本' }}
            </button>
          </div>
        </div>
        <div v-if="restoreDisabled" class="restore-disabled-tip" role="status">
          正文生成期间可以查看和对比历史版本，暂停生成后才能恢复。
        </div>
        <div class="detail-body">
          <template v-if="currentHistory">
            <div class="history-snapshot-meta">
              <span>{{ sourceLabel(currentHistory) }}</span>
              <span v-if="currentHistory.contentVersion">正文 v{{ currentHistory.contentVersion }}</span>
              <span v-if="currentHistory.modelCode">模型 {{ currentHistory.modelCode }}</span>
            </div>
            <div v-if="currentHistory.reviewSnapshot" class="history-review-snapshot">
              <strong>当时审稿结果</strong>
              <span>
                {{ currentHistory.reviewSnapshot.requiresAction ? '需要确认' : '仅修改建议' }}
                · {{ currentHistory.reviewSnapshot.issues.length }} 项
              </span>
              <ul v-if="currentHistory.reviewSnapshot.issues.length">
                <li
                  v-for="(issue, index) in currentHistory.reviewSnapshot.issues"
                  :key="`${issue.code}-${index}`"
                >
                  {{ issue.blocking ? '需确认' : '建议' }} · {{ issue.message }}
                </li>
              </ul>
            </div>
            <pre v-if="viewMode === 'preview'">{{ currentHistory.textContent || '该版本没有正文内容。' }}</pre>
            <div v-else class="diff-view">
              <div class="diff-legend">
                <span><i class="legend-dot is-history"></i>历史版本</span>
                <span><i class="legend-dot is-current"></i>当前正文</span>
              </div>
              <div v-if="!hasLineDiff" class="history-empty">两版正文没有差异</div>
              <div v-else class="diff-lines">
                <div
                  v-for="(row, index) in lineDiff"
                  :key="`${row.type}-${row.oldLine || 0}-${row.newLine || 0}-${index}`"
                  class="diff-line"
                  :class="`is-${row.type}`"
                >
                  <span class="diff-mark">{{ diffMark(row.type) }}</span>
                  <span class="diff-no">{{ row.oldLine || '' }}</span>
                  <span class="diff-no">{{ row.newLine || '' }}</span>
                  <span class="diff-text">
                    <template v-if="row.segments">
                      <span
                        v-for="(seg, segIndex) in row.segments"
                        :key="segIndex"
                        :class="{ 'seg-changed': seg.changed }"
                      >{{ seg.text }}</span>
                    </template>
                    <template v-else>{{ row.text || ' ' }}</template>
                  </span>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="history-empty">请选择一个历史版本查看</div>
        </div>
      </div>
    </div>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import EwModal from '@/components/EwModal/index.vue'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { buildChapterStorageKey, getWritingStorage, type StoredChapterVersion } from '@/storage'
import { LOCAL_USER_ID } from '@/storage/local-library'
import { resetLocalVersionMark } from '@/storage/local-version-service'
import { recordWriteJournal } from '@/storage/write-journal'
import type { ChapterHistoryItem } from '@/types/book'
import { countWords } from '@/utils/word-count'

type ViewMode = 'preview' | 'diff'
type DiffType = 'same' | 'removed' | 'added'
interface DiffSegment {
  text: string
  changed: boolean
}
interface LineDiffRow {
  type: DiffType
  text: string
  oldLine?: number
  newLine?: number
  /** 行内字符级差异；没有配对成功的行不带此字段，整行按行级样式渲染 */
  segments?: DiffSegment[]
}

const props = defineProps<{
  visible: boolean
  chapterId: number | null
  chapterTitle?: string
  restoreDisabled?: boolean
  bookId?: string | number
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'restored', chapterId: number): void
}>()

const visibleProxy = computed({
  get: () => props.visible,
  set: (value: boolean) => emit('update:visible', value),
})

const loading = ref(false)
const restoring = ref(false)
const historyList = ref<ChapterHistoryItem[]>([])
const activeHistoryId = ref<number | null>(null)
const serverTextContent = ref('')
const viewMode = ref<ViewMode>('preview')
const editorStore = useWritingEditorStore()

const currentHistory = computed(() => {
  return historyList.value.find(item => item.id === activeHistoryId.value) || null
})

const detailTitle = computed(() => {
  return viewMode.value === 'preview' ? '版本内容预览' : '与当前正文对比'
})

const currentTextContent = computed(() => {
  if (Number(editorStore.activeChapterId) === Number(props.chapterId)) {
    return editorStore.activeChapterTextContent
  }
  return serverTextContent.value
})

const lineDiff = computed(() => {
  if (!currentHistory.value || viewMode.value !== 'diff') return []
  return buildLineDiff(currentHistory.value.textContent || '', currentTextContent.value)
})

const hasLineDiff = computed(() => lineDiff.value.some(row => row.type !== 'same'))

/**
 * 历史版本有两个来源，且必须同时呈现：
 * - 云端：正文上传成功时由服务端留档
 * - 本地：不上云的模式下由客户端节流留档（本地书库 / 「仅本地」）
 *
 * 早先按当前同步模式二选一，于是「仅本地」期间攒下的快照在切回云端保存后
 * 全部消失——它们其实还在本地库里，只是没人去读。现在两边都读，按时间合并。
 * 本地条目用负数 id，避免和服务端自增 id 撞号。
 */
const resolveHistoryUserId = () => LOCAL_USER_ID

const localVersions = ref<StoredChapterVersion[]>([])

const isLocalHistoryItem = (item: ChapterHistoryItem) => Number(item.id) < 0

/** 本地版本映射成弹窗现有的展示结构，避免为两种来源写两套 UI */
const toHistoryItem = (version: StoredChapterVersion, index: number): ChapterHistoryItem => ({
  id: -(index + 1),
  versionName: `本地快照 ${index + 1}`,
  type: 0,
  remark: version.remark || '本地自动快照',
  source: 'local',
  wordCount: countWords(version.textContent),
  createTime: new Date(Number(version.createdAt || 0)).toLocaleString(),
  preview: String(version.textContent || '').slice(0, 80),
  textContent: String(version.textContent || ''),
  contentVersion: Number(version.remoteVersion || 0),
})

/**
 * 合并排序：先按正文版本，再按时间。
 *
 * 不能只按时间排。云端早期的记录存的是「覆盖前的旧正文」，内容属于版本 N，
 * 时间戳却打在版本 N+1 诞生的那一刻——只按时间排，它就会跑到比它新得多的
 * 本地快照上面去，看着像「越新字数越少」。
 * 而版本号在两边都是可靠的：云端条目是 contentVersion，本地快照是它所基于的
 * remoteVersion（基于 vN 的未同步改动，天然排在 vN 之后、vN+1 之前）。
 * 同一版本内，云端那份是这一版本身，本地那份是在它之上的改动，所以本地更新。
 */
const historyTime = (item: ChapterHistoryItem) => {
  const time = new Date(String(item.createTime || '').replace(/-/g, '/')).getTime()
  return Number.isFinite(time) ? time : 0
}

const compareHistory = (a: ChapterHistoryItem, b: ChapterHistoryItem) => {
  const versionDiff = Number(b.contentVersion || 0) - Number(a.contentVersion || 0)
  if (versionDiff) return versionDiff
  const localDiff = Number(isLocalHistoryItem(b)) - Number(isLocalHistoryItem(a))
  if (localDiff) return localDiff
  return historyTime(b) - historyTime(a)
}

const normalizeHistoryText = (value: string) => String(value || '').replace(/\s+/g, '')

/**
 * 云端自动留版本之后，同一份正文两边都会存一份。正文一样就只留云端那条——
 * 它是权威副本，恢复走服务端接口更稳。剩下的本地快照代表「云端没有的那一份」
 * （离线、仅本地、上传失败），恰好是本地历史存在的意义。
 */
const dedupeHistory = (
  serverItems: ChapterHistoryItem[],
  localItems: ChapterHistoryItem[]
) => {
  const serverTexts = new Set(
    serverItems.map(item => normalizeHistoryText(item.textContent))
  )
  const keptLocal = localItems.filter(
    item => !serverTexts.has(normalizeHistoryText(item.textContent))
  )
  // 去重后重新编号，否则会出现「本地快照 1、本地快照 3」这种缺号，看着像丢了东西。
  // id 保持原样（它编码的是 localVersions 的下标，恢复时要用），只改展示名。
  keptLocal.forEach((item, index) => {
    item.versionName = `本地快照 ${index + 1}`
  })
  return [...serverItems, ...keptLocal]
}

const loadLocalHistory = async () => {
  const userId = resolveHistoryUserId()
  const bookId = String(props.bookId || '')
  if (!bookId || !props.chapterId) {
    // 弹窗被挂载在多处，只要有一处漏传 book-id，本地分支就会静默地查出空列表，
    // 表现和「真的没有版本」一模一样。记一条日志，别再让它无声失败。
    recordWriteJournal({
      at: Date.now(),
      op: 'history',
      backend: 'sqlite',
      storageKey: `${userId}:${bookId}:${props.chapterId || 0}`,
      chars: 0,
      ok: false,
      reason: 'missing bookId/chapterId',
    })
    localVersions.value = []
    return [] as ChapterHistoryItem[]
  }
  const versions = await getWritingStorage().listChapterVersions(
    userId,
    bookId,
    Number(props.chapterId)
  )
  recordWriteJournal({
    at: Date.now(),
    op: 'history',
    backend: 'sqlite',
    storageKey: buildChapterStorageKey(userId, bookId, Number(props.chapterId)),
    chars: 0,
    ok: true,
    detail: `rows=${versions.length}`,
  })
  localVersions.value = versions
  return versions.map(toHistoryItem)
}

/** 本地草稿正文：云端不可达时用它当"当前正文"的比对基准 */
const loadLocalCurrentText = async () => {
  const bookId = String(props.bookId || '')
  if (!bookId || !props.chapterId) return ''
  const draft = await getWritingStorage().getChapterByIdentity(
    resolveHistoryUserId(),
    bookId,
    Number(props.chapterId)
  )
  return String(draft?.textContent || '')
}

const loadHistory = async () => {
  if (!props.chapterId) {
    historyList.value = []
    localVersions.value = []
    activeHistoryId.value = null
    serverTextContent.value = ''
    return
  }
  loading.value = true
  try {
    const localItems = await loadLocalHistory().catch(error => {
      console.error('load local chapter history failed', error)
      localVersions.value = []
      return [] as ChapterHistoryItem[]
    })

    historyList.value = dedupeHistory([], localItems).sort(compareHistory)
    activeHistoryId.value = historyList.value[0]?.id ?? null
    serverTextContent.value = await loadLocalCurrentText()
  } catch (error) {
    console.error('load chapter history failed', error)
    ElMessage.error(String(error?.message || '加载历史版本失败'))
    historyList.value = []
    localVersions.value = []
    activeHistoryId.value = null
    serverTextContent.value = ''
  } finally {
    loading.value = false
  }
}

const handleRestore = async () => {
  if (!currentHistory.value) return
  if (props.restoreDisabled) {
    ElMessage.warning('请先暂停生成，再恢复历史版本')
    return
  }
  try {
    await inkConfirm(
      '恢复会用该历史版本覆盖当前章节正文，当前正文将被替换，是否继续？',
      '恢复历史版本',
      {
        confirmButtonText: '恢复',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
  } catch {
    return
  }

  if (props.restoreDisabled) {
    ElMessage.warning('当前章节正在生成，暂时不能恢复历史版本')
    return
  }
  restoring.value = true
  try {
    await restoreLocalVersion()
    ElMessage.success('历史版本已恢复')
    emit('restored', Number(props.chapterId))
    visibleProxy.value = false
  } catch (error) {
    console.error('restore chapter history failed', error)
    ElMessage.error(String(error?.message || '恢复历史版本失败'))
  } finally {
    restoring.value = false
  }
}

/** 本地恢复：把选中版本写回当前草稿，父级随后重载章节即可看到 */
const restoreLocalVersion = async () => {
  // 本地条目 id 是 -(下标+1)
  const index = Math.abs(Number(activeHistoryId.value || 0)) - 1
  const version = localVersions.value[index]
  if (!version) throw new Error('本地版本已失效，请重新打开历史')
  const storage = getWritingStorage()
  const userId = resolveHistoryUserId()
  const bookId = String(props.bookId || '')
  const current = await storage.getChapterByIdentity(userId, bookId, Number(props.chapterId))
  if (current) {
    await storage.saveChapterVersion({
      userId, bookId, chapterId: current.chapterId, source: 'local',
      title: current.title, textContent: current.textContent, contentJson: current.contentJson,
      remoteVersion: current.remoteVersion, remark: '历史恢复前快照',
    })
  }
  await storage.saveChapterLocal({
    ...(current || {}),
    userId,
    bookId,
    chapterId: Number(props.chapterId),
    title: version.title || current?.title || '',
    textContent: version.textContent || '',
    contentJson: version.contentJson ?? null,
    localVersion: Number(current?.localVersion || 0),
    remoteVersion: Number(current?.remoteVersion || 0),
    baseRemoteVersion: Number(current?.baseRemoteVersion || 0),
    baseTitle: String(current?.baseTitle || ''),
    baseTextContent: String(current?.baseTextContent || ''),
    baseContentJson: current?.baseContentJson ?? null,
    dirty: true,
    conflict: false,
    localOnly: true,
    updatedAt: Date.now(),
  }, { expectedLocalVersion: Number(current?.localVersion || 0) })
  // 重置节流基线：刚恢复的内容与上一版差异必然很大，不重置会立刻再存一版。
  resetLocalVersionMark(buildChapterStorageKey(userId, bookId, Number(props.chapterId)))
}

const typeLabel = (type: number) => {
  if (type === 0) return '自动快照'
  if (type === 2) return '发布前快照'
  return '手动快照'
}

const sourceLabel = (item: ChapterHistoryItem) => ({
  local: '本地快照',
  workflow_candidate: 'AI候选',
  workflow_rewrite: '重写前候选',
  manual: '人工保存',
  restore: '历史恢复前快照',
  admin_edit: '管理端编辑',
  auto_wipe_guard: '清空保护快照',
}[String(item.source || '')] || typeLabel(item.type))

const splitLines = (text: string) => {
  const value = String(text || '')
  return value ? value.split(/\r\n|\n|\r/) : []
}

const buildLineDiff = (oldText: string, newText: string): LineDiffRow[] => {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (!oldLines.length && !newLines.length) return []
  const dp = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0)
  )
  // 从尾部计算最长公共子序列，保证相同行能稳定对齐。
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows: LineDiffRow[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      rows.push({
        type: 'same',
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      })
      oldIndex += 1
      newIndex += 1
      continue
    }
    if (
      newIndex >= newLines.length ||
      (oldIndex < oldLines.length && dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1])
    ) {
      rows.push({
        type: 'removed',
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
      })
      oldIndex += 1
    } else {
      rows.push({
        type: 'added',
        text: newLines[newIndex],
        newLine: newIndex + 1,
      })
      newIndex += 1
    }
  }
  attachInlineDiff(rows)
  return rows
}

/**
 * 行级 diff 只能说明「这一行变了」。网文一段常常上百字，改了三五个字，
 * 界面上就是删一整行、加一整行，两行几乎一样，用户得肉眼找茬。
 * 这里把相邻的删除行/新增行按顺序配对，行内再做一次字符级对比，
 * 把真正变化的字标出来（segments），模板里给深色底。
 */
const attachInlineDiff = (rows: LineDiffRow[]) => {
  let index = 0
  while (index < rows.length) {
    if (rows[index].type !== 'removed') {
      index += 1
      continue
    }
    const removedStart = index
    while (index < rows.length && rows[index].type === 'removed') index += 1
    const addedStart = index
    while (index < rows.length && rows[index].type === 'added') index += 1
    const removedRows = rows.slice(removedStart, addedStart)
    const addedRows = rows.slice(addedStart, index)
    const pairCount = Math.min(removedRows.length, addedRows.length)
    for (let pair = 0; pair < pairCount; pair += 1) {
      const [oldSegments, newSegments] = diffChars(removedRows[pair].text, addedRows[pair].text)
      if (oldSegments && newSegments) {
        removedRows[pair].segments = oldSegments
        addedRows[pair].segments = newSegments
      }
    }
  }
}

// 字符级 DP 是 O(旧长×新长)，超长段落两两相乘会卡界面，超限就退回整行高亮。
const INLINE_DIFF_MAX_CELLS = 250_000
// 公共字符占比太低说明整行被重写，行内高亮会把整行涂满，不如整行样式干净。
const INLINE_DIFF_MIN_SIMILARITY = 0.35

/** 字符级 LCS 对比。返回 [null, null] 表示这一对不适合行内高亮。 */
const diffChars = (
  oldText: string,
  newText: string
): [DiffSegment[], DiffSegment[]] | [null, null] => {
  // Array.from 按码点切分，避免把 emoji 这类代理对拆成两半
  const oldChars = Array.from(oldText)
  const newChars = Array.from(newText)
  if (!oldChars.length || !newChars.length) return [null, null]
  if (oldChars.length * newChars.length > INLINE_DIFF_MAX_CELLS) return [null, null]
  const dp = Array.from({ length: oldChars.length + 1 }, () =>
    Array(newChars.length + 1).fill(0)
  )
  for (let i = oldChars.length - 1; i >= 0; i -= 1) {
    for (let j = newChars.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldChars[i] === newChars[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  if (dp[0][0] / Math.max(oldChars.length, newChars.length) < INLINE_DIFF_MIN_SIMILARITY) {
    return [null, null]
  }
  const oldSegments: DiffSegment[] = []
  const newSegments: DiffSegment[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldChars.length || newIndex < newChars.length) {
    if (
      oldIndex < oldChars.length &&
      newIndex < newChars.length &&
      oldChars[oldIndex] === newChars[newIndex]
    ) {
      pushSegment(oldSegments, oldChars[oldIndex], false)
      pushSegment(newSegments, newChars[newIndex], false)
      oldIndex += 1
      newIndex += 1
    } else if (
      newIndex >= newChars.length ||
      (oldIndex < oldChars.length && dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1])
    ) {
      pushSegment(oldSegments, oldChars[oldIndex], true)
      oldIndex += 1
    } else {
      pushSegment(newSegments, newChars[newIndex], true)
      newIndex += 1
    }
  }
  return [oldSegments, newSegments]
}

const pushSegment = (segments: DiffSegment[], char: string, changed: boolean) => {
  const last = segments[segments.length - 1]
  if (last && last.changed === changed) {
    last.text += char
  } else {
    segments.push({ text: char, changed })
  }
}

const diffMark = (type: DiffType) => {
  if (type === 'removed') return '-'
  if (type === 'added') return '+'
  return ' '
}

watch(
  () => [props.visible, props.chapterId],
  ([visible]) => {
    if (visible) {
      viewMode.value = 'preview'
      loadHistory()
    }
  },
  { immediate: true }
)
</script>

<style scoped lang="scss">
.chapter-history-modal {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  /* 高度交给弹窗本身（含用户拖拽调整），这里只负责铺满 */
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 6px;
}

.history-item {
  width: 100%;
  text-align: left;
  border: 1px solid var(--ui-border);
  background: var(--ui-glass-bg);
  border-radius: 10px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover,
  &.active {
    border-color: var(--ink-accent);
    box-shadow: var(--ui-shadow);
  }
}

.history-title-row,
.history-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.history-meta,
.history-version-meta,
.history-remark,
.history-preview,
.history-words {
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.history-version-meta,
.history-snapshot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  color: var(--ink-tertiary, var(--ink-sec));
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.history-preview {
  margin-top: 8px;
  line-height: 1.6;
}

.history-detail {
  min-height: 0;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-glass-bg);
  overflow: hidden;
}

.detail-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ui-border);
}

.detail-title {
  font-weight: 600;
  color: var(--ink-main);
}

.restore-disabled-tip {
  flex: 0 0 auto;
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--btn-ghost-bg);
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.view-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--btn-ghost-bg);

  button {
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-sec);
    cursor: pointer;
    font-size: calc(12px * var(--ui-font-scale, 1));
    padding: 5px 10px;
  }

  button.active {
    background: var(--ui-glass-bg);
    color: var(--ink-main);
    box-shadow: var(--ui-shadow);
  }
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;

  pre {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.8;
    color: var(--ink-main);
    font-family: inherit;
  }
}

.history-snapshot-meta {
  margin: 0 0 10px;
}

.history-review-snapshot {
  display: grid;
  gap: 5px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--ink-sec);
  background: color-mix(in srgb, var(--ink-accent) 7%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.6;

  strong {
    color: var(--ink-main);
  }

  ul {
    display: grid;
    gap: 3px;
    margin: 0;
    padding-left: 18px;
  }
}

.diff-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.diff-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.diff-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.legend-dot.is-history {
  background: var(--state-danger);
}

.legend-dot.is-current {
  background: var(--state-success);
}

.diff-lines {
  /* 行底色 / 行内变化字底色的浓度；深色主题会吃掉颜色，单独调浓 */
  --diff-row-tint: 20%;
  --diff-seg-tint: 40%;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
}

.theme-dark .diff-lines {
  --diff-row-tint: 28%;
  --diff-seg-tint: 50%;
}

.diff-line {
  display: grid;
  grid-template-columns: 24px 42px 42px minmax(0, 1fr);
  gap: 8px;
  min-height: 30px;
  align-items: flex-start;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 6%, transparent);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;

  &:last-child {
    border-bottom: none;
  }

  &.is-removed {
    background: color-mix(in srgb, var(--state-danger) var(--diff-row-tint), transparent);
    /* 用内阴影画左侧色条，不占布局，避免和未变行错位 */
    box-shadow: inset 3px 0 0 var(--state-danger);
    color: var(--state-danger-on);
  }

  &.is-added {
    background: color-mix(in srgb, var(--state-success) var(--diff-row-tint), transparent);
    box-shadow: inset 3px 0 0 var(--state-success);
    color: var(--state-success-on);
  }
}

.diff-mark,
.diff-no {
  color: var(--ink-sec);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: calc(12px * var(--ui-font-scale, 1));
  user-select: none;
}

.diff-line.is-removed .diff-mark {
  color: var(--state-danger);
  font-weight: 700;
}

.diff-line.is-added .diff-mark {
  color: var(--state-success);
  font-weight: 700;
}

.diff-text .seg-changed {
  border-radius: 3px;
}

.diff-line.is-removed .seg-changed {
  background: color-mix(in srgb, var(--state-danger) var(--diff-seg-tint), transparent);
}

.diff-line.is-added .seg-changed {
  background: color-mix(in srgb, var(--state-success) var(--diff-seg-tint), transparent);
}

.diff-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.history-empty {
  color: var(--ink-sec);
  font-size: calc(13px * var(--ui-font-scale, 1));
  padding: 16px;
  text-align: center;
}

@media (max-width: 760px) {
  .chapter-history-modal {
    grid-template-columns: 1fr;
    /* 窄屏上下叠放：列表最多占四成，剩下留给正文对比，两边各自滚动 */
    grid-template-rows: minmax(0, 40%) minmax(0, 1fr);
  }

  .detail-header,
  .detail-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .view-switch,
  .detail-actions .ink-btn {
    width: 100%;
  }

  .view-switch button {
    flex: 1;
  }
}
</style>
