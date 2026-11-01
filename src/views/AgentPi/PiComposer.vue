<template>
  <div class="pi-composer-wrap" @dragover="dragOver" @drop="dropFile">
    <div class="pi-composer">
      <!-- 输入框上方只放文件附件；技能和 @ 的资料是文字里的标记节点。 -->
      <ul v-if="store.attachment" class="pi-attachments" aria-label="本条消息附带">
        <li
          class="pi-attachment-card"
          :class="{ 'is-error': store.attachment.error }"
          :role="store.attachment.previewing ? 'status' : undefined"
        >
          <i
            :class="[
              store.attachment.previewing
                ? 'fa-solid fa-spinner fa-spin'
                : store.attachment.error
                  ? 'fa-solid fa-triangle-exclamation'
                  : 'fa-regular fa-file-lines',
              'pi-attachment-icon'
            ]"
            aria-hidden="true"
          ></i>
          <span class="pi-attachment-info">
            <strong :title="store.attachment.file.name">{{
              store.attachment.catalog ? `《${store.attachment.catalog.title}》` : store.attachment.file.name
            }}</strong>
            <small :title="catalogLine">{{ catalogLine }}</small>
          </span>
          <button
            type="button"
            :aria-label="`移除附件 ${store.attachment.file.name}`"
            title="从本次消息移除"
            @click="store.removeAttachment"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </li>
      </ul>
      <div class="pi-composer-field">
        <!-- / 或 $ 选技能，@ 引用当前作品的资料；上下键选，回车选中，Esc 关闭。 -->
        <div
          v-if="menu"
          :id="menuId"
          class="pi-composer-menu"
          role="listbox"
          :aria-label="menu.kind === 'skill' ? '选择技能' : '引用作品资料'"
        >
          <template v-if="menuItems.length">
            <template v-for="(item, index) in menuItems" :key="item.key">
              <div v-if="item.group && (index === 0 || menuItems[index - 1].group !== item.group)" class="pi-composer-menu-group">
                {{ item.group }}
              </div>
              <button
                :id="`${menuId}-${index}`"
                type="button"
                role="option"
                :aria-selected="index === active"
                :class="{ 'is-active': index === active }"
                @mousedown.prevent
                @mouseenter="active = index"
                @click="choose(index)"
              >
                <i :class="item.icon" aria-hidden="true"></i
                ><span><strong>{{ item.title }}</strong><small v-if="item.hint">{{ item.hint }}</small></span>
              </button>
            </template>
          </template>
          <p v-else class="pi-composer-menu-empty">{{ menuEmpty }}</p>
        </div>
        <!-- 真正的可编辑区：文字是文本节点，技能和引用是不可编辑的标记节点，光标、退格、输入法都由浏览器处理。 -->
        <div
          ref="editor"
          class="pi-composer-editor"
          :contenteditable="store.inputLocked ? 'false' : 'true'"
          role="textbox"
          aria-multiline="true"
          aria-label="创作要求"
          :data-placeholder="store.pendingQuestion ? '直接回复上面的问题，或选一个选项…' : '描述你的想法，或告诉 Agent 要处理哪一章…'"
          :title="sendHint"
          :aria-expanded="!!menu"
          :aria-controls="menu ? menuId : undefined"
          :aria-activedescendant="menu && menuItems[active] ? `${menuId}-${active}` : undefined"
          @input="onInput"
          @keydown="onKeydown"
          @keyup="onKeyup"
          @click="onClick"
          @paste="onPaste"
          @blur="onBlur"
          @compositionend="onCompositionEnd"
        ></div>
      </div>
      <div class="pi-composer-toolbar pi-composer-controls">
        <div class="pi-composer-tools">
          <button
            class="pi-icon-button"
            aria-label="添加文件"
            title="添加书籍文件（TXT、Markdown、Word、EPUB），也可拖入聊天"
            :disabled="store.inputLocked"
            @click="fileInput?.click()"
          >
            <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
          </button>
          <input ref="fileInput" type="file" :accept="DOCUMENT_ACCEPT" hidden @change="chooseFile" />
          <el-select
            :model-value="store.bookId"
            placeholder="选择作品"
            aria-label="选择作品"
            clearable
            filterable
            :disabled="store.busy"
            class="pi-book-select"
            @change="value => store.changeContext({ bookId: value || '' })"
          >
            <template #prefix><i class="fa-solid fa-book-open" aria-hidden="true"></i></template>
            <el-option v-for="book in store.books" :key="book.id" :value="book.id" :label="book.title" />
          </el-select>
          <el-select
            :model-value="store.modelCode"
            placeholder="选择模型"
            aria-label="选择模型"
            :disabled="store.busy"
            class="pi-model-select"
            @change="value => store.changeContext({ modelCode: value })"
          >
            <template #prefix><i class="fa-solid fa-sliders" aria-hidden="true"></i></template>
            <el-option
              v-for="model in store.models"
              :key="model.code"
              :value="model.code"
              :label="model.name"
            />
          </el-select>
        </div>
        <div class="pi-send-tools">
          <template v-if="store.pendingQuestion && !store.stopping && !store.stopFailed">
            <button
              class="pi-send"
              aria-label="回复这个问题"
              :title="(store.pendingQuestion.spec.afterAnswer === 'pause' ? '保存回答并暂停' : '提交回答') + '（' + sendKeys + '）'"
              :disabled="!store.draft.trim() || store.answering"
              @click="store.send"
            >
              <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
            </button>
          </template>
          <template v-else-if="store.running || store.stopping || store.stopFailed">
            <span class="pi-running-label">{{
              store.stopping ? '正在停止' : store.stopFailed ? '停止未完成' : '执行中'
            }}</span>
            <button
              class="pi-send pi-stop"
              :aria-label="store.stopFailed ? '重试停止' : '停止当前工作'"
              :title="store.stopFailed ? '重试停止' : '停止当前工作'"
              :disabled="store.stopping"
              @click="store.stop"
            >
              <i class="fa-solid fa-stop" aria-hidden="true"></i>
            </button>
          </template>
          <button
            v-else-if="store.runControl.state === 'paused' && !store.draft.trim() && !store.attachment"
            type="button"
            class="ink-btn ink-btn-sm ink-btn-primary"
            title="继续刚才暂停的工作"
            :disabled="store.busy"
            @click="store.resumeConversation()"
          >
            继续
          </button>
          <button
            v-else
            class="pi-send"
            aria-label="发送消息"
            :title="'发送消息（' + sendKeys + '）'"
            :disabled="
              !store.ready ||
              (!store.draft.trim() && !store.attachment) ||
              store.busy ||
              store.attachment?.previewing ||
              !!store.attachment?.error
            "
            @click="store.send"
          >
            <i
              :class="store.connecting ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-arrow-up'"
              aria-hidden="true"
            ></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { skillLabel, skillDisplayName, skillNamesForInput } from '@/agent-pi/skills'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usePiWorkspace } from './use-pi-workspace'
