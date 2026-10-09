<template>
          <section class="settings-pane">
            <section class="settings-card sync-status-card">
              <div class="cloud-badge"><i class="fa-solid fa-hard-drive"></i></div>
              <div class="sync-status-main">
                <span>保存方式</span>
                <strong>全部内容保存在本机</strong>
                <small>最近本地备份：{{ formatLocaleDateTime(settingsDraft.lastBackupAt, '暂无') }}</small>
                <small>当前设备：{{ desktopSupported ? '桌面客户端' : '浏览器' }}</small>
              </div>
              <div class="sync-mode-box">
                <p class="hint-line">正文边写边存本机，关闭窗口时自动生成快照；异常退出后重新打开即可恢复。</p>
              </div>
            </section>

            <section v-if="usingLegacyStorage" class="settings-card">
              <div class="settings-card-title"><i class="fa-solid fa-database"></i><strong>正在使用原有数据</strong></div>
              <p class="hint-line">上次数据升级未完成，作品仍按原来的方式保存。你可以继续写作，也可以保存后重新尝试升级。</p>
              <div class="action-row">
                <button class="ink-btn ink-btn-outline" type="button" :disabled="retryingUpgrade" @click="retryUpgrade">
                  {{ retryingUpgrade ? '正在保存并重启…' : '重试数据升级' }}
                </button>
              </div>
            </section>

            <section class="settings-card local-backup-card">
              <div class="settings-card-title">
                <i class="fa-solid fa-database"></i>
                <strong>本地备份</strong>
              </div>
              <div class="backup-form-grid">
                <label class="field-line wide">
                  <span>备份目录</span>
                  <div class="path-box">{{ settingsDraft.backupDir || (desktopSupported ? '读取中...' : '桌面客户端支持目录管理') }}</div>
                </label>
                <label class="field-line">
                  <span>自动备份频率</span>
                  <el-select
                    v-model="settingsDraft.backupInterval"
                    size="small"
                    class="settings-inline-select"
                    popper-class="settings-select-popper"
                  >
                    <el-option label="每 10 分钟" value="10m" />
                    <el-option label="每 20 分钟" value="20m" />
                    <el-option label="每 30 分钟" value="30m" />
                  </el-select>
                </label>
                <label class="field-line">
                  <span>保留份数</span>
                  <el-input-number v-model="settingsDraft.backupRetention" :min="1" :max="100" size="small" />
                </label>
              </div>
              <p class="hint-line">备份内容：有改动的章节正文，以及各书的参考数据（大纲/角色/设定/时间线/故事线）。</p>
              <div class="action-row">
                <button class="ink-btn ink-btn-outline" type="button" :disabled="!desktopSupported || loading" @click="changeBackupDir">
                  <i class="fa-solid fa-folder-open"></i> 修改目录
                </button>
                <button class="ink-btn ink-btn-outline" type="button" :disabled="!desktopSupported || loading" @click="openBackupDir">
                  <i class="fa-regular fa-folder-open"></i> 打开目录
                </button>
                <button class="ink-btn ink-btn-primary" type="button" :disabled="!canBackupNow" @click="backupNow">
                  <i v-if="backingUp" class="fa-solid fa-spinner fa-spin"></i>
                  <i v-else class="fa-solid fa-cloud-arrow-up"></i>
                  立即备份
                </button>
                <button class="ink-btn ink-btn-outline" type="button" :disabled="!desktopSupported || loading || backingUp" @click="restoreVisible = true">
                  <i class="fa-solid fa-clock-rotate-left"></i> 恢复备份
                </button>
              </div>
              <p v-if="backupError" class="error-line">{{ backupError }}</p>
            </section>
            <section class="settings-card full-backup-card">
              <div class="settings-card-title">
                <i class="fa-solid fa-box-archive"></i>
                <strong>一键备份与恢复</strong>
              </div>
              <p class="hint-line">把本机的全部内容打成一个 .zip 文件：作品与正文、章节版本历史、参考资料、提示词库、模型配置（含 API Key）、界面与写作设置、码字统计、导入的字体。</p>
              <p class="hint-line">恢复时可选“完整覆盖”或“合并到现有数据”。备份文件含明文 API Key，请妥善保管。</p>
              <div class="action-row">
                <button class="ink-btn ink-btn-primary" type="button" :disabled="!desktopSupported || loading || fullBackingUp" @click="backupEverything">
                  <i v-if="fullBackingUp" class="fa-solid fa-spinner fa-spin"></i>
                  <i v-else class="fa-solid fa-file-zipper"></i>
                  {{ fullBackingUp ? (fullProgress || '备份中…') : '一键备份' }}
                </button>
                <button class="ink-btn ink-btn-outline" type="button" :disabled="!desktopSupported || loading || fullBackingUp" @click="fullRestoreVisible = true">
                  <i class="fa-solid fa-rotate-left"></i> 一键恢复
                </button>
              </div>
              <p v-if="fullBackupError" class="error-line">{{ fullBackupError }}</p>
            </section>
            <BackupRestoreModal v-if="restoreVisible" v-model:visible="restoreVisible" @view-books="viewRestoredBooks" />
            <FullBackupRestoreModal v-if="fullRestoreVisible" v-model:visible="fullRestoreVisible" />
          </section>
</template>

