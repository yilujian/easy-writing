<!-- Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md. -->
<template>
  <aside class="sidebar-container" :class="{ 'mobile-open': mobileOpen }" @click="handleSidebarClick">
    <!-- Logo -->
    <div class="logo-section">
      <div class="logo-icon">
        <img src="/logo.png" alt="易创">
      </div>
      <div class="brand-copy">
        <h1 class="logo-text">易创</h1>
        <span class="brand-line"></span>
        <div class="brand-subtitle">本地增强版 · LOCAL</div>
      </div>
    </div>

    <!-- 导航菜单 -->
    <nav class="nav-section">
      <div class="nav-group">
        <router-link to="/novel" class="nav-item ink-nav-item" :class="{ 'active': currentRoute === '/novel' }">
          <i class="fa-solid fa-house"></i>
          <span>首页</span>
        </router-link>

        <router-link to="/myBooks" class="nav-item ink-nav-item" :class="{ 'active': currentRoute === '/myBooks' }">
          <i class="fa-solid fa-book"></i>
          <span>我的作品</span>
        </router-link>

        <router-link
          v-if="isFeatureEnabled('workflowBook')"
          to="/workflowBook"
          class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute.startsWith('/workflowBook') }"
        >
          <i class="fa-solid fa-diagram-project"></i>
          <span>工作流建书</span>
        </router-link>

        <router-link
v-if="isFeatureEnabled('writeStatistics')" to="/writeStatistics" class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute === '/writeStatistics' }">
          <i class="fa-solid fa-chart-line"></i>
          <span>码字统计</span>
        </router-link>
      </div>

      <div class="menu-divider"></div>

      <div class="nav-group">
        <router-link v-if="isFeatureEnabled('novelRank')" to="/novelRank" class="nav-item ink-nav-item" :class="{ 'active': currentRoute === '/novelRank' }">
          <i class="fa-solid fa-arrow-trend-up"></i>
          <span>榜单风向</span>
        </router-link>

        <router-link
          v-if="isFeatureEnabled('breakdown')"
          to="/bookBreakdown"
          class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute.startsWith('/bookBreakdown') }"
        >
          <i class="fa-solid fa-file-invoice"></i>
          <span>竞品拆书</span>
        </router-link>

        <router-link
          v-if="isFeatureEnabled('inspiration')"
          to="/inspiration"
          class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute === '/inspiration' }"
        >
          <i class="fa-regular fa-lightbulb"></i>
          <span>灵感素材</span>
        </router-link>
      </div>

      <div class="menu-divider"></div>

      <div class="nav-group">
        <router-link
          v-if="isFeatureEnabled('byokModels')"
          to="/aiModels"
          class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute.startsWith('/aiModels') }"
        >
          <i class="fa-solid fa-cube"></i>
          <span>模型管理</span>
        </router-link>

        <router-link
          to="/prompts"
          class="nav-item ink-nav-item"
          :class="{ 'active': currentRoute.startsWith('/prompts') }"
        >
          <i class="fa-regular fa-file-lines"></i>
          <span>提示词</span>
        </router-link>

      </div>
    </nav>

    <div class="footer-links">
      <router-link to="/localCenter" class="nav-item footer-item ink-nav-item" :class="{ 'active': currentRoute === '/localCenter' }">
        <i class="fa-solid fa-hard-drive"></i>
        <span>本地中心</span>
      </router-link>
      <router-link to="/feedback" class="nav-item footer-item ink-nav-item" :class="{ 'active': currentRoute === '/feedback' }">
        <i class="fa-regular fa-message"></i>
        <span>反馈</span>
      </router-link>

      <button
        type="button"
        class="nav-item footer-item ink-nav-item"
        @click="checkForUpdates"
      >
        <i class="fa-solid fa-rotate"></i>
        <span>检查更新</span>
      </button>

      <button
        type="button"
        class="nav-item footer-item ink-nav-item"
        @click="localSettingsVisible = true"
      >
        <i class="fa-solid fa-gear"></i>
        <span>设置</span>
      </button>
    </div>
  </aside>

  <LocalWritingSettingsModal v-model:visible="localSettingsVisible" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import LocalWritingSettingsModal from '@/views/Writing/components/LocalWritingSettingsModal.vue'

import { useAppConfigStore } from '@/stores/app-config'

const props = defineProps<{
  mobileOpen?: boolean
}>()

const emit = defineEmits<{
  (e: 'close-mobile'): void
}>()

