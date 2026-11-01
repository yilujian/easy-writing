import { Type, type JsonObject, validateToolArguments } from '@earendil-works/pi-ai'
import groups from '../contracts/tool-groups.json' with { type: 'json' }

type Schema = Record<string, unknown>
export interface ToolSpec {
  name: string
  label: string
  description: string
  parameters: object
}
type Group = { selector: string; default: string; label: string; operations: Record<string, string> }
const catalog: Record<string, Group> = groups
const owner = new Map(
  Object.entries(catalog).flatMap(([name, group]) =>
    Object.entries(group.operations).map(
      ([choice, operation]) => [operation, { name, selector: group.selector, choice }] as const
    )
  )
)

/** One public interface per group; each atomic operation retains its existing checks. */
export function publicTools(operations: ToolSpec[]): ToolSpec[] {
  const byName = new Map(operations.map(tool => [tool.name, tool]))
  return operations.flatMap(tool => {
    const group = catalog[tool.name]
    if (!group) return owner.has(tool.name) ? [] : [tool]
    const members = Object.entries(group.operations).map(([choice, operation]) => {
      const definition = byName.get(operation)
      if (!definition) throw new Error('工具分组缺少操作：' + operation)
      const schema = definition.parameters as Schema
      return { choice, definition, fields: Object.keys(schema.properties as Schema) }
    })
    const properties = Object.assign(
      {},
      ...members.map(({ definition }) => (definition.parameters as Schema).properties)
    )
    properties[group.selector] = {
      type: 'string',
      enum: Object.keys(group.operations),
      default: group.default
    }
    return [
      {
        name: tool.name,
        label: group.label,
        description: members
          .map(
            ({ choice, definition, fields }) =>
              `${group.selector}=${choice}（可填参数：${fields.join('、') || '无'}）。${toolReference(definition.description)}`
          )
          .join('\n'),
        parameters: { type: 'object', properties, additionalProperties: false }
      }
    ]
  })
}

export function resolveTool(name: string, input: Record<string, unknown>) {
  const group = catalog[name]
  if (!group) return { name, args: input }
  const choice = input[group.selector] === undefined ? group.default : String(input[group.selector])
  const operation = group.operations[choice]
  if (!Object.hasOwn(group.operations, choice))
    throw new Error('不支持的 ' + name + '.' + group.selector + '：' + choice)
  const args = { ...input }
  delete args[group.selector]
  return { name: operation, args }
}

/** Validate only the chosen operation. A provider sees a flat tool schema, while the
 * authorizations and required fields remain those of the selected operation. */
export function groupedArguments(
  name: string,
  id: string,
  input: Record<string, unknown>,
  operations: ToolSpec[]
) {
  if (!Object.hasOwn(catalog, name)) return { name, args: input }
  const group = catalog[name]
  let selected = input
  if (input[group.selector] === undefined) {
    // Some compatible providers omit the selector. Infer only an unambiguous operation
    // with all its required keys and no foreign keys; ambiguous payloads retain the default.
    const candidates = Object.entries(group.operations).filter(([, operation]) => {
      const schema = operations.find(op => op.name === operation)?.parameters as Schema | undefined
      if (!schema) return false
      const fields = (schema.properties || {}) as Schema
      return (
        Object.keys(input).every(key => Object.hasOwn(fields, key)) &&
        ((schema.required || []) as string[]).every(key => Object.hasOwn(input, key))
      )
    })
    if (candidates.length === 1) selected = { ...input, [group.selector]: candidates[0][0] }
  }
  const resolved = resolveTool(name, selected)
  const definition = operations.find(op => op.name === resolved.name)
  if (!definition) throw Error('工具分组缺少操作：' + resolved.name)
  const schema = definition.parameters as Schema
  const allowed = Object.keys((schema.properties || {}) as Schema)
  const extra = Object.keys(resolved.args).filter(key => !allowed.includes(key))
  const chosen = `${name}(${catalog[name].selector}=${selected[group.selector] ?? group.default})`
  if (extra.length)
    throw Error(`${chosen} 不接受 ${extra.join('、')}。本操作可填：${allowed.join('、') || '无'}。`)
  const args = validateToolArguments(
    { name, description: definition.description, parameters: Type.Unsafe(schema) },
    { type: 'toolCall', id, name, arguments: resolved.args as JsonObject }
  )
  return { name: resolved.name, args: args as Record<string, unknown> }
}

/** API references follow the current catalog; the author's Skill file is untouched. */
export function toolReference(text: string) {
  return text.replace(
    /\b(?:read_references|list_chapters|list_drafts|save_creation_draft|save_new_chapter_draft|save_outline_draft|save_skill_draft|search_writing_resources)\b/g,
    operation => {
      const target = owner.get(operation)!
      return target.name + '（' + target.selector + '=' + target.choice + '）'
    }
  )
}

export function toolNotice(source: string) {
  const names = [...owner]
    .filter(([operation, target]) => operation !== target.name && operation !== 'read_platform_state')
    .map(([name]) => name)
  const referenced = names.filter(name => new RegExp('\\b' + name + '\\b').test(source))
  const retired = /\b(?:read_creation_record|set_creation_record|present_creation)\b/.test(source)
    ? '\n建书任务登记接口已移除：沿用本对话已有要求，用 ask_author 提问、save_draft 提交候选；原方法的创作内容仍适用，平台保存真实问答，不再手动维护台账。'
    : ''
  return (
    retired +
    (referenced.length
      ? '\n平台当前接口对应（仅更新调用方式，原方法与原文不变）：\n' +
        referenced.map(name => name + ' → ' + toolReference(name)).join('\n')
      : '')
  )
}
