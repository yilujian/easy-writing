import contracts from '@/types/pi-entities.json'
import type { PiEntityDraft, PiEntityKind } from '@/types/agent-pi'

export interface PiField {
  label: string
  type: 'string' | 'number' | 'strings'
  default?: unknown
  reference?: string
  nullable?: boolean
  required?: boolean
  enum?: Array<string | number>
  options?: string[]
  min?: number
  max?: number
  format?: string
}
export interface PiEntitySpec {
  label: string
  collection: string
  createOnly?: boolean
  fields: Record<string, PiField>
}
export const entitySpecs: Record<PiEntityKind, PiEntitySpec> = contracts as Record<PiEntityKind, PiEntitySpec>
export function creationFields(draft: PiEntityDraft, content = draft.content): Record<string, unknown> {
  const values = JSON.parse(content)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('创作候选格式无效')
  return values
}
/** 展示顺序由契约决定。旧新书候选可显示空缺项，修改候选仍只展示实际修改项。 */
export function creationFormFields(draft: PiEntityDraft, content = draft.content): Record<string, unknown> {
  const values = creationFields(draft, content)
  const spec = entitySpecs[draft.entity]
  return Object.fromEntries(Object.entries(spec.fields)
    .filter(([key, field]) => Object.prototype.hasOwnProperty.call(values, key) || (draft.entity === 'book' && !draft.targetId && field.default !== undefined))
    .map(([key, field]) => [key, Object.prototype.hasOwnProperty.call(values, key) ? values[key] : structuredClone(field.default)]))
}
export function creationTitle(draft: PiEntityDraft, content = draft.content) {
  const values = creationFields(draft, content)
  return String(
    values.name ||
      values.title ||
      draft.baseEntity?.name ||
      draft.baseEntity?.title ||
      entitySpecs[draft.entity].label
  )
}
export function creationSummary(draft: PiEntityDraft, content = draft.content) {
  const label = creationTitle(draft, content)
  if (draft.entity === 'book') return `创建《${label}》，同时建立「第一卷」和空白「第1章」。`
  if (draft.entity === 'volume')
    return draft.targetId ? `更新分卷「${label}」的名称或卷纲。` : `创建分卷「${label}」，追加到作品目录末尾。`
  return `${draft.targetId ? '更新' : '创建'}${entitySpecs[draft.entity].label}「${label}」。只保存预览中列出的字段。`
}
