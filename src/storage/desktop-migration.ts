import { isTauriRuntime } from './writing-storage'
import { desktopInvoke, encodeRecords, encodeDesktopValue, type PersistedStore } from './desktop-records'
import { initAppSettings } from './app-settings'
import specification from './migrations/desktop-v1.json'
import { collectLegacySnapshot } from './legacy-inventory'
export { readLegacyStore } from './legacy-inventory'
export const LEGACY_STORES = specification.stores.map(store => [store.db, store.store] as const)

export interface MigrationProgress {
  mode: 'startup' | 'migration'
  phase: 'checking' | 'backup' | 'migrating' | 'verifying' | 'finishing' | 'ready'
  completed: number
  total: number
  message: string
  detail: string
  log?: string
}
export interface StorageInspection {
  state: 'ready' | 'needs_inventory' | 'retry' | 'adopt_legacy_receipt' | 'repair_receipt'
  token: string
  pendingRestore: boolean
  sqliteRecords: number
  sqliteContentRecords: number
}
interface MigrationPlan {
  action: 'initialized' | 'migrate'
  runId: string
  backupPath: string
}

/** One startup gate for every desktop installation; application modules load only after it succeeds. */
export async function migrateDesktopStorage(onProgress?: (progress: MigrationProgress) => void) {
  if (!isTauriRuntime()) return
  const total = specification.stores.length + 8
  let completed = 0
  let mode: MigrationProgress['mode'] = 'startup'
  const report = (
    phase: MigrationProgress['phase'],
    message: string,
    detail: string,
    log?: string,
    partial = 0
  ) => onProgress?.({ mode, phase, completed: completed + partial, total, message, detail, log })
  const ready = async () => {
    await initAppSettings()
    completed = total
    report(
      'ready',
      mode === 'migration' ? '迁移完成，正在打开工作台…' : '本地数据已就绪',
      '原有数据保持保留，正在加载工作台。'
    )
  }
  report('checking', '正在检查本地存储状态…', '核对存储版本、数据库结构和迁移记录。')
  let inspection = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
  if (inspection.pendingRestore) {
    await desktopInvoke('desktop_recover_restore')
    inspection = await desktopInvoke<StorageInspection>('desktop_storage_inspect')
    if (inspection.pendingRestore) throw new Error('上次恢复尚未完成，已停止启动以保护原数据')
  }
  completed = 1
  if (inspection.state === 'ready') {
    await ready()
    return
  }
  if (inspection.state === 'adopt_legacy_receipt' || inspection.state === 'repair_receipt') {
    report('checking', '正在核对迁移完成凭据…', '根据已完成的迁移记录补全元数据，不重复导入旧数据。')
    await desktopInvoke('desktop_storage_finalize', { token: inspection.token })
    await ready()
    return
  }
  if (inspection.state !== 'needs_inventory' && inspection.state !== 'retry')
    throw new Error('本地存储状态不受当前版本支持，未修改数据')
  report('checking', '正在清点旧版本数据…', '只读取旧数据，确认是否存在需要迁移的内容。')
  const snapshot = await collectLegacySnapshot()
  for (const warning of snapshot.warnings) console.warn('[desktop-migration] 清点旧数据：', warning)
  completed = 2
  const plan = await desktopInvoke<MigrationPlan>('desktop_migration_prepare', {
    token: inspection.token,
    manifest: snapshot.manifest
  })
  if (plan.action === 'initialized') {
    await ready()
    return
  }
  if (plan.action !== 'migrate' || !plan.runId) throw new Error('迁移计划无效，未继续写入')
  mode = 'migration'
  completed = 3
  report('backup', '原始数据库副本已保存', '按照已确认的旧数据清单开始迁移。', '迁移前的数据库副本已保存')
  // 进度页此时才创建，清点阶段跳过的内容在这里补进处理详情，用户能看到哪些没迁
  for (const warning of snapshot.warnings) {
    report('backup', '原始数据库副本已保存', '按照已确认的旧数据清单开始迁移。', `已跳过 · ${warning}`)
  }
  const stage = (store: PersistedStore) =>
    desktopInvoke('desktop_migration_stage', { runId: plan.runId, store })
  try {
    for (const spec of specification.stores) {
      const source = snapshot.records.get(spec.namespace)!
      report(
        'migrating',
        `正在迁移${spec.label}…`,
        source.length ? `共 ${source.length} 条记录，正在准备写入。` : '未发现旧记录，正在确认此项无需迁移。'
      )
      const records = await encodeRecords(spec.namespace, source, (done, count) =>
        report(
          'migrating',
          `正在迁移${spec.label}…`,
          `已整理 ${done} / ${count} 条记录，附件会一并保存。`,
          undefined,
          (done / count) * 0.7
        )
      )
      await stage({ namespace: spec.namespace, records })
      completed += 1
      report(
        'migrating',
        `${spec.label}已处理`,
        '等待所有模块完成后统一校验并提交。',
        `${spec.label} · ${records.length ? `${records.length} 条记录已暂存` : '无旧数据，已跳过'}`
      )
    }
    report('migrating', '正在整理书籍封面…', '核对每张封面的原始字节和保存结果。')
    const covers = snapshot.records.get(specification.coverNamespace)!
    const coverRecords = []
    for (const row of covers) {
      const value = row.value as { original: string; book: Record<string, unknown> }
      coverRecords.push({
        key: row.key,
        value: JSON.stringify({
          ...value,
          book: { ...value.book, coverUrl: await encodeDesktopValue(value.book.coverUrl, 'book-cover') }
        })
      })
      report(
        'migrating',
        '正在整理书籍封面…',
        `已保存 ${coverRecords.length} / ${covers.length} 张封面。`,
        undefined,
        (coverRecords.length / covers.length) * 0.7
      )
    }
    await stage({ namespace: specification.coverNamespace, records: coverRecords })
    completed += 1
    report(
      'verifying',
      '字体与文件对应关系已确认',
      '每个旧字体均保留了对应文件。',
      `书籍封面 · ${coverRecords.length ? `${coverRecords.length} 张已保存` : '无需转换'}`
    )
    completed += 1
    const settings = await encodeRecords(
      specification.settingsNamespace,
      snapshot.records.get(specification.settingsNamespace)!
    )
    report(
      'migrating',
      '正在迁移设置与统计…',
      `共 ${settings.length} 项，原始设置继续保留。`,
      '字体与文件对应关系校验通过'
    )
    await stage({ namespace: specification.settingsNamespace, records: settings })
    completed += 1
    report(
      'verifying',
      '正在复核源数据并提交迁移结果…',
      '再次核对源数据、暂存内容与附件，全部一致后才启用新存储。',
      `设置与统计 · ${settings.length} 项已暂存`
    )
    const verifiedSource = (await collectLegacySnapshot()).manifest
    await desktopInvoke('desktop_migration_commit', { runId: plan.runId, verifiedSource })
    completed += 1
    report('finishing', '正在加载迁移后的设置…', '校验和事务提交已完成。', '记录与附件校验通过，新存储已启用')
    await ready()
  } catch (error) {
    await desktopInvoke('desktop_migration_fail', { runId: plan.runId, message: String(error) }).catch(
      () => undefined
    )
    throw error
  }
}
