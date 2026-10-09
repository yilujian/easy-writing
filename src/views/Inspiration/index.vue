<template>
  <div class="inspiration-page">
    <div class="page-header">
      <div class="header-title">
        <h1>灵感素材</h1>
        <p>捕捉思绪，AI 助你笔下生花</p>
      </div>
      <div class="header-search" :class="{ focused: isSearchFocused }">
        <i class="fa-solid fa-magnifying-glass search-icon"></i>
        <input
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="搜索灵感..."
          @keyup.enter="handleSearch"
          @focus="isSearchFocused = true"
          @blur="isSearchFocused = false"
        />
      </div>
    </div>

    <div class="inspiration-grid">
      <section class="inspiration-main">
        <div class="input-card fusion-card">
          <div class="input-header">
            <span class="input-title">灵感输入</span>
            <span class="input-meta">
              {{ `${draftLength}/500` }}
            </span>
          </div>
          <InspirationInput
            :model-value="draft"
            :options="tagOptions"
            :max-length="500"
            min-height="130px"
            placeholder="在此记录一个脑洞，输入 #标签 空格生成标签..."
            @update:model-value="handleDraftUpdate"
          />
          <div class="input-actions">
            <!-- 保留占位容器以维持“保存灵感”按钮的右对齐布局；
                 原“标签”按钮无点击行为（死按钮），#标签 语法已在输入框 placeholder 说明，故移除 -->
            <div class="input-tools"></div>
            <button
              class="ink-btn ink-btn-primary"
              type="button"
              :disabled="submitting"
              @click="handleSubmit"
            >
              保存灵感
            </button>
          </div>
        </div>

        <div class="list-card fusion-card">
          <div class="list-header">
            <div class="list-title">灵感列表</div>
            <div class="list-meta">共 {{ inspirations.length }} 条</div>
          </div>
          <div class="list-tabs">
            <button
              v-for="tab in categoryTabs"
              :key="tab.value"
              class="tab-item"
              :class="{ active: activeCategory === tab.value }"
              type="button"
              @click="activeCategory = tab.value"
            >
              <span>{{ tab.label }}</span>
              <span class="tab-count">{{ categoryCounts[tab.value] || 0 }}</span>
            </button>
          </div>
          <div v-if="loading" class="list-empty">
            <i class="fa-solid fa-spinner fa-spin"></i>
            正在加载灵感...
          </div>
          <div v-else-if="!inspirations.length" class="list-empty">
            暂无灵感，先记录一条吧
          </div>
          <div v-else class="masonry">
            <article
              v-for="item in filteredInspirations"
              :key="item.id"
              class="inspiration-item"
              @click="startEdit(item)"
            >
              <i v-if="item.isPinned" class="pin-icon fa-solid fa-thumbtack" title="置顶"></i>
              <div v-if="editingId !== item.id" class="item-main">
                <!-- eslint-disable vue/no-v-html -- renderListContent 先 escapeHtml 再标注标签，无注入面 -->
                <p
                  :ref="setContentRef(item.id)"
                  class="item-content"
                  :class="{ expanded: isExpanded(item.id) }"
                  v-html="renderListContent(item.content)"
                >
                </p>
                <!-- eslint-enable vue/no-v-html -->
              </div>
              <div v-else class="item-edit">
                <InspirationInput
                  :ref="setEditInputRef"
                  :model-value="editingDraft"
                  :options="tagOptions"
                  :max-length="500"
                  min-height="130px"
                  placeholder="记录此刻的灵感..."
                  @update:model-value="handleEditUpdate"
                  @blur="handleEditBlur"
                  @click.stop
                />
              </div>
              <div class="item-footer">
                <span class="item-time">
                  {{ formatUpdateTime(item.updateTime || item.createTime) }}
                </span>
                <div class="item-actions">
                  <button
                    v-if="editingId !== item.id && hasOverflow(item.id)"
                    class="toggle-btn"
                    type="button"
                    @click.stop="toggleExpand(item.id)"
                  >
                    {{ isExpanded(item.id) ? '收起' : '展开' }}
                  </button>
                  <div v-if="editingId !== item.id" class="action-group">
                    <button
                      class="action-btn"
                      type="button"
                      @click.stop="copyInspiration(item)"
                    >
                      <i class="fa-regular fa-copy"></i>
                    </button>
                    <button
                      class="action-btn"
                      type="button"
                      @click.stop="deleteInspiration(item)"
                    >
                      <i class="fa-regular fa-trash-can"></i>
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <aside class="inspiration-side">
        <div class="side-card fusion-card">
          <div class="side-title">
            <span class="title-bar"></span>
            热门素材
          </div>
          <div v-if="hotTags.length" class="tag-list">
            <button
              v-for="tag in hotTags"
              :key="tag"
              class="tag-item"
              type="button"
              @click="handleTagClick(tag)"
            >
              {{ tag }}
            </button>
          </div>
          <div v-else class="tag-empty">
            暂无热门素材，多记录几条灵感即可生成
          </div>
        </div>

        <div class="side-card fusion-card">
          <div class="side-title side-title--with-action">
            <div class="side-title-text">
              <span class="title-bar"></span>
              每日推荐灵感
            </div>
            <button
              class="refresh-btn"
              type="button"
              :disabled="dailyRefreshing"
              @click="refreshDailySuggestion"
            >
              <i :class="dailyRefreshing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate'"></i>
            </button>
          </div>
          <div class="daily-card">
            {{ dailySuggestionText }}
          </div>
          <button class="link-button" type="button" @click="applyDailySuggestion">
            + 采纳
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { JsonRecord } from '@/types/json'
import { computed, nextTick, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import InspirationInput from '@/components/InspirationInput.vue'
import {
  addLocalInspiration,
  deleteLocalInspirations,
  getLocalInspirationInsights,
  listLocalInspirations,
  updateLocalInspiration
} from '@/storage/local-inspiration'
// 开源版：推荐灵感走本地 BYOK 直连
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildInspirationSparkMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'
import type { Inspiration, InspirationInsights } from '@/types'
const inspirations = ref<Inspiration[]>([])
const loading = ref(false)
const submitting = ref(false)
const keyword = ref('')
const draft = ref('')
const draftTag = ref('')
const activeCategory = ref('all')
const searchTimer = ref<number | null>(null)
const isSearchFocused = ref(false)
const editingId = ref<number | null>(null)
const editingDraft = ref('')
const editingOriginal = ref('')
const editingTag = ref('')
const editingTagOriginal = ref('')
const editTimer = ref<number | null>(null)
const expandedIds = ref<Set<number>>(new Set())
const overflowIds = ref<Set<number>>(new Set())
const contentRefs = ref<Record<number, Element | null>>({})
const dailyRefreshing = ref(false)
type InspirationInputExpose = {
  focus: () => void
}

const editInputRef = ref<InspirationInputExpose | null>(null)

const resolveInputRef = (
  el: Element | ComponentPublicInstance | null
): InspirationInputExpose | null => {
  if (!el) return null
  if (typeof el === 'object' && 'focus' in el) {
    return el as InspirationInputExpose
  }
  return null
}

const setEditInputRef = (el: Element | ComponentPublicInstance | null) => {
  editInputRef.value = resolveInputRef(el)
}

const UNTAGGED = '__untagged__'

interface MentionOption {
  value: string
  label: string
  meta?: string
}

const draftLength = computed(() => draft.value.length)
const hotTags = ref<string[]>([])
const dailySuggestion = ref('')
const dailySuggestionText = computed(() => {
  return dailySuggestion.value || '推荐灵感待接入本地 AI'
})
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

const escapeHtml = (value: string) => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const renderListContent = (text: string) => {
  if (!text) return ''
  const safeText = escapeHtml(text)
  return safeText.replace(
    /(^|[\s\u00a0\n])(#[^\s#]+)/,
    '$1<span class="tag-highlight">$2</span>'
  )
}
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

const categoryCounts = computed(() => {
  const counts: Record<string, number> = { all: inspirations.value.length }
  inspirations.value.forEach(item => {
    const key = normalizeTag(item.tag)
    counts[key] = (counts[key] || 0) + 1
  })
  return counts
})

const categoryTabs = computed(() => {
  const tabs = [{ label: '全部', value: 'all' }]
  const tagSet = new Set<string>()
  inspirations.value.forEach(item => {
    tagSet.add(normalizeTag(item.tag))
  })
  Array.from(tagSet).forEach(tag => {
    tabs.push({ label: displayTag(tag), value: tag })
  })
  return tabs
})

const tagOptions = computed(() => {
  const result: MentionOption[] = []
  const seen = new Set<string>()
  inspirations.value.forEach(item => {
    const normalized = normalizeTag(item.tag)
    if (!normalized || normalized === UNTAGGED || seen.has(normalized)) return
    seen.add(normalized)
    result.push({ value: normalized, label: normalized })
  })
  return result
})

const filteredInspirations = computed(() => {
  if (activeCategory.value === 'all') return inspirations.value
  return inspirations.value.filter(
    item => normalizeTag(item.tag) === activeCategory.value
  )
})

const formatUpdateTime = (value?: string) => {
  if (!value) return '刚刚'
  const date = dayjs(value)
  if (!date.isValid()) return '刚刚'
  const minutes = dayjs().diff(date, 'minute')
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = dayjs().diff(date, 'hour')
  if (hours < 24) return `${hours}小时前`
  const days = dayjs().diff(date, 'day')
  if (days < 30) return `${days}天前`
  return date.format('MM/DD')
}

const fetchInspirations = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const list = listLocalInspirations(keyword.value ? { keyword: keyword.value } : undefined)
    inspirations.value = list.map(item => ({
      ...item,
      content: mergeTagIntoContent(item.content || '', String(item.tag || '').trim())
    }))
    expandedIds.value = new Set()
    overflowIds.value = new Set()
    updateOverflow()
  } finally {
    loading.value = false
  }
}

