<template>
  <div class="pi-report-body pi-cover-pane" aria-label="封面预览">
    <p v-if="task.error" class="pi-report-error">{{ task.error }}</p>
    <figure v-if="task.imageUrl" class="pi-cover-figure">
      <img :src="task.imageUrl" :alt="`《${task.bookTitle}》封面候选`" />
      <figcaption>{{ task.summary || task.prompt }}</figcaption>
    </figure>
    <p class="pi-report-meta">模型 {{ task.modelName || task.modelCode }}<template v-if="task.size"> · {{ task.size }}</template></p>
    <div class="pi-cover-actions">
      <button
        v-if="!task.appliedAt"
        type="button"
        class="ink-btn ink-btn-primary"
        :disabled="busy || task.status !== 'completed'"
        @click="apply"
      >
        {{ busy ? '正在写入…' : '采用为封面' }}
      </button>
      <span v-else class="pi-report-meta">已采用为作品封面</span>
      <span class="pi-report-meta">想换一张，在对话里说你想怎么改。</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { usePiWorkspace } from './use-pi-workspace'
import type { CoverTask } from '@/types/cover-task'

const props = defineProps<{ task: CoverTask }>()
const store = usePiWorkspace()
const busy = ref(false)
async function apply() {
  busy.value = true
  try {
    await store.applyCover(props.task.id)
    ElMessage.success('已采用为作品封面')
  } catch (error) {
    ElMessage.error(String(error instanceof Error ? error.message : error))
  } finally {
    busy.value = false
  }
}
</script>
