import { writingCommand } from '@/writing-service/client'

export interface StoryMemory {
  pageEdits: Record<string, number>
  entries: Array<{ chapterNo: number; chapterId: string; title: string; summary: string }>
  people: Array<{ name: string; state: Record<string, unknown> }>
  openThreads: Array<{ title: string; origin: { chapterNo: number; quote: string } }>
  corrections: Array<{
    afterChapterId: string | number | null
    text: string
    editedAt: number
    id?: string
    source?: string
  }>
  chapters: Array<{ id: string; title: string; no: number }>
  pending: Array<[number, number]>
  needsConfirmation?: boolean
  paused: boolean
  queued: number
}
export interface BackfillPreview {
  hasPreviousText?:boolean
  targetHasText?:boolean
  chapterIds: string[]
  count: number
  characters: number
  revision: string
  throughChapterId?: string
  rangeKey?: string
  estimatedTokens?: number
}
export const readStoryMemory = (bookId: string) => writingCommand<StoryMemory>('story_memory', { bookId })
export const previewFullLedger = (bookId: string, target: { chapterId?: string; volumeId?: string } = {}) =>
  writingCommand<BackfillPreview>('story_memory_preview', { bookId, ...target })
export const startBackfill = (bookId: string, plan: BackfillPreview, modelCode?: string) =>
  writingCommand('story_memory_backfill', {
    bookId,
    chapterIds: plan.chapterIds,
    revision: plan.revision,
    ...(plan.throughChapterId ? { throughChapterId: plan.throughChapterId } : {}),
    modelCode
  })
export const pauseBackfill = (bookId: string) => writingCommand('story_memory_pause', { bookId })
export const saveCorrection = (
  bookId: string,
  afterChapterId: string | null,
  text: string,
  expectedEditedAt?: number
) =>
  writingCommand('story_memory_correct', {
    bookId,
    afterChapterId,
    text,
    ...(expectedEditedAt !== undefined ? { expectedEditedAt } : {})
  })

/** 查作品资料时仅以轻量书况提示是否需整理。按目标章节的事实只交给正文取材服务。 */
export async function readStorySummary(bookId: string) {
  return writingCommand<{ unindexed: Array<[number, number]>; indexed: number }>('story_memory_status', {
    bookId
  })
}