import { isSendShortcut, shortcutLabel } from './shortcuts'
import {
  detectMenu,
  filterItems,
  findMentionTokens,
  findSkillToken,
  findTokens,
  insertSkillToken,
  insertToken,
  mentionToken,
  removeTrigger,
  type InlineToken,
  type MenuTrigger
} from './composer-menu'
import { listMentionItems, REFERENCE_GROUPS, type MentionItem } from '@/agent-pi/references'
import { DOCUMENT_ACCEPT } from '@/writing-service/document-text'
const store = usePiWorkspace()
const sendKeys = computed(() => store.enterToSend ? 'Enter' : shortcutLabel('send'))
const sendHint = computed(() => sendKeys.value + ' 发送；' + (store.enterToSend ? 'Shift + Enter' : 'Enter') + ' 换行；/ 选技能，@ 引用作品资料')

const fileInput = ref<HTMLInputElement>()
const editor = ref<HTMLDivElement>()
const menuId = `pi-composer-menu-${Math.random().toString(36).slice(2, 8)}`
/** 附件卡第二行：识别中、识别结果（章数、字数、第一条分章提示）或失败原因。 */
const catalogLine = computed(() => {
  const pending = store.attachment
  if (!pending) return ''
  if (pending.previewing) return '正在识别目录…'
  if (pending.error) return pending.error
  const catalog = pending.catalog
  if (!catalog) return '随消息入库'
  const size = catalog.chars >= 10000 ? `${(catalog.chars / 10000).toFixed(1)} 万字` : `${catalog.chars} 字`
  return [`${catalog.chapterCount} 章 · ${size}`, catalog.warnings[0]].filter(Boolean).join(' · ')
})
function chooseFile(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (file) store.attachBook(file)
}
function dragOver(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
}
function dropFile(event: DragEvent) {
  const files = event.dataTransfer?.files
  if (!files?.length) return
  event.preventDefault()
  if (files.length !== 1) {
    ElMessage.warning('一次请附加一本书')
    return
  }
  store.attachBook(files[0])
}

