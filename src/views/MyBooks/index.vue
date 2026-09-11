<template>
  <div class="my-works-page">
    <!-- 筛选栏 -->
    <div class="filter-section">
      <!-- 按钮工具栏 -->
      <div class="toolbar">
        <div class="toolbar-left">
          <button class="ink-btn ink-btn-primary" @click="handleCreate">
            <i class="fa-solid fa-plus"></i>
            创建作品
          </button>
          <!-- <el-dropdown trigger="hover" placement="bottom-start">
            <button class="ink-btn ink-btn-primary">
              <i class="fa-solid fa-plus"></i>
              创建作品
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item>小说</el-dropdown-item>
                <el-dropdown-item>剧本</el-dropdown-item>
                <el-dropdown-item>视频</el-dropdown-item>
              </el-dropdown-menu>
            </template>
</el-dropdown> -->

          <button class="ink-btn ink-btn-accent" type="button" @click="goBookBreakdown">
            <i class="fa-solid fa-scissors"></i>
            拆书
          </button>

          <button class="ink-btn ink-btn-outline" type="button" @click="handleImport">
            <i class="fa-solid fa-file-import"></i>
            导入
          </button>

        </div>

        <div class="toolbar-right">
          <div class="search-box">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input v-model="searchKeyword" type="text" placeholder="搜索书名、分类、简介" />
            <button v-if="searchKeyword" class="search-clear" type="button" title="清空搜索" @click="searchKeyword = ''">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <button class="recycle-bin-btn" title="回收站" @click="handleRecycle">
            <i class="fa-regular fa-trash-can"></i>
            回收站
          </button>
          <div class="divider"></div>
          <div class="view-mode-group">
            <button :class="['view-mode-button', { active: viewMode === 'grid' }]" @click="viewMode = 'grid'">
              <i class="fa-solid fa-table-cells-large"></i>
            </button>
            <button :class="['view-mode-button', { active: viewMode === 'list' }]" @click="viewMode = 'list'">
              <i class="fa-solid fa-list-ul"></i>
            </button>
          </div>
        </div>
      </div>

      <div class="group-panel">
        <div class="group-scroll">
          <button
:class="['group-tab', { active: activeGroup === 'all' }]" type="button"
            @click="handleSelectGroup('all')">
            <i class="fa-solid fa-layer-group"></i>
            <span>全部作品</span>
            <em v-if="booksLoaded">{{ totalCount }}</em>
            <em v-else class="skeleton-block count-skeleton" aria-hidden="true"></em>
          </button>
          <button
:class="['group-tab', { active: activeGroup === 'ungrouped' }]" type="button"
            @click="handleSelectGroup('ungrouped')">
            <i class="fa-solid fa-book"></i>
            <span>未分组</span>
            <em v-if="booksLoaded">{{ ungroupedCount }}</em>
            <em v-else class="skeleton-block count-skeleton" aria-hidden="true"></em>
          </button>
          <button
v-for="group in bookGroups" :key="group.id"
            :class="['group-tab', { active: activeGroup === String(group.id) }]" type="button"
            @click="handleSelectGroup(String(group.id))">
            <i class="fa-regular fa-folder"></i>
            <span>{{ group.title }}</span>
            <em v-if="booksLoaded">{{ getGroupCount(group.id) }}</em>
            <em v-else class="skeleton-block count-skeleton" aria-hidden="true"></em>
          </button>
          <button class="group-add" type="button" @click="handleCreateGroup">
            <i class="fa-solid fa-plus"></i>
            新建分组
          </button>
        </div>
        <button class="group-manage" type="button" @click="handleManageGroups">
          <i class="fa-solid fa-gear"></i>
          <span>管理分组</span>
        </button>
      </div>

    </div>

    <!-- 加载中：骨架卡片复用作品卡布局占位，避免整页 spinner 与"暂无作品"闪现。
         必须放在第一分支——分组接口先返回时 displaySections 已非空（空分组也算 section），
         放后面骨架永远走不到 -->
    <div v-if="!booksLoaded && booksLoading" class="works-sections skeleton-sections" aria-busy="true">
      <section class="works-section">
        <div class="works-section-header">
          <div class="skeleton-block skeleton-section-title"></div>
        </div>
        <div class="works-list grid-view">
          <div v-for="n in 6" :key="n" class="work-card fusion-card skeleton-card">
            <div class="skeleton-card-body">
              <div class="skeleton-block skeleton-cover"></div>
              <div class="skeleton-card-lines">
                <div class="skeleton-block skeleton-line skeleton-w60"></div>
                <div class="skeleton-block skeleton-line skeleton-w32"></div>
                <div class="skeleton-block skeleton-line skeleton-w92"></div>
                <div class="skeleton-block skeleton-line skeleton-w78"></div>
                <div class="skeleton-block skeleton-line skeleton-w40 skeleton-meta"></div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 作品列表 -->
    <div v-else-if="displaySections.length > 0" class="works-sections">
      <section v-for="(section, sectionIndex) in displaySections" :key="section.id" class="works-section">
        <div class="works-section-header">
          <h3>{{ section.title }}</h3>
          <div v-if="sectionIndex === 0" class="sort-control">
            <el-dropdown trigger="click" placement="bottom-end" @command="handleSortChange">
              <button class="sort-trigger" type="button">
                <strong>{{ activeSortLabel }}</strong>
                <i class="fa-solid fa-chevron-down caret-icon"></i>
              </button>
              <template #dropdown>
                <el-dropdown-menu class="sort-dropdown-menu">
                  <el-dropdown-item