const fetchInsights = async () => {
  applyInsights(getLocalInspirationInsights())
}

const applyInsights = (data?: InspirationInsights) => {
  hotTags.value = Array.isArray(data?.hotTags)
    ? data.hotTags.filter(tag => String(tag || '').trim())
    : []
  dailySuggestion.value = String(data?.dailySuggestion || '')
}

const handleSearch = () => {
  fetchInspirations()
}

const handleDraftUpdate = (value: string) => {
  draft.value = value
  syncDraftTag(value)
}

const handleTagClick = (tag: string) => {
  const normalized = String(tag || '').trim()
  if (!normalized) return
  const parsed = extractTagAndContent(draft.value)
  const merged = mergeTagIntoContent(parsed.content, normalized)
  draft.value = merged
  syncDraftTag(merged)
}

const handleSubmit = async () => {
  const parsed = extractTagAndContent(draft.value)
  draftTag.value = parsed.tag
  const content = parsed.content
  if (!content) {
    ElMessage.warning('请输入灵感内容')
    return
  }
  if (content.length > 500) {
    ElMessage.warning('内容请控制在500字以内')
    return
  }
  if (submitting.value) return
  submitting.value = true
  try {
    await addLocalInspiration({ content, tag: persistTag(parsed.tag) })
    ElMessage.success('灵感已保存')
    draft.value = ''
    draftTag.value = ''
    await fetchInspirations()
    await fetchInsights()
  } finally {
    submitting.value = false
  }
}

