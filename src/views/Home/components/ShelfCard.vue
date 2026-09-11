<template>
          <div class="shelf-card fusion-card">
            <div class="section-header">
              <div class="section-title">
                <i class="fa-solid fa-layer-group"></i>
                我的书架
              </div>
              <button class="link-button" type="button" @click="goMyBooks">
                全部作品
                <i class="fa-solid fa-chevron-right"></i>
              </button>
            </div>
            <div v-if="books.length" class="book-list">
              <div v-for="book in books" :key="book.id" class="book-card" @click="openWriting(book)">
                <div class="book-cover">
                  <img
v-if="book.coverUrl && !coverLoadFailed[book.id]" class="book-cover-image" :src="book.coverUrl"
                    alt="封面" @error="handleCoverError(book)" />
                  <div v-else class="book-cover-placeholder">
                    <img :src="themeStore.currentSkinObj.img" class="placeholder-bg" alt="" @error="(e) => ((e.target as HTMLElement).style.visibility = 'hidden')" />
                    <div class="placeholder-content">
                      <span class="placeholder-title" :class="getDefaultCoverTitleClass(book.title)">
                        {{ book.title || '作品' }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="book-meta">
                  <div class="book-title">{{ book.title }}</div>
                  <div class="book-sub">{{ book.category || '未分类' }} · {{ wordCounter.value(book) == null ? '—' : formatWordCount(wordCounter.value(book)) }}</div>
                  <div class="book-intro">{{ book.intro || '暂无简介' }}</div>
                  <div class="book-update">上次编辑：{{ formatUpdateTime(book.updateTime || book.createTime) }}</div>
                </div>
                <button class="edit-btn" type="button" @click.stop="openWriting(book)">
                  <i class="fa-solid fa-pen"></i>
                </button>
              </div>
            </div>
            <!-- 加载中：避免闪现“暂无作品”空状态 -->
            <div v-else-if="booksLoading" class="book-empty book-loading">
              <i class="fa-solid fa-spinner fa-spin"></i>
              <span>正在加载作品...</span>
            </div>
            <div v-else class="book-empty">
              <div class="book-empty-illustration">
                <i class="fa-solid fa-book-open"></i>
              </div>
              <div class="book-empty-title">暂无作品</div>
              <div class="book-empty-desc">还没有创建书籍，去开启你的第一本作品吧</div>
              <button class="book-add-btn book-empty-btn" type="button" @click="goCreateBook">
                <i class="fa-solid fa-plus"></i>
                去创建作品
              </button>
            </div>
            <div v-if="books.length" class="book-add-row">
              <button class="book-add-btn" type="button" @click="goCreateBook">
                <i class="fa-solid fa-plus"></i>
                创建新作品
              </button>
            </div>
          </div>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import type { Book } from '@/types'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { formatUpdateTime, formatWordCount, getSortedBooks } from '../home-format'

const wordCounter = useWordCount()

const router = useRouter()
const themeStore = useThemeStore()
const localLibrary = getLocalLibraryStorage()

const books = ref<Book[]>([])
// 初始为 true：首屏拉取书架期间显示加载提示而不是空状态
const booksLoading = ref(true)
const coverLoadFailed = ref<Record<number, true>>({})

const fetchBooks = async () => {
  booksLoading.value = true
  try {
    const list = await localLibrary.listLocalBooks({ sortBy: 'updateTime', sortOrder: 'DESC' })
    books.value = getSortedBooks(list as Book[]).slice(0, 2)
    coverLoadFailed.value = {}
  } finally {
    booksLoading.value = false
  }
}

const handleCoverError = (book: { id: number }) => {
  if (typeof book?.id !== 'number') return
  coverLoadFailed.value[book.id] = true
}

// 按标题长度压缩竖排标题，避免小封面分列时被裁切。
const getDefaultCoverTitleClass = (title?: string) => {
  const len = Array.from(String(title || '')).length
  if (len >= 18) return 'is-compact'
  if (len >= 12) return 'is-long'
  return ''
}

const goMyBooks = () => {
  router.push({ path: '/myBooks' })
}

const goCreateBook = () => {
  router.push({ path: '/myBooks', query: { create: '1' } })
}

const openWriting = (book: { id: number }) => {
  if (!book?.id) return
  router.push({ name: 'Writing', params: { bookId: book.id } })
}

fetchBooks()
</script>

<style scoped lang="scss">

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ink-main);
}

.shelf-card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.link-button {
  font-size: 12px;
  color: var(--ink-sec);
  background: transparent;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.book-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 9px;
}

.book-card {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) auto;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 14px;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--bg-main) 96%, transparent),
      var(--ui-glass-bg)) padding-box,
    linear-gradient(135deg,
      color-mix(in srgb, var(--ink-accent) 28%, transparent),
      color-mix(in srgb, var(--ink-main) 12%, transparent)) border-box;
  border: 1px solid transparent;
  box-shadow: 0 6px 16px rgba(28, 25, 23, 0.06);
  align-items: stretch;
  min-height: 142px;
  transition: transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;
  cursor: pointer;
}