v-for="option in sortOptions" :key="option.value" :command="option.value"
                    :class="{ active: sortValue === option.value }">
                    <i :class="option.icon"></i>
                    {{ option.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        <div class="works-list" :class="{ 'grid-view': viewMode === 'grid' }">
          <div v-for="work in section.books" :key="work.id" class="work-card fusion-card" @click="openWriting(work)">
            <!-- 封面展示 -->
            <div class="book-cover-wrapper">
              <div class="book-spine"></div>
              <img
                v-if="work.coverUrl && !coverLoadFailed[work.id]"
                :src="work.coverUrl"
                class="book-cover-img"
                alt="封面"
                @error="handleCoverError(work)"
              />
              <div v-else class="book-cover-placeholder">
                <img :src="themeStore.currentSkinObj.img" class="placeholder-bg" alt="" @error="(e) => ((e.target as HTMLElement).style.visibility = 'hidden')" />
                <div class="placeholder-content">
                  <span class="placeholder-title" :class="getDefaultCoverTitleClass(work.title)">
                    {{ work.title || '作品' }}
                  </span>
                </div>
              </div>
            </div>

            <div class="work-content">
              <div class="work-header">
                <h3 class="work-title">{{ work.title }}</h3>
                <el-tag :type="getTagType(work.category || '玄幻脑洞')" size="small" effect="plain" class="category-tag">
                  {{ work.category || '未分类' }}
                </el-tag>
              </div>

              <p class="work-description">{{ work.intro }}</p>

              <div class="work-meta">
                <span class="meta-item">
                  <!-- <i class="fa-solid fa-font"></i> -->
                  {{ wordCounter.value(work) == null ? '—' : formatWordCount(wordCounter.value(work)) }}
                </span>
                <span class="meta-item">
                  <i class="fa-regular fa-clock"></i>
                  {{ formatUpdateTime(work.updateTime) }}
                </span>
              </div>

              <div class="work-footer">
                <div class="work-actions">
                  <!-- 平台暂未开放：生成视频 / 转为剧本 -->
                  <!-- <div class="action-buttons">
                    <button class="ink-btn-action" type="button" title="生成视频" @click.stop>
                      <i class="fa-solid fa-video"></i>
                      <span class="btn-text">生成视频</span>
                    </button>
                    <button class="ink-btn-action" type="button" title="转为剧本" @click.stop>
                      <i class="fa-regular fa-file-text"></i>
                      <span class="btn-text">转为剧本</span>
                    </button>
                  </div> -->
                  <el-dropdown class="work-more-dropdown" trigger="click" placement="bottom-end">
                    <button class="more-button" @click.stop>
                      <i class="fa-solid fa-ellipsis"></i>
                    </button>
                    <template #dropdown>
                      <el-dropdown-menu class="work-dropdown-menu">
                        <el-dropdown-item class="edit-item" @click="handleEdit(work)">
                          <i class="fa-solid fa-pen-to-square"></i>
                          编辑作品
                        </el-dropdown-item>
                        <el-dropdown-item class="export-item" @click.stop="handleExport(work)">
                          <i class="fa-solid fa-file-export"></i>
                          导出作品
                        </el-dropdown-item>
                        <el-dropdown-item @click.stop="handleMoveGroup(work)">
                          <i class="fa-solid fa-folder-tree"></i>
                          移动分组
                        </el-dropdown-item>
                        <el-dropdown-item class="delete-item" @click="handleDelete(work)">
                          <i class="fa-solid fa-trash"></i>
                          删除作品
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state-container animate-fade-in">
      <div class="empty-content">
        <div class="empty-icon-wrapper">
          <i class="fa-solid fa-scroll"></i>
          <div class="ink-splash"></div>
        </div>
        <h3 class="empty-title">{{ hasActiveFilter ? '没有匹配作品' : '暂无作品' }}</h3>
        <p v-if="hasActiveFilter" class="empty-desc">调整搜索词或分组后再看看</p>
        <p v-else class="empty-desc">提笔挥毫，绘出心中万千世界<br>既然还没有作品，何不现在开始创作？</p>
        <button v-if="!hasActiveFilter" class="ink-btn ink-btn-primary large-btn" @click="handleCreate">
          <i class="fa-solid fa-feather-pointed"></i>
          开始创作
        </button>
      </div>
    </div>

    <!-- 弹窗 -->
    <CreateBookModal
v-model:visible="showCreateModal" :book-data="currentBook" :book-groups="bookGroups"
      @success="handleSaveSuccess" />
    <RecycleBinModal v-model:visible="showRecycleModal" @restore-success="refreshBooks" />
    <ExportBookModal v-model:visible="showExportModal" :book="exportBook" />
    <ImportBookModal v-model:visible="showImportModal" @success="refreshBooks" />

    <BookGroupModals
      ref="groupModalsRef"
      :book-groups="bookGroups"
      :get-group-count="getGroupCount"
      @changed="refreshBooks"
      @group-deleted="handleGroupDeleted"
    />
  </div>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { computed, onMounted, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import CreateBookModal from './components/CreateBookModal.vue'
import RecycleBinModal from './components/RecycleBinModal.vue'
import ExportBookModal from './components/ExportBookModal.vue'
import ImportBookModal from './components/ImportBookModal.vue'
import BookGroupModals from './components/BookGroupModals.vue'
import type { BookSortBy, BookSortOrder } from "@/types/book"
import { Book, BookGroup } from "@/types"
import { CATEGORY_TAG_MAP } from '@/utils/constants'
import { useThemeStore } from '@/stores/theme'
import { getLocalLibraryStorage } from '@/storage/local-library'

const wordCounter = useWordCount()

type SortValue = 'updateTime_DESC' | 'updateTime_ASC' | 'createTime_DESC' | 'wordCount_DESC' | 'wordCount_ASC' | 'title_ASC'

const router = useRouter()
const route = useRoute()
const themeStore = useThemeStore()

// 数据
const showCreateModal = ref(false)
const showRecycleModal = ref(false)
const showExportModal = ref(false)
const showImportModal = ref(false)
const currentBook = ref<Book | null>(null)
const exportBook = ref<Book | null>(null)
// const activeTab = ref('long')
const viewMode = ref('grid')

// 全量书籍（一次网络拉取，服务端上限 200 条）：搜索/分组过滤/排序/计数全部在前端本地完成，
// 切换分组、排序、搜索不再发请求；下拉数据变更（增删改/导入/还原）后重拉一次。
const allBooks = ref<Book[]>([])
const bookGroups = ref<BookGroup[]>([])
const activeGroup = ref<'all' | 'ungrouped' | string>('all')
const sortValue = ref<SortValue>('updateTime_DESC')
const searchKeyword = ref('')
const coverLoadFailed = ref<Record<number, true>>({})
// 初始为 true：进入页面立即处于加载态，用骨架屏顶住首屏，避免闪现“暂无作品”
const booksLoading = ref(true)
// 首次列表数据（含离线回退）就绪后为 true，分组计数在此之前显示骨架占位而非 0
const booksLoaded = ref(false)
let booksFetchSeq = 0

const sortOptions: Array<{ value: SortValue; label: string; sortBy: BookSortBy; sortOrder: BookSortOrder; icon: string }> = [
  { value: 'updateTime_DESC', label: '最近更新', sortBy: 'updateTime', sortOrder: 'DESC', icon: 'fa-regular fa-clock' },
  { value: 'updateTime_ASC', label: '最早更新', sortBy: 'updateTime', sortOrder: 'ASC', icon: 'fa-solid fa-arrow-up-wide-short' },
  { value: 'createTime_DESC', label: '最新创建', sortBy: 'createTime', sortOrder: 'DESC', icon: 'fa-regular fa-calendar-plus' },
  { value: 'wordCount_DESC', label: '字数最多', sortBy: 'wordCount', sortOrder: 'DESC', icon: 'fa-solid fa-arrow-down-wide-short' },
  { value: 'wordCount_ASC', label: '字数最少', sortBy: 'wordCount', sortOrder: 'ASC', icon: 'fa-solid fa-arrow-up-wide-short' },
  { value: 'title_ASC', label: '书名顺序', sortBy: 'title', sortOrder: 'ASC', icon: 'fa-solid fa-arrow-down-a-z' },
]

const localLibrary = getLocalLibraryStorage()
// 开源版恒为本地模式；子弹窗仍按 prop 接收，保持接口不变


const handleCreate = () => {
  currentBook.value = null
  showCreateModal.value = true
}

const handleEdit = (work: Book) => {
  currentBook.value = work
  showCreateModal.value = true
}

const handleExport = (work: Book) => {
  exportBook.value = work
  showExportModal.value = true
}

const handleImport = () => {
  showImportModal.value = true
}

const handleRecycle = () => {
  showRecycleModal.value = true
}

const goBookBreakdown = () => {
  router.push('/bookBreakdown')
}

const fetchGroups = async () => {
  const groups = await localLibrary.listLocalGroups()
  bookGroups.value = groups
  if (activeGroup.value !== 'all' && activeGroup.value !== 'ungrouped') {
    const exists = groups.some(item => String(item.id) === activeGroup.value)
    if (!exists) activeGroup.value = 'all'
  }
}

// 获取书籍列表：一次拉全量，后续搜索/分组/排序均在前端本地完成
// 本地库里既有“本地模式新建的书”，也有“备份时镜像下来的云端书”。
// 二者都是这台机器上的本地作品——未登录/离线时统一显示，退登也看得到自己备份的书。
const fetchBooks = async () => {
  const seq = ++booksFetchSeq
  booksLoading.value = true
  try {
    const books = await localLibrary.listLocalBooks()
    if (seq === booksFetchSeq) {
      allBooks.value = books
      coverLoadFailed.value = {}
    }
  } finally {
    // 只允许最后发起的请求收起加载态，避免并发刷新时被旧请求提前关闭
    if (seq === booksFetchSeq) {
      booksLoading.value = false
      booksLoaded.value = true
    }
  }
}

const refreshBooks = async () => {
  // 分组与书籍列表并行拉取，缩短首屏等待
  await Promise.all([fetchGroups(), fetchBooks()])
}

const handleSaveSuccess = async (book?: Book) => {
  if (currentBook.value || !book?.id) {
    await refreshBooks()
    return
  }
  router.push({ name: 'Writing', params: { bookId: book.id } })
}

// 删除作品
const handleDelete = (work: Book) => {
  inkConfirm(
    `确定要删除《${work.title}》吗？删除后可在回收站找回。`,
    '删除确认',
    {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'work-delete-confirm-btn',
    }
  )
    .then(async () => {
      try {
        await localLibrary.softDeleteLocalBook([work.id])
        ElMessage.success('删除成功')
        refreshBooks()
      } catch (error) {
        console.error('删除失败:', error)
      }
    })
    .catch(() => {
      // cancel
    })
}

// 分组/排序切换均为本地即时过滤，不再发请求
const handleSelectGroup = (groupId: 'all' | 'ungrouped' | string) => {
  activeGroup.value = groupId
}

const handleSortChange = (value: SortValue) => {
  sortValue.value = value
}

const groupModalsRef = ref<InstanceType<typeof BookGroupModals> | null>(null)

const handleManageGroups = () => groupModalsRef.value?.openManage()
const handleCreateGroup = () => groupModalsRef.value?.openCreate()
const handleMoveGroup = (work: Book) => groupModalsRef.value?.openMove(work)

const handleGroupDeleted = (groupId: string) => {
  if (activeGroup.value === groupId) {
    activeGroup.value = 'all'
  }
}

// 初始化：先并行拉列表与分组渲染首屏，认领检测在列表就绪后异步执行
onMounted(() => {
  void refreshBooks()
  if (route.query.create === '1' || route.query.create === 'true') {
    handleCreate()
    const nextQuery = { ...route.query }
    delete nextQuery.create
    router.replace({ path: route.path, query: nextQuery })
  }
})

watch(
  () => route.query.create,
  (create) => {
    if (create === '1' || create === 'true') {
      handleCreate()
      const nextQuery = { ...route.query }
      delete nextQuery.create
      router.replace({ path: route.path, query: nextQuery })
    }
  }
)

// 方法
const getTagType = (type: string): 'primary' | 'success' | 'warning' | 'info' | 'danger' => {
  return CATEGORY_TAG_MAP[type] || 'info'
}

// 本地库存的是 ISO 时间串，直接渲染很难读；统一格式化为分钟级
const formatUpdateTime = (value?: string) => {
  const date = dayjs(value)
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : '--'
}

const formatWordCount = (value?: number | null) => {
  if (value === null) return '—'
  const safe = Math.max(0, Number(value) || 0)
  return `${safe}字`
}


// 打开写作页面
const openWriting = (work: Book) => {
  router.push({
    name: 'Writing',
    params: { bookId: work.id }
  })
}

const handleCoverError = (work: Book) => {
  if (typeof work?.id !== 'number') return
  coverLoadFailed.value[work.id] = true
}

// 按标题长度压缩竖排标题，避免小封面分列时被裁切。
const getDefaultCoverTitleClass = (title?: string) => {
  const len = Array.from(String(title || '')).length
  if (len >= 18) return 'is-compact'
  if (len >= 12) return 'is-long'
  return ''
}

const groupTitleMap = computed(() => {
  const map = new Map<string, string>()
  bookGroups.value.forEach(group => map.set(String(group.id), group.title))
  return map
})

// 关键词匹配：与服务端 bookList 的 keyWord 检索字段保持一致（书名/分类/简介/标签）
const matchKeyword = (book: Book, keyword: string) => {
  if (!keyword) return true
  const tags = Array.isArray(book.tags) ? book.tags.join(' ') : String(book.tags || '')
  return `${book.title || ''} ${book.category || ''} ${book.intro || ''} ${tags}`
    .toLowerCase()
    .includes(keyword)
}

// 计数基准：全量书按关键词过滤（沿用原逻辑——计数跟随搜索词，不受分组筛选影响）
const countBooks = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  return allBooks.value.filter(book => matchKeyword(book, keyword))
})

// 时间字段兼容 ISO / "YYYY-MM-DD HH:mm:ss"，解析失败退回数值比较
const toSortTime = (value: unknown) => {
  if (!value) return 0
  const time = new Date(value as string | number | Date).getTime()
  return Number.isNaN(time) ? Number(value) || 0 : time
}

// 本地排序：与服务端 bookList 白名单排序对齐（updateTime/createTime/wordCount/title + id 兜底）
const compareBooks = (a: Book, b: Book) => {
  const { sortBy, sortOrder } = activeSortOption.value
  const direction = sortOrder === 'ASC' ? 1 : -1
  let diff = 0
  if (sortBy === 'title') {
    diff = String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
  } else if (sortBy === 'wordCount') {
    diff = (wordCounter.value(a) ?? -1) - (wordCounter.value(b) ?? -1)
  } else {
    diff = toSortTime(a[sortBy]) - toSortTime(b[sortBy])
  }
  if (diff === 0) diff = (Number(a.id) || 0) - (Number(b.id) || 0)
  return direction * diff
}

// 展示列表：关键词过滤结果上再做分组过滤 + 本地排序（未分组口径与计数/分区保持一致：
// 无分组或所属分组已不存在的书都算未分组）
const works = computed(() => {
  let books = countBooks.value
  if (activeGroup.value === 'ungrouped') {
    books = books.filter(book => !book.groupId || !groupTitleMap.value.has(String(book.groupId)))
  } else if (activeGroup.value !== 'all') {
    books = books.filter(book => String(book.groupId || '') === activeGroup.value)
  }
  return [...books].sort(compareBooks)
})

const totalCount = computed(() => countBooks.value.length)

const ungroupedCount = computed(() =>
  countBooks.value.filter(book => !book.groupId || !groupTitleMap.value.has(String(book.groupId))).length
)

const groupCountMap = computed(() => {
  const map = new Map<string, number>()
  countBooks.value.forEach(book => {
    if (!book.groupId) return
    const groupId = String(book.groupId)
    if (!groupTitleMap.value.has(groupId)) return
    map.set(groupId, (map.get(groupId) || 0) + 1)
  })
  return map
})

const getGroupCount = (groupId: number | string) => groupCountMap.value.get(String(groupId)) || 0

const activeGroupTitle = computed(() => {
  if (activeGroup.value === 'all') return '全部作品'
  if (activeGroup.value === 'ungrouped') return '未分组'
  return groupTitleMap.value.get(activeGroup.value) || '作品分组'
})

const activeSortOption = computed(() =>
  sortOptions.find(option => option.value === sortValue.value) || sortOptions[0]
)

const activeSortLabel = computed(() => activeSortOption.value.label)

const displaySections = computed(() => {
  if (activeGroup.value !== 'all') {
    return works.value.length
      ? [{ id: activeGroup.value, title: activeGroupTitle.value, books: works.value }]
      : []
  }
  const sections: Array<{ id: string; title: string; books: Book[] }> = []
  const ungroupedBooks = works.value.filter(book => !book.groupId || !groupTitleMap.value.has(String(book.groupId)))
  if (ungroupedBooks.length) {
    sections.push({ id: 'ungrouped', title: '未分组', books: ungroupedBooks })
  }
  bookGroups.value.forEach(group => {
    const books = works.value.filter(book => String(book.groupId || '') === String(group.id))
    if (books.length) {
      sections.push({ id: String(group.id), title: group.title, books })
    }
  })
  return sections
})

const hasActiveFilter = computed(() => Boolean(searchKeyword.value.trim()) || activeGroup.value !== 'all')
</script>

<style scoped lang="scss">
.my-works-page {
  /* 当前页面采用区域滚动，筛选区保持在作品列表外层。 */
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 0;
}

.filter-section {
  flex: 0 0 auto;
  margin-bottom: 24px;

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
    gap: 12px;
    flex-wrap: wrap;

    .toolbar-left {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;

      .search-box {
        width: min(320px, 42vw);
        min-width: 220px;
        height: 36px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 10px;
        border: 1px solid var(--ui-border);
        border-radius: 6px;
        background: var(--ui-glass-bg);
        box-shadow: var(--ui-shadow);
        transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;

        &:focus-within {
          border-color: color-mix(in srgb, var(--ink-accent) 58%, var(--ui-border));
          background: color-mix(in srgb, var(--bg-main) 88%, transparent);
          box-shadow:
            0 0 0 2px color-mix(in srgb, var(--ink-accent) 12%, transparent),
            var(--ui-shadow);
        }

        > i {
          color: var(--ink-sec);
          font-size: 13px;
          flex-shrink: 0;
        }

        input {
          flex: 1;
          min-width: 0;
          height: 100%;
          border: none;
          outline: none;
          box-shadow: none;
          appearance: none;
          background: transparent;
          color: var(--ink-main);
          font-size: 13px;

          &:focus {
            border: none;
            outline: none;
            box-shadow: none;
          }

          &::placeholder {
            color: var(--ink-sec);
            opacity: 0.72;
          }
        }

        .search-clear {
          width: 22px;
          height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--ink-sec);
          cursor: pointer;

          &:hover {
            color: var(--ink-main);
            background: var(--ui-glass-bg-hover);
          }

          i {
            font-size: 12px;
          }
        }
      }

      .recycle-bin-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: transparent;
        border: 1px solid transparent;
        color: var(--ink-sec);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.3s ease;
        padding: 6px 12px;
        border-radius: 6px;

        &:hover {
          color: var(--ink-main);
          background: var(--ui-glass-bg);
          border-color: var(--ui-border);
          box-shadow: var(--ui-shadow);
        }
      }

      .divider {
        width: 1px;
        height: 20px;
        background-color: var(--ui-border);
      }

      .view-mode-group {
        display: flex;
        background: var(--ui-glass-bg);
        border-radius: 6px;
        padding: 4px;
        box-shadow: var(--ui-shadow);
        border: 1px solid var(--ui-border);

        .view-mode-button {
          padding: 8px;
          background: transparent;
          border: none;
          color: var(--ink-sec);
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;

          &:hover {
            color: var(--ink-main);
            background: var(--ui-glass-bg-hover);
          }

          &.active {
            background: var(--ink-main);
            color: var(--bg-main);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
          }

          i {
            font-size: 14px;
          }
        }
      }
    }
  }

  .group-panel {
    min-height: 68px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 18px;
    padding: 14px 18px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 84%, var(--ink-accent));
    border-radius: 8px;
    background: color-mix(in srgb, var(--ui-glass-bg) 90%, var(--bg-main));
    box-shadow: var(--ui-shadow);
  }

  .group-scroll {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    overflow-x: auto;
    padding: 10px 0;
    margin: -10px 0;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .group-tab,
  .group-add,
  .group-manage {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: color-mix(in srgb, var(--bg-main) 86%, transparent);
    color: var(--ink-main);
    cursor: pointer;
    transition: all 0.25s ease;
    font-size: 14px;
    white-space: nowrap;
    flex-shrink: 0;

    i {
      font-size: 13px;
      color: var(--ink-sec);
    }

    span {
      min-width: 0;
      max-width: 118px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    em {
      min-width: 28px;
      padding: 2px 9px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--ink-sec) 12%, transparent);
      color: var(--ink-sec);
      font-style: normal;
      font-size: 12px;
      line-height: 1.25;
      text-align: center;
    }

    /* 计数骨架：数据未就绪时以小胶囊占位，避免闪现 0 */
    em.count-skeleton {
      min-height: 19px;
      padding: 0;
      border-radius: 999px;
    }

    &:hover {
      border-color: color-mix(in srgb, var(--ink-accent) 52%, var(--ui-border));
      background: var(--ui-glass-bg-hover);
    }
  }

  .group-tab.active {
    border-color: color-mix(in srgb, var(--ink-accent) 40%, var(--ui-border));
    background: color-mix(in srgb, var(--ink-accent) 18%, var(--bg-main));
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--ink-accent) 16%, transparent),
      0 8px 18px color-mix(in srgb, var(--ink-accent) 12%, transparent);

    i {
      color: var(--ink-accent);
    }

    em {
      color: var(--ink-main);
      background: color-mix(in srgb, var(--ink-accent) 18%, transparent);
    }
  }

  .group-add {
    border-style: dashed;
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--bg-main) 80%, transparent);

    i {
      color: var(--ink-accent);
    }
  }

  .group-manage {
    border-color: transparent;
    background: transparent;
    color: var(--ink-sec);

    &:hover {
      color: var(--ink-main);
      border-color: var(--ui-border);
    }
  }

}

