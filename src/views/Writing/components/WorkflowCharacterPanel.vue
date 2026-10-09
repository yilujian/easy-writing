<template>
  <section class="workflow-asset-panel" aria-label="角色管理">
    <div class="asset-toolbar">
      <el-input
        v-model="searchText"
        class="ink-select"
        clearable
        :disabled="loading"
        placeholder="搜索角色姓名、别名或标签"
      >
        <template #prefix>
          <i class="fa-solid fa-magnifying-glass"></i>
        </template>
      </el-input>
      <button
        type="button"
        class="ink-btn ink-btn-accent ink-btn-sm asset-create-button"
        :disabled="interactionDisabled"
        @click="beginCreate"
      >
        <i class="fa-solid fa-plus"></i>
        新增角色
      </button>
    </div>

    <div class="asset-list-shell">
      <template v-if="loading">
        <el-skeleton :rows="3" animated />
      </template>
      <div v-else-if="loadError" class="asset-state is-error">
        <i class="fa-solid fa-circle-exclamation"></i>
        <span>{{ loadError }}</span>
        <button type="button" class="ink-btn ink-btn-ghost ink-btn-sm" @click="loadCharacters()">
          重新加载
        </button>
      </div>
      <div v-else-if="!filteredCharacters.length" class="asset-state">
        <i class="fa-regular fa-user"></i>
        <span>{{ characters.length ? '没有匹配的角色' : '还没有角色，新增后将从下一章参与生成' }}</span>
      </div>
      <div v-else class="asset-list custom-scroll">
        <div
          v-for="character in filteredCharacters"
          :key="character.id"
          class="asset-row"
          :class="{ active: !creating && selectedCharacterId === character.id }"
        >
          <button
            class="asset-row-main"
            type="button"
            :disabled="interactionDisabled"
            @click="selectCharacter(character)"
          >
            <span class="asset-avatar">{{ character.name.slice(0, 1) }}</span>
            <span class="asset-row-copy">
              <strong>{{ character.name }}</strong>
              <small>{{ character.tags?.join(' · ') || roleLabel(character.role) }}</small>
            </span>
            <span class="asset-kind">{{ roleLabel(character.role) }}</span>
          </button>
          <button
            type="button"
            class="asset-delete-button"
            :disabled="interactionDisabled && deletingCharacterId !== character.id"
            :aria-label="`删除角色${character.name}`"
            @click.stop="deleteCharacter(character)"
          >
            <i :class="deletingCharacterId === character.id ? 'fa-solid fa-spinner fa-spin' : 'fa-regular fa-trash-can'"></i>
          </button>
        </div>
      </div>
    </div>

    <div class="asset-divider"></div>

    <div v-if="formVisible" class="asset-detail">
      <div class="asset-detail-head">
        <div>
          <strong>{{ creating ? '新增角色' : '角色信息' }}</strong>
          <span>保存后从下一章起参与生成</span>
        </div>
        <span v-if="dirty" class="asset-dirty">待保存</span>
      </div>

      <div class="asset-form custom-scroll">
        <label class="form-field">
          <span>姓名</span>
          <el-input
            v-model="form.name"
            class="ink-select"
            maxlength="100"
            :disabled="formDisabled"
            placeholder="输入角色姓名"
          />
        </label>

        <label class="form-field">
          <span>别名</span>
          <CharacterAliasesInput
            v-model="form.aliases" :name="form.name"
            :character-id="selectedCharacterId" :characters="characters" :disabled="formDisabled" />
        </label>

        <div class="form-grid">
          <label class="form-field">
            <span>角色定位</span>
            <el-select
              v-model="form.role"
              class="ink-select workflow-select"
              popper-class="ink-select-popper"
              :disabled="formDisabled"
              fit-input-width
            >
              <el-option v-for="option in roleOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </label>
          <label class="form-field">
            <span>性别</span>
            <el-select
              v-model="form.gender"
              class="ink-select workflow-select"
              popper-class="ink-select-popper"
              :disabled="formDisabled"
              fit-input-width
            >
              <el-option v-for="option in genderOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </label>
        </div>

        <label class="form-field">
          <span>年龄</span>
          <el-input
            v-model="form.age"
            class="ink-select"
            maxlength="50"
            :disabled="formDisabled"
            placeholder="例如：18岁"
          />
        </label>

        <label class="form-field">
          <span>角色标签</span>
          <el-select
            v-model="form.tags"
            class="ink-select workflow-select"
            popper-class="ink-select-popper"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            :disabled="formDisabled"
            placeholder="输入标签后回车"
          >
            <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </label>

        <label class="form-field">
          <span>外貌特征</span>
          <div class="asset-textarea-wrap">
            <textarea
              v-model="form.appearance"
              class="ink-input asset-textarea"
              rows="3"
              maxlength="1000"
              :disabled="formDisabled"
              placeholder="描述角色的外貌和辨识特征"
            ></textarea>
            <span>{{ form.appearance.length }} / 1000</span>
          </div>
        </label>

        <label class="form-field">
          <span>性格特点</span>
          <div class="asset-textarea-wrap">
            <textarea
              v-model="form.personality"
              class="ink-input asset-textarea"
              rows="3"
              maxlength="1000"
              :disabled="formDisabled"
              placeholder="描述角色的性格、习惯和行为倾向"
            ></textarea>
            <span>{{ form.personality.length }} / 1000</span>
          </div>
        </label>

        <label class="form-field">
          <span>背景故事</span>
          <div class="asset-textarea-wrap">
            <textarea
              v-model="form.background"
              class="ink-input asset-textarea"
              rows="4"
              maxlength="2000"
              :disabled="formDisabled"
              placeholder="记录角色经历、目标和关键秘密"
            ></textarea>
            <span>{{ form.background.length }} / 2000</span>
          </div>
        </label>

        <label class="form-field">
          <span>能力与功法</span>
          <div class="asset-textarea-wrap">
            <textarea
              v-model="form.ability"
              class="ink-input asset-textarea"
              rows="3"
              maxlength="1200"
              :disabled="formDisabled"
              placeholder="描述能力、限制与使用代价"
            ></textarea>
            <span>{{ form.ability.length }} / 1200</span>
          </div>
        </label>
      </div>

      <div class="asset-actions">
        <button
          type="button"
          class="ink-btn ink-btn-outline"
          :disabled="formDisabled || !dirty"
          @click="discardDraft"
        >
          取消
        </button>
        <button
          type="button"
          class="ink-btn ink-btn-primary"
          :disabled="!canSave"
          @click="saveCharacter"
        >
          <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
          {{ saving ? '正在保存' : '保存角色' }}
        </button>
      </div>
    </div>

    <div v-else class="asset-state asset-detail-empty">
      <i class="fa-regular fa-hand-pointer"></i>
      <span>选择一个角色查看和修改信息</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import CharacterAliasesInput from '@/components/CharacterAliasesInput.vue'
