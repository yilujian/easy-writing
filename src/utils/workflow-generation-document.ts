import type { JsonRecord } from '@/types/json'
import type { GenerationEdit, GenerationPath } from '@/types/workflow-generation'

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
const safeKey = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key)
export const readGenerationPath = (document: JsonRecord, path: GenerationPath): unknown => {
  let value: unknown = document
  for (const part of path)
    value =
      typeof part === 'string'
        ? safeKey(part)
          ? (value as JsonRecord | undefined)?.[part]
          : undefined
        : Array.isArray(value)
          ? value.find(item => item?.id === part.id)
          : undefined
  return value
}

/** 数组对象按稳定 id 定位；用户改名、排序不会让后续生成覆盖另一个条目。 */
export const applyGenerationEdits = (document: JsonRecord, edits: GenerationEdit[]): JsonRecord => {
  const result = clone(document)
  for (const edit of edits) {
    if (!edit.path.length || edit.path.some(p => typeof p === 'string' && !safeKey(p))) continue
    let parent: JsonRecord | unknown[] = result
    for (let i = 0; i < edit.path.length - 1; i++) {
      const part = edit.path[i],
        next = edit.path[i + 1]
      const initial = typeof next === 'string' ? {} : []
      if (typeof part === 'string') {
        const object = parent as JsonRecord
        if (!object[part] || typeof object[part] !== 'object') object[part] = initial
        parent = object[part]
      } else {
        if (!Array.isArray(parent)) break
        let item = parent.find((row: JsonRecord) => row?.id === part.id) as JsonRecord | undefined
        if (!item) {
          item = { id: part.id }
          parent.push(item)
        }
        parent = item
      }
    }
    const key = edit.path[edit.path.length - 1]
    if (edit.op === 'order') {
      const array = readGenerationPath(result, edit.path)
      if (Array.isArray(array) && Array.isArray(edit.value)) {
        const order = edit.value as string[]
        array.sort((a, b) => {
          const ai = order.indexOf(a?.id),
            bi = order.indexOf(b?.id)
          return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi)
        })
      }
    } else if (typeof key === 'string') {
      if (edit.op === 'remove') delete (parent as JsonRecord)[key]
      else (parent as JsonRecord)[key] = clone(edit.value)
    } else if (Array.isArray(parent)) {
      const index = parent.findIndex((item: JsonRecord) => item?.id === key.id)
      if (edit.op === 'remove') {
        if (index >= 0) parent.splice(index, 1)
      } else if (index >= 0) parent[index] = clone(edit.value)
      else parent.push(clone(edit.value))
    }
  }
  return result
}

export const diffGenerationEdits = (
  before: unknown,
  after: unknown,
  path: GenerationPath = []
): GenerationEdit[] => {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (after === undefined) return [{ path, op: 'remove' }]
  const entityArray = (v: unknown): v is JsonRecord[] =>
    Array.isArray(v) && v.every(item => item && typeof item === 'object' && typeof item.id === 'string')
  // 这一块还没生成时作者先加了条目：也按条目记，后面模型生成的整块不会把作者的条目冲掉。
  if ((entityArray(before) || before === undefined) && entityArray(after)) {
    const previous = entityArray(before) ? before : []
    const edits: GenerationEdit[] = []
    for (const id of new Set([...previous, ...after].map(item => item.id))) {
      edits.push(
        ...diffGenerationEdits(
          previous.find(item => item.id === id),
          after.find(item => item.id === id),
          [...path, { id }]
        )
      )
    }
    edits.push({ path, op: 'order', value: after.map(item => item.id) })
    return edits
  }
  if (
    (before === undefined || (before && !Array.isArray(before) && typeof before === 'object')) &&
    after &&
    !Array.isArray(after) &&
    typeof after === 'object'
  ) {
    return [...new Set([...Object.keys(before || {}), ...Object.keys(after)])]
      .filter(safeKey)
      .flatMap(key =>
        diffGenerationEdits((before as JsonRecord | undefined)?.[key], (after as JsonRecord)[key], [
          ...path,
          key
        ])
      )
  }
  return [{ path, op: 'set', value: clone(after) }]
}
