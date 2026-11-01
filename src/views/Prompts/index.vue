<template>
  <section class="prompts-page">
    <header class="prompts-header">
      <div class="prompts-title">
        <h1>提示词管理</h1>
        <p>
          全部 AI 提示词以 md 文件存在本地{{ desktopSupported ? '（文稿/易创提示词 目录）' : '' }}。
          在这里改和直接改 md 文件是同一份内容：界面保存立即生效并写回文件；直接改文件的话，重启应用后生效。
          {{ varExample }} 是程序运行时代入的内容，请保留。
        </p>
        <div v-if="desktopSupported" class="dir-row">
          <span class="dir-path">{{ promptDir || '…' }}</span>
          <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" @click="handleOpenDir">
            <i class="fa-regular fa-folder-open"></i> 打开文件夹
          </button>
        </div>
      </div>
    </header>

    <section v-for="group in groupedFiles" :key="group.title" class="prompt-group fusion-card">
      <div class="prompt-group-title">
        <i class="fa-solid fa-layer-group"></i>
        <strong>{{ group.title }}</strong>
      </div>
      <div class="prompt-file-list">
        <div v-for="def in group.files" :key="def.id" class="prompt-file">
          <button class="prompt-file-head" type="button" @click="toggleFile(def.id)">
            <span class="prompt-file-name">
              {{ def.name }}
              <em v-if="modifiedIds.has(def.id)" class="prompt-modified-badge">已修改</em>
              <em v-if="updatedSlots[def.id]?.length" class="prompt-updated-badge">默认值已更新</em>
            </span>
            <span class="prompt-file-desc">{{ def.description }}</span>
            <i class="fa-solid" :class="expandedId === def.id ? 'fa-angle-up' : 'fa-angle-down'"></i>
          </button>

          <div v-if="expandedId === def.id" class="prompt-file-body">
            <div v-for="slot in def.slots" :key="slot.key" class="prompt-slot">
              <div class="prompt-slot-head">
                <span class="prompt-slot-label">{{ slot.label }}</span>
                <button
                  v-if="updatedSlots[def.id]?.includes(slot.key)"
                  class="prompt-slot-updated"
                  type="button"
                  title="这一段是你改过的版本；内置默认值随新版本更新了，点击对比"
                  @click="openEditor(def, slot, true)"
                >
                  <i class="fa-solid fa-circle-up"></i> 默认值已更新，对比新版
                </button>
                <span v-if="slot.variables?.length" class="prompt-slot-vars">
                  变量：<code v-for="name in slot.variables" :key="name">{{ wrapVar(name) }}</code>
                </span>
                <div
                  v-if="slot.defaultTemperature !== undefined"
                  class="prompt-slot-temp"
                  title="模型采样温度（0-2）：越低越稳、越高越发散"
                >
                  <span>温度</span>
                  <el-slider
                    v-model="draftTemps[slot.key]"
                    :min="0"
                    :max="2"
                    :step="0.05"
                    :show-tooltip="false"
                    @change="handleTempChange(def)"
                  />
                  <strong>{{ formatTemp(draftTemps[slot.key]) }}</strong>
                </div>
              </div>
              <button class="prompt-slot-preview" type="button" @click="openEditor(def, slot)">
                <span class="prompt-slot-preview-text" :class="{ 'is-empty': !draftSlots[slot.key] }">
                  {{ draftSlots[slot.key] || '（空）点击填写' }}
                </span>
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
            </div>
            <div class="prompt-file-actions">
              <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" :disabled="saving" @click="handleReset(def)">
                恢复默认
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="prompt-group fusion-card">
      <div class="prompt-group-title">
        <i class="fa-solid fa-puzzle-piece"></i>
        <strong>网文技能</strong>
      </div>
      <div class="prompt-file-list">
        <div class="prompt-file">
          <button class="prompt-file-head" type="button" @click="openPiSkills">
            <span class="prompt-file-name">Agent 创作技能</span>
            <span class="prompt-file-desc">
              在 Agent 的技能页查看建书策划、小说写作等内置方法，或管理自己的写作技能。
            </span>
            <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>
      </div>
    </section>

    <EwModal
      v-model:visible="editorVisible"
      :title="editorTitle"
      width="min(860px, 92vw)"
      :close-on-click-modal="false"
    >
      <div class="prompt-editor-body">
        <p v-if="editorSlot?.variables?.length" class="prompt-editor-vars">
          变量：<code v-for="name in editorSlot.variables" :key="name">{{ wrapVar(name) }}</code>
          <span>程序运行时代入，请保留。</span>
        </p>
        <div class="prompt-editor-panes" :class="{ 'is-compare': editorCompare }">
          <div class="prompt-editor-pane">
            <div v-if="editorCompare" class="prompt-editor-pane-title">你的版本</div>
            <textarea v-model="editorText" class="prompt-editor-input" spellcheck="false"></textarea>
          </div>
          <div v-if="editorCompare" class="prompt-editor-pane">
            <div class="prompt-editor-pane-title">
              新版默认值
              <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" @click="adoptDefault">用新版替换左侧</button>
            </div>
            <pre class="prompt-editor-default">{{ editorSlot?.defaultText }}</pre>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="ink-btn ink-btn-outline" type="button" @click="editorVisible = false">取消</button>
        <button class="ink-btn ink-btn-primary" type="button" :disabled="saving" @click="handleEditorSave">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </template>
    </EwModal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import { inkConfirm } from '@/utils/ink-confirm'