const applyDailySuggestion = () => {
  const suggestion = dailySuggestion.value.trim()
  if (!suggestion) {
    ElMessage.warning('暂无推荐灵感')
    return
  }
  draft.value = suggestion
  syncDraftTag(draft.value)
}

const suggestionLoading = ref(false)
const aiModelStore = useAiModelStore()
const refreshDailySuggestion = async () => {
  if (suggestionLoading.value) return
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  suggestionLoading.value = true
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
    dailySuggestion.value = content
    ElMessage.success('已生成新的推荐灵感')
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('生成推荐灵感失败:', error)
    ElMessage.error(String(error?.message || '生成推荐灵感失败，请稍后重试'))
  } finally {
    suggestionLoading.value = false
  }
}


// 解析 #标签：只抽取标签，不改动正文
const parseTagFromText = (text: string) => {
  const { tag } = extractTagAndContent(text)
  if (!tag) {
    return { tag: '', hasTag: false }
  }
  return { tag, hasTag: true }
}

const mergeTagIntoContent = (content: string, tag: string) => {
  const normalized = String(tag || '').trim()
  if (!normalized) return content
  const token = `#${normalized}`
  const safeContent = String(content || '')
  if (safeContent === token || safeContent.startsWith(`${token} `)) return safeContent
  return safeContent ? `${token} ${safeContent}` : token
}

