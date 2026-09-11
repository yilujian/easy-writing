<template>
  <EwModal
    v-model:visible="planPanelVisible"
    :modal="false"
    :click-through="true"
    :close-on-click-modal="false"
    :show-close="false"
    :draggable="false"
    width="340px"
    custom-class="plan-panel-modal"
    :initial-position="panelPosition"
    :header-style="{ padding: '0', borderBottom: 'none', background: 'transparent', justifyContent: 'space-between' }"
    :body-style="{ padding: '0' }"
  >
    <template #header>
      <div class="panel-header" @mousedown.prevent="startDrag">
        <div class="title">
          <i class="fa-solid fa-feather-pointed"></i>
          易创 · 码字记录
        </div>
        <div class="header-actions">
          <el-tooltip content="设置每日码字计划" placement="bottom">
            <button type="button" class="icon-btn" @click.stop="openSettings">
              <i class="fa-solid fa-sliders"></i>
            </button>
          </el-tooltip>
          <button type="button" class="icon-btn" @click.stop="planStore.setPanelVisible(false)">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
    </template>

    <div class="panel-shell" :style="assetVars">
      <div class="paper-texture" aria-hidden="true"></div>
      <div class="panel-body">
        <div class="status-pill" :class="`is-${writingStatus.kind}`">
          <i class="status-dot"></i>
          {{ writingStatus.text }}
        </div>

        <div class="plan-desc">
          今日计划 {{ targetWords ? `${targetWords.toLocaleString()} 字` : '未设置' }}
        </div>

        <div
          class="ink-ring"
          :class="{ 'is-achieved': achieved }"
          :style="{ '--ring-start': `${RING_START_DEG}deg` }"
        >
          <div class="ring-track"></div>
          <div v-show="arcDegrees > 0" class="ring-progress" :style="{ '--arc-deg': `${arcDegrees}deg` }"></div>
          <i v-if="showRingTip" class="ring-tip" :style="tipStyle" aria-hidden="true"></i>
          <div class="ring-center">
            <div class="ring-number" :class="{ 'is-long': todayWords >= 10000 }">
              {{ planStore.todayWordsAvailable ? todayWords.toLocaleString() : '—' }}
            </div>
            <div class="ring-label">今日已写</div>
            <div v-if="achieved" class="ring-seal">已达成</div>
            <div v-if="planStore.todayWordsAvailable && !achieved && targetWords > 0" class="ring-percent">已完成 {{ rawProgressPercent }}%</div>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <i class="fa-solid fa-pen-nib"></i>
            <div class="stat-info">
              <span class="stat-label">本次码字</span>
              <span class="stat-value">{{ displayedSessionWords.toLocaleString() }}<em>字</em></span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fa-solid fa-gauge-high"></i>
            <div class="stat-info">
              <span class="stat-label">码字速率</span>
              <span class="stat-value">{{ writingSpeed.toLocaleString() }}<em>字/时</em></span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fa-solid fa-clock"></i>
            <div class="stat-info">
              <span class="stat-label">专注时间</span>
              <span class="stat-value is-mono">{{ formatDuration(writingSeconds) }}</span>
            </div>
          </div>
          <div class="stat-card">
            <i class="fa-solid fa-mug-hot"></i>
            <div class="stat-info">
              <span class="stat-label">空闲时间</span>
              <span class="stat-value is-mono">{{ formatDuration(idleSeconds) }}</span>
            </div>
          </div>
        </div>

        <div class="panel-footer">
          <p class="footer-text">
            {{ footerParts.prefix }}<strong v-if="footerParts.highlight">{{ footerParts.highlight }}</strong>{{ footerParts.suffix }}
          </p>
          <div class="footer-divider" aria-hidden="true"></div>
        </div>
      </div>
    </div>
  </EwModal>

  <EwModal
    v-model:visible="settingsVisible"
    title="设置每日码字计划"
    width="380px"
    custom-class="plan-settings-modal"
  >
    <div class="settings-body">
      <el-input-number
        v-model="planTargetInput"
        :min="100"
        :step="100"
        :max="20000"
        controls-position="right"
        style="width: 100%;"
      />
      <p class="settings-tip">设置后用于统计今日计划达成情况。</p>
    </div>
    <template #footer>
      <button type="button" class="ink-btn ink-btn-outline" @click="planStore.closeSettings()">取消</button>
      <button type="button" class="ink-btn ink-btn-primary" @click="handleSaveTarget">
        <i class="fa-solid fa-feather-pointed"></i>
        保存
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { useWordCount } from '@/composables/use-word-count'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import EwModal from '@/components/EwModal/index.vue'
import { useWritingPlanStore } from '@/stores/writing-plan'
import inkRingMask from '@/assets/writing-plan/v2/ink-ring-mask.webp'
import footerBrushDivider from '@/assets/writing-plan/v2/footer-brush-divider.webp'
import ricePaperTexture from '@/assets/writing-plan/v2/rice-paper-texture.webp'

