import type { PiSkillDraft } from '@/types/agent-pi'

/**
 * 技能候选的内容：和宿主采用时的规则一致（名字 60 字、说明 300 字、正文 20 万字符、文件只在 references/ assets/ scripts/ 下，脚本只认 JavaScript），
 * 提交前先在这里核对，退回给模型改。
 */
export interface SkillDraftFile {
  path: string
  content: string
}
export interface SkillDraftFields {
  name: string
  description: string
  instructions: string
  files: SkillDraftFile[]
  replaceId: string | null
}
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
export function skillDraftFields(content: string): SkillDraftFields {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    /* 不是 JSON 就按空处理 */
  }
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map(item => {
      const file = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      return { path: str(file.path, 200).replace(/\\/g, '/'), content: typeof file.content === 'string' ? file.content : '' }
    })
    .filter(file => file.path)
  return {
    // 名字里不留空白：Pi 的 /skill:名字 命令按空格切名字
    name: str(raw.name, 80).replace(/\s+/g, '').slice(0, 60),
    description: str(raw.description, 300),
    instructions: typeof raw.instructions === 'string' ? raw.instructions.trim() : '',
    files,
    replaceId: str(raw.replaceId, 120) || null
  }
}
export const serializeSkillFields = (fields: SkillDraftFields) => JSON.stringify(fields)
export function skillDraftProblem(fields: SkillDraftFields): string {
  if (!fields.name) return '技能需要名字（60 字内）'
  if (!fields.description) return '技能需要一句话说明什么时候用（300 字内）'
  if (!fields.instructions) return '技能需要说明正文'
  if (fields.instructions.length > 200_000) return '技能说明超过 20 万字符'
  for (const file of fields.files) {
    const script = file.path.startsWith('scripts/')
    const allowed = file.path.startsWith('references/') || file.path.startsWith('assets/') || script
    if (!allowed || file.path.split('/').some(part => !part || part === '.' || part === '..'))
      return `文件只能放在 references/、assets/、scripts/ 下：${file.path}`
    if (script && !/\.(js|mjs|cjs)$/.test(file.path)) return `脚本只认 JavaScript：${file.path}`
    if (file.content.length > 2 * 1024 * 1024) return `${file.path} 超过 2 MB`
  }
  return ''
}
export const skillDraftTitle = (draft: PiSkillDraft, content = draft.content) => skillDraftFields(content).name || draft.title
