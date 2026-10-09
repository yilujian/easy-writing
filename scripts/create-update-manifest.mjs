import { parseArgs } from 'node:util'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'

// 输入已签名的更新包；只生成清单，不上传或改动线上文件。
const { values } = parseArgs({ options: Object.fromEntries(
  ['version', 'notes', 'date', 'base-url', 'windows', 'mac-arm64', 'mac-x64', 'linux-x64', 'out'].map(key => [key, { type: 'string' }])
) })
for (const key of ['version', 'notes', 'base-url', 'windows', 'mac-arm64', 'mac-x64', 'out']) {
  if (!values[key]) throw new Error(`缺少 --${key}`)
}
if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(values.version)) throw new Error('版本号必须符合 SemVer')
const base = new URL(values['base-url'].replace(/\/?$/, '/'))
if (base.protocol !== 'https:') throw new Error('更新包必须通过 HTTPS 提供')
const notes = (await readFile(values.notes, 'utf8')).trim()
if (!notes) throw new Error('更新内容不能为空')
const pub_date = new Date(values.date || Date.now()).toISOString()
const platforms = {}
for (const [target, key, suffix] of [
  ['windows-x86_64', 'windows', '.exe'],
  ['darwin-aarch64', 'mac-arm64', '.app.tar.gz'],
  ['darwin-x86_64', 'mac-x64', '.app.tar.gz'],
  ...(values['linux-x64'] ? [['linux-x86_64', 'linux-x64', '.AppImage']] : []),
]) {
  const path = resolve(values[key])
  if (!path.endsWith(suffix) || !(await stat(path)).size) throw new Error(`${target} 更新包格式不正确`)
  const signature = (await readFile(`${path}.sig`, 'utf8')).trim()
  if (!signature || !Buffer.from(signature, 'base64').toString().startsWith('untrusted comment:')) throw new Error(`${target} 缺少有效的 Tauri 签名`)
  platforms[target] = { signature, url: new URL(encodeURIComponent(basename(path)), base).href }
}
await mkdir(values.out, { recursive: true })
const output = resolve(values.out, 'latest.json')
await writeFile(output, JSON.stringify({ version: values.version, notes, pub_date, platforms }, null, 2) + '\n')
console.log(output)