const wordCounter = useWordCount()

const PANEL_WIDTH = 340
const PANEL_HEIGHT = 620

// v2 素材全部是透明遮罩/中性纹理，这里注入为 CSS 变量，由样式里用主题色着色。
// 用法约定见 src/assets/writing-plan/v2/README.md。
const assetVars = {
  '--ink-ring-mask': `url("${inkRingMask}")`,
  '--footer-brush-mask': `url("${footerBrushDivider}")`,
  '--rice-paper-texture': `url("${ricePaperTexture}")`,
}

const planStore = useWritingPlanStore()
const {
  targetWords,
  todayWords,
  sessionWords,
  planPanelVisible,
  panelPosition,
  writingSeconds,
  idleSeconds,
  settingsVisible,
  trackingStarted,
  lastTypingAt
} = storeToRefs(planStore)

const isDragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const planTargetInput = ref(0)

watch(
  settingsVisible,
  (visible) => {
    if (visible) {
      planTargetInput.value = targetWords.value || 0
    }
  }
)

// 状态胶囊要回答“现在还在写吗”，需要时间参与计算；面板可见时每秒刷一次。
const nowTick = ref(Date.now())
let statusTimer: number | null = null

const stopStatusTimer = () => {
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
}

watch(
  planPanelVisible,
  (visible) => {
    stopStatusTimer()
    if (visible) {
      nowTick.value = Date.now()
      statusTimer = window.setInterval(() => {
        nowTick.value = Date.now()
      }, 1000)
    }
  },
  { immediate: true }
)

// store 里空闲的口径是停顿 2 秒，直接照搬会让胶囊闪来闪去，放宽到 10 秒再显示小憩。
const IDLE_HINT_MS = 10_000

const writingStatus = computed(() => {
  if (!trackingStarted.value) return { kind: 'rest', text: '静待落笔' }
  if (nowTick.value - lastTypingAt.value <= IDLE_HINT_MS) return { kind: 'writing', text: '静心书写中' }
  return { kind: 'idle', text: '笔尖小憩' }
})

const displayedSessionWords = computed(() => {
  if (!trackingStarted.value) return 0
  return wordCounter.mode.value === 'text' ? planStore.sessionTextWords : sessionWords.value
})

// store 的 planProgress 封顶 100，画“超额”弧线和页脚文案需要未封顶的原始比例。
const progressRatio = computed(() => (planStore.todayWordsAvailable && targetWords.value > 0 ? todayWords.value / targetWords.value : 0))
const rawProgressPercent = computed(() => Math.round(progressRatio.value * 100))
const achieved = computed(() => targetWords.value > 0 && progressRatio.value >= 1)

/**
 * 墨环的叙事是“写字上墨”：淡墨轮廓当底，写过的进度用浓墨描上去；
 * 达成后整环墨满即为终态，环上不再叠色（试过用强调色继续画超额，
 * 视觉上像环莫名分成两截），超额幅度只在页脚文案里表达一处。
 */
