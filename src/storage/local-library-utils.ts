import { getWritingStorage } from '@/storage'
import type {
  LocalBook,
  LocalBookGroup,
  LocalChapter,
  LocalExportPayload,
  LocalImportPreview,
  LocalLibraryVolume,
  LocalParsedBook,
  LocalVolume,
} from './local-library-types'
import type { TextCounts } from '@/types/ui-preferences'
import { countWords } from '@/utils/word-count'

export const LOCAL_USER_ID = 'guest'

let localIdSeed = 0

export const createLocalEntityId = () => {
  localIdSeed = (localIdSeed + 1) % 1000
  return -(Date.now() * 1000 + localIdSeed)
}

export const isLocalEntityId = (id?: number | string | null) => {
  const value = Number(id)
  return Number.isFinite(value) && value < 0
}

export const nowIso = () => new Date().toISOString()

export const normalizeLocalBook = (payload: Partial<LocalBook>): LocalBook => {
  const createdAt = payload.createTime || nowIso()
  const title = String(payload.title || '').trim() || '未命名作品'
  return {
    id: Number(payload.id || createLocalEntityId()),
    title,
    intro: String(payload.intro || ''),
    // 工作流建书把 { workflowRunId } 写在这里，写作页据此恢复工作流控制面板
    globalInstruction: payload.globalInstruction ?? null,
    coverUrl: payload.coverUrl || '',
    category: payload.category || '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    platform: payload.platform || '',
    perspective: payload.perspective || '',
    audience: payload.audience || '',
    groupId: payload.groupId == null || payload.groupId === '' ? null : String(payload.groupId),
    status: Number(payload.status || 0),
    visibility: Number(payload.visibility || 0),
    wordCount: Number(payload.wordCount || 0),
    textWordCount: payload.textWordCount ?? (Number(payload.wordCount || 0) === 0 ? 0 : null),
    chapterCount: Number(payload.chapterCount || 0),
    authorId: LOCAL_USER_ID,
    createTime: createdAt,
    updateTime: payload.updateTime || createdAt,
    localOnly: true,
    mergeStatus: payload.mergeStatus || 'local',
    remoteBookId: payload.remoteBookId || null,
    mergedAt: payload.mergedAt || null,
    deletedAt: payload.deletedAt || null,
    ownerUserId: payload.ownerUserId == null ? null : String(payload.ownerUserId),
  }
}

export const normalizeLocalGroup = (payload: Partial<LocalBookGroup>): LocalBookGroup => {
  const createdAt = payload.createTime || nowIso()
  return {
    id: Number(payload.id || createLocalEntityId()),
    title: String(payload.title || '').trim() || '默认分组',
    sortNo: Number(payload.sortNo || 0),
    authorId: LOCAL_USER_ID,
    createTime: createdAt,
    updateTime: payload.updateTime || createdAt,
    localOnly: true,
    deletedAt: payload.deletedAt || null,
  }
}

export const normalizeLocalVolume = (payload: Omit<Partial<LocalVolume>, 'bookId'> & { bookId: string | number }): LocalVolume => {
  const createdAt = payload.createTime || nowIso()
  return {
    id: Number(payload.id || createLocalEntityId()),
    bookId: String(payload.bookId),
    title: String(payload.title || '').trim() || '第一卷',
    summary: payload.summary || '',
    sortNo: Number(payload.sortNo || 0),
    type: 'volume',
    planMeta: payload.planMeta ?? null,
    createTime: createdAt,
    updateTime: payload.updateTime || createdAt,
    deletedAt: payload.deletedAt || null,
  }
}