const syncDraftTag = (text: string) => {
  const parsed = parseTagFromText(text)
  draftTag.value = parsed.hasTag ? parsed.tag : ''
}

const syncEditingTag = (text: string) => {
  const parsed = parseTagFromText(text)
  editingTag.value = parsed.hasTag ? parsed.tag : ''
}

const startEdit = async (item: Inspiration) => {
  if (editingId.value && editingId.value !== item.id) {
    await commitEdit(true)
  }
  if (editingId.value === item.id) return
  editingId.value = item.id
  const safeContent = (item.content || '').slice(0, 500)
  editingDraft.value = safeContent
  editingOriginal.value = safeContent
  const parsed = parseTagFromText(safeContent)
  editingTag.value = parsed.hasTag ? parsed.tag : String(item.tag || '').trim()
  editingTagOriginal.value = editingTag.value
  activeCategory.value = 'all'
  await nextTick()
  editInputRef.value?.focus()
}

const copyInspiration = async (item: Inspiration) => {
  const content = item.content || ''
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    ElMessage.success('已复制')
  } catch (err) {
    ElMessage.error('复制失败')
  }
}

const setContentRef =
  (id: number) =>
  (node: Element | ComponentPublicInstance | null, _refs?: JsonRecord) => {
    if (!node) {
      contentRefs.value[id] = null
      return
    }
    const el =
      typeof node === 'object' && node !== null && '$el' in node
        ? (node.$el as Element | null)
        : (node as Element)
    contentRefs.value[id] = el
  }

const isExpanded = (id: number) => expandedIds.value.has(id)

const hasOverflow = (id: number) => overflowIds.value.has(id)

