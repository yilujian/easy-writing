<template>
  <main class="local-center">
    <header class="center-header">
      <div><p class="eyebrow">EASY WRITING / LOCAL</p><h1>本地中心</h1><p>安心写作，也让作品在硬盘上留一份。</p></div>
      <el-button :loading="checking" @click="refresh">刷新连接</el-button>
    </header>
    <section class="status-grid">
      <article><i class="fa-solid fa-plug" /><span>本地服务</span><strong>{{ state.available ? '已连接' : '未连接' }}</strong><p>{{ state.available ? '模型请求通过本机转发' : '请通过启动器打开本地增强版' }}</p></article>
      <article><i class="fa-solid fa-box-archive" /><span>硬盘快照</span><strong>{{ state.backups.length }} <small>/ 30 份</small></strong><p>每 5 分钟检查，内容变化时保存</p></article>
      <article><i class="fa-regular fa-clock" /><span>最近备份</span><strong class="time-value">{{ date(state.backups[0]?.createdAt) }}</strong><p>{{ state.busy ? '正在保存当前章节并备份…' : '可恢复为新作品，保留现有稿件' }}</p></article>
    </section>
    <el-alert v-if="state.error" :title="state.error" type="error" show-icon :closable="false" class="notice" />
    <el-alert v-if="!state.available" title="当前仍可写作；硬盘备份和模型转发需要本地启动器运行。" type="warning" show-icon :closable="false" class="notice" />
    <section class="backup-card">
      <div class="section-head"><div><h2>作品备份</h2><p>包含未删除作品的目录、正文和大纲 / 角色 / 设定 / 时间线 / 故事线。</p></div><el-button type="primary" :loading="state.busy" :disabled="!state.available" @click="backup">立即备份</el-button></div>
      <div class="path-box"><i class="fa-regular fa-folder-open" /><code>{{ state.backupDir || '连接后显示备份文件夹' }}</code></div>
      <p class="scope-note">不包含 API Key、模型配置、聊天记录、历史版本、灵感素材及回收站。页面关闭后停止定时备份；退出前建议点一次「立即备份」。</p>
      <el-table :data="state.backups" empty-text="还没有硬盘快照。创建作品后，点「立即备份」。" :max-height="380">
        <el-table-column label="保存时间" min-width="180"><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column>
        <el-table-column label="大小" width="110"><template #default="{ row }">{{ size(row.bytes) }}</template></el-table-column>
        <el-table-column label="操作" width="200"><template #default="{ row }"><el-button link type="primary" :disabled="loadingSnapshot" @click="inspect(row)">查看与恢复</el-button><el-button link :disabled="loadingSnapshot" @click="download(row)">下载</el-button></template></el-table-column>
      </el-table>
      <div class="import-row"><span>已有本地增强版快照？</span><el-button @click="fileInput?.click()">从文件查看与恢复</el-button><input ref="fileInput" type="file" accept=".json,application/json" hidden @change="openFile" /></div>
    </section>
    <section class="quick-grid">
      <article><h2>连接你自己的模型</h2><p>在模型管理中填入 Base URL、模型名和密钥。Ollama、LM Studio 可留空密钥；本地转发支持流式输出和取消。</p><el-button @click="router.push('/aiModels')">打开模型管理</el-button><p class="scope-note">使用外部模型时，发送的内容会交给你配置的服务商；使用本机模型可离线创作。</p></article>
      <article><h2>快捷进入写作</h2><p>按 Ctrl / ⌘ + K 搜索作品或功能。单本 TXT / JSON 的导入导出仍在「我的作品」中。</p><el-button @click="router.push('/myBooks')">回到我的作品</el-button><p class="scope-note">请固定使用 127.0.0.1:6789 和同一浏览器。换浏览器或清理数据后，可从硬盘快照恢复作品。</p></article>
    </section>
    <el-dialog v-model="dialogVisible" title="查看与恢复快照" width="min(720px, 94vw)" :close-on-click-modal="!restoring" :show-close="!restoring" :close-on-press-escape="!restoring">
      <p>选择一部作品恢复。会创建带「恢复」标记的新作品，现有作品不变。正文按原项目导入器恢复为文本，参考资料一并导入。</p>
      <el-table :data="snapshot?.books || []" empty-text="此快照没有作品" max-height="360">
        <el-table-column label="作品" min-width="180"><template #default="{ row }">{{ row.book.title }}</template></el-table-column>
        <el-table-column label="章节" width="80"><template #default="{ row }">{{ row.chapters.length }}</template></el-table-column>
        <el-table-column label="操作" width="140"><template #default="{ row }"><el-button type="primary" link :disabled="restoring" @click="restore(row)">恢复为新作品</el-button></template></el-table-column>
      </el-table>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { localBackupState as state, hasLocalCompanion, backupBooksToDisk, companionRequest, type DiskBackup, type BookSnapshot } from '@/utils/local-companion'
