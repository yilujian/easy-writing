<template>
  <section class="pi-resources-page" aria-label="写作资源">
    <div class="resource-toolbar">
      <input v-model="query" class="ink-input" aria-label="筛选资源" placeholder="按名称、问题或标签筛选" />
      <button class="ink-btn ink-btn-primary ink-btn-sm" :disabled="busy" @click="create">新增资源</button>
      <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="fileInput?.click()">导入资源包</button>
      <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy || !resources.length" @click="exportPacket">导出</button>
      <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="importPacket" />
    </div>
    <p class="resource-note">公共资源经人工核对和效果验证后才能推荐；作者私有材料可直接用于自己的任务。</p>
    <p v-if="error" class="pi-error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status" class="resource-note">{{ notice }}</p>
    <div class="resource-layout">
      <div class="resource-list" aria-label="资源列表">
        <p v-if="!filtered.length" class="resource-note">暂无匹配资源。可导入已整理的资源包，或新增自己的方法和案例。</p>
        <button v-for="item in filtered" :key="item.id" type="button" class="resource-row" :class="{ active: selected?.id === item.id }" :disabled="busy" @click="act(() => select(item))">
          <strong>{{ item.title }}</strong>
          <span>{{ item.problem }}</span>
          <small>{{ kindLabels[item.kind] }} · {{ scopeLabels[item.scope] }} · {{ item.enabled ? statusLabels[item.status] : '已停用' }} · 第 {{ item.version }} 版</small>
        </button>
      </div>
      <div v-if="form" class="resource-detail">
        <form @submit.prevent="save">
          <div class="resource-pair">
            <label>名称<input v-model="form.title" class="ink-input" required maxlength="120" /></label>
            <label>类别<select v-model="form.kind" class="ink-input"><option v-for="(label, value) in kindLabels" :key="value" :value="value">{{ label }}</option></select></label>
          </div>
          <div class="resource-pair">
            <label>使用范围<select v-model="form.scope" class="ink-input"><option value="author">作者私有</option><option value="book">仅所选作品</option><option value="public">公共候选资源</option></select></label>
            <label v-if="form.scope === 'book'">所属作品<select v-model="form.bookId" class="ink-input" required><option value="" disabled>选择作品</option><option v-for="book in store.books" :key="book.id" :value="book.id">{{ book.title }}</option></select></label>
          </div>
          <label>要解决的问题<textarea v-model="form.problem" class="ink-input" rows="2" required maxlength="1000" /></label>
          <div class="resource-pair">
            <label>适用条件（每行一项）<textarea v-model="conditions" class="ink-input" rows="3" /></label>
            <label>不适用情况（每行一项）<textarea v-model="exclusions" class="ink-input" rows="3" /></label>
          </div>
          <div class="resource-pair">
            <label>标签（每行一项）<textarea v-model="tags" class="ink-input" rows="2" /></label>
            <label>同义表达（每行一项）<textarea v-model="aliases" class="ink-input" rows="2" /></label>
          </div>
          <label>必要前情与后果<textarea v-model="form.context" class="ink-input" rows="3" maxlength="12000" /></label>
          <label>完整样本<textarea v-model="form.content" class="ink-input" rows="10" :disabled="form.source.rights === 'link_only'" maxlength="100000" placeholder="保留完整场景；仅链接材料不存原文" /></label>
          <label>方法说明与依据<textarea v-model="form.explanation" class="ink-input" rows="4" maxlength="12000" placeholder="区分观察、人工判断与尚未验证的假设" /></label>
          <fieldset>
            <legend>来源与使用范围</legend>
            <div class="resource-pair">
              <label>出处<input v-model="form.source.title" class="ink-input" required maxlength="300" /></label>
              <label>来源链接<input v-model="form.source.url" class="ink-input" type="url" maxlength="2000" placeholder="https://" /></label>
              <label>原文位置<input v-model="form.source.locator" class="ink-input" maxlength="1000" placeholder="章节、场景起止或段落" /></label>
              <label>来源版本<input v-model="form.source.version" class="ink-input" maxlength="200" /></label>
              <label>来源日期<input v-model="form.source.date" class="ink-input" maxlength="80" /></label>
              <label>材料使用方式<select v-model="form.source.rights" class="ink-input"><option value="original">原创示例</option><option value="licensed">授权材料</option><option value="link_only">仅链接与自行整理的说明</option></select></label>
            </div>
            <label>使用范围说明<textarea v-model="form.source.rightsNote" class="ink-input" rows="2" required maxlength="2000" /></label>
          </fieldset>
          <div class="resource-actions">
            <button class="ink-btn ink-btn-primary ink-btn-sm" :disabled="busy">{{ busy ? '处理中…' : selected ? '保存为新版本' : '保存资源' }}</button>
            <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy" @click="form = null; selected = null">关闭</button>
            <span v-if="selected" class="resource-note">改动材料后需重新人工核对和验证。</span>
          </div>
        </form>
        <section v-if="selected" class="resource-validation" aria-label="人工核对与效果验证">
          <h2>人工核对与效果验证</h2>
          <p>当前：{{ statusLabels[selected.status] }} · {{ selected.enabled ? '可在允许范围使用' : '已停用' }}</p>
          <p v-if="dirty" class="resource-note">有未保存的材料修改。请先保存新版本或重新载入，再记录验证结论。</p>
          <p v-if="selected.review" class="resource-note">原文核对：{{ selected.review.reviewer }} · {{ selected.review.notes }}</p>
          <div class="resource-pair">
            <label>核对人<input v-model="reviewer" class="ink-input" maxlength="100" /></label>
            <label>核对依据与结论<input v-model="reviewNotes" class="ink-input" maxlength="4000" placeholder="原文是否完整、解释是否准确、使用范围是否清楚" /></label>
          </div>
          <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy || dirty || !reviewer.trim() || !reviewNotes.trim()" @click="review">记录人工核对</button>
          <details class="resource-evaluation-form">
            <summary>记录一次人工效果验证</summary>
            <label>评价人<input v-model="evaluation.reviewer" class="ink-input" maxlength="100" /></label>
            <label>模型与设置<input v-model="evaluation.model" class="ink-input" maxlength="300" /></label>
            <label>测试任务与输入<textarea v-model="evaluation.task" class="ink-input" rows="2" maxlength="2000" /></label>
            <label>验证支持的范围<textarea v-model="evaluation.scope" class="ink-input" rows="2" maxlength="1000" /></label>
            <label>原始输出位置（每行一项）<textarea v-model="outputRefs" class="ink-input" rows="2" placeholder="盲评材料文件名或记录位置" /></label>
            <label>比较结论<select v-model="evaluation.conclusion" class="ink-input"><option value="supports">支持在此范围使用</option><option value="mixed">无明显改善或意见不一致</option><option value="unsupported">不支持此用法</option></select></label>
            <label class="resource-check"><input v-model="evaluation.hasFactIssues" type="checkbox" />存在尚未处理的事实问题</label>
            <label>比较理由与不足<textarea v-model="evaluation.notes" class="ink-input" rows="3" maxlength="6000" /></label>
            <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy || dirty || !selected.review" @click="evaluate">保存验证记录</button>
          </details>
          <ul v-if="selected.evaluations.length" class="resource-evaluations"><li v-for="item in selected.evaluations" :key="item.id">{{ item.reviewer }} · {{ item.model }} · {{ conclusionLabels[item.conclusion] }}<p>{{ item.scope }}：{{ item.notes }}</p></li></ul>
          <div class="resource-actions">
            <button class="ink-btn ink-btn-primary ink-btn-sm" :disabled="busy || dirty || !canRecommendResource(selected)" @click="changeStatus('recommended')">设为可推荐</button>
            <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy || dirty" @click="changeStatus('not_recommended')">暂不推荐</button>
            <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="busy || dirty" @click="toggleEnabled">{{ selected.enabled ? '停用条目' : '启用条目' }}</button>
          </div>
          <details v-if="history.length"><summary>历史版本（{{ history.length }}）</summary><article v-for="item in [...history].reverse()" :key="item.version"><strong>第 {{ item.version }} 版 · {{ statusLabels[item.status] }}</strong><p>{{ item.problem }}</p><pre>{{ item.content || item.explanation }}</pre></article></details>
        </section>
      </div>
    </div>
    <details v-if="usage.length" class="resource-usage"><summary>当前对话的资源使用记录（{{ usage.length }}）</summary><ol><li v-for="item in usage" :key="item.id">{{ item.kind === 'search' ? `查询：${item.query}` : `读取：${item.read?.title} · 第 ${item.read?.version} 版` }}<p>{{ item.kind === 'search' ? `候选：${item.candidates.map(c => c.title).join('、') || '无匹配'}` : item.read?.reason || '未填写理由' }}</p></li></ol></details>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePiWorkspace } from './use-pi-workspace'
