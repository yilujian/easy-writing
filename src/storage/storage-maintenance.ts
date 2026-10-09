let maintenance = false
const writes = new Set<Promise<unknown>>()
export function assertStorageWritable() {
  if (maintenance) throw new Error('正在处理本地数据，请等待完成并重新启动应用')
}
export async function trackStorageWrite<T>(write: () => Promise<T>): Promise<T> {
  assertStorageWritable()
  const result = write()
  writes.add(result)
  try {
    return await result
  } finally {
    writes.delete(result)
  }
}
export async function beginStorageMaintenance() {
  assertStorageWritable()
  maintenance = true
  const results = await Promise.allSettled([...writes])
  if (results.some(result => result.status === 'rejected')) {
    maintenance = false
    throw new Error('仍有内容保存失败，已停止数据操作；请先确认作品已保存')
  }
}
export function endStorageMaintenance() {
  maintenance = false
}

/** Legacy core databases use the same maintenance barrier as SQLite. */
export function trackIndexedDbTransaction(transaction: IDBTransaction): IDBTransaction {
  if (transaction.mode !== 'readwrite') return transaction
  try { assertStorageWritable() } catch (error) { transaction.abort(); throw error }
  void trackStorageWrite(() => new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('本地写入已中止')), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error || new Error('本地写入失败')), { once: true })
  })).catch(() => { /* The owning storage operation reports its transaction failure to the caller. */ })
  return transaction
}
