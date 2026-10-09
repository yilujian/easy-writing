<template>
          <section class="settings-pane">
            <section class="settings-card cache-overview-card">
              <div class="cache-ring">
                <i class="fa-solid fa-database"></i>
              </div>
              <div class="cache-summary">
                <span>本地缓存占用</span>
                <strong>{{ formatBytes(localStorageBytes) }}</strong>
                <small>界面提示、临时状态等键值缓存；清理不影响作品内容</small>
              </div>
              <button type="button" class="ink-btn ink-btn-outline" @click="clearLocalCache">
                <i class="fa-regular fa-trash-can"></i>
                清理缓存
              </button>
            </section>

            <section class="settings-card storage-backup-tip">
              <div class="settings-card-title">
                <i class="fa-solid fa-box-archive"></i>
                <strong>作品备份</strong>
              </div>
              <p class="hint-line">作品的备份目录、自动备份频率与手动备份统一在「保存与备份」页管理。</p>
              <div class="action-row">
                <button class="ink-btn ink-btn-outline" type="button" @click="ctx.navigate('sync')">
                  前往保存与备份
                </button>
              </div>
            </section>
          </section>
</template>

<script setup lang="ts">
import { appSettings } from '@/storage/app-settings'

import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { useSettingsCenterCtx } from '../settings-context'

const ctx = useSettingsCenterCtx()

const localStorageBytes = ref(0)

const refreshLocalStorageSize = () => {
  if (typeof window === 'undefined') {
    localStorageBytes.value = 0
    return
  }
  let total = 0
  for (let index = 0; index < appSettings.length; index += 1) {
    const key = appSettings.key(index) || ''
    const value = appSettings.getItem(key) || ''
    total += (key.length + value.length) * 2
  }
  localStorageBytes.value = total
}

const clearLocalCache = async () => {
  try {
    await inkConfirm('清理本地键值缓存不影响作品内容，只移除临时缓存项。', '清理缓存', {
      confirmButtonText: '清理',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  // 只清理明确的缓存前缀，避免误删用户设置与作品数据
  const removableKeys: string[] = []
  for (let index = 0; index < appSettings.length; index += 1) {
    const item = appSettings.key(index)
    if (item?.startsWith('ew-cache-')) removableKeys.push(item)
  }
  removableKeys.forEach(item => appSettings.removeItem(item))
  refreshLocalStorageSize()
  ElMessage.success('缓存已清理')
}

const formatBytes = (value: number) => {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

onMounted(refreshLocalStorageSize)
</script>
