<template>
  <EwModal v-model:visible="visible" title="分卷信息" width="600px" :append-to-body="true" :draggable="true">
    <div class="form-container">
      <!-- 分卷名称 -->
      <div class="form-item">
        <div class="label-row">
          <label class="form-label">分卷名称</label>
          <button class="ai-btn" type="button" :disabled="aiTitleLoading" @click="handleAiName">
            <i :class="aiTitleLoading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"></i>
            {{ aiTitleLoading ? '命名中...' : 'AI 赐名' }}
          </button>
        </div>
        <div class="input-wrapper">
          <input type="text" v-model="form.title" class="input-ink" placeholder="请输入分卷名称（选填）" maxlength="20">
          <span class="char-count">{{ form.title.length }} / 20</span>
        </div>
      </div>

      <!-- 分卷简介 -->
      <div class="form-item">
        <div class="label-row">
          <label class="form-label">分卷简介</label>
          <button class="ai-btn" type="button" :disabled="aiSummaryLoading" @click="handleAiPolish">
            <i :class="aiSummaryLoading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-leaf'"></i>
            {{ aiSummaryLoading ? '润色中...' : 'AI 润色' }}
          </button>
        </div>
        <div class="input-wrapper">
          <textarea
v-model="form.summary" class="input-ink textarea-ink" placeholder="请输入分卷简介，概括本卷核心剧情..." rows="5"
            maxlength="140"></textarea>
          <span class="char-count">{{ form.summary.length }} / 140</span>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="ink-btn ink-btn-outline" @click="visible = false">取消</button>
      <button class="ink-btn ink-btn-primary" @click="handleSave">
        <i class="fa-solid fa-feather-pointed"></i> 保存
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { reactive, watch, ref } from 'vue'
import { promptText } from '@/storage/local-prompts'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
// 开源版：AI 走本地 BYOK 直连（文本默认偏好模型）
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client'
import { buildFreeInstructionMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'

const aiModelStore = useAiModelStore()
const ensureAiModel = async () => {
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) ElMessage.warning(NO_MODEL_MESSAGE)
  return modelCode
}

interface VolumeData {
  title: string
  summary: string
}

const props = defineProps<{
  initialData?: VolumeData
}>()

const visible = defineModel<boolean>('visible')
const emit = defineEmits(['save'])

const form = reactive({
  title: '',
  summary: ''
})
const aiTitleLoading = ref(false)
const aiSummaryLoading = ref(false)

watch(() => visible.value, (newVal) => {
  if (newVal) {
    if (props.initialData) {
      form.title = props.initialData.title
      form.summary = props.initialData.summary
    } else {
      form.title = ''
      form.summary = ''
    }
  }
})

const normalizeAiTitle = (text: string) => {
  // 模型可能返回多条候选，只取第一条作为分卷标题。
  const firstLine = String(text || '')
    .split(/\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
  return firstLine.replace(/^[-*序号\d.、：《》"“”\s]+/, '').replace(/[。.!！]$/, '').trim().slice(0, 20)
}

const handleAiName = async () => {
  if (aiTitleLoading.value) return
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiTitleLoading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'volume_idea',
      sceneLabel: '分卷灵感',
      modelCode,
      messages: buildFreeInstructionMessages({
        instruction: promptText('free-instruction', 'volumeName'),
        selection: form.summary || form.title,
        context: `当前分卷名称：${form.title || '未填写'}；分卷简介：${form.summary || '未填写'}`
      }),
    })
    const title = normalizeAiTitle(data || '')
    if (!title) throw new Error('AI 暂无可用分卷名称')
    form.title = title
    ElMessage.success('AI 已生成分卷名称')
  } catch (error) {
    console.error('AI分卷命名失败:', error)
    ElMessage.error(String(error?.message || '分卷命名失败，请稍后重试'))
  } finally {
    aiTitleLoading.value = false
  }
}

const handleAiPolish = async () => {
  if (!form.summary.trim()) {
    ElMessage.warning('请先输入简介内容')
    return
  }
  if (aiSummaryLoading.value) return
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiSummaryLoading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'volume_idea',
      sceneLabel: '分卷灵感',
      modelCode,
      messages: buildFreeInstructionMessages({
        instruction: promptText('free-instruction', 'volumeSummaryPolish'),
        selection: form.summary,
        context: `分卷名称：${form.title || '未填写'}`
      }),
    })
    const summary = String(data || '').trim().slice(0, 140)
    if (!summary) throw new Error('AI 暂无可用分卷简介')
    form.summary = summary
    ElMessage.success('AI 已完成润色')
  } catch (error) {
    console.error('AI分卷简介润色失败:', error)
    ElMessage.error(String(error?.message || '分卷简介润色失败，请稍后重试'))
  } finally {
    aiSummaryLoading.value = false
  }
}

const handleSave = () => {
  emit('save', { ...form })
  visible.value = false
}
</script>

<style lang="scss" scoped>
.form-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.label-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.form-label {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  color: var(--ink-main);
}

.ai-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  border: none;
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
  background: rgba(180, 83, 9, 0.1);
  color: var(--ink-accent);
  transition: all 0.2s;

  &:hover {
    background: rgba(180, 83, 9, 0.2);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  i {
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.input-wrapper {
  position: relative;

  .char-count {
    position: absolute;
    right: 12px;
    bottom: 12px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    opacity: 0.6;
    pointer-events: none;
  }

  /* Adjust bottom padding for textarea to avoid overlap with char count */
  textarea.textarea-ink {
    padding-bottom: 30px;
    resize: none;
  }
}

.input-ink {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--input-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--ink-main);
  font-size: calc(14px * var(--ui-font-scale, 1));
  outline: none;
  transition: all 0.3s;

  &:focus {
    border-color: var(--input-focus-border);
    background: var(--input-focus-bg);
    box-shadow: 0 0 0 2px rgba(var(--ink-main-rgb), 0.1);
  }

  &::placeholder {
    color: var(--ink-sec);
    opacity: 0.5;
  }
}
</style>
