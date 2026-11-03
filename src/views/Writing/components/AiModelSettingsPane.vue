<template>
  <section class="ai-model-settings" :class="{ 'page-mode': mode === 'page' }">
    <div v-if="showHead" class="pane-head">
      <h3>AI模型</h3>
      <p>接入自己的供应商模型，并为各功能选择默认模型。API Key 只保存在本机。</p>
    </div>

    <!-- 默认模型：六个槽位平铺。前三个是用户直接感知的功能；后三个默认跟随/自动，用一行小字分组说明即可 -->
    <section class="model-card default-card">
      <div class="card-head inline-head">
        <div>
          <h4>默认模型</h4>
          <p>没选时自动用列表里第一个启用的模型；建书消耗大，需要你明确选一个。</p>
        </div>
        <button class="ink-btn ink-btn-outline compact-btn" type="button" @click="refreshModels">
          刷新
        </button>
      </div>
      <div class="default-grid">
        <template v-for="slot in defaultSlots" :key="slot.group">
          <div v-if="slot.group === firstAdvancedGroup" class="slot-group-caption">
            <span>进阶</span>
            <small>默认跟随上面的设置或自动启用，一般不用改</small>
          </div>
          <label class="field">
            <span>{{ slot.label }}<small class="key-local-hint">{{ slot.hint }}</small></span>
            <!-- 该用途一个模型都没有：下拉没意义，直接给"去添加"的入口 -->
            <div v-if="!slotModels(slot.group).length" class="slot-empty-note">
              <i class="fa-solid fa-circle-info"></i>
              <span>还没有{{ slot.sceneName }}模型，</span>
              <button type="button" class="link-btn" @click="startAddModel(slot.scene)">添加一个</button>
              <span>，添加后自动启用。</span>
            </div>
            <el-select
              v-else
              :model-value="aiModelStore.preferenceOf(slot.group)"
              size="small"
              class="model-select"
              popper-class="ai-model-select-popper"
              @update:model-value="setSlotValue(slot.group, $event)"
            >
              <template #prefix>
                <span class="model-select-prefix">
                  <img v-if="getSelectedModelIcon(slot.group)" :src="getSelectedModelIcon(slot.group)" alt="" />
                  <i v-else class="fa-solid" :class="slot.icon"></i>
                </span>
              </template>
              <el-option :label="slotEmptyLabel(slot)" value="">
                <span class="model-select-option">
                  <span class="model-option-icon"><i class="fa-solid" :class="slot.icon"></i></span>
                  <span class="model-option-copy">
                    <span class="model-option-name">{{ slotEmptyLabel(slot) }}</span>
                    <span class="model-option-desc">{{ slotEmptyDesc(slot) }}</span>
                  </span>
                </span>
              </el-option>
              <el-option
                v-for="model in slotModels(slot.group)"
                :key="model.code"
                :label="getModelOptionLabel(model)"
                :value="model.code"
              >
                <span class="model-select-option">
                  <span class="model-option-icon">
                    <img v-if="getModelProviderIcon(model)" :src="getModelProviderIcon(model)" alt="" />
                    <i v-else class="fa-solid fa-cube"></i>
                  </span>
                  <span class="model-option-copy">
                    <span class="model-option-name">{{ getModelOptionLabel(model) }}</span>
                    <span v-if="model.description" class="model-option-desc">{{ model.description }}</span>
                  </span>
                </span>
              </el-option>
            </el-select>
          </label>
        </template>
      </div>
    </section>

    <section class="model-card list-card">
      <div class="list-toolbar">
        <div>
          <h4>我的模型</h4>
          <p>{{ filteredModels.length }} 个模型 · 在这里接入供应商，上面的默认模型从这里选</p>
        </div>
        <div class="list-filters">
          <el-input v-model="keyword" size="small" clearable placeholder="搜索名称或代码">
            <template #prefix>
              <i class="fa-solid fa-magnifying-glass"></i>
            </template>
          </el-input>
          <el-select v-model="statusFilter" size="small" popper-class="ai-model-select-popper">
            <el-option label="全部状态" value="all" />
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
          <button class="ink-btn ink-btn-primary compact-btn" type="button" @click="startAddModel()">
            <i class="fa-solid fa-plus"></i>
            添加模型
          </button>
        </div>
      </div>

      <div v-if="loading" class="empty-state">模型加载中...</div>
      <div v-else-if="!filteredModels.length" class="empty-state">
        <template v-if="models.length">没有符合筛选条件的模型</template>
        <template v-else>
          <p>还没有模型。接入你的供应商后，AI 功能会自动使用它。</p>
          <button class="ink-btn ink-btn-primary" type="button" @click="startAddModel()">
            <i class="fa-solid fa-plus"></i>
            添加第一个模型
          </button>
        </template>
      </div>
      <div v-else class="model-table-wrap">
        <table class="model-table">
          <thead>
            <tr>
              <th>模型名称</th>
              <th>模型代码</th>
              <th>场景</th>
              <th>状态</th>
              <th>测试</th>
              <th>接口</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in filteredModels" :key="model.code">
              <td>
                <strong class="cell-title" :title="model.name">{{ model.name }}</strong>
                <small>{{ getProviderLabel(model.provider) }}</small>
              </td>
              <td class="mono-cell" :title="model.modelCode || model.code">{{ model.modelCode || model.code }}</td>
              <td>{{ sceneLabels[model.scene] || model.scene }}</td>
              <td>
                <!-- 状态列直接可切，不用再去操作列找"禁用/启用" -->
                <el-switch
                  class="row-status-switch"
                  size="small"
                  :model-value="model.status === 1"
                  :loading="togglingRowId === model.id"
                  :disabled="togglingRowId === model.id"
                  :aria-label="model.status === 1 ? '禁用该模型' : '启用该模型'"
                  active-text="启用"
                  inactive-text="禁用"
                  inline-prompt
                  @change="toggleStatus(model)"
                />
              </td>
              <td>
                <span v-if="rowTest(model.id)?.running" class="model-test-running">
                  <el-icon class="is-loading"><Loading /></el-icon>
                  {{ elapsedText(rowTest(model.id)?.progress.elapsedMs || 0) }}
                </span>
                <el-tag v-else size="small" effect="plain" :type="getTestClass(model)">{{ getTestLabel(model) }}</el-tag>
                <small v-if="!rowTest(model.id)?.running && (rowTest(model.id)?.result || model.lastLatency)">{{ durationText(rowTest(model.id)?.result?.latency ?? model.lastLatency ?? 0) }}</small>
              </td>
              <td class="url-cell">
                <span class="url-text" :title="model.baseUrl || ''">{{ model.baseUrl || '-' }}</span>
                <!-- 报错单独挂 title：单元格被 nowrap 截断，悬浮时要能看到完整错误而不是外层的地址 -->
                <small v-if="model.lastError && !rowTest(model.id)?.running && rowTest(model.id)?.result?.outcome !== 'cancelled'" class="error-text" :class="{ 'test-warning': ['timeout', 'unverified'].includes(model.lastTestOutcome || '') }" :title="model.lastError">{{ model.lastError }}</small>
              </td>
              <td>
                <div class="row-actions">
                  <el-button v-if="!rowTest(model.id)?.running" link type="primary" @click="testRowModel(model)">测试</el-button>
                  <el-button v-if="rowTest(model.id)?.running" link type="primary" @click="cancelTest(model.id)">取消测试</el-button>
                  <el-button link @click="editModel(model)">编辑</el-button>
                  <el-button link @click="toggleStatus(model)">
                    {{ model.status === 1 ? '禁用' : '启用' }}
                  </el-button>
                  <el-button link type="danger" @click="deleteModel(model)">删除</el-button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 添加 / 编辑模型：弹窗。页面上只留列表和默认模型，表单不常驻 -->
    <EwModal
      v-model:visible="composerOpen"
      :title="editingId ? '编辑模型' : '添加模型'"
      width="min(1040px, calc(100vw - 32px))"
      max-height="92vh"
      custom-class="ai-model-composer-modal"
      :close-on-click-modal="false"
      @close="closeComposer"
    >
      <div class="composer">
        <div class="composer-section">
          <div class="composer-section-head">
            <h5>供应商</h5>
            <p>选一家预设会自动填好接口地址与推荐参数，也可以选「自定义」</p>
          </div>
          <div class="provider-grid">
            <button
              v-for="preset in providerPresets"
              :key="preset.provider"
              type="button"
              class="provider-card"
              :class="{ active: form.provider === preset.provider }"
              :aria-pressed="form.provider === preset.provider"
              @click="applyProvider(preset)"
            >
              <span class="provider-icon" :class="{ 'is-custom': !preset.iconSrc }">
                <img v-if="preset.iconSrc" :src="preset.iconSrc" :alt="`${preset.label} logo`" loading="lazy" />
                <i v-else class="fa-solid fa-plus"></i>
              </span>
              <span class="provider-info">
                <strong>{{ preset.label }}</strong>
                <small>{{ preset.description }}</small>
              </span>
              <span v-if="form.provider === preset.provider" class="provider-check" aria-hidden="true">
                <i class="fa-solid fa-check"></i>
              </span>
            </button>
          </div>
        </div>

        <div class="composer-section">
          <div class="composer-section-head">
            <h5>连接信息</h5>
            <p>当前支持 OpenAI 兼容协议；API Key 只保存在本机</p>
          </div>
          <div class="form-grid">
            <label class="field">
              <span>使用场景</span>
              <el-select v-model="form.scene" size="small" popper-class="ai-model-select-popper">
                <el-option label="文字生成（续写、建书、对话）" value="text" />
                <el-option label="图像生成（封面）" value="image" />
              </el-select>
            </label>
            <label class="field">
              <span>服务商</span>
              <el-select v-model="form.provider" size="small" popper-class="ai-model-select-popper">
                <el-option
                  v-for="preset in providerPresets"
                  :key="preset.provider"
                  :label="preset.label"
                  :value="preset.provider"
                />
              </el-select>
            </label>
            <label class="field">
              <span>模型名称</span>
              <el-input v-model="form.name" size="small" maxlength="80" placeholder="我的 DeepSeek" />
            </label>
            <label ref="modelCodeFieldRef" class="field model-code-field">
              <span>模型代码</span>
              <div class="model-code-control">
                <el-input
                  v-model="form.modelCode"
                  size="small"
                  maxlength="120"
                  placeholder="deepseek-chat"
                  @focus="showRemoteModelPanel"
                  @input="remoteModelPanelVisible = false"
                />
                <button
                  class="fetch-model-btn"
                  type="button"
                  :disabled="remoteModelLoading"
                  @click.prevent="fetchRemoteModels"
                >
                  <i v-if="remoteModelLoading" class="fa-solid fa-spinner fa-spin"></i>
                  <i v-else class="fa-solid fa-cloud-arrow-down"></i>
                  拉取
                </button>
              </div>
              <div v-if="remoteModelPanelVisible" class="remote-model-panel">
                <button
                  v-for="code in remoteModels"
                  :key="code"
                  type="button"
                  :class="{ active: form.modelCode === code }"
                  @click.prevent="selectRemoteModel(code)"
                >
                  {{ code }}
                </button>
              </div>
            </label>
            <label class="field wide">
              <span>Base URL</span>
              <el-input v-model="form.baseUrl" size="small" maxlength="500" placeholder="https://api.example.com/v1" />
            </label>
            <label class="field wide">
              <span>API Key<small class="key-local-hint">（只保存在本机；Ollama 等本地部署可留空）</small></span>
              <el-input
                v-model="form.apiKey"
                size="small"
                type="password"
                show-password
                :placeholder="editingId ? '留空则不修改' : '请输入 API Key'"
              />
            </label>
            <label class="field">
              <span>最大上下文</span>
              <el-input-number
                v-model="form.maxContext"
                size="small"
                :min="1024"
                :max="1000000"
                :step="1024"
                controls-position="right"
              />
            </label>
            <label class="field">
              <span>最大输出 Tokens<small class="key-local-hint">（各家上限不同，思考型模型建议 32768 以上）</small></span>
              <el-input-number
                v-model="form.maxOutputTokens"
                size="small"
                :min="128"
                :max="form.maxContext"
                :step="512"
                controls-position="right"
              />
            </label>
            <label class="field">
              <span>思考模式<small class="key-local-hint">{{ thinkingSupportHint }}</small></span>
              <el-select v-model="form.thinking" size="small" class="ink-select" popper-class="ink-select-popper">
                <el-option label="关闭（结构化任务更快更稳）" value="off" />
                <el-option label="跟随模型默认" value="default" />
                <el-option label="开启（请调大最大输出 Tokens）" value="on" />
              </el-select>
            </label>
            <label class="field">
              <span>额外请求参数<small class="key-local-hint">（JSON 对象，原样合并进请求体）</small></span>
              <el-input
                v-model="form.extraParams"
                size="small"
                type="textarea"
                :rows="1"
                :autosize="{ minRows: 1, maxRows: 3 }"
                placeholder='{"chat_template_kwargs":{"enable_thinking":false}}'
              />
            </label>
          </div>
        </div>

        <el-collapse v-if="form.scene === 'text'" v-model="advancedOpen" class="model-test-advanced">
          <el-collapse-item title="高级设置" name="test-wait">
            <label class="field model-test-wait">
              <span>等待模型开始回复</span>
              <el-select v-model="selectedTestWait" aria-label="等待模型开始回复" size="small" popper-class="ai-model-select-popper">
                <el-option label="2 分钟" :value="120" />
                <el-option label="5 分钟" :value="300" />
                <el-option label="10 分钟" :value="600" />
              </el-select>
              <small>仅影响连接测试。云端默认 2 分钟，本地默认 5 分钟。</small>
            </label>
          </el-collapse-item>
        </el-collapse>
      </div>

      <template #footer>
        <div class="composer-test-footer">
          <div class="test-result" :class="testResultClass">
            <div class="test-icon" aria-hidden="true">
              <el-icon v-if="testingCurrent" class="is-loading"><Loading /></el-icon>
              <i v-else-if="testResult?.ok" class="fa-solid fa-check"></i>
              <i v-else-if="testResult?.outcome === 'cancelled'" class="fa-solid fa-minus"></i>
              <i v-else-if="testResult" class="fa-solid fa-xmark"></i>
              <i v-else class="fa-solid fa-signal"></i>
            </div>
            <div class="test-body">
              <strong role="status" aria-live="polite">{{ testResultTitle }}</strong>
              <span :title="testResultMessage">{{ testResultMessage }}</span>
              <el-text v-if="testResult?.reply" :line-clamp="2" class="model-test-reply">模型回复：{{ testResult.reply }}</el-text>
            </div>
            <dl v-if="testResult" class="test-meta">
              <div v-if="form.scene === 'text'">
                <dt>Token 用量</dt>
                <dd>{{ testResult.inputTokens != null && testResult.outputTokens != null ? testResult.inputTokens + testResult.outputTokens : '未获取' }}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{{ durationText(testResult.latency) }}</dd>
              </div>
              <div>
                <dt>时间</dt>
                <dd>{{ testedTimeText(testResult.testedAt) }}</dd>
              </div>
              <div class="test-meta-url">
                <dt>地址</dt>
                <dd :title="testResult.url || form.baseUrl">{{ testResult.url || form.baseUrl || '-' }}</dd>
              </div>
            </dl>
          </div>
          <div class="composer-footer">
            <el-switch v-model="modelEnabled" active-text="启用" inactive-text="禁用" />
            <div class="form-actions">
              <el-button class="ink-btn ink-btn-outline" @click="closeComposer">关闭</el-button>
              <el-button class="ink-btn ink-btn-outline" :disabled="testingCurrent" :loading="testingCurrent" @click="testCurrentModel">
                <i v-if="!testingCurrent" class="fa-solid fa-plug-circle-check" aria-hidden="true"></i>
                测试连接
              </el-button>
              <el-button v-if="testingCurrent" class="ink-btn ink-btn-outline" @click="cancelTest(editingId)">取消测试</el-button>
              <el-button class="ink-btn ink-btn-primary" type="primary" :loading="saving" @click="saveModel">
                <i v-if="!saving" class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                {{ editingId ? '保存修改' : '保存模型' }}
              </el-button>
            </div>
          </div>
        </div>
      </template>
    </EwModal>
  </section>