const route = useRoute()
const currentRoute = computed(() => route.path)
// 后台「功能与访问策略」关停的功能，导航入口直接隐藏
const appConfigStore = useAppConfigStore()
const { isFeatureEnabled } = appConfigStore
const localSettingsVisible = ref(false)
// 「检查更新」交给 App.vue：桌面端检查官网更新源，网页端打开官网下载页
const checkForUpdates = () => {
  window.dispatchEvent(new CustomEvent('ew-desktop-update-check'))
}

const handleSidebarClick = (event: MouseEvent) => {
  if (!props.mobileOpen) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.nav-item')) {
    emit('close-mobile')
  }
}
</script>

<style scoped lang="scss">
.sidebar-container {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: transparent;
  position: relative;
  z-index: 20;
  padding: 24px 16px;

  /* 右侧渐变边框 */
  &::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: 1px;
    height: 100%;
    background: var(--ink-accent);
    opacity: 0.3;
    pointer-events: none;
    z-index: 10;
  }
}

.logo-section {
  padding: 0 12px;
  margin-bottom: 32px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;

  .logo-icon {
    width: 42px;
    height: 42px;
    flex: 0 0 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    box-shadow: 0 4px 14px rgba(28, 25, 23, 0.18);
    transform: rotate(3deg);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }

  .brand-copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
  }

  .logo-text {
    display: inline-flex;
    align-items: center;
    font-size: 23px;
    font-weight: 700;
    font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif;
    line-height: 1.08;
    letter-spacing: 0;
    white-space: nowrap;
    color: var(--ink-main);
    text-shadow: 0 1px 0 rgba(255, 255, 255, 0.75);
  }

  .brand-line {
    display: block;
    width: 100%;
    height: 1px;
    border-radius: 999px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--ink-accent) 72%, var(--ink-main)) 0%, transparent 100%);
    opacity: 0.72;
  }

  .brand-subtitle {
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.08em;
    color: color-mix(in srgb, var(--ink-main) 58%, transparent);
    white-space: nowrap;
  }
}

.nav-section {
  flex: 1;
  overflow-y: auto;
  padding-right: 8px;

  // &::-webkit-scrollbar {
  //   width: 4px;
  // }

  // &::-webkit-scrollbar-track {
  //   background: transparent;
  // }

  // &::-webkit-scrollbar-thumb {
  //   background: var(--ink-accent);
  //   border-radius: 4px;
  //   opacity: 0.5;
  //   transition: opacity 0.3s;

  //   &:hover {
  //     opacity: 0.8;
  //   }
  // }
}

.nav-group {
  margin-bottom: 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 16px;
  margin-bottom: 4px;
  border-radius: 0 8px 8px 0;
  color: var(--ink-sec);
  font-size: 15px;
  text-decoration: none;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer;
  position: relative;
  width: 100%;
  font-family: inherit;

  i {
    width: 20px;
    text-align: center;
    font-size: 16px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  span {
    margin-left: 12px;
    transition: color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  &:hover:not(.active) {
    color: var(--nav-active-bar-color);
    background: var(--nav-hover-bg);

    i {
      transform: scale(1.1);
      color: var(--nav-active-bar-color);
    }
  }

  &.active {
    color: var(--nav-active-bar-color);
    font-weight: 600;

    i {
      color: var(--nav-active-bar-color);
    }
  }
}

.external-nav-item {
  border: 0;
  background: transparent;
}

.menu-divider {
  margin: 16px 16px;
  border-top: 1px dashed var(--ink-accent);
  opacity: 0.3;
}

.footer-links {
  margin-top: auto;
  padding: 16px 16px 0;
  border-top: 1px solid var(--btn-outline-border);

  .footer-item {
    margin-bottom: 4px;
    border-radius: 8px;
    border: 0;
    background-color: transparent;

    &:last-child {
      margin-bottom: 0;
    }
  }
}

@media (max-width: 1024px) {
  :global(body.web-runtime .sidebar-container){
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 90;
    width: min(280px, calc(100vw - 72px));
    max-width: calc(100vw - 72px);
    height: 100%;
    padding: 22px 14px;
    background: color-mix(in srgb, var(--bg-main) 94%, transparent);
    box-shadow: 18px 0 42px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(16px);
    transform: translateX(-104%);
    transition: transform 0.22s ease;

  }

  :global(body.web-runtime .sidebar-container.mobile-open) {
    transform: translateX(0);
  }

  :global(body.web-runtime .sidebar-container::after){
    opacity: 0.18;
  }
}
</style>
