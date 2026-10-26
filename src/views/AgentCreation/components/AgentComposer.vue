<template>
  <div class="ac-composer-wrap">
    <div
      class="ac-composer"
      :class="{ 'has-focus': focused, 'is-dragging': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <ul v-if="attachments.length || storing" class="ac-attachments" aria-label="上传附件">
        <li v-if="storing" class="ac-attachment-card" role="status">
          <i class="fa-solid fa-spinner fa-spin ac-attachment-icon" aria-hidden="true"></i>
          <span class="ac-attachment-info">
            <strong :title="storing">{{ storing }}</strong>
            <small
              >{{ importProgress?.stage || '正在读取'
              }}<template v-if="importProgress?.total">
                · {{ Math.round((importProgress.done / importProgress.total) * 100) }}%</template
              >
            </small>
          </span>
          <button
            v-if="importProgress?.cancellable !== false"
            type="button"
            aria-label="取消导入"
            @click="importer?.cancel()"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </li>
        <li v-for="reference in attachments" :key="reference.id" class="ac-attachment-card">
          <i :class="[referenceIcon(reference), 'ac-attachment-icon']" aria-hidden="true"></i>
          <span class="ac-attachment-info">
            <strong :title="reference.title">{{ reference.title }}</strong>
            <small>{{
              reference.description || (reference.kind === 'breakdown' ? '参考书' : '本地资料')
            }}</small>
          </span>
          <button
            type="button"
            :aria-label="`移除附件 ${reference.title}`"
            title="从当前对话移除"
            @click="store.removeReference(reference.id)"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </li>
      </ul>
      <div v-if="extraReferences.length || chosenSkill" class="ac-reference-chips">
        <span v-for="reference in extraReferences" :key="reference.id" class="ac-reference-chip">
          <i :class="referenceIcon(reference)" aria-hidden="true"></i>{{ reference.title }}
          <button :aria-label="`移除引用 ${reference.title}`" @click="store.removeReference(reference.id)">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </span>
        <span v-if="chosenSkill" class="ac-reference-chip"
          ><i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i>技能：{{ chosenSkill.name }}
          <small class="ac-skill-scope">本次使用</small
          ><button aria-label="取消指定技能" @click="store.selectedSkillId = null">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i></button
        ></span>
      </div>
      <textarea
        ref="input"
        v-model="store.draft"
        rows="2"
        aria-label="创作指令"
        aria-autocomplete="list"
        :aria-controls="picker?.visible ? picker.listId : undefined"
        :aria-activedescendant="picker?.activeOptionId"
        :placeholder="
          store.active?.status === 'running'
            ? '补充你的要求...'
            : '描述你的想法，@ 选择资料或技能，$ 直达技能…'
        "
        @keydown="onKeydown"
        @input="onInput"
        @click="picker?.syncMention()"
        @keyup="picker?.syncMention()"
        @select="picker?.syncMention()"
        @compositionstart="picker?.compositionStart()"
        @compositionend="picker?.compositionEnd()"
        @focus="focused = true"
        @blur="focused = false"
      ></textarea>
      <div class="ac-composer-toolbar">
        <div class="ac-composer-tools">
          <el-dropdown trigger="click" @command="onAddCommand">
            <button class="ac-icon-button ac-add-button" aria-label="更多创作操作">
              <i class="fa-solid fa-plus" aria-hidden="true"></i>
            </button>
            <template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item command="reference">引用作品、章节或资料</el-dropdown-item
                ><el-dropdown-item command="file">添加本地资料或整本书（TXT）</el-dropdown-item
                ><el-dropdown-item command="skill" divided>选择技能</el-dropdown-item
                ><el-dropdown-item command="create-skill">创建技能</el-dropdown-item></el-dropdown-menu
              ></template
            >
          </el-dropdown>
          <button class="ac-tool-button" aria-label="选择平台作品" @click="picker?.openBooks()">
            <i
              :class="primaryReference ? referenceIcon(primaryReference) : 'fa-solid fa-book-open'"
              aria-hidden="true"
            ></i>
            <span>{{ primaryReference?.title || '选择作品' }}</span>
            <i class="fa-solid fa-chevron-down ac-tiny" aria-hidden="true"></i>
          </button>
          <el-dropdown trigger="click" @command="(value: string) => (store.model = String(value))">
            <button class="ac-tool-button" aria-label="选择模型">
              <i class="fa-solid fa-sliders" aria-hidden="true"></i><span>{{ store.modelLabel }}</span
              ><i class="fa-solid fa-chevron-down ac-tiny" aria-hidden="true"></i>
            </button>
            <template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item
                  v-for="item in [{ code: '', name: '默认模型' }, ...store.models]"
                  :key="item.code"
                  :command="item.code"
                  >{{ item.name }}</el-dropdown-item
                ></el-dropdown-menu
              ></template
            >
          </el-dropdown>
        </div>
        <div class="ac-send-tools">
          <template v-if="store.active?.status === 'running'"
            ><span class="ac-running-label">执行中</span
            ><button class="ac-send" aria-label="停止任务" @click="store.pause()">
              <i class="fa-solid fa-stop" aria-hidden="true"></i></button
          ></template>
          <button
            v-else
            class="ac-send"
            :disabled="!store.ready || store.loading || store.submitting || !!storing || !store.draft.trim()"
            :title="storing ? '文本还在存放，稍等片刻再发送' : undefined"
            aria-label="发送消息"
            @click="submit"
          >
            <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
    <AgentComposerPicker ref="picker" :input="input" />
    <input ref="fileInput" type="file" accept=".txt,.md" hidden @change="attachFile" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import AgentComposerPicker from './AgentComposerPicker.vue'
