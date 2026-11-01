import { watch, type WatchStopHandle } from 'vue'
import { listen } from '@tauri-apps/api/event'
import type { Router } from 'vue-router'
import dayjs from 'dayjs'
import { appSettings } from '@/storage/app-settings'
import { getStatsOverview, getStatsTargets } from '@/storage/local-write-stats'
import { useWritingPlanStore } from '@/stores/writing-plan'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { useThemeStore } from '@/stores/theme'
import { useUiPreferencesStore } from '@/stores/ui-preferences'
import { usePiWorkspace } from '@/views/AgentPi/use-pi-workspace'
import { piTasks } from '@/agent-pi/tasks'
import { listenPetState, petCommand, petSnapshot } from './client'
import { PET_ACTIVITY_EVENT, type PetActivity, type PetView } from './types'
import {
  choosePetFeedback,
  feedbackForTask,
  goalMilestone,
  type ActivePetTask,
  type PetFeedback
} from './state'

export async function installPetCoordinator(router: Router, openSettings: () => void) {
  const plan = useWritingPlanStore(),
    editor = useWritingEditorStore(),
    theme = useThemeStore(),
    ui = useUiPreferencesStore()
  // 只观察既有 Store，不调用 initialize，不启动对话或恢复任务。
  const pi = usePiWorkspace()
  const tasks = new Map<string, ActivePetTask>(),
    previous = new Map<string, PetActivity>()
  const stops: Array<() => void> = []
  let storageError = false,
    flash: PetFeedback | null = null,
    flashUntil = 0,
    lastPublished = '',
    publishing = false
  let lastEnabled = false,
    goalKey = '',
    previousManual: number | null = null,
    previousAi: number | null = null
  let lastRoutineFeedback = 0
  let milestones: { key: string; manual: number[]; ai: number[] } = { key: '', manual: [], ai: [] }
  try {
    const saved = JSON.parse(appSettings.getItem('ew-desktop-pet-milestones') || '{}')
    if (saved && typeof saved.key === 'string' && Array.isArray(saved.manual) && Array.isArray(saved.ai))
      milestones = saved
  } catch {
    /* 首次使用 */
  }

  function receive(activity: PetActivity) {
    const before = tasks.get(activity.id)
    const target =
      activity.target === 'current' ? before?.target || router.currentRoute.value.path : activity.target
    if (activity.phase === 'cancelled' || activity.phase === 'done') tasks.delete(activity.id)
    else tasks.set(activity.id, { ...activity, target, updatedAt: Date.now() })
    if (activity.phase === 'done' || activity.phase === 'error') {
      // 开启桌宠之前完成的任务不在重新显示时补播。
      if (
        petSnapshot.value.preferences.enabled &&
        (activity.phase === 'error' || Date.now() - lastRoutineFeedback >= 30000)
      ) {
        if (activity.phase === 'done') lastRoutineFeedback = Date.now()
        flash = feedbackForTask({ ...activity, target })
        flashUntil = Date.now() + (activity.phase === 'error' ? 8000 : 2800)
      }
      if (activity.phase === 'error') tasks.delete(activity.id)
    }
    void publish()
  }
  const onActivity = (event: Event) => receive((event as CustomEvent<PetActivity>).detail)
  window.addEventListener(PET_ACTIVITY_EVENT, onActivity)
  stops.push(() => window.removeEventListener(PET_ACTIVITY_EVENT, onActivity))
  const observe = (
    id: string,
    phase: PetActivity['phase'] | null,
    message: string,
    target: string,
    next: Map<string, PetActivity>
  ) => {
    if (!phase) return
    const item = { id, phase, message, target }
    next.set(id, item)
    const old = previous.get(id)
    if (!old || old.phase !== phase || old.message !== message) {
      // 历史记录恢复时不播“刚完成”；真正从运行状态变为完成才反馈。
      if (phase !== 'done' || old?.phase === 'running' || old?.phase === 'waiting') receive(item)
    }
  }
  function refreshTasks() {
    const next = new Map<string, PetActivity>()
    for (const item of pi.petActivities) observe(item.id, item.phase, item.message, item.target || '', next)
    for (const item of piTasks.value) {
      const phase =
        item.status === 'completed'
          ? 'done'
          : item.status === 'failed'
            ? 'error'
            : item.status === 'waiting'
              ? 'waiting'
              : item.active
                ? 'running'
                : null
      const kind = { breakdown: '拆书', distillation: '文风分析', batch: '批量写作', cover: '封面生成' }[
        item.kind
      ]
      observe(
        `task:${item.id}`,
        phase,
        phase === 'done'
          ? `${kind}已完成，去看看结果吧。`
          : phase === 'error'
            ? `${kind}未完成，点击查看原因。`
            : phase === 'waiting'
              ? `${kind}等待你的确认。`
              : `正在${kind}…`,
        `pi-session:${item.sessionId}`,
        next
      )
    }
    for (const [id] of previous) if (!next.has(id)) tasks.delete(id)
    previous.clear()
    next.forEach((value, key) => previous.set(key, value))
  }
  function refreshGoals() {
    if (!petSnapshot.value.preferences.enabled) {
      goalKey = ''
      return
    }
    const date = dayjs().format('YYYY-MM-DD'),
      target = getStatsTargets(),
      stats = getStatsOverview(date)
    const manual = plan.bookId && plan.todayWordsAvailable ? plan.todayWords : stats.manualWords
    const ai = stats.aiWords
    const key = `${date}:${ui.wordCountMode}:${target.manual}:${target.ai}`
    if (goalKey !== key) {
      goalKey = key
      previousManual = manual
      previousAi = ai
      if (milestones.key !== key) milestones = { key, manual: [], ai: [] }
      return
    }
    const manualHit = goalMilestone(previousManual, manual, target.manual, milestones.manual)
    const aiHit = goalMilestone(previousAi, ai, target.ai, milestones.ai)
    previousManual = manual
    previousAi = ai
    if (manualHit === null && aiHit === null) return
    for (const [name, value] of [
      ['manual', manualHit],
      ['ai', aiHit]
    ] as const)
      if (value !== null) {
        milestones[name] = [...new Set([...milestones[name], ...[25, 50, 75, 100].filter(p => p <= value)])]
      }
    appSettings.setItem('ew-desktop-pet-milestones', JSON.stringify(milestones))
    const hit = manualHit ?? aiHit!,
      label = manualHit !== null ? '手写' : 'AI'
    flash = {
      state: hit === 100 ? 'celebrate' : 'idle',
      message:
        hit === 100 ? `今日${label}目标已完成，辛苦啦！` : `今日${label}目标已完成 ${hit}%，继续慢慢写。`,
      target: '/writeStatistics'
    }
    flashUntil = Date.now() + 3500
  }
  function foreground(target: string) {
    const route = router.currentRoute.value.path
    if (target.startsWith('pi:')) return route === '/agent-pi' && target === `pi:${pi.activeKey}`
    if (target.startsWith('pi-session:'))
      return route === '/agent-pi' && target === `pi-session:${pi.sessionId}`
    return route === target
  }
  async function publish() {
    if (publishing || !petSnapshot.value.preferences.enabled) return
    const feedback = choosePetFeedback({
      typing: router.currentRoute.value.path.startsWith('/writing/') && Date.now() - plan.lastTypingAt < 2500,
      tasks: [...tasks.values()],
      foreground,
      flash: Date.now() < flashUntil ? flash : null,
      storageError
    })
    const value: PetView = { ...feedback, theme: theme.currentTheme, quiet: editor.focusMode }
    const key = JSON.stringify(value)
    if (key === lastPublished) return
    publishing = true
    try {
      await petCommand('publish', value)
      lastPublished = key
    } catch (error) {
      console.warn('桌宠状态同步失败', error)
    } finally {
      publishing = false
    }
  }
  const failed = () => {
    storageError = true
    void publish()
  }
  const recovered = () => {
    storageError = false
    void publish()
  }
  window.addEventListener('ew-writing-storage-unavailable', failed)
  window.addEventListener('ew-writing-storage-recovered', recovered)
  stops.push(() => {
    window.removeEventListener('ew-writing-storage-unavailable', failed)
    window.removeEventListener('ew-writing-storage-recovered', recovered)
  })
  try {
    stops.push(
      await listenPetState(() => {
        const enabled = petSnapshot.value.preferences.enabled
        if (enabled && !lastEnabled) {
          lastPublished = ''
          goalKey = ''
          void publish()
        }
        lastEnabled = enabled
      })
    )
    stops.push(await listen<PetActivity>(PET_ACTIVITY_EVENT, event => receive(event.payload)))
    stops.push(
      await listen<string>('ew-desktop-pet-activate', async event => {
        const target = event.payload
        if (target === 'settings') {
          openSettings()
          return
        }
        if (target.startsWith('pi:')) {
          await router.push('/agent-pi')
          pi.focusPetChat(target.slice(3))
          return
        }
        if (target.startsWith('pi-session:')) {
          await router.push('/agent-pi')
          await pi.initialize()
          const session = pi.sessions.find(s => s.id === target.slice(11))
          if (session) await pi.selectSession(session)
          return
        }
        if (target.startsWith('/') && !target.startsWith('//')) await router.push(target)
      })
    )
    await petCommand('get')
    await petCommand('restore')
    lastEnabled = petSnapshot.value.preferences.enabled
    const stopWatch: WatchStopHandle = watch(
      () => [
        pi.petActivities,
        piTasks.value.map(t => [t.id, t.status, t.active])
      ],
      refreshTasks,
      { deep: true, immediate: true }
    )
    stops.push(stopWatch)
    let lastGoalCheck = 0
    const timer = setInterval(() => {
      if (Date.now() - lastGoalCheck >= 3000) {
        lastGoalCheck = Date.now()
        refreshGoals()
      }
      void publish()
    }, 500)
    stops.push(() => clearInterval(timer))
    void publish()
  } catch (error) {
    stops.forEach(stop => stop())
    throw error
  }
  return () => stops.forEach(stop => stop())
}
