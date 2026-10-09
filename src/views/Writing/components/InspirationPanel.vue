<template>
  <div class="panel-content">
    <!-- 面板标题 -->
    <div class="panel-header">
      <span class="panel-title">{{ title }}便签</span>
      <div class="panel-actions">
        <i class="fa-solid fa-xmark action-icon" @click="$emit('close')"></i>
      </div>
    </div>

    <!-- 搜索和添加栏 -->
    <div class="search-area">
      <div class="search-input-wrapper">
        <input v-model="searchQuery" type="text" placeholder="搜索灵感..." class="search-input" />
        <i class="fa-solid fa-magnifying-glass search-icon"></i>
      </div>
      <button class="add-btn" @click="generateInspiration" :disabled="aiGenerating" title="AI 生成灵感">
        <i :class="aiGenerating ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"></i>
      </button>
      <button class="add-btn" @click="addInspiration" title="添加灵感">
        <i class="fa-solid fa-plus"></i>
      </button>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-area">
      <span class="filter-text" :class="{ active: filterTag }">
        {{ filterTag ? '已筛选' : '全部' }}
      </span>
      <el-popover placement="bottom-end" width="auto" trigger="click" popper-class="inspiration-popover">
        <template #reference>
          <div class="filter-trigger">
            <i class="fa-solid fa-filter filter-icon" :class="{ active: filterTag }"></i>
          </div>
        </template>
        <div class="filter-menu">
          <div class="filter-chip" :class="{ active: !filterTag }" @click="filterTag = null">
            全部
          </div>
          <!-- 只有当有可用标签时才显示分割线 -->
          <div class="filter-divider" v-if="availableTags.length > 0"></div>
          <div
            v-for="tag in availableTags"
            :key="tag"
            class="filter-chip"
            :class="{ active: filterTag === tag }"
            @click="filterTag = tag"
          >
            {{ displayTag(tag) }}
          </div>
        </div>
      </el-popover>
    </div>

    <!-- 灵感列表 -->
    <div class="inspiration-list">
      <div v-if="loading" class="loading-state">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
        <p>正在加载灵感...</p>
      </div>
      <template v-else>
        <TransitionGroup name="list">
          <div v-for="item in filteredList" :key="item.id" class="inspiration-card">
            <!-- 卡片内容 -->
            <div class="card-body" :class="{ expanded: item.expanded }">
              <div class="card-content">
                <InspirationInput
                  :model-value="item.content"
                  :options="tagOptions"
                  :max-length="500"
                  min-height="130px"
                  placeholder="记录此刻的灵感..."
                  :ref="inputRefSetter(item.id)"
                  @update:model-value="value => handleContentUpdate(value, item)"
                />
              </div>
            </div>

            <div class="card-footer">
              <span class="card-time">{{ item.displayTime }}</span>
              <div class="card-actions">
                <button
                  v-if="item.isLongContent"
                  class="toggle-btn"
                  type="button"
                  @click.stop="toggleExpand(item)"
                >
                  {{ item.expanded ? '收起' : '展开' }}
                </button>
                <div class="action-group">
                  <button
                    class="action-btn"
                    type="button"
                    title="复制"
                    @click.stop="copyContent(item)"
                  >
                    <i class="fa-regular fa-copy"></i>
                  </button>
                  <button
                    class="action-btn"
                    type="button"
                    title="删除"
                    @click.stop="deleteInspiration(item.id)"
                  >
                    <i class="fa-regular fa-trash-can"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </TransitionGroup>

        <!-- 空状态 -->
        <div v-if="filteredList.length === 0" class="empty-state">
          <i class="fa-regular fa-lightbulb"></i>
          <p>{{ emptyText }}</p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import dayjs from 'dayjs'
import InspirationInput from '@/components/InspirationInput.vue'
import {
  addLocalInspiration,
  deleteLocalInspirations,
  listLocalInspirations,
  updateLocalInspiration
} from '@/storage/local-inspiration'
// 开源版：AI 生成灵感走本地 BYOK 直连
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildInspirationSparkMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import type { Inspiration } from '@/types'