import { canRecommendResource, evaluateWritingResource, exportWritingResources, getWritingResourceRecord, importWritingResources, listResourceUsage, listWritingResources, normalizeResourceInput, reviewWritingResource, saveWritingResource, setWritingResourceEnabled, setWritingResourceStatus } from '@/agent-pi/writing-resources'
import type { ResourceEvaluation, ResourceUsage, WritingResource, WritingResourceInput, WritingResourceStatus } from '@/types/writing-resource'
const store = usePiWorkspace()
const kindLabels = { technique: '写作技巧', case: '叙事案例', style: '文风样本', market: '市场资料' }
const scopeLabels = { author: '作者私有', book: '作品私有', public: '公共候选' }
const statusLabels = { pending_review: '待核对', pending_validation: '待验证', recommended: '可推荐', not_recommended: '暂不推荐' }
const conclusionLabels = { supports: '支持此用法', mixed: '结论不明确', unsupported: '不支持此用法' }
const resources = ref<WritingResource[]>([]), selected = ref<WritingResource | null>(null), history = ref<WritingResource[]>([])
const form = ref<WritingResourceInput | null>(null), query = ref(''), busy = ref(false), error = ref(''), notice = ref('')
const conditions = ref(''), exclusions = ref(''), tags = ref(''), aliases = ref(''), reviewer = ref(''), reviewNotes = ref(''), outputRefs = ref('')
const usage = ref<ResourceUsage[]>([]), fileInput = ref<HTMLInputElement>()
const evaluation = ref<Omit<ResourceEvaluation, 'id' | 'materialVersion' | 'at'>>({ reviewer: '', model: '', task: '', scope: '', conclusion: 'mixed', hasFactIssues: false, notes: '', outputRefs: [] })
const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const filtered = computed(() => resources.value.filter(item => `${item.title} ${item.problem} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const input = () => ({ ...form.value!, conditions: lines(conditions.value), exclusions: lines(exclusions.value), tags: lines(tags.value), aliases: lines(aliases.value) })
const dirty = computed(() => {
  if (!selected.value || !form.value) return false
  try { return JSON.stringify(normalizeResourceInput(input())) !== JSON.stringify(normalizeResourceInput(selected.value)) } catch { return true }
})
async function refresh() { resources.value = await listWritingResources(); usage.value = await listResourceUsage(store.sessionId) }
async function act(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await work() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false }
}
function setForm(item: WritingResourceInput) { form.value = JSON.parse(JSON.stringify(item)); conditions.value = item.conditions.join('\n'); exclusions.value = item.exclusions.join('\n'); tags.value = item.tags.join('\n'); aliases.value = item.aliases.join('\n') }
async function select(item: WritingResource) { selected.value = item; setForm(item); history.value = (await getWritingResourceRecord(item.id))?.history || []; reviewer.value = ''; reviewNotes.value = '' }
function create() {
  selected.value = null; history.value = []; error.value = ''
  setForm({ title: '', kind: 'case', problem: '', conditions: [], exclusions: [], tags: [], aliases: [], context: '', content: '', explanation: '', scope: 'author', bookId: '', source: { title: '', url: '', locator: '', version: '', date: '', rights: 'original', rightsNote: '' } })
}
async function update(item: WritingResource) { await refresh(); await select(item) }
const save = () => act(async () => { await update(await saveWritingResource(input(), selected.value?.id, selected.value?.version)); notice.value = '已保存。材料更新后，原验证结论保留在历史版本中。' })
const review = () => act(async () => { if (selected.value && !dirty.value) await update(await reviewWritingResource(selected.value.id, selected.value.version, reviewer.value, reviewNotes.value)) })
const evaluate = () => act(async () => { if (selected.value && !dirty.value) await update(await evaluateWritingResource(selected.value.id, selected.value.version, { ...evaluation.value, outputRefs: lines(outputRefs.value) })) })
const changeStatus = (status: WritingResourceStatus) => act(async () => { if (selected.value && !dirty.value) await update(await setWritingResourceStatus(selected.value.id, selected.value.version, status)) })
const toggleEnabled = () => act(async () => { if (selected.value && !dirty.value) await update(await setWritingResourceEnabled(selected.value.id, selected.value.version, !selected.value.enabled)) })
async function importPacket(event: Event) {
  const control = event.target as HTMLInputElement, file = control.files?.[0]; if (!file) return
  await act(async () => { if (file.size > 12 * 1024 * 1024) throw new Error('资源包不能超过 12 MB'); const result = await importWritingResources(JSON.parse(await file.text()), store.bookId); await refresh(); notice.value = `导入 ${result.imported} 条，已存在 ${result.skipped} 条；导入内容均待人工核对。` }); control.value = ''
}
const exportPacket = () => act(async () => {
  const blob = new Blob([JSON.stringify(await exportWritingResources(), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = '写作资源.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
})
onMounted(() => act(refresh))
</script>
<style scoped lang="scss">
.pi-resources-page { flex: 1; overflow: auto; padding: 24px; min-width: 0; color: var(--pi-ink); }
.resource-toolbar, .resource-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.resource-toolbar > input { flex: 1; min-width: 180px; }
.resource-note, .resource-row small { color: var(--pi-muted); font-size: 13px; }
.resource-note { margin: 10px 0; }
.resource-layout { display: grid; grid-template-columns: minmax(220px, 30%) minmax(0, 1fr); gap: 24px; margin-top: 20px; align-items: start; }
.resource-list { display: grid; gap: 8px; }
.resource-row { display: grid; gap: 5px; width: 100%; text-align: left; padding: 14px; border: 1px solid var(--pi-line); background: var(--pi-bg); border-radius: 8px; cursor: pointer; }
.resource-row.active { border-color: var(--pi-accent); background: var(--pi-soft); }
.resource-row span { font-size: 14px; overflow-wrap: anywhere; }
.resource-detail { min-width: 0; }
.resource-detail form, .resource-detail fieldset, .resource-evaluation-form { display: grid; gap: 14px; }
.resource-detail label { display: grid; gap: 5px; font-size: 14px; min-width: 0; }
.resource-detail label.resource-check { display: flex; align-items: center; }
.resource-detail .ink-input { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--pi-line); border-radius: 6px; background: var(--pi-bg); color: var(--pi-ink); font: inherit; }
.resource-detail textarea { resize: vertical; line-height: 1.65; }
.resource-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.resource-detail fieldset { padding: 14px; border: 1px solid var(--pi-line); border-radius: 8px; }
.resource-validation { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--pi-line); display: grid; gap: 12px; }
.resource-validation h2 { font-size: 18px; }
.resource-validation p { margin: 4px 0; }
.resource-validation summary, .resource-usage summary { cursor: pointer; padding: 8px 0; }
.resource-validation pre { max-height: 250px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.resource-evaluation-form > label { margin: 10px 0; }
.resource-evaluations, .resource-usage { font-size: 14px; overflow-wrap: anywhere; }
.resource-usage { margin-top: 24px; }
@media (max-width: 900px) { .pi-resources-page { padding: 16px; } .resource-layout { grid-template-columns: 1fr; } .resource-list { max-height: 270px; overflow: auto; } }
@media (max-width: 560px) { .resource-pair { grid-template-columns: 1fr; } }
</style>
