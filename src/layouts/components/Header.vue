<template>
  <header class="header-container">
    <div class="header-left">
      <button class="mobile-menu-button glass-element" type="button" aria-label="打开导航" @click="emit('toggle-sidebar')">
        <i class="fa-solid fa-bars"></i>
      </button>
      <div class="title-section">
        <h2 :class="['page-title', { 'page-title--greeting': showWelcome }]">
          {{ showWelcome ? greetingLine : pageTitle }}
        </h2>
        <p v-if="showWelcome" class="page-subtitle page-subtitle--poem">“ {{ poemLine }} ”</p>
        <p v-else-if="pageSubtitle" class="page-subtitle">
          {{ pageSubtitle }}
          <i v-if="showHelpIcon" class="fa-solid fa-circle-question help-icon"></i>
        </p>
      </div>
    </div>

    <div class="header-right">
      <HeaderSkinPicker />
      <HeaderThemeSwitcher />
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import HeaderSkinPicker from './HeaderSkinPicker.vue'
import HeaderThemeSwitcher from './HeaderThemeSwitcher.vue'

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
}>()

const route = useRoute()

const poemLines = [
  '且将新火试新茶，诗酒趁年华。',
  '长风破浪会有时，直挂云帆济沧海。',
  '山重水复疑无路，柳暗花明又一村。',
  '沉舟侧畔千帆过，病树前头万木春。',
  '会当凌绝顶，一览众山小。',
  '莫愁前路无知己，天下谁人不识君。',
  '路漫漫其修远兮，吾将上下而求索。',
  '千磨万击还坚劲，任尔东西南北风。'
]
const poemLine = ref(poemLines[0])

onMounted(() => {
  poemLine.value = poemLines[Math.floor(Math.random() * poemLines.length)]
})

const pageTitle = computed(() => {
  const metaTitle = String(route.meta.title || '').trim()
  if (metaTitle) return metaTitle
  const titleMap: Record<string, string> = {
    '/myBooks': '我的作品',
    '/writeStatistics': '码字统计',
    '/novelRank': '全网风向标'
  }
  return titleMap[route.path] || '易创'
})

const showWelcome = computed(() => route.path === '/novel')

const greetingLine = computed(() => {
  const hour = new Date().getHours()
  let greeting = '你好'
  if (hour >= 5 && hour < 11) {
    greeting = '早安'
  } else if (hour >= 11 && hour < 14) {
    greeting = '中午好'
  } else if (hour >= 14 && hour < 18) {
    greeting = '下午好'
  } else if (hour >= 18 && hour < 23) {
    greeting = '晚上好'
  } else {
    greeting = '夜深了'
  }
  return `${greeting}，创作者。`
})

const pageSubtitle = computed(() => {
  if (route.path === '/workflowBook') {
    return '从灵感到正文的一站式建书流程'
  }
  if (route.path === '/workflowBook/history') {
    return '查看草稿、生成进度与自动生文任务'
  }
  if (route.path === '/statistics') {
    return '统计所有设备字数总和'
  }
  return ''
})

const showHelpIcon = computed(() => route.path === '/statistics')
</script>

<style scoped lang="scss">
.glass-element {
  background: var(--ui-glass-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--ui-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
  color: var(--ink-sec);
  transition: all 0.3s ease;

  &:hover {
    background: var(--ui-glass-bg-hover);
    border-color: var(--ui-border-hover);
    color: var(--ink-main);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
}

.header-container {
  padding: 24px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;

  .title-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .page-title {
    font-size: calc(24px * var(--ui-font-scale, 1));
    font-weight: bold;
    color: var(--ink-main);
    letter-spacing: 1px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .page-title--greeting {
    font-family: "Ma Shan Zheng", "Noto Serif SC", "Songti SC", SimSun, serif;
    font-size: calc(24px * var(--ui-font-scale, 1));
    font-weight: 500;
    letter-spacing: 2px;
  }

  .page-subtitle {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;

    .help-icon {
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.3s ease;

      &:hover {
        opacity: 1;
      }
    }
  }

  .page-subtitle--poem {
    font-family: "Noto Serif SC", "Songti SC", SimSun, serif;
    font-size: calc(13px * var(--ui-font-scale, 1));
    opacity: 0.85;
    letter-spacing: 0.5px;
  }

  .welcome-badge {
    font-size: calc(12px * var(--ui-font-scale, 1));
    background: var(--ui-glass-bg);
    backdrop-filter: blur(12px);
    padding: 6px 12px;
    border-radius: 20px;
    border: 1px solid var(--ui-border);
    color: var(--ink-sec);
    cursor: pointer;
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    gap: 4px;

    i {
      font-size: calc(10px * var(--ui-font-scale, 1));
    }

    &:hover {
      background: var(--ui-glass-bg-hover);
      color: var(--ink-main);
      border-color: var(--ui-border-hover);
    }
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  flex: 0 0 auto;
}

.mobile-menu-button {
  display: none;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-glass-bg);
  color: var(--ink-main);
  cursor: pointer;
}

@media (max-width: 1024px) {
  :global(body.web-runtime .mobile-menu-button){
    display: inline-flex;
  }

  :global(body.web-runtime .header-container){
    gap: 12px;
    padding: 18px 0;
  }

  :global(body.web-runtime .header-left){
    flex: 1 1 auto;
    gap: 12px;
  }

  :global(body.web-runtime .header-right){
    gap: 10px;
  }

  :global(body.web-runtime .header-left .page-title){
    max-width: 42vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: calc(21px * var(--ui-font-scale, 1));
  }

  :global(body.web-runtime .header-left .page-subtitle){
    max-width: 42vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
}

@media (max-width: 768px) {
  :global(body.web-runtime .header-container){
    padding: 14px 0;
  }

  :global(body.web-runtime .header-left .page-title),
  :global(body.web-runtime .header-left .page-subtitle){
    max-width: 34vw;
  }

  :global(body.web-runtime .theme-btn){
    margin-right: 0 !important;
  }
}
</style>
