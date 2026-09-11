<template>
  <EwModal
v-model:visible="visibleProxy" title="回收站" width="800px" :close-on-click-modal="true" @close="close"
    @open="fetchRecycleBooks">
    <!-- 内容区域 -->
    <div class="recycle-list-container">
      <!-- 列表内容 -->
      <div v-if="loading" class="loading-state">
        <i class="fa-solid fa-spinner fa-spin"></i> 加载中...
      </div>

      <div v-else-if="recycleBooks.length > 0" class="recycle-list custom-scroll">
        <div v-for="book in recycleBooks" :key="book.id" class="recycle-item animate-fade-in">
          <div class="book-info">
            <div class="book-cover">
              <img :src="book.coverUrl || defaultCover" alt="封面" class="cover-img">
            </div>
            <div class="book-meta">
              <h4 class="book-title">{{ book.title }}</h4>
              <div class="meta-row">
                <el-tag size="small" type="info">{{ book.category || '未分类' }}</el-tag>
                <span class="word-count">{{ wordCounter.format(wordCounter.value(book)) }} 字</span>
              </div>
              <p class="delete-time">
                <i class="fa-regular fa-clock"></i>
                <span>删除时间：</span>
                <span class="time-val">{{ book.updateTime }}</span>
              </p>
            </div>
          </div>

          <div class="action-buttons">
            <button class="ink-btn ink-btn-sm ink-btn-primary" @click="handleRestore(book)">
              <i class="fa-solid fa-trash-arrow-up"></i> 恢复
            </button>
            <button class="ink-btn ink-btn-sm ink-btn-danger" :disabled="purgingId === book.id" @click="handlePurge(book)">
              <i class="fa-solid fa-eraser"></i> {{ purgingId === book.id ? '删除中...' : '彻底删除' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <div class="empty-icon-wrapper">
          <i class="fa-regular fa-trash-can"></i>
          <div class="ink-splash"></div>
        </div>
        <p class="empty-text">回收站空空如也</p>
        <p class="empty-subtext">落红不是无情物，化作春泥更护花</p>
      </div>

      <!-- 分页 -->
      <div v-if="total > 0" class="pagination-wrapper">
        <el-pagination
v-model:current-page="currentPage" v-model:page-size="pageSize" :total="total"
          layout="prev, pager, next" background small @size-change="fetchRecycleBooks"
          @current-change="fetchRecycleBooks" />
      </div>
    </div>
  </EwModal>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { ref, computed } from 'vue';
import EwModal from '@/components/EwModal/index.vue';
import { Book } from '@/types';
import { ElMessage, ElMessageBox } from 'element-plus';
import defaultCover from '@/assets/images/bg/bg1.jpg'; // 使用一个默认封面或占位图
import { getLocalLibraryStorage, purgeLocalBookCompletely } from '@/storage/local-library';

const wordCounter = useWordCount()

const props = defineProps({
  visible: { type: Boolean, default: false }
});

const emit = defineEmits(['update:visible', 'close', 'restore-success']);

const visibleProxy = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
});

// Data
const recycleBooks = ref<Book[]>([]);
const loading = ref(false);
const currentPage = ref(1);
const pageSize = ref(10);
const total = ref(0);
const localLibrary = getLocalLibraryStorage();

// Methods
const fetchRecycleBooks = async () => {
  loading.value = true;
  try {
    const list = await localLibrary.listLocalBooks({ deletedOnly: true, sortBy: 'updateTime', sortOrder: 'DESC' });
    recycleBooks.value = list;
    total.value = list.length;
  } catch (error) {
    console.error('获取回收站列表失败:', error);
  } finally {
    loading.value = false;
  }
};

const close = () => {
  emit('update:visible', false);
  emit('close');
};

const handleRestore = async (book: Book) => {
  try {
    await localLibrary.restoreLocalBook([book.id]);
    ElMessage.success(`《${book.title}》已恢复`);
    fetchRecycleBooks(); // 刷新回收站列表
    emit('restore-success'); // 通知父组件刷新主列表
  } catch (error) {
    console.error('恢复失败:', error);
  }
};

const purgingId = ref<number | null>(null);
const handlePurge = async (book: Book) => {
  try {
    await ElMessageBox.confirm(
      `《${book.title}》将连同全部章节正文、历史版本、参考数据和 AI 问答记录一起删除，无法恢复。磁盘上的备份文件不受影响。`,
      '彻底删除',
      { confirmButtonText: '彻底删除', cancelButtonText: '再想想', type: 'warning' }
    );
  } catch {
    return;
  }
  purgingId.value = book.id;
  try {
    await purgeLocalBookCompletely(book.id);
    ElMessage.success(`《${book.title}》已彻底删除`);
    fetchRecycleBooks();
    emit('restore-success'); // 复用刷新信号：主列表统计随之更新
  } catch (error) {
    ElMessage.error(String(error?.message || '彻底删除失败，请稍后重试'));
  } finally {
    purgingId.value = null;
  }
};

</script>

<style scoped lang="scss">
.recycle-list-container {
  min-height: 300px;
  display: flex;
  flex-direction: column;
}

.loading-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-sec);
  gap: 8px;
}

.recycle-list {
  flex: 1;
  max-height: 500px;
  overflow-y: auto;
  padding: 0 4px;
}

.recycle-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--btn-ghost-border);
  transition: background-color 0.2s;

  &:hover {
    background-color: var(--bg-hover);
  }

  &:last-child {
    border-bottom: none;
  }
}

.book-info {
  display: flex;
  gap: 12px;
  align-items: center;
}

.book-cover {
  width: 40px;
  height: 56px;
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--progress-track-bg);

  .cover-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.book-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-main);
  margin: 0;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.word-count {
  color: var(--ink-sec);
  font-size: 12px;
}

.delete-time {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: var(--ink-sec);
  margin: 0;

  i {
    margin-right: 4px;
  }

  .time-val {
    margin-left: 2px;
    padding-top: 2px;
    /* Micro-adjustment for vertical centering */
  }
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.ink-btn-danger {
  background: var(--el-color-danger);
  color: white;
  border: 1px solid transparent;
  box-shadow: 0 2px 4px color-mix(in srgb, var(--state-danger) 20%, transparent);

  &:hover {
    background: var(--el-color-danger-dark-2);
    box-shadow: 0 4px 8px color-mix(in srgb, var(--state-danger) 30%, transparent);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--ink-sec);
  padding: 60px 0;

  .empty-icon-wrapper {
    position: relative;
    width: 80px;
    height: 80px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    justify-content: center;

    i {
      font-size: 42px;
      color: var(--ink-sec);
      opacity: 0.6;
      position: relative;
      z-index: 2;
    }

    .ink-splash {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 140%;
      height: 140%;
      background: radial-gradient(circle, rgba(0, 0, 0, 0.05) 0%, transparent 70%);
      border-radius: 50%;
      z-index: 1;
      filter: blur(4px);
    }
  }

  .empty-text {
    font-size: 16px;
    font-weight: 600;
    color: var(--ink-main);
    margin-bottom: 8px;
  }

  .empty-subtext {
    font-size: 13px;
    color: var(--ink-sec);
    opacity: 0.8;
    font-style: italic;
  }
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
