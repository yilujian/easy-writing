<template>
  <Transition name="editor-back-top">
    <button
      v-if="visible"
      type="button"
      class="editor-back-to-top"
      aria-label="返回顶部"
      title="返回顶部"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
      @focus="focused = true"
      @blur="focused = false"
      @mousedown.prevent
      @click="scrollToTop"
    >
      <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useEditorScrollNavigation } from '../composables/useEditorScrollNavigation'

const props = defineProps<{
  scrollElement: HTMLElement | null
  contentElement: HTMLElement | null
  active: boolean
  chapterKey: string | number | null | undefined
}>()
const { visible, hovered, focused, scrollToTop } = useEditorScrollNavigation({
  scrollElement: toRef(props, 'scrollElement'),
  contentElement: toRef(props, 'contentElement'),
  active: toRef(props, 'active'),
  chapterKey: toRef(props, 'chapterKey')
})
</script>

<style scoped lang="scss">
.editor-back-to-top {
  position: absolute;
  right: 26px;
  bottom: 52px;
  z-index: 20;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  color: var(--ink-sec);
  background: var(--popover-bg);
  box-shadow: var(--ui-shadow);
  cursor: pointer;
  touch-action: manipulation;
  transition:
    color 140ms ease,
    border-color 140ms ease,
    background-color 140ms ease;
  i {
    font-size: calc(14px * var(--ui-font-scale, 1));
  }
  &:hover,
  &:focus-visible {
    color: var(--ink-main);
    border-color: var(--ui-border-hover);
    background: var(--card-bg-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--ink-main);
    outline-offset: 3px;
  }
  &:active {
    background: var(--overlay-active);
  }
}
.editor-back-top-enter-active,
.editor-back-top-leave-active {
  transition:
    opacity 160ms ease-out,
    transform 160ms ease-out;
}
.editor-back-top-enter-from,
.editor-back-top-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.editor-back-top-leave-active {
  pointer-events: none;
}
@media (pointer: coarse) {
  .editor-back-to-top {
    width: 44px;
    height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .editor-back-to-top,
  .editor-back-top-enter-active,
  .editor-back-top-leave-active {
    transition: none;
  }
  .editor-back-top-enter-from,
  .editor-back-top-leave-to {
    transform: none;
  }
}
</style>
