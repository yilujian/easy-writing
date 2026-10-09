<template>
        <div class="tools-card fusion-card">
          <div class="section-header">
            <div class="section-title">
              <i class="fa-solid fa-screwdriver-wrench"></i>
              常用工具
            </div>
          </div>
          <div class="tools-grid">
            <div v-for="tool in tools" :key="tool.key" class="tool-item clickable" @click="handleToolClick(tool)">
              <div class="tool-icon" :style="{ background: tool.color }">
                <i :class="tool.icon"></i>
              </div>
              <div class="tool-info">
                <div class="tool-name">{{ tool.name }}</div>
                <div class="tool-desc">{{ tool.desc }}</div>
              </div>
            </div>
          </div>
          <AICreateCover v-model:visible="coverVisible" @apply="coverVisible = false" />
        </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AICreateCover from './AICreateCover.vue'

const router = useRouter()
const coverVisible = ref(false)

interface ToolItem {
  key: string
  name: string
  desc: string
  icon: string
  color: string
}

const tools: ToolItem[] = [
  {
    key: 'ai-book',
    name: 'AI 一键建书',
    desc: '大纲/人设/开篇',
    icon: 'fa-solid fa-wand-magic-sparkles',
    color: 'color-mix(in srgb, var(--ink-main) 8%, transparent)'
  },
  {
    key: 'analysis',
    name: '竞品拆书',
    desc: '分析节奏与卖点',
    icon: 'fa-solid fa-scissors',
    color: 'color-mix(in srgb, var(--state-warning) 14%, transparent)'
  },
  {
    key: 'cover',
    name: '封面制作',
    desc: 'AI 快速出图',
    icon: 'fa-regular fa-image',
    color: 'color-mix(in srgb, var(--chart-ai) 14%, transparent)'
  },
  {
    key: 'inspiration',
    name: '灵感速记',
    desc: '随手记录灵感',
    icon: 'fa-regular fa-lightbulb',
    color: 'color-mix(in srgb, var(--state-success) 14%, transparent)'
  }
]

const handleToolClick = (tool: ToolItem) => {
  switch (tool.key) {
    case 'ai-book':
      router.push({ path: '/workflowBook' })
      return
    case 'analysis':
      router.push({ path: '/bookBreakdown' })
      return
    case 'inspiration':
      router.push({ path: '/inspiration' })
      return
    case 'cover':
      coverVisible.value = true
      return
    default:
      return
  }
}
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

.tools-card {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tools-grid {
  display: grid;
  // 每格至少 180，放不下自动减列，不需要断点
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 14px;
}

.tool-item {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--ink-main) 9%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-glass-bg) 88%, var(--bg-main));
  align-items: center;
  min-width: 0;
  min-height: 76px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 38%, transparent);
  transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}

.tool-item.clickable {
  cursor: pointer;
}

.tool-item:hover {
  transform: translateY(-3px);
  background: var(--ui-glass-bg-hover);
  border-color: var(--ui-border-hover);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bg-main) 48%, transparent);
}

.tool-icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-main);
}

.tool-name {
  font-weight: 600;
  color: var(--ink-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-desc {
  font-size: 12px;
  color: var(--ink-sec);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

</style>