defineProps<{
  title: string
  bookId?: string | number
}>()

defineEmits<{
  (e: 'close'): void
}>()

const UNTAGGED = '__untagged__'

interface InspirationItem extends Inspiration {
  displayTime: string
  expanded: boolean
  isLongContent: boolean
}

interface MentionOption {
  value: string
  label: string
  meta?: string
}

type InspirationInputExpose = {
  focus: () => void
  getEditor: () => HTMLDivElement | null
}

// --- 状态 ---
const searchQuery = ref('')
const filterTag = ref<string | null>(null)
const inputRefs = ref<Map<number, InspirationInputExpose>>(new Map())
const inspirationList = ref<InspirationItem[]>([])
const loading = ref(false)
const pendingFocusId = ref<number | null>(null)
const saveTimerMap = new Map<number, number>()

// --- 计算属性 ---
const normalizeTag = (tag?: string) => {
  const value = String(tag || '').trim()
  return value ? value : UNTAGGED
}

const displayTag = (tag?: string) => {
  const value = normalizeTag(tag)
  return value === UNTAGGED ? '未分类' : value
}

const persistTag = (tag?: string) => {
  const value = String(tag || '').trim()
  return value === UNTAGGED ? '' : value
}

const availableTags = computed(() => {
  const existing = new Set<string>()
  inspirationList.value.forEach(item => existing.add(normalizeTag(item.tag)))
  return Array.from(existing)
})

const tagOptions = computed(() => {
  const result: MentionOption[] = []
  const seen = new Set<string>()
  inspirationList.value.forEach(item => {
    const normalized = normalizeTag(item.tag)
    if (!normalized || normalized === UNTAGGED || seen.has(normalized)) return
    seen.add(normalized)
    result.push({ value: normalized, label: normalized })
  })
  return result
})

const filteredList = computed(() => {
  let list = inspirationList.value

  if (filterTag.value) {
    list = list.filter(item => normalizeTag(item.tag) === filterTag.value)
  }

  const keyword = searchQuery.value.trim().toLowerCase()
  if (keyword) {
    list = list.filter(item =>
      (item.content || '').toLowerCase().includes(keyword) ||
      item.displayTime.toLowerCase().includes(keyword)
    )
  }
  return list
})

const emptyText = computed(() => '暂无灵感，点击右上角 + 号添加')

const normalizeInputText = (text: string) => text.replace(/\u00a0/g, ' ')