.book-card:hover {
  transform: translateY(-4px);
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--bg-main) 98%, transparent),
      var(--ui-glass-bg-hover)) padding-box,
    linear-gradient(135deg,
      color-mix(in srgb, var(--ink-accent) 36%, transparent),
      color-mix(in srgb, var(--ink-main) 18%, transparent)) border-box;
  box-shadow: var(--card-shadow-hover, var(--ui-shadow));
}

.book-cover {
  position: relative;
  width: 84px;
  height: 126px;
  aspect-ratio: auto;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-main) 86%, var(--ink-accent));
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  box-shadow:
    0 10px 22px color-mix(in srgb, var(--ink-main) 18%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 62%, transparent);
  overflow: hidden;
}

.book-cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  position: absolute;
  inset: 0;
  z-index: 1;
}

.book-cover-placeholder {
  --default-cover-bg-filter: grayscale(1) contrast(0.9) brightness(1.08);
  --default-cover-bg-opacity: 0.72;
  --default-cover-tint: color-mix(in srgb, var(--ink-accent) 24%, var(--bg-main));
  --default-cover-tint-opacity: 0.46;

  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: color-mix(in srgb, var(--bg-main) 88%, var(--ink-accent));
  border: 1px solid color-mix(in srgb, var(--ink-accent) 16%, var(--bg-main));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 72%, transparent);
}

.book-cover-placeholder::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: var(--default-cover-tint);
  opacity: var(--default-cover-tint-opacity);
}

.book-cover-placeholder .placeholder-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  filter: var(--default-cover-bg-filter);
  opacity: var(--default-cover-bg-opacity);
}

.book-cover-placeholder .placeholder-content {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 9px 5px;
  z-index: 2;
}

.book-cover-placeholder .placeholder-title {
  display: block;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: 800;
  color: var(--ink-main);
  text-align: center;
  writing-mode: vertical-rl;
  text-orientation: upright;
  letter-spacing: 2px;
  line-height: 1.32;
  font-family: "Songti SC", "Noto Serif SC", STSong, serif;
  text-shadow:
    0 1px 0 color-mix(in srgb, var(--bg-main) 96%, transparent),
    0 3px 10px color-mix(in srgb, var(--bg-main) 82%, transparent);
  overflow: visible;
}

.book-cover-placeholder .placeholder-title.is-long {
  font-size: 10.5px;
  letter-spacing: 1px;
}

.book-cover-placeholder .placeholder-title.is-compact {
  font-size: 9.5px;
  letter-spacing: 0;
  line-height: 1.22;
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


.book-meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}

.book-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-sub,
.book-update {
  font-size: 11px;
  color: var(--ink-sec);
}

.book-intro {
  font-size: 11px;
  color: var(--ink-sec);
  opacity: 0.8;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.edit-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  cursor: pointer;
  box-shadow: var(--ui-shadow);
  transition: transform 0.2s ease, background 0.2s ease;
  align-self: end;
  justify-self: end;
  margin-bottom: 12px;
}

.edit-btn:hover {
  transform: translateY(-2px);
  background: var(--ui-glass-bg-hover);
}

.book-add-row {
  display: flex;
  justify-content: flex-end;
}

.book-empty {
  border-radius: 14px;
  border: 1px dashed var(--ui-border);
  background: var(--btn-ghost-bg);
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.book-empty.book-loading {
  flex-direction: row;
  justify-content: center;
  color: var(--ink-sec);
  font-size: 13px;

  i {
    font-size: 16px;
    color: var(--ink-accent);
  }
}

.book-empty-illustration {
  width: 62px;
  height: 62px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg,
      color-mix(in srgb, var(--bg-main) 85%, transparent),
      color-mix(in srgb, var(--ink-accent) 12%, transparent));
  color: var(--ink-accent);
  box-shadow: 0 8px 18px rgba(28, 25, 23, 0.08);
}

.book-empty-title {
  font-weight: 600;
  color: var(--ink-main);
}

.book-empty-desc {
  font-size: 12px;
  color: var(--ink-sec);
  opacity: 0.8;
}

.book-empty-btn {
  margin-top: 4px;
  height: 34px;
  padding: 0 16px;
  border-radius: 10px;
  border-style: solid;
  border-width: 1px;
}

.book-add-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px dashed var(--btn-ghost-border);
  background: var(--btn-ghost-bg);
  color: var(--ink-main);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.book-add-btn:hover {
  background: var(--btn-ghost-hover-bg);
  border-color: var(--btn-ghost-hover-border);
}

@media (max-width: 720px) {
  .book-list {
    grid-template-columns: 1fr;
  }

  .book-card {
    grid-template-columns: 84px minmax(0, 1fr);
  }

  .edit-btn {
    justify-self: end;
  }
}

@media (max-width: 540px) {
  .book-card {
    grid-template-columns: 1fr;
    justify-items: start;
  }

  .book-cover {
    width: 92px;
    height: 138px;
  }

  .edit-btn {
    align-self: flex-start;
  }
}
</style>
