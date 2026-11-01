<template>
  <div class="panel-content ai-chat-panel" :class="{ 'is-expanded': isExpanded }">
    <div class="panel-header">
      <div class="panel-title">
        <span class="name text-ellipsis" :title="currentSessionTitle || title">
          {{ currentSessionTitle || title }}
        </span>
        <span class="meta" v-if="sessionList.length">共 {{ sessionList.length }} 个对话</span>
      </div>
      <div class="panel-actions">
        <el-tooltip content="删除当前会话" placement="bottom" :show-after="500">
          <i class="fa-solid fa-trash-can action-icon" @click="handleClearSession"></i>
        </el-tooltip>

        <SmartPopover
:width="280" placement="bottom-end" trigger="click" @update:visible="showHistoryPopover = $event"
          ref="historyPopoverRef">
          <template #trigger>
            <span class="popover-ref">
              <el-tooltip content="历史对话" placement="bottom" :show-after="500">
                <i class="fa-solid fa-clock-rotate-left action-icon" :class="{ active: showHistoryPopover }"></i>
              </el-tooltip>
            </span>
          </template>

          <div class="ai-history-popper">
            <div class="history-panel">
              <div class="history-header">
                <span>历史对话</span>
                <button class="ink-btn-action" @click="startNewChat">
                  <i class="fa-solid fa-plus"></i> 新建
                </button>
              </div>
              <el-scrollbar height="120px">
                <div v-if="!sessionList.length" class="history-empty">
                  <el-empty description="暂无对话" :image-size="60" />
                </div>
                <template v-else>
                  <div
v-for="session in sessionList" :key="session.id" class="history-item"
                    :class="{ active: session.id === currentSessionId }" @click="switchSession(session)">
                    <div class="info">
                      <span v-if="editingSessionId !== session.id" class="text-ellipsis">{{ session.title }}</span>
                      <el-input
v-else v-model="renameInput" size="small" maxlength="30" class="ink-select"
                        @keyup.enter="confirmRename(session)" @blur="confirmRename(session)" @click.stop />
                    </div>
                    <div class="ops">
                      <el-tooltip content="重命名" placement="top" :show-after="500">
                        <i class="fa-solid fa-pen-to-square action-btn" @click.stop="startRename(session)"></i>
                      </el-tooltip>
                      <el-tooltip content="删除" placement="top" :show-after="500">
                        <i
class="fa-solid fa-trash action-btn delete"
                          @click.stop="handleDeleteSession(session.id)"></i>
                      </el-tooltip>
                    </div>
                  </div>
                </template>
              </el-scrollbar>
            </div>
          </div>
        </SmartPopover>

        <el-tooltip :content="isExpanded ? '收起' : '展开面板'" placement="bottom" :show-after="500">
          <i class="fa-solid fa-expand action-icon" :class="{ active: isExpanded }" @click="toggleExpand"></i>
        </el-tooltip>

        <i class="fa-solid fa-xmark action-icon" @click="$emit('close')"></i>
      </div>
    </div>

    <div class="panel-body chat-body">
      <el-scrollbar ref="scrollRef" class="chat-scroll">
        <div v-if="messages.length === 0" class="empty-state">
          <div class="icon-wrapper">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
          </div>
          <p>我是你的 AI 助手。你可以先打招呼，也可以聊小说灵感、剧情、人物、设定，或者直接自由提问。</p>
          <div class="suggestions">
            <el-tag
v-for="item in quickPrompts" :key="item" size="small" effect="plain" class="suggestion-tag"
              @click="quickAsk(item)">
              {{ item }}
            </el-tag>
          </div>
        </div>

        <div v-for="(msg, index) in messages" :key="msg.localId || msg.id || index" :class="['chat-message', msg.role]">
          <div class="avatar">
            <i :class="msg.role === 'ai' ? 'fa-solid fa-wand-magic-sparkles' : 'fa-solid fa-user-pen'"></i>
          </div>
          <div class="message-block">
            <!-- eslint-disable-next-line vue/no-v-html -- markdown-it 以 html:false 渲染，原始 HTML 不透传 -->
            <div class="message-text" v-html="renderMarkdown(msg.content)"></div>
            <div class="typing" v-if="msg.loading">
              <i class="fa-solid fa-ellipsis fa-beat-fade"></i>
              AI 正在思考...
            </div>
            <div class="reference-tags" v-if="msg.references?.length">
              <el-tag v-for="refItem in msg.references" :key="refItem.id" size="small" type="info" effect="plain">
                {{ refItem.label }}
              </el-tag>
            </div>
            <div class="message-ops">
              <el-tooltip content="复制" placement="top">
                <i class="fa-regular fa-copy" @click="copyText(msg.content)"></i>
              </el-tooltip>
              <el-tooltip v-if="msg.role === 'ai' && !msg.loading" content="再次回答" placement="top">
                <i class="fa-solid fa-rotate-right" @click="regenerateFrom(index)"></i>
              </el-tooltip>
              <el-tooltip content="删除" placement="top">
                <i class="fa-regular fa-trash-can" @click="handleDeleteMessage(msg, index)"></i>
              </el-tooltip>
            </div>
          </div>
        </div>
      </el-scrollbar>

      <div class="chat-input-area">
        <div class="input-container">
          <div class="input-toolbar">
            <div class="left-tools">
              <SmartPopover :width="260" placement="top-start" trigger="click" @show="handleChapterPickerShow">
                <template #trigger>
                  <span class="popover-ref">
                    <el-button text size="small">
                      <el-icon>
                        <Link />
                      </el-icon> 关联章节
                    </el-button>
                  </span>
                </template>
                <div class="chapter-picker-popover">
                  <div class="chapter-picker">
                    <el-input v-model="chapterSearch" size="small" placeholder="搜索章节" clearable />
                    <el-scrollbar height="180px">
                      <div v-if="chapterLoading" class="chapter-option muted">加载中...</div>
                      <div v-else-if="!filteredChapterOptions.length" class="chapter-option muted">
                        暂无可引用章节
                      </div>
                      <div
