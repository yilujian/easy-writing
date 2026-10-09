<template>
  <section class="ai-model-manage-page">
    <AiModelSettingsPane :show-head="false" mode="page" />
  </section>
</template>

<script setup lang="ts">
import AiModelSettingsPane from '@/views/Writing/components/AiModelSettingsPane.vue'
</script>

<style scoped lang="scss">
.ai-model-manage-page {
  position: relative;
  min-height: 100%;
  padding: 22px 28px 36px;
  color: var(--ink-main);
}

:deep(.ai-model-settings.page-mode) {
  gap: 20px;
}

:deep(.ai-model-settings.page-mode .provider-grid) {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}

:deep(.ai-model-settings.page-mode .model-card),
:deep(.ai-model-settings.page-mode .provider-card) {
  border-radius: 8px;
}

:deep(.ai-model-settings.page-mode .model-grid) {
  grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.8fr);
}

@include content-max(620px) {
  .ai-model-manage-page {
    padding: 20px 12px 28px;
  }
}
</style>
