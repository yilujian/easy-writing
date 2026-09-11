<template>
  <section class="settings-pane menu-management">
    <p class="hint-line">选择在侧边栏显示的入口。隐藏入口不影响已有内容，「设置」始终保留。</p>
    <div class="settings-two-col">
      <section v-for="group in groups" :key="group.title" class="settings-card">
        <div class="settings-card-title">
          <strong>{{ group.title }}</strong>
        </div>
        <label v-for="item in group.items" :key="item.id" class="switch-row compact">
          <span
            ><i :class="item.icon" aria-hidden="true"></i> <strong>{{ item.label }}</strong></span
          >
          <el-switch
            :model-value="!uiDraft.hiddenMenus.includes(item.id)"
            :aria-label="`显示${item.label}`"
            @change="setVisible(item.id, Boolean($event))"
          />
        </label>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { navigationGroups } from '@/config/navigation'
import { useAppConfigStore } from '@/stores/app-config'
import type { MenuId } from '@/types/ui-preferences'
import { useSettingsCenterCtx } from '../settings-context'

const { uiDraft } = useSettingsCenterCtx()
const appConfig = useAppConfigStore()
const groups = computed(() =>
  navigationGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => !item.featureKey || appConfig.isFeatureEnabled(item.featureKey))
    }))
    .filter(group => group.items.length)
)
function setVisible(id: MenuId, visible: boolean) {
  uiDraft.hiddenMenus = visible
    ? uiDraft.hiddenMenus.filter(item => item !== id)
    : [...new Set([...uiDraft.hiddenMenus, id])]
}
</script>
