<template>
  <div v-if="error || retrying || recoveredErrors?.length" class="pi-run-notice" :class="{ 'is-error': !!error && !retrying }">
    <p v-if="retrying" role="status">服务暂时中断，正在重试。{{ preservation }}</p>
    <p v-else-if="error" role="alert">{{ piErrorMessage(error) }}{{ preservation }}</p>
    <details v-if="details">
      <summary>{{ error || retrying ? '查看错误详情' : '重试后已恢复 · 查看记录' }}</summary>
      <pre>{{ details }}</pre>
    </details>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { piErrorDetails, piErrorMessage } from '@/agent-pi/errors'
const props = defineProps<{ error?: string; retrying?: boolean; recoveredErrors?: string[]; hasCandidates?: boolean; hasSaved?: boolean }>()
const preservation = computed(() => [props.hasSaved ? '已采用的内容仍已保存。' : '', props.hasCandidates ? '已生成的候选仍可预览，正式保存以采用结果为准。' : ''].join(''))
const details = computed(() => piErrorDetails([props.error, ...(props.recoveredErrors || [])].filter(Boolean).join('\n\n')))
</script>
<style scoped>
.pi-run-notice { margin: 12px 0; font-size: calc(13px * var(--ui-font-scale, 1)); line-height: 1.7; min-width: 0; }
.pi-run-notice p { margin: 0 0 6px; }
.pi-run-notice.is-error > p { color: var(--pi-accent); }
.pi-run-notice summary { cursor: pointer; color: var(--pi-muted); }
.pi-run-notice pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border: 1px solid var(--pi-line); border-radius: 6px; font-size: 12px; }
</style>
