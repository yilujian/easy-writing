<template>
  <section class="settings-pane sensitive-lexicon-pane">
    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-plus"></i>
        <strong>添加自定义词</strong>
      </div>
      <p class="hint-line">
        收词建议：至少两个字，选正常剧情几乎不会用到的词——把「杀」「血」这类常用字加进来会整篇误报。
        涉政类词各平台标准不同，按你的目标平台要求添加。
      </p>
      <div class="add-row">
        <input
          v-model="newWord"
          class="ink-input-underline word-input"
          type="text"
          placeholder="输入词条，回车添加"
          maxlength="20"
          @keyup.enter="handleAdd"
        />
        <el-select
          v-model="newWordType"
          size="small"
          class="settings-inline-select type-select"
          popper-class="settings-select-popper"
        >
          <el-option
            v-for="option in typeOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <button class="ink-btn ink-btn-primary" type="button" @click="handleAdd">添加</button>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-regular fa-user"></i>
        <strong>自定义词（{{ customWords.length }}）</strong>
      </div>
      <p v-if="!customWords.length" class="hint-line">还没有自定义词。上方添加后立即对写作台生效。</p>
      <div v-else class="word-chip-list">
        <span v-for="entry in customWords" :key="entry.word" class="word-chip">
          <span class="chip-word">{{ entry.word }}</span>
          <span class="chip-type">{{ typeLabel(entry.type) }}</span>
          <button class="chip-remove" type="button" :title="`删除「${entry.word}」`" @click="handleRemove(entry.word)">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </span>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-book"></i>
        <strong>内置词库（启用 {{ enabledBuiltinCount }} / 停用 {{ disabledWords.size }}）</strong>
      </div>
      <p class="hint-line">点击词条可停用或恢复；觉得误报的词停掉即可，随时能恢复。</p>
      <div v-for="group in builtinGroups" :key="group.type" class="builtin-group">
        <div class="builtin-group-title">{{ group.label }}（{{ group.entries.length }}）</div>
        <div class="word-chip-list">
          <button
            v-for="entry in group.entries"
            :key="entry.word"
            type="button"
            class="word-chip builtin-chip"
            :class="{ disabled: disabledWords.has(entry.word) }"
            :title="disabledWords.has(entry.word) ? '已停用，点击恢复' : '点击停用'"
            @click="handleToggleBuiltin(entry.word)"
          >
            {{ entry.word }}
          </button>
        </div>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  addCustomSensitiveWord,
  listBuiltinSensitiveWords,
  loadUserSensitiveLexicon,
  removeCustomSensitiveWord,
  SENSITIVE_TYPE_LABELS,
  setBuiltinWordDisabled,
} from '@/storage/local-sensitive-words'

const lexiconTick = ref(0)
const lexicon = computed(() => {
  void lexiconTick.value
  return loadUserSensitiveLexicon()
})
const refresh = () => {
  lexiconTick.value += 1
}

const newWord = ref('')
const newWordType = ref(1)

const typeOptions = Object.entries(SENSITIVE_TYPE_LABELS).map(([value, label]) => ({
  value: Number(value),
  label,
}))

const typeLabel = (type: number) => SENSITIVE_TYPE_LABELS[type] || '其他'

const customWords = computed(() => lexicon.value.custom)
const disabledWords = computed(() => new Set(lexicon.value.disabled))

const builtinGroups = computed(() => {
  const groups = new Map<number, { type: number; label: string; entries: Array<{ word: string; type: number }> }>()
  for (const entry of listBuiltinSensitiveWords()) {
    if (!groups.has(entry.type)) {
      groups.set(entry.type, { type: entry.type, label: typeLabel(entry.type), entries: [] })
    }
    groups.get(entry.type)!.entries.push(entry)
  }
  return [...groups.values()]
})

const enabledBuiltinCount = computed(
  () => listBuiltinSensitiveWords().length - disabledWords.value.size
)

const handleAdd = () => {
  const result = addCustomSensitiveWord(newWord.value, newWordType.value)
  if (result.ok) {
    ElMessage.success(result.message)
    newWord.value = ''
  } else {
    ElMessage.warning(result.message)
  }
  refresh()
}

const handleRemove = (word: string) => {
  removeCustomSensitiveWord(word)
  ElMessage.success(`已删除「${word}」`)
  refresh()
}

const handleToggleBuiltin = (word: string) => {
  const willDisable = !disabledWords.value.has(word)
  setBuiltinWordDisabled(word, willDisable)
  ElMessage.success(willDisable ? `已停用「${word}」` : `已恢复「${word}」`)
  refresh()
}
</script>

<style lang="scss">
/* 设置中心样式随批F规矩收敛在弹窗命名空间下（分区被 Teleport 弹窗包裹，scoped 会失联） */
.settings-center-modal .sensitive-lexicon-pane {
  .add-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .word-input {
    flex: 1;
    min-width: 180px;
  }

  .type-select {
    width: 130px;
  }

  .word-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }

  .word-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--btn-outline-border);
    background: var(--surface-2);
    color: var(--ink-main);
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.4;
  }

  .chip-type {
    font-size: calc(11px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }

  .chip-remove {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--ink-sec);
    cursor: pointer;
    display: inline-flex;
    align-items: center;

    &:hover {
      color: var(--state-danger, #c45656);
    }
  }

  .builtin-chip {
    cursor: pointer;
    transition: opacity 0.2s ease, border-color 0.2s ease;

    &:hover {
      border-color: var(--ink-accent);
    }

    &.disabled {
      opacity: 0.45;
      text-decoration: line-through;
    }
  }

  .builtin-group {
    margin-top: 14px;
  }

  .builtin-group-title {
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 700;
    color: var(--ink-sec);
  }
}
</style>
