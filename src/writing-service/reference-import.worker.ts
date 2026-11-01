import { readDocumentText } from './document-text'
import { decideTextUse, parseReferenceBook, textFingerprint } from './reference-book'
import type { BookCatalog, ParsedReferenceBook, ReferenceChapter } from './reference-book'

let sequence = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const command = <T>(action: string, args: object): Promise<T> =>
  new Promise((resolve, reject) => {
    const request = ++sequence
    pending.set(request, { resolve: value => resolve(value as T), reject })
    postMessage({ kind: 'command', request, action, args })
  })
const progress = (stage: string, done = 0, total = 0) => postMessage({ kind: 'progress', stage, done, total })

async function readExisting(projectId: string) {
  let text = '',
    title = '',
    version = ''
  for (let offset = 0, total = 1; offset < total;) {
    const batch = await command<{
      title: string
      total: number
      version: string
      chapters: ReferenceChapter[]
    }>('reference_export', { projectId, offset })
    if (version && version !== batch.version) throw new Error('参考书已改变，请重试')
    version = batch.version
    title = batch.title
    text += batch.chapters.map(c => `${c.title}\n${c.text}\n`).join('\n')
    offset += batch.chapters.length
    total = batch.total
    progress('核对旧书', offset, total)
    if (!batch.chapters.length && offset < total) throw new Error('章节读取不完整')
  }
  return { text, title, version }
}
const chapterHash = (chapters: ReferenceChapter[]) =>
  textFingerprint(chapters.map(c => `${c.title}${c.text}`.replace(/\s/g, '')).join(''))
/** 文件指纹只看文本和非默认的分章方式，与拆书工作台一致；是否保留超长章不影响"同一本书"的判断。 */
const fingerprintPrefix = (options?: import('./reference-book').ReferenceParseOptions) =>
  options?.headingStyle && options.headingStyle !== 'auto'
    ? JSON.stringify({ headingStyle: options.headingStyle }) + '\n'
    : ''
/** 上传后立刻给作者看的目录：只有章名和字数，不带正文。 */
const catalogOf = (book: ParsedReferenceBook, intent: 'breakdown' | null): BookCatalog => ({
  title: book.title,
  chapterCount: book.chapters.length,
  chars: book.totalChars,
  warnings: book.warnings,
  book: decideTextUse(book, intent) === 'reference',
  chapters: book.chapters.map((c, i) => ({ no: i + 1, title: c.title, chars: c.chars }))
})

async function run(
  file: File | undefined,
  intent: 'breakdown' | null,
  projectId?: string,
  parseOptions?: import('./reference-book').ReferenceParseOptions,
  captureSource = false,
  preview = false,
  verifyCandidates = true
) {
  let text = ''
  let filename = file?.name || ''
  let expectedVersion = ''
  if (projectId) {
    const old = await readExisting(projectId)
    expectedVersion = old.version
    filename = old.title + '.txt'
    text = old.text
  } else if (file) {
    text = await readDocumentText(file, (done, total) => progress('读取文本', done, total))
  }
  if (!text.trim()) throw new Error('文件是空的')
  if (preview) {
    progress('识别章节')
    postMessage({ kind: 'done', preview: true, result: catalogOf(parseReferenceBook(text, filename, parseOptions), intent) })
    return
  }
  if (captureSource) {
    for (let offset = 0, index = 0; offset < text.length; index++) {
      let end = Math.min(offset + 131072, text.length)
      const tail = text.charCodeAt(end - 1)
      if (end < text.length && tail >= 0xd800 && tail <= 0xdbff) end--
      progress('保存附件原文', offset, text.length)
      await command('capture_source_chunk', { index, text: text.slice(offset, end) })
      offset = end
    }
  }
  progress('检查重复文件')
  const sourceHash = projectId ? '' : await textFingerprint(fingerprintPrefix(parseOptions) + text)
  if (!projectId) {
    const existing = await command<unknown>('reference_find', { sourceHash })
    if (existing) {
      postMessage({ kind: 'done', result: existing })
      return
    }
  }
  progress('识别章节')
  const book = parseReferenceBook(text, filename, parseOptions)
  if (!projectId && decideTextUse(book, intent) === 'material') {
    const result = await command('material_put', { title: filename, content: text })
    postMessage({ kind: 'done', material: true, result })
    return
  }
  text = ''
  progress('检查已有书籍')
  // 章名与正文顺序相同即同一本书，兼容旧分章把带标点章名并入正文的记录。
  const contentHash = await chapterHash(book.chapters)
  if (!projectId) {
    const existing = await command<unknown>('reference_find', { contentHash })
    if (existing) {
      postMessage({ kind: 'done', result: existing })
      return
    }
  }
  // 同名旧书逐章重读算指纹只服务没有新版指纹的老记录；聊天附件不为此等待。
  if (!projectId && verifyCandidates) {
    const candidates = await command<Array<{ projectId: string }>>('reference_candidates', {
      title: book.title
    })
    for (const candidate of candidates) {
      const old = await readExisting(candidate.projectId)
      const hash = await chapterHash(parseReferenceBook(old.text, old.title + '.txt').chapters)
      await command('reference_remember', {
        projectId: candidate.projectId,
        expectedVersion: old.version,
        contentHash: hash
      })
    }
    if (candidates.length) {
      const existing = await command<unknown>('reference_find', { contentHash })
      if (existing) {
        postMessage({ kind: 'done', result: existing })
        return
      }
    }
  }
  const { token } = await command<{ token: string }>('reference_begin', {
    title: book.title,
    preserveLongChapters: parseOptions?.preserveLongChapters === true,
    total: book.chapters.length,
    sourceHash,
    contentHash,
    notes: book.warnings,
    replaceProjectId: projectId,
    expectedVersion
  })
  const total = book.chapters.length
  for (let offset = 0; offset < total; offset += 8) {
    progress('保存章节', offset, total)
    await command('reference_append', {
      token,
      offset,
      chapters: book.chapters.slice(offset, offset + 8).map(c => ({ title: c.title, text: c.text }))
    })
    // 已保存的正文及时释放，后续批次不再携带整本小说。
    for (let i = offset; i < Math.min(offset + 8, total); i++) book.chapters[i].text = ''
  }
  progress('完成导入', total, total)
  const result = await command('reference_commit', { token })
  postMessage({ kind: 'done', result })
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data
  if (data.kind === 'reply') {
    const request = pending.get(data.request)
    pending.delete(data.request)
    if (data.error) request?.reject(new Error(data.error))
    else request?.resolve(data.value)
  } else if (data.kind === 'start') {
    void run(
      data.file,
      data.intent,
      data.projectId,
      data.parseOptions,
      data.captureSource,
      data.preview === true,
      data.verifyCandidates !== false
    ).catch(error =>
      postMessage({ kind: 'error', error: String(error instanceof Error ? error.message : error) })
    )
  }
}