// ---- 编辑区与文字模型的对应：store.draft 是带标记的纯文字（/技能名、@标题），编辑区里标记是不可编辑的节点。
const CHIP = 'pi-chip'
const TAIL = 'pi-editor-tail'
const skillNames = computed(() => skillNamesForInput(store.skills))
const isChip = (node: Node | null | undefined): node is HTMLElement =>
  !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(CHIP)
const isTail = (node: Node | null | undefined) =>
  !!node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(TAIL)
/** 把编辑区（或它的一段）读成文字：文本节点原样，标记节点换成它代表的文字，换行是换行符。 */
function serialize(root: Node) {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.classList.contains(CHIP)) {
      out += el.dataset.token || ''
      return
    }
    if (el.tagName === 'BR') {
      if (!el.classList.contains(TAIL)) out += '\n'
      return
    }
    if (['DIV', 'P'].includes(el.tagName) && out && !out.endsWith('\n')) out += '\n'
    el.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return out
}
function chipNode(token: InlineToken, text: string) {
  const el = document.createElement('span')
  el.className = `${CHIP} is-${token.kind}`
  el.contentEditable = 'false'
  el.dataset.token = text
  el.textContent = token.kind === 'skill' ? skillDisplayName(token.name) : text.slice(1)
  el.title = token.kind === 'skill' ? `技能 ${skillDisplayName(token.name)}` : `${REFERENCE_GROUPS[token.reference.kind]} · ${token.reference.title}`
  return el
}
/** 文字末尾的换行要靠一个占位 br 才显示得出来；它不算文字。 */
function ensureTail(root: HTMLElement) {
  for (const node of Array.from(root.childNodes)) if (isTail(node)) node.remove()
  if (serialize(root).endsWith('\n')) {
    const br = document.createElement('br')
    br.className = TAIL
    root.append(br)
  }
}
let rendered = ''
/** 按文字重建编辑区：文字拆成文本节点和标记节点。 */
function render(text: string) {
  const root = editor.value
  if (!root) return
  root.replaceChildren()
  let cursor = 0
  for (const token of findTokens(text, skillNames.value, store.references)) {
    if (token.start > cursor) root.append(document.createTextNode(text.slice(cursor, token.start)))
    root.append(chipNode(token, text.slice(token.start, token.end)))
    cursor = token.end
  }
  if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)))
  ensureTail(root)
  rendered = text
}
/** 编辑区改了就写回 store.draft；空了就把编辑区清干净，占位提示才会出现。 */
function syncFromDom() {
  const root = editor.value
  if (!root) return
  const text = serialize(root)
  rendered = text
  if (store.draft !== text) store.draft = text
  if (!text && root.childNodes.length) root.replaceChildren()
}
/** 光标在文字模型里的位置：把编辑区开头到光标这一段读成文字，取长度。 */
function caretOffset() {
  const root = editor.value,
    selection = window.getSelection()
  if (!root || !selection?.rangeCount) return store.draft.length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return store.draft.length
  const prefix = document.createRange()
  prefix.setStart(root, 0)
  prefix.setEnd(range.startContainer, range.startOffset)
  return serialize(prefix.cloneContents()).length
}
function nodeLength(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').length
  if (isChip(node)) return (node.dataset.token || '').length
  if ((node as HTMLElement).tagName === 'BR') return isTail(node) ? 0 : 1
  return serialize(node).length
}
function placeCaret(node: Node, offset: number) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
/** 把光标放到文字模型的某个位置；落在标记里就放到标记后面。 */
function setCaret(offset: number) {
  const root = editor.value
  if (!root) return
  const nodes = Array.from(root.childNodes)
  let acc = 0
  for (const [index, node] of nodes.entries()) {
    const length = nodeLength(node)
    if (node.nodeType === Node.TEXT_NODE && offset <= acc + length) {
      placeCaret(node, offset - acc)
      return
    }
    if (node.nodeType !== Node.TEXT_NODE && !isTail(node) && offset <= acc + length) {
      placeCaret(root, index + 1)
      return
    }
    acc += length
  }
  placeCaret(root, nodes.filter(node => !isTail(node)).length)
}
/** 在光标处插入纯文字（回车、粘贴都走这里，不让浏览器塞进段落标签）。 */
function insertText(value: string) {
  const root = editor.value,
    selection = window.getSelection()
  if (!root || !value || !selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return
  range.deleteContents()
  const node = document.createTextNode(value)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  ensureTail(root)
  syncFromDom()
  pruneReferences()
  updateMenu()
}
/** 文字里没有了的 @标题，对应的引用也去掉。 */
function pruneReferences() {
  const kept = new Set(findMentionTokens(store.draft, store.references).map(item => `${item.reference.kind}:${item.reference.id}`))
  if (kept.size !== store.references.length) store.references = store.references.filter(item => kept.has(`${item.kind}:${item.id}`))
}
watch(
  () => store.draft,
  value => {
    // 别处改了草稿（快捷开场、发送后清空）才重建；自己打字时文字和编辑区本来就一致
    if (value === rendered) return
    render(value)
    if (document.activeElement === editor.value) setCaret(value.length)
  }
)
onMounted(() => render(store.draft))

// ---- 标记的删除：退格第一下选中整个标记，第二下连同后面的空格删掉；光标本身进不去标记。
const selectedChip = ref<HTMLElement | null>(null)
function clearSelectedChip() {
  selectedChip.value?.classList.remove('is-selected')
  selectedChip.value = null
}
/** 光标紧挨着的标记：退格看前面（标记后面那个空格之后也算），删除键看后面。 */
function adjacentChip(direction: 'before' | 'after') {
  const root = editor.value,
    selection = window.getSelection()
  if (!root || !selection?.rangeCount || !selection.isCollapsed) return null
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0)
  if (!root.contains(node)) return null
  let candidate: Node | null | undefined = null
  if (node === root) candidate = direction === 'before' ? root.childNodes[offset - 1] : root.childNodes[offset]
  else if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ''
    if (direction === 'before') {
      if (offset === 0 || (offset === 1 && text[0] === ' ')) candidate = node.previousSibling
    } else if (offset === text.length) candidate = node.nextSibling
  }
  return isChip(candidate) ? candidate : null
}
function removeChip(chip: HTMLElement) {
  const root = editor.value
  if (!root) return
  const next = chip.nextSibling
  if (next?.nodeType === Node.TEXT_NODE && (next.textContent || '').startsWith(' '))
    next.textContent = (next.textContent || '').slice(1)
  const previous = chip.previousSibling
  const index = Array.from(root.childNodes).indexOf(chip)
  chip.remove()
  if (previous?.nodeType === Node.TEXT_NODE) placeCaret(previous, (previous.textContent || '').length)
  else placeCaret(root, Math.max(0, index))
  clearSelectedChip()
  ensureTail(root)
  syncFromDom()
  pruneReferences()
  updateMenu()
}
function deleteChip(event: KeyboardEvent) {
  const chip = adjacentChip(event.key === 'Backspace' ? 'before' : 'after')
  if (!chip) return false
  event.preventDefault()
  if (selectedChip.value === chip) removeChip(chip)
  else {
    clearSelectedChip()
    selectedChip.value = chip
    chip.classList.add('is-selected')
  }
  return true
}

