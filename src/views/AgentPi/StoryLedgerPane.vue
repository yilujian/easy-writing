<template>
  <div class="pi-ledger">
    <section class="pi-ledger-state">
      <label
        >本书默认文风
        <select :value="defaultStyle" @change="changeDefaultStyle">
          <option value="">跟随本书正文</option>
          <option
            v-for="s in piSkills.filter(s => s.enabled && s.name !== 'novel-writing')"
            :key="s.id"
            :value="s.id"
          >
            {{ skillLabel(s) }}
          </option>
        </select>
      </label>
      <label v-if="choices.length || chosen">
        写作范文
        <select :value="chosen" @change="changeSample">
          <option value="">首章写前选择</option>
          <option value="direct">不选外部范文</option>
          <option v-for="item in choices" :key="item.id" :value="item.id">{{ item.title }}</option>
        </select>
      </label>
      <label
        ><input type="checkbox" :checked="learnEdits" :disabled="settingBusy" @change="changeLearning" />
        允许这本书使用我的手改作为范例</label
      >
      <small>开启后记录你改过并保存的 AI 段落，供本书写作和改稿参考。关闭时会清除本书已存的改例。</small>
      <p v-if="status" role="status">{{ status }}</p>
      <div class="pi-ledger-actions">
        <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="backfill">
          {{ view?.paused ? '继续整理' : '全书补记' }}
        </button>
        <button
          v-if="view?.queued && !view.paused"
          type="button"
          class="ink-btn ink-btn-outline ink-btn-sm"
          @click="pause"
        >
          暂停整理
        </button>
      </div>
      <h3>作者更正</h3>
      <label
        >从哪一章之后生效
        <select v-model="anchor">
          <option value="">开篇</option>
          <option v-for="c in view?.chapters" :key="c.id" :value="c.id">
            第 {{ c.no }} 章 {{ c.title }}
          </option>
        </select></label
      >
      <textarea v-model="note" class="pi-ledger-textarea" rows="3" aria-label="作者更正"></textarea>
      <button
        type="button"
        class="ink-btn ink-btn-outline ink-btn-sm"
        :disabled="busy || !view"
        @click="save"
      >
        保存更正
      </button>
    </section>
    <section v-if="view?.people.length" class="pi-ledger-entry">
      <h3>人物近况</h3>
      <p v-for="person in view.people" :key="person.name">
        {{ person.name }} {{ person.state.location || '' }} {{ person.state.realm || '' }}
        {{ Array.isArray(person.state.items) ? person.state.items.join('、') : '' }}
      </p>
    </section>
    <section v-if="view?.corrections.some(c => c.id)" class="pi-ledger-entry">
      <h3>对话中确认的更正</h3>
      <p v-for="c in view.corrections.filter(c => c.id)" :key="c.id">{{ c.text }}</p>
    </section>
    <section v-if="view?.openThreads.length" class="pi-ledger-entry">
      <h3>未收伏笔</h3>
      <p v-for="t in view.openThreads" :key="t.origin.chapterNo + t.title">
        第 {{ t.origin.chapterNo }} 章 · {{ t.title }}
      </p>
    </section>
    <section v-for="entry in entries" :key="entry.chapterId" class="pi-ledger-entry">
      <h4>第 {{ entry.chapterNo }} 章 {{ entry.title }}</h4>
      <p>{{ entry.summary }}</p>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { piCommand } from '@/agent-pi/client'
import { appSettings } from '@/storage/app-settings'
import {
  configureExamples,
  examplePreference,
  sampleChoices,
  currentChoice,
  setSampleChoice,
  type SampleChoice
} from '@/agent-pi/prose-samples'
import { piSkills, skillLabel } from '@/agent-pi/skills'
import {
  readStoryMemory,
  previewFullLedger,
  startBackfill,
  pauseBackfill,
  saveCorrection,
  type StoryMemory
} from '@/agent-pi/story-ledger'
const props = defineProps<{ bookId: string; modelCode?: string }>()
const view = ref<StoryMemory | null>(null),
  defaultStyle = ref(''),
  anchor = ref(''),
  note = ref(''),
  busy = ref(false)
const choices = ref<SampleChoice[]>([]),
  chosen = ref(''),
  learnEdits = ref(false),
  settingBusy = ref(false)
