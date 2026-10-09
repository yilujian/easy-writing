<template>
  <div class="home-page">
    <div class="home-grid">
      <section class="main-column">
        <ShelfCard />
        <CommonToolsCard />
      </section>

      <aside class="side-column">
        <WritingProgressCard />
        <QuickNoteCard />
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import ShelfCard from './components/ShelfCard.vue'
import WritingProgressCard from './components/WritingProgressCard.vue'
import CommonToolsCard from './components/CommonToolsCard.vue'
import QuickNoteCard from './components/QuickNoteCard.vue'
</script>

<style scoped lang="scss">
.home-page {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding-bottom: 18px;
}

.home-grid {
  display: grid;
  // 主列不写硬最小值：宽度不够时由下面的容器查询切成单列，而不是撑破容器被裁掉
  grid-template-columns: minmax(0, 1fr) minmax(300px, 328px);
  gap: 16px;
  // 不能写 height: 100%：网格会把这个固定高度分给各行，
  // 内容超出时可缩的行被压扁重叠，内容不足时行被拉到视口底。高度随内容，最多到视口再滚动。
  max-height: 100%;
  align-content: start;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}

.main-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* 右列：进度卡按内容高，灵感速记吃掉剩余高度，让两列底边对齐 */
.side-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  min-height: 0;
}

.side-column > :deep(.note-card) {
  flex: 1 1 auto;
}

.side-column :deep(.note-card .note-body) {
  flex: 1 1 auto;
}

/*
 * 断点按内容区宽度（MainLayout 的 .content-wrapper 是容器）：
 * 两列 = 书架合理最小 560 + 间距 16 + 右列 300 = 876。数字来自内容本身，与侧栏宽、窗口宽无关。
 * 单列时顺序：书架、进度、灵感速记、常用工具。
 */
@container content (max-width: 875px) {
  .home-grid {
    grid-template-columns: 1fr;
  }

  .main-column {
    display: contents;
  }

  .side-column {
    display: contents;
  }

  .side-column > :deep(.note-card),
  .side-column :deep(.note-card .note-body) {
    flex: 0 0 auto;
  }

  .main-column > :deep(.shelf-card) { order: 1; }
  .side-column > :deep(.progress-card) { order: 2; }
  .side-column > :deep(.note-card) { order: 3; }
  .main-column > :deep(.tools-card) { order: 4; }
}

/* 不支持容器查询的旧 WebKit（macOS 10.15 及更早）：一律单列，宁可保守也不裁内容 */
@supports not (container-type: inline-size) {
  .home-grid {
    grid-template-columns: 1fr;
  }

  .main-column,
  .side-column {
    display: contents;
  }

  .side-column > :deep(.note-card),
  .side-column :deep(.note-card .note-body) {
    flex: 0 0 auto;
  }

  .main-column > :deep(.shelf-card) { order: 1; }
  .side-column > :deep(.progress-card) { order: 2; }
  .side-column > :deep(.note-card) { order: 3; }
  .main-column > :deep(.tools-card) { order: 4; }
}

@media (max-width: 540px) {
  .home-page {
    padding: 0 6px 24px;
  }
}
</style>
