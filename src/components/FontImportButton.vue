<template>
  <span class="font-import-action">
    <button
      type="button"
      class="font-import-button"
      @click.stop="emit('click')"
    >
      <i class="fa-solid fa-plus" aria-hidden="true"></i>
      导入字体
    </button>
  </span>
</template>

<script setup lang="ts">
const emit = defineEmits<{ click: [] }>()
</script>

<style scoped lang="scss">
.font-import-action {
  display: inline-flex;
  flex-shrink: 0;
}

.font-import-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink-accent);
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
  cursor: pointer;

  &:hover { background: var(--input-bg); }
  &:focus-visible { outline: 2px solid var(--ink-accent); outline-offset: 2px; }
  &:disabled { cursor: wait; }
}
</style>
