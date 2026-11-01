<script setup lang="ts">
import { reactive, watch, computed, ref } from 'vue'
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

interface Volume {
  id: number | string
  title: string
}

interface ChapterData {
  id?: number
  volumeId: string | number
  title: string
  summary: string
  wordCount?: number
}

const props = defineProps<{
  initialData?: ChapterData
  volumes: Volume[]
  selectedVolumeId?: string | number
}>()

const visible = defineModel<boolean>('visible')
const emit = defineEmits(['save'])

const form = reactive({
  volumeId: '' as string | number,
  title: '',
  summary: '',
  wordCount: 2500
})

const isEdit = computed(() => !!props.initialData)
const aiTitleLoading = ref(false)
const aiOutlineLoading = ref(false)
const activeVolumeTitle = computed(() => props.volumes.find(vol => String(vol.id) === String(form.volumeId))?.title || '')

watch(() => visible.value, (newVal) => {
  if (newVal) {
    if (props.initialData) {
      form.volumeId = props.initialData.volumeId
      form.title = props.initialData.title
      form.summary = props.initialData.summary
      form.wordCount = props.initialData.wordCount || 2500
    } else {
      form.volumeId = props.selectedVolumeId || (props.volumes.length > 0 ? props.volumes[0].id : '')
      form.title = ''
      form.summary = ''
      form.wordCount = 2500
    }
  }
})

const normalizeAiText = (text: string, limit: number) => {
  // 模型可能返回编号或解释，只取第一条可用结果写回表单。
  const firstLine = String(text || '')
    .split(/\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
  return firstLine.replace(/^[-*序号\d.、：《》"“”\s]+/, '').replace(/[。.!！]$/, '').trim().slice(0, limit)
}

const handleAiName = async () => {
  if (aiTitleLoading.value) return
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiTitleLoading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'chapter_idea',
      sceneLabel: '章节灵感',
      modelCode,
      messages: buildFreeInstructionMessages({
        instruction: promptText('free-instruction', 'chapterName'),
        selection: form.summary || form.title || activeVolumeTitle.value,
        context: `所属分卷：${activeVolumeTitle.value || '未指定'}；当前章节名：${form.title || '未填写'}；剧情梗概：${form.summary || '未填写'}`
      }),
    })
    const title = normalizeAiText(data || '', 50)
    if (!title) throw new Error('AI 暂无可用章节名称')
    form.title = title
    ElMessage.success('AI 已生成章节名称')
  } catch (error) {
    console.error('AI章节命名失败:', error)
    ElMessage.error(String(error?.message || '章节命名失败，请稍后重试'))
  } finally {
    aiTitleLoading.value = false
  }
}

const handleAiOutline = async () => {
  const source = form.summary.trim() || form.title.trim()
  if (!source) {
    ElMessage.warning('请先输入章节名称或剧情方向')
    return
  }
  if (aiOutlineLoading.value) return
  const modelCode = await ensureAiModel()
  if (!modelCode) return
  aiOutlineLoading.value = true
  try {
    const data = await requestLocalChatCompletion({
      scene: 'chapter_idea',
      sceneLabel: '章节灵感',
      modelCode,
      messages: buildFreeInstructionMessages({
        instruction: promptText('free-instruction', 'chapterOutline'),
        selection: source,
        context: `所属分卷：${activeVolumeTitle.value || '未指定'}；章节名称：${form.title || '未填写'}；预估字数：${form.wordCount}字`
      }),
    })
    const outline = String(data || '').trim().slice(0, 500)
    if (!outline) throw new Error('AI 暂无可用细纲')
    form.summary = outline
    ElMessage.success('AI 已完成细纲扩充')
  } catch (error) {
    console.error('AI章节细纲扩充失败:', error)
    ElMessage.error(String(error?.message || '细纲扩充失败，请稍后重试'))
  } finally {
    aiOutlineLoading.value = false
  }
}

const handleSave = () => {
  if (!form.volumeId) {
    ElMessage.warning('请选择所属分卷')
    return
  }
  if (!form.title) {
    ElMessage.warning('请输入章节名称')
    return
  }
  emit('save', { ...form })
  visible.value = false
}
</script>

