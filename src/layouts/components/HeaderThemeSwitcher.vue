<template>
      <el-dropdown @command="handleThemeChange" trigger="click">
        <button class="icon-button theme-btn glass-element">
          <i :class="themeStore.themeConfig.icon"></i>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
v-for="theme in themeStore.themes" :key="theme.value" :command="theme.value"
              :class="{ 'is-active': themeStore.currentTheme === theme.value }">
              <i :class="theme.icon" style="margin-right: 8px;"></i>
              {{ theme.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
</template>

<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()

const handleThemeChange = (theme: string) => {
  themeStore.switchTheme(theme)
}
</script>

<style scoped lang="scss">
.glass-element {
  background: var(--ui-glass-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--ui-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
  color: var(--ink-sec);
  transition: all 0.3s ease;

  &:hover {
    background: var(--ui-glass-bg-hover);
    border-color: var(--ui-border-hover);
    color: var(--ink-main);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
}

.icon-button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  i {
    font-size: calc(18px * var(--ui-font-scale, 1));
  }
}
</style>
