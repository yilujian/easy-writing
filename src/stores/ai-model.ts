import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  AI_MODEL_GROUPS,
  type AiModelGroupCode,
  type AiModelOption,
  type AiModelOptionsResult
} from '@/types/ai-model'
import {
  getLocalAiPreference,
  listLocalAiModels,
  saveLocalAiPreference,
  sceneOfGroup
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
    description: String(item.modelCode || '').trim()
  }))
]

export const useAiModelStore = defineStore('ai-model', () => {
  const loading = ref<Record<string, boolean>>({})
  const loaded = ref<Record<string, boolean>>({})
  const groups = ref<Record<string, AiModelOptionsResult | null>>({})

  const textModel = ref('')
  const workflowModel = ref('')
  const imageModel = ref('')
  /** 向量检索模型（embedding）；空 = 不启用语义检索 */
  const embeddingModel = ref('')
  /** 后台整理模型（故事状态抽取、章节摘要等批量任务）；空 = 跟随写作助手 */
  const backgroundModel = ref('')
  /** 微信助手（ClawBot 通道）回答用的模型；空 = 跟随写作助手 */
  const weixinModel = ref('')
  /** 各分组当前保存的偏好 code（分组表里的全部分组，含 Agent 四个角色）；旧字段保留给已有页面 */
  const selected = ref<Partial<Record<AiModelGroupCode, string>>>({})
  const fallbackOf = (groupCode: AiModelGroupCode) =>
    AI_MODEL_GROUPS.find(group => group.code === groupCode)?.fallback

  const textModels = computed(() => groups.value.text_assist?.models || [])
  const workflowModels = computed(() => groups.value.workflow_book?.models || [])
  const imageModels = computed(() => groups.value.image_generation?.models || [])
  const embeddingModels = computed(() => groups.value.embedding?.models || [])
  const backgroundModels = computed(() => groups.value.background?.models || [])
  const weixinModels = computed(() => groups.value.weixin?.models || [])

  /**
   * 各分组实际生效的模型（分组列表已只含启用的模型）：
   * - 写作助手 / 图像生成 / 语义记忆：没选时自动用该用途列表里的第一个，加完模型就能用；
   * - 后台整理 / 微信助手：没选时跟随写作助手；
   * - 工作流建书：不自动兜底、也不借用写作助手——建书是大额消耗，必须由用户明确选择
   *   （见 tests/workflow-model-selection.test.ts）。
   */
  const firstEnabled = (models: AiModelOption[]) => models.find(model => model.status !== 0)?.code || ''
  const effectiveTextModel = computed(() => textModel.value || firstEnabled(textModels.value))
  const effectiveWorkflowModel = computed(() => workflowModel.value)
  const effectiveImageModel = computed(() => imageModel.value || firstEnabled(imageModels.value))
  const effectiveEmbeddingModel = computed(() => embeddingModel.value || firstEnabled(embeddingModels.value))
  const effectiveBackgroundModel = computed(() => backgroundModel.value || effectiveTextModel.value)
  const effectiveWeixinModel = computed(() => weixinModel.value || effectiveTextModel.value)

  /** 用户在该分组保存的偏好原值（空 = 自动 / 跟随 / 未设置，含义见 effective 系列） */
  const preferenceOf = (groupCode: AiModelGroupCode): string => {
    if (groupCode === 'text_assist') return textModel.value
    if (groupCode === 'workflow_book') return workflowModel.value
    if (groupCode === 'image_generation') return imageModel.value
    if (groupCode === 'embedding') return embeddingModel.value
    if (groupCode === 'background') return backgroundModel.value
    if (groupCode === 'weixin') return weixinModel.value
    return selected.value[groupCode] || ''
  }
  /** 分支页面沿用的名字：某分组保存的偏好原值 */
  const selectedModelCode = (groupCode: AiModelGroupCode) => preferenceOf(groupCode)
  const modelsFor = (groupCode: AiModelGroupCode) => groups.value[groupCode]?.models || []

  /** 该分组当前实际会用的模型 code（可能为空） */
  const effectiveModelCode = (groupCode: AiModelGroupCode): string => {
    if (groupCode === 'text_assist') return effectiveTextModel.value
    if (groupCode === 'workflow_book') return effectiveWorkflowModel.value
    if (groupCode === 'image_generation') return effectiveImageModel.value
    if (groupCode === 'embedding') return effectiveEmbeddingModel.value
    if (groupCode === 'background') return effectiveBackgroundModel.value
    if (groupCode === 'weixin') return effectiveWeixinModel.value
    // Agent 角色：自己选了用自己的，否则沿分组表的回退链（写作/评审/索引 → 规划 → 写作助手）
    const own = selected.value[groupCode] || ''
    if (own) return own
    const fallback = fallbackOf(groupCode)
    return fallback ? effectiveModelCode(fallback) : ''
  }

  const textSelectOptions = computed(() => toSelectOptions(textModels.value))
  const workflowSelectOptions = computed(() => toSelectOptions(workflowModels.value))
  const imageSelectOptions = computed(() => toSelectOptions(imageModels.value))
  const embeddingSelectOptions = computed(() => toSelectOptions(embeddingModels.value))
  const backgroundSelectOptions = computed(() => toSelectOptions(backgroundModels.value))

  const normalizeSelectedModel = (groupCode: AiModelGroupCode, value: string) => {
    const code = String(value || '').trim()
    if (!code) return ''
    const models = groups.value[groupCode]?.models || []
    return models.some(item => item.code === code) ? code : ''
  }

  const applyGroupModelValue = (groupCode: AiModelGroupCode, value: string) => {
    const modelCode = normalizeSelectedModel(groupCode, value)
    selected.value = { ...selected.value, [groupCode]: modelCode }
    if (groupCode === 'text_assist') textModel.value = modelCode
    if (groupCode === 'workflow_book') workflowModel.value = modelCode
    if (groupCode === 'image_generation') imageModel.value = modelCode
    if (groupCode === 'embedding') embeddingModel.value = modelCode
    if (groupCode === 'background') backgroundModel.value = modelCode
    if (groupCode === 'weixin') weixinModel.value = modelCode
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
  const setEmbeddingModel = (value: string) => setGroupModel('embedding', value)
  const setBackgroundModel = (value: string) => setGroupModel('background', value)
  const setWeixinModel = (value: string) => setGroupModel('weixin', value)

  const pendingGroupLoads = new Map<string, Promise<AiModelOptionsResult | null | undefined>>()

  const loadGroup = (groupCode: AiModelGroupCode, force = false) => {
    const pending = pendingGroupLoads.get(groupCode)
    if (pending) return pending
    if (loaded.value[groupCode] && !force) return Promise.resolve(groups.value[groupCode])
    const task = (async () => {
      loading.value[groupCode] = true
      try {
        const { data } = await listLocalAiModels({ scene: sceneOfGroup(groupCode) })
        // 停用的模型不进下拉；已选中的模型被停用/删除时自动回落"智能推荐"
        const models = (data || []).filter(model => model.status !== 0)
        groups.value[groupCode] = {
          policy: null,
          defaultModel: null,
          models,
          selectedModelCode: getLocalAiPreference(groupCode)
        }
        loaded.value[groupCode] = true
        applyGroupModelValue(groupCode, getLocalAiPreference(groupCode))
        return groups.value[groupCode]
      } finally {
        loading.value[groupCode] = false
      }
    })()
    pendingGroupLoads.set(groupCode, task)
    void task
      .finally(() => {
        if (pendingGroupLoads.get(groupCode) === task) pendingGroupLoads.delete(groupCode)
      })
      .catch(() => undefined)
    return task
  }

  const loadTextModels = (force = false) => loadGroup('text_assist', force)
  /** AI 功能取模型的统一入口：偏好组未加载则先加载；没选默认时自动用第一个启用的文本模型（可能为空） */
  const ensureTextModel = async (): Promise<string> => {
    if (!loaded.value.text_assist) await loadGroup('text_assist')
    return effectiveTextModel.value
  }
  const loadWorkflowModels = (force = false) => loadGroup('workflow_book', force)
  /** 工作流只认自己的默认偏好：没选就返回空串，由调用方提示用户选择，不借用写作助手的模型 */
  const ensureWorkflowModel = async (): Promise<string> => {
    if (!loaded.value.workflow_book) await loadWorkflowModels()
    return effectiveWorkflowModel.value
  }
  const loadImageModels = (force = false) => loadGroup('image_generation', force)
  const loadEmbeddingModels = (force = false) => loadGroup('embedding', force)
  /** 语义记忆取模型：没选时自动用第一个启用的向量模型；返回空串表示没有向量模型、功能不启用 */
  const ensureEmbeddingModel = async (): Promise<string> => {
    if (!loaded.value.embedding) await loadEmbeddingModels()
    return effectiveEmbeddingModel.value
  }
  const loadBackgroundModels = (force = false) => loadGroup('background', force)
  /** 后台批量任务取模型：优先"后台整理"分组，没选则跟随写作助手；都没有返回空串 */
  const ensureBackgroundModel = async (): Promise<string> => {
    if (!loaded.value.background) await loadBackgroundModels()
    return backgroundModel.value || (await ensureTextModel())
  }
  const loadWeixinModels = (force = false) => loadGroup('weixin', force)
  /** 微信助手取模型：优先"微信助手"分组，没选则跟随写作助手；都没有返回空串 */
  const ensureWeixinModel = async (): Promise<string> => {
    if (!loaded.value.weixin) await loadWeixinModels()
    return weixinModel.value || (await ensureTextModel())
  }
  /**
   * 任意分组的统一入口：未加载则先加载；没单独选时沿分组表回退，
   * 回退到底的分组按 effective 规则（写作助手自动用第一个启用的，建书不兜底）。
   */
  const ensureGroupModel = async (groupCode: AiModelGroupCode): Promise<string> => {
    if (!loaded.value[groupCode]) await loadGroup(groupCode)
    const own = preferenceOf(groupCode)
    if (own) return own
    const fallback = fallbackOf(groupCode)
    return fallback ? ensureGroupModel(fallback) : effectiveModelCode(groupCode)
  }
  const loadAll = async (force = false) => {
    await Promise.all(AI_MODEL_GROUPS.map(group => loadGroup(group.code, force)))
  }

  return {
    groups,
    loading,
    loaded,
    textModel,
    workflowModel,
    imageModel,
    embeddingModel,
    backgroundModel,
    weixinModel,
    textModels,
    workflowModels,
    imageModels,
    embeddingModels,
    backgroundModels,
    weixinModels,
    textSelectOptions,
    workflowSelectOptions,
    imageSelectOptions,
    embeddingSelectOptions,
    backgroundSelectOptions,
    effectiveTextModel,
    effectiveWorkflowModel,
    effectiveImageModel,
    effectiveEmbeddingModel,
    effectiveBackgroundModel,
    effectiveWeixinModel,
    preferenceOf,
    effectiveModelCode,
    selected,
    selectedModelCode,
    modelsFor,
    ensureGroupModel,
    setGroupModel,
    setTextModel,
    setWorkflowModel,
    setImageModel,
    setEmbeddingModel,
    setBackgroundModel,
    setWeixinModel,
    loadGroup,
    loadTextModels,
    ensureTextModel,
    loadWorkflowModels,
    ensureWorkflowModel,
    loadImageModels,
    loadEmbeddingModels,
    ensureEmbeddingModel,
    loadBackgroundModels,
    ensureBackgroundModel,
    loadWeixinModels,
    ensureWeixinModel,
    loadAll
  }
})