.works-sections {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-bottom: 0;
  padding-bottom: 40px;
  padding-right: 4px;
}

.works-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;

  h3 {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 17px;
    font-weight: 700;
    color: var(--ink-main);

    &::before {
      content: '';
      width: 4px;
      height: 16px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--ink-accent) 82%, var(--ink-main));
      box-shadow: 0 1px 3px color-mix(in srgb, var(--ink-accent) 26%, transparent);
      flex-shrink: 0;
    }
  }

}

.sort-control {
  display: inline-flex;
  align-items: center;
  color: var(--ink-sec);
  flex-shrink: 0;

  .sort-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: none;
    background: transparent;
    color: var(--ink-sec);
    font-size: 13px;
    cursor: pointer;
    padding: 4px 0;
    transition: color 0.2s ease;

    &:hover {
      color: color-mix(in srgb, var(--ink-main) 64%, var(--ink-sec));
    }

    strong {
      font-weight: 600;
      color: currentColor;
    }

    .caret-icon {
      margin-left: 2px;
      color: currentColor;
      font-size: 11px;
    }
  }
}

.works-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 0;

  &.grid-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
    gap: 24px;

    .work-card {
      height: 100%;
      display: flex;
      flex-direction: row;
      border-radius: 10px;
      overflow: hidden;
      padding: 0;

      .book-cover-wrapper {
        width: clamp(104px, 16vw, 140px);
        flex-shrink: 0;
        align-self: flex-start;
        position: relative;
        overflow: hidden;
        padding: 24px 12px;
        display: flex;
        flex-direction: column;
        justify-content: center;

        .book-spine {
          display: none;
        }

        .book-cover-img {
          width: 100%;
          height: auto;
          aspect-ratio: 2 / 3;
          object-fit: cover;
          transition: transform 0.5s ease;
          border-radius: 6px;
          box-shadow: 2px 4px 8px rgba(0, 0, 0, 0.15);
        }

        .book-cover-placeholder {
          --default-cover-bg-filter: grayscale(1) contrast(0.9) brightness(1.08);
          --default-cover-bg-opacity: 0.72;
          --default-cover-tint: color-mix(in srgb, var(--ink-accent) 24%, var(--bg-main));
          --default-cover-tint-opacity: 0.46;

          width: 100%;
          height: auto;
          aspect-ratio: 2 / 3;
          position: relative;
          overflow: hidden;
          background: color-mix(in srgb, var(--bg-main) 88%, var(--ink-accent));
          border-radius: 8px;
          border: 1px solid color-mix(in srgb, var(--ink-accent) 16%, var(--bg-main));
          box-shadow:
            0 10px 22px color-mix(in srgb, var(--ink-main) 18%, transparent),
            inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 72%, transparent);

          &::after {
            content: '';
            position: absolute;
            inset: 0;
            z-index: 1;
            pointer-events: none;
            background: var(--default-cover-tint);
            opacity: var(--default-cover-tint-opacity);
          }

          .placeholder-bg {
            position: absolute;
            inset: 0;
            z-index: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
            filter: var(--default-cover-bg-filter);
            opacity: var(--default-cover-bg-opacity);
            transition: transform 0.5s ease;
          }

          .placeholder-content {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 14px 7px;
            z-index: 2;
          }

          .placeholder-title {
            display: block;
            width: 100%;
            height: 100%;
            box-sizing: border-box;
            font-size: 17px;
            font-weight: 800;
            color: var(--ink-main);
            text-align: center;
            writing-mode: vertical-rl;
            text-orientation: upright;
            letter-spacing: 3px;
            line-height: 1.32;
            font-family: "Songti SC", "Noto Serif SC", STSong, serif;
            text-shadow:
              0 1px 0 color-mix(in srgb, var(--bg-main) 96%, transparent),
              0 3px 10px color-mix(in srgb, var(--bg-main) 82%, transparent);
            overflow: visible;
          }

          .placeholder-title.is-long {
            font-size: 15px;
            letter-spacing: 1px;
          }

          .placeholder-title.is-compact {
            font-size: 13px;
            letter-spacing: 0;
            line-height: 1.22;
          }
        }
      }

      .work-content {
        flex: 1;
        height: 100%;
        display: flex;
        flex-direction: column;
        padding: 20px;

        .work-footer {
          margin-top: auto;
        }
      }

      &:hover {

        .book-cover-img,
        .placeholder-bg {
          transform: scale(1.05);
        }
      }
    }
  }
}

