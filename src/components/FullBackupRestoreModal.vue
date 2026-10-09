<template>
  <EwModal
    v-model:visible="visibleProxy" title="一键恢复" width="640px" max-height="85vh"
    custom-class="full-restore-modal" :close-on-click-modal="false" :show-close="!busy && !restartRequired && !done"
  >
    <div class="full-restore-body">
      <p class="restore-hint">选择由“一键备份”生成的 .zip 文件。恢复完成后应用会重新启动。</p>
      <div class="restore-file">
        <span :title="filePath">{{ filePath || '尚未选择备份文件' }}</span>
        <button class="ink-btn ink-btn-outline" type="button" :disabled="busy || done || restartRequired" @click="chooseFile">
          <i :class="opening ? 'fa-solid fa-spinner fa-spin' : 'fa-regular fa-folder-open'"></i>
          {{ opening ? '读取中…' : '选择文件' }}
        </button>
      </div>
      <p v-if="error" class="restore-error" role="alert">{{ error }}</p>

      <template v-if="inspection && !done && !restartRequired">
        <dl class="restore-summary">
          <div><dt>备份时间</dt><dd>{{ formatLocaleDateTime(inspection.manifest.createdAt, '未知') }}</dd></div>
          <div><dt>来源版本</dt><dd>{{ inspection.manifest.appVersion || '未知' }} · {{ inspection.manifest.platform }}</dd></div>
          <div><dt>作品</dt><dd>{{ counts.books }} 本 · {{ counts.chapters }} 章 · 版本历史 {{ counts.versions }} 条</dd></div>
          <div><dt>资料</dt><dd>{{ idbSummary }}</dd></div>
          <div><dt>其它</dt><dd>字体 {{ counts.fonts }} 个 · 提示词文档 {{ inspection.promptCount }} 个 · 配置项 {{ counts.localStorageKeys }} 项</dd></div>
        </dl>

        <div class="restore-modes">
          <label class="restore-mode" :class="{ active: mode === 'overwrite' }">
            <input v-model="mode" type="radio" value="overwrite" :disabled="busy" />
            <span>
              <strong>完整覆盖</strong>
              <small>清空本机现有数据，整个工作台回到备份时的状态。适合换机器、重装后找回全部内容。</small>
            </span>
          </label>
          <label class="restore-mode" :class="{ active: mode === 'merge' }">
            <input v-model="mode" type="radio" value="merge" :disabled="busy" />
            <span>
              <strong>合并到现有数据</strong>
              <small>备份里的作品连同参考资料、工作流、妙笔对话作为新记录加入，本机作品不动；编号冲突自动换号。界面与写作设置、自定义背景以备份为准，模型配置、AI 记录、拆书项目按编号补缺，本机已有的灵感、敏感词等保留。</small>
            </span>
          </label>
        </div>
        <label v-if="mode === 'overwrite'" class="restore-safety">
          <el-switch v-model="safetyBackup" size="small" :disabled="busy" />
          <span>恢复前先把当前数据完整备份到备份目录（推荐，误操作可以再恢复回来）</span>
        </label>
        <p v-if="progress" class="restore-progress"><i class="fa-solid fa-spinner fa-spin"></i> {{ progress }}</p>
      </template>

      <div v-if="done && report" class="restore-done">
        <p><i class="fa-solid fa-circle-check"></i> 恢复完成：作品 {{ report.books }} 本、章节 {{ report.chapters }} 章、版本历史 {{ report.versions }} 条、字体 {{ report.fonts }} 个、提示词文档 {{ report.prompts }} 个。</p>
        <p v-if="reportIdbSummary">{{ reportIdbSummary }}</p>
        <p v-for="warning in report.warnings" :key="warning" class="restore-done-path">{{ warning }}</p>
        <p v-if="report.safetyBackupPath" class="restore-done-path">恢复前的安全备份：{{ report.safetyBackupPath }}</p>
        <p>需要重新启动应用才能加载恢复后的数据。</p>
      </div>
    </div>
    <template #footer>
      <div class="restore-footer">
        <button v-if="!done && !restartRequired" class="ink-btn ink-btn-outline" type="button" :disabled="busy" @click="close">取消</button>
        <button v-if="!done && !restartRequired" class="ink-btn ink-btn-primary" type="button" :disabled="!inspection || busy" @click="restore">
          <i v-if="restoring" class="fa-solid fa-spinner fa-spin"></i>
          {{ restoring ? '恢复中…' : '开始恢复' }}
        </button>
        <button v-else class="ink-btn ink-btn-primary" type="button" @click="restartApp">
          <i class="fa-solid fa-rotate-right"></i> 重新启动应用
        </button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import EwModal from '@/components/EwModal/index.vue'
import { inkConfirm } from '@/utils/ink-confirm'
import { formatLocaleDateTime } from '@/utils/format'
import { getLocalBackupService } from '@/storage/local-backup-service'
import {
  applyFullBackup,
  RestoreRestartRequiredError,
  buildFullBackupFileName,
  closeFullBackup,
  openFullBackup,
  type FullBackupInspection,
  type FullRestoreMode,
  type FullRestoreReport,
} from '@/storage/full-backup'
import { IDB_STORES } from '@/storage/full-backup-idb'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()