import { getCharacterNames } from '@/utils/character-aliases'
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
// 开源版：角色数据走本地参考库，函数形状对齐原服务端接口，调用点不动
import {
  addLocalCharacter as addCharacterApi,
  deleteLocalCharacters as deleteCharacterApi,
  listLocalCharacters as getCharacterListApi,
  updateLocalCharacter as updateCharacterApi,
} from '@/storage/local-reference'
import { showApiError } from '@/utils/api-error'
import type { Character } from '@/types'
import { inkConfirm } from '@/utils/ink-confirm'

interface CharacterForm {
  name: string
  aliases: string[]
  role: number
  gender: number
  age: string
  tags: string[]
  appearance: string
  personality: string
  background: string
  ability: string
}

const props = defineProps<{
  bookId?: string | number
}>()

const emit = defineEmits<{
  (event: 'lore-updated'): void
}>()

const roleOptions = [
  { label: '主角', value: 0 },
  { label: '主要配角', value: 1 },
  { label: '反派', value: 2 },
  { label: '路人', value: 3 },
]
const genderOptions = [
  { label: '女', value: 0 },
  { label: '男', value: 1 },
  { label: '其他', value: 2 },
]

const createEmptyForm = (): CharacterForm => ({
  name: '',
  aliases: [],
  role: 0,
  gender: 0,
  age: '',
  tags: [],
  appearance: '',
  personality: '',
  background: '',
  ability: '',
})

const toCharacterForm = (character: Character): CharacterForm => ({
  name: character.name,
  aliases: [...(character.aliases || [])],
  role: character.role,
  gender: character.gender,
  age: character.age ?? '',
  tags: [...(character.tags ?? [])],
  appearance: character.appearance ?? '',
  personality: character.personality ?? '',
  background: character.background ?? '',
  ability: character.ability ?? '',
})

// 服务端角色列表是已保存基准，本地表单只承载当前尚未提交的编辑草稿。
const characters = ref<Character[]>([])
const selectedCharacterId = ref<number | null>(null)
const previousCharacterId = ref<number | null>(null)
const searchText = ref('')
const loading = ref(false)
const saving = ref(false)
const deletingCharacterId = ref<number | null>(null)
const loadError = ref('')
const creating = ref(false)
const form = reactive<CharacterForm>(createEmptyForm())
let loadRevision = 0

const selectedCharacter = computed(() =>
  characters.value.find(character => character.id === selectedCharacterId.value) ?? null
)
const formVisible = computed(() => creating.value || selectedCharacter.value !== null)
const interactionDisabled = computed(() => loading.value || saving.value || deletingCharacterId.value !== null)
const formDisabled = computed(() => interactionDisabled.value || !formVisible.value)
const tagOptions = computed(() =>
  [...new Set(characters.value.flatMap(character => character.tags ?? []))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN')
  )
)
const filteredCharacters = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase()
  if (!keyword) return characters.value
  return characters.value.filter(character =>
    [...getCharacterNames(character), ...(character.tags ?? []), character.appearance, character.personality]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase().includes(keyword))
  )
})
const dirty = computed(() => {
  if (creating.value) return true
  if (!selectedCharacter.value) return false
  // 表单快照只比较可编辑字段，避免服务端时间等无关字段制造未保存状态。
  return JSON.stringify(form) !== JSON.stringify(toCharacterForm(selectedCharacter.value))
})
const canSave = computed(() =>
  Boolean(props.bookId && form.name.trim() && dirty.value && !formDisabled.value)
)

