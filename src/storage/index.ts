import { IndexedDbWritingStorage } from './indexeddb-writing-storage'
import { SqliteWritingStorage } from './sqlite-writing-storage'
import type { WritingStorage } from './writing-storage'
import { usesSqliteCore } from './storage-mode'

let storage: WritingStorage | null = null

export const getWritingStorage = () => {
  if (!storage) {
    storage = usesSqliteCore()
      ? new SqliteWritingStorage()
      : new IndexedDbWritingStorage()
  }
  return storage
}

export * from './writing-storage'