export const normalizeLocalChapter = (payload: Omit<Partial<LocalChapter>, 'bookId' | 'volumeId'> & { bookId: string | number; volumeId: string | number }): LocalChapter => {
  const createdAt = payload.createTime || nowIso()
  return {
    id: Number(payload.id || createLocalEntityId()),
    bookId: String(payload.bookId),
    volumeId: String(payload.volumeId),
    title: String(payload.title || '').trim() || '第1章',
    summary: payload.summary || '',
    wordCount: Number(payload.wordCount || 0),
    textWordCount: payload.textWordCount ?? (Number(payload.wordCount || 0) === 0 ? 0 : null),
    sortNo: Number(payload.sortNo || 0),
    status: Number(payload.status || 0),
    isPaid: Number(payload.isPaid || 0),
    type: 'chapter',
    planMeta: payload.planMeta ?? null,
    workflowStatus: payload.workflowStatus || null,
    createTime: createdAt,
    updateTime: payload.updateTime || createdAt,
    deletedAt: payload.deletedAt || null,
  }
}

export const sortBySortNo = <T extends { sortNo?: number; createTime?: string; id?: number }>(list: T[]) =>
  [...list].sort((a, b) => Number(a.sortNo || 0) - Number(b.sortNo || 0) || String(a.createTime || '').localeCompare(String(b.createTime || '')) || Number(a.id || 0) - Number(b.id || 0))

export const buildLocalTree = (volumes: LocalVolume[], chapters: LocalChapter[]): LocalLibraryVolume[] => {
  const activeVolumes = sortBySortNo(volumes.filter(volume => !volume.deletedAt))
  const activeChapters = sortBySortNo(chapters.filter(chapter => !chapter.deletedAt))
  return activeVolumes.map(volume => ({
    ...volume,
    open: true,
    children: activeChapters.filter(chapter => String(chapter.volumeId) === String(volume.id)),
  }))
}

export const calcLocalBookStats = (chapters: LocalChapter[]) => ({
  textWordCount: chapters.filter(chapter => !chapter.deletedAt).reduce<number | null>((sum, chapter) => {
    const count = chapter.textWordCount ?? (chapter.wordCount === 0 ? 0 : null)
    return sum === null || count === null ? null : sum + count
  }, 0),
  wordCount: chapters.filter(chapter => !chapter.deletedAt).reduce((sum, chapter) => sum + Number(chapter.wordCount || 0), 0),
  chapterCount: chapters.filter(chapter => !chapter.deletedAt).length,
})

const countTextWords = (value: string) => countWords(value)

/**
 * 一本书各章的本地草稿字数。
 *
 * 这是本地模式的最热路径：每次落盘都会重算书籍统计，而它以前是「按章串行地
 * 把整章正文读出来再数一遍」——N 章就是 N 次 SQL 往返 + N 份全文反序列化，
 * 打字时每 160ms 跑一轮，卡顿肉眼可见。chapter_contents 已有 wordCount 列，
 * 一条 SQL 就能取全，不必碰 payload。
 */
export const loadLocalDraftWordCounts = async (bookId: number | string) => {
  const map = new Map<number, TextCounts>()
  try {
    const rows = await getWritingStorage().listChapterWordCounts(LOCAL_USER_ID, bookId)
    rows.forEach(row => map.set(Number(row.chapterId), { wordCount: Number(row.wordCount || 0), textWordCount: row.textWordCount ?? null }))
  } catch (error) {
    console.warn('批量读取本地草稿字数失败', error)
  }
  return map
}

/**
 * 有本地草稿就以草稿为准（包括 0——用户可能真把这一章删空了）；
 * 没有草稿才回落到章节元数据。
 * 早先这里写的是 `get(id) || chapter.wordCount`，那个 `||` 会把"草稿真的是空的"
 * 也当成"没查到"，是在遮 wordCount 列未回填的洞；列回填之后不需要它了。
 */
export const resolveLocalChapterWords = (
  chapter: LocalChapter,
  draftWords: Map<number, TextCounts>
) => {
  const id = Number(chapter.id)
  return draftWords.has(id) ? draftWords.get(id)!.wordCount : Number(chapter.wordCount || 0)
}

