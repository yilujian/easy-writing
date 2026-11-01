/** 固定源码快照 → 完整 Pi 构建。开发接入不修改根项目依赖或原 Agent 运行时。 */
import { readFile, writeFile, mkdir, access, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(resolve(root, 'upstream.lock.json'), 'utf8'))
const upstream = resolve(root, 'upstream'),
  archive = resolve(root, '.cache/pi-source.tar.gz')
const exists = async path => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
function run(command, args, cwd = upstream) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, HUSKY: '0' },
    shell: process.platform === 'win32'
  })
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${command} 未完成（${result.status}）`)
}
await mkdir(resolve(root, '.cache'), { recursive: true })
if (!(await exists(resolve(upstream, 'package.json')))) {
  if (!(await exists(archive))) {
    const response = await fetch(lock.archiveUrl, { headers: { 'User-Agent': 'easy-writing-pi-setup' } })
    if (!response.ok) throw new Error(`下载 Pi 源码失败：${response.status}`)
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  }
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  if (digest !== lock.sha256) throw new Error('Pi 源码校验失败，未执行构建')
  await mkdir(upstream, { recursive: true })
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', upstream], root)
  await writeFile(resolve(upstream, '.yichuang-revision'), lock.commit)
}
const revision = resolve(upstream, '.yichuang-revision')
if (!(await exists(revision)) || (await readFile(revision, 'utf8')).trim() !== lock.commit)
  throw new Error('Pi 源码目录版本不符；请先保留本地改动，再重新准备源码')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
run(npm, ['run', 'hydrate:model-data'])
run(npm, ['run', 'build:offline'])
const modules = resolve(root, 'node_modules')
if (!(await exists(modules)))
  await symlink(resolve(upstream, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(
  resolve(root, 'runtime.json'),
  JSON.stringify({ node: process.execPath, version: lock.version, commit: lock.commit }, null, 2) + '\n'
)
console.log(`Pi ${lock.version} 完整运行时已准备；可在桌面开发版打开 Agent(Pi版本)。`)
