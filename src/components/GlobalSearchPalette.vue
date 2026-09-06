<!-- Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md. -->
<template>
  <Teleport to="body">
    <div v-if="visible" class="gsp-overlay" @mousedown.self="close">
      <div class="gsp-panel" role="dialog" aria-label="全局搜索">
        <div class="gsp-input-row">
          <i class="fa-solid fa-magnifying-glass gsp-input-icon"></i>
          <input
            ref="inputRef"
            v-model="query"
            class="gsp-input"
            type="text"
            placeholder="搜索作品或功能…"
            autocomplete="off"
            spellcheck="false"
            @keydown="handleInputKeydown"
          />
          <span class="gsp-kbd">Esc</span>
        </div>

        <div ref="listRef" class="gsp-results">
          <template v-for="section in sections" :key="section.key">
            <div class="gsp-section-title">{{ section.title }}</div>
            <button
              v-for="item in section.items"
              :key="item.key"
              type="button"
              class="gsp-item"
              :class="{ 'is-active': item.index === activeIndex }"
              @mouseenter="activeIndex = item.index"
              @click="confirmItem(item)"
            >
              <i class="gsp-item-icon" :class="item.icon"></i>
              <span class="gsp-item-label">{{ item.label }}</span>
              <span v-if="item.hint" class="gsp-item-hint">{{ item.hint }}</span>
              <span v-if="item.index === activeIndex" class="gsp-item-enter">↵</span>
            </button>
          </template>
          <div v-if="!flatItems.length" class="gsp-empty">没有匹配的结果</div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Book } from '@/types'
import { useAppConfigStore, type FeatureKey } from '@/stores/app-config'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { getDesktopPlatform } from '@/utils/desktop-window'

interface FeatureEntry {
  title: string
  path: string
  icon: string
  /** 拼音全拼/首字母/英文别名，配合标题做简单匹配 */
  keywords: string
  featureKey?: FeatureKey
}

interface PaletteItem {
  key: string
  type: 'feature' | 'book'
  label: string
  icon: string
  hint?: string
  path?: string
  bookId?: number
}

type IndexedItem = PaletteItem & { index: number }

// 功能导航静态表：与 src/router/index.ts 一级功能页、Sidebar 图标保持一致。
const FEATURE_ENTRIES: FeatureEntry[] = [
  { title: '本地中心', path: '/localCenter', icon: 'fa-solid fa-hard-drive', keywords: 'local backup beifen bendizhongxin' },
  { title: '首页', path: '/novel', icon: 'fa-solid fa-house', keywords: 'home shouye sy' },
  { title: '我的作品', path: '/myBooks', icon: 'fa-solid fa-book', keywords: 'books mybooks wodezuopin wdzp zuopin' },
  { title: '工作流建书', path: '/workflowBook', icon: 'fa-solid fa-diagram-project', keywords: 'workflow gongzuoliujianshu gzljs jianshu', featureKey: 'workflowBook' },
  { title: '码字统计', path: '/writeStatistics', icon: 'fa-solid fa-chart-line', keywords: 'statistics mazitongji mztj tongji', featureKey: 'writeStatistics' },
  { title: '榜单风向', path: '/novelRank', icon: 'fa-solid fa-arrow-trend-up', keywords: 'rank bangdanfengxiang bdfx bangdan', featureKey: 'novelRank' },
  { title: '竞品拆书', path: '/bookBreakdown', icon: 'fa-solid fa-file-invoice', keywords: 'breakdown jingpinchaishu jpcs chaishu', featureKey: 'breakdown' },
  { title: '灵感素材', path: '/inspiration', icon: 'fa-regular fa-lightbulb', keywords: 'inspiration linggansucai lgsc linggan', featureKey: 'inspiration' },
  { title: '模型管理', path: '/aiModels', icon: 'fa-solid fa-cube', keywords: 'models moxingguanli mxgl moxing', featureKey: 'byokModels' },
  { title: '问题反馈', path: '/feedback', icon: 'fa-regular fa-message', keywords: 'feedback wentifankui wtfk fankui' },
]

const MAX_BOOK_RESULTS = 20

const router = useRouter()
const route = useRoute()
const appConfigStore = useAppConfigStore()
const isMac = getDesktopPlatform() === 'macos'
// 独立参考面板窗口不挂全局搜索（保持精简形态）。
const isPanelWindow = typeof window !== 'undefined' && window.location.pathname.startsWith('/writing-panel/')

const visible = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const books = ref<Book[]>([])
let bookFetchSeq = 0

// 面板打开时拉一次作品列表；接口失败静默降级为只显示功能项。
const fetchBooks = async () => {
  const seq = ++bookFetchSeq
  try {
    // 与我的作品页一致，展示本地库作品
    const localBooks = await getLocalLibraryStorage().listLocalBooks({})
    if (seq === bookFetchSeq) {
      books.value = localBooks.filter(book => !book.deletedAt)
    }
  } catch {
    if (seq === bookFetchSeq) books.value = []
  }
}

const normalizedQuery = computed(() => query.value.trim().toLowerCase())

const featureItems = computed<PaletteItem[]>(() => {
  const q = normalizedQuery.value
  return FEATURE_ENTRIES
    .filter(entry => !entry.featureKey || appConfigStore.isFeatureEnabled(entry.featureKey))
    .filter(entry => !q || entry.title.toLowerCase().includes(q) || entry.keywords.toLowerCase().includes(q))
    .map(entry => ({
      key: `feature:${entry.path}`,
      type: 'feature' as const,
      label: entry.title,
      icon: entry.icon,
      path: entry.path,
    }))
})