.work-card {
  padding: 0;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  flex-direction: row;
  min-width: 0;

  .book-cover-wrapper {
    width: clamp(104px, 16vw, 140px);
    min-width: clamp(104px, 16vw, 140px);
    align-self: flex-start;
    position: relative;
    overflow: hidden;
    padding: 24px 8px;
    display: flex;
    flex-direction: column;
    justify-content: center;

    .book-spine {
      display: none;
    }

    .book-cover-img {
      width: 100%;
      height: auto;
      aspect-ratio: 2 / 3;
      object-fit: cover;
      border-radius: 4px;
      box-shadow: 1px 2px 5px rgba(0, 0, 0, 0.15);
    }

    .placeholder-bg {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .book-cover-placeholder {
      --default-cover-bg-filter: grayscale(1) contrast(0.9) brightness(1.08);
      --default-cover-bg-opacity: 0.72;
      --default-cover-tint: color-mix(in srgb, var(--ink-accent) 24%, var(--bg-main));
      --default-cover-tint-opacity: 0.46;

      width: 100%;
      height: auto;
      aspect-ratio: 2 / 3;
      position: relative;
      overflow: hidden;
      background: color-mix(in srgb, var(--bg-main) 88%, var(--ink-accent));
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--ink-accent) 16%, var(--bg-main));
      box-shadow:
        0 10px 22px color-mix(in srgb, var(--ink-main) 16%, transparent),
        inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 72%, transparent);

      &::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        background: var(--default-cover-tint);
        opacity: var(--default-cover-tint-opacity);
      }

      .placeholder-bg {
        position: absolute;
        inset: 0;
        z-index: 0;
        filter: var(--default-cover-bg-filter);
        opacity: var(--default-cover-bg-opacity);
      }

      .placeholder-content {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 14px 7px;
        z-index: 2;
      }

      .placeholder-title {
        display: block;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        font-size: 15px;
        color: var(--ink-main);
        text-align: center;
        font-weight: 800;
        writing-mode: vertical-rl;
        text-orientation: upright;
        letter-spacing: 3px;
        line-height: 1.32;
        text-shadow:
          0 1px 0 color-mix(in srgb, var(--bg-main) 96%, transparent),
          0 3px 10px color-mix(in srgb, var(--bg-main) 82%, transparent);
        font-family: "Songti SC", "Noto Serif SC", STSong, serif;
        overflow: visible;
      }

      .placeholder-title.is-long {
        font-size: 13px;
        letter-spacing: 1px;
      }

      .placeholder-title.is-compact {
        font-size: 11.5px;
        letter-spacing: 0;
        line-height: 1.22;
      }
    }
  }

  .work-content {
    flex: 1;
    padding: 20px;
    display: flex;
    flex-direction: column;
    min-width: 0;

    .work-header {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      margin-bottom: 10px;

      .category-tag {
        background-color: transparent;
        border-color: var(--ink-sec);
        color: var(--ink-sec);
        opacity: 0.8;
        align-self: flex-start;
      }

      .work-title {
        font-size: 18px;
        font-weight: bold;
        color: var(--ink-main);
        letter-spacing: 1px;
        transition: color 0.3s ease;
        line-height: 1.4;
        white-space: normal;
        word-break: break-word;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;

        &:hover {
          color: var(--ink-accent);
        }
      }
    }

    .work-description {
      font-size: 14px;
      color: var(--ink-sec);
      line-height: 1.6;
      margin-bottom: 12px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      opacity: 0.8;
    }

    .work-meta {
      font-size: 12px;
      color: var(--ink-sec);
      font-family: system-ui, sans-serif;
      opacity: 0.7;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;

      .meta-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;

        i {
          font-size: 12px;
        }
      }
    }

    .work-footer {
      padding-top: 12px;
      // border-top: 1px dashed var(--ui-border); // Dashed for ink style
      display: flex;
      justify-content: space-between;
      align-items: center;

      .work-actions {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        flex: 1;
        min-width: 0;
        gap: 12px;

        .action-buttons {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          min-width: 0;

          // .action-button {
          //   display: flex;
          //   align-items: center;
          //   gap: 4px;
          //   padding: 6px 12px;
          //   border: 1px solid var(--ui-border);
          //   border-radius: 4px;
          //   font-size: 12px;
          //   color: var(--ink-sec);
          //   background: transparent;
          //   cursor: pointer;
          //   transition: all 0.3s ease;

          //   &:hover {
          //     color: var(--ink-main);
          //     border-color: var(--ink-main);
          //     background: var(--ui-glass-bg);
          //   }

          //   i {
          //     font-size: 12px;
          //   }
          // }
        }

        .more-button {
          padding: 0 8px;
          background: transparent;
          border: none;
          color: var(--ink-sec);
          cursor: pointer;
          transition: color 0.3s ease;
          font-size: 14px;

          &:hover {
            color: var(--ink-main);
          }
        }

        .work-more-dropdown {
          margin-left: auto;
        }
      }
    }
  }
}