export const resolveLocalChapterTextWords = (chapter: LocalChapter, draftWords: Map<number, TextCounts>) =>
  draftWords.has(Number(chapter.id)) ? draftWords.get(Number(chapter.id))!.textWordCount : chapter.textWordCount ?? (chapter.wordCount === 0 ? 0 : null)

export const calcLocalBookStatsWithDrafts = async (
  bookId: number | string,
  chapters: LocalChapter[],
  draftWords?: Map<number, TextCounts>
) => {
  const activeChapters = chapters.filter(chapter => !chapter.deletedAt)
  // 本地正文草稿才是实际内容源，章节元数据可能因异步保存中断而滞后。
  const words = draftWords ?? (await loadLocalDraftWordCounts(bookId))
  const wordCount = activeChapters.reduce(
    (sum, chapter) => sum + resolveLocalChapterWords(chapter, words),
    0
  )
  const textWordCount = activeChapters.reduce<number | null>((sum, chapter) => {
    const count = resolveLocalChapterTextWords(chapter, words)
    return sum === null || count === null ? null : sum + count
  }, 0)
  return {
    wordCount,
    textWordCount,
    chapterCount: activeChapters.length,
  }
}

const txtVolumePattern = /^第([零一二三四五六七八九十百千万两\d]+)卷([\s:：、.-]*)(.*)$/
const txtChapterPattern = /^第([零一二三四五六七八九十百千万两\d]+)[章节回]([\s:：、.-]*)(.*)$/

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** 卷/章序号转数字（一百零五 → 105）；解析不了返回 null */
const parseTxtHeadingNo = (raw: string): number | null => {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let section = 0
  let current = 0
  for (const ch of text) {
    if (ch in CN_DIGIT) {
      current = CN_DIGIT[ch]
    } else if (ch in CN_UNIT) {
      section += (current || 1) * CN_UNIT[ch]
      current = 0
    } else if (ch === '万') {
      total += (section + current || 1) * 10000
      section = 0
      current = 0
    } else {
      return null
    }
  }
  return total + section + current
}

/**
 * 标题候选行排雷：正文里恰好以"第N章"开头的叙述句不能拿来切章。
 * 三条线：带句号叹号问号的是句子；序号后没分隔符还带逗号的是叙述
 * （"第三章正文在此，讲了……"）；序号不往前走的是回指（第五章正文里提"第三章"）。
 * 序号解析不了时放行，维持宁可多切的旧行为。
 */
const acceptTxtHeading = (match: RegExpMatchArray, lastNo: number): { pass: boolean; no: number | null } => {
  const [, noText, separator, rest] = match
  if (/[。！？!?…]/.test(rest)) return { pass: false, no: null }
  if (!separator && /[，,、；;：:]/.test(rest)) return { pass: false, no: null }
  const no = parseTxtHeadingNo(noText)
  if (no != null && lastNo > 0 && no <= lastNo) return { pass: false, no }
  return { pass: true, no }
}

/** 优先按 BOM 解码；无 BOM 时先验证 UTF-8，再兼容 GBK/GB18030 中文文本。 */
const readLocalTxtContent = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let encoding: string | null = null
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'

  let text: string
  try {
    if (encoding) {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        text = new TextDecoder('gb18030', { fatal: true }).decode(bytes)
      }
    }
  } catch {
    throw new Error('无法正确读取 TXT 编码，请将原文件另存为 UTF-8 后重新导入')
  }
  // 拒绝带空字符的内容，避免未标记编码的 UTF-16 或二进制文件被当作正文保存。
  if (text.includes('\0')) {
    throw new Error('文件包含非文本字符，请将原文件另存为 UTF-8 格式的 TXT 后重新导入')
  }
  return text
}