const arcDegrees = computed(() => {
  if (!targetWords.value || achieved.value) return 0
  return Math.round(Math.min(progressRatio.value, 1) * 3600) / 10
})

// 进度弧从底部中心（180°）起笔顺时针走：素材左下半圈墨最浓，起步阶段的
// 进度落在最实的笔画带上，一眼可见；快写满时的缺口则落在右侧枯笔飞白区，
// “还没写满”和“笔枯了”在视觉上是同一种语言。0% 不画弧、100% 换整环浓墨，
// 起点切口只在中途可见且有羽化，无需迁就笔锋接缝。
const RING_START_DEG = 180
// 墨环笔画带中心的半径与容器尺寸（px），笔尖墨点沿这条圆周走
const RING_TIP_RADIUS = 93
const RING_SIZE = 232

// 弧线太短时墨点会和接缝挤在一起，走出一小段再显示
const showRingTip = computed(() => targetWords.value > 0 && arcDegrees.value > 8)

const tipStyle = computed(() => {
  const theta = ((RING_START_DEG + arcDegrees.value) * Math.PI) / 180
  const x = RING_SIZE / 2 + RING_TIP_RADIUS * Math.sin(theta)
  const y = RING_SIZE / 2 - RING_TIP_RADIUS * Math.cos(theta)
  // 用 transform 而不是 left/top：合成器动画，标签页被节流时也能走完
  return { transform: `translate(${x}px, ${y}px)` }
})

const footerParts = computed(() => {
  if (!planStore.todayWordsAvailable) return { prefix: '今日部分旧记录无法补算', highlight: '', suffix: '' }
  if (!targetWords.value) return { prefix: '设个今日计划，', highlight: '', suffix: '落笔生花' }
  if (achieved.value) {
    const overage = rawProgressPercent.value - 100
    if (overage > 0) return { prefix: '今日超额 ', highlight: `${overage}%`, suffix: '，笔耕不辍' }
    return { prefix: '今日计划', highlight: '达成', suffix: '，笔耕不辍' }
  }
  if (!todayWords.value) return { prefix: '今日尚未动笔，', highlight: '', suffix: '静待墨香' }
  return { prefix: '今日已完成 ', highlight: `${rawProgressPercent.value}%`, suffix: '，笔耕不辍' }
})

const writingSpeed = computed(() => {
  if (!writingSeconds.value) return 0
  const hours = writingSeconds.value / 3600
  if (!hours) return 0
  return Math.round(displayedSessionWords.value / hours)
})

const openSettings = () => {
  planStore.openSettings()
}

const handleSaveTarget = () => {
  const value = Math.max(0, Math.round(planTargetInput.value))
  planStore.submitTarget(value)
}

const formatDuration = (secs: number) => {
  const safe = Math.max(0, Math.floor(secs))
  const hours = Math.floor(safe / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((safe % 3600) / 60).toString().padStart(2, '0')
  const seconds = Math.floor(safe % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

const startDrag = (event: MouseEvent) => {
  isDragging.value = true
  dragOffset.value = {
    x: event.clientX - panelPosition.value.x,
    y: event.clientY - panelPosition.value.y
  }
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
}

const onDrag = (event: MouseEvent) => {
  if (!isDragging.value) return
  const nextX = event.clientX - dragOffset.value.x
  const nextY = event.clientY - dragOffset.value.y
  planStore.setPanelPosition({
    x: Math.max(12, Math.min(window.innerWidth - PANEL_WIDTH, nextX)),
    y: Math.max(12, Math.min(window.innerHeight - PANEL_HEIGHT, nextY))
  })
}

const stopDrag = () => {
  isDragging.value = false
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
}

onBeforeUnmount(() => {
  stopStatusTimer()
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
})
</script>

<style scoped lang="scss">
:deep(.plan-panel-modal) {
  /* 设计稿是近不透明的纸面卡片：用主题纸色打底，留一点玻璃感 */
  background: color-mix(in srgb, var(--bg-main) 92%, transparent);
  border-radius: 16px;
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow);
  color: var(--ink-main);
  min-width: 0;
  backdrop-filter: blur(18px);
  overflow: hidden;
}

.panel-header {
  display: flex;
  width: 100%;
  align-items: center;
  padding: 14px 16px 10px;
  user-select: none;
  gap: 12px;

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: 'Noto Serif SC', serif;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;

    i {
      color: var(--ink-accent);
    }
  }

  .header-actions {
    display: flex;
    gap: 8px;
    margin-left: auto;

    .icon-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: var(--ui-glass-bg);
      border: 1px solid var(--ui-border);
      color: var(--ink-sec);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;

      &:hover {
        color: var(--ink-main);
        background: var(--ui-glass-bg-hover);
        border-color: var(--ui-border-hover, var(--ui-border));
        transform: translateY(-1px);
      }
    }
  }
}

