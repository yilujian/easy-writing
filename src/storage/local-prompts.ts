import { PROMPT_FILE_DEFS, findPromptFileDef, type PromptFileDef } from '@/config/prompts'
import { LEGACY_PROMPT_TEXT_HASHES, hashPromptText } from '@/config/prompts/legacy-defaults'
import { isTauriRuntime } from '@/storage'

/**
 * 提示词库：全部 AI 提示词以 md 文件形式存在本地。
 *
 * - 桌面端：md 文件在「Documents/易创提示词/」目录（Rust 命令读写）。
 *   启动时读入全部文件；设置中心保存时写回文件；用户直接改 md、重启后生效。
 *   目录里缺哪个文件就按默认值补写哪个（删文件 = 恢复该场景默认）。
 * - 网页端（开发/预览）：没有文件系统，md 内容存 IndexedDB，格式与文件一致。
 * - 运行时：全部文本进内存缓存，组装器同步读取（initLocalPrompts 在挂载前完成）。
 * - 空槽位回退默认值：用户把某段删空不会把空提示词发给模型。
 */

const DB_NAME = 'ew-local-prompts'
const STORE_NAME = 'files'

type SlotTexts = Record<string, string>
type SlotTemps = Record<string, number>

const cache = new Map<string, SlotTexts>()
const tempCache = new Map<string, SlotTemps>()
let initialized = false

/** 温度钳制到合法区间；非数字返回 undefined */
const normalizeTemperature = (value: unknown): number | undefined => {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.min(2, Math.max(0, Math.round(num * 100) / 100))
}

// ---------------------------------------------------------------------------
// md 序列化 / 解析（格式：frontmatter 记 id，正文按 "## 槽名" 分段）
// ---------------------------------------------------------------------------

export const serializePromptFile = (def: PromptFileDef, slots: SlotTexts = {}, temps: SlotTemps = {}): string => {
  const lines: string[] = [
    '---',
    `id: ${def.id}`,
    '---',
    '',
    `> ${def.name} —— ${def.description}`,
    '> 按 "## 段名" 分段编辑，段名不要改；改坏了删掉这个文件即可恢复默认。',
  ]
  const varLines = def.slots
    .filter(slot => slot.variables?.length)
    .map(slot => `> 「${slot.label}」里的 ${slot.variables!.map(name => `{{${name}}}`).join('、')} 是程序代入的内容，请保留。`)
  lines.push(...varLines)
  if (def.slots.some(slot => slot.defaultTemperature !== undefined)) {
    lines.push('> 段首的「温度：x」是该段调用模型的采样温度（0-2，越低越稳、越高越发散），可改数值，别删这一行。')
  }
  lines.push('')
  for (const slot of def.slots) {
    const text = String(slots[slot.key] ?? slot.defaultText).trim() || slot.defaultText
    lines.push(`## ${slot.label}`, '')
    const temperature = temps[slot.key] ?? slot.defaultTemperature
    if (temperature !== undefined) lines.push(`温度：${temperature}`, '')
    lines.push(text, '')
  }
  return lines.join('\n')
}

