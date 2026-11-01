import { isTauri } from '@tauri-apps/api/core'
import { PET_ACTIVITY_EVENT, type PetActivity } from './types'

/** 旁路反馈：不等待桌宠、不传正文/凭据、不影响业务成功或取消语义。 */
export function notifyPetActivity(activity: PetActivity) {
  if (!isTauri()) return
  window.dispatchEvent(new CustomEvent(PET_ACTIVITY_EVENT, { detail: activity }))
  // 独立写作面板里的 AI 请求同样转给主窗口汇总。
  void import('@tauri-apps/api/window')
    .then(async ({ getCurrentWindow }) => {
      if (getCurrentWindow().label === 'main') return
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', PET_ACTIVITY_EVENT, activity)
    })
    .catch(() => undefined)
}
export function beginPetActivity(message: string, target = 'current') {
  if (!isTauri()) return { done: () => {}, error: () => {}, cancel: () => {} }
  const id = `request:${crypto.randomUUID()}`
  let settled = false
  notifyPetActivity({ id, phase: 'running', message: message.slice(0, 70), target })
  const finish = (phase: 'done' | 'error' | 'cancelled', result: string) => {
    if (settled) return
    settled = true
    notifyPetActivity({ id, phase, message: result, target })
  }
  return {
    done: () => finish('done', '结果已生成，去看看吧。'),
    error: () => finish('error', '这次任务未完成，点击查看原因。'),
    cancel: () => finish('cancelled', '')
  }
}
