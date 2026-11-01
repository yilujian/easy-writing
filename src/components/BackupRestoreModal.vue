<template>
  <EwModal
v-model:visible="visibleProxy" title="恢复备份" width="720px" max-height="85vh"
    custom-class="backup-restore-modal" :close-on-click-modal="false" :show-close="!busy">
    <div class="restore-body">
      <p class="restore-hint">选择“易创备份”文件夹或其中某本作品的文件夹，扫描后确认恢复。</p>
      <div class="restore-directory">
        <span :title="directory">{{ directory || '尚未选择备份目录' }}</span>
        <button class="ink-btn ink-btn-outline" type="button" :disabled="busy || results.length > 0" @click="chooseDirectory">
          <i :class="scanning ? 'fa-solid fa-spinner fa-spin' : 'fa-regular fa-folder-open'"></i>
          {{ scanning ? '扫描中…' : '选择目录' }}
        </button>
      </div>
      <ul class="restore-tips">
        <li>每章采用最新可读备份；恢复为新作品，原有作品和备份文件保留。</li>
        <li>恢复备份中的正文、排版与参考资料，不包含设置和码字统计。</li>
        <li>旧备份未记录目录顺序和删除状态，按卷章标题排序，可能包含曾删除的章节，请核对预览。</li>
      </ul>
      <p v-if="error" class="restore-error" role="alert">{{ error }}</p>
      <template v-if="preview">
        <p v-if="!preview.books.length" class="restore-hint">未找到可恢复的自动备份。请确认目录内保留了作品、分卷和章节文件夹。</p>
        <div v-else class="restore-books">
          <p class="restore-summary">识别到 {{ preview.books.length }} 本作品，已选 {{ selected.length }} 本</p>
          <div v-for="book in preview.books" :key="book.sourceId" class="restore-book">
            <el-checkbox
:model-value="selected.includes(book.sourceId)" :disabled="busy || isRestored(book.sourceId)"
              @change="toggle(book.sourceId, Boolean($event))">
              {{ book.title }} <span v-if="isRestored(book.sourceId)">（已恢复）</span>
            </el-checkbox>
            <div class="restore-book-meta">
              {{ book.chapters.length }} 章 · {{ wordCount(book).toLocaleString() }} 字 · 最近备份 {{ date(book.latestAt) }}
            </div>
            <div class="restore-book-meta">参考资料：{{ book.reference ? summarizeBookReference(book.reference) || '空快照' : '无备份' }}</div>
            <details v-if="book.chapters.length">
              <summary>查看章节</summary>
              <ol class="restore-chapters">
                <li v-for="chapter in book.chapters" :key="chapter.sourceId">
                  <span>{{ chapter.volumeTitle }} / {{ chapter.title }}</span>
                  <small>{{ countWords(chapter.textContent) }} 字</small>
                </li>
              </ol>
            </details>
          </div>
        </div>
        <details v-if="preview.warnings.length" class="restore-warnings">
          <summary>扫描提示（{{ preview.warnings.length }}）</summary>
          <ul><li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li></ul>
        </details>
      </template>
      <p v-if="restoring" role="status">{{ progress }}</p>
      <div v-if="results.length" class="restore-results" role="status">
        <strong>已恢复 {{ results.length }} 本作品</strong>
        <p v-for="result in results" :key="result.sourceId">{{ result.title }}（{{ result.chapterCount }} 章）</p>
      </div>
    </div>
    <template #footer>
      <button class="ink-btn ink-btn-outline" type="button" :disabled="busy" @click="visibleProxy = false">关闭</button>
      <button v-if="results.length" class="ink-btn ink-btn-outline" type="button" :disabled="busy" @click="emit('view-books')">查看作品</button>
      <button class="ink-btn ink-btn-primary" type="button" :disabled="busy || !pendingBooks.length" @click="restore">
        <i v-if="restoring" class="fa-solid fa-spinner fa-spin"></i>{{ restoring ? '恢复中…' : '确认恢复' }}
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import EwModal from '@/components/EwModal/index.vue'
import { scanBackupDirectory, restoreBackupBook } from '@/storage/local-backup-restore'
import { summarizeBookReference } from '@/storage/local-reference-transfer'
import { countWords } from '@/utils/word-count'
import type { BackupRestoreBook, BackupRestorePreview, BackupRestoreResult } from '@/types/backup-restore'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [value: boolean]; 'view-books': [] }>()
const directory = ref('')
const scanning = ref(false), restoring = ref(false), error = ref(''), progress = ref('')
const preview = shallowRef<BackupRestorePreview>()
const selected = ref<string[]>([])
const results = ref<Array<BackupRestoreResult & { sourceId: string }>>([])
const busy = computed(() => scanning.value || restoring.value)
const visibleProxy = computed({ get: () => props.visible, set: (value: boolean) => { if (!busy.value) emit('update:visible', value) } })
const isRestored = (id: string) => results.value.some(result => result.sourceId === id)
const pendingBooks = computed(() => preview.value?.books.filter(book => selected.value.includes(book.sourceId) && !isRestored(book.sourceId)) || [])
const wordCount = (book: BackupRestoreBook) => book.chapters.reduce((sum, chapter) => sum + countWords(chapter.textContent), 0)
const date = (value: number) => value ? new Date(value).toLocaleString() : '时间未知'
const toggle = (id: string, checked: boolean) => { selected.value = checked ? [...selected.value, id] : selected.value.filter(item => item !== id) }

