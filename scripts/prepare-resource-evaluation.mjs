/** 准备资源 A/B/C 对照任务与盲评表；不调用模型，也不产生人工有效结论。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const output = option('--output')
if (!output) throw new Error('请通过 --output 指定新的准备目录；本命令只准备任务，不调用模型。')
const destination = resolve(output)
// 不覆盖已有评审材料或实验结果。
await mkdir(destination)
const packet = JSON.parse(await readFile(option('--resources', resolve(root, 'docs/agent-resource-pilot/resources.json')), 'utf8'))
const tasks = JSON.parse(await readFile(option('--tasks', resolve(root, 'docs/agent-resource-pilot/tasks.json')), 'utf8'))
if (packet.format !== 'yichuang-writing-resources-v1' || tasks.format !== 'yichuang-resource-eval-tasks-v1') throw new Error('资料包或任务格式无效')
const byId = new Map(packet.resources.map(resource => [resource.id, resource]))
await mkdir(resolve(destination, 'prompts')); await mkdir(resolve(destination, 'coordinator')); await mkdir(resolve(destination, 'reviewers'))
const manifest = []
const csv = ['样稿编号,任务编号,是否愿意采用,具体修改意见,事实问题,评审人']
for (const task of tasks.tasks) {
  const materials = task.resourceIds.map(id => { const resource = byId.get(id); if (!resource) throw new Error(`任务 ${task.id} 引用了不存在的资源`); return resource })
  for (let repeat = 1; repeat <= tasks.repeats; repeat++) {
    const jobs = ['A', 'B', 'C'].map(group => {
      const id = randomUUID()
      const context = group === 'A' ? '' : materials.map(resource => `参考样本（不是本故事事实）：\n必要前情：${resource.context}\n完整样本：${resource.content}${group === 'C' ? `\n待验证的方法说明：${resource.explanation}` : ''}`).join('\n\n')
      return { id, group, taskId: task.id, partition: task.partition, repeat, resourceIds: task.resourceIds, prompt: [task.prompt, context].filter(Boolean).join('\n\n'), reviewRequired: true }
    })
    // 只隐藏样稿组别，不从重复结果中挑选有利样稿；每个任务/组别生成次数相同。
    for (const job of jobs.sort((a, b) => a.id.localeCompare(b.id))) {
      await writeFile(resolve(destination, 'prompts', `${job.id}.json`), JSON.stringify({ id: job.id, taskId: job.taskId, prompt: job.prompt, maxOutputTokens: 1500, status: 'awaiting_source_review_and_model_run' }, null, 2))
      manifest.push({ ...job, prompt: undefined })
      csv.push(`${job.id},${task.id},,,,,`)
    }
  }
}
await writeFile(resolve(destination, 'coordinator', 'manifest.json'), JSON.stringify({ status: 'prepared_only', humanSourceReviewRequired: true, model: null, settings: null, jobs: manifest }, null, 2))
await writeFile(resolve(destination, 'reviewers', 'ballot.csv'), '\uFEFF' + csv.join('\n'))
await writeFile(resolve(destination, 'README.txt'), '这些是待执行的对照任务，不是生成结果。先由内容负责人核对资源与任务分配，再固定同一模型和参数执行。原始稿保存为样稿编号.txt，全部保留；给评审人时不提供 coordinator 或 prompts 目录。人工允许选择无差别或都不好。holdout 任务不得参与调整资源后再当作未见样本。\n')
console.log(JSON.stringify({ prepared: manifest.length, generated: 0, humanReviews: 0, output: destination }))
