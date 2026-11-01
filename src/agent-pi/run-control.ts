import { piCommand } from './client'
import type { PiRunControl, PiRunControlChange } from '@/types/agent-pi'
import type { PiTaskKind } from './tasks'

export const RUN_CONTROL_EVENT = 'ew-pi-run-control'
export const initialRunControl = (): PiRunControl => ({
  state: 'active',
  revision: 0,
  heldTasks: [],
  resumeAgent: false,
  pausedBookId: null,
  pendingInput: null,
  rankings: null
})
export function announceRunControl(sessionId: string, control: PiRunControl) {
  window.dispatchEvent(new CustomEvent(RUN_CONTROL_EVENT, { detail: { sessionId, control } }))
}
export const readRunControl = (sessionId: string) =>
  piCommand<PiRunControl>('run_control', { sessionId, action: 'read' })
export async function changeRunControl(
  sessionId: string,
  action: 'pause' | 'end' | 'resume' | 'release_task',
  extra: { resumeAgent?: boolean; revision?: number; task?: { kind: PiTaskKind; id: string } } = {}
) {
  const changed = await piCommand<PiRunControlChange>('run_control', { sessionId, action, ...extra })
  announceRunControl(sessionId, changed.control)
  return changed
}
export const allowsTaskContinuation = (control: PiRunControl, task: { kind: string; id: string }) =>
  control.state === 'active' &&
  !control.pendingInput &&
  !control.heldTasks.some(held => held.kind === task.kind && held.id === task.id)
