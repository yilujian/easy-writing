<template>
  <!-- 过程区：思考、中间说明、工具，任何时候都默认收起；运行中在标题上显示正在做什么。 -->
  <details v-if="steps.length" class="pi-inline-details pi-process">
    <summary>
      <i :class="running && !answered ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-list-check'" aria-hidden="true"></i
      ><span>{{ title }}</span
      ><i class="fa-solid fa-chevron-right pi-details-chevron" aria-hidden="true"></i>
    </summary>
    <ol class="pi-steps">
      <li v-for="step in steps" :key="step.id" :class="`is-${step.kind}`">
        <template v-if="step.kind === 'thinking'">
          <div class="pi-step-head">
            <i class="fa-regular fa-lightbulb" aria-hidden="true"></i><span class="pi-step-name">思考</span
            ><small class="pi-step-time">{{ step.durationMs ? formatDuration(step.durationMs) : running ? '进行中' : '' }}</small>
          </div>
          <p class="pi-thinking-text">{{ step.text }}</p>
        </template>
        <template v-else>
          <div class="pi-step-head">
            <i :class="stepIcon(step)" aria-hidden="true"></i
            ><span class="pi-step-name">{{ labels[step.name || ''] || step.name || '平台操作' }}</span
            ><span v-if="step.argsSummary" class="pi-step-args" :title="step.argsSummary">{{ step.argsSummary }}</span
            ><small class="pi-step-time">{{
              step.durationMs != null && step.status === '已完成' ? formatDuration(step.durationMs) : step.status
            }}</small>
          </div>
          <p v-if="step.status === '进行中' && step.progress" class="pi-step-result">{{ step.progress }}</p>
          <p v-else-if="step.resultSummary" class="pi-step-result" :class="{ 'is-error': step.isError }">
            {{ step.resultSummary }}
          </p>
        </template>
      </li>
    </ol>
  </details>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { formatDuration } from '@/agent-pi/conversation'
import type { PiTurnStep } from '@/agent-pi/conversation'
/** 一轮的过程区；一条回复里有几轮（作者的话一轮、任务完成后接着说一轮）就有几个。 */
const props = defineProps<{
  steps: PiTurnStep[]
  running: boolean
  /** 这一轮已经写出结论：标题不再转圈。 */
  answered: boolean
  thinkingMs: number
  labels: Record<string, string>
}>()
const stepIcon = (step: PiTurnStep) =>
  step.status === '已完成'
    ? 'fa-solid fa-check'
    : step.status === '已停止' || step.status === '未完成'
      ? 'fa-regular fa-circle-stop'
      : 'fa-solid fa-circle-notch fa-spin'
/** 折叠时一句话概括这一轮做了什么；运行中显示当前在做的事。 */
const title = computed(() => {
  if (props.running) {
    const current = [...props.steps].reverse().find(step => step.kind === 'tool' && step.status === '进行中')
    if (current) return `正在${props.labels[current.name || ''] || '执行操作'}…`
    const tail = props.steps[props.steps.length - 1]
    if (tail?.kind === 'thinking' && !tail.durationMs) return '正在思考…'
    return '正在处理…'
  }
  const parts: string[] = []
  if (props.steps.some(step => step.kind === 'thinking'))
    parts.push(props.thinkingMs ? `思考 ${formatDuration(props.thinkingMs)}` : '有思考过程')
  const tools = props.steps.filter(step => step.kind === 'tool').length
  if (tools) parts.push(`调用了 ${tools} 个工具`)
  return parts.join(' · ') || '过程'
})
</script>
