<template>
  <Teleport to="body" :disabled="!appendToBody">
    <transition name="fade" @after-enter="handleOpened" @after-leave="restoreFocus">
      <div
v-if="visible" class="ew-modal-overlay" :class="{ 'is-click-through': clickThrough || !modal }"
        @click.self="handleOverlayClick">
        <div
          ref="modalRef"
          class="ew-modal-container animate-zoom-in"
          :class="[customClass, { 'is-resizable': resizable, 'is-resizing': isResizing }]"
          :style="modalStyle"
          :role="modal ? 'dialog' : undefined"
          :aria-modal="modal ? true : undefined"
          :aria-label="title"
          :data-managed-focus="manageFocus && modal ? '' : undefined"
          tabindex="-1"
          @keydown="handleKeydown"
        >
          <!-- Header -->
          <div class="ew-modal-header" :style="headerStyle" @mousedown="onHeaderMouseDown">
            <div class="ew-modal-header-main">
              <slot name="header">
                <h2 class="ew-modal-title">
                  <span class="ink-bar"></span>
                  {{ title }}
                </h2>
              </slot>
            </div>
            <button v-if="showClose" class="ew-close-btn" type="button" aria-label="关闭弹窗" @click="close">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>

          <!-- Body -->
          <div class="ew-modal-body custom-scroll" :style="bodyStyle">
            <slot></slot>
          </div>

          <!-- Footer -->
          <div class="ew-modal-footer" v-if="$slots.footer">
            <slot name="footer"></slot>
          </div>

          <button
            v-if="resizable"
            class="ew-modal-resize-handle"
            type="button"
            title="调整尺寸"
            @mousedown.stop.prevent="startResize"
          >
            <i class="fa-solid fa-grip-lines"></i>
          </button>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  width: { type: String, default: '780px' },
  height: { type: String, default: '' },
  maxHeight: { type: String, default: '' },
  top: { type: String, default: '' }, // If set, overrides flex centering vertical
  left: { type: String, default: '' }, // If set, positions from left
  modal: { type: Boolean, default: true }, // Whether to show mask
  closeOnClickModal: { type: Boolean, default: true },
  appendToBody: { type: Boolean, default: true },
  showClose: { type: Boolean, default: true },
  draggable: { type: Boolean, default: false },
  resizable: { type: Boolean, default: false },
  resizeMinWidth: { type: Number, default: 360 },
  resizeMinHeight: { type: Number, default: 240 },
  clickThrough: { type: Boolean, default: false }, // If true, mask is transparent and clicks pass through (pointer-events: none on overlay)
  customClass: { type: String, default: '' },
  initialPosition: { type: Object as () => { x: number; y: number } | undefined, default: undefined }, // Initial position { x, y }
  headerStyle: { type: Object as () => Record<string, string>, default: () => ({}) }, // Custom header style
  bodyStyle: { type: Object as () => Record<string, string>, default: () => ({}) }, // Custom body style
  /** 按需启用键盘焦点管理，存量可拖拽/非模态窗口保持原有行为。 */
  manageFocus: { type: Boolean, default: false }
});

const emit = defineEmits(['update:visible', 'close', 'open', 'opened']);

const modalRef = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;

const focusableElements = () => Array.from(modalRef.value?.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
) || []).filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');

const handleOpened = () => {
  if (props.manageFocus && props.modal && !modalRef.value?.contains(document.activeElement)) {
    modalRef.value?.focus({ preventScroll: true });
  }
  emit('opened');
};

const restoreFocus = () => {
  const anotherModal = document.querySelector('.ew-modal-container[data-managed-focus]');
  if (props.manageFocus && !anotherModal && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
};

const handleKeydown = (event: KeyboardEvent) => {
  if (!props.manageFocus || !props.modal) return;
  // 内部选择器先处理自己的 Esc，不连带关闭整个弹窗。
  if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[aria-expanded="true"]'))) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === 'Tab') {
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first) { event.preventDefault(); modalRef.value?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.value)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }
};

// Dragging Logic
const isDragging = ref(false);
const dragStart = { x: 0, y: 0 };
const transform = ref({ x: 0, y: 0 });
const isResizing = ref(false);
const resizeSize = ref<{ width: number; height: number } | null>(null);
const resizeStart = { x: 0, y: 0, width: 0, height: 0, transformX: 0, transformY: 0 };

watch(() => props.visible, (val) => {
  if (val) {
    if (props.manageFocus) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    emit('open');
    // Reset drag position on open
    transform.value = { x: 0, y: 0 };
    resizeSize.value = null;
  }
});

const onHeaderMouseDown = (e: MouseEvent) => {
  if (!props.draggable || !modalRef.value) return;

  isDragging.value = true;
  dragStart.x = e.clientX;
  dragStart.y = e.clientY;

  // Calculate initial offset if we want to continue dragging from where we left off,
  // but here we are using transform translate, so we just add to the existing transform.

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};

const onMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;

  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;

  transform.value.x += dx;
  transform.value.y += dy;

  dragStart.x = e.clientX;
  dragStart.y = e.clientY;
};

const onMouseUp = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
};

const getResizeBounds = () => {
  const maxWidth = Math.max(320, window.innerWidth - 32);
  const maxHeight = Math.max(240, window.innerHeight - 32);
  return {
    minWidth: Math.min(props.resizeMinWidth, maxWidth),
    minHeight: Math.min(props.resizeMinHeight, maxHeight),
    maxWidth,
    maxHeight
  };
};

