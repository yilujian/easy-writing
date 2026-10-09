<template>
  <div class="app-container" :class="{ 'full-screen': hideLayout }">
    <!-- 背景层（仅在非全屏时显示） -->
    <div v-if="!hideLayout" class="ink-bg-container">
      <img
        :src="themeStore.currentSkinObj.img"
        class="ink-bg-image"
        alt=""
        @error="(e) => ((e.target as HTMLElement).style.visibility = 'hidden')"
      >
    </div>
    <div v-if="!hideLayout" class="paper-texture"></div>

    <div
      v-if="!hideLayout"
      class="mobile-sidebar-mask"
      :class="{ visible: mobileSidebarOpen }"
      @click="closeMobileSidebar"
    ></div>

    <!-- 左侧边栏 -->
    <Sidebar v-if="!hideLayout" :mobile-open="mobileSidebarOpen" @close-mobile="closeMobileSidebar" />

    <!-- 右侧主要内容区 -->
    <main
      class="main-content"
      :class="{
        'full-width': hideLayout,
        'workflow-book-layout': route.name === 'WorkflowBook',
      }"
    >
      <!-- 顶部Header -->
      <Header v-if="!hideLayout" @toggle-sidebar="toggleMobileSidebar" />

      <!-- 页面内容 -->
      <div class="content-wrapper" :class="{ 'no-padding': hideLayout }">
        <router-view />

        <!-- 页脚 -->
        <!-- <PageFooter /> -->
      </div>

      <!-- 客服悬浮球 -->
      <!-- <div v-if="!hideLayout" class="customer-service">
        <button class="service-button">
          <i class="fa-solid fa-headset"></i>
        </button>
      </div> -->
    </main>

  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import Sidebar from './components/Sidebar.vue'
import Header from './components/Header.vue'

const route = useRoute()
const themeStore = useThemeStore()
const hideLayout = computed(() => route.meta.hideLayout === true)
const mobileSidebarOpen = ref(false)

const closeMobileSidebar = () => {
  mobileSidebarOpen.value = false
}

const toggleMobileSidebar = () => {
  mobileSidebarOpen.value = !mobileSidebarOpen.value
}

watch(() => route.fullPath, closeMobileSidebar)
</script>

<style scoped lang="scss">
.app-container {
  position: relative;
  z-index: 10;
  height: 100%;
  min-height: 0;
  display: flex;

  &.full-screen {
    // 全屏模式（写作页面）
    overflow: hidden;
  }
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
  z-index: 10;
  padding-right: 24px;
  padding-left: 16px;

  &.full-width {
    // 全宽模式（写作页面）
    padding: 0;
  }

  // 建书主流程压缩独占页头，为小分辨率保留稳定的内容编辑高度。
  &.workflow-book-layout :deep(.header-container) {
    padding-top: 12px;
    padding-bottom: 12px;
  }
}

.content-wrapper {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  // 页面布局按"内容区实际宽度"响应（@container content），不再关心窗口宽和侧栏宽
  container-type: inline-size;
  container-name: content;

  // &::-webkit-scrollbar {
  //   width: 4px;
  // }

  // &::-webkit-scrollbar-track {
  //   background: transparent;
  // }

  // &::-webkit-scrollbar-thumb {
  //   background: var(--ui-border);
  //   border-radius: 4px;
  //   opacity: 0.5;
  //   transition: opacity 0.3s;

  //   &:hover {
  //     opacity: 0.8;
  //     background: var(--ink-accent);
  //   }
  // }

  &.no-padding {
    // 无内边距（写作页面）
    overflow: hidden;
  }
}

.mobile-sidebar-mask {
  display: none;
}

:global(body.web-runtime .app-container){
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

:global(body.web-runtime .main-content){
  min-width: 0;
}

@media (max-width: 1024px) {
  :global(body.web-runtime .main-content){
    padding-right: 16px;
    padding-left: 16px;
  }

  .mobile-sidebar-mask {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: block;
    background: rgba(17, 24, 39, 0.32);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;

    &.visible {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

@media (max-width: 768px) {
  :global(body.web-runtime .main-content){
    padding-right: 12px;
    padding-left: 12px;
  }
}

@media (max-width: 640px) {
  :global(body.web-runtime .main-content){
    padding-right: 8px;
    padding-left: 8px;
  }
}

.customer-service {
  position: fixed;
  bottom: 32px;
  right: 32px;
  z-index: 50;

  .service-button {
    width: 56px;
    height: 56px;
    background-color: var(--btn-primary-bg);
    color: var(--btn-primary-color);
    border: 1px solid var(--ui-border);
    border-radius: 50%;
    box-shadow: var(--ui-shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

    i {
      font-size: 20px;
      transition: transform 0.3s;
    }

    &:hover {
      background-color: var(--btn-primary-hover-bg);
      transform: scale(1.1) rotate(5deg);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);

      i {
        transform: scale(1.1);
      }
    }
  }
}
</style>
