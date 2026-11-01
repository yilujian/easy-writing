import { readLocalTxtContent } from '@/storage/text-file'

/**
 * 把一本书的文件读成纯文本：TXT 原样，Markdown 去掉标记，Word（docx）和 EPUB 本机解包取正文。
 * 后面的分章、查重、入库都只认纯文本，所以几种格式在这一层就汇合了，不依赖服务端。
 */
export const DOCUMENT_EXTENSIONS = ['txt', 'md', 'markdown', 'docx', 'epub'] as const
export const DOCUMENT_ACCEPT = '.txt,.md,.markdown,.docx,.epub'
export const DOCUMENT_LABEL = 'TXT、Markdown、Word（docx）或 EPUB'
export const documentExtension = (name: string) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase()
export const isSupportedDocument = (name: string) =>
  (DOCUMENT_EXTENSIONS as readonly string[]).includes(documentExtension(name))

// ---- 最小的 zip 读取：docx 和 epub 都是 zip 包，只需要按名字取文件（存储或 deflate 两种压缩）。
const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
export interface ZipArchive {
  names: string[]
  read: (name: string) => Promise<Uint8Array>
  text: (name: string) => Promise<string>
}
export async function openZip(buffer: ArrayBuffer): Promise<ZipArchive> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const total = view.getUint16(eocd + 10, true)
  const offset = view.getUint32(eocd + 16, true)
  if (total === 0xffff || offset === 0xffffffff) throw new Error('文件使用了 zip64，暂不支持')
  const entries = new Map<string, { method: number; size: number; start: number }>()
  const decoder = new TextDecoder('utf-8')
  let cursor = offset
  for (let n = 0; n < total; n++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== SIG_CENTRAL) throw new Error('zip 目录损坏')
    const method = view.getUint16(cursor + 10, true)
    const size = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const local = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (local + 30 > bytes.length || view.getUint32(local, true) !== SIG_LOCAL) throw new Error('zip 条目损坏')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    entries.set(name, { method, size, start })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  const read = async (name: string) => {
    const entry = entries.get(name)
    if (!entry) throw new Error(`压缩包里没有 ${name}`)
    const slice = bytes.subarray(entry.start, entry.start + entry.size)
    if (entry.method === 0) return slice
    if (entry.method !== 8) throw new Error('压缩方式不支持')
    // 不经 Blob 和 Response：直接喂给解压流再逐块收回，浏览器和测试环境都走得通
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice)
        controller.close()
      }
    })
    const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
  return { names: [...entries.keys()], read, text: async name => decoder.decode(await read(name)) }
}

// ---- 文本整理
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: '　', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' }
export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
/** HTML 转文字：块级标签换行，其余标签去掉，实体还原。Worker 里没有 DOM，用正则就够了。 */
export function htmlToText(html: string) {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
  return tidy(
    decodeEntities(
      body
        .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        // 块级标签：结束处换行，开始处不加，段落之间就是单个换行，和 TXT 小说一样
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|dd|dt|pre|figure|figcaption|table)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
  )
}
/** Word 正文：每个 w:p 是一段，段内的 w:t 拼起来；w:br 换行，w:tab 当空格。 */
export function docxToText(xml: string) {
  const paragraphs: string[] = []
  const pattern = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const inner = match[1] || ''
    const text = inner
      .replace(/<w:tab\s*\/>/g, ' ')
      .replace(/<w:(?:br|cr)\s*\/>/g, '\n')
      .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, '$1\u0000')
      .split('\u0000')
      .map(part => part.replace(/<[^>]+>/g, ''))
      .join('')
    paragraphs.push(decodeEntities(text))
  }
  return tidy(paragraphs.join('\n'))
}
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? ''
const resolvePath = (base: string, href: string) => {
  const parts = (base ? base.split('/') : []).concat(decodeURIComponent(href.split('#')[0]).split('/'))
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}
/** EPUB：container.xml 找到 opf，按 spine 顺序把每个 xhtml 读成文字拼起来。 */
export async function epubToText(zip: ZipArchive) {
  const container = await zip.text('META-INF/container.xml')
  const opfPath = container.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1]
  if (!opfPath) throw new Error('EPUB 缺少目录文件')
  const opf = await zip.text(opfPath)
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const manifest = new Map<string, { href: string; type: string }>()
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) manifest.set(attr(tag, 'id'), { href: attr(tag, 'href'), type: attr(tag, 'media-type') })
  const spine = (opf.match(/<itemref\b[^>]*>/gi) || []).map(tag => attr(tag, 'idref')).filter(Boolean)
  const order = spine.length ? spine : [...manifest.keys()]
  const chunks: string[] = []
  for (const id of order) {
    const item = manifest.get(id)
    if (!item || !/html|xml/i.test(item.type)) continue
    const path = resolvePath(base, item.href)
    if (!zip.names.includes(path)) continue
    const text = htmlToText(await zip.text(path))
    if (text) chunks.push(text)
  }
  if (!chunks.length) throw new Error('EPUB 里没有读到正文')
  return chunks.join('\n\n')
}
/** Markdown：去掉标题井号、强调符号、链接和图片语法，剩下的就是正文。 */
export function markdownToText(markdown: string) {
  return tidy(
    markdown
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
      .replace(/`([^`\n]+)`/g, '$1')
  )
}
/** 按扩展名把文件读成纯文本；进度只在 TXT 读取时有细分，其余报开始和结束。 */
export async function readDocumentText(file: File, progress?: (done: number, total: number) => void) {
  const ext = documentExtension(file.name)
  if (ext === 'txt') return readLocalTxtContent(file, progress)
  if (ext === 'md' || ext === 'markdown') return markdownToText(await readLocalTxtContent(file, progress))
  if (ext === 'docx' || ext === 'epub') {
    progress?.(0, 1)
    const zip = await openZip(await file.arrayBuffer())
    const text = ext === 'docx' ? docxToText(await zip.text('word/document.xml')) : await epubToText(zip)
    progress?.(1, 1)
    return text
  }
  throw new Error(`暂不支持这种文件，请选择 ${DOCUMENT_LABEL}`)
}
