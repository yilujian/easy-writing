import { appSettings } from '@/storage/app-settings'
const STORAGE_KEY = 'ew-workflow-active-run'

// 记住「用户当前正在编辑的工作流」，让切到别的功能模块再回来时无缝续上，
// 而不是新建一条空 run、把进行中的流程丢进历史记录里。
//
// 按 userId 分区：同一浏览器换账号不会串到别人的 run（服务端 requireRun 还会再校验一次归属）。
// 统一设置存储：关窗、刷新后仍能续上，桌面端持久化到 SQLite。
type ActiveRunMap = Record<string, number>

const readMap = (): ActiveRunMap => {
  try {
    const raw = appSettings.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ActiveRunMap
  } catch {
    // 存储不可用（隐私模式 / 配额满）时退化为「不恢复」，不影响主流程
    return {}
  }
}

const writeMap = (map: ActiveRunMap) => {
  try {
    appSettings.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 同上：写不进去只是失去恢复能力
  }
}

const resolveKey = (userId: number) => String(Number(userId) || 0)

export const getActiveRunId = (userId: number): number => {
  if (!Number(userId)) return 0
  return Number(readMap()[resolveKey(userId)] || 0)
}

export const setActiveRunId = (userId: number, runId: number) => {
  if (!Number(userId) || !Number(runId)) return
  writeMap({ ...readMap(), [resolveKey(userId)]: Number(runId) })
}

export const clearActiveRunId = (userId: number) => {
  if (!Number(userId)) return
  const map = readMap()
  delete map[resolveKey(userId)]
  writeMap(map)
}
