import test from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalServer } from './server.mjs'

const fixture = () => ({ format: 'easy-writing-local-books', version: 1, createdAt: new Date().toISOString(), books: [{ version: 1, exportedAt: new Date().toISOString(), book: { title: '测试作品', id: 1 }, volumes: [{ id: 2 }], chapters: [{ id: 3, volumeId: '2', textContent: '风吹过原野。' }], reference: { roles: ['林远'] } }] })
async function setup(t, fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), 'ew-local-'))
  await mkdir(join(dir, 'dist')); await writeFile(join(dir, 'dist/index.html'), '<h1>writing</h1>')
  const server = createLocalServer({ dataDir: join(dir, 'data'), assetDir: join(dir, 'dist'), fetchImpl })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const status = await (await fetch(`${base}/api/local/status`)).json()
  const headers = { 'Content-Type': 'application/json', 'X-EW-Local-Token': status.token }
  return { base, headers }
}
test('backup round-trip preserves chapters/reference; unchanged data deduplicates; invalid data is rejected', async t => {
  const { base, headers } = await setup(t)
  const value = fixture()
  const save = () => fetch(`${base}/api/local/backups`, { method: 'POST', headers, body: JSON.stringify(value) })
  const first = await (await save()).json(); assert.match(first.id, /^backup-/)
  value.exportedAt = new Date().toISOString()
  const second = await (await save()).json(); assert.equal(second.id, first.id); assert.equal(second.unchanged, true)
  const loaded = await (await fetch(`${base}/api/local/backups/${first.id}`, { headers })).json()
  assert.deepEqual(loaded.books, value.books)
  value.books[0].chapters[0].textContent = 33
  assert.equal((await save()).status, 400)
})
test('rejects untrusted origin, host and missing token; traversal cannot read arbitrary files; SPA fallback works', async t => {
  const { base, headers } = await setup(t)
  assert.equal((await fetch(`${base}/api/local/status`, { headers: { Origin: 'https://example.com' } })).status, 403)
  const badHostStatus = await new Promise(resolve => { const request = http.get(`${base}/api/local/status`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }); request.on('error', error => { throw error }) })
  assert.equal(badHostStatus, 403)
  assert.equal((await fetch(`${base}/api/local/backups`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(`${base}/api/local/backups/..%2Fsecret`, { headers })).status, 400)
  assert.equal((await fetch(`${base}/api/local/ai`, { method: 'POST', headers, body: JSON.stringify({ url: 'file:///etc/passwd', method: 'GET' }) })).status, 400)
  assert.match(await (await fetch(`${base}/writing/123`)).text(), /writing/)
  assert.equal((await fetch(`${base}/missing.js`)).status, 404)
})
test('AI proxy forwards stream/authentication and preserves provider error status', async t => {
  const { base, headers } = await setup(t, async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test-only')
    assert.equal(options.headers.origin, undefined)
    assert.equal(options.redirect, 'error')
    if (url.includes('fail')) return new Response('{"error":{"message":"invalid key"}}', { status: 401 })
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"text":"你好"}\n\n')); c.enqueue(encoder.encode('data: [DONE]\n\n')); c.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const call = url => fetch(`${base}/api/local/ai`, { method: 'POST', headers, body: JSON.stringify({ url, method: 'POST', headers: { authorization: 'Bearer test-only', origin: 'bad' }, body: '{}' }) })
  const response = await call('http://127.0.0.1:11434/v1/chat/completions')
  assert.match(response.headers.get('content-type'), /event-stream/)
  assert.match(await response.text(), /你好.*\n\ndata: \[DONE\]/)
  assert.equal((await call('https://provider.example/fail')).status, 401)
})
test('snapshot retention keeps latest 30 complete files', async t => {
  const { base, headers } = await setup(t)
  for (let i = 0; i < 32; i++) {
    const value = fixture(); value.books[0].book.title = `作品${i}`
    assert.equal((await fetch(`${base}/api/local/backups`, { method: 'POST', headers, body: JSON.stringify(value) })).status, 200)
  }
  const status = await (await fetch(`${base}/api/local/status`)).json()
  assert.equal(status.backups.length, 30)
  for (const item of status.backups) assert.equal((await fetch(`${base}/api/local/backups/${item.id}`, { headers })).status, 200)
})
test('cancelling the browser stream aborts the upstream model request', async t => {
  let upstreamAborted
  const aborted = new Promise(resolve => { upstreamAborted = resolve })
  const { base, headers } = await setup(t, async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'))
      options.signal.addEventListener('abort', () => { upstreamAborted(true); controller.error(new Error('aborted')) }, { once: true })
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const controller = new AbortController()
  const response = await fetch(`${base}/api/local/ai`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ url: 'http://127.0.0.1:11434/v1/chat/completions', method: 'POST', headers: {}, body: '{}' }) })
  const reader = response.body.getReader(); await reader.read(); controller.abort()
  let timer
  try { assert.equal(await Promise.race([aborted, new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000) })]), true) } finally { clearTimeout(timer) }
})