</template>

<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import type { ModelTestProgress } from '@/types/model-test'
import { modelTestWaitSeconds } from '@/utils/model-test-policy'
import { persistModelTestResult } from '@/utils/model-connection-test'
import EwModal from '@/components/EwModal/index.vue'
import { inkConfirm } from '@/utils/ink-confirm'
import { showApiError } from '@/utils/api-error'
import { AI_MODEL_GROUPS, type AiModelGroupCode, type AiModelOption } from '@/types/ai-model'
// 开源版：BYOK 模型走本地库+直连供应商（@/storage/local-ai-models + @/utils/local-ai-client），
// 函数形状对齐原服务端接口，调用点不动；API Key 只存本机
import {
  deleteLocalAiModel as deleteUserAiModelApi,
  listLocalAiModels as getUserAiModelsApi,
  saveLocalAiModel as saveUserAiModelApi,
  setLocalAiModelStatus as setUserAiModelStatusApi,
} from '@/storage/local-ai-models'
import {
  listLocalAiRemoteModels as listUserAiRemoteModelsApi,
  testLocalAiModel as testUserAiModelApi,
} from '@/utils/local-ai-client'
import type { AiThinkingMode, UserAiModelSavePayload, UserAiModelScene, UserAiModelTestResult } from '@/types/user-ai-model'
import { useAiModelStore } from '@/stores/ai-model'

