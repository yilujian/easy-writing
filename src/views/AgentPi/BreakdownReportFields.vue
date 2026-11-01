<template>
  <div class="pi-report-fields">
    <template v-for="section in sections" :key="section.key">
      <h4>{{ section.label }}</h4>
      <template v-if="section.kind === 'paragraphs'">
        <p v-for="(line, i) in section.lines" :key="i">{{ line }}</p>
      </template>
      <ul v-else-if="section.kind === 'bullets'">
        <li v-for="(line, i) in section.lines" :key="i">{{ line }}</li>
      </ul>
      <ol v-else-if="section.kind === 'pacing'" class="pi-report-pacing" aria-label="爽点强度曲线">
        <li v-for="(point, i) in section.points" :key="i">
          <span class="pi-report-dots" aria-hidden="true">{{ dots(point.score) }}</span>
          <span><strong>第 {{ point.chapterNo }} 章</strong> {{ point.label }}</span>
          <span class="pi-sr-only">强度 {{ point.score }}/5</span>
        </li>
      </ol>
      <dl v-else-if="section.kind === 'rows'" class="pi-report-rows">
        <template v-for="(row, i) in section.rows" :key="i">
          <dt>{{ row.head }}</dt>
          <dd>{{ row.body }}</dd>
        </template>
      </dl>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { JsonRecord } from '@/types/json'

/** 范围报告按字段写成能读的段落和列表；没登记的字段退化成"字段：内容"。 */
const props = defineProps<{ report: JsonRecord }>()
type Section =
  | { key: string; label: string; kind: 'paragraphs' | 'bullets'; lines: string[] }
  | { key: string; label: string; kind: 'rows'; rows: Array<{ head: string; body: string }> }
  | { key: string; label: string; kind: 'pacing'; points: Array<{ chapterNo: string; score: number; label: string }> }
type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
const list = (value: unknown) => (Array.isArray(value) ? value.map(str).filter(Boolean).join('、') : str(value))
const chapters = (value: unknown) => {
  const text = list(value)
  return text ? (/^[\d\s,，、\-–—]+$/.test(text) ? `第 ${text} 章` : text) : ''
}
const dots = (score: number) => '●'.repeat(Math.max(0, Math.min(5, score))) + '○'.repeat(Math.max(0, 5 - Math.min(5, score)))
const labels: Record<string, string> = {
  editorNotes: '综合分析',
  outlineRecovery: '结构与推进',
  characterArcs: '人物变化',
  foreshadowLedger: '伏笔线索',
  pacingCurve: '爽点节奏',
  reusableTechniques: '可借鉴写法'
}
const order = ['editorNotes', 'outlineRecovery', 'characterArcs', 'foreshadowLedger', 'pacingCurve', 'reusableTechniques']
function generic(value: unknown): string {
  if (Array.isArray(value)) return value.map(generic).filter(Boolean).join('、')
  if (isRec(value))
    return Object.entries(value)
      .map(([k, v]) => `${k}：${generic(v)}`)
      .join('；')
  return str(value)
}
const sections = computed<Section[]>(() => {
  const report = props.report || {}
  const keys = [...order.filter(key => key in report), ...Object.keys(report).filter(key => !order.includes(key))]
  const out: Section[] = []
  for (const key of keys) {
    if (['scope', 'chapterIds'].includes(key)) continue
    const value = report[key]
    const label = labels[key] || key
    if (key === 'editorNotes' || typeof value === 'string') {
      const lines = str(value)
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean)
      if (lines.length) out.push({ key, label, kind: 'paragraphs', lines })
      continue
    }
    if (!Array.isArray(value) || !value.length) continue
    if (key === 'reusableTechniques' || value.every(item => typeof item === 'string')) {
      out.push({ key, label, kind: 'bullets', lines: value.map(generic).filter(Boolean) })
      continue
    }
    if (key === 'pacingCurve') {
      out.push({
        key,
        label,
        kind: 'pacing',
        points: value.filter(isRec).map(item => ({
          chapterNo: str(item.chapterNo || item.chapter),
          score: Number(item.score ?? item.intensity) || 0,
          label: str(item.label || item.note)
        }))
      })
      continue
    }
    const rows = value.filter(isRec).map(item => {
      if (key === 'outlineRecovery')
        return {
          head: [str(item.stage), chapters(item.chapters)].filter(Boolean).join(' · '),
          body: [item.goal ? `目标：${str(item.goal)}` : '', item.payoff ? `兑现：${str(item.payoff)}` : ''].filter(Boolean).join('；')
        }
      if (key === 'characterArcs')
        return {
          head: str(item.name),
          body: [str(item.arc), item.keyChapters ? `关键章节：${chapters(item.keyChapters)}` : ''].filter(Boolean).join('；')
        }
      if (key === 'foreshadowLedger')
        return {
          head: str(item.item),
          body: `第 ${str(item.plantChapter)} 章埋下，${
            item.status === 'recovered' && Number(item.payoffChapter) ? `第 ${str(item.payoffChapter)} 章回收` : '尚未回收'
          }`
        }
      const [first, ...rest] = Object.entries(item)
      return { head: first ? generic(first[1]) : '', body: rest.map(([k, v]) => `${k}：${generic(v)}`).join('；') }
    })
    out.push({ key, label, kind: 'rows', rows })
  }
  return out
})
</script>