v-else v-for="item in filteredChapterOptions" :key="item.id" class="chapter-option"
                        @click="addChapterReference(item)">
                        <i class="fa-regular fa-note-sticky"></i>
                        <div class="title text-ellipsis">{{ item.title }}</div>
                        <span class="add">引用</span>
                      </div>
                    </el-scrollbar>
                  </div>
                </div>
              </SmartPopover>

              <el-button v-if="hasReferences" text size="small" @click="clearReferences">
                <el-icon>
                  <Delete />
                </el-icon> 清空引用
              </el-button>
            </div>
            <div class="right-tools">
              <span class="stat-text">共 {{ wordCount + totalReferencedWordCount }} 字</span>
            </div>
          </div>

          <div class="ref-tags-wrapper" v-if="hasReferences">
            <div class="ref-group" v-if="referencedChapters.length">
              <label>章节</label>
              <el-tag
v-for="chap in referencedChapters" :key="chap.id" size="small" closable
                @close="removeChapterRef(chap.id)">
                {{ chap.title }}
              </el-tag>
            </div>
            <div class="ref-group" v-if="referencedSelections.length">
              <label>选区</label>
              <el-tag
v-for="sel in referencedSelections" :key="sel.id" size="small" closable
                @close="removeSelectionRef(sel.id)">
                {{ sel.title }} · {{ sel.range }}
              </el-tag>
            </div>
          </div>

          <div class="input-box">
            <textarea
v-model="inputValue" class="custom-textarea" placeholder="可以先打招呼，也可以问：这章怎么接、这种题材有什么灵感，或者直接自由提问。" rows="4"
              @keydown.ctrl.enter.prevent="handleSend" @keydown.meta.enter.prevent="handleSend"></textarea>
          </div>

          <div class="input-footer">
            <div class="footer-left">
              <el-select
v-model="selectedTemplate" placeholder="咨询方向" size="small" class="ink-select"
                popper-class="ink-select-popper">
                <el-option v-for="item in templateOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <ModelChip v-model="chatModelOverride" group-code="text_assist" compact class="chat-model-chip" />
            </div>
            <div class="footer-right">
              <el-button v-if="isGenerating" type="danger" circle class="send-btn" @click="stopGenerate">
                <el-icon>
                  <VideoPause />
                </el-icon>
              </el-button>
              <el-button
v-else type="primary" circle class="send-btn" :disabled="!inputValue.trim()"
                @click="handleSend">
                <el-icon>
                  <Position />
                </el-icon>
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { loadCharacterContext } from '@/storage/character-context'
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import type { PopoverInstance, ScrollbarInstance } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { Link, Position, VideoPause, Delete } from '@element-plus/icons-vue'
import SmartPopover from '@/components/SmartPopover.vue'
// 开源版：对话走本地 BYOK 直连（流式），会话与历史存本机；章节引用读本地写作存储
import { streamLocalChatCompletion } from '@/utils/local-ai-client'
import { buildMiaobiMessages } from '@/config/ai-prompts'
import {
  listLocalChatSessions as getAiSessionListApi,
  createLocalChatSession as createAiSessionApi,
  getLocalChatHistory as getAiHistoryApi,
  deleteLocalChatSessions as deleteAiSessionApi,
  deleteLocalChatMessage as deleteAiMessageApi,
  renameLocalChatSession as renameAiSessionApi,
  appendLocalChatMessages,
} from '@/storage/local-ai-chat'
import { showApiError } from '@/utils/api-error'
import {
  getLocalBookTreeData as getBookTreeApi,
  getLocalChapterDetailData as getChapterDetailApi,
} from '@/storage/local-reference'
import { useAiModelStore } from '@/stores/ai-model'
import { promptTemperature, promptText } from '@/storage/local-prompts'
import { useAiChatStore, type AiSelectionItem } from '@/stores/ai-chat'
import { useWritingEditorStore } from '@/stores/writing-editor'
import ModelChip from '@/components/ModelChip.vue'
import { renderMarkdown } from '@/utils/markdown';