<template>
  <EwModal
    v-model:visible="visible"
    :title="isEdit ? '编辑章节' : '新建章节'"
    width="600px"
    :close-on-click-modal="false"
    append-to-body
    draggable
  >
    <div class="form-container">
      <!-- 所属分卷 -->
      <div class="form-item">
        <label class="form-label">所属分卷</label>
        <el-select
          v-model="form.volumeId"
          class="ink-select"
          popper-class="ink-select-popper"
          placeholder="请选择分卷"
        >
          <el-option v-for="vol in volumes" :key="vol.id" :label="vol.title" :value="vol.id" />
        </el-select>
      </div>

      <!-- 章节名称 -->
      <div class="form-item">
        <div class="label-row">
          <label class="form-label">章节名称</label>
          <button class="ai-btn" type="button" :disabled="aiTitleLoading" @click="handleAiName">
            <i :class="aiTitleLoading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"></i>
            {{ aiTitleLoading ? '拟题中...' : 'AI 拟题' }}
          </button>
        </div>
        <div class="input-wrapper">
          <input
            type="text"
            v-model="form.title"
            class="ink-input-underline"
            style="padding-right: 50px;"
            placeholder="请输入章节名称"
            maxlength="50"
          >
          <span class="char-count">{{ form.title.length }} / 50</span>
        </div>
      </div>

      <!-- 剧情梗概 -->
      <div class="form-item">
        <div class="label-row">
          <label class="form-label">剧情梗概 / AI 指令</label>
          <button class="ai-btn" type="button" :disabled="aiOutlineLoading" @click="handleAiOutline">
            <i :class="aiOutlineLoading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-leaf'"></i>
            {{ aiOutlineLoading ? '扩充中...' : 'AI 扩充细纲' }}
          </button>
        </div>
        <div class="input-wrapper">
          <textarea
            v-model="form.summary"
            class="textarea-ink"
            placeholder="请输入本章核心剧情，或输入指令让 AI 自动生成..."
            rows="6"
            maxlength="500"
          ></textarea>
          <span class="char-count">{{ form.summary.length }} / 500</span>
        </div>
      </div>

      <!-- 预估生成字数 -->
      <div class="form-item">
        <div class="label-row">
          <label class="form-label">预估生成字数</label>
          <span class="word-count-val">{{ form.wordCount }} 字</span>
        </div>
        <div class="slider-wrapper">
          <el-slider v-model="form.wordCount" :min="1000" :max="10000" :step="100" class="slider-ink" />
        </div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer-wrapper">
        <div class="hint-text">
          <i class="fa-regular fa-lightbulb"></i>
          提示：完善梗概可提高 AI 生成质量
        </div>
        <div class="dialog-footer">
          <button class="ink-btn ink-btn-outline" @click="visible = false">取消</button>
          <button class="ink-btn ink-btn-primary" @click="handleSave">
            <i class="fa-solid fa-feather-pointed"></i> {{ isEdit ? '保存' : '创建并生成正文' }}
          </button>
        </div>
      </div>
    </template>
  </EwModal>
</template>

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
  justify-content: space-between;
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

  /* For underline input, adjust position */
  .ink-input-underline + .char-count {
     bottom: 8px;
     right: 0;
  }
}

.textarea-ink {
  width: 100%;
  padding: 12px 16px;
  padding-bottom: 30px;
  border: 1px solid var(--input-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--ink-main);
  font-size: calc(14px * var(--ui-font-scale, 1));
  outline: none;
  transition: all 0.3s;
  resize: none;

  &:focus {
    border-color: var(--input-focus-border);
    background: var(--input-focus-bg);
    box-shadow: 0 0 0 2px var(--selection-bg-color);
  }

  &::placeholder {
    color: var(--ink-sec);
    opacity: 0.5;
  }
}

.word-count-val {
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  font-variant-numeric: tabular-nums;
}

.slider-wrapper {
  padding: 0 8px;

  :deep(.el-slider__bar) {
    background-color: var(--ink-accent);
  }

  :deep(.el-slider__button) {
    border-color: var(--ink-accent);
  }

  :deep(.el-slider__runway) {
    background-color: var(--progress-track-bg);
  }
}

.dialog-footer-wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.hint-text {
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  display: flex;
  align-items: center;
  gap: 6px;

  i {
    opacity: 0.7;
  }
}

.dialog-footer {
  display: flex;
  gap: 12px;
}
</style>