const toggleExpand = (id: number) => {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

const updateOverflow = () => {
  nextTick(() => {
    const next = new Set(overflowIds.value)
    filteredInspirations.value.forEach(item => {
      const el = contentRefs.value[item.id]
      if (!el) return
      if (expandedIds.value.has(item.id)) {
        next.add(item.id)
        return
      }
      if (el.scrollHeight > el.clientHeight + 1) {
        next.add(item.id)
      } else {
        next.delete(item.id)
      }
    })
    overflowIds.value = next
  })
}

const deleteInspiration = async (item: Inspiration) => {
  try {
    await deleteLocalInspirations([item.id])
    inspirations.value = inspirations.value.filter(row => row.id !== item.id)
    const nextExpanded = new Set(expandedIds.value)
    nextExpanded.delete(item.id)
    expandedIds.value = nextExpanded
    const nextOverflow = new Set(overflowIds.value)
    nextOverflow.delete(item.id)
    overflowIds.value = nextOverflow
    if (editingId.value === item.id) {
      editingId.value = null
      editingDraft.value = ''
      editingOriginal.value = ''
      editingTag.value = ''
      editingTagOriginal.value = ''
    }
    await fetchInsights()
    ElMessage.success('已删除')
  } catch (err) {
    console.error('删除灵感失败:', err)
    ElMessage.error('删除失败')
  }
}

const scheduleEditCommit = () => {
  if (editTimer.value) {
    window.clearTimeout(editTimer.value)
  }
  editTimer.value = window.setTimeout(() => {
    commitEdit(false)
  }, 600)
}

const handleEditUpdate = (value: string) => {
  editingDraft.value = value
  syncEditingTag(value)
  if (editingId.value) {
    scheduleEditCommit()
  }
}

const handleEditBlur = async () => {
  await commitEdit(true)
}

const commitEdit = async (forceClose: boolean) => {
  if (!editingId.value) return
  if (editTimer.value) {
    window.clearTimeout(editTimer.value)
    editTimer.value = null
  }
  const parsed = extractTagAndContent(editingDraft.value)
  const originalParsed = extractTagAndContent(editingOriginal.value)
  editingTag.value = parsed.tag
  const content = parsed.content
  const original = originalParsed.content
  const tag = persistTag(parsed.tag)
  const originalTag = persistTag(editingTagOriginal.value)
  if (!content) {
    if (forceClose) {
      ElMessage.warning('内容不能为空')
      editingDraft.value = editingOriginal.value
      editingTag.value = editingTagOriginal.value
      editingId.value = null
    }
    return
  }
  if (content.length > 500) {
    if (forceClose) {
      ElMessage.warning('内容请控制在500字以内')
      editingDraft.value = editingOriginal.value
      editingTag.value = editingTagOriginal.value
      editingId.value = null
    }
    return
  }
  if (content === original && tag === originalTag) {
    if (forceClose) {
      editingId.value = null
    }
    return
  }
  try {
    const updated = await updateLocalInspiration({
      id: editingId.value,
      content,
      tag
    })
    const idx = inspirations.value.findIndex(item => item.id === editingId.value)
    if (idx !== -1) {
      const mergedContent = mergeTagIntoContent(content, tag)
      inspirations.value[idx] = updated
        ? { ...updated, content: mergeTagIntoContent(updated.content || '', String(updated.tag || '').trim()) }
        : {
            ...inspirations.value[idx],
            content: mergedContent,
            tag
          }
    }
    editingOriginal.value = content
    editingTagOriginal.value = tag
    await fetchInsights()
    const nextExpanded = new Set(expandedIds.value)
    nextExpanded.delete(editingId.value)
    expandedIds.value = nextExpanded
    if (forceClose) {
      editingId.value = null
    }
  } catch (err) {
    console.error('更新灵感失败:', err)
    ElMessage.error('更新失败')
    if (forceClose) {
      editingDraft.value = editingOriginal.value
      editingTag.value = editingTagOriginal.value
      editingId.value = null
    }
  }
}

fetchInspirations()
fetchInsights()

watch(
  () => keyword.value,
  () => {
    if (searchTimer.value) {
      window.clearTimeout(searchTimer.value)
    }
    searchTimer.value = window.setTimeout(() => {
      fetchInspirations()
    }, 300)
  }
)

watch(
  () => categoryTabs.value,
  tabs => {
    if (!tabs.find(tab => tab.value === activeCategory.value)) {
      activeCategory.value = 'all'
    }
  },
  { immediate: true }
)

watch(
  () => filteredInspirations.value,
  () => {
    updateOverflow()
  },
  { deep: true }
)

watch(
  () => editingId.value,
  value => {
    if (!value) {
      updateOverflow()
    }
  }
)
</script>

<style scoped lang="scss">
.inspiration-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.header-title {
  display: flex;
  flex-direction: column;
  gap: 6px;

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--ink-main);
  }

  p {
    margin: 0;
    font-size: 12px;
    color: var(--ink-sec);
  }
}

.header-search {
  position: relative;
  min-width: 280px;
}

.search-input {
  width: 100%;
  padding: 8px 12px 8px 30px !important;
  font-size: 12px;
  border: 1px solid var(--input-border);
  border-radius: 18px;
  background: var(--input-bg);
  color: var(--ink-main);
  box-shadow: var(--ui-shadow);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  border-radius: 20px !important;
  //缩进

  &::placeholder {
    color: var(--ink-sec);
    opacity: 0.6;
  }

  &:focus {
    outline: none;
  }
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--ink-sec);
  opacity: 0.6;
  font-size: 12px;
  pointer-events: none;
}