const roleLabel = (role: number) => roleOptions.find(option => option.value === role)?.label ?? '未分类'

const assignForm = (nextForm: CharacterForm) => {
  Object.assign(form, nextForm)
}

const loadCharacters = async (preferredCharacterId: number | null = selectedCharacterId.value) => {
  if (!props.bookId) {
    characters.value = []
    selectedCharacterId.value = null
    loadError.value = ''
    return
  }
  const revision = ++loadRevision
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await getCharacterListApi(
      { bookId: String(props.bookId), page: 1, size: 500 },
      { loading: false, silentError: true }
    )
    // 切换作品后丢弃旧请求结果，避免上一部作品的角色短暂写入当前面板。
    if (revision !== loadRevision) return
    characters.value = data?.list ?? []
    const nextCharacter =
      characters.value.find(character => character.id === preferredCharacterId) ??
      characters.value[0] ??
      null
    selectedCharacterId.value = nextCharacter?.id ?? null
    creating.value = false
    assignForm(nextCharacter ? toCharacterForm(nextCharacter) : createEmptyForm())
  } catch (error) {
    if (revision !== loadRevision) return
    loadError.value = '角色加载失败'
    showApiError(error, loadError.value)
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

const confirmDiscard = async () => {
  if (!dirty.value) return true
  try {
    await inkConfirm('当前角色有未保存的修改，确定放弃吗？', '放弃修改', {
      confirmButtonText: '放弃',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

const selectCharacter = async (character: Character) => {
  if (interactionDisabled.value || (!creating.value && selectedCharacterId.value === character.id)) return
  if (!(await confirmDiscard())) return
  creating.value = false
  selectedCharacterId.value = character.id
  previousCharacterId.value = null
  assignForm(toCharacterForm(character))
}

const beginCreate = async () => {
  if (!props.bookId) {
    ElMessage.warning('请先选择要编辑的作品')
    return
  }
  if (interactionDisabled.value || !(await confirmDiscard())) return
  previousCharacterId.value = selectedCharacterId.value
  selectedCharacterId.value = null
  creating.value = true
  assignForm(createEmptyForm())
}

const discardDraft = () => {
  if (creating.value) {
    const previousCharacter =
      characters.value.find(character => character.id === previousCharacterId.value) ??
      characters.value[0] ??
      null
    selectedCharacterId.value = previousCharacter?.id ?? null
    previousCharacterId.value = null
    creating.value = false
    assignForm(previousCharacter ? toCharacterForm(previousCharacter) : createEmptyForm())
    return
  }
  if (selectedCharacter.value) assignForm(toCharacterForm(selectedCharacter.value))
}

const saveCharacter = async () => {
  if (!canSave.value || !props.bookId) return
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请输入角色姓名')
    return
  }
  const wasCreating = creating.value
  saving.value = true
  try {
    const payload = {
      name,
      aliases: [...form.aliases],
      role: form.role,
      gender: form.gender,
      age: form.age.trim(),
      tags: form.tags.map(tag => tag.trim()).filter(Boolean),
      appearance: form.appearance.trim(),
      personality: form.personality.trim(),
      background: form.background.trim(),
      ability: form.ability.trim(),
    }
    const { data } = wasCreating
      ? await addCharacterApi({ bookId: String(props.bookId), ...payload })
      : await updateCharacterApi({ id: selectedCharacterId.value!, ...payload })
    await loadCharacters(data.id)
    emit('lore-updated')
    ElMessage.success(wasCreating ? '角色已新增' : '角色已保存')
  } catch (error) {
    showApiError(error, wasCreating ? '新增角色失败' : '保存角色失败')
  } finally {
    saving.value = false
  }
}

const deleteCharacter = async (character: Character) => {
  if (interactionDisabled.value) return
  try {
    await inkConfirm(`确定删除角色「${character.name}」吗？`, '删除角色', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  deletingCharacterId.value = character.id
  try {
    await deleteCharacterApi({ ids: [character.id] })
    characters.value = characters.value.filter(candidate => candidate.id !== character.id)
    // 删除当前角色时选择下一项；删除其他角色不打断正在填写的表单草稿。
    if (!creating.value && selectedCharacterId.value === character.id) {
      const nextCharacter = characters.value[0] ?? null
      selectedCharacterId.value = nextCharacter?.id ?? null
      assignForm(nextCharacter ? toCharacterForm(nextCharacter) : createEmptyForm())
    }
    emit('lore-updated')
    ElMessage.success('角色已删除')
  } catch (error) {
    showApiError(error, '删除角色失败')
  } finally {
    deletingCharacterId.value = null
  }
}

watch(
  () => props.bookId,
  () => {
    loadRevision += 1
    searchText.value = ''
    characters.value = []
    selectedCharacterId.value = null
    previousCharacterId.value = null
    creating.value = false
    assignForm(createEmptyForm())
    void loadCharacters()
  },
  { immediate: true }
)
</script>

<style scoped lang="scss">
@use './workflow-asset-panel';
</style>
