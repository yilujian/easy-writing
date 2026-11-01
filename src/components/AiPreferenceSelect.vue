<template>
  <!-- 完全受控：不监听 update:visible，避免 el-popover 默认 hover 触发把下拉悬浮打开 -->
  <el-popover
    :visible="open"
    placement="bottom-start"
    :width="popperWidth"
    :show-arrow="false"
    :offset="6"
    popper-class="ai-pref-popper"
  >
    <template #reference>
      <button
        ref="triggerRef"
        type="button"
        class="ai-pref-trigger"
        :class="{ 'is-open': open, 'is-disabled': disabled }"
        :disabled="disabled"
        @click="setOpen(!open)"
      >
        <span class="trigger-main">
          <span class="trigger-title">{{ triggerLabel || selectedOption?.title || placeholder }}</span>
          <span v-if="selectedOption?.tag" class="pref-tag" :class="`tag-${selectedOption.tagKind || 'plain'}`">
            <i v-if="selectedOption.tagKind === 'vip'" class="fa-solid fa-crown"></i>
            {{ selectedOption.tag }}
          </span>
        </span>
        <i v-if="disabled" class="fa-solid fa-spinner fa-spin trigger-caret"></i>
        <i v-else class="fa-solid fa-chevron-down trigger-caret" :class="{ flipped: open }"></i>
      </button>
    </template>

    <div class="ai-pref-options custom-scroll">
      <button
        v-for="option in options"
        :key="option.value || '__default__'"
        type="button"
        class="ai-pref-option"
        :class="{ selected: option.value === modelValue, locked: option.locked }"
        @click="handlePick(option)"
      >
        <span class="option-main">
          <span class="option-head">
            <span class="option-title">{{ option.title }}</span>
            <span v-if="option.tag" class="pref-tag" :class="`tag-${option.tagKind || 'plain'}`">
              <i v-if="option.tagKind === 'vip'" class="fa-solid fa-crown"></i>
              {{ option.tag }}
            </span>
            <span v-if="option.value === modelValue" class="pref-tag tag-current">当前</span>
          </span>
          <span v-if="option.description" class="option-desc">{{ option.description }}</span>
        </span>
        <span v-if="option.locked" class="option-state">
          <span class="lock-chip"><i class="fa-solid fa-lock"></i></span>
          <span class="pref-tag tag-unlock">开通会员</span>
        </span>
        <span v-else-if="option.value === modelValue" class="option-state">
          <i class="fa-solid fa-circle-check option-check"></i>
        </span>
      </button>
    </div>
    <!-- 底部扩展区（如「修改默认模型」跳转），点击后收起下拉 -->
    <div v-if="$slots.footer" class="ai-pref-footer" @click="setOpen(false)">
      <slot name="footer" />
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface AiPreferenceOption {
  value: string
  title: string
  description?: string
  tag?: string
  tagKind?: 'recommend' | 'vip' | 'free' | 'custom' | 'default' | 'plain'
  locked?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: AiPreferenceOption[]
  placeholder?: string
  disabled?: boolean
  /** 触发器自定义显示文案（如「跟随默认 · DeepSeek」），不影响下拉选项展示 */
  triggerLabel?: string
}>(), {
  placeholder: '请选择',
  disabled: false,
  triggerLabel: '',
})

const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'locked', option: AiPreferenceOption): void
  (e: 'open-change', open: boolean): void
}>()

const open = ref(false)
const triggerRef = ref<HTMLElement | null>(null)

const selectedOption = computed(() =>
  props.options.find(option => option.value === props.modelValue) || null
)

// 下拉比触发器略宽，保证两行式选项（标题+描述）有足够排版空间
const popperWidth = computed(() => {
  const triggerWidth = triggerRef.value?.clientWidth || 0
  return Math.max(triggerWidth, 340)
})

const setOpen = (value: boolean) => {
  if (props.disabled && value) return
  if (open.value === value) return
  open.value = value
  emit('open-change', value)
}