import { previewLocalBookImport, importLocalBookFromPreview } from '@/storage/local-library'
import type { LocalExportPayload } from '@/storage/local-library-types'
const router = useRouter()
const checking = ref(false), loadingSnapshot = ref(false), restoring = ref(false), dialogVisible = ref(false)
const snapshot = ref<BookSnapshot | null>(null), fileInput = ref<HTMLInputElement | null>(null)
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录'
const size = (n: number) => n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const report = (error: unknown) => ElMessage.error(error instanceof Error ? error.message : '操作失败，请重试')
async function refresh() { checking.value = true; try { await hasLocalCompanion(true) } finally { checking.value = false } }
async function backup() { try { await backupBooksToDisk(); ElMessage.success('已确认作品硬盘备份') } catch (error) { report(error) } }
function validate(value: BookSnapshot) {
  if (value?.format !== 'easy-writing-local-books' || value.version !== 1 || !Array.isArray(value.books) || value.books.some(b => b?.version !== 1 || typeof b.book?.title !== 'string' || !Array.isArray(b.chapters) || !Array.isArray(b.volumes))) throw new Error('这不是有效的本地增强版快照。单本作品 JSON 请在「我的作品」导入。')
  snapshot.value = value; dialogVisible.value = true
}
async function inspect(row: DiskBackup) {
  loadingSnapshot.value = true
  try { validate(await (await companionRequest(`backups/${row.id}`)).json()) } catch (error) { report(error) } finally { loadingSnapshot.value = false }
}
async function download(row: DiskBackup) {
  loadingSnapshot.value = true
  try {
    const blob = await (await companionRequest(`backups/${row.id}`)).blob()
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = row.id; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) { report(error) } finally { loadingSnapshot.value = false }
}
async function openFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  try { if (file) { if (file.size > 100 * 1024 * 1024) throw new Error('快照不能超过 100 MB'); validate(JSON.parse(await file.text())) } } catch (error) { report(error) } finally { input.value = '' }
}
async function restore(book: LocalExportPayload) {
  try { await ElMessageBox.confirm(`将「${book.book.title}」恢复为新作品？`, '恢复作品', { confirmButtonText: '恢复为新作品', cancelButtonText: '取消', type: 'info' }) } catch { return }
  restoring.value = true
  try {
    const file = new File([JSON.stringify(book)], 'book.json', { type: 'application/json' })
    const preview = await previewLocalBookImport(file)
    await importLocalBookFromPreview(preview, { title: `${book.book.title}（恢复 ${new Date().toLocaleDateString('zh-CN')}）` })
    ElMessage.success('已恢复为新作品，可在「我的作品」查看')
  } catch (error) { report(error) } finally { restoring.value = false }
}
onMounted(refresh)
</script>
<style scoped>
.local-center { max-width: 1260px; margin: 0 auto; padding: 32px; color: var(--ink-main); overflow-y: auto; height: 100%; box-sizing: border-box; }
.center-header,.section-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
h1 { font-size: 30px; margin: 8px 0 12px; } h2 { font-size: 19px; margin: 0 0 12px; }
p { color: var(--ink-secondary, var(--ink-main)); font-size: 15px; line-height: 1.8; margin: 8px 0; }
.eyebrow { font-size: 12px; letter-spacing: .15em; color: var(--ink-accent); }
.status-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; margin: 28px 0; }
article,.backup-card { background: var(--surface-1); border: 1px solid var(--divider); border-radius: 12px; padding: 24px; }
.status-grid article { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
.status-grid i { color: var(--ink-accent); font-size: 20px; margin-bottom: 4px; }
.status-grid span { font-size: 14px; }.status-grid strong { font-size: 28px; }.status-grid small { font-size: 14px; font-weight: 400; }.status-grid .time-value { font-size: 19px; line-height: 1.6; }
.status-grid p { font-size: 14px; margin: 0; }.notice { margin-bottom: 18px; }
.path-box { display: flex; align-items: center; gap: 12px; margin: 20px 0 10px; padding: 15px; background: var(--bg-main); border-radius: 6px; }.path-box code { overflow-wrap: anywhere; font-size: 14px; }
.scope-note { font-size: 13px; margin: 12px 0 20px; }.quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }.quick-grid .el-button { margin-top: 10px; }
.import-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding-top: 22px; font-size: 14px; }
@media(max-width:900px) { .local-center { padding: 20px; }.status-grid { grid-template-columns: 1fr; gap: 12px; }.quick-grid { grid-template-columns: 1fr; }.center-header,.section-head { align-items: flex-start; flex-wrap: wrap; } }
</style>
