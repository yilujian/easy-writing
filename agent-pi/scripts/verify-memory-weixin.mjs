/** 真实 Pi + 桌面 SQLite + 本机模拟模型；不调用微信网络或真实模型。 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  out = mkdtempSync(join(tmpdir(), 'ew-pi-memory-weixin-'))
const pause = ms => new Promise(r => setTimeout(r, ms))
let active, provider
const stop = child => {
  if (child && !child.killed)
    try {
      process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM')
    } catch {}
}
process.on('SIGINT', () => {
  stop(active)
  stop(provider)
  process.exitCode = 130
})
const run = (args, log) =>
  new Promise((resolve, reject) => {
    const fd = openSync(join(out, log), 'w', 0o600)
    const child = spawn('pnpm', args, {
      cwd: root,
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32',
      env: { ...process.env, EW_PI_VALIDATION_UNTHROTTLED: '1' },
      shell: process.platform === 'win32'
    })
    active = child
    const timer = setTimeout(() => {
      stop(child)
      reject(new Error('桌面验证超时'))
    }, 240000)
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(timer)
      closeSync(fd)
      active = null
      code === 0 ? resolve() : reject(new Error('桌面进程未正常结束：' + code))
    })
  })
console.log('隔离验证输出：' + out)
try {
  if (!(await fetch('http://localhost:4414')).ok) throw new Error('需要先启动 pnpm dev:desktop:ui')
  provider = spawn(process.execPath, ['tests/fixtures/pi-memory-weixin-provider.mjs', out], {
    cwd: root,
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  })
  const until = Date.now() + 10000
  while (!existsSync(join(out, 'provider.json')) && Date.now() < until) await pause(100)
  const { baseUrl } = JSON.parse(readFileSync(join(out, 'provider.json')))
  for (const phase of ['main', 'reopen']) {
    const config = join(out, 'tauri-' + phase + '.json')
    writeFileSync(
      config,
      JSON.stringify({
        productName: 'Pi 记忆微信隔离验证',
        identifier: 'com.yichuang.writing.pi-memory-weixin-validation',
        build: {
          beforeDevCommand: '',
          devUrl:
            'http://localhost:4414/tests/pi-memory-weixin-native.html?' +
            new URLSearchParams({ output: out, provider: baseUrl, phase })
        }
      })
    )
    await run(
      ['tauri', 'dev', '--config', config, '--no-watch', '--features', 'local-tests'],
      'desktop-' + phase + '.log'
    )
    const result = JSON.parse(readFileSync(join(out, 'native-' + phase + '.json')))
    if (!result.passed) throw new Error(phase + ' 未通过：' + result.error)
    console.log(phase + ' 通过：' + result.checks.length + ' 项')
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  stop(active)
  stop(provider)
}