const handlePick = (option: AiPreferenceOption) => {
  if (option.locked) {
    setOpen(false)
    emit('locked', option)
    return
  }
  setOpen(false)
  if (option.value !== props.modelValue) {
    emit('change', option.value)
  }
}

const handleOutsidePointer = (event: MouseEvent) => {
  if (!open.value) return
  const target = event.target as Node
  if (triggerRef.value?.contains(target)) return
  if ((target as HTMLElement)?.closest?.('.ai-pref-popper')) return
  setOpen(false)
}

onMounted(() => document.addEventListener('mousedown', handleOutsidePointer, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', handleOutsidePointer, true))
</script>

<style scoped lang="scss">
.ai-pref-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 5px 10px 5px 12px;
  border: 1px solid var(--input-border, var(--ui-border));
  border-radius: 8px;
  background: var(--input-bg, transparent);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  cursor: pointer;
  text-align: left;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;

  &:hover:not(.is-disabled) {
    border-color: var(--ink-accent);
  }

  &.is-open {
    border-color: var(--ink-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink-accent) 15%, transparent);
  }

  &.is-disabled {
    cursor: default;
    opacity: 0.65;
  }
}

.trigger-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.trigger-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-caret {
  flex-shrink: 0;
  font-size: calc(11px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  transition: transform 0.2s ease;

  &.flipped {
    transform: rotate(180deg);
  }
}
</style>

<style lang="scss">
/* 下拉浮层挂在 body 下，样式不可 scoped */
.ai-pref-popper.el-popover.el-popper {
  padding: 6px;
  border-radius: 12px;
  border: 1px solid var(--ui-border-hover, var(--ui-border));
  background: var(--bg-main, #fff);
  box-shadow: 0 18px 42px rgba(30, 20, 10, 0.16);
}

.ai-pref-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.ai-pref-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--ink-main);

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 6%, transparent);
  }

  &.selected {
    background: color-mix(in srgb, var(--ink-accent) 10%, transparent);
  }

  &.locked {
    cursor: pointer;

    .option-title,
    .option-desc {
      opacity: 0.6;
    }
  }
}

.ai-pref-option .option-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ai-pref-option .option-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ai-pref-option .option-title {
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
  color: var(--ink-main);
}

.ai-pref-option .option-desc {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  line-height: 1.5;
}

.ai-pref-option .option-state {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.ai-pref-option .option-check {
  font-size: calc(16px * var(--ui-font-scale, 1));
  color: var(--ink-accent);
}

.ai-pref-footer {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--ink-sec) 16%, transparent);
}

.ai-pref-option .lock-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink-sec) 14%, transparent);
  color: var(--ink-sec);
  font-size: calc(10px * var(--ui-font-scale, 1));
}

/* 标签 chips：触发器与下拉共用 */
.pref-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 99px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.6;
  font-weight: 500;

  i {
    font-size: calc(10px * var(--ui-font-scale, 1));
  }

  &.tag-vip {
    color: var(--ink-accent);
    background: linear-gradient(180deg, #fbe9c6, #f6d89a);
  }

  &.tag-recommend {
    color: #3f6212;
    background: #ecfccb;
  }

  &.tag-free {
    color: #166534;
    background: var(--state-success-surface);
  }

  &.tag-custom {
    color: #1d4ed8;
    background: #dbeafe;
  }

  &.tag-default,
  &.tag-plain {
    color: var(--ink-sec);
    background: color-mix(in srgb, var(--ink-sec) 12%, transparent);
  }

  &.tag-current {
    color: var(--ink-accent);
    background: color-mix(in srgb, var(--ink-accent) 14%, transparent);
  }

  &.tag-unlock {
    color: var(--ink-accent);
    background: #fdf0d5;
    border: 1px solid #ecd9a8;
  }
}

@media (prefers-color-scheme: dark) {
  .ai-pref-popper.el-popover.el-popper {
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
  }
}
</style>