type ProviderPreset = {
  label: string
  provider: string
  baseUrl: string
  icon: string
  iconSrc?: string
  description: string
  /** 该家常见上下文与输出上限的推荐值：输出上限各家各模型不同，超了会 400、不填各家默认又有大有小 */
  maxContext: number
  maxOutputTokens: number
  /** 新建模型时思考模式的默认值：能用参数关思考的供应商默认关，其余跟随模型默认 */
  thinking: AiThinkingMode
}

withDefaults(defineProps<{
  showHead?: boolean
  mode?: 'pane' | 'page'
}>(), {
  showHead: true,
  mode: 'pane',
})

const providerPresets: ProviderPreset[] = [
  { label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', icon: 'AI', iconSrc: '/provider-icons/openai.svg', description: 'OpenAI 兼容接口', maxContext: 128000, maxOutputTokens: 16384, thinking: 'default' },
  { label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', icon: 'DS', iconSrc: '/provider-icons/deepseek.ico', description: 'DeepSeek 官方接口', maxContext: 1000000, maxOutputTokens: 32768, thinking: 'off' },
  { label: 'MiniMax', provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', icon: 'MM', iconSrc: '/provider-icons/minimax.ico', description: 'MiniMax 官方接口', maxContext: 200000, maxOutputTokens: 16384, thinking: 'default' },
  { label: '通义千问', provider: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', icon: 'QW', iconSrc: '/provider-icons/tongyi.svg', description: '阿里百炼兼容接口', maxContext: 131072, maxOutputTokens: 16384, thinking: 'off' },
  { label: '火山方舟', provider: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', icon: 'ARK', iconSrc: '/provider-icons/volcengine.png', description: '豆包/方舟兼容接口', maxContext: 256000, maxOutputTokens: 32768, thinking: 'off' },
  { label: '智谱', provider: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', icon: 'GLM', iconSrc: '/provider-icons/bigmodel.png', description: '智谱开放平台', maxContext: 200000, maxOutputTokens: 65536, thinking: 'off' },
  { label: '硅基流动', provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', icon: 'SF', iconSrc: '/provider-icons/siliconflow.ico', description: '多模型聚合接口', maxContext: 131072, maxOutputTokens: 16384, thinking: 'off' },
  { label: 'OpenRouter', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', icon: 'OR', iconSrc: '/provider-icons/openrouter.ico', description: '路由聚合接口', maxContext: 200000, maxOutputTokens: 32768, thinking: 'default' },
  { label: 'Gemini兼容', provider: 'gemini_openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', icon: 'G', iconSrc: '/provider-icons/gemini.svg', description: 'Google 兼容接口', maxContext: 1000000, maxOutputTokens: 65536, thinking: 'default' },
  { label: 'Claude', provider: 'claude', baseUrl: 'https://api.anthropic.com/v1', icon: 'C', iconSrc: '/provider-icons/claude.svg', description: 'Anthropic Claude 接口', maxContext: 200000, maxOutputTokens: 16384, thinking: 'default' },
  { label: 'xAI Grok', provider: 'xai', baseUrl: 'https://api.x.ai/v1', icon: 'X', iconSrc: '/provider-icons/xai.svg', description: 'xAI Grok 接口', maxContext: 131072, maxOutputTokens: 16384, thinking: 'default' },
  { label: '本地部署', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', icon: '家', iconSrc: '/provider-icons/local.svg', description: 'Ollama / LM Studio 等本机服务，无需 API Key', maxContext: 32768, maxOutputTokens: 16384, thinking: 'off' },
  { label: '自定义', provider: 'custom', baseUrl: '', icon: '+', description: '自定义兼容接口', maxContext: 128000, maxOutputTokens: 8192, thinking: 'default' },
]

/** 思考模式下拉旁的小字：告诉用户这家能不能用参数开关（表在 local-ai-client 的 THINKING_PARAMS） */
const thinkingSupportHint = computed(() => {
  if (['deepseek', 'bigmodel', 'volcengine', 'aliyun', 'siliconflow', 'openrouter'].includes(form.provider)) {
    return '（此供应商支持开/关）'
  }
  if (['gemini_openai', 'local'].includes(form.provider)) return '（此供应商只支持关闭，开启即跟随默认）'
  return '（此供应商没有通用开关，可在额外请求参数里自填）'
})

const sceneLabels: Record<string, string> = {
  text: '文字',
  image: '生图',
}

/**
 * 「默认模型」的槽位定义。主槽位是用户直接感知的三类功能；进阶槽位要么是省钱开关、
 * 要么用于后台处理，默认跟随/自动；进阶槽位单独分组。
 */
type SlotDef = {
  group: AiModelGroupCode
  label: string
  hint: string
  icon: string
  scene: UserAiModelScene
  /** 空态文案里的用途名：还没有「文本」模型 */
  sceneName: string
}

const primarySlots: SlotDef[] = [
  { group: 'text_assist', label: '写作助手', hint: '续写、润色、妙笔、取名等日常功能', icon: 'fa-wand-magic-sparkles', scene: 'text', sceneName: '文本' },
  { group: 'workflow_book', label: '工作流建书', hint: '按大纲逐章生成正文，建议用最强的模型', icon: 'fa-diagram-project', scene: 'text', sceneName: '文本' },
  { group: 'image_generation', label: '图像生成', hint: '作品封面', icon: 'fa-image', scene: 'image', sceneName: '生图' },
]

const advancedSlots: SlotDef[] = [
  { group: 'weixin', label: '微信助手', hint: '在微信里跟易创对话时用', icon: 'fa-comment-dots', scene: 'text', sceneName: '文本' },
  { group: 'background', label: '后台整理', hint: '每章写完后自动整理人物状态与伏笔，调用次数多，可选便宜的', icon: 'fa-clipboard-list', scene: 'text', sceneName: '文本' },
  { group: 'agent_planner', label: 'Agent 规划', hint: 'Agent 对话主循环：理解指令、调用工具、规划拍子', icon: 'fa-diagram-project', scene: 'text', sceneName: '文本' },
  { group: 'agent_writer', label: 'Agent 写作', hint: '生成正文与定向修订，可以选更强的模型', icon: 'fa-pen-nib', scene: 'text', sceneName: '文本' },
  { group: 'agent_critic', label: 'Agent 评审', hint: '读者模拟体检，可与写作模型不同', icon: 'fa-magnifying-glass', scene: 'text', sceneName: '文本' },
  { group: 'agent_indexer', label: 'Agent 索引', hint: '章节卡提取与记忆整理，调用次数多，建议用便宜快的', icon: 'fa-layer-group', scene: 'text', sceneName: '文本' },
]

const defaultSlots: SlotDef[] = [...primarySlots, ...advancedSlots]
const firstAdvancedGroup = advancedSlots[0].group

/** 添加/编辑模型的弹窗 */
const composerOpen = ref(false)

const aiModelStore = useAiModelStore()
const loading = ref(false)
const saving = ref(false)
const togglingRowId = ref<number | null>(null)
const remoteModelLoading = ref(false)
const remoteModelPanelVisible = ref(false)
const modelCodeFieldRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const models = ref<AiModelOption[]>([])
const remoteModels = ref<string[]>([])
const keyword = ref('')
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')
interface TestState {
  controller: AbortController
  progress: ModelTestProgress
  running: boolean
  result: UserAiModelTestResult | null
}
const tests = reactive(new Map<string, TestState>())
const testKey = (id: number | null | undefined) => id == null ? 'composer' : `model:${id}`
const currentTest = computed(() => tests.get(testKey(editingId.value)))
const testingCurrent = computed(() => !!currentTest.value?.running)
const testResult = computed(() => currentTest.value?.result ?? null)
const advancedOpen = ref<string[]>([])
let mounted = true
const rowTest = (id: number) => tests.get(testKey(id))
const elapsedText = (ms: number) => `已等待 ${Math.floor(ms / 1000)} 秒`
const durationText = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
const testedTimeText = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
function cancelTest(id: number | null | undefined) { tests.get(testKey(id))?.controller.abort() }
function resetCurrentTest() {
  cancelTest(editingId.value)
  tests.delete(testKey(editingId.value))
}
async function runTest(payload: Partial<UserAiModelSavePayload>) {
  const key = testKey(payload.id)
  if (tests.get(key)?.running) return
  const state = reactive<TestState>({ controller: markRaw(new AbortController()), progress: { phase: 'waiting', elapsedMs: 0 }, running: true, result: null })
  tests.set(key, state)
  try {
    const { data } = await testUserAiModelApi(payload, {
      signal: state.controller.signal,
      onProgress: progress => { if (tests.get(key) === state) state.progress = progress }
    })
    if (!mounted || tests.get(key) !== state) return
    state.result = data
    if (data.outcome === 'cancelled') ElMessage.info('已取消测试')
    else if (data.ok) ElMessage.success(data.message)
    else if (data.outcome === 'timeout' || data.outcome === 'unverified') ElMessage.warning(data.message)
    else ElMessage.error(data.message)
    await refreshModels()
  } catch (error) {
    if (mounted && tests.get(key) === state) showApiError(error, '模型测试未完成')
  } finally {
    state.running = false
  }
}

/** 新增态的默认供应商：表单初值与重置都从这条预设取，保证与预设卡片一致 */
const DEFAULT_PRESET = providerPresets[0]

const form = reactive<UserAiModelSavePayload>({
  name: '',
  scene: 'text',
  provider: DEFAULT_PRESET.provider,
  protocol: 'openai_compatible',
  modelCode: '',
  baseUrl: DEFAULT_PRESET.baseUrl,
  apiKey: '',
  maxContext: DEFAULT_PRESET.maxContext,
  maxOutputTokens: DEFAULT_PRESET.maxOutputTokens,
  status: 1,
  sort: 0,
  thinking: DEFAULT_PRESET.thinking,
  extraParams: '',
  testWaitSeconds: undefined,
})

const selectedTestWait = computed({
  get: () => modelTestWaitSeconds(form),
  set: (value: 120 | 300 | 600) => { form.testWaitSeconds = value }
})

const modelEnabled = computed({
  get: () => form.status === 1,
  set: value => {
    form.status = value ? 1 : 0
  },
})

const slotModels = (group: AiModelGroupCode) => aiModelStore.groups[group]?.models || []

const setSlotValue = (group: AiModelGroupCode, value: unknown) => {
  void aiModelStore.setGroupModel(group, String(value || ''))
}

/** 该分组实际生效的模型名（没选时是自动/跟随到的那个） */
const effectiveModelName = (group: AiModelGroupCode) => {
  const code = aiModelStore.effectiveModelCode(group)
  if (!code) return ''
  const model = slotModels(group).find(item => item.code === code) || aiModelStore.textModels.find(item => item.code === code)
  return model ? model.name || model.modelCode || code : ''
}

/** 分组没单独选时跟随哪个分组（取自模型分组表），没有回退的返回空 */
const groupFallbackLabel = (group: AiModelGroupCode) => {
  const fallback = AI_MODEL_GROUPS.find(item => item.code === group)?.fallback
  return fallback ? AI_MODEL_GROUPS.find(item => item.code === fallback)?.name || '' : ''
}

/** 空选项的标题：把"没选"时到底会用哪个模型直接写出来，不再叫"智能推荐" */
const slotEmptyLabel = (slot: SlotDef) => {
  const name = effectiveModelName(slot.group)
  if (slot.group === 'workflow_book') return '未设置'
  const fallback = groupFallbackLabel(slot.group)
  if (fallback) return name ? `跟随${fallback} · ${name}` : `跟随${fallback}`
  return name ? `自动 · ${name}` : `未添加${slot.sceneName}模型`
}

const slotEmptyDesc = (slot: SlotDef) => {
  if (slot.group === 'workflow_book') return '建书消耗大，请明确选一个；不会自动借用写作助手的模型'
  const fallback = groupFallbackLabel(slot.group)
  if (fallback) return `不单独选时与${fallback}用同一个模型`
  return `不指定时自动用列表里第一个启用的${slot.sceneName}模型`
}

/** 打开添加弹窗；从某个槽位的"添加一个"进来时预选对应用途 */
const startAddModel = (scene?: UserAiModelScene) => {
  resetForm()
  if (scene) form.scene = scene
  composerOpen.value = true
}

/** 关闭弹窗并清掉表单：取消、右上角 X、保存成功都走这里 */
const closeComposer = () => {
  composerOpen.value = false
  resetForm()
}

const filteredModels = computed(() => {
  const term = keyword.value.trim().toLowerCase()
  return models.value.filter(model => {
    if (statusFilter.value === 'enabled' && model.status !== 1) return false
    if (statusFilter.value === 'disabled' && model.status === 1) return false
    if (!term) return true
    return `${model.name} ${model.modelCode || model.code} ${model.provider || ''}`.toLowerCase().includes(term)
  })
})

const testResultClass = computed(() => testingCurrent.value ? 'testing' : !testResult.value || testResult.value.outcome === 'cancelled' ? 'idle' : testResult.value.ok ? 'success' : ['timeout', 'unverified'].includes(testResult.value.outcome || '') ? 'warning' : 'error')

const testResultTitle = computed(() => {
  if (testingCurrent.value) return '正在测试'
  if (!testResult.value) return '等待测试'
  if (testResult.value.outcome === 'cancelled') return '已取消测试'
  if (testResult.value.outcome === 'timeout') return '等待超时'
  if (testResult.value.outcome === 'unverified') return '尚未验证通过'
  return testResult.value.ok ? (testResult.value.outcome === 'reachable' ? '服务检查完成' : '测试成功') : '测试未通过'
})

const testResultMessage = computed(() => {
  if (testingCurrent.value) {
    const phase = currentTest.value?.progress.phase
    return `${form.scene === 'image' ? '正在检查模型列表' : phase === 'thinking' ? '模型正在思考' : phase === 'receiving' ? '正在接收模型回复' : '等待模型回复'}，${elapsedText(currentTest.value?.progress.elapsedMs || 0)}`
  }
  if (!testResult.value) return form.scene === 'image' ? '仅检查模型列表，不生成图片，不验证生图效果' : '请求一句简短回复，可能产生少量模型用量'
  return testResult.value.message
})

onMounted(async () => {
  document.addEventListener('click', closeRemoteModelPanelOnOutside)
  await refreshModels()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeRemoteModelPanelOnOutside)
  mounted = false
  for (const test of tests.values()) test.controller.abort()
  tests.clear()
})

const applyProvider = (preset: ProviderPreset) => {
  form.provider = preset.provider
  if (preset.baseUrl) form.baseUrl = preset.baseUrl
  form.maxContext = preset.maxContext
  form.maxOutputTokens = preset.maxOutputTokens
  form.thinking = preset.thinking
  resetCurrentTest()
  clearRemoteModels()
}

const refreshModels = async () => {
  loading.value = true
  try {
    const { data } = await getUserAiModelsApi()
    models.value = data || []
    await aiModelStore.loadAll(true)
  } catch (error) {
    showApiError(error, '加载模型失败')
  } finally {
    loading.value = false
  }
}

const saveModel = async () => {
  if (saving.value) return
  if (!validateForm()) return
  saving.value = true
  try {
    const payload = buildPayload()
    const completed = testResult.value ? toRaw(testResult.value) : null
    resetCurrentTest()
    const wasEditing = Boolean(editingId.value)
    const sceneHadNone = !models.value.some(model => model.scene === payload.scene && model.status === 1)
    const saved = await saveUserAiModelApi(payload)
    if (completed) await persistModelTestResult(saved.data.id, completed).catch(error => console.warn('模型已保存，测试结果记录失败', error))
    // 保存即关弹窗回到列表，刚存的那条在列表里、默认模型里都能看到。
    // 之前保存后表单仍处于该条的编辑态，用户接着改再点保存，就把上一条悄悄覆盖了。
    // 要改已保存的模型，从列表点「编辑」显式进入。
    closeComposer()
    ElMessage.success(
      wasEditing
        ? '模型已更新'
        : sceneHadNone && payload.status === 1
          ? '模型已保存；这是第一个可用的该用途模型，相关 AI 功能会自动使用它'
          : '模型已保存，已加入列表；要让某个功能用它，在上方「默认模型」里选'
    )
    await refreshModels()
  } catch (error) {
    showApiError(error, '保存模型失败')
  } finally {
    saving.value = false
  }
}

const testCurrentModel = async () => {
  if (!validateForm()) return
  await runTest(buildPayload())
}

const testRowModel = (model: AiModelOption) => runTest({ id: model.id })

const fetchRemoteModels = async () => {
  // 模型列表由服务端代理拉取，输入框仍保留手动填写能力。
  if (!validateRemoteModelFetch()) return
  remoteModelLoading.value = true
  remoteModelPanelVisible.value = false
  try {
    const { data } = await listUserAiRemoteModelsApi(buildRemoteModelPayload())
    remoteModels.value = data?.models || []
    remoteModelPanelVisible.value = remoteModels.value.length > 0
    if (remoteModels.value.length) {
      ElMessage.success(`已拉取 ${remoteModels.value.length} 个模型`)
    } else {
      ElMessage.info('未拉取到模型列表')
    }
  } catch (error) {
    showApiError(error, '拉取模型列表失败')
  } finally {
    remoteModelLoading.value = false
  }
}

const selectRemoteModel = (code: string) => {
  form.modelCode = code
  remoteModelPanelVisible.value = false
}

const showRemoteModelPanel = () => {
  remoteModelPanelVisible.value = remoteModels.value.length > 0
}

const closeRemoteModelPanelOnOutside = (event: MouseEvent) => {
  if (!remoteModelPanelVisible.value) return
  const target = event.target as Node | null
  if (target && modelCodeFieldRef.value?.contains(target)) return
  // 点击字段外部时收起浮层，避免遮挡后续表单。
  remoteModelPanelVisible.value = false
}

const editModel = (model: AiModelOption) => {
  resetCurrentTest()
  advancedOpen.value = []
  editingId.value = model.id
  form.name = model.name || ''
  form.scene = model.scene === 'image' ? 'image' : 'text'
  form.provider = model.provider || 'custom'
  form.protocol = 'openai_compatible'
  form.modelCode = model.modelCode || ''
  form.baseUrl = model.baseUrl || ''
  form.apiKey = ''
  form.maxContext = Number(model.maxContext || 4096)
  form.maxOutputTokens = Number(model.maxOutputTokens || 8192)
  form.thinking = model.thinking || 'default'
  form.extraParams = model.extraParams || ''
  form.testWaitSeconds = model.testWaitSeconds
  form.status = model.status === 0 ? 0 : 1
  resetCurrentTest()
  clearRemoteModels()
  composerOpen.value = true
}

const toggleStatus = async (model: AiModelOption) => {
  if (togglingRowId.value === model.id) return
  togglingRowId.value = model.id
  try {
    await setUserAiModelStatusApi(model.id, model.status === 1 ? 0 : 1)
    ElMessage.success(model.status === 1 ? '已禁用' : '已启用')
    await refreshModels()
  } catch (error) {
    showApiError(error, '状态更新失败')
  } finally {
    togglingRowId.value = null
  }
}

const deleteModel = async (model: AiModelOption) => {
  try {
    await inkConfirm(`确定删除「${model.name}」吗？`, '删除模型', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    cancelTest(model.id)
    tests.delete(testKey(model.id))
    await deleteUserAiModelApi(model.id)
    ElMessage.success('模型已删除')
    if (editingId.value === model.id) closeComposer()
    await refreshModels()
  } catch (error) {
    showApiError(error, '删除模型失败')
  }
}

const resetForm = () => {
  resetCurrentTest()
  advancedOpen.value = []
  editingId.value = null
  form.name = ''
  form.scene = 'text'
  form.provider = DEFAULT_PRESET.provider
  form.protocol = 'openai_compatible'
  form.modelCode = ''
  form.baseUrl = DEFAULT_PRESET.baseUrl
  form.apiKey = ''
  form.maxContext = DEFAULT_PRESET.maxContext
  form.maxOutputTokens = DEFAULT_PRESET.maxOutputTokens
  form.status = 1
  form.sort = 0
  form.thinking = DEFAULT_PRESET.thinking
  form.extraParams = ''
  form.testWaitSeconds = undefined
  resetCurrentTest()
  clearRemoteModels()
}

const buildPayload = (): UserAiModelSavePayload => ({
  id: editingId.value || undefined,
  name: form.name.trim(),
  scene: form.scene,
  provider: form.provider,
  protocol: 'openai_compatible',
  modelCode: form.modelCode.trim(),
  baseUrl: form.baseUrl.trim(),
  apiKey: form.apiKey?.trim() || undefined,
  maxContext: Number(form.maxContext || 4096),
  maxOutputTokens: Number(form.maxOutputTokens || 8192),
  status: form.status,
  sort: Number(form.sort || 0),
  thinking: form.thinking || 'default',
  extraParams: form.extraParams?.trim() || '',
  testWaitSeconds: form.testWaitSeconds,
})

watch(() => [form.provider, form.baseUrl, form.modelCode, form.apiKey, form.scene, form.thinking, form.extraParams, form.maxOutputTokens, form.testWaitSeconds], () => {
  if (!composerOpen.value) return
  const running = testingCurrent.value
  resetCurrentTest()
  if (running) ElMessage.info('配置已修改，旧测试已取消')
})

const buildRemoteModelPayload = (): Partial<UserAiModelSavePayload> => ({
  id: editingId.value || undefined,
  scene: form.scene,
  provider: form.provider,
  protocol: 'openai_compatible',
  modelCode: form.modelCode.trim(),
  baseUrl: form.baseUrl.trim(),
  apiKey: form.apiKey?.trim() || undefined,
  maxContext: Number(form.maxContext || 4096),
  maxOutputTokens: Number(form.maxOutputTokens || 8192),
  status: form.status,
  sort: Number(form.sort || 0),
})

const validateRemoteModelFetch = () => {
  if (!form.baseUrl.trim()) {
    ElMessage.warning('请填写 Base URL')
    return false
  }
  if (
    !Number.isInteger(Number(form.maxOutputTokens)) ||
    Number(form.maxOutputTokens) < 128 ||
    Number(form.maxOutputTokens) > Number(form.maxContext)
  ) {
    ElMessage.warning('最大输出 Tokens 必须为 128 到最大上下文之间的整数')
    return false
  }
  // 本地部署（Ollama/LM Studio 等）没有 Key，允许留空拉取；请求层留空就不带鉴权头
  return true
}

const clearRemoteModels = () => {
  remoteModels.value = []
  remoteModelPanelVisible.value = false
}

const validateForm = () => {
  if (!form.name.trim()) {
    ElMessage.warning('请填写模型名称')
    return false
  }
  if (!form.modelCode.trim()) {
    ElMessage.warning('请填写模型代码')
    return false
  }
  if (!form.baseUrl.trim()) {
    ElMessage.warning('请填写 Base URL')
    return false
  }
  if (
    !Number.isInteger(Number(form.maxOutputTokens)) ||
    Number(form.maxOutputTokens) < 128 ||
    Number(form.maxOutputTokens) > Number(form.maxContext)
  ) {
    ElMessage.warning('最大输出 Tokens 必须为 128 到最大上下文之间的整数')
    return false
  }
  if (form.extraParams?.trim()) {
    try {
      const parsed: unknown = JSON.parse(form.extraParams)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    } catch {
      ElMessage.warning('额外请求参数必须是 JSON 对象，例如 {"enable_thinking": false}')
      return false
    }
  }
  // 本地部署（Ollama/LM Studio 等）没有 Key，允许留空
  return true
}

const getProviderLabel = (provider?: string) => {
  return providerPresets.find(item => item.provider === provider)?.label || provider || '自定义'
}

const normalizeProvider = (provider?: string, code?: string) => {
  const raw = `${provider || ''} ${code || ''}`.toLowerCase()
  // claude/gemini 必须先于 openai 判断：provider 值 gemini_openai、代码 openai-gpt-*
  // 都含 "openai" 字样，顺序反了会全部套上 OpenAI 图标
  if (raw.includes('claude') || raw.includes('anthropic')) return 'claude'
  if (raw.includes('gemini')) return 'gemini_openai'
  if (raw.includes('grok') || raw.includes('xai')) return 'xai'
  if (raw.includes('deepseek')) return 'deepseek'
  if (raw.includes('openai') || raw.includes('gpt')) return 'openai'
  if (raw.includes('qwen') || raw.includes('tongyi') || raw.includes('aliyun')) return 'aliyun'
  if (raw.includes('doubao') || raw.includes('volc') || raw.includes('ark')) return 'volcengine'
  if (raw.includes('glm') || raw.includes('zhipu') || raw.includes('bigmodel')) return 'bigmodel'
  if (raw.includes('silicon')) return 'siliconflow'
  if (raw.includes('openrouter')) return 'openrouter'
  return provider || 'custom'
}

const getModelProviderIcon = (model?: AiModelOption | null) => {
  if (!model) return ''
  const provider = normalizeProvider(model.provider, `${model.name || ''} ${model.modelCode || model.code || ''}`)
  return providerPresets.find(item => item.provider === provider)?.iconSrc || ''
}

const getModelOptionLabel = (model: AiModelOption) => {
  const name = model.name || model.modelCode || model.code
  return model.ownerType === 'user' ? `${name} · 自定义` : name
}

/** 槽位前缀图标用的模型：没选时也显示自动/跟随到的那个，让"没选"不等于"没有" */
const getSelectedModel = (groupCode: AiModelGroupCode) => {
  const selectedCode = aiModelStore.effectiveModelCode(groupCode)
  if (!selectedCode) return null
  return slotModels(groupCode).find(item => item.code === selectedCode)
    || aiModelStore.textModels.find(item => item.code === selectedCode)
    || null
}

const getSelectedModelIcon = (groupCode: AiModelGroupCode) => {
  return getModelProviderIcon(getSelectedModel(groupCode))
}

const getTestLabel = (model: AiModelOption) => {
  const outcome = rowTest(model.id)?.result?.outcome || model.lastTestOutcome
  if (outcome === 'cancelled') return '已取消'
  if (outcome === 'timeout') return '等待超时'
  if (outcome === 'unverified') return '未验证'
  if (outcome === 'success') return '已回复'
  const status = model.testStatus
  if (status === 1) return '已连接'
  if (status === 2) return '失败'
  return '未测试'
}

const getTestClass = (model: AiModelOption) => {
  const outcome = rowTest(model.id)?.result?.outcome || model.lastTestOutcome
  if (outcome === 'cancelled') return 'info'
  if (outcome === 'timeout' || outcome === 'unverified') return 'warning'
  const status = model.testStatus
  if (status === 1) return 'success'
  if (status === 2) return 'danger'
  return 'info'
}
</script>

<style scoped lang="scss">
.ai-model-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ink-main);
}

.pane-head {
  h3 {
    margin: 0 0 8px;
    font-size: calc(18px * var(--ui-font-scale, 1));
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.7;
  }
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: 12px;
}

.provider-card,
.model-card {
  border: 1px solid var(--ui-border);
  background: var(--card-bg, var(--ui-glass-bg));
  box-shadow: var(--card-shadow, var(--ui-shadow));
  backdrop-filter: blur(12px);
}

.provider-card {
  position: relative;
  min-height: 84px;
  padding: 14px 38px 14px 14px;
  border-radius: 8px;
  color: var(--ink-main);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  overflow: hidden;
  transition: border-color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease;

  &::before {
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: var(--ink-accent);
    opacity: 0;
    content: '';
  }

  &:hover {
    border-color: var(--ink-accent);
    background: var(--card-bg-hover, var(--ui-glass-bg-hover));
    box-shadow: 0 12px 28px color-mix(in srgb, var(--ink-accent) 12%, transparent);
  }

  &.active {
    border-color: var(--ink-accent);
    background: linear-gradient(135deg, rgba(var(--ink-accent-rgb, 180, 100, 40), 0.08), transparent 56%), var(--card-bg-hover, var(--ui-glass-bg-hover));
    box-shadow: inset 0 0 0 1px var(--ink-accent), 0 12px 30px rgba(var(--ink-accent-rgb, 180, 100, 40), 0.14), var(--card-shadow, var(--ui-shadow));

    &::before {
      opacity: 1;
    }
  }
}

.provider-icon {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--input-bg) 82%, var(--bg-main) 18%);
  border: 1px solid color-mix(in srgb, var(--input-border) 72%, var(--bg-main) 28%);
  color: var(--ink-accent);
  font-size: calc(14px * var(--ui-font-scale, 1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-main) 72%, transparent);

  img {
    display: block;
    width: 34px;
    height: 34px;
    object-fit: contain;
  }

  &.is-custom {
    background: rgba(var(--ink-accent-rgb, 180, 100, 40), 0.1);
    border-color: rgba(var(--ink-accent-rgb, 180, 100, 40), 0.24);
  }
}

.provider-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }

  strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.35;
  }

  small {
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(11px * var(--ui-font-scale, 1));
    line-height: 1.45;
  }
}

.provider-check {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--ink-accent);
  color: var(--btn-primary-color, #fff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(10px * var(--ui-font-scale, 1));
  box-shadow: 0 6px 16px rgba(var(--ink-accent-rgb, 180, 100, 40), 0.24);
}

.model-card {
  border-radius: 8px;
  padding: 14px;
  min-width: 0;
}

.card-head,
.list-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;

  h4 {
    margin: 0 0 4px;
    font-size: calc(15px * var(--ui-font-scale, 1));
    line-height: 1.4;
  }

  p {
    margin: 0;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.6;
  }
}

.form-grid,
.default-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
  margin-top: 12px;
}

