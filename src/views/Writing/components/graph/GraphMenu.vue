<template>
  <Teleport to="body">
    <div class="graph-menu" :style="{ left: `${clampedX}px`, top: `${clampedY}px` }" @mousedown.stop @click.stop @contextmenu.prevent.stop>
      <div
        v-for="item in items"
        :key="item.key"
        class="graph-menu-item"
        :class="{ danger: item.danger }"
        @click="emit('select', item.key)"
      >
        <i v-if="item.icon" :class="item.icon"></i>
        {{ item.label }}
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

export interface GraphMenuItem {
  key: string
  label: string
  icon?: string
  danger?: boolean
}

/** 画布右键菜单壳：定位夹在视口内，点外面/Esc 由使用方经 close 事件收起 */
const props = defineProps<{
  x: number
  y: number
  items: GraphMenuItem[]
}>()

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'close'): void
}>()

const MENU_WIDTH = 168
const clampedX = computed(() => Math.min(props.x, window.innerWidth - MENU_WIDTH - 8))
const clampedY = computed(() => Math.min(props.y, window.innerHeight - props.items.length * 36 - 16))

const handleOutside = () => emit('close')
const handleKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  // 延迟一拍再挂，避免打开菜单的同一次点击立刻触发关闭
  window.setTimeout(() => {
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleKey)
  }, 0)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleOutside)
  document.removeEventListener('keydown', handleKey)
})
</script>

<style scoped lang="scss">
.graph-menu {
  position: fixed;
  z-index: 4000;
  min-width: 148px;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-main) 96%, var(--ui-glass-bg));
  box-shadow: 0 12px 30px color-mix(in srgb, var(--ink-main) 18%, transparent);
}

.graph-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  cursor: pointer;

  i {
    width: 14px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  }

  &.danger {
    color: var(--state-danger);

    i { color: var(--state-danger); }
  }
}
</style>