// ---- 弹出菜单：按光标前的触发符决定是技能还是资料；资料按当前作品缓存一次。
type MenuRow = { key: string; title: string; hint?: string; keywords?: string; icon: string; group?: string; skill?: string; mention?: MentionItem }
const menu = ref<MenuTrigger | null>(null)
const active = ref(0)
const mentionCache = ref<{ bookId: string; items: MentionItem[] } | null>(null)
const mentionLoading = ref(false)
const ICONS: Record<MentionItem['kind'], string> = {
  chapter: 'fa-regular fa-file-lines',
  character: 'fa-regular fa-user',
  setting: 'fa-solid fa-mountain-sun',
  outline: 'fa-solid fa-list',
  storyline: 'fa-solid fa-route',
  breakdown: 'fa-solid fa-book-open'
}
const menuItems = computed<MenuRow[]>(() => {
  const current = menu.value
  if (!current) return []
  if (current.kind === 'skill')
    return filterItems(
      store.skills
        .filter(skill => skill.enabled)
        .map(skill => ({ key: skill.id, title: skillLabel(skill), hint: skill.description, keywords: skill.name + ' ' + skill.description, icon: 'fa-solid fa-wand-magic-sparkles', skill: skill.name })),
      current.query
    )
  const items = mentionCache.value?.bookId === store.bookId ? mentionCache.value.items : []
  return filterItems(
    items.map(item => ({
      key: `${item.kind}:${item.id}`,
      title: item.title,
      hint: item.hint,
      icon: ICONS[item.kind],
      group: REFERENCE_GROUPS[item.kind],
      mention: item
    })),
    current.query,
    16
  )
})
const menuEmpty = computed(() => {
  if (!menu.value) return ''
  if (menu.value.kind === 'skill') return store.skills.some(s => s.enabled) ? '没有匹配的技能' : '还没有启用的技能'
  if (!store.bookId) return '先在下方选择作品，再 @ 它的章节、人物和设定'
  if (mentionLoading.value) return '正在读取作品资料…'
  return '没有匹配的资料'
})
async function loadMentions() {
  const bookId = store.bookId
  if (!bookId || mentionCache.value?.bookId === bookId) return
  mentionLoading.value = true
  try {
    const items = await listMentionItems(bookId)
    if (store.bookId === bookId) mentionCache.value = { bookId, items }
  } catch {
    mentionCache.value = { bookId, items: [] }
  } finally {
    mentionLoading.value = false
  }
}
watch(
  () => store.bookId,
  () => {
    mentionCache.value = null
  }
)
function updateMenu() {
  const next = detectMenu(store.draft, caretOffset())
  const changed = !menu.value || !next || menu.value.start !== next.start || menu.value.kind !== next.kind
  menu.value = next
  if (changed) active.value = 0
  if (next?.kind === 'mention') void loadMentions()
}
function closeMenu() {
  menu.value = null
}
function choose(index: number) {
  const current = menu.value,
    row = menuItems.value[index]
  if (!current || !row) return
  let next = removeTrigger(store.draft, current)
  // 标记就放在触发符原来的位置，可以在句子中间；一条消息只有一个技能
  if (row.skill) next = insertSkillToken(next.text, row.skill, next.caret, findSkillToken(next.text, skillNames.value))
  if (row.mention) {
    store.addReference(row.mention)
    next = insertToken(next.text, mentionToken(row.mention.title), next.caret)
  }
  store.draft = next.text
  render(next.text)
  menu.value = null
  void nextTick(() => {
    editor.value?.focus()
    setCaret(next.caret)
  })
}

