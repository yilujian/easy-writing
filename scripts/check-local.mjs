/** Local regression files intentionally stay out of Git. Missing suites are an error, never a pass. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const frontendOnly = process.argv.includes('--frontend-only')
const required = [
  'vitest.config.ts',
  'tests/desktop-migration.test.ts',
  'tests/full-backup-idb.test.ts',
  'tests/writing-backup-restore.test.ts'
]
if (!frontendOnly) {
  const modules = [...readFileSync(`${root}/src-tauri/src/lib.rs`, 'utf8').matchAll(/mod (\w*tests);/g)]
  required.push(
    ...modules.map(([, name]) => `src-tauri/src/${name}.rs`),
    'src-tauri/src/desktop_storage_release_tests.rs'
  )
}
const missing = required.filter(path => !existsSync(`${root}/${path}`))
if (missing.length || !readdirSync(`${root}/tests`).some(name => name.endsWith('.test.ts'))) {
  console.error(
    `本地完整验收文件缺失：${missing.join('、')}。测试文件按约定不上传；基础检查请运行 pnpm check。`
  )
  process.exit(1)
}
const commands = frontendOnly
  ? [['pnpm', ['exec', 'vitest', 'run']]]
  : [
      ['pnpm', ['check']],
      ['pnpm', ['exec', 'vitest', 'run']],
      ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'local-tests', '--lib']]
    ]
for (const [command, args] of commands) {
  const env = { ...process.env }
  delete env.EW_AGENT_LIVE_MODEL // Paid-provider checks are a separate, explicitly configured step.
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
  if (result.error || result.status !== 0) process.exit(result.status || 1)
}