const filePath = ref('')
const opening = ref(false)
const restoring = ref(false)
const error = ref('')
const restartRequired = ref(false)
const progress = ref('')
const mode = ref<FullRestoreMode>('overwrite')
const safetyBackup = ref(true)
const inspection = shallowRef<FullBackupInspection | null>(null)
const report = shallowRef<FullRestoreReport | null>(null)
const done = computed(() => Boolean(report.value))
const busy = computed(() => opening.value || restoring.value)
const counts = computed(() => inspection.value?.manifest.counts || { books: 0, chapters: 0, versions: 0, fonts: 0, localStorageKeys: 0 })
/** 清单里 IndexedDB 各库的计数拼成一行，如"参考资料 2 本 · 工作流 1 条"；全为 0 的库不显示 */
const describeIdbCounts = (values: Record<string, number> | undefined) => {
  if (!values) return ''
  const units: Record<string, string> = { reference: '本', workflow: '条', chat: '个', 'ai-records': '条', breakdown: '个', 'ai-images': '张', skin: '张', rank: '份' }
  return IDB_STORES
    .filter(spec => (values[spec.name] || 0) > 0)
    .map(spec => `${spec.label} ${values[spec.name]} ${units[spec.name] || '条'}`)
    .join(' · ')
}
const idbSummary = computed(() => {
  const values = inspection.value?.manifest.counts.idb
  if (!values) return '旧版本生成的备份，不含参考资料、工作流等资料'
  return describeIdbCounts(values) || '无'
})
const reportIdbSummary = computed(() => {
  const text = describeIdbCounts(report.value?.idb)
  return text ? `已写入：${text}。` : ''
})
const visibleProxy = computed({
  get: () => props.visible,
  set: (value: boolean) => {
    if (busy.value) return
    if (!value) void releaseSession()
    emit('update:visible', value)
  },
})

const releaseSession = async () => {
  const current = inspection.value
  inspection.value = null
  if (current && !done.value) await closeFullBackup(current.session)
}

const chooseFile = async () => {
  if (busy.value) return
  error.value = ''
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    title: '选择一键备份文件',
    multiple: false,
    directory: false,
    filters: [{ name: '易创备份', extensions: ['zip'] }],
  })
  if (!selected || Array.isArray(selected)) return
  opening.value = true
  try {
    await releaseSession()
    filePath.value = selected
    inspection.value = await openFullBackup(selected)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    opening.value = false
  }
}

const restore = async () => {
  const current = inspection.value
  if (!current || busy.value) return
  if (mode.value === 'overwrite') {
    try {
      await inkConfirm('完整覆盖会清空本机现有的作品、正文、设置和统计，全部替换成备份里的内容。确定继续吗？', '确认完整覆盖', {
        confirmButtonText: '覆盖恢复',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }
  }
  restoring.value = true
  error.value = ''
  try {
    let safetyBackupPath = ''
    if (mode.value === 'overwrite' && safetyBackup.value) {
      const settings = await getLocalBackupService().getSettings()
      const { join } = await import('@tauri-apps/api/path')
      safetyBackupPath = await join(settings.backupDir, buildFullBackupFileName().replace('易创全量备份', '易创安全备份'))
    }
    report.value = await applyFullBackup(current, mode.value, {
      safetyBackupPath,
      onProgress: text => {
        progress.value = text
      },
    })
    inspection.value = null
  } catch (cause) {
    restartRequired.value = cause instanceof RestoreRestartRequiredError
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    restoring.value = false
    progress.value = ''
  }
}

const restartApp = async () => {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_app')
  } catch {
    window.location.reload()
  }
}

const close = () => {
  visibleProxy.value = false
}

onBeforeUnmount(() => {
  void releaseSession()
})
</script>

<style scoped lang="scss">
.full-restore-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 8px;
  color: var(--ink-main);
}

.restore-hint {
  margin: 0;
  font-size: 13px;
  color: var(--ink-sec);
}

.restore-file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px dashed var(--ui-border-hover);
  border-radius: 8px;
  background: var(--input-bg);

  span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--ink-sec);
  }
}

.restore-error {
  margin: 0;
  font-size: 13px;
  color: var(--state-danger);
}

.restore-summary {
  margin: 0;
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 13px;

  div {
    display: flex;
    gap: 12px;
  }

  dt {
    flex: 0 0 64px;
    color: var(--ink-sec);
  }

  dd {
    margin: 0;
    color: var(--ink-main);
  }
}

.restore-modes {
  display: grid;
  gap: 8px;
}

.restore-mode {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--card-bg);
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;

  &.active {
    border-color: color-mix(in srgb, var(--ink-accent) 55%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink-accent) 25%, transparent) inset;
  }

  input {
    margin-top: 3px;
    accent-color: var(--ink-accent);
  }

  span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  strong {
    font-size: 14px;
    color: var(--ink-main);
  }

  small {
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-sec);
  }
}

.restore-safety {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--ink-sec);
}

.restore-progress {
  margin: 0;
  font-size: 13px;
  color: var(--ink-accent);
}

.restore-done {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--state-success-surface);
  color: var(--state-success-on, var(--ink-main));
  font-size: 13px;
  line-height: 1.7;

  p {
    margin: 0;
  }

  i {
    margin-right: 6px;
    color: var(--state-success);
  }
}

.restore-done-path {
  word-break: break-all;
  color: var(--ink-sec);
}

.restore-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