.header-search.focused .search-input {
  border-color: var(--input-focus-border);
  background: var(--input-focus-bg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink-accent) 18%, transparent);
}

.inspiration-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 18px;
}

.inspiration-main {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.input-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.input-title {
  font-weight: 600;
  color: var(--ink-main);
}

.input-meta {
  font-size: 12px;
  color: var(--ink-sec);
}


.input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.input-tools {
  display: flex;
  gap: 12px;
  color: var(--ink-sec);
  font-size: 12px;
}

.tool-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.list-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.list-tabs {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ui-border);
}

.tab-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--ink-sec);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 6px 0;
  position: relative;
}

.tab-item.active {
  color: var(--ink-accent);
}

.tab-item.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -5px;
  height: 3px;
  border-radius: 999px;
  background: var(--ink-accent);
}

.tab-count {
  min-width: 26px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--btn-ghost-bg);
  color: var(--ink-sec);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.list-title {
  font-weight: 600;
  color: var(--ink-main);
}

.list-meta {
  font-size: 12px;
  color: var(--ink-sec);
}

.masonry {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.inspiration-item {
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 16%, transparent);
  background: var(--ui-glass-bg);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  position: relative;
}

.inspiration-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--ui-shadow);
  border-color: color-mix(in srgb, var(--ink-accent) 35%, transparent);
}

.item-main {
  display: block;
}

.pin-icon {
  position: absolute;
  top: 10px;
  right: 12px;
  font-size: 12px;
  color: var(--ink-accent);
  opacity: 0.6;
}

.item-edit {
  display: block;
}


.item-content {
  font-size: 13px;
  color: var(--ink-main);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}

:deep(.item-content .tag-highlight) {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 16%, transparent);
  color: var(--ink-accent);
  font-weight: 600;
  margin: 0 2px;
}

.item-content.expanded {
  display: block;
  -webkit-line-clamp: unset;
  line-clamp: unset;
  overflow: visible;
}

.item-footer {
  font-size: 12px;
  color: var(--ink-sec);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid color-mix(in srgb, var(--ink-main) 6%, transparent);
  padding-top: 10px;
}


.item-actions {
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
}

.toggle-btn:hover {
  color: var(--ink-main);
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
}

.action-btn:hover {
  color: var(--ink-main);
}

.inspiration-item:hover .action-group {
  opacity: 1;
}

.list-empty {
  border: 1px dashed var(--ui-border);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--ink-sec);
  background: var(--btn-ghost-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.inspiration-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.side-card {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.side-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ink-main);
}

.side-title--with-action {
  justify-content: space-between;
}

.side-title-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.title-bar {
  width: 3px;
  height: 14px;
  background: var(--ink-accent);
  border-radius: 999px;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-item {
  border: none;
  background: var(--btn-ghost-bg);
  color: var(--ink-main);
  border: 1px solid var(--btn-ghost-border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.tag-item:hover {
  background: var(--btn-ghost-hover-bg);
  border-color: var(--btn-ghost-hover-border);
}

.tag-empty {
  font-size: 12px;
  color: var(--ink-sec);
  line-height: 1.6;
  padding: 6px 2px;
}

.daily-card {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--ink-accent) 30%, transparent);
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
  padding: 12px;
  font-size: 12px;
  color: var(--ink-main);
  line-height: 1.6;
}

.refresh-btn {
  border: none;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-radius: 8px;
  transition: color 0.2s ease, background 0.2s ease;
}

.refresh-btn:hover {
  color: var(--ink-main);
  background: var(--btn-ghost-bg);
}

.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.link-button {
  align-self: flex-end;
  font-size: 12px;
  color: var(--ink-accent);
  border: none;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@include content-max(920px) {
  .inspiration-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .header-search {
    width: 100%;
    min-width: 0;
  }

  .masonry {
    grid-template-columns: 1fr;
  }
}
</style>
