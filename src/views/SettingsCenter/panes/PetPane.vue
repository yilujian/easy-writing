<template>
  <section class="settings-pane pet-settings">
    <section class="settings-section-block">
      <div class="number-title"><span>1</span><strong>桌面陪伴</strong></div>
      <div class="settings-card pet-setting-row">
        <div>
          <strong>显示桌宠</strong>
          <p>独立显示在桌面，可自由拖动；右键菜单可以隐藏。</p>
        </div>
        <el-switch
          :model-value="prefs.enabled"
          :disabled="!desktopSupported || saving || loading"
          aria-label="显示桌宠"
          @change="change({ enabled: Boolean($event) })"
        />
      </div>
      <p v-if="!desktopSupported" class="pet-platform-hint">请在桌面客户端中开启桌宠，网页预览只展示形象。</p>
      <p v-if="error" class="pet-setting-error" role="alert">{{ error }}</p>
    </section>
    <section class="settings-section-block">
      <div class="number-title"><span>2</span><strong>选择伙伴</strong></div>
      <div class="pet-choice-grid">
        <button
          v-for="pet in PET_CHARACTERS"
          :key="pet.id"
          type="button"
          class="pet-choice"
          :class="{ active: prefs.character === pet.id }"
          :aria-pressed="prefs.character === pet.id"
          :disabled="saving || loading || !desktopSupported"
          @click="change({ character: pet.id })"
        >
          <img :src="petAsset(pet.id, 'original')" alt="" :class="{ pixel: pet.id === 'robot' }" />
          <strong>{{ pet.name }}</strong
          ><small>{{ pet.style }}</small>
          <i v-if="prefs.character === pet.id" class="fa-solid fa-check" aria-hidden="true"></i>
        </button>
      </div>
    </section>
    <section class="settings-section-block">
      <div class="number-title"><span>3</span><strong>显示与互动</strong></div>
      <div class="settings-card pet-setting-row">
        <div>
          <strong>桌宠大小</strong>
          <p>调整角色大小，不改变桌面缩放。</p>
        </div>
        <div class="option-row three pet-size-options">
          <button
            v-for="item in sizes"
            :key="item.value"
            type="button"
            class="settings-option-btn"
            :class="{ active: prefs.size === item.value }"
            :aria-pressed="prefs.size === item.value"
            :disabled="saving || loading || !desktopSupported"
            @click="change({ size: item.value })"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <div class="settings-card pet-setting-row">
        <div>
          <strong>状态气泡</strong>
          <p>显示码字目标与任务提示，点击可回到对应页面。</p>
        </div>
        <el-switch
          :model-value="prefs.bubbles"
          :disabled="saving || loading || !desktopSupported"
          aria-label="状态气泡"
          @change="change({ bubbles: Boolean($event) })"
        />
      </div>
      <div class="settings-card pet-setting-row">
        <div>
          <strong>减少动态效果</strong>
          <p>保留状态姿势，停止循环动作；专注模式会自动安静陪伴。</p>
        </div>
        <el-switch
          :model-value="prefs.reducedMotion"
          :disabled="saving || loading || !desktopSupported"
          aria-label="减少动态效果"
          @change="change({ reducedMotion: Boolean($event) })"
        />
      </div>
      <button
        type="button"
        class="ink-btn ink-btn-outline"
        :disabled="saving || !desktopSupported || !prefs.enabled"
        @click="resetPosition"
      >
        重置到桌面右下角
      </button>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PET_CHARACTERS, petAsset } from '@/desktop-pet/catalog'
import { configurePet, petCommand, petSnapshot } from '@/desktop-pet/client'
import type { PetPreferences } from '@/desktop-pet/types'
import { useSettingsCenterCtx } from '../settings-context'

const { desktopSupported } = useSettingsCenterCtx()
const prefs = computed(() => petSnapshot.value.preferences)
const loading = ref(false),
  saving = ref(false),
  error = ref('')
const sizes = [
  { label: '小', value: 160 },
  { label: '标准', value: 200 },
  { label: '大', value: 260 }
] as const
async function change(patch: Partial<PetPreferences>) {
  saving.value = true
  error.value = ''
  try {
    await configurePet({ ...prefs.value, ...patch })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
async function resetPosition() {
  saving.value = true
  error.value = ''
  try {
    await petCommand('reset_position')
  } catch (cause) {
    error.value = String(cause)
  } finally {
    saving.value = false
  }
}
onMounted(async () => {
  if (!desktopSupported) return
  loading.value = true
  try {
    await petCommand('get')
  } catch (cause) {
    error.value = String(cause)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped lang="scss">
.pet-setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  margin-bottom: 14px;
}
.pet-setting-row strong {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}
.pet-setting-row p,
.pet-platform-hint {
  margin: 6px 0 0;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.7;
}
.pet-setting-error {
  color: var(--state-danger);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.pet-choice-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.pet-choice {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--card-bg);
  color: var(--ink-main);
  cursor: pointer;
  font: inherit;
}
.pet-choice:hover {
  background: var(--card-bg-hover);
  border-color: var(--ui-border-hover);
}
.pet-choice.active {
  border-color: var(--ink-accent);
  background: var(--accent-soft);
}
.pet-choice:focus-visible {
  outline: 2px solid var(--ink-accent);
  outline-offset: 2px;
}
.pet-choice:disabled {
  cursor: default;
}
.pet-choice img {
  width: 100%;
  height: 112px;
  object-fit: contain;
}
.pet-choice img.pixel {
  image-rendering: pixelated;
}
.pet-choice strong {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}
.pet-choice small {
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
.pet-choice i {
  position: absolute;
  top: 12px;
  right: 12px;
  color: var(--ink-accent);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
.pet-size-options {
  min-width: 200px;
}
@media (max-width: 960px) {
  .pet-choice-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pet-setting-row {
    flex-wrap: wrap;
  }
}
</style>
