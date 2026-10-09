import { appSettings } from '@/storage/app-settings'
/**
 * 敏感词本地词库：替代旧服务端 /writing/utility/check 数据通道。
 *
 * 词库两层合并生效：
 * - 内置基础词库（本文件）：只收高特异性词——几乎只在违规语境出现的词。
 *   网文剧情里"杀/血/赌/死"是正常内容，把这类常用字词收进来会整篇误报，
 *   功能就成了噪音；平台机审真正普遍拦截的是露骨性描写、毒品交易、
 *   现实赌博引流、极端辱骂这类词，内置库聚焦这些。
 * - 用户自定义层（localStorage `ew-local-sensitive-words`）：可补词、可停用
 *   内置词。编辑界面在待办（见开源改造批次计划），存储形状已定，本批只读。
 *
 * 涉政类内置留空：各平台审核标准差异大且随时间变化，收进开源仓库既难维护
 * 也容易过时，请按目标平台要求在自定义层添加。
 */

export interface SensitiveMatchItem {
  word: string
  type: number
  typeLabel: string
  count: number
}

export interface SensitiveScanResult {
  hasSensitive: boolean
  total: number
  words: string[]
  matches: SensitiveMatchItem[]
}

export const SENSITIVE_TYPE_LABELS: Record<number, string> = {
  1: '涉政敏感',
  2: '色情低俗',
  3: '暴力血腥',
  4: '赌毒违禁',
  5: '辱骂脏话',
}

const label = (type: number) => SENSITIVE_TYPE_LABELS[type] || '其他'

interface LexiconEntry {
  word: string
  type: number
}

// 内置基础词库。收词三条线：词长 ≥ 2、高特异性（正常剧情几乎不用）、
// 平台机审普遍拦截。宁缺毋滥——误报比漏报伤害大。
const BUILTIN_SENSITIVE_WORDS: LexiconEntry[] = [
  // 色情低俗：露骨性描写用词（网文平台机审红线）
  { word: '做爱', type: 2 },
  { word: '性交', type: 2 },
  { word: '交媾', type: 2 },
  { word: '轮奸', type: 2 },
  { word: '强奸', type: 2 },
  { word: '奸淫', type: 2 },
  { word: '嫖娼', type: 2 },
  { word: '卖淫', type: 2 },
  { word: '援交', type: 2 },
  { word: '一夜情', type: 2 },
  { word: '自慰', type: 2 },
  { word: '手淫', type: 2 },
  { word: '春药', type: 2 },
  { word: '催情药', type: 2 },
  { word: '迷奸', type: 2 },
  { word: '兽交', type: 2 },
  { word: '乱伦', type: 2 },
  { word: '幼女', type: 2 },
  { word: '恋童', type: 2 },
  { word: '裸聊', type: 2 },
  { word: '色情片', type: 2 },
  { word: '黄片', type: 2 },
  { word: 'AV女优', type: 2 },
  { word: '援助交际', type: 2 },
  // 暴力血腥：极端细节描写词（过度血腥是平台重点整治项）
  { word: '碎尸', type: 3 },
  { word: '分尸', type: 3 },
  { word: '肢解', type: 3 },
  { word: '开膛破肚', type: 3 },
  { word: '虐杀', type: 3 },
  { word: '虐尸', type: 3 },
  { word: '奸杀', type: 3 },
  { word: '轮暴', type: 3 },
  { word: '灭门惨案', type: 3 },
  { word: '自杀教程', type: 3 },
  { word: '教你自杀', type: 3 },
  // 赌毒违禁：现实毒品/赌博引流/枪爆（虚构剧情一般不用这些现实词）
  { word: '海洛因', type: 4 },
  { word: '冰毒', type: 4 },
  { word: '摇头丸', type: 4 },
  { word: '大麻', type: 4 },
  { word: '可卡因', type: 4 },
  { word: '吗啡', type: 4 },
  { word: 'K粉', type: 4 },
  { word: '氯胺酮', type: 4 },
  { word: '罂粟壳', type: 4 },
  { word: '制毒', type: 4 },
  { word: '贩毒', type: 4 },
  { word: '吸毒', type: 4 },
  { word: '毒品交易', type: 4 },
  { word: '开设赌场', type: 4 },
  { word: '网络赌博', type: 4 },
  { word: '赌博网站', type: 4 },
  { word: '线上投注', type: 4 },
  { word: '博彩平台', type: 4 },
  { word: '六合彩', type: 4 },
  { word: '时时彩', type: 4 },
  { word: '私彩', type: 4 },
  { word: '洗码', type: 4 },
  { word: '军火交易', type: 4 },
  { word: '买卖枪支', type: 4 },
  { word: '自制炸药', type: 4 },
  { word: '炸弹制作', type: 4 },
  { word: '雷管', type: 4 },
  // 辱骂脏话：常见极端辱骂（对话里偶发脏话平台通常也会拦）
  { word: '操你妈', type: 5 },
  { word: '草你妈', type: 5 },
  { word: '日你妈', type: 5 },
  { word: '你妈死了', type: 5 },
  { word: '狗杂种', type: 5 },
  { word: '贱货', type: 5 },
  { word: '婊子', type: 5 },
  { word: '妓女', type: 5 },
  { word: '傻逼', type: 5 },
  { word: '煞笔', type: 5 },
  { word: '沙比', type: 5 },
  { word: '妈了个逼', type: 5 },
  { word: '狗娘养的', type: 5 },
]

// ---------------------------------------------------------------------------
// 用户自定义层（编辑入口在待办，存储形状先定；本批只读取）
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ew-local-sensitive-words'

