<template>
  <details class="pi-inline-details pi-question-record">
    <summary>
      <i :class="answer?.cancelled ? 'fa-solid fa-arrow-turn-up' : 'fa-solid fa-circle-check'" aria-hidden="true"></i>
      <span class="pi-question-record-question">{{ spec.question }}</span>
      <span class="pi-question-record-answer">{{ answerSummary(answer) }}</span>
      <i class="fa-solid fa-chevron-right pi-details-chevron" aria-hidden="true"></i>
    </summary>
    <div class="pi-question-record-body">
      <p v-if="spec.description" class="pi-question-desc">{{ spec.description }}</p>
      <details v-for="proposal in spec.proposals || []" :key="proposal.id"><summary>{{ proposal.title }}</summary><p style="white-space: pre-wrap; overflow-wrap: anywhere">{{ proposal.content }}</p></details>
      <ol v-if="spec.historySteps.length" class="pi-question-record-steps" aria-label="逐项回答">
        <li v-for="step in spec.historySteps" :key="step.key" :class="{ 'is-skipped': !stepText(step.key) }">
          <span class="pi-question-record-step-question">{{ step.question }}</span>
          <span class="pi-question-record-step-answer">{{ stepText(step.key) || '跳过，交给 Agent 建议' }}</span>
        </li>
      </ol>
      <ul v-if="spec.options.length" class="pi-question-record-options" aria-label="当时的选项">
        <li v-for="option in spec.options" :key="option.id" :class="{ 'is-selected': picked(option.id, option.title) }">
          <i :class="picked(option.id, option.title) ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'" aria-hidden="true"></i>
          <span>
            <strong
              >{{ option.title
              }}<em v-if="answer?.inputs?.[option.id]" class="pi-question-record-input">{{ answer.inputs[option.id] }}</em></strong
            >
            <small v-if="option.description">{{ option.description }}</small>
          </span>
        </li>
      </ul>
      <p v-if="answer?.text" class="pi-question-record-text">
        <i class="fa-regular fa-pen-to-square" aria-hidden="true"></i>{{ answer.text }}
      </p>
    </div>
  </details>
</template>
<script setup lang="ts">
import { answerSummary, selectedText } from '@/agent-pi/questions'
import type { PiQuestionAnswer, PiQuestionSpec } from '@/types/agent-pi'

const props = defineProps<{ spec: PiQuestionSpec; answer: PiQuestionAnswer | null }>()
const picked = (id: string, title: string) =>
  !!props.answer && !props.answer.cancelled && (props.answer.selectedIds?.includes(id) || props.answer.selected.includes(title))
const stepText = (key: string) => {
  const value = props.answer?.steps?.[key]
  return value ? [selectedText(value).join('、'), value.text].filter(Boolean).join('；') : ''
}
</script>