/* 宣纸纹理铺满整个面板（含头部）：定位基准是 .ew-modal-container，
   穿出 body 的滚动裁切；pointer-events 放行，不挡任何点击。 */
.paper-texture {
  position: absolute;
  inset: 0;
  /* 显式定层：纹理垫底、内容在上，不依赖“定位元素按 DOM 顺序绘制”的隐式规则 */
  z-index: 0;
  border-radius: 16px;
  background-image: var(--rice-paper-texture);
  background-repeat: repeat;
  background-size: 256px 256px;
  opacity: 0.3;
  pointer-events: none;
}

.panel-body {
  position: relative;
  z-index: 1;
  padding: 2px 18px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 999px;
  border: 1px solid var(--ui-border);
  background: var(--btn-ghost-bg);
  color: var(--ink-main);
  font-size: 13px;
  letter-spacing: 0.05em;

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink-sec);
  }

  &.is-writing .status-dot {
    background: var(--ink-accent);
    animation: dot-breathe 2s ease-in-out infinite;
  }
}

@keyframes dot-breathe {
  50% {
    opacity: 0.45;
  }
}

.plan-desc {
  font-family: 'Noto Serif SC', serif;
  font-size: 14px;
  color: var(--ink-sec);
  letter-spacing: 0.08em;
}

.ink-ring {
  position: relative;
  width: 232px;
  height: 232px;
  margin: 2px 0;
}

.ring-track,
.ring-progress {
  position: absolute;
  inset: 0;
  -webkit-mask: var(--ink-ring-mask) center / contain no-repeat;
  mask: var(--ink-ring-mask) center / contain no-repeat;
}

.ring-track {
  background: color-mix(in srgb, var(--ink-main) 24%, transparent);
  transition: background 0.4s ease;
}

.ink-ring.is-achieved .ring-track {
  /* 拉到实色：素材遮罩本身有浓淡，墨色给满才接近主题稿的密度 */
  background: var(--ink-main);
}

.ring-progress {
  /* “写字上墨”：进度用浓墨描；达成后整环由 track 直接给满，此层不再出场 */
  --ring-fill: var(--ink-main);
  /* 从落笔接缝起笔，两端各 9° 角向渐隐，让切口像墨迹自然洇开 */
  background: conic-gradient(
    from var(--ring-start, 0deg),
    transparent 0deg,
    var(--ring-fill) 9deg,
    var(--ring-fill) calc(var(--arc-deg, 0deg) - 9deg),
    transparent var(--arc-deg, 0deg)
  );
}

