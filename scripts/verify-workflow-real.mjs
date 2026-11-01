/** 工作流建书真机验证：隔离数据目录 + 真实模型。只读本机模型配置，密钥留在中继进程里，不进测试数据库。 */
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const origin = option('--origin') || 'http://localhost:4414'
const source = option('--models-db'), output = option('--output'), limit = Number(option('--max-requests'))
if (!source || !output || !Number.isInteger(limit) || limit < 1) throw Error('必须明确 --models-db、--output、--max-requests；仅在得到真实请求授权后运行')
const out = resolve(output); mkdirSync(out, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(resolve(source), { readOnly: true })
const setting = key => { const r = db.prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?").get(JSON.stringify(key)); return r ? JSON.parse(r.value) : null }
const config = JSON.parse(setting('ew-local-ai-models'))
const selected = option('--model') || config.preferences?.workflow_book
const model = config.models.find(m => String(m.id) === String(selected)); db.close()
if (!model || model.status !== 1 || model.scene !== 'text') throw Error('工作流模型未配置或不可用')
let count = 0, phase = '', child, deny = null
const requests = []
const ledger = () => writeFileSync(resolve(out, 'request-ledger.json'), JSON.stringify({ model: model.modelCode, limit, count, requests }, null, 2), { mode: 0o600 })
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.end(); return }
  let record
  try {
    if (req.url === '/settings') { res.end(JSON.stringify({ modelCode: model.modelCode, provider: model.provider, maxContext: model.maxContext, maxOutputTokens: model.maxOutputTokens, thinking: model.thinking })); return }
    if (req.url === '/status') {
      const last = requests.at(-1)
      res.end(JSON.stringify({ count, remaining: limit - count, last: last ? { number: last.number, scenario: last.scenario, scene: last.scene, head: String(last.lastUserMessage || '').slice(0, 6000), status: last.status } : null }))
      return
    }
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url === '/case') { phase = body.name; res.end('{}'); return }
    if (req.url === '/deny') { deny = { delayMs: Number(body.delayMs || 0) }; res.end('{}'); return }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    if (deny) {
      await new Promise(r => setTimeout(r, deny.delayMs))
      res.writeHead(402); res.end(JSON.stringify({ error: { message: '隔离验证：模拟供应商拒绝请求' } })); return
    }
    if (count >= limit) { res.writeHead(402); res.end(JSON.stringify({ error: { message: '隔离验证请求预算已用完' } })); return }
    const user = (body.messages || []).filter(m => m.role === 'user').at(-1)?.content
    record = { number: ++count, scenario: phase, scene: (body.messages || [])[0]?.content?.slice(0, 60), startedAt: Date.now(), messageRoles: (body.messages || []).map(m => m.role), lastUserMessage: user, systemMessage: (body.messages || []).find(m => m.role === 'system')?.content }
    requests.push(record); ledger()
    const abort = new AbortController(); res.once('close', () => abort.abort())
    const upstream = await fetch(model.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + model.apiKey }, body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(420000)]) })
    record.status = upstream.status; ledger()
    if (!upstream.ok) { res.writeHead(upstream.status); res.end(JSON.stringify({ error: { message: '隔离验证模型请求失败，HTTP ' + upstream.status } })); return }
    res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || (body.stream ? 'text/event-stream' : 'application/json') })
    for await (const chunk of upstream.body) { appendFileSync(resolve(out, 'response-' + record.number + '.sse'), chunk, { mode: 0o600 }); res.write(chunk) }
    res.end(); record.finishedAt = Date.now(); ledger()
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(); if (record) record.error = error.name; ledger() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r)); const relay = 'http://127.0.0.1:' + server.address().port
const configFile = resolve(out, 'tauri-real.json')
const reuse = option('--identifier')
if (reuse && !/^com\.yichuang\.writing\.workflow-validation\.[a-f0-9]{32}$/.test(reuse)) throw Error('只允许接续工作流验证专用的隔离数据')
writeFileSync(configFile, JSON.stringify({ productName: '工作流真实模型隔离验证', identifier: reuse || ('com.yichuang.writing.workflow-validation.' + randomUUID().replaceAll('-', '')), build: { beforeDevCommand: '', devUrl: origin + '/tests/workflow-real.html?' + new URLSearchParams({ output: out, relay }) } }))
const fd = openSync(resolve(out, 'native.log'), 'w', 0o600)
try {
  child = spawn('pnpm', ['tauri', 'dev', '--config', configFile, '--no-watch', '--features', 'local-tests'], { cwd: process.cwd(), stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, EW_PI_VALIDATION_UNTHROTTLED: '1' } })
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('隔离验收超时')), 2400000); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('桌面验收进程退出 ' + code)) }); child.once('error', reject) })
  const result = JSON.parse(readFileSync(resolve(out, 'real-results.json'), 'utf8'))
  console.log(JSON.stringify({ output: out, model: model.modelCode, requests: count, passed: result.passed, cases: result.results?.map(r => ({ name: r.name, passed: r.passed, error: r.error, note: r.note })) }, null, 2))
} finally {
  // 应用本体由 cargo 另起进程组，杀掉 pnpm 那一组不够；按父子关系把整棵树清掉，否则残留实例会和下一次验证抢同一个隔离数据库。
  const descendants = root => { try { const rows = execSync('ps -axo pid=,ppid=').toString().trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)); const out = []; const walk = pid => { for (const [id, parent] of rows) if (parent === pid) { out.push(id); walk(id) } }; walk(root); return out } catch { return [] } }
  if (child) { const tree = descendants(child.pid); try { process.kill(-child.pid, 'SIGTERM') } catch { /* 可能已退出 */ } for (const pid of tree) { try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ } } await new Promise(r => setTimeout(r, 1500)); for (const pid of tree) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } } }
  closeSync(fd); server.closeAllConnections(); server.close(); ledger()
}
