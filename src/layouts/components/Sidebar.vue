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
        <div class="brand-subtitle">AI创作平台</div>
      </div>
    </div>

    <!-- 空分组不渲染分隔线，所有可选入口隐藏后仍可从设置恢复。 -->
    <nav class="nav-section">
      <template
 v-for="(group, index) in visibleGroups" :key="group.title">
        <div v-if="index" class="menu-divider"></div>
        <div class="nav-group">
          <router-link
v-for="item in group.items" :key="item.id" :to="item.path!" class="nav-item ink-nav-item"
            :class="{ active: currentRoute === item.path || currentRoute.startsWith(`${item.path}/`) }">
            <i :class="item.icon"></i><span>{{ item.label }}</span>
          </router-link>
        </div>
      </template>
    </nav>
    <div class="footer-links">
      <template v-for="item in footerItems" :key="item.id">
        <router-link v-if="item.path" :to="item.path" class="nav-item footer-item ink-nav-item" :class="{ active: currentRoute === item.path }">
          <i :class="item.icon"></i><span>{{ item.label }}</span>
        </router-link>
        <button v-else type="button" class="nav-item footer-item ink-nav-item" @click="checkForUpdates">
          <i :class="item.icon"></i><span>{{ item.label }}</span>
        </button>
      </template>
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
import { useUiPreferencesStore } from '@/stores/ui-preferences'
import { navigationGroups } from '@/config/navigation'

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
const preferences = useUiPreferencesStore()
const filteredGroups = computed(() => navigationGroups.map(group => ({
  ...group, items: group.items.filter(item => preferences.isMenuVisible(item.id) && (!item.featureKey || appConfigStore.isFeatureEnabled(item.featureKey)))
})))
const visibleGroups = computed(() => filteredGroups.value.slice(0, -1).filter(group => group.items.length))
const footerItems = computed(() => filteredGroups.value[filteredGroups.value.length - 1].items)
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
