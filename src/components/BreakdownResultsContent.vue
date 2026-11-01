<template>
  <div class="breakdown-results">
    <div class="result-toolbar">
      <BreakdownSaveButton
        v-if="data && (data.indexed || data.projectReport)"
        :project-id="projectId"
        :initial-saved="data.savedToWorkbench"
        @saved="data.savedToWorkbench = true"
      />
      <button class="ink-btn ink-btn-outline" :disabled="loading || repairing" @click="load(offset)">
        刷新
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取拆书结果…</p>
    <template v-if="data">
      <p class="coverage">
        《{{ data.title }}》<template v-if="from">第 {{ data.rangeFrom }}–{{ data.rangeTo }} 章 · </template
        >已生成 {{ data.indexed }}/{{ from ? data.rangeTotal : data.total }} 章的章节卡。<span
          v-if="!data.searchReady"
          >全文检索正在后台建立，不影响查看章节和已有结果。</span
        >
      </p>
      <div v-if="data.needsRepair" class="repair-note">
        <p>
          这本书由旧版分章器导入，带标点的章名可能被并入上一章。修复会保留原目录和旧成果，未改变章节的结果继续复用。
        </p>
        <button class="ink-btn ink-btn-outline" :disabled="repairing || loading" @click="repair">
          检查并修复分章
        </button>
      </div>
      <p v-if="data.repairNote" class="repair-note">{{ data.repairNote }}</p>
      <div v-if="repairing" role="status">
        {{ repairProgress?.stage || '正在读取'
        }}<template v-if="repairProgress?.total">
          · {{ repairProgress.done }}/{{ repairProgress.total }}</template
        >
        <button
          v-if="repairProgress?.cancellable !== false"
          class="ink-btn ink-btn-outline"
          @click="repairTask?.cancel()"
        >
          取消
        </button>
      </div>
      <details v-if="data.projectReport" open class="report">
        <summary>已保存的全书报告</summary>
        <p v-for="line in projectReportLines" :key="line">{{ line }}</p>
      </details>
      <p v-else>尚未生成汇总报告，下面的章节卡可直接阅读。</p>
      <button v-if="data.indexed" class="ink-btn ink-btn-primary" :disabled="repairing" @click="analyse">
        去对话{{ data.projectReport ? '继续分析' : '生成拆书报告' }}
      </button>
      <p v-if="!data.indexed">尚无有效章节卡。可回到对话选择拆解范围。</p>
      <article v-for="card in data.cards" :key="card.no" class="chapter-result">
        <h3>{{ card.title }}</h3>
        <p>{{ card.oneLine }}</p>
        <ul v-if="card.events?.length">
          <li v-for="(event, i) in card.events" :key="i">{{ event }}</li>
        </ul>
        <dl>
          <template v-if="card.hooks?.length"
            ><dt>钩子</dt>
            <dd v-for="(hook, i) in card.hooks" :key="`h${i}`">{{ hook.text }}</dd></template
          >
          <template v-if="card.payoffs?.length"
            ><dt>爽点</dt>
            <dd v-for="(payoff, i) in card.payoffs" :key="`p${i}`">
              {{ payoff.quote || payoff.type }}
            </dd></template
          >
          <template v-if="card.planted?.length"
            ><dt>埋下的伏笔</dt>
            <dd v-for="(line, i) in card.planted" :key="`t${i}`">{{ line }}</dd></template
          >
          <template v-if="card.paid?.length"
            ><dt>回收的伏笔</dt>
            <dd v-for="(line, i) in card.paid" :key="`r${i}`">{{ line }}</dd></template
          >
        </dl>
      </article>
      <div v-if="data.indexed > 20" class="result-toolbar">
        <button
          class="ink-btn ink-btn-outline"
          :disabled="offset === 0 || loading"
          @click="load(offset - 20)"
        >
          上一页
        </button>
        <span>{{ offset + 1 }}–{{ Math.min(offset + 20, data.indexed) }} / {{ data.indexed }}</span>
        <button
          class="ink-btn ink-btn-outline"
          :disabled="offset + 20 >= data.indexed || loading"
          @click="load(offset + 20)"
        >
          下一页
        </button>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import BreakdownSaveButton from './BreakdownSaveButton.vue'
