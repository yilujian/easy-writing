<template>
  <div class="preference-panel">
    <h3 class="panel-title">偏好设置</h3>

    <!-- 音效 -->
    <div class="setting-group">
      <div class="group-label"><i class="fa-solid fa-music"></i> 沉浸音效</div>
      <div class="option-grid">
        <div
v-for="opt in soundOptions" :key="opt.value" class="opt-btn" :class="{ active: typingSound === opt.value }"
          @click="setTypingSound(opt.value)">
          {{ opt.label }}
        </div>
      </div>
    </div>

    <!-- 特效 -->
    <div class="setting-group">
      <div class="group-label"><i class="fa-solid fa-wand-magic-sparkles"></i> 视觉特效</div>
      <div class="option-grid">
        <div
v-for="opt in effectOptions" :key="opt.value" class="opt-btn"
          :class="{ active: typingEffect === opt.value }" @click="setTypingEffect(opt.value)">
          {{ opt.label }}
        </div>
      </div>
    </div>
    <!-- 自爆模式 -->
    <div class="setting-group">
      <div class="group-label" style="color: #b91c1c;">
        <i class="fa-solid fa-bomb"></i> 自爆测试 (停止打字触发)
      </div>
      <div class="option-grid" style="grid-template-columns: repeat(5, 1fr); gap: 4px;">
        <div
v-for="opt in selfDestructOptions" :key="opt.value" class="opt-btn warn-btn"
          :class="{ active: selfDestructMode === opt.value }" @click="setSelfDestructMode(opt.value)">
          {{ opt.label }}
        </div>
      </div>
    </div>

    <!-- 打字机模式：光标低于基准线就自动上滚，基准线在编辑区高度的百分之几 -->
    <div class="setting-group">
      <div class="group-label"><i class="fa-solid fa-keyboard"></i> 打字机模式</div>
      <div class="option-grid" style="grid-template-columns: repeat(5, 1fr); gap: 4px;">
        <div class="opt-btn" :class="{ active: !typewriterEnabled }" @click="setTypewriterEnabled(false)">关</div>
        <div
          v-for="ratio in TYPEWRITER_RATIOS" :key="ratio" class="opt-btn"
          :class="{ active: typewriterEnabled && typewriterRatio === ratio }" @click="chooseTypewriter(ratio)">
          {{ ratio }}%
        </div>
      </div>
    </div>

    <!-- 专注模式：只亮光标所在的段，其余段变淡 -->
    <div class="setting-group">
      <div class="group-label"><i class="fa-regular fa-eye"></i> 专注模式</div>
      <div class="switch-row">
        <span>{{ focusMode ? '已开启' : '已关闭' }}</span>
        <el-switch
          :model-value="focusMode"
          @change="(value: string | number | boolean) => setFocusMode(Boolean(value))"
        />
      </div>
    </div>

    <div class="setting-group">
      <div class="group-label"><i class="fa-solid fa-highlighter"></i> 角色设定高亮</div>
      <div class="switch-row">
        <span>{{ entityHighlightEnabled ? '已开启' : '已关闭' }}</span>
        <el-switch
          :model-value="entityHighlightEnabled"
          @change="(value: string | number | boolean) => setEntityHighlightEnabled(Boolean(value))"
        />
      </div>
      <details v-if="bookKey" :key="bookKey" class="dismissed-highlights">
        <summary>
          <span>当前作品已取消的高亮</span>
          <span class="dismissed-count">{{ dismissedNames.length }}</span>
        </summary>
        <template v-if="dismissedNames.length">
          <div class="dismissed-actions">
            <span>仅影响当前作品</span>
            <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" @click="restoreAll">全部恢复</button>
          </div>
          <p v-if="!entityHighlightEnabled" class="dismissed-hint">恢复后，开启上方开关即可显示高亮。</p>
          <ul class="dismissed-list" aria-label="当前作品已取消的高亮">
            <li v-for="name in dismissedNames" :key="name">
              <span class="dismissed-name">{{ name }}</span>
              <button type="button" class="ink-btn ink-btn-outline ink-btn-sm" :aria-label="`恢复 ${name} 的高亮`" @click="restoreOne(name)">恢复</button>
            </li>
          </ul>
        </template>
        <p v-else class="dismissed-hint" role="status">当前作品没有已取消的高亮。</p>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { TYPEWRITER_RATIOS, useWritingEditorStore, type TypewriterRatio } from '@/stores/writing-editor';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { TYPING_SOUND_OPTIONS } from '@/config/typing-sounds';