async function loadWritingSettings(bookId: string) {
  choices.value = []
  chosen.value = currentChoice(bookId)
  learnEdits.value = false
  const [options, setting, style] = await Promise.all([
    sampleChoices(bookId), examplePreference(bookId), piCommand<string>('book_style', { bookId })
  ])
  if (bookId === props.bookId) {
    defaultStyle.value = appSettings.getItem('ew-pi-default-style:' + bookId) ?? style
    choices.value = options
    learnEdits.value = setting.enabled
  }
}
async function changeSample(event: Event) {
  const bookId = props.bookId,
    value = (event.target as HTMLSelectElement).value
  try {
    await setSampleChoice(bookId, value)
    if (bookId === props.bookId) chosen.value = value
  } catch (e) {
    ;(event.target as HTMLSelectElement).value = chosen.value
    ElMessage.error(String(e))
  }
}
async function changeLearning(event: Event) {
  const bookId = props.bookId,
    control = event.target as HTMLInputElement,
    enabled = control.checked
  settingBusy.value = true
  try {
    if (!enabled)
      await ElMessageBox.confirm('关闭后将清除本书保存的改例，章节正文仍保留。', '关闭手改范例', {
        confirmButtonText: '关闭并清除',
        cancelButtonText: '取消'
      })
    if (bookId !== props.bookId) return
    await configureExamples(bookId, enabled)
    learnEdits.value = enabled
  } catch (e) {
    control.checked = learnEdits.value
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  } finally {
    settingBusy.value = false
  }
}
const entries = computed(() => view.value?.entries.slice().reverse() || [])
const status = computed(() =>
  !view.value
    ? ''
    : view.value.needsConfirmation
      ? '这些章节需要重新核对。你可以先继续写。'
      : view.value.paused
        ? '整理已暂停'
        : view.value.pending.length
          ? '待整理章节 ' + view.value.pending.map(([a, b]) => (a === b ? a : a + '–' + b)).join('、')
          : '现有正文均已整理'
)
let sequence = 0
async function load(reset = false) {
  const id = props.bookId,
    seq = ++sequence
  try {
    const next = await readStoryMemory(id)
    if (seq !== sequence || id !== props.bookId) return
    view.value = next
    if (reset) {
      anchor.value = next.chapters[next.chapters.length - 1]?.id || ''
      loadNote()
    }
  } catch (e) {
    if (id === props.bookId) ElMessage.error(String(e))
  }
}
const editedAt = ref(0)
function loadNote() {
  const record = view.value?.corrections.find(c => !c.id && String(c.afterChapterId ?? '') === anchor.value)
  note.value = record?.text || ''
  editedAt.value = view.value?.pageEdits[anchor.value] || 0
}
watch(anchor, loadNote)
watch(
  () => props.bookId,
  id => {
    view.value = null
    defaultStyle.value = appSettings.getItem('ew-pi-default-style:' + id) || ''
    void loadWritingSettings(id).catch(e => ElMessage.error(String(e)))
    void load(true)
  },
  { immediate: true }
)
function changeDefaultStyle(e: Event) {
  defaultStyle.value = (e.target as HTMLSelectElement).value
  appSettings.setItem('ew-pi-default-style:' + props.bookId, defaultStyle.value)
}
async function save() {
  const id = props.bookId
  busy.value = true
  try {
    await saveCorrection(id, anchor.value || null, note.value, editedAt.value)
    await load()
    loadNote()
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function backfill() {
  const id = props.bookId
  busy.value = true
  try {
    const plan = await previewFullLedger(id)
    if (!plan.count) {
      ElMessage.info('现有正文均已整理')
      return
    }
    await ElMessageBox.confirm(
      `需整理 ${plan.count} 章，约 ${plan.characters} 字正文，预计至少 ${plan.count} 次模型请求，约 ${Math.max(1, Math.ceil(plan.count / 4))}–${Math.max(1, plan.count)} 分钟。可以暂停，按实际用量计费。`,
      '全书补记',
      { confirmButtonText: '开始整理', cancelButtonText: '取消' }
    )
    if (id === props.bookId) {
      await startBackfill(id, plan, props.modelCode)
      await load()
    }
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function pause() {
  try {
    await pauseBackfill(props.bookId)
    await load()
  } catch (e) {
    ElMessage.error(String(e))
  }
}
let off: UnlistenFn | undefined,
  closed = false
onMounted(async () => {
  const stop = await listen<{ bookId: string }>('agent-canon-changed', e => {
    if (e.payload.bookId === props.bookId) void load()
  })
  if (closed) stop()
  else off = stop
})
onBeforeUnmount(() => {
  closed = true
  off?.()
})
</script>
