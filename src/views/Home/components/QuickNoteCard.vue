<template>
        <div class="note-card fusion-card">
          <div class="section-header">
            <div class="section-title section-title--link" @click="goInspiration">
              <i class="fa-solid fa-bookmark"></i>
              灵感速记
            </div>
            <button class="icon-button" type="button" @click.stop="handleAddInspiration">
              <i class="fa-solid fa-plus"></i>
            </button>
          </div>
          <div class="note-body">
            <InspirationInput
ref="inspirationInputRef" :model-value="inspirationDraft"
              :options="tagOptions" :max-length="300" min-height="130px"
              placeholder="点击记录灵感..."
              @blur="handleInspirationBlur" @update:model-value="handleInspirationUpdate" />
          </div>
          <div v-if="inspirationLoading" class="note-footer note-footer--loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            正在加载灵感...
          </div>
          <div v-else-if="inspirations.length" class="note-footer">
            最近更新 {{ formatUpdateTime(inspirations[0]?.updateTime || inspirations[0]?.createTime) }}
          </div>
        </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import InspirationInput from '@/components/InspirationInput.vue'
import type { Inspiration } from '@/types'
import {
  addLocalInspiration,
  listLocalInspirations,
  updateLocalInspiration
} from '@/storage/local-inspiration'
import { formatUpdateTime } from '../home-format'

const router = useRouter()

const inspirations = ref<Inspiration[]>([])
const inspirationLoading = ref(false)
const inspirationDraft = ref('')
const inspirationActiveId = ref<number | null>(null)
const inspirationOriginal = ref('')
const inspirationBackup = ref<Inspiration[]>([])
const isAddingInspiration = ref(false)
const inspirationInputRef = ref<{ focus: () => void } | null>(null)

interface MentionOption {
  value: string
  label: string
}

const sortInspirationsByUpdated = (list: Inspiration[]) => {
  return list
    .slice()
    .sort((a, b) =>
      dayjs(b.updateTime || b.createTime || 0).valueOf() -
      dayjs(a.updateTime || a.createTime || 0).valueOf()
    )
}

const normalizeInputText = (text: string) => text.replace(/\u00a0/g, ' ')

