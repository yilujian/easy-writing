<template>
  <SettingsCenterModal v-if="settingsOpen" v-model:visible="settingsOpen" initial-section="pet" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SettingsCenterModal from '@/views/SettingsCenter/SettingsCenterModal.vue'
import { installPetCoordinator } from './coordinator'

const settingsOpen = ref(false),
  router = useRouter()
let dispose: (() => void) | undefined,
  disposed = false
onMounted(async () => {
  try {
    dispose = await installPetCoordinator(router, () => {
      settingsOpen.value = true
    })
    if (disposed) dispose()
  } catch (error) {
    console.warn('桌宠启动失败，可在设置中重试', error)
  }
})
onBeforeUnmount(() => {
  disposed = true
  dispose?.()
})
</script>