import { PROMPT_FILE_DEFS, type PromptFileDef, type PromptSlotDef } from '@/config/prompts'
import {
  getLocalPromptSlots,
  getLocalPromptTemps,
  getPromptDefaultUpdates,
  getPromptDirPath,
  isPromptFileModified,
  openPromptDir,
  resetLocalPromptFile,
  saveLocalPromptFile,
} from '@/storage/local-prompts'
import { isTauriRuntime } from '@/storage'

const desktopSupported = isTauriRuntime()
const router = useRouter()
async function openPiSkills() {
  const { usePiWorkspace } = await import('@/views/AgentPi/use-pi-workspace')
  usePiWorkspace().view = 'skills'
  await router.push('/agent-pi')
}
const promptDir = ref('')
const expandedId = ref('')
const saving = ref(false)
const draftSlots = reactive<Record<string, string>>({})
const draftTemps = reactive<Record<string, number>>({})
const modifiedIds = ref(new Set<string>())
/** 文件 id → 用户改过、但内置默认值之后更新了的槽 key */
const updatedSlots = ref<Record<string, string[]>>({})

const editorVisible = ref(false)
const editorDef = ref<PromptFileDef | null>(null)
const editorSlot = ref<PromptSlotDef | null>(null)
const editorText = ref('')
/** 对比模式：右侧并排显示新版默认值 */
const editorCompare = ref(false)
const editorTitle = computed(() =>
  editorDef.value && editorSlot.value ? `${editorDef.value.name} · ${editorSlot.value.label}` : ''
)

const groupedFiles = computed(() => {
  const groups: Array<{ title: string; files: PromptFileDef[] }> = []
  for (const def of PROMPT_FILE_DEFS) {
    const group = groups.find(item => item.title === def.group)
    if (group) group.files.push(def)
    else groups.push({ title: def.group, files: [def] })
  }
  return groups
})

// 模板字面量里写不了裸的双花括号（会被 Vue 当插值），从脚本出
const wrapVar = (name: string) => `{{${name}}}`
const varExample = wrapVar('变量')

const formatTemp = (value?: number) =>
  typeof value === 'number' ? String(Math.round(value * 100) / 100) : ''

const refreshModified = () => {
  modifiedIds.value = new Set(PROMPT_FILE_DEFS.filter(def => isPromptFileModified(def.id)).map(def => def.id))
  const updated: Record<string, string[]> = {}
  for (const def of PROMPT_FILE_DEFS) {
    const keys = getPromptDefaultUpdates(def.id)
    if (keys.length) updated[def.id] = keys
  }
  updatedSlots.value = updated
}

const loadDrafts = (fileId: string) => {
  const slots = getLocalPromptSlots(fileId)
  for (const key of Object.keys(draftSlots)) delete draftSlots[key]
  Object.assign(draftSlots, slots)
  const temps = getLocalPromptTemps(fileId)
  for (const key of Object.keys(draftTemps)) delete draftTemps[key]
  Object.assign(draftTemps, temps)
}

const toggleFile = (fileId: string) => {
  if (expandedId.value === fileId) {
    expandedId.value = ''
    return
  }
  expandedId.value = fileId
  loadDrafts(fileId)
}

const persistFile = async (def: PromptFileDef, message: string) => {
  if (saving.value) return
  saving.value = true
  try {
    await saveLocalPromptFile(def.id, { ...draftSlots }, { ...draftTemps })
    refreshModified()
    ElMessage({ message, type: 'success', grouping: true })
  } catch (error) {
    ElMessage.error(String(error?.message || '保存失败，请稍后重试'))
  } finally {
    saving.value = false
  }
}

const handleTempChange = (def: PromptFileDef) => {
  void persistFile(def, `「${def.name}」温度已保存，立即生效`)
}

const openEditor = (def: PromptFileDef, slot: PromptSlotDef, compare = false) => {
  editorDef.value = def
  editorSlot.value = slot
  editorText.value = draftSlots[slot.key] || ''
  editorCompare.value = compare
  editorVisible.value = true
}

/** 对比模式里一键采用新版默认值；保存后这一段就跟回默认，提示自动消失 */
const adoptDefault = () => {
  if (editorSlot.value) editorText.value = editorSlot.value.defaultText
}

const handleEditorSave = async () => {
  const def = editorDef.value
  const slot = editorSlot.value
  if (!def || !slot) return
  draftSlots[slot.key] = editorText.value
  await persistFile(def, `「${def.name} · ${slot.label}」已保存，立即生效`)
  editorVisible.value = false
}