:global(.theme-dark .book-cover-placeholder) {
  --default-cover-bg-filter: grayscale(1) contrast(0.9) brightness(0.62);
  --default-cover-bg-opacity: 0.58;
  --default-cover-tint: color-mix(in srgb, var(--ink-accent) 30%, var(--bg-main));
  --default-cover-tint-opacity: 0.62;

  background: color-mix(in srgb, var(--bg-main) 86%, var(--ink-accent));
  border-color: color-mix(in srgb, var(--ink-accent) 28%, var(--bg-main));
}

:global(.theme-dark .book-cover-placeholder .placeholder-title) {
  text-shadow:
    0 1px 0 color-mix(in srgb, var(--bg-main) 88%, transparent),
    0 3px 12px color-mix(in srgb, var(--bg-main) 90%, transparent);
}



@media (max-width: 900px) {
  :global(body.web-runtime .my-works-page){
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
  }

  :global(body.web-runtime .filter-section){
    margin-bottom: 16px;

    .toolbar {
      margin-top: 12px;
      width: 100%;
      flex-direction: column;
      align-items: stretch;

      .toolbar-left {
        width: 100%;
        flex-direction: column;
        align-items: stretch;

        .ink-btn {
          width: 100%;
          padding-inline: 10px;
        }
      }

      .toolbar-right {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr;
        justify-content: stretch;
        align-items: stretch;
        gap: 10px;

        .search-box {
          width: 100%;
          max-width: 100%;
          min-width: 0;
        }

        .recycle-bin-btn {
          width: 100%;
          justify-content: center;
        }

        .view-mode-group {
          justify-self: start;
        }

        .divider {
          display: none;
        }
      }
    }

    .group-panel {
      gap: 8px;
      align-items: stretch;
      flex-direction: column;
      padding: 12px;
    }

    .group-scroll {
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .group-tab,
    .group-add,
    .group-manage {
      max-width: 180px;
      flex-shrink: 0;
    }

    .group-manage {
      align-self: flex-start;
    }

  }

  :global(body.web-runtime .works-section-header) {
    align-items: flex-start;

    .sort-control {
      margin-left: auto;
    }
  }

  :global(body.web-runtime .works-list){
    gap: 12px;

    &.grid-view {
      grid-template-columns: 1fr;
      gap: 12px;

      .work-card {
        flex-direction: column;
      }

      .work-card .book-cover-wrapper {
        width: 100%;
        min-width: 0;
        padding: 14px 14px 0;
        align-items: center;
      }

      .work-card .book-cover-img,
      .work-card .book-cover-placeholder {
        width: min(180px, 48vw);
      }
    }
  }

  :global(body.web-runtime .work-card){
    flex-direction: column;

    .book-cover-wrapper {
      width: 100%;
      min-width: 0;
      padding: 14px 14px 0;
      align-items: center;
    }

    .book-cover-img,
    .book-cover-placeholder {
      width: min(180px, 48vw);
    }

    .work-content {
      padding: 14px;
    }
  }
}

@media (max-width: 420px) {
  .ink-btn-action {
    padding: 6px 10px;
    font-size: 12px;

    .btn-text {
      display: none;
    }
  }
}

/* 骨架屏：加载期以卡片骨架占位，复用作品卡布局尺寸 */
.skeleton-block {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ink-sec) 12%, transparent);

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--bg-main) 55%, transparent),
      transparent
    );
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }
}