export const parsePromptFile = (raw: string): { id: string; sections: Record<string, string> } | null => {
  const text = String(raw || '')
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/)
  const id = frontmatter?.[1].match(/(?:^|\n)id:\s*([\w-]+)/)?.[1] || ''
  if (!id) return null
  const sections: Record<string, string> = {}
  const matches = [...text.matchAll(/^## (.+)$/gm)]
  for (let index = 0; index < matches.length; index += 1) {
    const label = matches[index][1].trim()
    const start = matches[index].index! + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index! : text.length
    sections[label] = text.slice(start, end).trim()
  }
  return { id, sections }
}

/** 解析出的分段（按槽名）映射回槽 key；未知段名忽略，缺失段回默认。
 * 段首的「温度：x」行是槽级采样温度，剥出来单独存，不进提示词文本。 */
const sectionsToSlots = (
  def: PromptFileDef,
  sections: Record<string, string>
): { texts: SlotTexts; temps: SlotTemps } => {
  const texts: SlotTexts = {}
  const temps: SlotTemps = {}
  for (const slot of def.slots) {
    let text = String(sections[slot.label] ?? '').trim()
    const tempMatch = text.match(/^温度[:：]\s*([\d.]+)\s*\n?/)
    if (tempMatch) {
      const temperature = normalizeTemperature(tempMatch[1])
      if (temperature !== undefined) temps[slot.key] = temperature
      text = text.slice(tempMatch[0].length).trim()
    }
    // 旧版默认值原样躺在文件里（用户没改过）→ 自动升级为新默认值
    if (text && LEGACY_PROMPT_TEXT_HASHES.has(hashPromptText(text))) text = ''
    texts[slot.key] = text || slot.defaultText
  }
  return { texts, temps }
}

const applyParsed = (def: PromptFileDef, sections: Record<string, string>) => {
  const { texts, temps } = sectionsToSlots(def, sections)
  cache.set(def.id, texts)
  tempCache.set(def.id, temps)
}

// ---------------------------------------------------------------------------
// 网页端兜底存储（IndexedDB 存 md 全文，键 = 文件 id）
// ---------------------------------------------------------------------------

const withIdb = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 加载 / 保存
// ---------------------------------------------------------------------------

const fileNameOf = (def: PromptFileDef) => `${def.name}.md`

const loadFromDesktop = async () => {
  const { invoke } = await import('@tauri-apps/api/core')
  const documents = await invoke<Array<{ fileName: string; content: string }>>('list_prompt_documents')
  const parsedById = new Map<string, Record<string, string>>()
  for (const doc of documents) {
    const parsed = parsePromptFile(doc.content)
    if (parsed) parsedById.set(parsed.id, parsed.sections)
  }
  for (const def of PROMPT_FILE_DEFS) {
    const sections = parsedById.get(def.id)
    if (sections) {
      applyParsed(def, sections)
    } else {
      // 仅创建缺失文件，不覆盖无法识别的原文件；单组失败不影响其他组。
      applyParsed(def, {})
      try {
        const created = await invoke<boolean>('ensure_prompt_document', {
          fileName: fileNameOf(def),
          content: serializePromptFile(def),
        })
        if (!created) console.warn(`「${def.name}」文件存在但无法识别，原文件未覆盖，本次使用默认值`)
      } catch (error) {
        console.warn(`「${def.name}」默认文件无法创建，原文件未修改`, error)
      }
    }
  }
}

const loadFromWeb = async () => {
  for (const def of PROMPT_FILE_DEFS) {
    const stored = await withIdb<unknown>('readonly', store => store.get(def.id))
    const parsed = typeof stored === 'string' ? parsePromptFile(stored) : null
    applyParsed(def, parsed?.sections || {})
  }
}

/** 启动时装载全部提示词（挂载应用前 await，保证组装器同步读取时已就绪） */
export const initLocalPrompts = async () => {
  if (initialized) return
  try {
    if (isTauriRuntime()) await loadFromDesktop()
    else await loadFromWeb()
  } catch (error) {
    // 保留已加载的自定义内容，仅为未加载的组补默认值。
    console.warn('提示词库装载失败，使用内置默认值', error)
    for (const def of PROMPT_FILE_DEFS) if (!cache.has(def.id)) applyParsed(def, {})
  }
  initialized = true
}

/** 保存一个场景的全部槽位（界面编辑用）：写回 md（桌面=文件 / 网页=IndexedDB）并刷新缓存 */
export const saveLocalPromptFile = async (fileId: string, slots: SlotTexts, temps: SlotTemps = {}) => {
  const def = findPromptFileDef(fileId)
  if (!def) throw new Error('提示词场景不存在')
  const normalized: SlotTexts = {}
  const normalizedTemps: SlotTemps = {}
  for (const slot of def.slots) {
    normalized[slot.key] = String(slots[slot.key] ?? '').trim() || slot.defaultText
    if (slot.defaultTemperature !== undefined) {
      normalizedTemps[slot.key] = normalizeTemperature(temps[slot.key]) ?? slot.defaultTemperature
    }
  }
  const content = serializePromptFile(def, normalized, normalizedTemps)
  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_prompt_document', { fileName: fileNameOf(def), content })
  } else {
    await withIdb('readwrite', store => store.put(content, def.id))
  }
  cache.set(def.id, normalized)
  tempCache.set(def.id, normalizedTemps)
  return normalized
}