const extractTagAndContent = (text: string) => {
  const normalized = normalizeInputText(text || '')
  const match = normalized.match(/(^|[\s\u00a0\n])#([^\s#]+)/)
  if (!match) {
    return { tag: '', content: normalized.trim() }
  }
  const tag = match[2]
  const content = normalized
    .replace(match[0], match[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
  return { tag, content }
}

const parseTagFromText = (text: string) => extractTagAndContent(text).tag

const mergeTagIntoContent = (content: string, tag: string) => {
  const normalized = String(tag || '').trim()
  if (!normalized) return content
  const token = `#${normalized}`
  const safeContent = String(content || '')
  if (safeContent === token || safeContent.startsWith(`${token} `)) return safeContent
  return safeContent ? `${token} ${safeContent}` : token
}

const tagOptions = computed(() => {
  const result: MentionOption[] = []
  const seen = new Set<string>()
  inspirations.value.forEach(item => {
    const fromText = parseTagFromText(item.content || '')
    const fromField = String(item.tag || '').trim()
    ;[fromText, fromField].forEach(tag => {
      const value = String(tag || '').trim()
      if (!value || seen.has(value)) return
      seen.add(value)
      result.push({ value, label: value })
    })
  })
  return result
})

const applyInspirationDraft = (force = false) => {
  if (isAddingInspiration.value && !force) return
  if (!inspirations.value.length) {
    inspirationDraft.value = ''
    inspirationActiveId.value = null
    inspirationOriginal.value = ''
    return
  }
  const first = inspirations.value[0]
  inspirationDraft.value = first?.content || ''
  inspirationActiveId.value = first?.id || null
  inspirationOriginal.value = first?.content || ''
}

const fetchInspirations = async () => {
  if (inspirationLoading.value) return
  inspirationLoading.value = true
  try {
    const list = listLocalInspirations()
    const sorted = sortInspirationsByUpdated(list)
    inspirations.value = sorted.map(item => ({
      ...item,
      content: mergeTagIntoContent(item.content || '', String(item.tag || '').trim())
    }))
    applyInspirationDraft()
  } finally {
    inspirationLoading.value = false
  }
}

const goInspiration = () => {
  router.push({ path: '/inspiration' })
}

const handleInspirationUpdate = (value: string) => {
  inspirationDraft.value = value
}

const restoreBackup = () => {
  inspirations.value = inspirationBackup.value
  isAddingInspiration.value = false
  applyInspirationDraft(true)
}

const handleInspirationBlur = async () => {
  const parsed = extractTagAndContent(inspirationDraft.value)
  const content = parsed.content
  const tag = parsed.tag
  const originalParsed = extractTagAndContent(inspirationOriginal.value)
  try {
    if (isAddingInspiration.value) {
      if (!content) {
        restoreBackup()
        return
      }
      if (content.length > 300) {
        ElMessage.warning('内容请控制在300字以内')
        restoreBackup()
        return
      }
      addLocalInspiration({ content, tag })
      ElMessage.success('已保存灵感')
      isAddingInspiration.value = false
      await fetchInspirations()
      return
    }

    if (!content) {
      if (inspirationActiveId.value) {
        inspirationDraft.value = inspirationOriginal.value
      }
      return
    }
    if (content.length > 300) {
      ElMessage.warning('内容请控制在300字以内')
      inspirationDraft.value = inspirationOriginal.value
      return
    }
    if (!inspirationActiveId.value) {
      addLocalInspiration({ content, tag })
      ElMessage.success('已保存灵感')
      await fetchInspirations()
      return
    }
    if (content !== originalParsed.content || tag !== originalParsed.tag) {
      updateLocalInspiration({ id: inspirationActiveId.value, content, tag })
      ElMessage.success('已更新灵感')
      await fetchInspirations()
    }
  } catch (error) {
    console.error('保存灵感失败:', error)
    if (isAddingInspiration.value) restoreBackup()
    ElMessage.error('保存灵感失败')
  }
}

const handleAddInspiration = () => {
  if (isAddingInspiration.value) return
  inspirationBackup.value = inspirations.value.slice()
  inspirations.value = []
  inspirationDraft.value = ''
  inspirationActiveId.value = null
  inspirationOriginal.value = ''
  isAddingInspiration.value = true
  requestAnimationFrame(() => {
    inspirationInputRef.value?.focus()
  })
}

fetchInspirations()
</script>

<style scoped lang="scss">

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ink-main);
}

.section-title--link {
  cursor: pointer;
  transition: color 0.2s ease;
}

.section-title--link:hover {
  color: var(--ink-accent);
}

.note-card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.note-card .icon-button {
  border: none;
  background: transparent;
  color: var(--ink-sec);
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, color 0.2s ease;
}

.note-card .icon-button:hover {
  background: var(--ui-glass-bg-hover);
  color: var(--ink-main);
}

.note-body {
  background: color-mix(in srgb, var(--bg-main) 72%, transparent);
  border: 1px solid color-mix(in srgb, var(--ink-main) 10%, var(--ui-border));
  padding: 0;
  border-radius: 12px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  line-height: 1.6;
  min-height: clamp(100px, 14vh, 142px);
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
}

.note-body:focus-within {
  background: color-mix(in srgb, var(--bg-main) 84%, transparent);
  border-color: color-mix(in srgb, var(--ink-accent) 36%, var(--ui-border));
}


.note-footer {
  flex: 0 0 auto;
  min-width: 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-card {
  min-height: 0;
}

.note-card :deep(.inspiration-input) {
  flex: 0 0 auto;
  width: 100%;
  border: none;
  background: transparent;
  box-shadow: none;
}

.note-card :deep(.inspiration-input__editor) {
  min-height: clamp(90px, 12vh, 132px);
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 14px 16px;
}

.note-card :deep(.inspiration-input.is-focused .inspiration-input__editor) {
  border: none;
  background: transparent;
  box-shadow: none;
}

.note-card :deep(.inspiration-input__editor:empty::before) {
  color: color-mix(in srgb, var(--ink-sec) 78%, transparent);
}


.note-footer--loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-sec);
}

.note-footer--loading i {
  color: var(--ink-accent);
}

</style>
