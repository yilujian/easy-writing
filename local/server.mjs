/** Local companion. AGPL-3.0-only. No third-party runtime dependencies. */
import http from 'node:http'
import { readFile, writeFile, mkdir, readdir, stat, rename, unlink } from 'node:fs/promises'
import { resolve, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }
const validId = id => /^backup-\d{13}-[a-f0-9]{12}\.json$/.test(id)
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
async function body(req, limit = 100 * 1024 * 1024) {
  let size = 0; const chunks = []
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('内容超过大小限制'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
export function validateBackup(value) {
  if (!value || value.format !== 'easy-writing-local-books' || value.version !== 1 || !Array.isArray(value.books) || value.books.length > 10000) throw new Error('备份格式无效')
  for (const b of value.books) {
    if (b?.version !== 1 || typeof b.book?.title !== 'string' || !Array.isArray(b.volumes) || !Array.isArray(b.chapters)) throw new Error('作品数据无效')
    for (const c of b.chapters) if (typeof c.textContent !== 'string') throw new Error('章节正文无效')
  }
}
export function createLocalServer({ dataDir = resolve(root, 'local-data'), assetDir = resolve(root, 'dist'), fetchImpl = fetch } = {}) {
  const token = randomBytes(32).toString('hex')
  const backupDir = resolve(dataDir, 'backups')
  let writing = Promise.resolve()
  const list = async () => {
    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    const names = (await readdir(backupDir)).filter(validId).sort().reverse()
    return Promise.all(names.map(async id => ({ id, createdAt: new Date(Number(id.split('-')[1])).toISOString(), bytes: (await stat(resolve(backupDir, id))).size })))
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const origin = `http://127.0.0.1:${server.address().port}`
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '仅允许本地工作台访问' })
    let url
    try { url = new URL(req.url, origin) } catch { return json(res, 400, { error: '地址无效' }) }
    try {
      if (url.pathname === '/api/local/status' && req.method === 'GET') return json(res, 200, { app: 'easy-writing-local', version: 1, token, backupDir, backups: await list() })
      if (url.pathname.startsWith('/api/local/')) {
        if (req.headers['x-ew-local-token'] !== token) return json(res, 403, { error: '本地会话已失效，请刷新页面' })
        if (url.pathname === '/api/local/backups' && req.method === 'POST') {
          const payload = JSON.parse((await body(req)).toString('utf8'))
          validateBackup(payload)
          const data = JSON.stringify(payload)
          const digest = createHash('sha256').update(JSON.stringify(payload.books.map(({ exportedAt, ...book }) => book))).digest('hex').slice(0, 12)
          const save = async () => {
            const existing = await list()
            if (existing[0]?.id.endsWith(`-${digest}.json`)) return { id: existing[0].id, unchanged: true }
            const id = `backup-${Date.now()}-${digest}.json`
            const tmp = resolve(backupDir, `${id}.${randomBytes(4).toString('hex')}.tmp`)
            await writeFile(tmp, data, { flag: 'wx', mode: 0o600 })
            await rename(tmp, resolve(backupDir, id))
            // Retain the most recent 30 snapshots; a new snapshot is durable before pruning.
            for (const old of (await list()).slice(30)) await unlink(resolve(backupDir, old.id))
            return { id, unchanged: false }
          }
          const operation = writing.then(save); writing = operation.catch(() => {})
          return json(res, 200, await operation)
        }
        if (url.pathname.startsWith('/api/local/backups/') && req.method === 'GET') {
          const id = decodeURIComponent(url.pathname.slice('/api/local/backups/'.length))
          if (!validId(id)) return json(res, 400, { error: '备份名称无效' })
          return json(res, 200, JSON.parse(await readFile(resolve(backupDir, id), 'utf8')))
        }
        if (url.pathname === '/api/local/ai' && req.method === 'POST') {
          const payload = JSON.parse((await body(req, 25 * 1024 * 1024)).toString('utf8'))
          const target = new URL(payload.url)
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !['GET', 'POST'].includes(payload.method)) return json(res, 400, { error: '模型请求地址或方法无效' })
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
          res.on('close', () => controller.abort())
          try {
            const headers = {}
            for (const name of ['authorization', 'content-type', 'accept']) if (typeof payload.headers?.[name] === 'string') headers[name] = payload.headers[name]
            const upstream = await fetchImpl(target.href, { method: payload.method, headers, body: payload.method === 'GET' ? undefined : payload.body, signal: controller.signal, redirect: 'error' })
            res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
            if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res)
            else res.end()
          } finally { clearTimeout(timer) }
          return
        }
        return json(res, 404, { error: '接口不存在' })
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '请求方法不支持' })
      const pathname = decodeURIComponent(url.pathname)
      let file = resolve(assetDir, '.' + pathname)
      if (!file.startsWith(resolve(assetDir) + sep) && file !== resolve(assetDir)) return json(res, 403, { error: '路径无效' })
      try { if (!(await stat(file)).isFile()) file = resolve(assetDir, 'index.html') } catch { if (extname(pathname)) return json(res, 404, { error: '文件不存在' }); file = resolve(assetDir, 'index.html') }
      const bytes = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '文件不存在，请先构建项目' : error.message || '本地操作失败' })
    }
  })
  return server
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 22) { console.error('请安装 Node.js 22 或更高版本。'); process.exit(1) }
  try { await stat(resolve(root, 'dist/index.html')) } catch { console.error('缺少 dist 构建文件。请使用完整发行包，或执行 pnpm install 后 pnpm build。'); process.exit(1) }
  const port = Number(process.env.EW_PORT || 6789)
  const server = createLocalServer({ dataDir: process.env.EW_DATA_DIR ? resolve(process.env.EW_DATA_DIR) : undefined })
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口 6789 已被占用。请关闭旧实例；保持固定地址可继续使用原浏览器数据。' : error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`
    console.info(`易创 · 本地增强版\n打开 ${url}\n保持此窗口运行。按 Ctrl+C 停止。\n作品自动保存在浏览器，硬盘快照在 local-data/backups；退出前可在「本地中心」立即备份。`)
    if (!process.argv.includes('--no-open')) {
      const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
      const child = spawn(command[0], command[1], { stdio: 'ignore' }); child.on('error', () => console.info(`请手动打开 ${url}`)); child.unref()
    }
  })
}
