/** 本地假模型 + 真 Pi RPC/工具/会话。不会读取用户凭据或写入用户作品。 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const missingCandidate = process.argv.includes('--missing-candidate')
const home = await mkdtemp(resolve(tmpdir(), 'ew-pi-smoke-'))
await mkdir(resolve(home, 'sessions'))
await mkdir(resolve(home, 'workspace'))
let apiCalls = 0,
  saved = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  if (req.url === '/context') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({result:{runControl:{state:'active',pendingInput:null},activeBook:{id:'-1',title:'隔离测试书'},drafts:[],tasks:[],memories:[]}}))
    return
  }
  if (req.url === '/tool') {
    assert.equal(req.headers.authorization, 'Bearer smoke-token')
    const value =
      body.tool === 'list_chapters'
        ? [{ id: '-11', title: '第一章' }]
        : body.tool === 'read_chapter'
          ? { chapterId: '-11', title: '第一章', content: '林渡站在门外。', version: 0 }
          : body.tool === 'save_draft'
            ? (saved++, { draftId: 'test-draft', status: '待采用' })
            : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: value }))
    return
  }
  apiCalls++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const prompt = body.messages.filter(m => m.role === 'user').at(-1)?.content || ''
  if (String(prompt).includes('慢速')) {
    res.write(
      `data: ${JSON.stringify({ id: 's', choices: [{ index: 0, delta: { role: 'assistant', content: '半截回答' }, finish_reason: null }] })}\n\n`
    )
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 30000)
    req.on('close', () => clearTimeout(timer))
    return
  }
  const tools = body.messages.filter(m => m.role === 'tool')
  const sequence = [
    ['read_book', { view: 'chapters' }],
    ['read_chapter', { chapterId: '-11', purpose: 'revision' }],
    [
      'save_draft',
      { chapterId: '-11', baseVersion: 0, title: '第一章', content: '林渡站在门外，摸了摸袖里的钥匙。' }
    ]
  ]
  const repair = body.messages.some(m =>
    (typeof m.content === 'string' ? m.content : (m.content || []).map(x => x.text || '').join('')).includes('平台交付检查：')
  )
  const next = missingCandidate && tools.length === 2 && !repair ? undefined : sequence[tools.length]
  const delta = next
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-${tools.length}`,
            type: 'function',
            function: { name: next[0], arguments: JSON.stringify(next[1]) }
          }
        ]
      }
    : { role: 'assistant', content: missingCandidate && !repair ? '这是聊天里的草案，确认后我再提交。' : '草稿已生成，等待你采用。' }
  res.end(
    `data: ${JSON.stringify({ id: `r-${apiCalls}`, object: 'chat.completion.chunk', created: 1, model: 'qa', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
  )
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`
const records = []
const waiters = new Set()
let stderr = ''
const child = spawn(
  process.execPath,
  [
    resolve(base, 'upstream/packages/coding-agent/dist/cli.js'),
    '--mode',
    'rpc',
    '--provider',
    'yichuang',
    '--model',
    'qa',
    '--thinking',
    'off',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--extension',
    resolve(base, 'extensions/yichuang.ts'),
    '--system-prompt',
    resolve(base, 'prompts/system.md'),
    '--skill',
    resolve(base, 'skills/novel-writing/SKILL.md'),
    '--tools',
    'list_books,read_book,read_chapter,save_draft,ask_author,read',
    '--session-dir',
    resolve(home, 'sessions')
  ],
  {
    cwd: resolve(home, 'workspace'),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: resolve(home, 'config'),
      EW_PI_MODEL: JSON.stringify({
        modelCode: 'qa',
        name: '测试模型',
        baseUrl: endpoint + '/v1',
        apiKey: 'fake-only',
        maxContext: 32000,
        maxOutputTokens: 4096
      }),
      EW_PI_BOOK: JSON.stringify({ id: '-1', title: '隔离测试书' }),
      EW_PI_TOOL_URL: endpoint + '/tool',
      EW_PI_TOOL_TOKEN: 'smoke-token'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }
)
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', text => {
  buffer += text
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    try {
      const r = JSON.parse(line)
      records.push(r)
      for (const f of waiters) f(r)
    } catch {
      stderr += '\nNON_JSON:' + line
    }
  }
})
child.stderr.on('data', d => (stderr += d.toString()))
child.on('exit', code => {
  for (const f of waiters) f({ type: 'exit', code })
})
const send = (type, args = {}) => {
  const id = crypto.randomUUID()
  child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n')
  return id
}
const wait = (predicate, timeout = 20000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check)
      reject(new Error('Pi timeout\n' + stderr + '\n' + JSON.stringify(records.slice(-8))))
    }, timeout)
    const check = r => {
      if (predicate(r)) {
        clearTimeout(timer)
        waiters.delete(check)
        resolve(r)
      } else if (r.type === 'exit') {
        clearTimeout(timer)
        waiters.delete(check)
        reject(new Error('Pi exited ' + r.code + '\n' + stderr))
      }
    }
    waiters.add(check)
  })
try {
  let done = wait(r => r.type === 'response' && r.command === 'get_state')
  send('get_state')
  const state = await done
  assert.equal(state.success, true)
  done = wait(r => r.type === 'response' && r.command === 'get_commands')
  send('get_commands')
  assert.ok((await done).data.commands.some(command => command.name.includes('novel-writing')))
  done = wait(r => r.type === 'agent_settled')
  send('prompt', { message: '请读取第一章并生成一份草稿，完成后停止。' })
  await done
  assert.equal(saved, 1, JSON.stringify(records.slice(-10)))
  assert.equal(apiCalls, missingCandidate ? 5 : 4)
  assert.ok(records.some(r => r.type === 'tool_execution_end' && r.toolName === 'save_draft' && !r.isError))
  const files = await readdir(resolve(home, 'sessions'))
  assert.ok(files.some(f => f.endsWith('.jsonl')))
  const contents = await readFile(
    resolve(
      home,
      'sessions',
      files.find(f => f.endsWith('.jsonl'))
    ),
    'utf8'
  )
  assert.ok(contents.includes('yichuang-book'))
  assert.ok(!contents.includes('fake-only'))
  if (missingCandidate) assert.ok(contents.includes('yichuang-candidate-delivery'))
  done = wait(r => r.type === 'message_update')
  send('prompt', { message: '慢速测试' })
  await done
  const stopped = wait(r => r.type === 'agent_settled')
  const ack = wait(r => r.type === 'response' && r.command === 'abort')
  send('clear_queue')
  send('abort')
  await ack
  await stopped
  done = wait(r => r.type === 'response' && r.command === 'get_state')
  send('get_state')
  assert.equal((await done).data.isStreaming, false)
  console.log(
    JSON.stringify(
      {
        passed: true,
        pi: '1.3.0',
        realRuntime: true,
        apiCalls,
        saveDraftCalls: saved,
        stopped: true,
        persisted: true,
        candidateRepair: missingCandidate,
        home
      },
      null,
      2
    )
  )
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 2000).unref()
  server.closeAllConnections()
  server.close()
}
