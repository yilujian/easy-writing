<template>
  <div
    class="pi-workspace pi-version"
    :class="{
      'sidebar-collapsed': !sidebarOpen,
      'mobile-sidebar-open': sidebarOpen,
      'has-document': store.view === 'chat' && (!!store.openedDraft || !!openedResultView),
      'document-expanded': documentExpanded
    }"
  >
    <button
      v-if="sidebarOpen"
      class="pi-sidebar-backdrop"
      aria-label="收起导航"
      @click="sidebarOpen = false"
    ></button>
    <PiSidebar
      ref="sidebar"
      :open="sidebarOpen"
      @close="sidebarOpen = false"
      @new-chat="newChat"
      @select="selectSession"
      @skills="openSkills"
      @memory="store.view = 'memory'; closeOnNarrow()"
      @resources="store.view = 'resources'; closeOnNarrow()"
    />
    <div class="pi-main">
      <header class="pi-header pi-topbar">
        <div class="pi-header-title">
          <button
            v-if="!sidebarOpen"
            class="pi-icon-button"
            aria-label="展开侧栏"
            @click="sidebarOpen = true"
          >
            <i class="fa-solid fa-bars" aria-hidden="true"></i>
          </button>
          <h1>{{ pageTitle }}</h1>
          <button
            v-if="store.view === 'chat' && activeBook"
            class="pi-icon-button"
            aria-label="故事状态"
            title="故事状态"
            :aria-pressed="!!openedLedger"
            @click="selectResult({ kind: 'ledger', id: activeBook.id })"
          >
            <i class="fa-solid fa-book-bookmark" aria-hidden="true"></i>
          </button>
        </div>
      </header>
      <div v-if="store.error" class="pi-error"><PiRunNotice :error="store.error" /></div>
      <div class="pi-chat-workspace">
        <section
          class="pi-conversation-pane"
          :class="{ 'is-welcome': isWelcome && store.view === 'chat' }"
          :aria-label="pageTitle"
        >
          <PiSkillsPage v-if="store.view === 'skills'" />
          <PiMemoryPage v-else-if="store.view === 'memory'" />
          <PiResourcesPage v-else-if="store.view === 'resources'" />
          <div v-else-if="isWelcome" class="pi-welcome-content">
            <div class="pi-welcome-title pi-welcome">
              <h2 ref="documentTitle" tabindex="-1">今天，想写点什么？</h2>
              <p>从一个想法开始，也可以继续你的作品。</p>
            </div>
            <PiComposer ref="composer" />
            <div class="pi-starters">
              <button v-for="item in starters" :key="item.label" @click="startFrom(item.prompt)">
                <i :class="item.icon" aria-hidden="true"></i>{{ item.label }}
              </button>
            </div>
            <button
              v-if="store.sessions[0]"
              class="pi-resume-last"
              :disabled="store.inputLocked"
              @click="selectSession(store.sessions[0])"
            >
              <i class="fa-regular fa-clock" aria-hidden="true"></i
              ><span>继续上次：{{ store.sessions[0].title }}</span
              ><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
          </div>
          <template v-else>
            <PiConversation
              ref="conversation"
              :key="store.activeKey"
              :labels="toolNames"
              :document-locked="adopting || switchingDraft"
              @open-draft="selectDraft"
              @open-result="selectResult"
              @adopt-all="adoptAll"
            />
            <div class="pi-composer-dock"><PiComposer ref="composer" /></div>
          </template>
        </section>
        <aside
          v-if="store.view === 'chat' && (store.openedDraft || openedResultView || openedLedger)"
          class="pi-draft-pane"
          :aria-label="store.openedDraft ? '内容编辑区' : '拆书报告'"
        >
          <header class="pi-document-header">
            <div>
              <h2>{{ paneTitle }}</h2>
              <p class="pi-draft-target">{{ paneSubtitle }}</p>
            </div>
            <div class="pi-actions">
              <button
                class="pi-icon-button"
                :aria-label="documentExpanded ? '恢复面板宽度' : '展开阅读'"
                :title="documentExpanded ? '恢复宽度' : '展开阅读'"
                @click="documentExpanded = !documentExpanded"
              >
                <i
                  :class="documentExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'"
                  aria-hidden="true"
                ></i>
              </button>
              <button
                class="pi-icon-button"
                :aria-label="store.openedDraft ? '关闭草稿' : '关闭报告'"
                :disabled="adopting || switchingDraft"
                @click="closePane"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
          </header>
          <BreakdownReportPane v-if="!store.openedDraft && openedReportTask" :task="openedReportTask" />
          <DistillationResultPane v-else-if="!store.openedDraft && openedDistillation" :task="openedDistillation" />
          <CoverResultPane v-else-if="!store.openedDraft && openedCover" :task="openedCover" />
          <StoryLedgerPane v-else-if="!store.openedDraft && openedLedger" :book-id="openedLedger" :model-code="store.modelCode" />
          <template v-if="store.openedDraft">
          <div class="pi-document-tabs">
            <span class="pi-document-label">{{ draftTarget === '章节' ? '章节正文' : draftTarget }}</span>
            <span class="pi-state-label" :class="{ success: !!store.openedDraft.appliedAt }">{{
              store.openedDraft.appliedAt ? '已采用' : '待采用'
            }}</span>
          </div>
          <CreationEditor
            v-if="store.openedDraft.kind === 'entity'"
            v-model="draftContent"
            :draft="store.openedDraft"
            :disabled="!!store.openedDraft.appliedAt || store.busy || adopting"
          />
          <SkillDraftEditor
            v-else-if="store.openedDraft.kind === 'skill'"
            v-model="draftContent"
            :draft="store.openedDraft"
            :disabled="!!store.openedDraft.appliedAt || store.busy || adopting"
          />
          <textarea
            v-else
            :value="draftContent"
            @input="onProseInput"
            class="pi-draft-editor"
            :readonly="!!store.openedDraft.appliedAt || store.busy || adopting"
            aria-label="草稿正文"
            spellcheck="false"
            @change="persistDraft"
          ></textarea>
          <ProseTextTarget v-if="store.openedDraft.kind==='text'" :key="store.openedDraft.id" :draft="store.openedDraft" :content="draftContent" :books="store.books" :disabled="store.busy || adopting" @prepared="saved=>{store.openedDraft=saved;void store.reloadDrafts()}" />
          <details v-if="store.openedDraft.kind==='chapter' && store.openedDraft.selection" class="pi-resource-provenance"><summary>对照选段原文</summary><p>{{ store.openedDraft.selection.text }}</p><small>仅替换这段原文。</small></details>
          <details v-if="store.openedDraft.resourceUse?.length" class="pi-resource-provenance">
            <summary>初次生成时读取的参考资料（{{ store.openedDraft.resourceUse.length }}）</summary>
            <ul><li v-for="(item, i) in store.openedDraft.resourceUse" :key="i">
              {{ item.title }} · 第 {{ item.version }} 版 · {{ item.paragraphFrom }}—{{ item.paragraphTo }} 段
              <p v-if="item.reason">{{ item.reason }}</p>
            </li></ul>
            <p>这些是参考材料，不是本书事实；读取记录不代表写作质量已获验证。</p>
          </details>
          <footer class="pi-document-footer">
            <div>
              <span
                ><i class="fa-regular fa-clock" aria-hidden="true"></i
                >{{ store.openedDraft.appliedAt ? (store.openedDraft.kind === 'skill' ? '已保存到技能目录' : '已保存到作品') : store.openedDraft.kind === 'skill' ? '确认采用后写进技能目录' : store.openedDraft.kind === 'text' ? '独立文本，可编辑和复制' : store.openedDraft.kind === 'short_story' ? '采用后创建新书并保存首章' : '确认采用后写入作品' }}</span
              ><small v-if="store.openedDraft.kind !== 'entity' && store.openedDraft.kind !== 'skill'"
                >{{ draftContent.replace(/\s/g, '').length }} 字</small
              >
            </div>
            <button v-if="store.openedDraft.kind==='text'" class="ink-btn ink-btn-primary" @click="copyText">复制改稿</button>
            <button
              v-else
              class="ink-btn ink-btn-primary"
              :disabled="store.busy || adopting || !!store.openedDraft.appliedAt"
              @click="adopt"
            >
              {{
                store.openedDraft.appliedAt
                  ? `已保存到${draftTarget}`
                  : adopting
                    ? '正在保存'
                    : `采用并保存到${draftTarget}`
              }}
            </button>
          </footer>
          </template>
        </aside>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { usePiWorkspace } from './use-pi-workspace'
