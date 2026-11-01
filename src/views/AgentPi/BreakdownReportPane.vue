<template>
  <div class="pi-report-body" aria-label="拆书报告">
    <p class="pi-report-meta">
      已完成 {{ done }}/{{ task.chapters.length }} 章<template v-if="task.status !== 'completed'">
        · {{ statusLabel }}</template
      >。分析判断由 AI 生成，可对照原文核实。
    </p>
    <p v-if="task.error" class="pi-report-error">{{ task.error }}</p>
    <section v-if="task.report" class="pi-report-section">
      <h3>{{ task.scope }}总结</h3>
      <BreakdownReportFields :report="task.report" />
    </section>
    <p v-else class="pi-report-pending">
      {{ task.phase === 'report' && task.status === 'running' ? '正在汇总范围报告…' : '范围报告尚未完成，已完成的章节可以先看。' }}
    </p>
    <template v-if="segments.length">
      <h3 class="pi-report-chapters-title">分段报告</h3>
      <details v-for="segment in segments" :key="segment.key" class="pi-report-chapter">
        <summary>
          <span>{{ segment.range }}</span><small>{{ segment.report ? '已完成' : '尚未完成' }}</small>
        </summary>
        <BreakdownReportFields v-if="segment.report" :report="segment.report" />
      </details>
    </template>
    <h3 class="pi-report-chapters-title">逐章分析</h3>
    <details
      v-for="chapter in ordered"
      :key="chapter.id"
      class="pi-report-chapter"
      @toggle="onChapterToggle(chapter.id, $event)"
    >
      <summary>
        <span>{{ chapter.sortNo }}. {{ chapter.title }}</span
        ><small>{{ chapter.done ? '已完成' : liveChapter === chapter.id ? '正在分析' : '尚未完成' }}</small>
      </summary>
      <p v-if="loading[chapter.id]" class="pi-report-meta">正在读取已保存结果…</p>
      <p v-if="errors[chapter.id]" class="pi-report-error" role="alert">{{ errors[chapter.id] }}</p>
      <template v-for="(detail, detailIndex) in details[chapter.id] ? [details[chapter.id]] : []" :key="detailIndex">
        <p v-if="detail.sourceChanged" class="pi-report-meta">原文已经变化，本次分析仍基于旧版本；引文保留为当时片段。</p>
        <p v-if="!detail.saved.result" class="pi-report-meta">本章尚未完整分析，已保存的分段进度会在继续时复用。</p>
        <template v-for="(analysis, analysisIndex) in detail.saved.result ? [detail.saved.result] : []" :key="analysisIndex">
          <h4>剧情梳理</h4>
          <p class="pi-report-prose">{{ analysis.summary }}</p>
          <h4>关键节点</h4>
          <div v-for="node in analysis.outline" :key="node.id" class="pi-report-node">
            <strong>{{ node.title }} <small>{{ node.range }}</small></strong>
            <p>{{ node.text }}</p>
          </div>
          <template v-if="analysis.rhythm.length">
            <h4>冲突与节奏</h4>
            <p v-for="(r, i) in analysis.rhythm" :key="i"><strong>{{ r.label }}：</strong>{{ r.desc }}</p>
          </template>
          <template v-if="analysis.relations?.length">
            <h4>人物关系</h4>
            <p v-for="(r, i) in analysis.relations" :key="i">{{ r.from }} 与 {{ r.to }} · {{ r.relation }}：{{ r.desc }}</p>
          </template>
          <template v-if="analysis.setting.length">
            <h4>设定</h4>
            <p v-for="(s, i) in analysis.setting" :key="i"><strong>{{ s.name }}：</strong>{{ s.desc }}</p>
          </template>
          <template v-if="analysis.golden">
            <h4>前三章重点</h4>
            <p><strong>开篇吸引力：</strong>{{ analysis.golden.hook300 }}</p>
            <p><strong>人物建立：</strong>{{ analysis.golden.characterEstablish }}</p>
            <p><strong>核心困境：</strong>{{ analysis.golden.coreDilemma }}</p>
            <div v-for="(anchor, i) in analysis.golden.anchors" :key="i" class="pi-report-node">
              <blockquote>{{ anchor.quote }}</blockquote>
              <p>{{ anchor.comment }}</p>
            </div>
          </template>
          <template v-if="analysis.findings?.length">
            <h4>原文依据与可借鉴写法</h4>
            <div v-for="(finding, i) in analysis.findings" :key="i" class="pi-report-finding">
              <p><strong>原文事实：</strong>{{ finding.fact }}</p>
              <p><strong>分析判断：</strong>{{ finding.interpretation }}</p>
              <p><strong>可借鉴写法：</strong>{{ finding.technique }}</p>
              <details>
                <summary>查看原文 · 第 {{ finding.startPara }}—{{ finding.endPara }} 段</summary>
                <blockquote>{{ finding.quote }}</blockquote>
                <p
                  v-for="(paragraph, j) in (detail.sourceChanged ? [] : detail.content.paragraphs).slice(
                    finding.startPara - 1,
                    finding.endPara
                  )"
                  :key="j"
                >
                  {{ paragraph }}
                </p>
              </details>
            </div>
          </template>
        </template>
        <details class="pi-report-source">
          <summary>{{ detail.sourceChanged ? '查看当前版本原文' : '查看本章原文' }}</summary>
          <p v-for="(paragraph, i) in detail.content.paragraphs" :key="i"><small>{{ i + 1 }}</small> {{ paragraph }}</p>
        </details>
      </template>
    </details>
  </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { breakdownLive, readTaskChapter, SEGMENT_SIZE } from '@/agent-pi/breakdown-tasks'
