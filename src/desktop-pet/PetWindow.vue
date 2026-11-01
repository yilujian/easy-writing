<template>
  <main class="pet-window" @contextmenu.prevent="openMenu" @pointerdown="closeOutside">
    <button
      v-if="showBubble"
      ref="bubble"
      type="button"
      class="pet-bubble"
      :class="{ 'is-error': view.state === 'error' }"
      @click="activate(false)"
    >
      {{ view.message || greeting }}<span v-if="view.target" class="pet-link-hint">查看 ›</span>
    </button>
    <canvas
      ref="canvas"
      width="640"
      height="640"
      class="pet-character"
      :class="{ 'is-pixel': preferences.character === 'robot' }"
      role="img"
      :aria-label="`${characterName}，${stateName}`"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="press = null"
    />
    <div v-if="error" class="pet-load-error" role="alert">{{ error }}</div>
    <div
      v-if="menuOpen"
      ref="menu"
      class="pet-context-menu"
      role="menu"
      aria-label="桌宠菜单"
      :style="menuStyle"
      @pointerdown.stop
    >
      <span class="pet-menu-title">{{ characterName }}</span>
      <button role="menuitem" type="button" @click="activate(true)">桌宠设置</button>
      <button role="menuitem" type="button" @click="hide">隐藏桌宠</button>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PET_CHARACTERS } from './catalog'
import { listenPetState, petCommand, petSnapshot } from './client'
import { drawPet, loadPetSheet, type PetSheet } from './renderer'
import { defaultPetPreferences, defaultPetView, type PetSnapshot } from './types'

const preview = ref<PetSnapshot>({
  preferences: { ...defaultPetPreferences(), enabled: true },
  view: defaultPetView()
})
const snapshot = computed(() => (isTauri() ? petSnapshot.value : preview.value))
const preferences = computed(() => snapshot.value.preferences)
const view = computed(() => snapshot.value.view)
const characterName = computed(
  () => PET_CHARACTERS.find(p => p.id === preferences.value.character)?.name || '桌宠'
)
const stateName = computed(
  () =>
    ({ idle: '安静陪伴', typing: '正在码字', thinking: '正在处理', celebrate: '庆祝', error: '需要处理' })[
      view.value.state
    ]
)
const canvas = ref<HTMLCanvasElement | null>(null),
  bubble = ref<HTMLElement | null>(null),
  menu = ref<HTMLElement | null>(null)
const menuOpen = ref(false),
  menuPoint = ref({ x: 0, y: 0 }),
  error = ref('')
const menuStyle = computed(() => ({ left: `${menuPoint.value.x}px`, top: `${menuPoint.value.y}px` }))
const greeting = ref('')
const showBubble = computed(
  () =>
    preferences.value.bubbles &&
    Boolean(view.value.message || greeting.value) &&
    (!view.value.quiet || view.value.state === 'error')
)
const systemReduced = matchMedia('(prefers-reduced-motion: reduce)')
const reduced = ref(systemReduced.matches)
let animation = 0,
  startedAt = 0,
  sheet: PetSheet | null = null,
  loadVersion = 0,
  disposed = false
let stopListening: (() => void) | undefined
let press: { x: number; y: number; dragged: boolean } | null = null
let greetingTimer: ReturnType<typeof setTimeout> | undefined
let lastRegions = '',
  bounds = { x: 0, y: 0, width: 320, height: 320 }