interface SessionItem {
  id: number | string
  title: string
}

interface ChatMessage {
  id?: number
  localId?: string
  role: 'user' | 'ai'
  content: string
  loading?: boolean
  references?: { id: string; label: string }[]
}


interface ChapterOption {
  id: number
  title: string
}

interface ChapterReference extends ChapterOption {
  content?: string
  loading?: boolean
}

interface BookTreeNode {
  id: number
  title: string
  type?: string
  nodeType?: number
  children?: BookTreeNode[]
}

const props = defineProps<{
  title: string
  bookId?: string | number
}>()

defineEmits<{ (e: 'close'): void }>()

const writingStore = useWritingEditorStore()
const aiChatStore = useAiChatStore()

const sessionList = ref<SessionItem[]>([])
const currentSessionId = ref<number | string | null>(null)
const currentSessionTitle = ref('')
const messages = ref<ChatMessage[]>([])
const inputValue = ref('')
const isGenerating = ref(false)
let abortController: AbortController | null = null
// 切换会话前结束当前请求，半截回答仍保存到发起请求的会话。
let requestFinished: Promise<void> = Promise.resolve()

const showHistoryPopover = ref(false)
const historyPopoverRef = ref<PopoverInstance | null>(null)
const editingSessionId = ref<number | null>(null)
const renameInput = ref('')

const referencedChapters = ref<ChapterReference[]>([])
const referencedSelections = ref<AiSelectionItem[]>([])
const chapterOptions = ref<ChapterOption[]>([])
const chapterSearch = ref('')
const chapterLoading = ref(false)
const chapterCache = new Map<number, string>()
const chapterOptionsLoaded = ref(false)

const isExpanded = ref(false)
const originalPanelWidth = ref<number | null>(null)
const scrollRef = ref<ScrollbarInstance | null>(null)

interface TemplateOption {
  label: string
  value: string
  hint: string
  /** 提示词库 miaobi 场景里的槽位 key（指令文本用户可改） */
  promptSlot: string
}

const templateOptions: TemplateOption[] = [
  {
    label: '剧情顾问',
    value: 'plot_advisor',
    hint: '帮你判断这一章该怎么推进、冲突够不够、下一拍怎么接。',
    promptSlot: 'plotAdvisor'
  },
  {
    label: '人物顾问',
    value: 'character_advisor',
    hint: '帮你看人物动机、人设稳定性、关系变化和台词是否对味。',
    promptSlot: 'characterAdvisor'
  },
  {
    label: '设定顾问',
    value: 'setting_advisor',
    hint: '帮你检查设定是否自洽，有没有穿帮、越界或规则冲突。',
    promptSlot: 'settingAdvisor'
  },
  {
    label: '文案顾问',
    value: 'copy_advisor',
    hint: '帮你改标题、简介、章节钩子和卖点表达。',
    promptSlot: 'copyAdvisor'
  }
]
const selectedTemplate = ref<TemplateOption['value']>(templateOptions[0].value)
// 本面板临时覆盖模型：空值 = 跟随「AI 模型」页的全局默认；选择不回写全局
const chatModelOverride = ref('')
const aiModelStore = useAiModelStore()
const activeTemplateHint = computed(() => {
  return templateOptions.find(item => item.value === selectedTemplate.value)?.hint || ''
})
const activeTemplateInstruction = () => {
  const slot = templateOptions.find(item => item.value === selectedTemplate.value)?.promptSlot
  return slot ? promptText('miaobi', slot) : ''
}

const quickPrompts = [
  '你好',
  '你好，我想写一篇读书奇谈，你能先给我几个方向吗？',
  '这一章的冲突够不够，下一拍该怎么接？',
  '主角现在的动机站得住吗？',
  '这段设定有没有穿帮或越界？',
  '这个开头的钩子够不够吸引人？'
]

const bookIdValue = computed(() => {
  if (props.bookId === undefined || props.bookId === null) return ''
  const val = String(props.bookId)
  return val
})

const numericBookId = computed(() => {
  const raw = Number(bookIdValue.value)
  // 本地书号是负数（与本地实体 ID 同规约），非零即有效；raw > 0 是服务端时代的校验
  return Number.isFinite(raw) && raw !== 0 ? raw : null
})

const wordCount = computed(() => inputValue.value.trim().length)
const totalReferencedWordCount = computed(() => {
  let sum = 0
  referencedChapters.value.forEach(ch => {
    sum += (ch.content || '').length
  })
  referencedSelections.value.forEach(sel => {
    sum += (sel.content || '').length
  })
  return sum
})
const hasReferences = computed(() => referencedChapters.value.length > 0 || referencedSelections.value.length > 0)
const filteredChapterOptions = computed(() => {
  const keyword = chapterSearch.value.trim().toLowerCase()
  const pickedIds = referencedChapters.value.map(ch => ch.id)
  return chapterOptions.value
    .filter(item => !pickedIds.includes(item.id))
    .filter(item => !keyword || item.title.toLowerCase().includes(keyword))
})