import { inkConfirm } from '@/utils/ink-confirm'
import type { PiSession } from '@/types/agent-pi'
import PiComposer from './PiComposer.vue'
import PiConversation from './PiConversation.vue'
import CreationEditor from './CreationEditor.vue'
import PiRunNotice from './PiRunNotice.vue'
import SkillDraftEditor from './SkillDraftEditor.vue'
import { skillDraftFields } from '@/agent-pi/skill-draft'
import BreakdownReportPane from './BreakdownReportPane.vue'
import { breakdownTasks } from '@/agent-pi/breakdown-tasks'
import { distillationTasks } from '@/agent-pi/distillation-tasks'
import DistillationResultPane from './DistillationResultPane.vue'
import { coverTasks } from '@/agent-pi/cover-tasks'
import CoverResultPane from './CoverResultPane.vue'
import {typedByAuthor} from '@/agent-pi/prose-samples'
import ProseTextTarget from './ProseTextTarget.vue'
import StoryLedgerPane from './StoryLedgerPane.vue'
import type { PiTaskKind } from '@/agent-pi/tasks'
import PiSkillsPage from './PiSkillsPage.vue'
import PiMemoryPage from './PiMemoryPage.vue'
const PiResourcesPage = defineAsyncComponent(() => import('./PiResourcesPage.vue'))
import { entitySpecs, creationTitle, creationSummary } from '@/agent-pi/creation'
import PiSidebar from './PiSidebar.vue'
import { matchShortcut } from './shortcuts'
import './style.scss'
const store = usePiWorkspace()
const composer = ref<InstanceType<typeof PiComposer>>()
const sidebar = ref<InstanceType<typeof PiSidebar>>()
const conversation = ref<InstanceType<typeof PiConversation>>()
const documentTitle = ref<HTMLElement>()
const switchingDraft = ref(false)
const sidebarOpen = ref(window.innerWidth > 900)
const documentExpanded = ref(false)
const onResize = () => {
  if (window.innerWidth <= 900) sidebarOpen.value = false
}
const closeOnNarrow = () => {
  if (window.innerWidth <= 900) sidebarOpen.value = false
}
async function newChat(groupId = '') {
  await store.newChat(typeof groupId === 'string' ? groupId : '')
  closeOnNarrow()
}
async function selectSession(session: PiSession) {
  await store.selectSession(session)
  closeOnNarrow()
}
function openSkills() {
  store.view = 'skills'
  closeOnNarrow()
}
function startFrom(prompt: string) {
  store.draft = prompt
  void nextTick(() => composer.value?.focus())
}
const adopting = ref(false)
const draftContent = computed({
  get: () => store.draftContent,
  set: value => {
    store.draftContent = value
  }
})
const starters = [
  {
    label: '开一本新书',
    icon: 'fa-regular fa-file-lines',
    prompt: '帮我构思一本新作品，先和我确定题材与创作方向。'
  },
  {
    label: '续写与修改',
    icon: 'fa-solid fa-pen',
    prompt: '读取当前作品的目录和资料，帮我起草或修改指定章节。'
  },
  {
    label: '拆解参考书',
    icon: 'fa-solid fa-book-open',
    prompt: '我想拆解一本参考书，请引导我上传文件并确认拆书范围。'
  },
  {
    label: '查看榜单',
    icon: 'fa-solid fa-chart-column',
    prompt: '查看已有榜单快照，说明数据日期，并帮我分析创作方向。'
  }
]
const toolNames: Record<string, string> = {
  write_prose: '写正文候选', search_chapters: '查本书原文', plan_chapters: '写章纲',
  control_session: '控制当前阶段',
  read_memory: '读取长期记忆',
  remember_memory: '记住偏好或事实',
  forget_memory: '忘记一条记忆',
  confirm_materials: '确认保存作品资料',
  save_creation_draft: '保存创作候选',
  read_breakdown: '读取拆书资料',
  run_breakdown: '执行拆书',
  run_distillation: '蒸馏写作方法',
  run_batch: '批量写作',
  make_cover: '生成封面',
  control_task: '控制任务',
  reparse_book_attachment: '重新识别目录',
  list_rankings: '查看榜单目录',
  read_rankings: '读取榜单快照',
  refresh_rankings: '刷新指定榜单',
  list_books: '查看作品列表',
  read_book: '读取作品信息',
  read_platform_state: '查看会话状态',
  prepare_writing: '准备写作',
  list_chapters: '读取章节目录',
  read_chapter: '读取章节正文',
  read_references: '读取人物与设定',
  save_draft: '提交章节修改候选',
  save_new_chapter_draft: '保存新章节候选',
  save_outline_draft: '保存大纲修改建议',
  list_drafts: '查看已有草稿',
  read: '读取技能文件',
  run_skill_script: '运行技能脚本',
  read_style_examples: '取写法范例',
  search_writing_resources: '查找写作资源',
  read_writing_resource: '读取写作资源',
  save_skill_draft: '提交技能候选',
  ask_author: '等待作者决定'
}
const draftTarget = computed(() =>
  store.openedDraft?.kind === 'entity'
    ? entitySpecs[store.openedDraft.entity].label
    : store.openedDraft?.kind === 'outline'
      ? '大纲'
      : store.openedDraft?.kind === 'skill'
        ? '技能'
        : store.openedDraft?.kind==='short_story' ? '新书' : store.openedDraft?.kind==='text' ? '独立文本' : '章节'
)
const draftBookTitle = computed(() =>
  store.openedDraft?.kind === 'entity' && store.openedDraft.entity === 'book'
    ? '新作品'
    : store.openedDraft?.kind==='short_story' ? store.openedDraft.title : store.openedDraft?.kind==='text' ? '未绑定作品' : store.books.find(b => b.id === store.openedDraft?.bookId)?.title || '作品已删除'
)
const activeBook = computed(() => store.books.find(b => b.id === store.bookId))
const isWelcome = computed(
  () =>
    !store.messages.some(message => message.role === 'user' || message.role === 'assistant') &&
    !store.sessionFile &&
    !store.running &&
    !store.dialog &&
    !store.openedDraft &&
    !store.tasks.some(t => t.sessionId === store.sessionId)
)
const pageTitle = computed(
  () =>
    (store.view === 'skills' ? '技能' : store.view === 'resources' ? '写作资源' : store.view === 'memory' ? '记忆' : '') ||
    store.sessions.find(
      session =>
        session.localKey === store.activeKey || (!!store.sessionFile && session.file === store.sessionFile)
    )?.title ||
    activeBook.value?.title ||
    '新对话'
)
/** 右栏打开的任务结果：通用视图给标题，拆书报告面板另外要原始任务记录。 */
const openedResultView = computed(() => {
  const opened = store.openedResult
  return opened ? store.tasks.find(t => t.kind === opened.kind && t.id === opened.id) || null : null
})
const openedReportTask = computed(() =>
  store.openedResult?.kind === 'breakdown' ? breakdownTasks.value.find(task => task.id === store.openedResult?.id) || null : null
)
const openedDistillation = computed(() =>
  store.openedResult?.kind === 'distillation' ? distillationTasks.value.find(task => task.id === store.openedResult?.id) || null : null
)
const openedCover = computed(() =>
  store.openedResult?.kind === 'cover' ? coverTasks.value.find(task => task.id === store.openedResult?.id) || null : null
)
const RESULT_TITLES: Record<PiTaskKind, string> = { breakdown: '拆书报告', distillation: '写作方法', batch: '批量写作', cover: '封面' }
/** 右栏打开的故事状态账本：按作品，不是任务。 */
const openedLedger = computed(() => (store.openedResult?.kind === 'ledger' ? store.openedResult.id : ''))
const paneTitle = computed(() => {
  const draft = store.openedDraft
  if (draft) return draft.kind === 'entity' ? creationTitle(draft, draftContent.value) : draft.title
  if (openedLedger.value) return `《${store.books.find(b => b.id === openedLedger.value)?.title || ''}》故事状态`
  const view = openedResultView.value
  return view ? `《${view.title}》${RESULT_TITLES[view.kind]}` : ''
})
const paneSubtitle = computed(() => {
  if (store.openedDraft) return `${draftBookTitle.value} / ${targetDescription.value}`
  if (openedLedger.value) return ''
  const view = openedResultView.value
  if (!view) return ''
  return [view.scope, view.numbers[0]].filter(Boolean).join(' · ')
})
const targetDescription = computed(() => {
  const draft = store.openedDraft
  if (!draft) return ''
  if (draft.kind === 'entity') return entitySpecs[draft.entity].label
  if (draft.kind === 'outline') return draft.baseOutline.title
  if (draft.kind === 'new_chapter')
    return `${draft.volumeTitle} · 新章节${draft.appliedAt ? '（已创建）' : ' · 确认后追加卷末'}`
  if (draft.kind === 'skill') return draft.appliedAt ? '技能 · 已写进技能目录' : draft.replaceId ? '技能 · 替换已有技能' : '技能 · 新建'
  return draft.kind === 'chapter' ? draft.baseTitle : draft.kind === 'short_story' ? '独立短篇 · 新书首章' : '独立文本'
})
let lastPane: { kind: 'draft'; id: string } | { kind: 'result'; result: { kind: PiTaskKind | 'ledger'; id: string } } | null = null
watch(
  () => store.openedDraft?.id,
  (id, previous) => {
    documentExpanded.value = false
    if (previous && !id) lastPane = { kind: 'draft', id: previous }
  }
)
watch(
  () => store.openedResult,
  (result, previous) => {
    documentExpanded.value = false
    if (previous && !result) lastPane = { kind: 'result', result: previous }
  }
)
function onProseInput(event:Event){
  store.setDraftContent((event.target as HTMLTextAreaElement).value,typedByAuthor(event as InputEvent))
}
async function persistDraft() {
  const d = store.openedDraft
  if (d && !d.appliedAt && d.content !== draftContent.value) await store.editDraft(d.id, draftContent.value)
}
async function closeDraft() {
  if (adopting.value || switchingDraft.value) return
  const id = store.openedDraft?.id
  switchingDraft.value = true
  try {
    await persistDraft()
    store.openedDraft = null
    switchingDraft.value = false
    await nextTick()
    if (id) conversation.value?.focusDraft(id)
  } catch {
    /* 保存失败保留当前草稿 */
  } finally {
    switchingDraft.value = false
  }
}
async function selectResult(result: { kind: PiTaskKind | 'ledger'; id: string }) {
  if (adopting.value || switchingDraft.value) return
  const chat = store.activeKey
  switchingDraft.value = true
  try {
    await persistDraft()
    if (store.activeKey !== chat) return
    store.openedDraft = null
    store.openedResult = result
    await nextTick()
    documentTitle.value?.focus()
  } catch {
    /* 保存失败保留当前草稿 */
  } finally {
    switchingDraft.value = false
  }
}
function closePane() {
  if (store.openedDraft) return closeDraft()
  store.openedResult = null
}
async function selectDraft(id: string) {
  if (adopting.value || switchingDraft.value || store.inputLocked) return
  const chat = store.activeKey
  switchingDraft.value = true
  try {
    await persistDraft()
    if (store.activeKey !== chat) return
    store.openedResult = null
    store.openedDraft = store.drafts.find(d => d.id === id) || null
    await nextTick()
    documentTitle.value?.focus()
  } catch {
    /* 保存失败保留当前草稿 */
  } finally {
    switchingDraft.value = false
  }
}
async function copyText() {
  try {await navigator.clipboard.writeText(draftContent.value)}
  catch {const field=document.querySelector<HTMLTextAreaElement>('.pi-draft-editor');field?.focus();field?.select()}
}
async function adopt() {
  if (adopting.value) return
  adopting.value = true
  try {
    const confirmation = await store.prepareAdoption(draftContent.value)
    if (!confirmation) return
    if (confirmation.draft.appliedAt) {
      await store.adopt(confirmation)
      return
    }
    const book = store.books.find(b => b.id === confirmation.draft.bookId)?.title || '当前作品'
    await inkConfirm(
      confirmation.draft.kind === 'entity'
        ? creationSummary(confirmation.draft) +
            (confirmation.draft.entity === 'book'
              ? '保存后可选择新作品开始对话。'
              : `目标作品：《${book}》。`)
        : confirmation.draft.kind === 'short_story' ? `采用后将创建《${confirmation.draft.title}》并写入当前编辑的完整首章。`
        : confirmation.draft.kind === 'skill'
          ? `${skillDraftFields(confirmation.draft.content).replaceId ? '更新' : '新建'}技能「${skillDraftFields(confirmation.draft.content).name}」，写进技能目录，输入 / 就能用。`
        : confirmation.draft.kind === 'outline'
          ? '采用后将更新目标大纲，请确认修改内容。'
          : confirmation.draft.kind === 'new_chapter'
            ? `将在《${book}》的「${confirmation.draft.volumeTitle}」创建「${confirmation.draft.title}」，追加到保存时的卷末。请确认归属和当前草稿内容。`
            : `将保存到《${book}》的「${confirmation.draft.title}」，原文保留在章节历史中。请确认当前草稿内容。`,
      '采用草稿',
      { confirmButtonText: '采用并保存', cancelButtonText: '取消' }
    )
    await store.adopt(confirmation)
  } catch {
    // 取消不保存；准备失败由工作区显示错误，当前编辑内容保留。
  } finally {
    adopting.value = false
  }
}
/** 一轮里生成的多份候选一次采用：资料和不覆盖正文的章节；改稿仍逐份看。 */
async function adoptAll(ids: string[]) {
  if (adopting.value || !ids.length) return
  adopting.value = true
  try {
    await persistDraft()
    const confirmations = await store.prepareAdoptionBatch(ids)
    await inkConfirm(confirmations.map((c, i) => `${i + 1}. ${c.draft.title}`).join('\n') + '\n仅保存以上候选的当前确认版本。', `确认采用这 ${confirmations.length} 份候选`, { confirmButtonText: '采用并保存', cancelButtonText: '取消' })
    await store.adoptAll(ids, confirmations)
  } catch {
    // 失败由工作区显示错误，已写入的保留。
  } finally {
    adopting.value = false
  }
}
/** ⌘. 收起右栏；再按一次重新打开最近看过的文档。 */
async function togglePane() {
  if (store.openedDraft || openedResultView.value) {
    await closePane()
    return
  }
  if (lastPane?.kind === 'result') {
    const wanted = lastPane.result
    if (store.tasks.some(t => t.kind === wanted.kind && t.id === wanted.id)) return selectResult(wanted)
  }
  const remembered = lastPane?.kind === 'draft' ? lastPane.id : ''
  const id = remembered && store.drafts.some(d => d.id === remembered) ? remembered : store.drafts[store.drafts.length - 1]?.id
  if (id) await selectDraft(id)
}
function onShortcut(event: KeyboardEvent) {
  const action = matchShortcut(event)
  if (!action || action === 'send') return
  const dialogOpen = !!document.querySelector(
    '.ew-modal-container[data-managed-focus], .el-message-box, .el-dropdown__popper[aria-hidden="false"]'
  )
  if (action === 'stop') {
    if (dialogOpen || store.dialog) return
    if (store.running && !store.stopping) {
      event.preventDefault()
      void store.stop()
    } else if (window.innerWidth <= 900) sidebarOpen.value = false
    return
  }
  if (dialogOpen) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (action === 'search') sidebar.value?.openSearch()
  else if (action === 'new') void newChat()
  else if (action === 'pane') void togglePane()
}
function onFocusBack() {
  if (document.visibilityState === 'visible') void store.resync()
}
onMounted(() => {
  document.body.classList.add('pi-workspace-active')
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onShortcut, true)
  window.addEventListener('focus', onFocusBack)
  document.addEventListener('visibilitychange', onFocusBack)
  void store.initialize()
})
onBeforeRouteLeave(async () => {
  if (store.closing) return false
  try {
    await persistDraft()
  } catch {
    return false
  }
})
onUnmounted(() => {
  document.body.classList.remove('pi-workspace-active')
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onShortcut, true)
  window.removeEventListener('focus', onFocusBack)
  document.removeEventListener('visibilitychange', onFocusBack)
})
</script>
