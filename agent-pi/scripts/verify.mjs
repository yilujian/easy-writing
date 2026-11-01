/** 本地 Pi 验证入口。默认不调用真实模型；--real 必须显式指定来源数据库。 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
if (args.includes('--help')) {
  console.log(
    'node agent-pi/scripts/verify.mjs [--unit] [--ui [--session]] [--restore] [--real [--stage2 | --stream | --session] --models-db <平台 ew-writing.db> --models flash,pro] [--output <目录>]\n默认运行类型、工具契约和本地回归；--real 会调用所选真实模型，仅在隔离作品和验证配置中运行。'
  )
  process.exit(0)
}
const windowReload = args.includes('--window-reload')
const refresh = args.includes('--refresh')
const control = args.includes('--control')
const opening = args.includes('--opening')
const proseTarget = args.includes('--prose-target')
const historyPane = args.includes('--history-pane')
const session = args.includes('--session'),
  stage2 = args.includes('--stage2'),
  ui = args.includes('--ui'),
  stream = args.includes('--stream')
const real = args.includes('--real'),
  restore = args.includes('--restore'),
  unit = args.includes('--unit') || (!real && !restore && !ui)
const output = resolve(option('--output') || mkdtempSync(join(tmpdir(), 'ew-pi-verify-')))
mkdirSync(output, { recursive: true, mode: 0o700 })
const requireFiles = files => {
  const missing = files.filter(f => !existsSync(join(root, f)))
  if (missing.length)
    throw new Error(
      '本地验收文件缺失：' + missing.join('、') + '。本地测试按仓库原约定不入 Git；缺失不能视为通过。'
    )
}
let active,
  interrupted = false
const run = (command, argv, log, timeout = 900000, extraEnv = {}) =>
  new Promise((resolvePromise, reject) => {
    if (interrupted) {
      reject(new Error('验证已被停止'))
      return
    }
    const fd = openSync(join(output, log), 'w', 0o600)
    const child = spawn(command, argv, {
      cwd: root,
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...extraEnv },
      shell: process.platform === 'win32'
    })
    active = child
    const timer = setTimeout(() => {
      killOwn(child)
      reject(new Error('验证超时，未重放任务：' + log))
    }, timeout)
    child.once('error', e => {
      clearTimeout(timer)
      closeSync(fd)
      active = undefined
      reject(e)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      closeSync(fd)
      active = undefined
      code === 0 ? resolvePromise() : reject(new Error(log + ' 未通过，退出码 ' + code))
    })
  })
function killOwn(child) {
  try {
    if (process.platform === 'win32') child.kill()
    else process.kill(-child.pid, 'SIGTERM')
  } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true
    if (active) killOwn(active)
  })
const localTests = [
  'agent-pi-tools',
  'pi-stream-turns',
  'pi-document-cards',
  'pi-background-conversations',
  'pi-channel-runtime',
  'pi-weixin-adapter',
  'weixin-channel',
  'weixin-commands',
  'pi-story-ledger',
  'pi-session-context',
  'pi-author-messages',
  'pi-run-control',
  'agent-pi-research-confirm',
  'agent-pi-delivery',
  'pi-breakdown-execution',
  'pi-breakdown-analysis',
  'pi-breakdown-runtime',
  'pi-chat-attachments',
  'pi-chat-upload-lifecycle',
  'pi-rank-cancel',
  'pi-platform-task-close',
  'pi-research-target',
  'local-breakdown',
  'local-rank-store',
  'rank-service',
  'local-rank-crawler',
  'local-rank-qimao-fetch',
  'local-rank-qimao-http',
  'local-rank-qidian',
  'agent-pi-lifecycle',
  'agent-pi-adoption',
  'agent-pi-adoption-view',
  'agent-pi-new-chapter',
  'agent-pi-volume-question',
  'agent-pi-close',
  'pi-app-close',
  'pi-session-management',
  'pi-process-steps',
  'pi-question-card',
  'pi-question-ui',
  'pi-tool-groups',
  'pi-material-tools',
  'pi-rank-metadata',
  'pi-ranking-refresh',
  'pi-book-creation-flow',
  'pi-breakdown-live',
  'pi-breakdown-continue',
  'pi-attachment-import',
  'pi-composer-menu',
  'pi-skills',
  'pi-distillation-runtime',
  'pi-batch-flow',
  'pi-cover-flow',
  'document-text',
  'miaobi-session',
  'writing-ai-independent',
  'writing-ai-rewrite',
  'agent-draft-events',
  'agent-notices',
  'pi-catalog-concurrency',
  'sqlite-word-count-modes',
  'local-library-utils',
  'word-count-modes',
  'desktop-backup-roundtrip',
  'full-backup',
  'full-backup-idb',
  'agent-backup-restore'
].map(n => 'tests/' + n + '.test.ts')
console.log('验证输出：' + output)
try {
  await run(process.execPath, ['agent-pi/scripts/check-tools.mjs'], 'tools.log')
  if (unit) {
    requireFiles([
      ...localTests,
      'src-tauri/src/pi_tests.rs',
      'src-tauri/src/pi_adoption_tests.rs',
      'src-tauri/src/pi_new_chapter_tests.rs',
      'src-tauri/src/pi_entity_tests.rs'
    ])
    for (const [label, command, argv] of [
      ['types', 'pnpm', ['exec', 'vue-tsc', '--noEmit']],
      ['extension', 'pnpm', ['--dir', 'agent-pi', 'check']],
      ['delivery-native', process.execPath, ['agent-pi/scripts/smoke.mjs', '--missing-candidate']],
      ['frontend', 'pnpm', ['exec', 'vitest', 'run', '--maxWorkers=1', '--minWorkers=1', ...localTests]],
      [
        'native',
        'cargo',
        [
          'test',
          '--offline',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          '--features',
          'local-tests',
          'pi_host::',
          '--lib'
        ]
      ]
    ]) {
      console.log('检查 ' + label)
      await run(command, argv, label + '.log')
    }
  }
  if (real) {
    requireFiles(
      session
        ? ['tests/pi-session-native.html']
        : stream
          ? ['tests/pi-stream-real.html']
          : stage2
            ? ['tests/pi-stage2-real.html']
            : ['tests/pi-stage1-real.html', 'tests/pi-stage1-context.html']
    )
    const source = option('--models-db')
    if (!source) throw new Error('--real 必须明确提供 --models-db；不会自动搜索或显示密钥')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(resolve(source), { readOnly: true }),
      key = JSON.stringify('ew-local-ai-models')
    const row = db
      .prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?")
      .get(key)
    db.close()
    if (!row) throw new Error('来源数据库没有平台模型配置')
    const selected = option('--models', 'flash,pro').split(',')
    if (selected.some(n => !['flash', 'pro'].includes(n))) throw new Error('本验收只支持已确认的 flash、pro')
    const configured = JSON.parse(JSON.parse(row.value)).models
    const models = selected.map(name => {
      const m = configured.find(
        m => m.modelCode === 'deepseek-v4-' + name && m.scene === 'text' && m.status === 1
      )
      if (!m) throw new Error('未找到已启用的 ' + name)
      return { name, model: m }
    })
    const qaId = 'com.yichuang.writing.pi-batch1-validation'
    const configRoot =
      process.platform === 'darwin'
        ? join(homedir(), 'Library/Application Support')
        : process.platform === 'win32'
          ? process.env.APPDATA
          : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    if (!configRoot) throw new Error('无法确定验证配置目录')
    const qaPath = join(configRoot, qaId, 'ew-writing.db')
    if (resolve(source) === qaPath) throw new Error('真实来源与隔离验证库不能相同')
    const url = 'http://localhost:4414'
    if (!(await fetch(url)).ok) throw new Error('请先运行 pnpm dev:desktop:ui，保持 4414 端口可用')
    let prior,
      priorRun,
      copied = false
    const nonce = randomUUID(),
      readyKey = JSON.stringify('ew-pi-validation-run')
    const install = () => {
      if (!existsSync(qaPath)) return false
      const qa = new DatabaseSync(qaPath)
      try {
        if (!qa.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_records'").get()) return false
        prior = qa
          .prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?")
          .get(key)
        priorRun = qa
          .prepare("SELECT value FROM desktop_records WHERE namespace='app-settings' AND key=?")
          .get(readyKey)
        qa.exec('BEGIN IMMEDIATE')
        const put = qa.prepare(
          "INSERT OR REPLACE INTO desktop_records(namespace,key,value) VALUES('app-settings',?,?)"
        )
        put.run(
          key,
          JSON.stringify(JSON.stringify({ version: 1, models: models.map(x => x.model), preferences: {} }))
        )
        put.run(readyKey, JSON.stringify(nonce))
        qa.exec('COMMIT')
        copied = true
        chmodSync(qaPath, 0o600)
        return true
      } finally {
        qa.close()
      }
    }
    try {
      install()
      for (const { name, model } of session ? models.slice(0, 1) : models) {
        for (const phase of session
          ? ['session']
          : stream
            ? ['stream']
            : stage2
              ? ['real']
              : ['real', 'context']) {
          const query = new URLSearchParams({
            output,
            model: String(model.id),
            name,
            run: nonce,
            ...(session
              ? {
                  real: 'true',
                  nextModel: String(models.find(x => x.model.id !== model.id)?.model.id || model.id)
                }
              : {})
          })
          if (phase === 'context')
            query.set('book', JSON.parse(readFileSync(join(output, 'real-' + name + '.json'))).bookId)
          const config = join(output, `tauri-${phase}-${name}.json`)
          writeFileSync(
            config,
            JSON.stringify({
              productName: '易创 Pi 隔离验收',
              identifier: qaId,
              build: {
                beforeDevCommand: '',
                devUrl:
                  url +
                  (session
                    ? '/tests/pi-session-native.html?'
                    : stream
                      ? '/tests/pi-stream-real.html?'
                      : `/tests/pi-stage${stage2 ? 2 : 1}-${phase}.html?`) +
                  query
              }
            })
          )
          console.log(`真实验证 ${name} / ${phase}`)
          const task = run(
            'pnpm',
            [
              'tauri',
              'dev',
              '--config',
              config,
              '--no-watch',
              ...(stage2 || stream || session ? ['--features', 'local-tests'] : [])
            ],
            `desktop-${phase}-${name}.log`,
            900000,
            stage2 || stream || session ? { EW_PI_VALIDATION_UNTHROTTLED: '1' } : {}
          )
          // 新配置目录由应用原有启动流程建表，验证脚本等待唯一运行标识后才发请求。
          if (!copied) {
            const until = Date.now() + 60000
            while (!copied && !interrupted && Date.now() < until) {
              await new Promise(r => setTimeout(r, 500))
              install()
            }
            if (!copied) {
              if (active) killOwn(active)
              throw new Error('验证数据库未就绪')
            }
          }
          await task
          const result = JSON.parse(readFileSync(join(output, phase + '-' + name + '.json')))
          if (!result.passed) throw new Error(`${name}/${phase} 未通过，详见结果文件`)
        }
      }
    } finally {
      if (copied) {
        const qa = new DatabaseSync(qaPath)
        try {
          qa.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE')
          for (const [k, v] of [
            [key, prior],
            [readyKey, priorRun]
          ]) {
            if (v)
              qa.prepare("UPDATE desktop_records SET value=? WHERE namespace='app-settings' AND key=?").run(
                v.value,
                k
              )
            else qa.prepare("DELETE FROM desktop_records WHERE namespace='app-settings' AND key=?").run(k)
          }
          qa.exec('COMMIT')
        } finally {
          qa.close()
        }
      }
    }
  }
  if (ui) {
    requireFiles([
      windowReload ? 'tests/pi-platform-reload.html' : refresh ? 'tests/pi-refresh-native.html' : control ? 'tests/pi-control-native.html' : opening ? 'tests/pi-opening-native.html' : session ? 'tests/pi-session-native.html' : 'tests/pi-ui-native.html',
      'tests/fixtures/pi-ui-provider.mjs'
    ])
    const fd = openSync(join(output, 'ui-provider.log'), 'w', 0o600)
    const provider = spawn(process.execPath, ['tests/fixtures/pi-ui-provider.mjs', output, option('--origin','http://localhost:4414')], {
      cwd: root,
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32'
    })
    try {
      const until = Date.now() + 10000
      while (!existsSync(join(output, 'ui-provider.json')) && Date.now() < until)
        await new Promise(r => setTimeout(r, 100))
      const { baseUrl } = JSON.parse(readFileSync(join(output, 'ui-provider.json')))
      for (const phase of ['main', 'reopen']) {
        const config = join(output, `tauri-ui-${phase}.json`)
        writeFileSync(
          config,
          JSON.stringify({
            productName: 'Pi 对话交互隔离验证',
            identifier: option('--validation-id', 'com.yichuang.writing.pi-ui-validation'),
            build: {
              beforeDevCommand: '',
              devUrl:
                option('--origin', 'http://localhost:4414') + '/tests/' +
                (windowReload ? 'pi-platform-reload.html?' : historyPane ? 'pi-long-memory-pane.html?' : proseTarget ? 'pi-text-target-native.html?' : refresh ? 'pi-refresh-native.html?' : control ? 'pi-control-native.html?' : opening ? 'pi-opening-native.html?' : session ? 'pi-session-native.html?' : 'pi-ui-native.html?') +
                new URLSearchParams({ output, phase, provider: baseUrl })
            }
          })
        )
        console.log('桌面交互验证 ' + phase)
        await run(
          'pnpm',
          ['tauri', 'dev', '--config', config, '--no-watch', '--features', 'local-tests'],
          `ui-${phase}.log`,
          180000,
          { EW_PI_VALIDATION_UNTHROTTLED: '1' }
        )
        if (!JSON.parse(readFileSync(join(output, `ui-${phase}.json`))).passed)
          throw new Error('交互验证未通过：' + phase)
      }
    } finally {
      killOwn(provider)
      closeSync(fd)
    }
  }
  if (restore) {
    requireFiles(['tests/pi-stage1-restore.html', 'tests/fixtures/pi-stage1-provider.mjs'])
    const prompts = join(mkdtempSync(join(tmpdir(), 'ew-pi-restore-')), 'pi-test-prompts')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(join(prompts, 'fixture.md'), '隔离验证提示词。')
    const fd = openSync(join(output, 'provider.log'), 'w', 0o600)
    const provider = spawn(process.execPath, ['tests/fixtures/pi-stage1-provider.mjs', output], {
      cwd: root,
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32'
    })
    try {
      const until = Date.now() + 10000
      while (!existsSync(join(output, 'mock-provider.json')) && !interrupted && Date.now() < until)
        await new Promise(r => setTimeout(r, 100))
      if (!existsSync(join(output, 'mock-provider.json'))) throw new Error('隔离模型服务未就绪')
      const { baseUrl } = JSON.parse(readFileSync(join(output, 'mock-provider.json')))
      for (const phase of ['main', 'apply', 'merge', 'reopen']) {
        const query = new URLSearchParams({ output, provider: baseUrl, phase }),
          config = join(output, `tauri-restore-${phase}.json`)
        writeFileSync(
          config,
          JSON.stringify({
            productName: '易创 Pi 恢复隔离验证',
            identifier: 'com.yichuang.writing.pi-stage1-restore',
            build: {
              beforeDevCommand: '',
              devUrl: 'http://localhost:4414/tests/pi-stage1-restore.html?' + query
            }
          })
        )
        console.log('隔离恢复验证 ' + phase)
        await run(
          'pnpm',
          ['tauri', 'dev', '--features', 'local-tests', '--config', config, '--no-watch'],
          `restore-${phase}.log`,
          900000,
          { EW_PI_VALIDATION_PROMPTS: prompts }
        )
        if (!JSON.parse(readFileSync(join(output, 'restore-' + phase + '.json'))).passed)
          throw new Error('恢复验证 ' + phase + ' 未通过')
      }
    } finally {
      killOwn(provider)
      closeSync(fd)
    }
  }
  writeFileSync(
    join(output, 'verification.json'),
    JSON.stringify({ passed: true, unit, real, restore, ui, stream, output }, null, 2)
  )
  console.log('所选验证通过；未打包发布。')
} catch (e) {
  writeFileSync(
    join(output, 'verification.json'),
    JSON.stringify({ passed: false, error: String(e) }, null, 2)
  )
  console.error(String(e))
  process.exitCode = 1
}