// const renderMessage = (content: string) => {
//   if (!content) return ''
//   return content
//     .replace(/&/g, '&amp;')
//     .replace(/</g, '&lt;')
//     .replace(/>/g, '&gt;')
//     .replace(/\n/g, '<br />')
// }

const scrollToBottom = () => {
  nextTick(() => {
    if (scrollRef.value && typeof scrollRef.value.setScrollTop === 'function') {
      scrollRef.value.setScrollTop(999999)
    }
  })
}

const resetState = () => {
  abortController?.abort()
  currentSessionId.value = null
  currentSessionTitle.value = ''
  messages.value = []
  referencedChapters.value = []
  referencedSelections.value = []
  inputValue.value = ''
}

const loadSessions = async () => {
  if (!bookIdValue.value) return
  try {
    const requestedBook = bookIdValue.value
    const res = await getAiSessionListApi({ bookId: requestedBook })
    if (bookIdValue.value !== requestedBook) return
    sessionList.value = res.data || []
    if (sessionList.value.length && !currentSessionId.value) {
      switchSession(sessionList.value[0])
    }
  } catch (error) {
    console.error('加载会话列表失败', error)
  }
}

const loadHistory = async (sessionId: number | string, keepPosition = false) => {
  try {
    const res = await getAiHistoryApi({ sessionId: String(sessionId) })
    if (currentSessionId.value !== sessionId) return
    const list = res.data || []
    messages.value = list.map(item => ({
      id: item.id,
      role: item.role,
      content: item.content
    }))
    if (!keepPosition) scrollToBottom()
  } catch (error) {
    showApiError(error, '加载对话记录失败')
  }
}

const switchSession = async (session: SessionItem) => {
  if (session.id === currentSessionId.value) {
    historyPopoverRef.value?.hide()
    return
  }
  await finishActiveRequest()
  currentSessionId.value = session.id
  currentSessionTitle.value = session.title
  historyPopoverRef.value?.hide()
  await loadHistory(session.id)
}

const startNewChat = async () => {
  await finishActiveRequest()
  historyPopoverRef.value?.hide()
  editingSessionId.value = null
  renameInput.value = ''
  currentSessionId.value = null
  currentSessionTitle.value = '新对话'
  messages.value = []
}