@keyframes skeleton-shimmer {
  to {
    transform: translateX(100%);
  }
}

.skeleton-sections {
  .skeleton-section-title {
    width: 120px;
    height: 20px;
  }

  .skeleton-card {
    pointer-events: none;
    // 与真实卡片(≈389×251)同高，数据到达时布局不跳
    min-height: 251px;
    padding: 18px;

    .skeleton-card-body {
      display: flex;
      gap: 16px;
      height: 100%;
    }

    .skeleton-cover {
      flex: 0 0 132px;
      width: 132px;
      height: 198px;
      border-radius: 8px;
    }

    .skeleton-card-lines {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-top: 4px;
    }

    .skeleton-line {
      height: 14px;
    }

    .skeleton-w60 {
      width: 60%;
      height: 18px;
    }

    .skeleton-w32 {
      width: 32%;
    }

    .skeleton-w92 {
      width: 92%;
    }

    .skeleton-w78 {
      width: 78%;
    }

    .skeleton-w40 {
      width: 40%;
    }

    .skeleton-meta {
      margin-top: auto;
      height: 12px;
    }
  }
}

.empty-state-container {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--ui-glass-bg);
  border-radius: 12px;
  border: 1px dashed var(--ui-border);
  margin-bottom: 0;

  .empty-content {
    text-align: center;
    max-width: 400px;
  }

  .empty-icon-wrapper {
    position: relative;
    width: 80px;
    height: 80px;
    margin: 0 auto 24px;
    display: flex;
    align-items: center;
    justify-content: center;

    i {
      font-size: 48px;
      color: var(--ink-sec);
      opacity: 0.5;
      position: relative;
      z-index: 2;
    }

    .ink-splash {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 120%;
      height: 120%;
      background: radial-gradient(circle, rgba(0, 0, 0, 0.05) 0%, rgba(0, 0, 0, 0) 70%);
      border-radius: 50%;
      z-index: 1;
    }
  }

  .empty-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--ink-main);
    margin-bottom: 12px;
    letter-spacing: 2px;
  }

  .empty-desc {
    font-size: 14px;
    color: var(--ink-sec);
    line-height: 1.8;
    margin-bottom: 32px;
    opacity: 0.8;
  }

  .large-btn {
    padding: 10px 24px;
    font-size: 15px;

    i {
      margin-right: 8px;
    }
  }
}

.animate-fade-in {
  animation: fadeIn 0.5s ease-out forwards;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

<style lang="scss">
.work-dropdown-menu {
  .delete-item {
    color: var(--el-color-danger);

    &:hover {
      color: var(--el-color-danger) !important;
      background-color: var(--el-color-danger-light-9) !important;
    }
  }
}

.sort-dropdown-menu {
  .el-dropdown-menu__item {
    gap: 8px;

    &.active {
      color: var(--ink-main);
      background: color-mix(in srgb, var(--ink-accent) 14%, transparent);
      font-weight: 700;
    }
  }
}

</style>
