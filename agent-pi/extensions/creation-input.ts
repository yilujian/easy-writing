import contracts from '../../src/types/pi-entities.json' with { type: 'json' }

type Field = { type: string; label: string; default?: unknown; required?: boolean; nullable?: boolean; enum?: Array<string | number>; options?: string[]; min?: number; max?: number }
type Spec = { label: string; createOnly?: boolean; fields: Record<string, Field> }
const specs = contracts as Record<string, Spec>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const enumAliases: Record<string, Record<string, number>> = {
  role: { protagonist: 0, lead: 0, main_character: 0, 男主角: 0, 女主角: 0, supporting: 1, supporting_character: 1, 配角: 1, 男配角: 1, 女配角: 1, 重要配角: 1, antagonist: 2, villain: 2, extra: 3 },
  gender: { male: 1, female: 0, other: 2 }
}
/** 模型侧使用一个普通对象契约；实体专属规则在执行前给出定向错误，原生保存契约保持严格。 */
export const creationInputSchema = {
  type: 'object', required: ['entity', 'fields'], additionalProperties: true,
  properties: {
    entity: { type: 'string', description: Object.entries(specs).map(([id, spec]) => `${id}=${spec.label}`).join('；') },
    targetId: { type: ['string', 'null'], description: '修改已有资料时填写读取到的编号；创建省略' },
    draftId: { type: 'string', description: '修改当前未采用候选时填写，保留同一候选' },
    draftRevision: { type: 'integer', minimum: 1, description: '修改未采用候选时的当前修订号，防止覆盖作者编辑' },
    fields: { type: 'object', minProperties: 1, additionalProperties: true,
      description: '只提交当前 entity 的字段。新作品 book 使用 title（书名）、intro、category、tags（文字数组）、platform、perspective（人称）、voice（叙述口吻，一句话）、audience；仅书名必填，未确定的可选项保持空值。仿写建书可加 styleSkillId（已启用技能的编号）。为已有分卷写卷纲用 kind=entity、entity=volume、targetId=分卷编号、fields={summary:卷纲}。人物用 name/background/role/gender；世界观用 name/detail/type；大纲用 title/content/nodeType。不要把人物或世界观改存成大纲来规避字段错误。',
      properties: Object.fromEntries([...new Set(Object.values(specs).flatMap(spec => Object.keys(spec.fields)))].map(name => {
        const matches = Object.values(specs).flatMap(spec => spec.fields[name] ? [spec.fields[name]] : [])
        const types = [...new Set(matches.flatMap(field => field.type === 'strings' ? ['array'] : field.type === 'number' ? ['integer', 'string'] : field.nullable ? ['string', 'null'] : ['string']))]
        return [name, { type: types.length === 1 ? types[0] : types, description: [...new Set(matches.map(field => field.label + (field.enum ? '（' + field.enum.map((v, i) => `${v}=${field.options?.[i] || v}`).join('、') + '）' : '')))].join('；'), ...(types.includes('array') ? { items: { type: 'string' }, maxItems: 200 } : {}) }]
      }))
    }
  }
}
export function normalizeCreationInput(raw: Record<string, unknown>) {
  const entity = String(raw.entity || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  const spec = specs[entity]
  if (!Object.prototype.hasOwnProperty.call(specs, entity)) throw new Error(`未知资料类型「${raw.entity}」。请使用：${Object.keys(specs).join('、')}。`)
  const fail = (message: string): never => { throw new Error(`${spec.label}候选未提交：${message}。支持字段：${Object.keys(spec.fields).join('、')}。请修正这一实体，不要改存成其他类型。`) }
  const rootExtra = Object.keys(raw).filter(key => !['entity', 'fields', 'targetId', 'reason', 'draftId', 'draftRevision'].includes(key))
  if (rootExtra.length) fail(`顶层不支持 ${rootExtra.join('、')}`)
  if (!object(raw.fields)) fail('fields 须为单个对象；多个人物请分别提交')
  const fields: Record<string, unknown> = { ...raw.fields as Record<string, unknown> }
  const rename = (from: string, to: string) => {
    if (!(from in fields)) return
    if (to in fields && fields[to] !== fields[from]) fail(`${from} 与 ${to} 的内容冲突`)
    fields[to] = fields[from]; delete fields[from]
  }
  const append = (from: string, to: string, label: string) => {
    if (!(from in fields)) return
    const value = fields[from]
    if (typeof value !== 'string') fail(`${from} 须为文字`)
    if (fields[to] !== undefined && typeof fields[to] !== 'string') fail(`${to} 须为文字`)
    fields[to] = [fields[to], `${label}：${value}`].filter(Boolean).join('\n\n'); delete fields[from]
  }
  if (entity === 'book') rename('name', 'title')
  if (entity === 'character') {
    rename('title', 'name')
    if (!('background' in fields)) { if ('bio' in fields) rename('bio', 'background'); else rename('intro', 'background') }
    append('bio', 'background', '人物简介'); append('intro', 'background', '人物简介')
    append('motivation', 'background', '动机'); append('secret', 'background', '秘密')
  }
  if (entity === 'world_setting') {
    rename('title', 'name'); rename('intro', 'detail')
    if ('tags' in fields) {
      if (!Array.isArray(fields.tags) || fields.tags.length > 200 || fields.tags.some(tag => typeof tag !== 'string')) fail('tags 须为文字列表')
      if (fields.detail !== undefined && typeof fields.detail !== 'string') fail('detail 须为文字')
      fields.detail = [fields.detail, `标签：${(fields.tags as string[]).join('、')}`].filter(Boolean).join('\n\n'); delete fields.tags
    }
  }
  if (!Object.keys(fields).length) fail('fields 不能为空')
  for (const [key, value] of Object.entries(fields)) {
    const field = spec.fields[key]
    if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) fail(`不支持字段 ${key}`)
    if (value === null && field.nullable) continue
    if (field.type === 'number') {
      let n: unknown = value
      if (typeof value === 'string') {
        const index = field.options?.indexOf(value.trim()) ?? -1
        n = index >= 0 ? field.enum?.[index] : enumAliases[key]?.[value.trim().toLowerCase()] ?? (/^-?\d+$/.test(value.trim()) ? Number(value) : NaN)
      }
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || (field.enum && !field.enum.includes(n)) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max))
        fail(`${key} 的取值无效${field.enum ? '，可用 ' + field.enum.map((v, i) => `${v}=${field.options?.[i] || v}`).join('、') : '，须为合法整数'}`)
      fields[key] = n
    } else if (field.type === 'strings') {
      if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string')) fail(`${key} 须为最多 200 项的文字列表`)
    } else if (typeof value !== 'string') fail(`${key} 须为文字`)
  }
  const targetId = raw.targetId == null || raw.targetId === '' ? undefined : raw.targetId
  if (targetId !== undefined && typeof targetId !== 'string') fail('targetId 须为读取到的文字编号')
  if (targetId && spec.createOnly) fail('此类型只支持创建')
  if (!targetId) for (const [key, field] of Object.entries(spec.fields)) if (field.required && (!String(fields[key] ?? '').trim())) fail(`创建时必须填写 ${key}`)
  // 新书统一为完整七项；只补未提交的默认值，不推测创作定位，也不污染其他实体的局部修改。
  if (entity === 'book' && !targetId) {
    for (const [key, field] of Object.entries(spec.fields)) {
      if (!(key in fields) && field.default !== undefined) fields[key] = structuredClone(field.default)
    }
  }
  if (raw.draftId !== undefined && (typeof raw.draftId !== 'string' || !raw.draftId || !Number.isSafeInteger(raw.draftRevision) || Number(raw.draftRevision) < 1)) fail('修改候选须提供 draftId 与当前 draftRevision')
  return { entity, fields, ...(targetId ? { targetId } : {}), ...(raw.draftId ? { draftId: raw.draftId, draftRevision: raw.draftRevision } : {}) }
}