.ring-tip {
  position: absolute;
  left: -8px;
  top: -8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  --tip-color: color-mix(in srgb, var(--ink-main) 92%, transparent);
  /* 墨芯 + 纸色光环：墨点骑在浓墨弧的尽头上，深处靠光环显形、浅处靠墨芯显形 */
  background: radial-gradient(
    circle,
    var(--tip-color) 0 40%,
    color-mix(in srgb, var(--bg-main) 96%, transparent) 52%,
    color-mix(in srgb, var(--bg-main) 60%, transparent) 66%,
    transparent 80%
  );
  pointer-events: none;
  transition: transform 0.4s ease;
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.ring-number {
  font-family: 'Noto Serif SC', serif;
  font-size: 48px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ink-main);
  font-variant-numeric: tabular-nums;

  &.is-long {
    font-size: 34px;
  }
}

.ring-label {
  font-family: 'Noto Serif SC', serif;
  font-size: 13px;
  color: var(--ink-sec);
  letter-spacing: 0.2em;
  text-indent: 0.2em;
}

.ring-percent {
  margin-top: 6px;
  font-family: 'Noto Serif SC', serif;
  font-size: 12px;
  color: var(--ink-sec);
  letter-spacing: 0.08em;
}

.ring-seal {
  margin-top: 6px;
  padding: 2px 10px;
  border: 1px solid var(--ink-accent);
  border-radius: 4px;
  color: var(--ink-accent);
  background: color-mix(in srgb, var(--ink-accent) 8%, transparent);
  font-family: 'Noto Serif SC', serif;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
}

.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
  margin-top: 4px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-radius: 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-glass-bg);

  > i {
    flex: 0 0 auto;
    width: 22px;
    font-size: 18px;
    text-align: center;
    color: var(--ink-accent);
    opacity: 0.85;
  }
}

.stat-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.stat-label {
  font-size: 12px;
  color: var(--ink-sec);
  letter-spacing: 0.05em;
}

.stat-value {
  font-family: 'Noto Serif SC', serif;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--ink-main);
  font-variant-numeric: tabular-nums;

  em {
    font-style: normal;
    font-size: 11px;
    color: var(--ink-sec);
    margin-left: 4px;
    letter-spacing: 0;
  }

  &.is-mono {
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    font-size: 16px;
    letter-spacing: 0.04em;
  }
}

.panel-footer {
  width: 100%;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.footer-text {
  margin: 0;
  font-family: 'Noto Serif SC', serif;
  font-size: 14px;
  color: var(--ink-main);
  letter-spacing: 0.06em;

  strong {
    color: var(--ink-accent);
    font-size: 17px;
    margin: 0 2px;
  }
}

.footer-divider {
  width: 86%;
  height: 26px;
  margin-top: 2px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ink-main) 72%, transparent),
    var(--ink-accent)
  );
  -webkit-mask: var(--footer-brush-mask) center / contain no-repeat;
  mask: var(--footer-brush-mask) center / contain no-repeat;
}

/* 暗夜主题：纹理换柔光叠加提质感，环内数字用金色强调（见主题稿） */
.theme-dark .paper-texture {
  mix-blend-mode: soft-light;
  opacity: 0.45;
}

.theme-dark .ring-number {
  color: var(--ink-accent);
}

.theme-dark .ring-track {
  background: color-mix(in srgb, var(--ink-main) 20%, transparent);
}

.theme-dark .ink-ring.is-achieved .ring-track {
  background: color-mix(in srgb, var(--ink-main) 85%, transparent);
}

.theme-dark .ring-progress {
  --ring-fill: color-mix(in srgb, var(--ink-main) 85%, transparent);
}

.theme-dark .ring-tip {
  --tip-color: color-mix(in srgb, var(--ink-main) 85%, transparent);
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .settings-tip {
    margin: 0;
    font-size: 12px;
    color: var(--ink-sec);
  }
}

/* 设置弹窗必须压在码字面板之上：两个 EwModal 同为 z-index 2000，
   叠放只看 DOM 顺序，面板挪到屏幕中间时会盖住设置弹窗。 */
:global(.ew-modal-overlay:has(> .plan-settings-modal)) {
  z-index: 2100;
}
</style>
