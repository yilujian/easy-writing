/**
 * 开发版热更新时，改了被任务模块引用的文件，Vite 会把任务模块重新执行一遍：新实例向任务层登记一份空列表，
 * 而 Pinia 里的旧工作台仍把任务写进旧列表，于是界面看不到任务卡、完成事件也找不到任务。
 * 把这类模块级状态放进 import.meta.hot.data，重新执行时取回同一份。生产包没有 import.meta.hot，直接新建。
 */
export function hotState<T>(key: string, create: () => T): T {
  const data = import.meta.hot?.data as Record<string, unknown> | undefined
  if (!data) return create()
  if (!(key in data)) data[key] = create()
  return data[key] as T
}
