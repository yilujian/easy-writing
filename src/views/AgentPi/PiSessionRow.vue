<template>
  <button
    class="pi-history-row pi-session-row"
    :class="{ active, selected: active, 'is-dragging': dragging }"
    :draggable="draggable ? 'true' : undefined"
    :disabled="disabled"
    :title="`${session.book?.title || '独立会话'} · ${session.title}`"
    aria-haspopup="menu"
    aria-keyshortcuts="Shift+F10"
    @click="$emit('select', session)"
    @mousedown.right.prevent
    @contextmenu.prevent.stop="$emit('menu', session, $event)"
    @keydown="onKeydown"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <span>{{ session.title }}</span>
    <i v-if="session.pinnedAt" class="fa-solid fa-thumbtack pi-pinned-indicator" aria-label="已置顶"></i>
    <small v-if="session.status" class="pi-session-status">{{ statusLabel }}</small>
  </button>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PiSession } from '@/types/agent-pi'

const props = defineProps<{ session: PiSession; active: boolean; disabled?: boolean; draggable?: boolean }>()
const emit = defineEmits<{
  (event: 'select', session: PiSession): void
  (event: 'menu', session: PiSession, trigger: MouseEvent | KeyboardEvent): void
  (event: 'dragstart', session: PiSession): void
  (event: 'dragend'): void
}>()
const dragging = ref(false)
const statusLabel = computed(
  () =>
    ({ waiting: '待确认', failed: '未完成', connecting: '连接中', running: '进行中' })[
      props.session.status || 'running'
    ]
)
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    event.stopPropagation()
    emit('menu', props.session, event)
  }
}
function onDragStart(event: DragEvent) {
  if (!props.draggable) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/plain', props.session.file || props.session.localKey || '')
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  dragging.value = true
  emit('dragstart', props.session)
}
function onDragEnd() {
  dragging.value = false
  emit('dragend')
}
</script>