.default-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.model-select {
  width: 100%;

  :deep(.el-select__wrapper) {
    min-height: 36px;
    padding-left: 9px;
  }
}

.model-select-prefix,
.model-option-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--input-bg) 78%, var(--bg-main));
  border: 1px solid color-mix(in srgb, var(--input-border) 76%, transparent);
  color: var(--ink-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;

  img {
    display: block;
    width: 21px;
    height: 21px;
    object-fit: contain;
  }

  i {
    font-size: calc(13px * var(--ui-font-scale, 1));
  }
}

.model-select-option {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  line-height: 1;

  > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &.wide {
    grid-column: 1 / -1;
  }

  span {
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 600;
  }
}

.model-code-field {
  position: relative;
  z-index: 12;
}

.model-code-control {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.fetch-model-btn {
  min-width: 72px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: var(--settings-control-bg, var(--input-bg));
  color: var(--ink-accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;

  &:hover:not(:disabled) {
    border-color: var(--ink-accent);
    background: var(--settings-control-hover-bg, var(--input-focus-bg));
  }

  &:disabled {
    color: var(--settings-muted-color, var(--ink-sec));
    cursor: not-allowed;
  }
}

/* 模型列表使用浮层，避免撑开表单布局。 */
.remote-model-panel {
  position: absolute;
  z-index: 24;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  max-height: 178px;
  overflow: auto;
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--bg-main);
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14);

  button {
    min-width: 0;
    min-height: 28px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--ink-main);
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.45;
    text-align: left;
    overflow-wrap: anywhere;

    &:hover,
    &.active {
      border-color: var(--ink-accent);
      background: var(--nav-active-bg);
      color: var(--nav-active-color, var(--ink-main));
    }
  }
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;

  .el-button + .el-button { margin-left: 0; }
}

