<template>
  <div class="pi-report-body" aria-label="写作方法档案">
    <p class="pi-report-meta">
      <template v-if="task.outcome">
        {{ task.outcome.chapterCards }} 章参考正文 · {{ task.outcome.samples }} 段原文样本 ·
        {{ task.outcome.styleCards }} 条写法说明 · {{ task.outcome.taboos }} 条写作注意事项<template
          v-if="task.calibrationChapters?.length"
        >
          · 校准改动 {{ task.outcome.calibrated }} 条</template
        >。
      </template>
      技能「{{ task.skillName }}」已在技能列表里，输入 / 就能用。
    </p>
    <p v-if="task.error" class="pi-report-error">{{ task.error }}</p>
    <section v-if="skill" class="pi-report-section">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="pi-markdown" v-html="renderMarkdown(skill.instructions)"></div>
      <p class="pi-report-meta">
        <button v-if="book && skill.enabled" type="button" class="pi-text-link" @click="applyStyle">
          设为《{{ book.title }}》的默认文风
        </button>
        <button type="button" class="pi-text-link" @click="store.view = 'skills'">在技能页查看或编辑</button>
      </p>
    </section>
    <p v-else class="pi-report-pending">技能文件还没读到，稍后再打开。</p>
  </div>
</template>
<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { appSettings, flushAppSettings } from '@/storage/app-settings'
import { computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import { usePiWorkspace } from './use-pi-workspace'
import type { DistillationTask } from '@/types/distillation-task'

const props = defineProps<{ task: DistillationTask }>()
const store = usePiWorkspace()
const skill = computed(() => store.skills.find(item => item.id === props.task.skillId) || null)
const book = computed(() => store.books.find(item => item.id === store.bookId))
async function applyStyle() {
  const target = book.value
  const style = skill.value
  if (!target || !style?.enabled) return
  try {
    appSettings.setItem('ew-pi-default-style:' + target.id, style.id)
    await flushAppSettings()
    ElMessage.success('已设置《' + target.title + '》的默认文风')
  } catch (error) {
    ElMessage.error(String(error))
  }
}
</script>
