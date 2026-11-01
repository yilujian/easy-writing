<template>
  <button class="ink-btn ink-btn-primary" type="button" :disabled="busy || checking || saved" @click="save">
    {{ busy ? '正在保存…' : saved ? '已保存到拆书工作台' : '保存到拆书工作台' }}
  </button>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { writingCommand } from '@/writing-service/client'
const props = defineProps<{ projectId: string; initialSaved?: boolean; beforeSave?: () => Promise<void> }>()
const emit = defineEmits<{ saved: [] }>()
const saved = ref(false)
const busy = ref(false)
const checking = ref(false)
watch(
  () => [props.projectId, props.initialSaved],
  async () => {
    saved.value = props.initialSaved ?? false
    if (props.initialSaved !== undefined || !props.projectId) return
    const id = props.projectId
    checking.value = true
    try {
      const result = await writingCommand<{ saved: boolean }>('reference_publication', { projectId: id })
      if (id === props.projectId) saved.value = result.saved
    } catch (error) {
      ElMessage.error(String(error))
    } finally {
      if (id === props.projectId) checking.value = false
    }
  },
  { immediate: true }
)
async function save() {
  if (busy.value || saved.value) return
  busy.value = true
  try {
    await props.beforeSave?.()
    await writingCommand('reference_publish', { projectId: props.projectId })
    saved.value = true
    emit('saved')
    ElMessage.success('已保存到拆书工作台')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    busy.value = false
  }
}
</script>
