<template>
  <div ref="scroller" class="pi-chat-scroll" @scroll="onScroll">
    <div class="pi-messages" aria-live="polite" aria-relevant="additions text">
      <template v-for="(turn, index) in turns" :key="turn.id">
        <article v-if="turn.user && userEvent(turn.user)" class="pi-chat-message is-event">
          <div class="pi-event-chip">
            <i class="fa-solid fa-book-open" aria-hidden="true"></i
            ><span>{{ eventChipText(userEvent(turn.user)!) }}</span>
          </div>
        </article>
        <article v-else-if="turn.user" class="pi-chat-message is-user user">
          <div v-if="userSkill(turn.user)" class="pi-message-tags">
            <span class="pi-message-tag is-skill"
              ><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>{{ userSkill(turn.user) }}</span
            >
          </div>
          <div
            v-if="userFile(turn.user)"
            class="pi-message-attachment"
            :class="`is-${attachmentView(userFile(turn.user)!).status}`"
            :role="attachmentView(userFile(turn.user)!).status === 'importing' ? 'status' : undefined"
          >
            <i :class="attachmentView(userFile(turn.user)!).icon" aria-hidden="true"></i
            ><span>{{ userFile(turn.user)!.filename }}</span
            ><small>{{ attachmentView(userFile(turn.user)!).text }}</small>
          </div>
          <div class="pi-user-message">
            <template v-for="(part, partIndex) in userParts(turn.user)" :key="partIndex"
              ><span v-if="part.reference" class="pi-message-mention" :title="part.reference.title">{{
                part.text.slice(1)
              }}</span
              ><template v-else>{{ part.text }}</template></template
            >
          </div>
          <div class="pi-message-actions is-user">
            <button aria-label="复制消息" title="复制内容" @click="copy(userText(turn.user))">
              <i class="fa-regular fa-copy" aria-hidden="true"></i>
            </button>
          </div>
        </article>
        <article
          v-if="
            turn.segments.length ||
            turn.steps.length ||
            turn.drafts.length ||
            turnTasks(turn).length ||
            turn.running ||
            turn.error ||
            turn.stopped ||
            turn.questions.length ||
            (index === turns.length - 1 && store.pendingQuestion)
          "
          class="pi-chat-message is-assistant assistant"
          :data-turn-id="turn.id"
        >
          <div class="pi-assistant-identity"><img src="/logo.png" alt="" /><strong>易创</strong></div>
          <div class="pi-assistant-body">
            <div class="pi-reply-divider"><span class="pi-reply-rule" aria-hidden="true"></span></div>
            <!-- 一条回复里的每一轮：作者的话开始第一轮，任务（拆书、蒸馏、封面）完成后接着说的是后面几轮，
                 每轮各有过程区、正文、文档卡和任务卡；事件标签是轮与轮之间的一行。 -->
            <template v-for="(round, roundIndex) in turn.rounds" :key="round.id">
              <div v-if="roundIndex > 0 && round.event" class="pi-event-chip is-round">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i><span>{{ eventChipText(round.event) }}</span>
              </div>
              <PiProcessBlock
                :steps="round.steps"
                :running="round.running"
                :answered="!!round.answer"
                :thinking-ms="round.thinkingMs"
                :labels="labels"
              />
              <!-- 主流程：模型写的文字和它问的卡按发生顺序排列；挂着的卡就在它出现的位置。 -->
              <template v-for="segment in round.segments" :key="segment.id">
                <!-- eslint-disable-next-line vue/no-v-html -- 继续使用禁用原始 HTML 的平台解析器。 -->
                <div v-if="segment.kind === 'text'" class="pi-message-body" v-html="renderMarkdown(segment.text)"></div>
                <Transition v-else name="pi-card" mode="out-in">
                  <PiQuestionCard
                    v-if="!segment.answer && pendingFor(segment.id)"
                    :key="`card:${segment.id}`"
                    :spec="pendingFor(segment.id)!.spec"
                    :busy="store.answering"
                    @answer="store.answerQuestion"
                    @cancel="store.answerQuestion({ selected: [], selectedIds: [], cancelled: true })"
                  />
                  <PiQuestionRecord v-else :key="`record:${segment.id}`" :spec="segment.spec" :answer="segment.answer" />
                </Transition>
            </template>
            <Transition name="pi-card">
              <PiQuestionCard
                v-if="index === turns.length - 1 && roundIndex === turn.rounds.length - 1 && store.pendingQuestion && !placedInline(turn)"
                :key="store.pendingQuestion.id"
                :spec="store.pendingQuestion.spec"
                :busy="store.answering"
                @answer="store.answerQuestion"
                @cancel="store.answerQuestion({ selected: [], selectedIds: [], cancelled: true })"
              />
            </Transition>
            <p v-if="round.running && !round.segments.length && !round.steps.length && !store.pendingQuestion" class="pi-stream-status" role="status">
              正在处理…
            </p>
            <div v-if="round.drafts.length" class="pi-document-cards" aria-label="本轮生成的文档">
              <button
                v-for="document in round.drafts"
                :key="document.id"
                class="pi-document-card"
                :data-draft-id="document.id"
                :aria-label="`打开文档：${documentTitle(document)}，${document.appliedAt ? '已采用' : '待采用'}`"
                :aria-pressed="store.openedDraft?.id === document.id"
                :disabled="documentLocked || store.inputLocked"
                @click="$emit('open-draft', document.id)"
              >
                <i class="fa-regular fa-file-lines pi-document-card-icon" aria-hidden="true"></i>
                <span class="pi-document-card-text">
                  <strong>{{ documentTitle(document) }}</strong>
                  <span
                    >{{ documentKind(document) }}<span aria-hidden="true"> · </span
                    >{{ document.appliedAt ? '已采用' : '待采用' }}</span
                  >
                </span>
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
              </button>
              <button
                v-if="adoptable(round).length > 0"
                type="button"
                class="pi-text-link pi-document-adopt-all"
                :disabled="documentLocked || store.busy || round.running"
                @click="$emit('adopt-all', adoptable(round).map(d => d.id))"
              >
                {{ adoptable(round).length > 1 ? '全部采用' : '确认采用' }}（{{ adoptable(round).length }}）
              </button>
            </div>
            <p v-if="round.drafts.some(d => !d.appliedAt && !d.dismissedAt)" class="pi-candidate-notice" role="status">
              {{ round.running ? (store.pendingQuestion ? '正在等待你的回答，请使用上方确认卡；其余候选可以先预览。' : '本轮内容仍在生成，可以先预览；完成后再确认采用。') : '候选尚未写入作品。请预览后采用或调整；继续讨论不会自动保存。' }}
            </p>
            <PiTaskCard
              v-for="task in tasksFor(round)"
              :key="`${task.kind}:${task.id}`"
              :view="task"
              :opened="store.openedResult?.kind === task.kind && store.openedResult?.id === task.id"
              @open-result="$emit('open-result', $event)"
              @continue="store.continueAfterTask($event, true)"
            />
            <PiRunNotice
              v-if="!round.stopped"
              :error="round.error"
              :retrying="round.running && !!store.retry"
              :recovered-errors="round.recoveredErrors"
              :has-candidates="round.drafts.some(d => !d.appliedAt)"
              :has-saved="round.drafts.some(d => !!d.appliedAt)"
            />
            <p v-if="round.stopped" class="pi-stopped">已停止，已生成的内容保留。</p>
            </template>
            <div v-if="turn.segments.some(segment => segment.kind === 'text')" class="pi-message-actions">
              <button class="pi-copy" aria-label="复制消息" title="复制内容" @click="copy(turnText(turn))">
                <i class="fa-regular fa-copy" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </article>
      </template>
      <PiTaskCard
        v-for="task in unanchored"
        :key="`${task.kind}:${task.id}`"
        :view="task"
        :opened="store.openedResult?.kind === task.kind && store.openedResult?.id === task.id"
        @open-result="$emit('open-result', $event)"
        @continue="store.continueAfterTask($event, true)"
      />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usePiWorkspace } from './use-pi-workspace'