const handleReset = async (def: PromptFileDef) => {
  try {
    await inkConfirm(`「${def.name}」的全部提示词将恢复为内置默认值。`, '恢复默认', {
      confirmButtonText: '恢复默认',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  saving.value = true
  try {
    await resetLocalPromptFile(def.id)
    loadDrafts(def.id)
    refreshModified()
    ElMessage.success(`「${def.name}」已恢复默认`)
  } catch (error) {
    ElMessage.error(String(error?.message || '恢复失败，请稍后重试'))
  } finally {
    saving.value = false
  }
}

const handleOpenDir = async () => {
  try {
    await openPromptDir()
  } catch (error) {
    ElMessage.error(String(error?.message || '打开文件夹失败'))
  }
}

onMounted(() => {
  refreshModified()
  if (desktopSupported) {
    void getPromptDirPath().then(dir => {
      promptDir.value = dir
    }).catch(() => undefined)
  }
})
</script>

<style scoped lang="scss">
.prompts-page {
  min-height: 100%;
  padding: 22px 28px 36px;
  color: var(--ink-main);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.prompts-header {
  .prompts-title {
    h1 {
      font-size: calc(22px * var(--ui-font-scale, 1));
      font-weight: 700;
      margin: 0 0 8px;
    }

    p {
      margin: 0;
      font-size: calc(13px * var(--ui-font-scale, 1));
      line-height: 1.8;
      color: var(--ink-sec);
      max-width: 860px;
    }
  }
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;

  .dir-path {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    word-break: break-all;
  }
}

.prompt-group {
  padding: 16px 18px;
  border-radius: 10px;
}

.prompt-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(15px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  margin-bottom: 12px;

  i {
    color: var(--ink-accent);
  }
}

.prompt-file-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-file {
  border: 1px solid var(--btn-ghost-border);
  border-radius: 8px;
  overflow: hidden;
}

.prompt-file-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;

  &:hover {
    background: var(--bg-hover);
  }

  .prompt-file-name {
    font-weight: 600;
    color: var(--ink-main);
    white-space: nowrap;
  }

  .prompt-modified-badge,
  .prompt-updated-badge {
    font-style: normal;
    font-size: calc(11px * var(--ui-font-scale, 1));
    color: var(--ink-accent);
    margin-left: 6px;
  }

  .prompt-updated-badge {
    color: var(--state-warning, var(--ink-accent));
  }

  .prompt-file-desc {
    flex: 1;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  i {
    color: var(--ink-sec);
  }
}

.prompt-file-body {
  padding: 4px 12px 12px;
  border-top: 1px solid var(--btn-ghost-border);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

html[data-ui-enlarged] .prompt-file-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 10px;
  .prompt-file-name { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
  .prompt-file-desc { grid-column: 1 / -1; grid-row: 2; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
  > i { grid-column: 2; grid-row: 1; }
}

.prompt-slot-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 6px;

  .prompt-slot-label {
    font-size: calc(13px * var(--ui-font-scale, 1));
    font-weight: 600;
    color: var(--ink-main);
  }

  .prompt-slot-updated {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border: 1px solid var(--state-warning, var(--ink-accent));
    border-radius: 999px;
    background: transparent;
    color: var(--state-warning, var(--ink-accent));
    font-size: calc(11px * var(--ui-font-scale, 1));
    cursor: pointer;

    &:hover {
      background: var(--bg-hover);
    }
  }

  .prompt-slot-temp {
    margin-left: auto;
    display: grid;
    grid-template-columns: auto 150px 34px;
    align-items: center;
    gap: 10px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);

    strong {
      font-size: calc(12px * var(--ui-font-scale, 1));
      color: var(--ink-main);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    :deep(.el-slider) {
      --el-slider-height: 4px;
      --el-slider-button-size: 14px;
    }
  }

  .prompt-slot-vars {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);

    code {
      margin-right: 4px;
      padding: 0 4px;
      border-radius: 4px;
      background: var(--surface-2);
    }
  }
}

.prompt-slot-preview {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--btn-ghost-border);
  border-radius: 6px;
  background: var(--surface-1);
  cursor: pointer;
  text-align: left;

  &:hover {
    border-color: var(--ink-accent);

    i {
      color: var(--ink-accent);
    }
  }

  .prompt-slot-preview-text {
    flex: 1;
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.7;
    color: var(--ink-main);
    white-space: pre-wrap;
    word-break: break-word;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;

    &.is-empty {
      color: var(--ink-sec);
    }
  }

  i {
    margin-top: 3px;
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    flex-shrink: 0;
  }
}

.prompt-file-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.prompt-editor-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-editor-vars {
  margin: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);

  code {
    margin-right: 4px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--surface-2);
  }

  span {
    margin-left: 6px;
  }
}

.prompt-editor-panes {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;

  &.is-compare {
    grid-template-columns: 1fr 1fr;
  }
}

.prompt-editor-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.prompt-editor-pane-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;
  color: var(--ink-sec);
}

.prompt-editor-default {
  margin: 0;
  height: 56vh;
  overflow: auto;
  padding: 10px 12px;
  border: 1px dashed var(--btn-ghost-border);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.8;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt-editor-input {
  width: 100%;
  height: 56vh;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--btn-ghost-border);
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.8;
  font-family: inherit;

  &:focus {
    outline: none;
    border-color: var(--ink-accent);
  }
}
</style>