export interface UserSensitiveLexicon {
  version: 1
  /** 用户补充的词（type 缺省归 0/其他） */
  custom: LexiconEntry[]
  /** 用户停用的内置词（按词面匹配） */
  disabled: string[]
}

export const loadUserSensitiveLexicon = (): UserSensitiveLexicon => {
  const empty: UserSensitiveLexicon = { version: 1, custom: [], disabled: [] }
  try {
    const parsed = JSON.parse(appSettings.getItem(STORAGE_KEY) || '')
    if (!parsed || parsed.version !== 1) return empty
    return {
      version: 1,
      custom: Array.isArray(parsed.custom)
        ? parsed.custom
            .filter((item: LexiconEntry) => item && typeof item.word === 'string' && item.word.trim())
            .map((item: LexiconEntry) => ({ word: item.word.trim(), type: Number(item.type) || 0 }))
        : [],
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.map(String) : [],
    }
  } catch {
    return empty
  }
}

/** 词库变更广播：写作台监听后对当前章节重扫（设置中心改词即时生效） */
export const SENSITIVE_LEXICON_UPDATED_EVENT = 'ew-sensitive-lexicon-updated'

const saveUserSensitiveLexicon = (lexicon: UserSensitiveLexicon) => {
  try {
    appSettings.setItem(STORAGE_KEY, JSON.stringify(lexicon))
    window.dispatchEvent(new CustomEvent(SENSITIVE_LEXICON_UPDATED_EVENT))
  } catch (error) {
    console.warn('写入敏感词自定义层失败', error)
  }
}

export interface LexiconMutationResult {
  ok: boolean
  message: string
}

/**
 * 添加自定义词。词长硬限 ≥ 2（单字会整篇误报，与内置库同一条卫生线）。
 * 词面与被停用的内置词相同时按"恢复内置词"处理，不产生重复条目。
 */
export const addCustomSensitiveWord = (word: string, type: number): LexiconMutationResult => {
  const value = String(word || '').trim()
  if (!value) return { ok: false, message: '请输入词条' }
  if (value.length < 2) return { ok: false, message: '词条至少两个字：单字几乎必然整篇误报' }
  const user = loadUserSensitiveLexicon()
  const builtin = BUILTIN_SENSITIVE_WORDS.find(entry => entry.word === value)
  if (builtin) {
    if (!user.disabled.includes(value)) {
      return { ok: false, message: `「${value}」已在内置词库（${label(builtin.type)}）` }
    }
    saveUserSensitiveLexicon({ ...user, disabled: user.disabled.filter(item => item !== value) })
    return { ok: true, message: `「${value}」是内置词，已恢复启用` }
  }
  if (user.custom.some(entry => entry.word === value)) {
    return { ok: false, message: `「${value}」已在自定义词里` }
  }
  saveUserSensitiveLexicon({
    ...user,
    custom: [...user.custom, { word: value, type: Number(type) || 0 }],
  })
  return { ok: true, message: `已添加「${value}」` }
}

export const removeCustomSensitiveWord = (word: string) => {
  const user = loadUserSensitiveLexicon()
  saveUserSensitiveLexicon({ ...user, custom: user.custom.filter(entry => entry.word !== word) })
}

/** 停用/恢复内置词（误报的词停掉即可，不必删词库） */
export const setBuiltinWordDisabled = (word: string, disabled: boolean) => {
  const user = loadUserSensitiveLexicon()
  const next = disabled
    ? user.disabled.includes(word) ? user.disabled : [...user.disabled, word]
    : user.disabled.filter(item => item !== word)
  saveUserSensitiveLexicon({ ...user, disabled: next })
}

/** 生效词表 = 内置 − 停用 + 自定义（同词自定义类型优先） */
export const getEffectiveSensitiveWords = (): LexiconEntry[] => {
  const user = loadUserSensitiveLexicon()
  const disabled = new Set(user.disabled)
  const merged = new Map<string, LexiconEntry>()
  for (const entry of BUILTIN_SENSITIVE_WORDS) {
    if (!disabled.has(entry.word)) merged.set(entry.word, entry)
  }
  for (const entry of user.custom) {
    if (!disabled.has(entry.word)) merged.set(entry.word, entry)
  }
  return [...merged.values()]
}

// ---------------------------------------------------------------------------
// 扫描引擎
// ---------------------------------------------------------------------------

/** 全文扫描：逐词计数（词库百余条 × 万字文本毫秒级，词库大了再上 trie） */
export const scanSensitiveText = (
  text: string,
  lexicon: LexiconEntry[] = getEffectiveSensitiveWords()
): SensitiveScanResult => {
  const content = String(text || '')
  const matches: SensitiveMatchItem[] = []
  let total = 0
  if (content) {
    for (const entry of lexicon) {
      let count = 0
      let index = content.indexOf(entry.word)
      while (index !== -1) {
        count += 1
        index = content.indexOf(entry.word, index + entry.word.length)
      }
      if (count > 0) {
        matches.push({ word: entry.word, type: entry.type, typeLabel: label(entry.type), count })
        total += count
      }
    }
  }
  matches.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
  return {
    hasSensitive: matches.length > 0,
    total,
    words: matches.map(item => item.word),
    matches,
  }
}

/** 词库卫生自检口径（单测用）：词长 ≥ 2 且无重复，防止误报单字混入 */
export const listBuiltinSensitiveWords = (): LexiconEntry[] => [...BUILTIN_SENSITIVE_WORDS]