<script setup lang="ts">
import { getStorageMode } from '@/storage/storage-mode'
import { retryStorageUpgrade } from '@/storage/storage-upgrade'
import { inkConfirm } from '@/utils/ink-confirm'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import BackupRestoreModal from '@/components/BackupRestoreModal.vue'
import FullBackupRestoreModal from '@/components/FullBackupRestoreModal.vue'
import { buildFullBackupFileName, createFullBackup } from '@/storage/full-backup'
import { ElMessage } from 'element-plus'
import { getLocalBackupService } from '@/storage/local-backup-service'
import { formatLocaleDateTime } from '@/utils/format'
import { useSettingsCenterCtx } from '../settings-context'

const ctx = useSettingsCenterCtx()
const { settingsDraft, loading } = ctx
const desktopSupported = ctx.desktopSupported
const usingLegacyStorage = desktopSupported && getStorageMode().mode === 'legacy'
const retryingUpgrade = ref(false)
const retryUpgrade = async () => {
  try {
    await inkConfirm('将先保存当前内容，再重启尝试升级数据。升级未完成时仍可继续使用原有数据。', '重试数据升级', {
      confirmButtonText: '保存并重启', cancelButtonText: '取消', type: 'info',
    })
  } catch { return }
  retryingUpgrade.value = true
  try { await retryStorageUpgrade() }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); retryingUpgrade.value = false }
}
const backupService = getLocalBackupService()
const router = useRouter()
const restoreVisible = ref(false)
const viewRestoredBooks = async () => {
  restoreVisible.value = false
  ctx.close()
  await router.push({ path: '/myBooks', query: { restored: String(Date.now()) } })
}

const backingUp = ref(false)
const backupError = ref('')

const fullRestoreVisible = ref(false)
const fullBackingUp = ref(false)
const fullProgress = ref('')
const fullBackupError = ref('')

const backupEverything = async () => {
  if (fullBackingUp.value) return
  fullBackupError.value = ''
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { join } = await import('@tauri-apps/api/path')
  const defaultDir = settingsDraft.value.backupDir || (await backupService.getDefaultBackupDir())
  const target = await save({
    title: '保存一键备份',
    defaultPath: defaultDir ? await join(defaultDir, buildFullBackupFileName()) : buildFullBackupFileName(),
    filters: [{ name: '易创备份', extensions: ['zip'] }],
  })
  if (!target) return
  fullBackingUp.value = true
  fullProgress.value = ''
  try {
    // 先让打开中的编辑器把正文落盘，备份里才是最新内容
    const snapshotted = await backupService.snapshotActiveWritingEditor()
    if (!snapshotted) {
      fullBackupError.value = '当前章节保存到本地失败，未执行一键备份'
      return
    }
    const summary = await createFullBackup(target, text => {
      fullProgress.value = text
    })
    settingsDraft.value = await backupService.saveSettings({ ...settingsDraft.value, lastBackupAt: Date.now() })
    ElMessage.success(`已备份到 ${summary.path}（${(summary.bytes / 1024 / 1024).toFixed(1)} MB）`)
    if (summary.warnings?.length) {
      ElMessage.warning({ message: `备份已完成，但有内容未包含：${summary.warnings.join('；')}`, duration: 10000, showClose: true })
    }
  } catch (error) {
    console.error('full backup failed', error)
    fullBackupError.value = error instanceof Error ? error.message : String(error)
  } finally {
    fullBackingUp.value = false
    fullProgress.value = ''
  }
}

const canBackupNow = computed(() =>
  Boolean(desktopSupported && settingsDraft.value.backupEnabled && !loading.value && !backingUp.value)
)

const changeBackupDir = async () => {
  const selected = await backupService.chooseBackupDir(settingsDraft.value.backupDir)
  if (!selected) return
  settingsDraft.value.backupDir = selected
}

const openBackupDir = async () => {
  try {
    await backupService.openBackupDir(settingsDraft.value.backupDir)
  } catch (error) {
    console.error('open backup dir failed', error)
    backupError.value = '打开备份目录失败'
  }
}

const backupNow = async () => {
  if (backingUp.value) return
  backingUp.value = true
  backupError.value = ''
  try {
    settingsDraft.value = await backupService.saveSettings(settingsDraft.value)
    const snapshotted = await backupService.snapshotActiveWritingEditor()
    if (!snapshotted) {
      backupError.value = '当前章节保存到本地失败，未执行本地备份'
      return
    }
    const bookId = ctx.bookId.value
    const result = bookId
      ? await backupService.backupCurrentBook(bookId)
      : await backupService.backupAllPendingBooks()
    const referenceSuccess = result.referenceSuccess || 0
    const referenceFailed = result.referenceFailed || []
    if (!result.supported) {
      backupError.value = '本地文件备份仅桌面客户端支持'
    } else if (result.failed.length || referenceFailed.length) {
      const parts: string[] = []
      if (result.failed.length) parts.push(`${result.failed.length} 章（${result.failed[0].message}）`)
      if (referenceFailed.length) parts.push(`${referenceFailed.length} 本参考数据（${referenceFailed[0].message}）`)
      backupError.value = `备份失败：${parts.join('、')}`
    } else if (result.success > 0 || referenceSuccess > 0) {
      settingsDraft.value.lastBackupAt = result.lastBackupAt
      const parts: string[] = []
      if (result.success > 0) parts.push(`${result.success} 章`)
      if (referenceSuccess > 0) parts.push(`${referenceSuccess} 本参考数据`)
      ElMessage.success(`已备份 ${parts.join('、')}`)
    } else {
      ElMessage.info('没有需要备份的新内容')
    }
  } catch (error) {
    console.error('manual backup failed', error)
    backupError.value = error instanceof Error ? error.message : '立即备份失败'
  } finally {
    backingUp.value = false
  }
}
</script>