.row-actions .el-button + .el-button { margin-left: 0; }
.model-test-running { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--ink-sec); font-variant-numeric: tabular-nums; }
.model-table .test-warning { color: var(--state-warning-on); }
.model-test-advanced {
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  --el-collapse-border-color: var(--input-border);
  --el-collapse-header-text-color: var(--ink-main);
  --el-collapse-content-text-color: var(--ink-sec);
}
.model-test-wait { max-width: 360px; padding: 4px 0 0; }
.model-test-wait small { color: var(--ink-sec); line-height: 1.6; }
.model-test-reply { color: var(--ink-main); align-self: flex-start; }

.compact-btn {
  min-height: 30px;
  padding: 0 12px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

// 连接测试结果：弹窗底部一条状态条，耗时/时间/地址横着排在右侧
.test-result {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: center;

  &.success {
    border-color: var(--state-success-border);
    background: var(--state-success-surface);
    color: var(--state-success-on);
  }

  &.error {
    border-color: var(--state-danger-border);
    background: var(--state-danger-surface);
    color: var(--state-danger-on);
  }

  &.testing,
  &.warning {
    border-color: var(--state-warning-border);
    background: var(--state-warning-surface);
    color: var(--state-warning-on);
  }
}

.test-icon {
  width: 28px;
  height: 28px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  border-radius: 50%;
  border: 1px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.test-body {
  flex: 1 1 220px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  span {
    font-size: calc(12px * var(--ui-font-scale, 1));
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
}

.test-meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  font-size: calc(12px * var(--ui-font-scale, 1));

  div {
    display: flex;
    gap: 4px;
    min-width: 0;
  }

  dt,
  dd {
    margin: 0;
    line-height: 1.5;
    white-space: nowrap;
  }

  dt {
    opacity: 0.72;
  }

  dd {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .test-meta-url dd {
    max-width: 280px;
  }
}

.inline-head {
  align-items: center;
}

.list-toolbar {
  align-items: center;
}

.list-filters {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 110px auto;
  align-items: center;
  gap: 8px;
  width: min(540px, 60%);
}

.empty-state {
  margin-top: 12px;
  padding: 28px 12px;
  border-radius: 8px;
  border: 1px dashed var(--input-border);
  color: var(--settings-muted-color, var(--ink-sec));
  text-align: center;
  font-size: calc(13px * var(--ui-font-scale, 1));

  p {
    margin: 0 0 12px;
  }
}

.model-table-wrap {
  margin-top: 12px;
  overflow-x: auto;
}

.model-table {
  width: 100%;
  min-width: 820px;
  border-collapse: collapse;
  font-size: calc(12px * var(--ui-font-scale, 1));

  th,
  td {
    padding: 9px 8px;
    border-bottom: 1px solid var(--ui-border);
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--settings-muted-color, var(--ink-sec));
    font-weight: 600;
    white-space: nowrap;
  }

  td {
    color: var(--ink-main);
  }

  small {
    display: block;
    margin-top: 3px;
    color: var(--settings-muted-color, var(--ink-sec));
    font-size: calc(11px * var(--ui-font-scale, 1));
  }
}

.cell-title,
.mono-cell,
.url-cell {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-title {
  display: block;
}

.mono-cell {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.url-cell {
  max-width: 160px;
}

.url-cell .url-text,
.url-cell .error-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-text {
  color: var(--state-danger) !important;
  cursor: help;
}

.status-pill {
  min-width: 52px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--settings-muted-color, var(--ink-sec));
  white-space: nowrap;

  &.enabled,
  &.success {
    border-color: var(--state-success-border);
    background: var(--state-success-surface);
    color: var(--state-success-on);
  }

  &.disabled,
  &.error {
    border-color: var(--state-danger-border);
    background: var(--state-danger-surface);
    color: var(--state-danger-on);
  }
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  button {
    border: 0;
    background: transparent;
    color: var(--ink-accent);
    cursor: pointer;
    font-size: calc(12px * var(--ui-font-scale, 1));

    &:disabled {
      color: var(--settings-muted-color, var(--ink-sec));
      cursor: not-allowed;
    }

    &.danger {
      color: var(--state-danger);
    }
  }
}

:deep(.el-input__wrapper),
:deep(.el-select__wrapper) {
  min-height: 34px;
  border-radius: 7px;
  background: var(--input-bg);
  box-shadow: 0 0 0 1px var(--input-border) inset;
}

:deep(.el-input__wrapper.is-focus),
:deep(.el-select__wrapper.is-focused) {
  background: var(--input-focus-bg);
  box-shadow: 0 0 0 1px var(--input-focus-border) inset;
}

:deep(.el-input-number) {
  width: 100%;
}

// element-plus 的常规文字色被编译成固定灰（#57534e），暗夜下回显值和占位符几乎同色，
// 这里把已填内容拉到主题正文色、占位符压到弱化色，两者拉开层次
:deep(.el-input__inner),
:deep(.el-select__selected-item:not(.el-select__placeholder)),
:deep(.el-select__placeholder:not(.is-transparent)) {
  color: var(--ink-main);
}

:deep(.el-input__inner::placeholder),
:deep(.el-select__placeholder.is-transparent) {
  color: var(--ink-muted);
}

// textarea 不走 .el-input__wrapper，element-plus 默认给的是编译期固定的白底灰边，暗夜主题下会突兀
:deep(.el-textarea__inner) {
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--ink-main);
  box-shadow: 0 0 0 1px var(--input-border) inset;

  &::placeholder {
    color: var(--ink-muted);
  }

  &:hover {
    box-shadow: 0 0 0 1px var(--input-border) inset;
  }

  &:focus {
    background: var(--input-focus-bg);
    box-shadow: 0 0 0 1px var(--input-focus-border) inset;
  }
}

// 启用/禁用开关：element-plus 主色被编译成固定墨黑，暗夜主题下轨道和背景混成一团，改走主题变量
:deep(.el-switch) {
  --el-switch-on-color: var(--ink-accent);
  --el-switch-off-color: color-mix(in srgb, var(--ink-sec) 26%, var(--input-bg));
  --el-color-primary: var(--ink-accent);
  --el-text-color-primary: var(--ink-sec);
  height: 24px;
  line-height: calc(24px * var(--ui-font-scale, 1));
}

:deep(.el-switch__core) {
  min-width: 42px;
  height: 22px;
  border-radius: 999px;
}

:deep(.el-switch__action) {
  width: 18px;
  height: 18px;
  background-color: var(--on-inverse);
}

:deep(.el-switch__label) {
  color: var(--ink-sec);
}

:deep(.el-switch__label.is-active) {
  color: var(--ink-main);
}

// 列表里的状态开关：inline-prompt 把"启用/禁用"写进轨道，尺寸跟表格行高匹配
:deep(.row-status-switch) {
  height: 22px;
  line-height: calc(22px * var(--ui-font-scale, 1));

  .el-switch__core {
    min-width: 52px;
    height: 22px;
  }

  .el-switch__action {
    width: 18px;
    height: 18px;
  }

  .el-switch__inner {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }
}

:global(.ai-model-select-popper .el-select-dropdown__item) {
  // 两行选项（模型名 + 说明）需要自适应高度；上下留足内边距，说明文字不贴边
  height: auto;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 6px;
  line-height: 1.4;
  // 弹层底色是主题玻璃色，选项文字必须跟主题走，不能用 element-plus 浅色默认值
  color: var(--ink-sec);
}

:global(.ai-model-select-popper .el-select-dropdown__item + .el-select-dropdown__item) {
  margin-top: 2px;
}

:global(.ai-model-select-popper .model-option-copy) {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

:global(.ai-model-select-popper .model-option-name) {
  line-height: 1.3;
}

:global(.ai-model-select-popper .model-option-desc) {
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 1.35;
  opacity: 0.72;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global(.ai-model-select-popper .el-select-dropdown__item.is-selected) {
  color: var(--ink-accent);
  font-weight: 600;
  background: var(--selection-bg-color);
}

:global(.ai-model-select-popper) {
  border: 1px solid var(--ui-border) !important;
  border-radius: 8px !important;
  background: var(--ui-glass-bg) !important;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink-main) 20%, transparent) !important;
  backdrop-filter: blur(18px);
  overflow: hidden;
}

:global(.ai-model-select-popper .el-select-dropdown__list) {
  padding: 6px !important;
}

:global(.ai-model-select-popper .el-select-dropdown__item.hover),
:global(.ai-model-select-popper .el-select-dropdown__item:hover) {
  background: var(--nav-active-bg);
  color: var(--ink-accent);
}

:global(.ai-model-select-popper .model-select-option) {
  width: 100%;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

:global(.ai-model-select-popper .model-option-icon) {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--ink-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
}

:global(.ai-model-select-popper .model-option-icon img) {
  width: 21px;
  height: 21px;
  object-fit: contain;
}

:global(.ai-model-select-popper .el-popper__arrow::before) {
  background: var(--ui-glass-bg) !important;
  border-color: var(--ui-border) !important;
}

@media (max-width: 920px) {
  .provider-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .default-grid {
    grid-template-columns: 1fr;
  }

  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .list-filters {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .provider-grid {
    grid-template-columns: 1fr;
  }

  .provider-card {
    min-height: 72px;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .model-code-control {
    grid-template-columns: 1fr;
  }

  .fetch-model-btn {
    width: 100%;
  }
}

.key-local-hint {
  margin-left: 4px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 400;
  color: var(--ink-sec);
}

// 默认模型里"进阶"那一行的分组小字：横跨整行，隔开两组槽位但不折叠
.slot-group-caption {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--input-border);
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);

  span {
    font-weight: 600;
    color: var(--ink-main);
  }

  small {
    font-size: calc(11px * var(--ui-font-scale, 1));
  }
}

// 某用途一个模型都没有时，槽位位置放一行提示 + 添加入口，高度与下拉框对齐
.slot-empty-note {
  min-height: 36px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 0 10px;
  border: 1px dashed var(--input-border);
  border-radius: 6px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.5;

  i {
    margin-right: 4px;
    color: var(--ink-accent);
  }
}

.link-btn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-accent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;

  &:hover {
    opacity: 0.8;
  }
}

// 添加/编辑模型弹窗的内容：供应商、连接信息两段 + 测试状态条
.composer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 2px 0;

  // 弹窗里供应商卡片比页面上紧凑：13 家要在一屏内看全
  .provider-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }

  .provider-card {
    min-height: 60px;
    padding: 10px 28px 10px 10px;
    gap: 10px;
    box-shadow: none;
    backdrop-filter: none;
  }

  .provider-icon {
    width: 36px;
    height: 36px;

    img {
      width: 24px;
      height: 24px;
    }
  }

  .provider-info strong {
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  .provider-info small {
    font-size: calc(10px * var(--ui-font-scale, 1));
    line-height: 1.35;
  }

  .provider-check {
    top: 8px;
    right: 8px;
    width: 16px;
    height: 16px;
    font-size: calc(9px * var(--ui-font-scale, 1));
  }

  .form-grid {
    margin-top: 10px;
  }
}

.composer-section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;

  h5 {
    margin: 0;
    font-size: calc(13px * var(--ui-font-scale, 1));
    font-weight: 600;
    color: var(--ink-main);
  }

  p {
    margin: 0;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--settings-muted-color, var(--ink-sec));
  }
}

.composer-test-footer { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 12px; }

.composer-footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