const startResize = (e: MouseEvent) => {
  if (!props.resizable || !modalRef.value) return;
  const rect = modalRef.value.getBoundingClientRect();
  isResizing.value = true;
  resizeStart.x = e.clientX;
  resizeStart.y = e.clientY;
  resizeStart.width = rect.width;
  resizeStart.height = rect.height;
  resizeStart.transformX = transform.value.x;
  resizeStart.transformY = transform.value.y;
  document.addEventListener('mousemove', handleResizeMove);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'nwse-resize';
  document.body.style.userSelect = 'none';
};

const handleResizeMove = (e: MouseEvent) => {
  if (!isResizing.value) return;
  const { minWidth, minHeight, maxWidth, maxHeight } = getResizeBounds();
  const width = Math.max(minWidth, Math.min(maxWidth, resizeStart.width + e.clientX - resizeStart.x));
  const height = Math.max(minHeight, Math.min(maxHeight, resizeStart.height + e.clientY - resizeStart.y));
  resizeSize.value = { width, height };

  // 居中弹窗调整尺寸时补偿 transform，避免拖右下角时左上角跟着漂移。
  if (!props.initialPosition) {
    transform.value = {
      x: resizeStart.transformX + (width - resizeStart.width) / 2,
      y: resizeStart.transformY + (height - resizeStart.height) / 2
    };
  }
};

const stopResize = () => {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
};

const modalStyle = computed(() => {
  const style: Record<string, string> = {
    width: resizeSize.value ? `${resizeSize.value.width}px` : props.width
  };

  if (resizeSize.value) {
    style.height = `${resizeSize.value.height}px`;
  } else if (props.height) {
    style.height = props.height;
  }

  if (props.resizable) {
    style.minWidth = `min(${props.resizeMinWidth}px, calc(100vw - 32px))`;
    style.minHeight = `min(${props.resizeMinHeight}px, calc(100vh - 32px))`;
    style.maxWidth = 'calc(100vw - 32px)';
    style.maxHeight = 'calc(100vh - 32px)';
  }

  if (props.maxHeight) {
    style.maxHeight = props.maxHeight;
  }

  // 如果有初始位置，使用固定定位
  if (props.initialPosition) {
    style.position = 'fixed';
    style.top = `${props.initialPosition.y}px`;
    style.left = `${props.initialPosition.x}px`;
    style.margin = '0';
  } else {
    // 否则使用默认的居中布局
    if (props.top) {
      style.marginTop = props.top;
    }
    if (props.left) {
      style.marginLeft = props.left;
    }
  }

  if (transform.value.x !== 0 || transform.value.y !== 0) {
    style.transform = `translate(${transform.value.x}px, ${transform.value.y}px)`;
  }

  return style;
});

const close = () => {
  emit('update:visible', false);
  emit('close');
};

const handleOverlayClick = () => {
  if (props.closeOnClickModal && !props.clickThrough) {
    close();
  }
};

onBeforeUnmount(() => {
  restoreFocus();
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', stopResize);
});
</script>

<style scoped lang="scss">
/* --- Transitions --- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.animate-zoom-in {
  animation: zoomIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes zoomIn {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* --- Layout & Glassmorphism --- */
.ew-modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(3px);
  z-index: 2000; /* High z-index like Element Plus */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;

  &.is-click-through {
    background-color: transparent;
    backdrop-filter: none;
    pointer-events: none;

    .ew-modal-container {
      pointer-events: auto;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); /* Enhance shadow for visibility without backdrop */
    }
  }
}

.ew-modal-container {
  max-width: calc(100vw - 24px);
  max-height: 95vh;
  display: flex;
  flex-direction: column;
  background: var(--ui-glass-bg);
  backdrop-filter: blur(20px);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  box-shadow: var(--ui-shadow);
  transition: width 0.3s ease, height 0.3s ease, box-shadow 0.3s ease; /* Exclude transform from transition to avoid lag during drag */
  position: relative;

  &.is-resizing {
    transition: box-shadow 0.3s ease;
  }
}

.ew-modal-resize-handle {
  position: absolute;
  right: -10px;
  bottom: -10px;
  z-index: 3;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 50%;
  background: var(--ui-glass-bg);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  color: var(--ink-light);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: nwse-resize;
  transform: rotate(-45deg);
  transition: color 0.2s ease, background 0.2s ease;

  &:hover {
    color: var(--ink-main);
    background: var(--panel-bg);
  }
}

/* --- Header --- */
.ew-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  user-select: none;
  cursor: default;

  .ew-modal-header-main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .ew-modal-title {
    font-size: calc(18px * var(--ui-font-scale, 1));
    font-weight: 700;
    color: var(--ink-main);
    letter-spacing: 0.1em;
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: "Noto Serif SC", serif;
    margin: 0;

    .ink-bar {
      width: 4px;
      height: 16px;
      background-color: var(--ink-accent);
      border-radius: 99px;
    }
  }

  .ew-close-btn {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-sec);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

    &:hover {
      color: var(--ink-main);
      background-color: var(--btn-ghost-hover-bg);
      transform: rotate(90deg) scale(1.1);
    }
  }
}

/* --- Body --- */
.ew-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

/* --- Footer --- */
.ew-modal-footer {
  padding: 12px 14px;
  border-top: 1px solid var(--ui-border);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  background: var(--panel-footer-bg);
  border-radius: 0 0 8px 8px;
}

/* Theme Adaptation (Ensure global vars are used) */
</style>