// ---- 事件
function onInput(event: Event) {
  syncFromDom()
  if ((event as InputEvent).isComposing) return
  pruneReferences()
  updateMenu()
}
function onCompositionEnd() {
  // 输入法选完字后文字才定，这时再看有没有触发符
  void nextTick(() => {
    syncFromDom()
    pruneReferences()
    updateMenu()
  })
}
function onKeydown(event: KeyboardEvent) {
  // 输入法拼字期间的按键（包括确认候选的回车）都交给输入法
  if (event.isComposing || event.keyCode === 229) return
  if ((event.key === 'Backspace' || event.key === 'Delete') && deleteChip(event)) return
  clearSelectedChip()
  if (menu.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = menuItems.value.length
      if (count) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
      return
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      if (menuItems.value.length) {
        event.preventDefault()
        choose(active.value)
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return
    }
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (isSendShortcut(event, store.enterToSend)) {
      closeMenu()
      void store.send()
    } else insertText('\n')
  }
}
function onKeyup(event: KeyboardEvent) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) updateMenu()
}
function onClick() {
  clearSelectedChip()
  updateMenu()
}
function onPaste(event: ClipboardEvent) {
  event.preventDefault()
  insertText(event.clipboardData?.getData('text/plain') || '')
}
function onBlur() {
  closeMenu()
  clearSelectedChip()
}
defineExpose({
  focus: () => {
    editor.value?.focus()
    setCaret(store.draft.length)
  }
})
</script>