import { buildPiTurns, eventChipText, parseEventMessage, piMessageText, placeTasks } from '@/agent-pi/conversation'
import type { PiTurn, PiTurnRound, PiTurnSegment } from '@/agent-pi/conversation'
import { renderMarkdown } from '@/utils/markdown'
import { creationTitle, entitySpecs } from '@/agent-pi/creation'
import { skillDraftTitle } from '@/agent-pi/skill-draft'
import PiTaskCard from '@/components/PiTaskCard.vue'
import PiProcessBlock from './PiProcessBlock.vue'
import PiRunNotice from './PiRunNotice.vue'
import type { PiTaskKind } from '@/agent-pi/tasks'
import PiQuestionCard from './PiQuestionCard.vue'
import PiQuestionRecord from './PiQuestionRecord.vue'
import { importLive, importProgressText, parseAttachmentMessage } from '@/agent-pi/attachments'
import { parseSkillCommand, skillDisplayName } from '@/agent-pi/skills'
import { parseReferenceMessage } from '@/agent-pi/references'
import { findMentionTokens } from './composer-menu'
import type { PiMessage } from '@/types/agent-pi'
import type { PiDraft } from '@/types/agent-pi'
defineProps<{ labels: Record<string, string>; documentLocked?: boolean }>()
defineEmits<{
  (event: 'open-draft', id: string): void
  (event: 'open-result', result: { kind: PiTaskKind; id: string }): void
  (event: 'adopt-all', ids: string[]): void
}>()
/** 一轮里还没采用的候选：资料（人物、设定、大纲等）和不覆盖任何正文的章节（新章、填空白章）；改已有正文的改稿仍逐份看。 */
const adoptable = (round: PiTurnRound) =>
  round.drafts.filter(
    d => !d.appliedAt && !d.dismissedAt && (d.kind === 'entity' || d.kind === 'outline' || d.kind === 'new_chapter' || (d.kind === 'chapter' && !d.baseText.trim()))
  )
