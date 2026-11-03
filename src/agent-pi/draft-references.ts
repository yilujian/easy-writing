import type { PiDraft } from '@/types/agent-pi'

/** 平台工具成功保存候选后返回的引用；不能从模型回复或标题推断。 */
export function draftIdFromResult(details: unknown): string | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const id = (details as Record<string, unknown>).draftId
  return typeof id === 'string' && id.trim() ? id : undefined
}

/** 结果回执尚未到达时，只关联已经落盘、来源调用明确的候选。 */
export function draftBelongsToCall(draft: PiDraft, callId: string): boolean {
  return draft.proseSource?.callId === callId || draft.id === `${draft.sessionId}:${callId}`
}
