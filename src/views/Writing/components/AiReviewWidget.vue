<template>
  <!-- 使用 Teleport 挂载到 body，避免 overflow 裁剪 -->
  <Teleport to="body">
    <div v-if="visible" ref="widgetRef" class="ai-review-widget" :style="positionStyle" @mousedown.stop>
      <!-- 原文对比区 -->
      <div class="diff-box">
        <div class="diff-header">修改前 (Original):</div>
        <div class="diff-content">{{ originalText }}</div>
      </div>

      <!-- 操作条 -->
      <div class="review-bar">
        <span class="review-label">
          <i class="fa-solid fa-microchip"></i> AI 已修改
        </span>
        <div class="review-actions">
          <button class="btn-discard" @click="handleDiscard">
            <i class="fa-solid fa-xmark"></i> 废弃
          </button>
          <button class="btn-accept" @click="handleAccept">
            <i class="fa-solid fa-check"></i> 采纳
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Editor } from '@tiptap/vue-3'
import { restoreAiRewrite } from '../editor-utils/ai-rewrite'

const props = defineProps<{
  editor: Editor
  originalText: string // 旧文本
  originalSlice: unknown
  currentRange: { from: number, to: number } // 新文本的范围
}>()

const emit = defineEmits<{
  (e: 'close', action: 'accept' | 'discard'): void
}>()

const visible = ref(true)
const widgetRef = ref<HTMLElement | null>(null)
const top = ref(0)
const left = ref(0)

// 计算位置：寻找 DOM 中的高亮元素
const updatePosition = () => {
  const highlightNode = document.querySelector('.ai-review-highlight')

  if (highlightNode && widgetRef.value) {
    const rect = highlightNode.getBoundingClientRect()

    // 定位到元素正下方，并居中
    top.value = rect.bottom + 10 + window.scrollY
    left.value = Math.max(10, rect.left + window.scrollX)
  }
}

// 监听滚动和缩放，实时更新位置
onMounted(() => {
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('resize', updatePosition)
  nextTick(updatePosition)

  props.editor.on('update', updatePosition)
  props.editor.on('selectionUpdate', updatePosition)
})

onUnmounted(() => {
  window.removeEventListener('scroll', updatePosition, true)
  window.removeEventListener('resize', updatePosition)
  props.editor.off('update', updatePosition)
  props.editor.off('selectionUpdate', updatePosition)
})

// 样式绑定
const positionStyle = computed(() => ({
  top: `${top.value}px`,
  left: `${left.value}px`
}))

// --- 业务逻辑 ---

const handleAccept = () => {
  // 清除高亮
  props.editor.commands.unsetAiReviewRange()
  emit('close', 'accept')
}

const handleDiscard = () => {
  // 废弃：回滚内容
  restoreAiRewrite(props.editor, props.currentRange, props.originalSlice)
  props.editor.commands.unsetAiReviewRange()

  emit('close', 'discard')
}
</script>

<style scoped lang="scss">
.ai-review-widget {
  position: absolute;
  z-index: 99999;
  background-color: var(--ui-glass-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--ink-accent);
  border-radius: 8px;
  box-shadow: var(--ui-shadow);
  width: 380px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fadeIn 0.2s ease-out;

  .diff-box {
    background-color: var(--panel-bg);
    border-bottom: 1px solid var(--ui-border);
    padding: 10px 12px;
    max-height: 150px;
    overflow-y: auto;

    .diff-header {
      font-size: calc(11px * var(--ui-font-scale, 1));
      color: var(--ink-sec);
      margin-bottom: 6px;
      font-weight: bold;
    }

    .diff-content {
      font-size: calc(13px * var(--ui-font-scale, 1));
      color: var(--ink-main);
      line-height: 1.5;
      text-decoration: line-through;
      opacity: 0.7;
      white-space: pre-wrap;
    }
  }

  .review-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background-color: var(--panel-footer-bg);

    .review-label {
      font-size: calc(12px * var(--ui-font-scale, 1));
      font-weight: 600;
      color: var(--ink-accent);
      display: flex;
      align-items: center;
      gap: 4px;

      i {
        font-size: calc(13px * var(--ui-font-scale, 1));
      }
    }

    .review-actions {
      display: flex;
      gap: 8px;

      button {
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid;
        cursor: pointer;
        font-size: calc(12px * var(--ui-font-scale, 1));
        font-family: system-ui, sans-serif;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;

        i {
          font-size: calc(12px * var(--ui-font-scale, 1));
        }
      }

      .btn-discard {
        border-color: var(--state-danger);
        color: var(--state-danger);
        background: var(--btn-outline-bg);

        &:hover {
          background: var(--state-danger-strong-bg);
          color: var(--state-danger-strong-on);
        }
      }

      .btn-accept {
        border-color: var(--state-success);
        color: var(--on-inverse);
        background: var(--state-success);

        &:hover {
          background: var(--state-success-on);
          border-color: var(--state-success-on);
        }
      }
    }
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