export const parseLocalTxtBook = async (file: File): Promise<LocalParsedBook> => {
  const text = await readLocalTxtContent(file)
  const filenameTitle = file.name.replace(/\.[^.]+$/, '').trim() || '导入作品'
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const volumes: LocalParsedBook['volumes'] = []
  let currentVolume = { title: '第一卷', chapters: [] as LocalParsedBook['volumes'][number]['chapters'] }
  let currentChapter: LocalParsedBook['volumes'][number]['chapters'][number] | null = null

  const pushVolume = () => {
    if (currentVolume.chapters.length) volumes.push(currentVolume)
  }
  const pushChapterText = (line: string) => {
    if (!currentChapter) {
      currentChapter = { title: '第1章', textContent: '' }
      currentVolume.chapters.push(currentChapter)
    }
    currentChapter.textContent += `${line}\n`
  }

  let lastVolumeNo = 0
  let lastChapterNo = 0
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const volumeMatch = line.match(txtVolumePattern)
    if (volumeMatch && line.length <= 40) {
      const verdict = acceptTxtHeading(volumeMatch, lastVolumeNo)
      if (verdict.pass) {
        pushVolume()
        currentVolume = { title: line, chapters: [] }
        currentChapter = null
        if (verdict.no != null) lastVolumeNo = verdict.no
        // 分卷计数的书每卷章号从头数；连续计数的书章号只增不减，清零无影响
        lastChapterNo = 0
        continue
      }
    }
    const chapterMatch = line.match(txtChapterPattern)
    if (chapterMatch && line.length <= 60) {
      const verdict = acceptTxtHeading(chapterMatch, lastChapterNo)
      if (verdict.pass) {
        currentChapter = { title: line, textContent: '' }
        currentVolume.chapters.push(currentChapter)
        if (verdict.no != null) lastChapterNo = verdict.no
        continue
      }
    }
    pushChapterText(rawLine)
  }
  pushVolume()

  if (!volumes.length) {
    volumes.push({
      title: '第一卷',
      chapters: [{ title: '第1章', textContent: text }],
    })
  }

  return {
    title: filenameTitle,
    intro: '',
    volumes: volumes.map(volume => ({
      ...volume,
      chapters: volume.chapters.map(chapter => ({
        ...chapter,
        textContent: chapter.textContent.trim(),
      })),
    })),
  }
}

export const createLocalImportPreview = (filename: string, payload: LocalParsedBook): LocalImportPreview => {
  const chapters = payload.volumes.flatMap(volume => volume.chapters)
  return {
    filename,
    title: payload.title,
    intro: payload.intro || '',
    volumeCount: payload.volumes.length,
    chapterCount: chapters.length,
    chaptersPreview: chapters.slice(0, 12).map(chapter => ({
      title: chapter.title,
      wordCount: countTextWords(chapter.textContent),
    })),
    warnings: chapters.length ? [] : ['未识别到章节，导入时会自动创建第1章'],
    payload,
  }
}

export const buildLocalTxtExport = async (payload: LocalExportPayload) => {
  const lines: string[] = [
    `书名：${payload.book.title}`,
    payload.book.intro ? `简介：${payload.book.intro}` : '',
    '',
  ]
  for (const volume of sortBySortNo(payload.volumes)) {
    lines.push(volume.title, '')
    const chapters = sortBySortNo(payload.chapters.filter(chapter => String(chapter.volumeId) === String(volume.id)))
    for (const chapter of chapters) {
      lines.push(chapter.title, '', chapter.textContent || '', '')
    }
  }
  return lines.join('\n')
}

export const buildLocalExportPayload = async (book: LocalBook, volumes: LocalVolume[], chapters: LocalChapter[]): Promise<LocalExportPayload> => {
  const storage = getWritingStorage()
  const exportChapters = await Promise.all(chapters.filter(chapter => !chapter.deletedAt).map(async chapter => {
    const draft = await storage.getChapterByIdentity(LOCAL_USER_ID, book.id, chapter.id)
    return {
      ...chapter,
      textContent: draft?.textContent || '',
      contentJson: draft?.contentJson,
    }
  }))
  return {
    version: 1,
    exportedAt: nowIso(),
    book,
    volumes: volumes.filter(volume => !volume.deletedAt),
    chapters: exportChapters,
  }
}
