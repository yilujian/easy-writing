import { piCommand } from './client'

export interface PiMemory {
  id: string
  scope: 'author' | 'book'
  bookId: string
  content: string
  revision: number
  createdAt: number
  updatedAt: number
  source: string
  sessionId: string
  knowledge?: { characterId: string; factId: string; known: boolean }
  afterChapterId?: string
}
export const listMemories = (bookId = '') => piCommand<PiMemory[]>('memory', { op: 'list', bookId })
export const saveMemory = (
  value: Pick<PiMemory, 'id' | 'scope' | 'bookId' | 'content' | 'revision' | 'afterChapterId' | 'knowledge'>,
  source = 'manual',
  sessionId = ''
) => piCommand<PiMemory>('memory', { ...value, op: 'save', source, sessionId })
export const deleteMemory = (value: Pick<PiMemory, 'id' | 'bookId' | 'revision'>) =>
  piCommand('memory', { ...value, op: 'delete' })
