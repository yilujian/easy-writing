/** 沿用平台已有模型，在独立桌面配置里做自然语言验收；不连接微信。 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, existsSync, openSync, closeSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  args = process.argv.slice(2)
const option = (n, fallback = '') => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : fallback
}
const source = option('--models-db'),
  selected = option('--models', 'flash,pro').split(','),
  cases = option('--cases')
if (!source || selected.some(x => !['flash', 'pro'].includes(x)))
  throw new Error('需指定 --models-db；--models 支持 flash,pro')
for (const file of ['tests/pi-memory-real.html', 'tests/pi-memory-real.ts']) {
  if (!existsSync(join(root, file))) throw new Error('本地验收文件缺失：' + file)
}
const out = mkdtempSync(join(tmpdir(), 'ew-pi-memory-real-')),
  profile = 'com.yichuang.writing.pi-memory-weixin-validation'
const base =
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const qaPath = join(base, profile, 'ew-writing.db'),
  key = JSON.stringify('ew-local-ai-models'),
  nonceKey = JSON.stringify('ew-pi-real-memory-run'),
  nonce = randomUUID()
if (resolve(source) === qaPath) throw new Error('模型来源不能是隔离库')
if (!existsSync(qaPath)) throw new Error('请先运行 verify-memory-weixin.mjs 初始化隔离配置')
const db = new DatabaseSync(resolve(source), { readOnly: true })
const row = db.prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?").get(key)
db.close()
if (!row) throw new Error('来源库没有模型配置')
const configured = JSON.parse(JSON.parse(row.value)).models
const models = selected.map(name => {
  const m = configured.find(
    x => x.status === 1 && x.scene === 'text' && x.modelCode === 'deepseek-v4-' + name
  )
  if (!m) throw new Error('没有启用的 ' + name)
  return { name, model: m }
})
const qa = new DatabaseSync(qaPath)
qa.exec('PRAGMA busy_timeout=10000')
const get = k =>
  qa.prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?").get(k)
const prior = get(key),
  priorNonce = get(nonceKey)
let active,
  stopped = false
const kill = () => {
  if (active)
    try {
      process.platform === 'win32' ? active.kill() : process.kill(-active.pid, 'SIGTERM')
    } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopped = true
  kill()
})
const run = (argv, log) =>
  new Promise((resolvePromise, reject) => {
    const fd = openSync(join(out, log), 'w', 0o600),
      child = spawn('pnpm', argv, {
        cwd: root,
        stdio: ['ignore', fd, fd],
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        env: { ...process.env, EW_PI_VALIDATION_UNTHROTTLED: '1' }
      })
    active = child
    const timer = setTimeout(() => {
      kill()
      reject(new Error('真实模型验收超时'))
    }, 45 * 60_000)
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(timer)
      closeSync(fd)
      active = null
      code === 0 ? resolvePromise() : reject(new Error('验收进程退出 ' + code))
    })
  })
console.log('真实模型验收输出：' + out)
try {
  if (!(await fetch('http://localhost:4414')).ok) throw new Error('请先启动前端开发服务')
  qa.exec('BEGIN IMMEDIATE')
  const put = qa.prepare(
    "INSERT OR REPLACE INTO desktop_records(namespace,key,value) VALUES('app-settings',?,?)"
  )
  put.run(
    key,
    JSON.stringify(JSON.stringify({ version: 1, models: models.map(x => x.model), preferences: {} }))
  )
  put.run(nonceKey, JSON.stringify(nonce))
  qa.exec('COMMIT')
  chmodSync(qaPath, 0o600)
  const failures = []
  for (const { name, model } of models) {
    if (stopped) break
    const config = join(out, 'tauri-' + name + '.json')
    writeFileSync(
      config,
      JSON.stringify({
        productName: 'Pi 真实模型隔离验收',
        identifier: profile,
        build: {
          beforeDevCommand: '',
          devUrl:
            'http://localhost:4414/tests/pi-memory-real.html?' +
            new URLSearchParams({ output: out, model: String(model.id), name, run: nonce, cases })
        }
      })
    )
    console.log('开始 ' + model.modelCode)
    await run(
      ['tauri', 'dev', '--config', config, '--no-watch', '--features', 'local-tests'],
      'desktop-' + name + '.log'
    )
    const result = JSON.parse(readFileSync(join(out, 'real-' + name + '.json')))
    console.log(
      name + ': ' + result.results.filter(r => r.passed).length + '/' + result.results.length + ' 通过'
    )
    for (const r of result.results.filter(r => !r.passed)) {
      failures.push(name + ':' + r.id)
      console.log('未通过 ' + r.id + '：' + r.error)
    }
  }
  if (failures.length || stopped) process.exitCode = 1
} finally {
  kill()
  qa.exec('BEGIN IMMEDIATE')
  for (const [k, v] of [
    [key, prior],
    [nonceKey, priorNonce]
  ]) {
    if (v)
      qa.prepare(
        "INSERT OR REPLACE INTO desktop_records(namespace,key,value) VALUES('app-settings',?,?)"
      ).run(k, v.value)
    else qa.prepare("DELETE FROM desktop_records WHERE namespace='app-settings' AND key=?").run(k)
  }
  qa.exec('COMMIT')
  qa.close()
}