import BreakdownReportFields from './BreakdownReportFields.vue'
import type { BreakdownTask } from '@/types/breakdown-task'
import type { JsonRecord } from '@/types/json'

const props = defineProps<{ task: BreakdownTask }>()
const details = reactive<Record<number, Awaited<ReturnType<typeof readTaskChapter>>>>({})
const loading = reactive<Record<number, boolean>>({})
const errors = reactive<Record<number, string>>({})
const opened = new Set<number>()
const ordered = computed(() => [...props.task.chapters].sort((a, b) => a.sortNo - b.sortNo))
const done = computed(() => props.task.chapters.filter(c => c.done).length)
const liveChapter = computed(() => breakdownLive.value[props.task.id]?.chapterId)
const statusLabel = computed(
  () =>
    ({
      running: '进行中',
      pausing: '正在暂停',
      paused: '已暂停',
      failed: '未完成',
      cancelled: '已取消',
      completed: '已完成'
    })[props.task.status]
)
/** 超过 50 章的任务先出分段报告，每段对应目录里连续的 50 章。 */
const segments = computed(() => {
  const chapters = ordered.value
  if (chapters.length <= SEGMENT_SIZE) return []
  const out: Array<{ key: string; range: string; report: JsonRecord | null }> = []
  for (let index = 0; index * SEGMENT_SIZE < chapters.length; index++) {
    const slice = chapters.slice(index * SEGMENT_SIZE, (index + 1) * SEGMENT_SIZE)
    out.push({
      key: `segment:${index}`,
      range: `第 ${slice[0].sortNo}–${slice[slice.length - 1].sortNo} 章`,
      report: props.task.reportSteps[`segment:${index}`] || null
    })
  }
  return out
})
async function read(id: number) {
  loading[id] = true
  errors[id] = ''
  try {
    details[id] = await readTaskChapter(props.task.id, id)
  } catch (e) {
    errors[id] = String(e instanceof Error ? e.message : e)
  } finally {
    loading[id] = false
  }
}
function onChapterToggle(id: number, event: Event) {
  if ((event.target as HTMLDetailsElement).open) {
    opened.add(id)
    if (!details[id]) void read(id)
  } else opened.delete(id)
}
watch(
  () => props.task.updatedAt,
  () => {
    for (const id of opened) void read(id)
  }
)
</script>