const extractTagAndContent = (text: string) => {
  const normalized = normalizeInputText(text || '')
  const match = normalized.match(/(^|[\s\u00a0\n])#([^\s#]+)/)
  if (!match) {
    return { tag: '', content: normalized.trim() }
  }
  const tag = match[2]
  const content = normalized
    .replace(match[0], match[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
  return { tag, content }
}

const loadInspirations = async () => {
  loading.value = true
  inputRefs.value = new Map()
  try {
    inspirationList.value = listLocalInspirations().map(mapNoteToItem)
    await nextTick()
    inspirationList.value.forEach(item => {
      const editor = inputRefs.value.get(item.id)?.getEditor() || null
      checkLongContent(editor, item.id)
    })
    if (pendingFocusId.value) {
      inputRefs.value.get(pendingFocusId.value)?.focus()
      pendingFocusId.value = null
    }
  } catch (error) {
    console.error('加载灵感失败:', error)
    ElMessage.error('加载灵感失败')
  } finally {
    loading.value = false
  }
}

const mapNoteToItem = (note: Inspiration): InspirationItem => ({
  ...note,
  content: mergeTagIntoContent(note.content || '', String(note.tag || '').trim()),
  tag: String(note.tag || '').trim(),
  displayTime: formatDisplayTime(note.updateTime || note.createTime),
  expanded: false,
  isLongContent: false
})

const formatDisplayTime = (value?: string) => {
  if (!value) return dayjs().format('YYYY-MM-DD HH:mm')
  return dayjs(value).format('YYYY-MM-DD HH:mm')
}

// --- 操作 ---
const addInspiration = async () => {
  try {
    const created = await addLocalInspiration({
      content: '',
      tag: filterTag.value ? persistTag(filterTag.value) : ''
    })
    pendingFocusId.value = created.id
    await loadInspirations()
  } catch (error) {
    console.error('新增灵感失败:', error)
    ElMessage.error('新增灵感失败')
  }
}

const aiGenerating = ref(false)
const aiModelStore = useAiModelStore()
// AI 生成灵感：参照最近的灵感标签与内容，本地模型直连生成一条
const generateInspiration = async () => {
  if (aiGenerating.value) return
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  aiGenerating.value = true
  try {
    const recent = listLocalInspirations().slice(0, 8)
    const spark = await requestLocalChatCompletion({
      scene: 'inspiration_spark',
      sceneLabel: '灵感激发',
      modelCode,
      messages: buildInspirationSparkMessages({
        recentTags: [...new Set(recent.map(item => String(item.tag || '').trim()).filter(Boolean))],
        recentContents: recent.map(item => String(item.content || '').slice(0, 60)).filter(Boolean),
      }),
    })
    const content = String(spark || '').trim()
    if (!content) throw new Error('AI 暂无灵感返回')
    await addLocalInspiration({ content, tag: 'AI灵感' })
    await loadInspirations()
    ElMessage.success('已生成一条 AI 灵感')
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('AI 生成灵感失败:', error)
    ElMessage.error(String(error?.message || 'AI 生成灵感失败，请稍后重试'))
  } finally {
    aiGenerating.value = false
  }
}

const deleteInspiration = async (id: number) => {
  if (!id) return
  try {
    await inkConfirm('确定删除该灵感便签吗？', '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    await deleteLocalInspirations([id])
    inputRefs.value.delete(id)
    await loadInspirations()
    ElMessage.success('灵感已删除')
  } catch (error) {
    console.error('删除灵感失败:', error)
    ElMessage.error('删除灵感失败')
  }
}

const toggleExpand = (item: InspirationItem) => {
  item.expanded = !item.expanded
}

const copyContent = async (item: InspirationItem) => {
  const text = item.content || ''
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      throw new Error('clipboard unsupported')
    }
    ElMessage.success('已复制灵感内容')
  } catch (error) {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      ElMessage.success('已复制灵感内容')
    } catch (err) {
      console.error('复制灵感失败:', error || err)
      ElMessage.error('复制失败，请手动复制')
    }
  }
}

const resolveInputRef = (
  el: Element | ComponentPublicInstance | null
): InspirationInputExpose | null => {
  if (!el) return null
  if (typeof el === 'object' && 'getEditor' in el && 'focus' in el) {
    return el as InspirationInputExpose
  }
  return null
}

const setInputRef = (el: Element | ComponentPublicInstance | null, id: number) => {
  const instance = resolveInputRef(el)
  if (instance) {
    inputRefs.value.set(id, instance)
    nextTick(() => {
      const editor = instance.getEditor()
      checkLongContent(editor, id)
    })
    return
  }
  inputRefs.value.delete(id)
}

const inputRefSetter = (id: number) => {
  return (el: Element | ComponentPublicInstance | null) => setInputRef(el, id)
}

const handleContentUpdate = (value: string, item: InspirationItem) => {
  item.content = value
  syncItemTag(item, value)
  const editor = inputRefs.value.get(item.id)?.getEditor() || null
  checkLongContent(editor, item.id)
  scheduleContentSave(item)
}

const checkLongContent = (el: HTMLElement | null, id: number) => {
  const item = inspirationList.value.find(i => i.id === id)
  if (!item) return
  const length = (item.content || '').length
  if (!el) {
    item.isLongContent = length > 80
    return
  }
  item.isLongContent = el.scrollHeight > 200 || length > 80
}

const scheduleContentSave = (item: InspirationItem) => {
  const timer = saveTimerMap.get(item.id)
  if (timer) {
    window.clearTimeout(timer)
  }
  const newTimer = window.setTimeout(async () => {
    await persistContent(item)
    saveTimerMap.delete(item.id)
  }, 600)
  saveTimerMap.set(item.id, newTimer)
}

const persistContent = async (item: InspirationItem) => {
  try {
    const parsed = extractTagAndContent(item.content || '')
    item.tag = parsed.tag
    await updateLocalInspiration({
      id: item.id,
      content: parsed.content,
      tag: persistTag(parsed.tag)
    })
    item.content = mergeTagIntoContent(parsed.content, parsed.tag)
    item.displayTime = formatDisplayTime()
  } catch (error) {
    console.error('保存灵感失败:', error)
    ElMessage.error('保存灵感失败')
  }
}

onBeforeUnmount(() => {
  saveTimerMap.forEach(timer => window.clearTimeout(timer))
  saveTimerMap.clear()
})


const mergeTagIntoContent = (content: string, tag: string) => {
  const normalized = String(tag || '').trim()
  if (!normalized) return content
  const token = `#${normalized}`
  const safeContent = String(content || '')
  if (safeContent === token || safeContent.startsWith(`${token} `)) return safeContent
  return safeContent ? `${token} ${safeContent}` : token
}

const syncItemTag = (item: InspirationItem, text: string) => {
  const parsed = extractTagAndContent(text)
  item.tag = parsed.tag
}

// --- 数据加载 ---
loadInspirations()
</script>

<style scoped lang="scss">
.panel-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 320px;
  background: transparent;
  height: 100%;

  .panel-header {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-bottom: 1px solid var(--divider);
    background: var(--panel-header-bg);
    flex-shrink: 0;

    .panel-title {
      font-weight: bold;
      font-size: 14px;
      color: var(--ink-main);
    }

    .panel-actions {
      .action-icon {
        font-size: 12px;
        color: var(--ink-sec);
        opacity: 0.6;
        cursor: pointer;
        transition: all 0.2s;

        &:hover {
          opacity: 1;
          color: var(--ink-main);
        }
      }
    }
  }

  .search-area {
    padding: 12px;
    display: flex;
    gap: 8px;
    align-items: center;

    .search-input-wrapper {
      position: relative;
      flex: 1;

      .search-input {
        width: 100%;
        padding: 4px 24px 4px 8px;
        font-size: 12px;
        border: 1px solid var(--input-border);
        border-radius: 4px;
        background: var(--input-bg);
        color: var(--ink-main);
        height: 26px;

        &::placeholder {
          color: var(--ink-sec);
          opacity: 0.5;
        }

        &:focus {
          background: var(--input-focus-bg);
          outline: none;
          border-color: var(--ink-accent);
        }
      }

      .search-icon {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        color: var(--ink-sec);
        opacity: 0.5;
      }
    }

    .add-btn {
      background: none;
      border: none;
      color: var(--ink-sec);
      font-size: 14px;
      cursor: pointer;
      transition: color 0.3s ease;
      width: auto;
      height: auto;
      display: inline-block;

      &:hover {
        color: var(--ink-main);
        background: none;
        transform: none;
      }

      &:active {
        transform: none;
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }
  }

  .filter-area {
    padding: 0 12px 8px;
    display: flex;
    justify-content: space-between;

    .filter-trigger {
      display: flex;
      align-items: center;
      gap: 8px; // Space between text and icon
      cursor: pointer;
      font-size: 12px;
      color: var(--ink-sec);
      transition: color 0.2s;

      &:hover {
        color: var(--ink-main);
      }

      .filter-text {
        &.active {
          color: var(--ink-main);
          font-weight: bold;
        }
      }

      .filter-icon {
        &.active {
          color: var(--ink-accent, var(--state-info));
        }
      }
    }
  }

  .inspiration-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px 40px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;

    /* 滚动条样式 */
    // &::-webkit-scrollbar {
    //   width: 4px;
    // }

    // &::-webkit-scrollbar-thumb {
    //   background: rgba(0, 0, 0, 0.1);
    //   border-radius: 2px;
    // }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--ink-sec);
      opacity: 0.6;

      i {
        font-size: 24px;
        margin-bottom: 8px;
      }

      p {
        font-size: 12px;
      }
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--ink-sec);
      gap: 8px;

      i {
        font-size: 16px;
      }

      p {
        font-size: 12px;
      }
    }

    .inspiration-card {
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--ink-main) 16%, transparent);
      background: var(--ui-glass-bg);
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;

      &:hover {
        transform: translateY(-2px);
        box-shadow: var(--ui-shadow);
        border-color: color-mix(in srgb, var(--ink-accent) 35%, transparent);
      }

      .card-body {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 6px;

        .card-content {
          position: relative;
          max-height: 160px; // Collapsed height limit
          overflow: hidden;
          transition: max-height 0.3s ease;

          &:focus-within {
            overflow: visible;
          }
        }

        &.expanded .card-content {
          max-height: 500px; // Expanded height limit
        }

      }

      .card-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: var(--ink-sec);
        border-top: 1px solid color-mix(in srgb, var(--ink-main) 6%, transparent);
        padding-top: 10px;

        .card-time {
          color: var(--ink-sec);
        }

        .card-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .toggle-btn {
          border: none;
          background: transparent;
          color: var(--ink-accent);
          cursor: pointer;
          font-size: 12px;
          padding: 0;

          &:hover {
            color: var(--ink-main);
          }
        }

        .action-group {
          display: flex;
          gap: 10px;
          opacity: 0;
          transition: opacity 0.2s ease;
        }

        .action-btn {
          border: none;
          background: transparent;
          color: var(--ink-sec);
          cursor: pointer;
          transition: color 0.2s ease;
          padding: 0;
        }

        .action-btn:hover {
          color: var(--ink-main);
        }
      }
    }

    .inspiration-card:hover .action-group {
      opacity: 1;
    }
  }
}

