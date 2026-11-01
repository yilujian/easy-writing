import type { PetActivity, PetState } from './types'

export interface PetFeedback {
  state: PetState
  message: string
  target: string
}
export interface ActivePetTask extends PetActivity {
  updatedAt: number
}
export function feedbackForTask(task: PetActivity): PetFeedback {
  return {
    state: task.phase === 'error' ? 'error' : task.phase === 'done' ? 'celebrate' : 'thinking',
    message: task.message,
    target: task.target || ''
  }
}
/** 用户取消不庆祝、不报错；码字期间不被后台任务反复抢占。 */
export function choosePetFeedback(input: {
  typing: boolean
  tasks: ActivePetTask[]
  foreground: (target: string) => boolean
  flash: PetFeedback | null
  storageError: boolean
}): PetFeedback {
  if (input.storageError)
    return { state: 'error', message: '当前保存遇到问题，请回到平台处理。', target: 'current' }
  const live = input.tasks
    .filter(t => ['running', 'waiting', 'error'].includes(t.phase))
    .sort(
      (a, b) => Number(b.phase === 'waiting') - Number(a.phase === 'waiting') || b.updatedAt - a.updatedAt
    )
  const foreground = live.find(t => input.foreground(t.target || ''))
  if (foreground) return feedbackForTask(foreground)
  if (input.flash?.state === 'celebrate' && input.flash.target === '/writeStatistics') return input.flash
  if (input.typing) return { state: 'typing', message: '', target: '' }
  if (input.flash) return input.flash
  if (live[0]) return feedbackForTask(live[0])
  return { state: 'idle', message: '', target: '' }
}
export function goalMilestone(
  previous: number | null,
  current: number | null,
  target: number,
  seen: number[]
): number | null {
  if (previous === null || current === null || target <= 0 || current <= previous) return null
  const crossed = [25, 50, 75, 100].filter(
    percent =>
      !seen.includes(percent) && previous < (target * percent) / 100 && current >= (target * percent) / 100
  )
  return crossed.length ? crossed[crossed.length - 1] : null
}