import { useAgentWorkspace } from '../use-agent-workspace'
import { referenceIcon } from '../reference-icons'
import { REFERENCE_MAX_MB } from '@/agent/reference-book'
import { importReferenceFile, type ReferenceImportProgress } from '@/agent/reference-import'
import type { AgentReference } from '@/types/agent-creation'

defineProps<{ compact?: boolean }>()
const emit = defineEmits<{ sent: []; 'create-skill': [] }>()
const store = useAgentWorkspace()
const input = ref<HTMLTextAreaElement>()
const picker = ref<InstanceType<typeof AgentComposerPicker>>()
const fileInput = ref<HTMLInputElement>()
const focused = ref(false)
const dragging = ref(false)
/** 正在存放的整本书书名：存放期间输入框显示进度、暂缓发送 */
const storing = ref<string | null>(null)
const importProgress = ref<ReferenceImportProgress | null>(null)
let importer: ReturnType<typeof importReferenceFile> | undefined
/** 从“拆解参考书”入口打开文件选择时记下意图，选完文件后用 */
let fileIntent: 'breakdown' | null = null
const chosenSkill = computed(() => store.skills.find(item => item.id === store.selectedSkillId))
const isAttachment = (reference: AgentReference) =>
  reference.kind === 'breakdown' || reference.kind === 'material'
const attachments = computed(() => store.references.filter(isAttachment))
const primaryReference = computed(() => store.references.find(reference => reference.kind === 'book'))
const extraReferences = computed(() =>
  store.references.filter(
    reference => !isAttachment(reference) && reference.id !== primaryReference.value?.id
  )
)
const focus = () => nextTick(() => input.value?.focus())
/** “拆解参考书”入口：拆书库里已有书就让作者挑一本，没有就直接选文件导入 */
function chooseReferenceBook() {
  if (store.availableReferences.some(reference => reference.kind === 'breakdown'))
    picker.value?.open('reference', 'breakdown')
  else {
    fileIntent = 'breakdown'
    fileInput.value?.click()
  }
}
defineExpose({ focus, chooseReferenceBook })

