import type { BookReferenceExport } from '@/storage/local-reference-transfer'

export interface BackupScan { files: Array<{ path: string; content: string }>; warnings: string[] }
export interface BackupRestoreChapter {
  sourceId: string
  volumeId: string
  volumeTitle: string
  title: string
  textContent: string
  contentJson: unknown
  backupAt: number
  sourcePath: string
  /** 备份时目录里的实际位置（从 1 起）；旧备份文件没有，为 null */
  orderNo: number | null
  volumeOrderNo: number | null
}
export interface BackupRestoreBook {
  sourceId: string
  title: string
  chapters: BackupRestoreChapter[]
  reference?: BookReferenceExport
  referenceAt: number
  latestAt: number
}
export interface BackupRestorePreview { books: BackupRestoreBook[]; warnings: string[] }
export interface BackupRestoreResult { bookId: number; title: string; chapterCount: number }