/** 恢复一个场景的默认值（重写 md 文件） */
export const resetLocalPromptFile = async (fileId: string) => {
  return await saveLocalPromptFile(fileId, {})
}

export const getPromptDirPath = async (): Promise<string> => {
  if (!isTauriRuntime()) return ''
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<string>('get_prompt_dir')
}

export const openPromptDir = async () => {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_prompt_dir')
}

// ---------------------------------------------------------------------------
// 运行时读取（组装器同步调用）
// ---------------------------------------------------------------------------

/** 取一段提示词文本（用户改过取改过的，否则默认值） */
export const promptText = (fileId: string, slotKey: string): string => {
  const cached = cache.get(fileId)?.[slotKey]
  if (cached) return cached
  const def = findPromptFileDef(fileId)
  const slot = def?.slots.find(item => item.key === slotKey)
  return slot?.defaultText || ''
}

/** 取文本并代入 {{变量}}；模板里没出现的变量忽略，未提供的变量替换为空 */
export const renderPromptText = (
  fileId: string,
  slotKey: string,
  vars: Record<string, string | number> = {}
): string => {
  return promptText(fileId, slotKey)
    .replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => String(vars[name.trim()] ?? ''))
    .trim()
}

/** 取一个槽的采样温度：用户改过取改过的，否则场景默认；无定义 = 不调温 */
export const promptTemperature = (fileId: string, slotKey: string): number | undefined => {
  const cached = tempCache.get(fileId)?.[slotKey]
  if (cached !== undefined) return cached
  const def = findPromptFileDef(fileId)
  return def?.slots.find(item => item.key === slotKey)?.defaultTemperature
}

/** 界面编辑用：当前生效的全部槽位温度（仅含定义了温度的槽） */
export const getLocalPromptTemps = (fileId: string): SlotTemps => {
  const def = findPromptFileDef(fileId)
  if (!def) return {}
  const current = tempCache.get(fileId) || {}
  const temps: SlotTemps = {}
  for (const slot of def.slots) {
    if (slot.defaultTemperature !== undefined) {
      temps[slot.key] = current[slot.key] ?? slot.defaultTemperature
    }
  }
  return temps
}

/** 界面编辑用：当前生效的全部槽位文本 */
export const getLocalPromptSlots = (fileId: string): SlotTexts => {
  const def = findPromptFileDef(fileId)
  if (!def) return {}
  const current = cache.get(fileId) || {}
  const slots: SlotTexts = {}
  for (const slot of def.slots) slots[slot.key] = current[slot.key] || slot.defaultText
  return slots
}

/** 某场景是否有槽位偏离默认值（界面上标"已修改"） */
export const isPromptFileModified = (fileId: string): boolean => {
  const def = findPromptFileDef(fileId)
  if (!def) return false
  const current = cache.get(fileId)
  if (!current) return false
  const currentTemps = tempCache.get(fileId) || {}
  return def.slots.some(slot => {
    if ((current[slot.key] || slot.defaultText) !== slot.defaultText) return true
    if (slot.defaultTemperature === undefined) return false
    return (currentTemps[slot.key] ?? slot.defaultTemperature) !== slot.defaultTemperature
  })
}