const store = usePiWorkspace(),
  scroller = ref<HTMLElement>(),
  followBottom = ref(true)
const sessionTasks = computed(() => store.tasks.filter(t => t.sessionId === store.sessionId))
const turns = computed(() =>
  buildPiTurns(store.messages, store.activities, store.running, store.stopped, store.drafts, store.thinkingMs, sessionTasks.value)
)
/** 任务卡放在哪一轮由数据层按"谁启动、谁读过"定；别的对话或工作台启动而这里读过的任务也有卡，作为查看结果的入口。 */
const placement = computed(() => placeTasks(turns.value, store.tasks, store.sessionId || ''))
const tasksFor = (round: PiTurnRound) => placement.value.byRound.get(round.id) || []
const turnTasks = (turn: PiTurn) => turn.rounds.flatMap(tasksFor)
const unanchored = computed(() => placement.value.unplaced)
/** 作者消息的几层外衣：技能命令在最外面，然后是附件标记，最后是 @ 的资料；剥掉后才是作者的话。 */
const bodyOf = (message: PiMessage) => {
  const raw = piMessageText(message)
  return parseSkillCommand(raw)?.text ?? raw
}
const userSkill = (message: PiMessage) => skillDisplayName(parseSkillCommand(piMessageText(message))?.skill || '')
const userText = (message: PiMessage) => parseReferenceMessage(parseAttachmentMessage(bodyOf(message)).text).text
/** 作者的话按 @标题 切开，引用那段单独上色；复制时仍是原文。 */
const userParts = (message: PiMessage) => {
  const { text, references } = parseReferenceMessage(parseAttachmentMessage(bodyOf(message)).text)
  const parts: Array<{ text: string; reference: (typeof references)[number] | null }> = []
  let cursor = 0
  for (const token of findMentionTokens(text, references).sort((a, b) => a.start - b.start)) {
    if (token.kind !== 'ref') continue
    if (token.start > cursor) parts.push({ text: text.slice(cursor, token.start), reference: null })
    parts.push({ text: text.slice(token.start, token.end), reference: token.reference })
    cursor = token.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), reference: null })
  return parts
}
const userEvent = (message: PiMessage) => parseEventMessage(piMessageText(message)).event
const userFile = (message: PiMessage) => parseAttachmentMessage(bodyOf(message)).file
/** 附件卡的状态：正在跑的入库看实时进度，其余按宿主记录；没有记录时只显示章数。 */
const attachmentView = (file: { id: string; chapterCount?: number }) => {
  const live = importLive.value[file.id],
    record = store.attachments[file.id]
  if (live) return { status: 'importing', icon: 'fa-solid fa-circle-notch fa-spin', text: `正在入库 · ${importProgressText(live)}` }
  if (record?.status === 'failed')
    return { status: 'failed', icon: 'fa-solid fa-triangle-exclamation', text: `入库失败：${record.error || '原因未知'}` }
  if (record?.status === 'ready')
    return { status: 'ready', icon: 'fa-regular fa-file-lines', text: `已导入 · ${record.chapterCount} 章` }
  if (record?.status === 'importing') return { status: 'importing', icon: 'fa-solid fa-circle-notch fa-spin', text: '正在入库…' }
  return { status: 'unknown', icon: 'fa-regular fa-file-lines', text: file.chapterCount ? `${file.chapterCount} 章` : 'TXT 文件' }
}
const documentTitle = (draft: PiDraft) => (draft.kind === 'entity' ? creationTitle(draft) : draft.kind === 'skill' ? skillDraftTitle(draft) : draft.title)
const documentKind = (draft: PiDraft) =>
  draft.kind === 'entity'
    ? entitySpecs[draft.entity].label
    : draft.kind === 'outline'
      ? '大纲'
      : draft.kind === 'new_chapter'
        ? '新章节'
        : draft.kind === 'skill'
          ? '技能'
          : draft.kind === 'short_story' ? '独立短篇' : draft.kind === 'text' ? '独立文本' : '章节正文'
