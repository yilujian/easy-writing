<template>
  <div class="pi-skills-page" aria-label="技能">
    <header class="pi-skills-head">
      <p>在输入框里输 <kbd>/</kbd> 选技能；Agent 也会按描述自己挑。</p>
      <div class="pi-skills-actions">
        <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="importFrom(false)">
          导入 SKILL.md
        </button>
        <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="importFrom(true)">
          导入文件夹
        </button>
        <button type="button" class="ink-btn ink-btn-primary ink-btn-sm" :disabled="busy" @click="openForm()">
          新建技能
        </button>
      </div>
    </header>
    <ul class="pi-skill-list" aria-label="技能列表">
      <li v-for="skill in store.skills" :key="skill.id" class="pi-skill-row" :class="{ 'is-off': !skill.enabled }">
        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
        <div class="pi-skill-text">
          <strong
            >{{ skillLabel(skill)
            }}<span v-for="tag in tags(skill)" :key="tag" class="pi-skill-tag">{{ tag }}</span></strong
          >
          <small>{{ skill.description }}</small>
        </div>
        <div class="pi-skill-controls">
          <button type="button" class="pi-text-link" :disabled="busy" @click="openForm(skill)">编辑</button>
          <button
            v-if="skill.source === 'custom' || skill.overridden"
            type="button"
            class="pi-text-link"
            :disabled="busy"
            @click="remove(skill)"
          >
            {{ skill.source === 'builtin' ? '恢复默认' : '删除' }}
          </button>
          <el-switch
            :model-value="skill.enabled"
            :aria-label="`${skill.enabled ? '停用' : '启用'} ${skillLabel(skill)}`"
            :disabled="busy"
            @update:model-value="toggle(skill, $event as boolean)"
          />
        </div>
      </li>
    </ul>
    <p v-if="!store.skills.length" class="pi-small-empty">还没有技能</p>

    <EwModal
      v-model:visible="form.visible"
      :title="form.id ? '编辑技能' : '新建技能'"
      width="640px"
      custom-class="pi-dialog"
      :close-on-click-modal="false"
      manage-focus
      @opened="nameInput?.focus()"
    >
      <form id="pi-skill-form" class="pi-form" @submit.prevent="submit">
        <label
          >名称<input
            ref="nameInput"
            v-model="form.displayName"
            class="ink-input"
            maxlength="60"
            aria-label="技能名称"
            :readonly="form.builtin"
            required
        /></label>
        <label
          >一句话说明什么时候用<input
            v-model="form.description"
            class="ink-input"
            maxlength="300"
            aria-label="技能描述"
            placeholder="例如：作者要打磨对白、让人物说话更像自己时用"
            required
        /></label>
        <label
          >给 Agent 的说明<textarea
            v-model="form.instructions"
            class="ink-input pi-skill-instructions"
            rows="12"
            aria-label="技能说明"
            placeholder="写清楚步骤、要读什么资料、按什么标准做、什么时候停"
            required
          ></textarea
        ></label>
        <label class="pi-skill-check"
          ><input v-model="form.manual" type="checkbox" /><span>只在我用 / 选中时使用，Agent 不自己挑</span></label
        >
        <p v-if="form.scripts.length" class="pi-skill-scripts">
          脚本：{{ form.scripts.join('、') }}
        </p>
      </form>
      <template #footer>
        <button type="button" class="ink-btn ink-btn-outline" @click="form.visible = false">取消</button>
        <button type="submit" form="pi-skill-form" class="ink-btn ink-btn-primary" :disabled="busy || !canSubmit">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </template>
    </EwModal>
  </div>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { usePiWorkspace } from './use-pi-workspace'
import { skillLabel } from '@/agent-pi/skills'
import type { PiSkill } from '@/types/agent-pi'

const store = usePiWorkspace()
const busy = ref(false)
const nameInput = ref<HTMLInputElement>()
const form = reactive({
  visible: false,
  id: '',
  builtin: false,
  name: '',
  displayName: '',
  description: '',
  instructions: '',
  manual: false,
  scripts: [] as string[]
})
const canSubmit = computed(() => !!form.displayName.trim() && !!form.description.trim() && !!form.instructions.trim())
const tags = (skill: PiSkill) =>
  [
    skill.source === 'builtin' ? (skill.overridden ? '内置 · 已改' : '内置') : '',
    skill.manual ? '手动' : '',
    skill.scripts.length ? `${skill.scripts.length} 个脚本` : ''
  ].filter(Boolean)
function openForm(skill?: PiSkill) {
  form.id = skill?.id || ''
  form.builtin = skill?.source === 'builtin'
  form.name = skill?.name || ''
  form.displayName = skill ? skillLabel(skill) : ''
  form.description = skill?.description || ''
  form.instructions = skill?.instructions || ''
  form.manual = skill?.manual || false
  form.scripts = skill?.scripts || []
  form.visible = true
}
async function run(task: () => Promise<unknown>, done?: string) {
  busy.value = true
  try {
    await task()
    if (done) ElMessage.success(done)
    return true
  } catch (error) {
    ElMessage.error(String(error instanceof Error ? error.message : error))
    return false
  } finally {
    busy.value = false
  }
}
async function submit() {
  if (!canSubmit.value) return
  const ok = await run(() =>
    store.saveSkill({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim() || form.displayName.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      manual: form.manual
    })
  )
  if (ok) form.visible = false
}
async function remove(skill: PiSkill) {
  try {
    await inkConfirm(
      skill.source === 'builtin' ? `把「${skillLabel(skill)}」恢复成内置的默认说明？你改过的内容会丢掉。` : `删除技能「${skillLabel(skill)}」？它的脚本和参考文件会一起删除。`,
      skill.source === 'builtin' ? '恢复默认' : '删除技能',
      { confirmButtonText: skill.source === 'builtin' ? '恢复默认' : '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await run(() => store.deleteSkill(skill.id))
}
const toggle = (skill: PiSkill, enabled: boolean) => run(() => store.toggleSkill(skill.id, enabled))
/** 选一个 SKILL.md 或包含它的文件夹，复制进作者技能目录。 */
async function importFrom(directory: boolean) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open(
    directory
      ? { title: '选择技能文件夹', directory: true, multiple: false }
      : { title: '选择 SKILL.md', directory: false, multiple: false, filters: [{ name: 'SKILL.md', extensions: ['md'] }] }
  )
  if (typeof selected !== 'string' || !selected) return
  await run(async () => {
    const imported = await store.importSkill(selected)
    return imported
  }, '技能已导入')
}
</script>
