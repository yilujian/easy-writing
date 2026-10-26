<template>
  <div class="ac-form ac-skill-editor">
    <label
      >技能名称<el-input
        :model-value="draft.name"
        @update:model-value="(value: string) => change('name', value)"
        aria-label="技能名称"
        :maxlength="80"
        :disabled="readonly"
    /></label>
    <label
      >用途说明<el-input
        :model-value="draft.description"
        @update:model-value="(value: string) => change('description', value)"
        aria-label="用途说明"
        :maxlength="1000"
        :disabled="readonly"
    /></label>
    <div class="ac-skill-editor-meta">
      <label
        >技能类型<el-select
          :model-value="draft.kind"
          @update:model-value="(value: AgentSkillDraft['kind']) => change('kind', value)"
          clearable
          aria-label="技能类型"
          placeholder="辅助技能（未分类）"
          class="ink-select"
          popper-class="ink-select-popper"
          :disabled="readonly"
        >
          <el-option label="写作方法" value="method" /><el-option label="文风" value="style" /><el-option
            label="检查"
            value="check"
          /><el-option label="工具流程" value="tool" /> </el-select
      ></label>
      <label v-if="draft.kind === 'method'"
        >替换方法编号<el-input
          :model-value="draft.replaces"
          @update:model-value="(value: string) => change('replaces', value)"
          placeholder="如 chapter-writing；留空作为辅助方法"
          aria-label="替换方法编号"
          :disabled="readonly"
      /></label>
    </div>
    <label
      >技能说明<el-input
        :model-value="draft.instructions"
        @update:model-value="(value: string) => change('instructions', value)"
        type="textarea"
        :rows="9"
        :maxlength="50000"
        aria-label="技能说明"
        :disabled="readonly"
    /></label>
    <p v-if="missingScripts.length" class="ac-skill-error" role="status">
      说明引用的脚本尚未添加：{{ missingScripts.join('、') }}。请在下方导入，或修改说明。
    </p>
    <details class="ac-skill-editor-files" :open="draft.files.length > 0">
      <summary>
        参考资料与脚本
        <span class="ac-muted">{{ scriptCount ? `${scriptCount} 个 Python 脚本` : '纯说明技能' }}</span>
      </summary>
      <div class="ac-actions">
        <button
          type="button"
          class="ac-button ink-btn ink-btn-outline"
          :disabled="readonly"
          @click="addScript"
        >
          新增脚本
        </button>
        <button
          type="button"
          class="ac-button ink-btn ink-btn-outline"
          :disabled="readonly"
          @click="fileInput?.click()"
        >
          导入文件
        </button>
        <button
          type="button"
          class="ac-button ink-btn ink-btn-outline"
          :disabled="readonly || hasRequirements"
          @click="addRequirements"
        >
          添加依赖清单
        </button>
      </div>
      <p v-if="!draft.files.length" class="ac-muted ac-form-note">
        写法放在技能说明；分析依据可导入 references/ 下的参考资料，需要计算时再添加脚本。
      </p>
      <p v-else-if="scriptCount" class="ac-muted ac-form-note">
        脚本从标准输入读取 JSON，将结果 JSON 输出到标准输出；请在技能说明中写明输入字段和用途。
      </p>
      <p v-else class="ac-muted ac-form-note">参考资料按需读取；写作必须遵守的要点请保留在技能说明中。</p>
      <div v-if="draft.files.length" class="ac-skill-file-editor">
        <div class="ac-skill-file-tabs" role="group" aria-label="待保存文件">
          <button
            v-for="(file, index) in draft.files"
            :key="index"
            type="button"
            :aria-pressed="activeFile === index"
            :class="{ active: activeFile === index }"
            @click="activeFile = index"
          >
            {{ file.path || '未命名文件' }}
          </button>
        </div>
        <template v-if="currentFile">
          <div class="ac-skill-file-toolbar">
            <label
              >文件路径<el-input
                :model-value="currentFile.path"
                @update:model-value="(value: string) => changeFile('path', value)"
                aria-label="文件路径"
                :disabled="readonly"
            /></label>
            <button type="button" class="ac-text-link" :disabled="readonly" @click="removeFile">
              移除此文件
            </button>
          </div>
          <el-input
            :model-value="currentFile.content"
            @update:model-value="(value: string) => changeFile('content', value)"
            class="ac-skill-source-input"
            type="textarea"
            :rows="12"
            spellcheck="false"
            aria-label="文件内容"
            :disabled="readonly"
          />
        </template>
      </div>
      <p v-if="preservedFiles.length" class="ac-muted ac-form-note">
        其余资源文件保持原样：{{ preservedFiles.join('、') }}
      </p>
    </details>

    <input
      ref="fileInput"
      type="file"
      accept=".py,.txt,.json,.md,.csv,.toml,.yaml,.yml"
      multiple
      hidden
      @change="importFiles"
    />
    <p v-if="error" class="ac-skill-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentSkillDraft } from '@/types/agent-creation'
