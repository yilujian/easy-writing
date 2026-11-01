<template>
  <div class="model-chip" :class="{ compact }">
    <AiPreferenceSelect
      :model-value="modelValue"
      :options="options"
      :trigger-label="triggerLabel"
      :placeholder="followLabel"
      :disabled="disabled"
      @change="handleChange"
      @open-change="handleOpenChange"
    >
      <template #footer>
        <button type="button" class="model-chip-defaults-link" @click="goDefaults">
          <i class="fa-solid fa-sliders"></i>
          修改默认模型
          <i class="fa-solid fa-arrow-right arrow"></i>
        </button>
      </template>
    </AiPreferenceSelect>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import type { AiModelGroupCode, AiModelOption } from '@/types/ai-model'
import { useAiModelStore } from '@/stores/ai-model'
import AiPreferenceSelect, { type AiPreferenceOption } from '@/components/AiPreferenceSelect.vue'

/**
 * 统一模型选择芯片：全站所有功能内的模型选择入口。
 *
 * 语义约定（与「AI 模型」页的全局默认配合）：
 * - 空值 = 跟随默认：触发器直接顶显当前全局默认模型名（用户未设默认时显示「智能推荐」），
 *   请求不携带 model 参数，由服务端按「用户全局默认 → 平台默认」解析，与显示一致。
 * - 选中具体模型 = 局部覆盖：scope=once 只影响当前面板本次会话（不回写全局默认），
 *   scope=book 用于工作流建书（钉住整本书，由调用方持久化到 run）。
 */
const props = withDefaults(defineProps<{
  groupCode: AiModelGroupCode
  modelValue: string
  scope?: 'once' | 'book'
  disabled?: boolean
  compact?: boolean
}>(), {
  scope: 'once',
  disabled: false,
  compact: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const router = useRouter()
const aiModelStore = useAiModelStore()

const models = computed<AiModelOption[]>(() => aiModelStore.groups[props.groupCode]?.models || [])

// 「AI 模型」页里该分组实际生效的模型：用户选的，或没选时的自动/跟随结果（工作流没选就是空）
const userDefaultCode = computed(() => aiModelStore.effectiveModelCode(props.groupCode))

const defaultModel = computed<AiModelOption | null>(() => {
  const code = userDefaultCode.value
  if (code) {
    const found = models.value.find(item => item.code === code)
    if (found) return found
  }
  return aiModelStore.groups[props.groupCode]?.defaultModel || null
})

const getOptionTitle = (model: AiModelOption) => {
  const name = model.name || model.modelCode || model.code
  return model.ownerType === 'user' ? `${name} · 自定义` : name
}

const defaultName = computed(() => {
  const model = defaultModel.value
  return model ? getOptionTitle(model) : '未设置'
})

const followLabel = computed(() => `跟随默认 · ${defaultName.value}`)

const scopeText = computed(() => (props.scope === 'book' ? '本书锁定' : '本次使用'))

const selectedModel = computed(() =>
  models.value.find(item => item.code === props.modelValue) || null
)

const triggerLabel = computed(() => {
  if (!props.modelValue) return followLabel.value
  const name = selectedModel.value ? getOptionTitle(selectedModel.value) : props.modelValue
  return `${scopeText.value} · ${name}`
})

const formatContext = (tokens: number) => {
  if (!tokens) return ''
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K 上下文` : `${tokens} 上下文`
}

// 本地模型库全是用户自己的 Key（BYOK），没有平台计费概念
const buildModelDescription = (model: AiModelOption) => {
  const parts: string[] = ['BYOK']
  const intro = String(model.description || '').trim()
  if (intro) parts.push(intro)
  else if (model.maxContext) parts.push(formatContext(Number(model.maxContext)))
  return parts.join(' · ')
}

const followDescription = computed(() => {
  if (props.scope === 'book') return '不锁定模型，全书使用你的默认模型（可在「AI 模型」页修改）'
  return '使用「AI 模型」页设置的默认模型'
})

const options = computed<AiPreferenceOption[]>(() => {
  const list: AiPreferenceOption[] = [
    {
      value: '',
      title: followLabel.value,
      description: followDescription.value,
      tag: '默认',
      tagKind: 'recommend',
    },
  ]
  models.value.forEach(model => {
    list.push({
      value: model.code,
      title: getOptionTitle(model),
      description: buildModelDescription(model),
      tag: '自定义',
      tagKind: 'custom',
    })
  })
  return list
})

const handleChange = (value: string) => {
  emit('update:modelValue', value)
}

// 展开时强制刷新模型列表：后台新增/启停模型无需重启客户端
const handleOpenChange = (open: boolean) => {
  if (open) void aiModelStore.loadGroup(props.groupCode, true)
}

const goDefaults = () => {
  void router.push('/aiModels')
}

onMounted(() => {
  void aiModelStore.loadGroup(props.groupCode)
})
</script>

<style scoped lang="scss">
.model-chip {
  min-width: 0;

  &.compact :deep(.ai-pref-trigger) {
    min-height: 28px;
    padding: 3px 8px 3px 10px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    border-radius: 6px;
  }
}
</style>

<style lang="scss">
/* 底部跳转按钮渲染在 body 下的浮层内，不能 scoped */
.model-chip-defaults-link {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-accent);
  cursor: pointer;
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: left;

  .arrow {
    margin-left: auto;
    font-size: calc(10px * var(--ui-font-scale, 1));
  }

  &:hover {
    background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
  }
}
</style>