const chooseDirectory = async () => {
  if (busy.value) return
  scanning.value = true
  error.value = ''
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ directory: true, multiple: false, title: '选择自动备份目录' })
    if (!path || Array.isArray(path)) return
    directory.value = path
    preview.value = undefined
    selected.value = []
    preview.value = await scanBackupDirectory(path)
    selected.value = preview.value.books.map(book => book.sourceId)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { scanning.value = false }
}

const restore = async () => {
  if (busy.value || !pendingBooks.value.length) return
  const books = [...pendingBooks.value]
  restoring.value = true
  error.value = ''
  const failures: string[] = []
  for (const [index, book] of books.entries()) {
    progress.value = `正在恢复 ${index + 1}/${books.length}：《${book.title}》`
    try { results.value.push({ ...await restoreBackupBook(book), sourceId: book.sourceId }) }
    catch (cause) { failures.push(`《${book.title}》：${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  error.value = failures.join('\n')
  restoring.value = false
}
</script>

<style scoped lang="scss">
.restore-body { display: grid; gap: 16px; color: var(--ink-main); font-size: calc(13px * var(--ui-font-scale, 1)); }
.restore-hint, .restore-summary { margin: 0; line-height: 1.7; }
.restore-directory { display: flex; gap: 12px; align-items: center; border: 1px solid var(--input-border); border-radius: 6px; padding: 12px; }
.restore-directory span { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--ink-sec); }
.restore-directory button { flex-shrink: 0; }
.restore-tips { margin: 0; padding-left: 18px; line-height: 1.8; color: var(--ink-sec); }
.restore-error { color: var(--state-danger); white-space: pre-wrap; margin: 0; }
.restore-book { border-bottom: 1px solid var(--ui-border); padding: 12px 0; }
.restore-book-meta { margin: 3px 0 7px; color: var(--ink-sec); line-height: 1.6; }
summary { cursor: pointer; color: var(--ink-accent); }
.restore-chapters { max-height: 200px; overflow: auto; margin: 10px 0 0; padding: 0; list-style: none; }
.restore-chapters li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; }
.restore-chapters small { flex-shrink: 0; color: var(--ink-sec); }
.restore-warnings { color: var(--ink-sec); overflow-wrap: anywhere; }
.restore-warnings ul { padding-left: 18px; max-height: 150px; overflow: auto; line-height: 1.7; }
.restore-results p { margin: 6px 0 0; }
</style>