const props = defineProps<{ bookId?: string | number }>();
const store = useWritingEditorStore();
const bookKey = computed(() => props.bookId == null ? '' : String(props.bookId).trim());
const dismissedNames = computed(() => bookKey.value ? store.dismissedEntityHighlightKeysByBook[bookKey.value] || [] : []);
const restoreOne = (name: string) => {
  if (!bookKey.value) return;
  try {
    store.restoreEntityHighlight(bookKey.value, name);
    ElMessage.success(`已恢复“${name}”的自动高亮`);
  } catch (error) { ElMessage.error(String(error)); }
};
const restoreAll = () => {
  if (!bookKey.value) return;
  try {
    store.resetDismissedEntityHighlights(bookKey.value);
    ElMessage.success('已恢复当前作品的全部自动高亮');
  } catch (error) { ElMessage.error(String(error)); }
};
const { typingSound, typingEffect, selfDestructMode, entityHighlightEnabled, typewriterEnabled, typewriterRatio, focusMode } = storeToRefs(store);
const { setTypingSound, setTypingEffect, setSelfDestructMode, setEntityHighlightEnabled, setTypewriterEnabled, setTypewriterRatio, setFocusMode } = store;

const chooseTypewriter = (ratio: TypewriterRatio) => {
  setTypewriterRatio(ratio);
  setTypewriterEnabled(true);
};

const soundOptions = TYPING_SOUND_OPTIONS;

const effectOptions = [
  { label: '挥毫泼墨', value: 'splash' },
  { label: '墨纹涟漪', value: 'ripple' },
  { label: '云烟缭绕', value: 'mist' },
  { label: '真实烈焰', value: 'fire' },
  { label: '文字鼓励', value: 'cheer' },
  { label: '无特效', value: 'none' }
] as const;

const selfDestructOptions = [
  { label: '关', value: 'off' },
  { label: '10秒', value: '10s' },
  { label: '20秒', value: '20s' },
  { label: '1分', value: '1m' },
  { label: '5分', value: '5m' }
] as const;
</script>

<style scoped lang="scss">
.preference-panel {
  padding: 16px;
  width: 100%;
  box-sizing: border-box;
  max-height: min(640px, calc(100vh - 24px));
  overflow-y: auto;
  overscroll-behavior: contain;
  background-color: var(--ui-bg);
  color: var(--ink-main);
}

.panel-title {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 700;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ink-main);
}

.setting-group {
  margin-bottom: 20px;

  &:last-child {
    margin-bottom: 0;
  }
}

.group-label {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  margin-bottom: 8px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.option-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.opt-btn {
  padding: 8px 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  border-radius: 6px;
  border: 2px solid var(--input-border);
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
  background: var(--input-bg);
  color: var(--ink-main);

  &:hover {
    border-color: var(--ink-sec);
  }

  &.active {
    border: 2px solid var(--ink-accent);
  }
}

.warn-btn {
  border-color: var(--state-danger-border);
  color: var(--state-danger-on);

  &.active {
    background: var(--state-danger-strong-bg);
    color: var(--state-danger-strong-on);
    border-color: var(--state-danger-strong-bg);
    font-weight: bold;
    border-width: 1px;
    /* Reset border width for active state if needed */
  }

  &:hover:not(.active) {
    background: var(--state-danger-surface);
    border-color: var(--state-danger-border);
  }
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
.dismissed-highlights {
  margin-top: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-main);

  button:focus-visible { outline: 2px solid var(--ink-accent); outline-offset: 2px; }

  summary {
    cursor: pointer;
    padding: 6px 0;
    color: var(--ink-sec);

    &:focus-visible { outline: 2px solid var(--ink-accent); outline-offset: 2px; border-radius: 4px; }
  }
}
.dismissed-count { margin-left: 6px; font-variant-numeric: tabular-nums; }
.dismissed-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 6px 0;
  color: var(--ink-sec);
}
.dismissed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;

  li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--ui-border); }
  li:last-child { border-bottom: none; }
  button { flex-shrink: 0; }
}
.dismissed-name { min-width: 0; overflow-wrap: anywhere; }
.dismissed-hint { margin: 8px 0 0; color: var(--ink-sec); font-size: calc(12px * var(--ui-font-scale, 1)); line-height: 1.6; }

</style>
