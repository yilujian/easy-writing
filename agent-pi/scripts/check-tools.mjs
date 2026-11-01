/** 三处边界分别保留职责；检测扩展、宿主权限和界面文案是否发生漂移。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../../', import.meta.url))
const read = file => readFileSync(root + file, 'utf8')
const extension = new Set(
  [...read('agent-pi/extensions/yichuang.ts').matchAll(/name: ['"]([a-z_]+)['"]/g)].map(m => m[1])
)
const host = read('src-tauri/src/pi_host.rs')
const native = new Set(
  [...host.match(/const TOOLS:[\s\S]*?= &\[([\s\S]*?)\];/)[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1])
)
assert.deepEqual(
  [...extension].filter(n => !['ask_author', 'read', 'read_platform_state', 'prepare_writing'].includes(n)).sort(),
  [...native].sort(),
  'Pi 扩展与原生工具白名单不一致'
)
const implementation = new Set(
  [...read('src/agent-pi/platform-tools.ts').matchAll(/tool === ['"]([a-z_]+)['"]/g)].map(m => m[1])
)
const rustOwners = read('src-tauri/src/pi_platform.rs').match(/pub const TOOLS:[\s\S]*?= &\[([\s\S]*?)\];/)[1]
for (const [, name] of rustOwners.matchAll(/"([a-z_]+)"/g)) {
  assert.ok(!implementation.has(name), '工具不能同时在主窗口和原生后台执行：' + name)
  implementation.add(name)
}
assert.deepEqual([...native].sort(), [...implementation].sort(), '平台工具存在缺失或未注册分支')
const labels = read('src/views/AgentPi/index.vue').match(/const toolNames:[\s\S]*?= \{([\s\S]*?)\n\}/)[1]
for (const name of extension)
  assert.match(labels, new RegExp('\\b' + name + ':'), '缺少工具界面文案：' + name)
assert.match(host, /arg\(tool_names\)/)
assert.match(host, /public_tool_names\(\)/)
const groups = JSON.parse(read('agent-pi/contracts/tool-groups.json'))
const members = new Set(Object.values(groups).flatMap(group => Object.values(group.operations)))
const exposed = [...extension].filter(name => groups[name] || !members.has(name))
for (const group of Object.values(groups))
  for (const operation of Object.values(group.operations)) assert.ok(extension.has(operation), '分组缺少原子操作：' + operation)
console.log('Pi 工具契约一致：' + exposed.length + ' 个对模型工具（含 3 个本地工具），' + native.size + ' 个原生原子操作。')