import { writingCommand } from '@/writing-service/client'
import { importReferenceFile, type ReferenceImportProgress } from '@/writing-service/reference-import'
import { usePiWorkspace } from '@/views/AgentPi/use-pi-workspace'
interface Card {
  no: number
  title: string
  oneLine: string
  events: string[]
  hooks: { text: string }[]
  payoffs: { quote: string; type: string }[]
  planted: string[]
  paid: string[]
}
interface Results {
  projectId: string
  title: string
  total: number
  rangeFrom: number
  rangeTo: number
  rangeTotal: number
  indexed: number
  cards: Card[]
  savedToWorkbench: boolean
  needsRepair: boolean
  repairNote?: string
  searchReady: boolean
  projectReport?: Record<string, unknown>
}
const props = defineProps<{
  projectId: string
  sessionId?: string
  revision?: number
  from?: number
  to?: number
}>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const store = usePiWorkspace()
const data = ref<Results | null>(null)
const loading = ref(false)
const error = ref('')
const offset = ref(0)
const repairing = ref(false)
const repairProgress = ref<ReferenceImportProgress | null>(null)
let repairTask: ReturnType<typeof importReferenceFile> | undefined
let request = 0
const reportLines = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(reportLines)
      : []
const projectReportLines = computed(() => reportLines(data.value?.projectReport))
async function load(start = 0) {
  if (!props.projectId) return
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const result = await writingCommand<Results>('breakdown_results', {
      projectId: props.projectId,
      offset: start,
      from: props.from,
      to: props.to
    })
    if (current === request) {
      data.value = result
      offset.value = start
    }
  } catch (cause) {
    if (current === request) error.value = String(cause)
  } finally {
    if (current === request) loading.value = false
  }
}
watch(
  () => [props.projectId, props.from, props.to],
  () => {
    data.value = null
    void load()
  },
  { immediate: true }
)
watch(
  () => props.revision,
  () => {
    if (!repairing.value) void load(offset.value)
  }
)
async function repair() {
  repairing.value = true
  error.value = ''
  try {
    repairTask = importReferenceFile({ projectId: props.projectId }, p => {
      repairProgress.value = p
    })
    await repairTask.promise
    await load()
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.value = String(cause)
  } finally {
    repairing.value = false
    repairTask = undefined
  }
}
async function analyse() {
  if (!data.value) return
  if (store.inputLocked) return
  await store.initialize()
  const session = props.sessionId ? store.sessions.find(s => s.id === props.sessionId) : undefined
  if (session) await store.selectSession(session)
  else {
    await store.newChat()
    await store.changeContext({ bookId: '' })
  }
  store.addReference({
    id: Number(data.value.projectId),
    kind: 'breakdown',
    title: data.value.title
  })
  store.draft = `@${data.value.title}\n\n请读取这本参考书已有的拆书结果，继续分析写法；尚未拆出的章节请注明，不要重复拆解。`
  emit('close')
  await router.push('/agent-pi')
}
onBeforeUnmount(() => {
  request++
  void repairTask?.cancel()
})
</script>
<style scoped>
.breakdown-results {
  color: var(--ink-main);
  line-height: 1.8;
}
.result-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.result-toolbar label {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 100%;
}
.result-toolbar select {
  max-width: 100%;
  padding: 8px;
  border: 1px solid var(--ui-border, #d8d1c5);
  border-radius: 6px;
  color: inherit;
  background: var(--input-bg, #faf7f1);
}
.coverage,
.repair-note {
  color: var(--ink-sec);
}
.repair-note {
  padding: 12px;
  background: var(--panel-bg, #f4f0e8);
  border-radius: 6px;
}
.chapter-result {
  border-top: 1px solid var(--ui-border, #d8d1c5);
  margin-top: 24px;
  padding-top: 16px;
}
.chapter-result ul {
  padding-left: 1.4em;
  margin: 8px 0;
}
.chapter-result h3 {
  font-size: calc(17px * var(--ui-font-scale, 1));
  margin: 0 0 8px;
}
dt {
  font-weight: 600;
}
dd {
  margin: 4px 0 8px;
}
.report summary {
  cursor: pointer;
  font-weight: 600;
}
@media (max-width: 600px) {
  .result-toolbar label {
    display: block;
  }
  .result-toolbar select {
    display: block;
    width: 100%;
  }
}
</style>
