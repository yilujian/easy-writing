// Assemble the same Pi RPC runtime for the target OS, including its own Node executable.
import { createHash } from 'node:crypto'
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
const upstream = join(root, 'upstream')
const pkg = join(upstream, 'packages/coding-agent')
const lock = JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8'))
if ((await readFile(join(upstream, '.yichuang-revision'), 'utf8')).trim() !== lock.commit)
  throw Error('请先运行 pnpm --dir agent-pi setup，准备锁定版本的 Pi')
const target = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE
const version = '22.21.1'
const checksums = {
  'darwin-arm64.tar.gz': 'c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af',
  'darwin-x64.tar.gz': '8e3dc89614debe66c2a6ad2313a1adb06eb37db6cd6c40d7de6f7d987f7d1afd',
  'win-x64.zip': '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf',
  'linux-x64.tar.xz': '680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88'
}
const targets = new Map([
  ['universal-apple-darwin', ['darwin-arm64.tar.gz', 'darwin-x64.tar.gz']],
  ['aarch64-apple-darwin', ['darwin-arm64.tar.gz']],
  ['x86_64-apple-darwin', ['darwin-x64.tar.gz']],
  ['x86_64-pc-windows-msvc', ['win-x64.zip']],
  ['x86_64-unknown-linux-gnu', ['linux-x64.tar.xz']]
])
const archives = targets.get(target)
if (!archives) throw Error('不支持的 Agent 打包目标：' + target)
const cache = process.env.EW_NODE_ARCHIVE_DIR || join(root, '.cache', 'node')
const destination = resolve(root, '../src-tauri/resources/agent-pi')
const tmp = await mkdtemp(join(tmpdir(), 'ew-node-'))
const staging = await mkdtemp(join(dirname(destination), '.pi-stage-'))
async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, dereference: true })
}
async function extractNode(suffix) {
  const name = 'node-v' + version + '-' + suffix
  const archive = join(cache, name)
  let bytes
  try { bytes = await readFile(archive) } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const response = await fetch('https://nodejs.org/dist/v' + version + '/' + name)
    if (!response.ok) throw Error('下载 Node 失败：HTTP ' + response.status)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksums[suffix]) throw Error(name + ' 校验失败')
  await mkdir(cache, { recursive: true })
  try { await writeFile(archive, bytes, { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  const dir = name.replace(/\.tar\.(gz|xz)$|\.zip$/, '')
  const win = suffix.endsWith('.zip')
  const binary = win ? 'node.exe' : 'bin/node'
  const members = [dir + '/' + binary, dir + '/LICENSE']
  if (win && process.platform !== 'win32') execFileSync('unzip', ['-q', archive, ...members, '-d', tmp])
  else execFileSync('tar', ['-xf', archive, '-C', tmp, ...members])
  await copy(join(tmp,dir,'LICENSE'), join(staging,'licenses','Node-LICENSE'))
  return join(tmp,dir,binary)
}
try {
  const bin = join(staging,'bin',target.includes('windows') ? 'node.exe' : 'node')
  await mkdir(dirname(bin), {recursive:true})
  const nodes = []
  for (const archive of archives) nodes.push(await extractNode(archive))
  if (nodes.length === 1) await copyFile(nodes[0],bin)
  else {
    execFileSync('lipo',['-create',...nodes,'-output',bin])
    execFileSync('codesign',['--force','--sign','-',bin])
  }
  await chmod(bin,0o755)
  for (const file of ['package.json','README.md','CHANGELOG.md','dist/bundle','dist/modes/interactive/theme','dist/core/export-html','schemas'])
    await copy(join(pkg,file),join(staging,'pi',file))
  // These are the runtime externals in the upstream Node bundle (the image library uses WASM).
  for (const dep of ['jiti','@silvia-odwyer/photon-node'])
    await copy(join(upstream,'node_modules',dep),join(staging,'pi/node_modules',dep))
  const {build} = createRequire(join(upstream,'package.json'))('esbuild')
  await build({
    entryPoints:[join(root,'extensions/yichuang.ts')],outfile:join(staging,'extensions/yichuang.mjs'),
    bundle:true,platform:'node',format:'esm',target:'node22.19',external:['@earendil-works/pi-ai']
  })
  for (const dir of ['skills','prompts']) await copy(join(root,dir),join(staging,dir))
  await copy(join(root,'LICENSE-Pi'),join(staging,'licenses','Pi-LICENSE'))
  await writeFile(join(staging,'runtime.json'), JSON.stringify({node:basename(bin),nodeVersion:version,piVersion:lock.version,commit:lock.commit,target}, null, 2)+'\n')
  await access(join(staging,'pi/dist/bundle/cli.js'))
  await rm(destination,{recursive:true,force:true})
  await rename(staging,destination)
  console.log('已准备安装包内的 Agent：'+target)
} finally {
  await rm(tmp,{recursive:true,force:true})
  await rm(staging,{recursive:true,force:true})
}
