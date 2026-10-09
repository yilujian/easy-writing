import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AiModelGroupCode, AiModelOption, AiModelOptionsResult } from '@/types/ai-model'
import {
  getLocalAiPreference,
  listLocalAiModels,
  saveLocalAiPreference,
  sceneOfGroup,
} from '@/storage/local-ai-models'

// 开源版：模型清单与默认偏好全部来自本地 BYOK 模型库（模型管理页维护），零网络请求

const getOptionLabel = (model: AiModelOption) => {
  return model.name || model.modelCode || model.code
}

const toSelectOptions = (models: AiModelOption[]) => [
  { label: '智能推荐', value: '', description: '按场景自动选择合适的模型' },
  ...models.map(item => ({
    label: getOptionLabel(item),
    value: item.code,
    description: String(item.modelCode || '').trim(),
  })),
]

export const useAiModelStore = defineStore('ai-model', () => {
  const loading = ref<Record<string, boolean>>({})
  const loaded = ref<Record<string, boolean>>({})
  const groups = ref<Record<string, AiModelOptionsResult | null>>({})

  const textModel = ref('')
  const workflowModel = ref('')
  const imageModel = ref('')

  const textModels = computed(() => groups.value.text_assist?.models || [])
  const workflowModels = computed(() => groups.value.workflow_book?.models || [])
  const imageModels = computed(() => groups.value.image_generation?.models || [])

  const textSelectOptions = computed(() => toSelectOptions(textModels.value))
  const workflowSelectOptions = computed(() => toSelectOptions(workflowModels.value))
  const imageSelectOptions = computed(() => toSelectOptions(imageModels.value))

  const normalizeSelectedModel = (groupCode: AiModelGroupCode, value: string) => {
    const code = String(value || '').trim()
    if (!code) return ''
    const models = groups.value[groupCode]?.models || []
    return models.some(item => item.code === code) ? code : ''
  }

  const applyGroupModelValue = (groupCode: AiModelGroupCode, value: string) => {
    const modelCode = normalizeSelectedModel(groupCode, value)
    if (groupCode === 'text_assist') textModel.value = modelCode
    if (groupCode === 'workflow_book') workflowModel.value = modelCode
    if (groupCode === 'image_generation') imageModel.value = modelCode
  }

  const setGroupModel = async (groupCode: AiModelGroupCode, value: string) => {
    const modelCode = normalizeSelectedModel(groupCode, value)
    await saveLocalAiPreference(groupCode, modelCode)
    applyGroupModelValue(groupCode, modelCode)
    return true
  }

  const setTextModel = (value: string) => setGroupModel('text_assist', value)
  const setWorkflowModel = (value: string) => setGroupModel('workflow_book', value)
  const setImageModel = (value: string) => setGroupModel('image_generation', value)

  const loadGroup = async (groupCode: AiModelGroupCode, force = false) => {
    if (loading.value[groupCode]) return groups.value[groupCode]
    if (loaded.value[groupCode] && !force) return groups.value[groupCode]
    loading.value[groupCode] = true
    try {
      const { data } = await listLocalAiModels({ scene: sceneOfGroup(groupCode) })
      // 停用的模型不进下拉；已选中的模型被停用/删除时自动回落"智能推荐"
      const models = (data || []).filter(model => model.status !== 0)
      groups.value[groupCode] = {
        policy: null,
        defaultModel: null,
        models,
        selectedModelCode: getLocalAiPreference(groupCode),
      }
      loaded.value[groupCode] = true
      applyGroupModelValue(groupCode, getLocalAiPreference(groupCode))
      return groups.value[groupCode]
    } finally {
      loading.value[groupCode] = false
    }
  }

  const loadTextModels = (force = false) => loadGroup('text_assist', force)
  /** AI 功能取模型的统一入口：偏好组未加载则先加载，返回文本默认模型 code（可能为空） */
  const ensureTextModel = async (): Promise<string> => {
    if (!textModel.value) await loadGroup('text_assist')
    return textModel.value
  }
  const loadWorkflowModels = (force = false) => loadGroup('workflow_book', force)
  /** 工作流使用自己的默认偏好，与页面“跟随默认”的展示保持一致。 */
  const ensureWorkflowModel = async (): Promise<string> => {
    if (!workflowModel.value) await loadWorkflowModels()
    return workflowModel.value
  }
  const loadImageModels = (force = false) => loadGroup('image_generation', force)
  const loadAll = async (force = false) => {
    await Promise.all([loadTextModels(force), loadWorkflowModels(force), loadImageModels(force)])
  }

  return {
    groups,
    loading,
    loaded,
    textModel,
    workflowModel,
    imageModel,
    textModels,
    workflowModels,
    imageModels,
    textSelectOptions,
    workflowSelectOptions,
    imageSelectOptions,
    setTextModel,
    setWorkflowModel,
    setImageModel,
    loadGroup,
    loadTextModels,
    ensureTextModel,
    loadWorkflowModels,
    ensureWorkflowModel,
    loadImageModels,
    loadAll,
  }
})