const turnText = (turn: PiTurn) =>
  turn.segments
    .filter((segment): segment is Extract<PiTurnSegment, { kind: 'text' }> => segment.kind === 'text')
    .map(segment => segment.text)
    .join('\n\n')
/** 挂着的卡就渲染在它出现的位置；Pi 原生询问没有对应的工具调用，放在这一轮末尾。 */
const pendingFor = (callId: string) =>
  store.pendingQuestion?.source === 'tool' && store.pendingQuestion.callId === callId ? store.pendingQuestion : null
const placedInline = (turn: PiTurn) =>
  turn.segments.some(segment => segment.kind === 'question' && !segment.answer && !!pendingFor(segment.id))
defineExpose({
  focusDraft: (id: string) =>
    Array.from(scroller.value?.querySelectorAll<HTMLButtonElement>('[data-draft-id]') || [])
      .find(card => card.dataset.draftId === id)
      ?.focus()
})

function onScroll() {
  const e = scroller.value
  if (e) followBottom.value = e.scrollHeight - e.clientHeight - e.scrollTop < 80
}
async function scrollToLatest() {
  await nextTick()
  if (followBottom.value && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}
// 只观察显示内容，避免每个 token 都深遍历完整榜单/资料工具结果；阅读上文时不强制滚回底部。
watch(
  () => {
    const last = turns.value[turns.value.length - 1]
    return [
      store.messages.length,
      last?.segments.length,
      last?.segments[last.segments.length - 1]?.kind === 'text' ? turnText(last).length : 0,
      last?.steps.length,
      last?.steps[last.steps.length - 1]?.text?.length,
      store.activities.map(a => `${a.status}${a.progress || ''}`).join('|'),
      store.pendingQuestion?.id,
      last?.questions.filter(q => q.answer).length,
      last?.drafts.length
    ]
  },
  scrollToLatest,
  { flush: 'post' }
)
onMounted(scrollToLatest)
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择内容')
  }
}
</script>

<style scoped>
.pi-message-attachment {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  max-width: 100%;
  padding: 10px 0;
  color: var(--pi-muted);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.pi-message-attachment span {
  overflow-wrap: anywhere;
}
.pi-message-attachment small {
  white-space: nowrap;
}
.pi-message-attachment.is-failed small {
  white-space: normal;
  color: var(--pi-accent);
}
.pi-message-attachment.is-importing > i {
  color: var(--pi-accent);
}
</style>