// 列表过渡动画
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>

<style lang="scss">
// 全局样式 (Popover)
.inspiration-popover.el-popover {
  padding: 8px !important;
  min-width: unset !important; // Remove fixed min-width to allow shrinking
  width: max-content !important; // Adapt to content width
  border-radius: 12px !important;
  border: 1px solid var(--ui-border) !important;
  box-shadow: var(--ui-shadow) !important;
  background: var(--ui-glass-bg-hover) !important;
  backdrop-filter: blur(16px) !important;
  overflow: hidden;

  .el-popover__title {
    display: none;
  }

  // 隐藏箭头，因为玻璃拟态下箭头很难处理得好看
  .el-popper__arrow::before {
    background: var(--ui-glass-bg-hover) !important;
    border: 1px solid var(--ui-border) !important;
    display: none;
  }

  .card-menu {
    .menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 13px;
      color: var(--state-danger); // Red for delete

      &:hover {
        background: var(--state-danger-surface);
      }

      i {
        font-size: 14px;
        color: var(--state-danger);
      }
    }
  }

  .filter-menu {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    flex-wrap: wrap;

    .filter-chip {
      padding: 2px 8px;
      height: 22px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      border: 1px solid var(--divider);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      background: var(--surface-1);
      white-space: nowrap; // Prevent text wrap
      flex-shrink: 0; // Prevent shrinking

      &:hover {
        background: var(--overlay-hover);
      }

      &.active {
        // background: var(--ui-glass-bg, var(--state-info));
        background: var(--overlay-active);
        // color: white;
        border-color: transparent;
        box-shadow: 0 0 0 2px var(--card-bg), 0 0 0 4px var(--ink-accent, var(--state-info));
      }
    }

    .filter-divider {
      width: 1px;
      height: 16px;
      background: var(--divider);
      margin: 0 4px;
    }

  }
}
</style>