const bookItems = computed<PaletteItem[]>(() => {
  const q = normalizedQuery.value
  return books.value
    .filter(book => !q || String(book.title || '').toLowerCase().includes(q))
    .slice(0, MAX_BOOK_RESULTS)
    .map(book => ({
      key: `book:${book.id}`,
      type: 'book' as const,
      label: String(book.title || '未命名作品'),
      icon: 'fa-solid fa-book-open',
      hint: book.wordCount ? `${book.wordCount}字` : undefined,
      bookId: book.id,
    }))
})

const sections = computed(() => {
  const result: Array<{ key: string; title: string; items: IndexedItem[] }> = []
  let index = 0
  const push = (key: string, title: string, items: PaletteItem[]) => {
    if (!items.length) return
    result.push({ key, title, items: items.map(item => ({ ...item, index: index++ })) })
  }
  push('features', '功能', featureItems.value)
  push('books', '作品', bookItems.value)
  return result
})

const flatItems = computed<IndexedItem[]>(() => sections.value.flatMap(section => section.items))

watch(normalizedQuery, () => {
  activeIndex.value = 0
})

watch(flatItems, items => {
  if (activeIndex.value > items.length - 1) activeIndex.value = Math.max(0, items.length - 1)
})

const scrollActiveIntoView = () => {
  void nextTick(() => {
    listRef.value?.querySelector('.gsp-item.is-active')?.scrollIntoView({ block: 'nearest' })
  })
}

watch(activeIndex, scrollActiveIntoView)

const open = () => {
  if (visible.value) {
    inputRef.value?.focus()
    return
  }
  query.value = ''
  activeIndex.value = 0
  visible.value = true
  void fetchBooks()
  void nextTick(() => inputRef.value?.focus())
}

const close = () => {
  visible.value = false
}

const confirmItem = (item: PaletteItem) => {
  if (item.type === 'feature' && item.path) {
    close()
    if (route.path !== item.path) void router.push(item.path)
    return
  }
  if (item.type === 'book' && item.bookId != null) {
    close()
    void router.push({ name: 'Writing', params: { bookId: item.bookId } })
    return
  }
}

const moveActive = (delta: number) => {
  const total = flatItems.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + delta + total) % total
}

const handleInputKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = flatItems.value[activeIndex.value]
    if (item) confirmItem(item)
  }
  // Esc 统一由全局 keydown 处理，避免重复关闭逻辑。
}

// ⌘K / Ctrl+K：mac 用 metaKey，其余平台用 ctrlKey，避免和系统习惯冲突。
const isSearchShortcut = (event: KeyboardEvent) => {
  if (event.key !== 'k' && event.key !== 'K') return false
  if (event.altKey || event.shiftKey) return false
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

const handleGlobalKeydown = (event: KeyboardEvent) => {
  if (isSearchShortcut(event)) {
    event.preventDefault()
    if (visible.value) {
      close()
    } else {
      open()
    }
    return
  }
  if (visible.value && event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

const handleOpenEvent = () => {
  open()
}

onMounted(() => {
  if (isPanelWindow) return
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('ew:global-search-open', handleOpenEvent)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('ew:global-search-open', handleOpenEvent)
})
</script>

<style scoped lang="scss">
.gsp-overlay {
  position: fixed;
  inset: 0;
  // 压过 titlebar(1000) 与 resize layer(1200)
  z-index: 1300;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 20vh;
  background: rgba(38, 32, 26, 0.32);
  backdrop-filter: blur(2px);
}

.gsp-panel {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 48px));
  max-height: 56vh;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ink-main) 14%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-main) 94%, #ffffff 6%);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--ink-main) 24%, transparent);
  backdrop-filter: blur(14px);
}

.gsp-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  height: 52px;
  padding: 0 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink-main) 10%, transparent);
}

.gsp-input-icon {
  font-size: 14px;
  color: var(--ink-sec);
}

.gsp-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink-main);
  font-size: 15px;

  &::placeholder {
    color: var(--ink-sec);
    opacity: 0.75;
  }
}

.gsp-kbd {
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 16%, transparent);
  border-radius: 5px;
  color: var(--ink-sec);
  font-size: 11px;
  line-height: 1.4;
}

.gsp-results {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.gsp-section-title {
  padding: 8px 10px 4px;
  color: var(--ink-sec);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.gsp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-main);
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &.is-active {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }
}

.gsp-item-icon {
  flex: 0 0 18px;
  font-size: 13px;
  text-align: center;
  color: var(--ink-sec);

  .gsp-item.is-active & {
    color: var(--ink-accent);
  }
}

.gsp-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gsp-item-hint {
  flex: 0 0 auto;
  color: var(--ink-sec);
  font-size: 11px;
}

.gsp-item-enter {
  flex: 0 0 auto;
  color: var(--ink-sec);
  font-size: 12px;
}

.gsp-empty {
  padding: 28px 0;
  color: var(--ink-sec);
  font-size: 13px;
  text-align: center;
}

.theme-dark .gsp-overlay {
  background: rgba(0, 0, 0, 0.5);
}

.theme-dark .gsp-panel {
  background: color-mix(in srgb, var(--bg-main) 88%, #ffffff 6%);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}
</style>