const handleClearSession = async () => {
  if (!messages.value.length && !currentSessionId.value) return
  try {
    await inkConfirm('删除后当前会话及其全部对话记录不可恢复，确定删除吗？', '删除当前会话', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await finishActiveRequest()
    if (currentSessionId.value) {
      await deleteAiSessionApi({ ids: [Number(currentSessionId.value)] })
      sessionList.value = sessionList.value.filter(item => item.id !== currentSessionId.value)
    }
    startNewChat()
    ElMessage.success('已删除当前会话')
  } catch (error) {
    // user canceled
  }
}

const handleDeleteSession = async (id: number | string) => {
  try {
    await inkConfirm('删除该对话后不可恢复，确认删除吗？', '提示', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await finishActiveRequest()
    await deleteAiSessionApi({ ids: [Number(id)] })
    sessionList.value = sessionList.value.filter(item => item.id !== id)
    if (currentSessionId.value === id) {
      startNewChat()
    }
    ElMessage.success('删除成功')
  } catch {
    // ignore
  }
}

const startRename = (session: SessionItem) => {
  editingSessionId.value = Number(session.id)
  renameInput.value = session.title
}

const confirmRename = async (session: SessionItem) => {
  if (editingSessionId.value !== Number(session.id)) return
  const nextTitle = renameInput.value.trim()
  if (!nextTitle) {
    ElMessage.warning('标题不能为空')
    return
  }
  try {
    await renameAiSessionApi({ id: Number(session.id), title: nextTitle })
    session.title = nextTitle
    if (currentSessionId.value === session.id) {
      currentSessionTitle.value = nextTitle
    }
    editingSessionId.value = null
    ElMessage.success('重命名成功')
  } catch (error) {
    showApiError(error, '重命名失败')
  }
}

const fetchChapterOptions = async () => {
  const numericId = numericBookId.value
  if (!numericId) return
  chapterLoading.value = true
  try {
    const res = await getBookTreeApi({ bookId: numericId })
    const list: ChapterOption[] = []
    const traverse = (nodes: BookTreeNode[] = []) => {
      nodes.forEach(node => {
        const isChapter = node.type === 'chapter' || node.nodeType === 1
        if (isChapter) {
          list.push({ id: node.id, title: node.title })
        }
        if (node.children && node.children.length) {
          traverse(node.children)
        }
      })
    }
    traverse(res.data || [])
    chapterOptions.value = list
    chapterOptionsLoaded.value = true
  } catch (error) {
    console.error('章节目录获取失败', error)
  } finally {
    chapterLoading.value = false
  }
}

const ensureChapterOptions = () => {
  if (chapterOptionsLoaded.value || chapterLoading.value) return
  fetchChapterOptions()
}

const handleChapterPickerShow = () => {
  ensureChapterOptions()
}

const addChapterReference = async (chapter: ChapterOption) => {
  if (referencedChapters.value.find(item => item.id === chapter.id)) {
    ElMessage.warning('该章节已引用')
    return
  }
  const ref: ChapterReference = { ...chapter, loading: true }
  referencedChapters.value.push(ref)
  if (chapterCache.has(chapter.id)) {
    ref.content = chapterCache.get(chapter.id)
    ref.loading = false
    return
  }
  try {
    const res = await getChapterDetailApi({ bookId: bookIdValue.value, id: chapter.id })
    const text = res.data?.textContent || ''
    ref.content = text || '（该章节暂无正文）'
    ref.loading = false
    chapterCache.set(chapter.id, ref.content || '')
  } catch (error) {
    ref.loading = false
    showApiError(error, '读取章节内容失败')
  }
}

const removeChapterRef = (id: number) => {
  referencedChapters.value = referencedChapters.value.filter(item => item.id !== id)
}

const removeSelectionRef = (id: string) => {
  referencedSelections.value = referencedSelections.value.filter(item => item.id !== id)
}

const clearReferences = () => {
  referencedChapters.value = []
  referencedSelections.value = []
}

const buildReferenceLabels = (chapters: ChapterReference[], selections: AiSelectionItem[]) => {
  const labels: { id: string; label: string }[] = []
  chapters.forEach(ch => {
    labels.push({ id: `chapter-${ch.id}`, label: `章节 · ${ch.title}` })
  })
  selections.forEach(sel => {
    labels.push({ id: sel.id, label: `${sel.title}${sel.range ? ` · ${sel.range}` : ''}` })
  })
  return labels
}

const extractSceneTailAnchor = (text: string, maxSentences = 3, maxLength = 320) => {
  const normalized = String(text || '').replace(/\r/g, '\n').trim()
  if (!normalized) return ''
  const sentences = normalized
    .split(/(?<=[。！？!?；;])/)
    .map(item => item.trim())
    .filter(Boolean)
  const anchor = sentences.length
    ? sentences.slice(-maxSentences).join(' ')
    : normalized.slice(-maxLength)
  return anchor.length > maxLength ? anchor.slice(-maxLength) : anchor
}

const resolveCurrentChapterReference = async () => {
  if (!writingStore.activeChapterId) {
    return { title: '', summary: '', sceneAnchor: '' }
  }
  try {
    const res = await getChapterDetailApi({ bookId: bookIdValue.value, id: writingStore.activeChapterId })
    const text = String(res.data?.textContent || '')
    return {
      title: writingStore.activeChapterTitle || '',
      summary: writingStore.activeChapterSummary || '',
      sceneAnchor: extractSceneTailAnchor(text)
    }
  } catch {
    return {
      title: writingStore.activeChapterTitle || '',
      summary: writingStore.activeChapterSummary || '',
      sceneAnchor: ''
    }
  }
}


const handleSend = () => {
  const requestBookId = bookIdValue.value
  const query = inputValue.value.trim()
  if (!query || isGenerating.value) return requestFinished
  if (!numericBookId.value) {
    ElMessage.warning('请先选择有效的书籍后再对话')
    return Promise.resolve()
  }
  if (referencedChapters.value.some(item => item.loading)) {
    ElMessage.info('章节内容正在读取，请稍后发送')
    return Promise.resolve()
  }
  // 在第一个异步调用前锁定本轮，避免连续点击重复发送。
  isGenerating.value = true
  const requestController = new AbortController()
  abortController = requestController
  const chapterSnapshot = referencedChapters.value.map(item => ({ ...item }))
  const selectionSnapshot = referencedSelections.value.map(item => ({ ...item }))
  const modeInstruction = activeTemplateInstruction()
  const modeHint = activeTemplateHint.value
  const modelCode = chatModelOverride.value || aiModelStore.effectiveTextModel
  const historyForPrompt = messages.value
    .filter(item => item.content && !item.loading)
    .map(item => ({ role: item.role, content: item.content }))
  let requestSessionId = currentSessionId.value
  let reply: ChatMessage | null = null
  const isCurrent = () => bookIdValue.value === requestBookId && currentSessionId.value === requestSessionId

  requestFinished = (async () => {
    try {
      const useWritingContext = chapterSnapshot.length > 0 || selectionSnapshot.length > 0
      const currentChapterRef = useWritingContext ? await resolveCurrentChapterReference() : null
      if (requestController.signal.aborted || bookIdValue.value !== requestBookId) return
      if (!requestSessionId) {
        const { data } = await createAiSessionApi({ bookId: requestBookId, firstQuestion: query })
        requestSessionId = data.id
        if (bookIdValue.value !== requestBookId) return
        currentSessionId.value = data.id
        currentSessionTitle.value = data.title
        sessionList.value = [data, ...sessionList.value]
      }
      if (requestController.signal.aborted) return
      await appendLocalChatMessages(Number(requestSessionId), [{ role: 'user', content: query }])
      if (requestController.signal.aborted || !isCurrent()) return
      messages.value.push({ role: 'user', content: query, references: buildReferenceLabels(chapterSnapshot, selectionSnapshot) })
      inputValue.value = ''
      referencedChapters.value = []
      referencedSelections.value = []
      messages.value.push({ localId: `ai-${Date.now()}`, role: 'ai', content: '', loading: true })
      // 从响应式数组取对象，流式增量才会实时更新气泡。
      reply = messages.value[messages.value.length - 1]
      scrollToBottom()

      let context = [
        ...chapterSnapshot.map(ch => `【引用章节：${ch.title}】\n${ch.content || ''}`),
        ...selectionSnapshot.map(sel => `【引用选区：${sel.title}${sel.range ? ` · ${sel.range}` : ''}】\n${sel.content}`),
      ].join('\n\n')
      if (!context && currentChapterRef?.title) {
        context = [
          `【当前章节】${currentChapterRef.title}`,
          currentChapterRef.summary ? `【章节目标】${currentChapterRef.summary}` : '',
          currentChapterRef.sceneAnchor ? `【场景锚点】${currentChapterRef.sceneAnchor}` : '',
        ].filter(Boolean).join('\n')
      }
      if (modeHint) context += `\n\n【写作策略】${modeHint}`
      const characterContext = await loadCharacterContext(requestBookId, [query, context, ...historyForPrompt.slice(-20).map(item => item.content)].join('\n'))
      if (requestController.signal.aborted || !isCurrent()) return
      await streamLocalChatCompletion({
        modelCode,
        scene: 'miaobi',
        sceneLabel: '妙笔对话',
        temperature: promptTemperature('miaobi', 'system'),
        messages: buildMiaobiMessages({ query, context: [characterContext, context].filter(Boolean).join('\n\n'), modeInstruction, history: historyForPrompt }),
        signal: requestController.signal,
      }, {
        onDelta: text => {
          if (requestController.signal.aborted || !isCurrent() || !reply) return
          reply.content += text
          scrollToBottom()
        },
        onDone: () => {},
        onError: message => { if (isCurrent()) ElMessage.error(message) },
      })
    } catch (error) {
      if (!requestController.signal.aborted && isCurrent()) showApiError(error, '妙笔对话失败')
    } finally {
      let replySaved = true
      if (reply) {
        reply.loading = false
        if (reply.content.trim() && requestSessionId) {
          try {
            await appendLocalChatMessages(Number(requestSessionId), [{ role: 'ai', content: reply.content }])
          } catch (error) {
            replySaved = false
            if (isCurrent()) showApiError(error, '回答保存失败，请先复制内容')
          }
        }
      }
      if (replySaved && requestSessionId && isCurrent()) {
        await loadHistory(requestSessionId, true)
        scrollToBottom()
      }
      if (abortController === requestController) {
        abortController = null
        isGenerating.value = false
      }
    }
  })()
  return requestFinished
}

const stopGenerate = () => {
  abortController?.abort()
}

const finishActiveRequest = async () => {
  stopGenerate()
  await requestFinished
}

const copyText = (text: string) => {
  navigator.clipboard?.writeText(text).then(() => {
    ElMessage.success('已复制到剪贴板')
  })
}

const handleDeleteMessage = async (msg: ChatMessage, index: number) => {
  try {
    await inkConfirm('删除后不可恢复，确认删除该消息吗？', '提示', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await finishActiveRequest()
    const messageId = msg.id ?? messages.value[index]?.id
    if (messageId) {
      await deleteAiMessageApi({ id: messageId })
    }
    messages.value.splice(index, 1)
  } catch {
    // ignore
  }
}

const regenerateFrom = async (index: number) => {
  if (isGenerating.value) return
  const prevUser = [...messages.value.slice(0, index)].reverse().find(item => item.role === 'user')
  if (!prevUser) {
    ElMessage.warning('未找到可重新发送的用户消息')
    return
  }
  // 直接用上次提问重新发起一轮回答，而不是只把文字塞回输入框
  inputValue.value = prevUser.content
  await handleSend()
}

const quickAsk = (text: string) => {
  inputValue.value = text
}

const drainSelectionQueue = () => {
  const selections = aiChatStore.consumeSelections()
  if (selections.length) {
    referencedSelections.value.push(...selections)
  }
}

const toggleExpand = () => {
  if (isExpanded.value) {
    if (originalPanelWidth.value !== null) {
      writingStore.setRightPanelWidth(originalPanelWidth.value)
    }
    isExpanded.value = false
  } else {
    originalPanelWidth.value = writingStore.rightPanelWidth
    writingStore.setRightPanelWidth(Math.min(writingStore.rightPanelWidth + 160, 600))
    isExpanded.value = true
  }
}

watch(() => aiChatStore.pendingSelections.length, () => {
  drainSelectionQueue()
}, { immediate: true })

watch(bookIdValue, (val, prev) => {
  if (prev === val) return
  resetState()
  chapterOptions.value = []
  chapterOptionsLoaded.value = false
  chapterSearch.value = ''
  if (val) {
    loadSessions()
  }
}, { immediate: true })

onMounted(() => {
  drainSelectionQueue()
})

onBeforeUnmount(() => {
  if (isExpanded.value && originalPanelWidth.value !== null) {
    writingStore.setRightPanelWidth(originalPanelWidth.value)
  }
  if (abortController) {
    abortController.abort()
  }
})
</script>

<style scoped lang="scss">
.ai-chat-panel {
  --ai-chat-sheen: linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink-main) 14%, transparent) 0%,
    transparent 65%
  );

  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: transparent;

  .panel-header {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    padding: 0 16px;
    border-bottom: 1px solid var(--ui-border);
    background: var(--panel-header-bg);

    .panel-title {
      display: flex;
      flex-direction: column;
      min-width: 0;
      max-width: 70%;

      .name {
        font-weight: 600;
        color: var(--ink-main);
      }

      .meta {
        font-size: calc(12px * var(--ui-font-scale, 1));
        color: var(--ink-sec);
      }
    }

    .panel-actions {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      gap: 12px;

      .action-icon {
        font-size: calc(14px * var(--ui-font-scale, 1));
        color: var(--ink-sec);
        opacity: 0.7;
        cursor: pointer;
        transition: color 0.2s ease, opacity 0.2s ease;

        &.active {
          color: var(--ink-main);
          opacity: 1;
        }

        &:hover {
          opacity: 1;
          color: var(--ink-main);
        }
      }
    }
  }

  .chat-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 12px 12px 0;
    gap: 12px;
    overflow: hidden;
  }

  .chat-scroll {
    flex: 1;
    min-width: 0;
    padding-right: 6px;
    overflow: hidden;
  }

  .empty-state {
    padding: 32px 12px;
    text-align: center;
    color: var(--ink-sec);

    .icon-wrapper {
      width: 48px;
      height: 48px;
      border-radius: 16px;
      margin: 0 auto 12px;
      background: var(--panel-header-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: calc(20px * var(--ui-font-scale, 1));
      color: var(--ink-accent);
    }

    .suggestions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      margin-top: 12px;

      .suggestion-tag {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        height: 28px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid var(--btn-outline-border);
        background: var(--btn-outline-bg);
        color: var(--ink-main);
        letter-spacing: 0.2px;
        position: relative;
        overflow: hidden;
        transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;

        &::before {
          content: '';
          position: absolute;
          inset: 0;
          background: var(--ai-chat-sheen);
          opacity: 0.75;
          pointer-events: none;
        }

        :deep(.el-tag__content) {
          position: relative;
          z-index: 1;
        }

        &:hover {
          background: var(--btn-outline-hover-bg);
          border-color: var(--ui-border-hover);
          box-shadow: var(--ui-shadow);
          transform: translateY(-1px);
        }

        &:active {
          transform: translateY(0);
          box-shadow: var(--ui-shadow);
        }
      }
    }
  }

  .chat-message {
    display: flex;
    min-width: 0;
    gap: 10px;
    margin-bottom: 14px;

    .avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: var(--panel-header-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--ink-main);
      flex-shrink: 0;
    }

    .message-block {
      flex: 1;
      min-width: 0;
      background: var(--ui-glass-bg);
      border: 1px solid var(--ui-border);
      border-radius: 12px;
      padding: 10px 12px;
      position: relative;

      .message-text {
        font-size: calc(13px * var(--ui-font-scale, 1));
        line-height: 1.7;
        color: var(--ink-main);
        word-break: break-word;
        overflow-wrap: anywhere;

        // 全局 * { padding: 0 } 清掉了列表默认缩进，序号会画到气泡外面，这里补回来。
        // v-html 注入的节点没有 scoped 属性，必须用 :deep() 才能命中
        :deep(ol),
        :deep(ul) {
          padding-left: 1.6em;
          margin: 4px 0;
        }

        :deep(li + li) {
          margin-top: 2px;
        }

        :deep(p + p),
        :deep(p + ol),
        :deep(p + ul),
        :deep(ol + p),
        :deep(ul + p) {
          margin-top: 6px;
        }

        :deep(pre) {
          max-width: 100%;
          white-space: pre-wrap;
          word-break: break-all;
          overflow-x: auto;
        }

        :deep(code) {
          word-break: break-all;
        }

        :deep(table) {
          display: block;
          max-width: 100%;
          overflow-x: auto;
        }

        :deep(img) {
          max-width: 100%;
        }
      }

      .typing {
        font-size: calc(12px * var(--ui-font-scale, 1));
        color: var(--ink-sec);
        margin-top: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .reference-tags {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .message-ops {
        display: flex;
        gap: 10px;
        margin-top: 8px;
        font-size: calc(12px * var(--ui-font-scale, 1));
        color: var(--ink-sec);

        i {
          cursor: pointer;
          transition: color 0.2s ease;

          &:hover {
            color: var(--ink-main);
          }
        }
      }
    }

    &.ai .message-block {
      background: rgba(99, 102, 241, 0.04);
    }
  }

  .chat-input-area {
    padding-bottom: 12px;
  }

  .input-container {
    border: 1px solid var(--ui-border);
    border-radius: 14px;
    background: var(--input-gradient);
    backdrop-filter: blur(14px);
    padding: 12px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 12px;
    box-shadow: var(--ui-shadow);

    .input-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-width: 0;
      border-bottom: 1px solid var(--ui-border);
      padding-bottom: 8px;

      .left-tools {
        display: flex;
        min-width: 0;
        gap: 8px;
      }

      .right-tools {
        .stat-text {
          font-size: calc(12px * var(--ui-font-scale, 1));
          color: var(--ink-sec);
        }
      }
    }

    .ref-tags-wrapper {
      display: flex;
      flex-direction: column;
      gap: 6px;

      .ref-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;

        label {
          font-size: calc(12px * var(--ui-font-scale, 1));
          color: var(--ink-sec);
        }
      }
    }

    .input-box {
      border-radius: 12px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      padding: 10px 12px;
      transition: background-color 0.2s ease, border-color 0.2s ease;

      &:focus-within {
        background: var(--input-focus-bg);
        border-color: var(--input-focus-border);
      }

      .custom-textarea {
        width: 100%;
        border: none;
        outline: none;
        box-shadow: none;
        transform: none;
        background: transparent;
        resize: none;
        color: var(--ink-main);
        font-size: calc(13px * var(--ui-font-scale, 1));
        line-height: 1.6;
        font-family: inherit;

        &:focus {
          box-shadow: none;
          transform: none;
        }

        &::placeholder {
          color: var(--ink-sec);
          opacity: 0.7;
        }
      }
    }

    .input-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;

      .footer-left {
        display: flex;
        gap: 8px;
        min-width: 0;

        .chat-model-chip {
          width: clamp(150px, 40%, 230px);
        }
      }

      .send-btn {
        width: 38px;
        height: 38px;
        box-shadow: var(--ui-shadow);
      }
    }
  }
}