function syncHitRegions() {
  if (!isTauri() || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect(),
    ratio = rect.width / 320
  const regions = [
    {
      x: rect.left + bounds.x * ratio,
      y: rect.top + bounds.y * ratio,
      width: bounds.width * ratio,
      height: bounds.height * ratio
    }
  ]
  for (const element of [bubble.value, menu.value])
    if (element) {
      const r = element.getBoundingClientRect()
      regions.push({ x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height })
    }
  const key = JSON.stringify(
    regions.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])))
  )
  if (key === lastRegions) return
  lastRegions = key
  void petCommand('hit_regions', JSON.parse(key)).catch(() => {
    lastRegions = ''
  })
}
function stopAnimation() {
  cancelAnimationFrame(animation)
  animation = 0
}
function render(now: number) {
  animation = 0
  if (disposed || !sheet || !canvas.value || !preferences.value.enabled || document.hidden) return
  const context = canvas.value.getContext('2d')
  if (!context) return
  const calm = reduced.value || preferences.value.reducedMotion || view.value.quiet
  context.setTransform(2, 0, 0, 2, 0, 0)
  bounds = drawPet(context, sheet, preferences.value.character, view.value.state, now - startedAt, calm)
  syncHitRegions()
  if (!calm) animation = requestAnimationFrame(render)
}
function resume() {
  stopAnimation()
  if (!disposed) animation = requestAnimationFrame(render)
}
watch(
  [
    () => preferences.value.character,
    () => view.value.state,
    () => preferences.value.enabled,
    () => preferences.value.reducedMotion,
    () => view.value.quiet
  ],
  async () => {
    const version = ++loadVersion
    stopAnimation()
    if (!preferences.value.enabled) {
      menuOpen.value = false
      return
    }
    try {
      const loaded = await loadPetSheet(preferences.value.character)
      if (disposed || version !== loadVersion) return
      sheet = loaded
      startedAt = performance.now()
      error.value = ''
      resume()
    } catch (cause) {
      if (version === loadVersion) error.value = String(cause instanceof Error ? cause.message : cause)
    }
  },
  { immediate: true }
)
watch(
  () => view.value.theme,
  theme => {
    document.documentElement.classList.remove('theme-new', 'theme-yellow', 'theme-green', 'theme-dark')
    document.documentElement.classList.add(
      `theme-${['new', 'yellow', 'green', 'dark'].includes(theme) ? theme : 'new'}`
    )
  },
  { immediate: true }
)
watch([showBubble, menuOpen, () => preferences.value.size], async () => {
  await nextTick()
  lastRegions = ''
  syncHitRegions()
})
function onReduced() {
  reduced.value = systemReduced.matches
  resume()
}
function closeOutside() {
  menuOpen.value = false
}
function openMenu(event: MouseEvent) {
  press = null
  menuPoint.value = {
    x: Math.max(8, Math.min(event.clientX, innerWidth - 156)),
    y: Math.max(8, Math.min(event.clientY, innerHeight - 120))
  }
  menuOpen.value = true
}
async function hide() {
  menuOpen.value = false
  try {
    if (isTauri()) await petCommand('hide')
    else preview.value.preferences.enabled = false
  } catch {
    error.value = '隐藏失败，请重试'
  }
}
async function activate(settings: boolean) {
  menuOpen.value = false
  if (isTauri())
    await petCommand('activate', { settings }).catch(() => {
      error.value = '打开平台失败，请重试'
    })
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  press = { x: event.clientX, y: event.clientY, dragged: false }
}
function pointerMove(event: PointerEvent) {
  if (!press || press.dragged || Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) return
  press.dragged = true
  menuOpen.value = false
  if (isTauri())
    void getCurrentWindow()
      .startDragging()
      .catch(() => {
        error.value = '拖动失败，请重试'
      })
      .finally(() => {
        press = null
      })
}
function pointerUp() {
  if (press && !press.dragged) {
    clearTimeout(greetingTimer)
    startedAt = performance.now()
    if (view.value.target) void activate(false)
    else {
      greeting.value = '我在这里，陪你慢慢写。'
      greetingTimer = setTimeout(() => {
        greeting.value = ''
      }, 2500)
    }
  }
  press = null
}
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape') menuOpen.value = false
}
onMounted(async () => {
  document.addEventListener('visibilitychange', resume)
  document.addEventListener('keydown', escape)
  window.addEventListener('resize', syncHitRegions)
  systemReduced.addEventListener('change', onReduced)
  if (isTauri()) {
    stopListening = await listenPetState()
    if (disposed) {
      stopListening()
      return
    }
    try {
      const initial = await petCommand('get')
      await loadPetSheet(initial.preferences.character)
      if (!disposed) {
        await nextTick()
        resume()
        await petCommand('ready')
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '桌宠启动失败'
      await petCommand('ready').catch(() => undefined)
    }
  } else resume()
})
onBeforeUnmount(() => {
  disposed = true
  loadVersion++
  stopAnimation()
  stopListening?.()
  clearTimeout(greetingTimer)
  document.removeEventListener('visibilitychange', resume)
  document.removeEventListener('keydown', escape)
  window.removeEventListener('resize', syncHitRegions)
  systemReduced.removeEventListener('change', onReduced)
})
</script>

<style lang="scss">
html.desktop-pet-root,
.desktop-pet-root body,
.desktop-pet-root #app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent !important;
}
.pet-window {
  position: relative;
  width: 100%;
  height: 100%;
  color: var(--ink-main);
  font-family:
    system-ui,
    -apple-system,
    'PingFang SC',
    sans-serif;
  user-select: none;
  -webkit-user-select: none;
}
.pet-character {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 30px);
  height: auto;
  aspect-ratio: 1;
  touch-action: none;
  cursor: grab;
}
.pet-character:active {
  cursor: grabbing;
}
.pet-character.is-pixel {
  image-rendering: pixelated;
}
.pet-bubble {
  position: absolute;
  z-index: 1;
  top: 10px;
  left: 12px;
  right: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--popover-bg);
  color: var(--ink-main);
  box-shadow: var(--ui-shadow);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.pet-bubble.is-error {
  border-color: var(--state-danger-border);
}
.pet-link-hint {
  display: inline-block;
  margin-left: 6px;
  color: var(--ink-accent);
  font-size: 11px;
}
.pet-context-menu {
  position: absolute;
  z-index: 2;
  width: 144px;
  padding: 6px;
  box-sizing: border-box;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--popover-bg);
  box-shadow: var(--modal-shadow);
}
.pet-menu-title {
  display: block;
  padding: 6px 8px;
  color: var(--ink-sec);
  font-size: 11px;
  border-bottom: 1px solid var(--divider);
  margin-bottom: 4px;
}
.pet-context-menu button {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 4px;
  padding: 9px 8px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  color: var(--ink-main);
  background: transparent;
  cursor: pointer;
}
.pet-context-menu button:hover {
  background: var(--overlay-hover);
}
.pet-window button:focus-visible {
  outline: 2px solid var(--ink-accent);
  outline-offset: 2px;
}
.pet-load-error {
  position: absolute;
  bottom: 8px;
  left: 12px;
  right: 12px;
  padding: 8px;
  font-size: 12px;
  color: var(--state-danger-on);
  background: var(--state-danger-surface);
}
</style>