const props = withDefaults(
  defineProps<{ modelValue: AgentSkillDraft; readonly?: boolean; preservedFiles?: string[] }>(),
  { preservedFiles: () => [] }
)
const emit = defineEmits<{ 'update:modelValue': [value: AgentSkillDraft] }>()
const draft = computed(() => props.modelValue)
const activeFile = ref(0)
const fileInput = ref<HTMLInputElement>()
const error = ref('')
const currentFile = computed(() => draft.value.files[activeFile.value])
const scriptCount = computed(() => draft.value.files.filter(file => file.path.endsWith('.py')).length)
const missingScripts = computed(() =>
  [...new Set(draft.value.instructions.match(/scripts\/[A-Za-z0-9_./-]+\.py\b/g) || [])].filter(
    path => !draft.value.files.some(file => file.path === path)
  )
)
const hasRequirements = computed(() =>
  draft.value.files.some(file => /(^|\/)requirements\.txt$/.test(file.path))
)
watch(
  () => props.modelValue.id,
  () => {
    activeFile.value = 0
    error.value = ''
  }
)
watch(
  () => props.modelValue.files.length,
  length => {
    activeFile.value = Math.max(0, Math.min(activeFile.value, length - 1))
  }
)
function change<K extends keyof AgentSkillDraft>(key: K, value: AgentSkillDraft[K]) {
  if (props.readonly) return
  const next = { ...draft.value, [key]: value }
  next.kind ||= null
  if (next.kind !== 'method' || !next.replaces) next.replaces = null
  emit('update:modelValue', next)
}
function changeFile(key: 'path' | 'content', value: string) {
  change(
    'files',
    draft.value.files.map((file, index) => (index === activeFile.value ? { ...file, [key]: value } : file))
  )
}
function addScript() {
  const names = new Set(draft.value.files.map(file => file.path))
  let suffix = 1
  while (names.has(`scripts/script_${suffix}.py`)) suffix++
  activeFile.value = draft.value.files.length
  change('files', [...draft.value.files, { path: `scripts/script_${suffix}.py`, content: '' }])
}
function addRequirements() {
  activeFile.value = draft.value.files.length
  change('files', [...draft.value.files, { path: 'requirements.txt', content: '' }])
}
function removeFile() {
  change(
    'files',
    draft.value.files.filter((_, index) => index !== activeFile.value)
  )
  activeFile.value = Math.max(0, Math.min(activeFile.value, draft.value.files.length - 1))
}
async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  try {
    const incoming = []
    const names = new Set(draft.value.files.map(file => file.path.toLowerCase()))
    for (const file of files) {
      if (file.size > 256 * 1024) throw new Error(`${file.name} 超过 256 KB`)
      const path =
        file.name === 'requirements.txt'
          ? file.name
          : `${file.name.endsWith('.md') ? 'references' : 'scripts'}/${file.name}`
      if (names.has(path.toLowerCase())) throw new Error(`${path} 已存在，请编辑现有文件或改名后导入`)
      names.add(path.toLowerCase())
      incoming.push({
        path,
        content: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      })
    }
    activeFile.value = draft.value.files.length + incoming.length - 1
    change('files', [...draft.value.files, ...incoming])
    error.value = ''
  } catch (cause) {
    error.value = String(cause)
  }
}
</script>
