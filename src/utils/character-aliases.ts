/** 角色称呼的统一规则；索引由角色资料派生，不单独保存。 */
export interface CharacterNames {
  id: string | number
  name: string
  aliases?: string[]
}

export const normalizeCharacterAliases = (name: string, value: unknown): string[] =>
  [...new Set((Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item && item !== name.trim()))]

export const getCharacterNames = (character: Pick<CharacterNames, 'name' | 'aliases'>) =>
  [character.name.trim(), ...normalizeCharacterAliases(character.name, character.aliases)].filter(Boolean)

export const buildCharacterNameIndex = <T extends CharacterNames>(characters: T[]) => {
  const index = new Map<string, T[]>()
  for (const character of characters) {
    for (const name of getCharacterNames(character)) {
      const candidates = index.get(name) || []
      if (!candidates.some(item => String(item.id) === String(character.id))) candidates.push(character)
      index.set(name, candidates)
    }
  }
  return index
}

export const isCharacterNameBoundary = (text: string, name: string, offset: number) =>
  !(/^[\p{Script=Latin}\d_]/u.test(name) && /[\p{Script=Latin}\d_]$/u.test(text.slice(0, offset))) &&
  !(/[\p{Script=Latin}\d_]$/u.test(name) && /^[\p{Script=Latin}\d_]/u.test(text.slice(offset + name.length)))

export const matchCharacterNames = <T extends CharacterNames>(characters: T[], text: string) => {
  const index = buildCharacterNameIndex(characters)
  const names = [...index.keys()].sort((a, b) => b.length - a.length)
  const matches = new Map<string, T[]>()
  if (!names.length || !text) return matches
  const matcher = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu')
  for (const match of text.matchAll(matcher)) {
    // 英文名称不应命中另一个英文单词内部；中文称呼允许紧邻叙述文字。
    if (!isCharacterNameBoundary(text, match[0], match.index!)) continue
    matches.set(match[0], index.get(match[0])!)
  }
  return matches
}