async function submit() {
  if (!store.draft.trim() || storing.value) return
  await store.send()
  picker.value?.close()
  emit('sent')
  focus()
}

function onKeydown(event: KeyboardEvent) {
  if (picker.value?.handleKeydown(event)) return
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (store.enterToSend || event.metaKey || event.ctrlKey)
  ) {
    event.preventDefault()
    submit()
  }
}

function onInput() {
  void nextTick(() => picker.value?.syncMention())
}

/** 输入框默认两行高，随内容长到 200px 为止，再长就在框内滚动 */
const INPUT_MIN_HEIGHT = 56
const INPUT_MAX_HEIGHT = 200
function resizeInput() {
  if (!input.value) return
  input.value.style.height = 'auto'
  input.value.style.height = `${Math.min(Math.max(input.value.scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT)}px`
}
watch(() => store.draft, resizeInput, { flush: 'post' })
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  resizeInput()
  let previousWidth = input.value?.clientWidth
  resizeObserver = new ResizeObserver(() => {
    if (input.value?.clientWidth === previousWidth) return
    previousWidth = input.value?.clientWidth
    resizeInput()
  })
  if (input.value) resizeObserver.observe(input.value)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  void importer?.cancel()
})

function onAddCommand(command: string) {
  if (command === 'reference') picker.value?.open('reference')
  else if (command === 'skill') picker.value?.open('skill')
  else if (command === 'file') fileInput.value?.click()
  else if (command === 'create-skill') emit('create-skill')
}

async function attachFile(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  const intent = fileIntent
  fileIntent = null
  if (file) await readFile(file, intent)
}

function onDrop(event: DragEvent) {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void readFile(file, null)
}

/**
 * 本地文本直接挂到对话上，不弹窗、不拆：怎么用由作者在对话里说，Agent 需要确认时在对话里问。
 * 像一本书的长文本按章存进参考书库（本地切块建检索，不调模型），其余作为一份资料；编码自动识别。
 */
async function readFile(file: File, intent: 'breakdown' | null) {
  if (!/\.(txt|md)$/i.test(file.name)) {
    ElMessage.warning('请选择 TXT 或 Markdown 文本')
    return
  }
  if (file.size > REFERENCE_MAX_MB * 1024 * 1024) {
    ElMessage.warning(`文件超过 ${REFERENCE_MAX_MB}MB，请先拆成几个文件`)
    return
  }
  if (storing.value) {
    ElMessage.info('上一份文本还在存放，稍等片刻')
    return
  }
  storing.value = file.name
  importProgress.value = { stage: '读取文本', done: 0, total: file.size, cancellable: true }
  const sessionId = store.activeId
  try {
    importer = importReferenceFile({ file, intent }, value => {
      importProgress.value = value
    })
    const value = await importer.promise
    const reference = value.material
      ? {
          id: `material:${value.result.materialId}`,
          kind: 'material' as const,
          bookId: '',
          materialId: value.result.materialId,
          title: value.result.title,
          chars: value.result.chars,
          description: `本地资料 · ${value.result.chars} 字`
        }
      : {
          id: value.result.bookId,
          bookId: value.result.bookId,
          kind: 'breakdown' as const,
          title: value.result.title,
          description: `参考书 · ${value.result.chapters} 章`
        }
    store.attachImportedReference(reference, sessionId)
    ElMessage.success(
      value.material
        ? '资料已添加'
        : value.result.existing
          ? `已引用已有的《${value.result.title}》`
          : `《${value.result.title}》已保存，全文检索将在后台建立`
    )
    if (store.activeId !== sessionId) ElMessage.info('导入期间已切换对话，可从参考书库重新引用')
    focus()
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      ElMessage.error(String(error instanceof Error ? error.message : error))
  } finally {
    storing.value = null
    importProgress.value = null
    importer = undefined
  }
}
</script>
