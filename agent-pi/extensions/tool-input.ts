/**
 * 模型在工具调用的 JSON 字符串里有时把换行多转义一次（写成字面的反斜杠加 n），
 * 解析出来的参数就带着两个字符“\n”，卡片和候选原样显示成乱码。
 * 这里在工具入口统一还原：只处理没有真换行、却带字面换行或制表符写法的字符串；
 * 带代码的工具（技能脚本、技能文件）保持原样，代码里的反斜杠有自己的含义。
 */
export const RAW_TEXT_TOOLS = new Set(['run_skill_script', 'save_skill_draft', 'read'])

const LITERAL_BREAK = /(?:\\r)?\\n|\\t/
export function decodeModelEscapes<T>(value: T): T {
  if (typeof value === 'string') {
    if (value.includes('\n') || !LITERAL_BREAK.test(value)) return value
    return value.replace(/(?:\\r)?\\n/g, '\n').replace(/\\t/g, '\t') as T
  }
  if (Array.isArray(value)) return value.map(item => decodeModelEscapes(item)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = decodeModelEscapes(item)
    return out as T
  }
  return value
}