.popover-ref {
  display: inline-flex;
}

:global(.theme-dark) {
  .ai-chat-panel {
    --ai-chat-sheen: linear-gradient(
      135deg,
      color-mix(in srgb, var(--ink-main) 8%, transparent) 0%,
      transparent 70%
    );
  }
}
</style>

<style lang="scss">
.chapter-picker-popover {
  padding: 12px;
  border-radius: 12px;

  .chapter-picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .chapter-option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--ink-main);

    &.muted {
      cursor: default;
      color: var(--ink-sec);
    }

    &:hover {
      background: var(--panel-header-bg);
    }

    .title {
      flex: 1;
    }

    .add {
      font-size: calc(12px * var(--ui-font-scale, 1));
      color: var(--ink-accent);
    }
  }
}
</style>

<style lang="scss">
.footer-left .ink-select {
  width: 130px;
}

.ink-select-popper {
  min-width: 130px !important;
}

.ai-history-popper {
  padding: 0;
  border-radius: 14px;
  overflow: hidden;

  .history-panel {
    display: flex;
    flex-direction: column;
    min-height: 200px;
  }

  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--ui-border);
    font-weight: 600;
  }

  .history-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    gap: 10px;
    cursor: pointer;
    transition: background-color 0.2s ease;

    &:hover {
      background: var(--nav-hover-bg);

      .ops {
        opacity: 1;
        pointer-events: auto;
      }
    }

    &.active {
      background: rgba(99, 102, 241, 0.08);
      color: var(--ink-main);
    }

    .info {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      overflow: hidden;
      font-size: calc(13px * var(--ui-font-scale, 1));
      color: var(--ink-main);
    }

    .ops {
      display: flex;
      gap: 12px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;

      .action-btn {
        cursor: pointer;
        color: var(--ink-sec);
        font-size: calc(13px * var(--ui-font-scale, 1));
        transition: color 0.2s ease;

        &:hover {
          color: var(--ink-main);
        }

        &.delete:hover {
          color: var(--ink-warning);
        }
      }
    }
  }
}
</style>
