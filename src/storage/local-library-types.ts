import type { JsonRecord } from '@/types/json'
import type { Book, BookGroup } from '@/types'
import type { BookReferenceExport } from './local-reference-transfer'

export type LocalMergeStatus = 'local' | 'merged' | 'ignored'

export interface LocalBook extends Book {
  localOnly: true
  groupId?: string | null
  chapterCount?: number
  mergeStatus?: LocalMergeStatus
  remoteBookId?: number | null
  mergedAt?: string | null
  deletedAt?: string | null
  // 归属账号：'guest'=未登录创建；数字串=所属云端账号 uid；null=存量数据（归属未知，仅展示）
  ownerUserId?: string | null
}

export interface LocalBookGroup extends BookGroup {
  localOnly: true
  deletedAt?: string | null
}

export interface LocalVolume {
  id: number
  bookId: string
  title: string
  summary?: string | null
  sortNo: number
  type: 'volume'
  // 工作流卷计划（本卷章纲清单等），细纲面板按它展示"待生成的未来章"
  planMeta?: JsonRecord | null
  createTime: string
  updateTime: string
  deletedAt?: string | null
}

export interface LocalChapter {
  id: number
  bookId: string
  volumeId: string
  title: string
  summary?: string | null
  wordCount: number

  textWordCount?: number | null
  sortNo: number
  status: number
  isPaid: number
  type: 'chapter'
  // 工作流章计划（expandedOutline 细纲、outlineSource 人工接管标记等）
  planMeta?: JsonRecord | null
  // 工作流生成状态：incomplete=半成品断点章 / review_required=待确认；普通章为空
  workflowStatus?: string | null
  createTime: string
  updateTime: string
  deletedAt?: string | null
}

export interface LocalLibraryVolume extends LocalVolume {
  children: LocalChapter[]
  open?: boolean
}

export interface LocalLibraryTree {
  bookId: string
  volumes: LocalLibraryVolume[]
}

export interface LocalBookListQuery {
  keyWord?: string
  groupId?: number | string
  ungrouped?: boolean
  includeDeleted?: boolean
  deletedOnly?: boolean
  sortBy?: 'updateTime' | 'createTime' | 'wordCount' | 'title'
  sortOrder?: 'ASC' | 'DESC'
}

export interface LocalExportChapter extends LocalChapter {
  textContent: string
  contentJson?: unknown
}

export interface LocalExportPayload {
  version: 1
  exportedAt: string
  book: LocalBook
  volumes: LocalVolume[]
  chapters: LocalExportChapter[]
  // 参考面板数据（大纲/角色/设定/时间线/故事线），批 H 起随 JSON 备份走；老备份没有此块
  reference?: BookReferenceExport
}

export interface LocalImportPreview {
  filename: string
  title: string
  intro?: string
  volumeCount: number
  chapterCount: number
  chaptersPreview: Array<{ title: string; wordCount: number }>
  warnings: string[]
  payload: LocalParsedBook
  // JSON 备份里的参考数据块，导入正文后随章节映射一并写入
  reference?: BookReferenceExport
}

export interface LocalParsedBook {
  title: string
  intro?: string
  volumes: Array<{
    title: string
    summary?: string
    chapters: Array<{
      title: string
      textContent: string
      summary?: string
      // JSON 备份里的旧章节 id：导入时建旧→新映射，参考数据的章节引用靠它落位
      sourceChapterId?: number
    }>
  }>
}

export interface LocalImportResult {
  bookId: number
  title: string
  volumeCount: number
  chapterCount: number
  totalWordCount: number
  warnings: string[]
}

// 云端书镜像到本地目录（离线可看）的输入结构：卷含章，均带云端真实 id。
export interface RemoteCatalogVolumeInput {
  id: number | string
  title?: string
  summary?: string
  sortNo?: number
  chapters: Array<{
    id: number | string
    title?: string
    summary?: string
    sortNo?: number
    wordCount?: number
    status?: number
  }>
}

export interface LocalLibraryStorage {
  listLocalBooks(query?: LocalBookListQuery): Promise<LocalBook[]>
  createLocalBook(payload: Partial<LocalBook>): Promise<LocalBook>
  // 用云端 id 直接落库整本目录（book+卷+章），标记为已合并；供离线回退渲染。
  importRemoteCatalog(book: Partial<LocalBook>, volumes: RemoteCatalogVolumeInput[]): Promise<void>
  updateLocalBook(payload: Partial<LocalBook> & { id: number }): Promise<LocalBook>
  softDeleteLocalBook(ids: number[]): Promise<void>
  restoreLocalBook(ids: number[]): Promise<void>
  /** 彻底删除：书+卷+章行硬删。正文/版本/参考等级联由 purgeLocalBookCompletely 编排 */
  purgeLocalBook(ids: number[]): Promise<void>
  getLocalBookDetail(id: number | string): Promise<LocalBook | null>
  listUnmergedLocalBooks(): Promise<LocalBook[]>
  markLocalBookMerged(id: number, remoteBookId: number, ownerUserId?: string): Promise<LocalBook | null>
  markLocalBookIgnored(id: number): Promise<LocalBook | null>

  listLocalGroups(): Promise<LocalBookGroup[]>
  createLocalGroup(payload: { title: string; sortNo?: number }): Promise<LocalBookGroup>
  updateLocalGroup(payload: { id: number; title?: string; sortNo?: number }): Promise<LocalBookGroup | null>
  deleteLocalGroup(ids: number[]): Promise<void>

  getLocalBookTree(bookId: number | string): Promise<LocalLibraryVolume[]>
  createLocalVolume(payload: { bookId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }): Promise<LocalVolume>
  updateLocalVolume(payload: { id: number; title?: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null }): Promise<LocalVolume | null>
  deleteLocalVolume(ids: number[]): Promise<void>
  sortLocalVolumes(payload: { bookId: number | string; volumeIds: number[] }): Promise<void>

  createLocalChapter(payload: { bookId: number | string; volumeId: number | string; title: string; summary?: string; sortNo?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }): Promise<LocalChapter>
  updateLocalChapter(payload: { id: number; title?: string; summary?: string; volumeId?: string; sortNo?: number; wordCount?: number; planMeta?: JsonRecord | null; workflowStatus?: string | null }): Promise<LocalChapter | null>
  /** 只凭章节 id 反查（单章重写等入口只有 chapterId，没有 bookId） */
  getLocalChapterById(id: number): Promise<LocalChapter | null>
  deleteLocalChapter(ids: number[]): Promise<void>
  sortLocalChapters(payload: { volumeId: number | string; chapterIds: number[] }): Promise<void>
  /** 返回刷新后的书籍统计，调用方据此更新书籍总字数，不必再触发整棵目录树重载 */
  updateLocalChapterContentMeta(payload: { bookId: number | string; chapterId: number; wordCount: number; title?: string }): Promise<LocalBook | null | undefined>
}
