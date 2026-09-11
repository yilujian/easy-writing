import type { WordCountMode } from '@/types/ui-preferences'
import { countWords, countTextWords } from '@/utils/word-count'

/**
 * 从 ProseMirror 事务里统计本次编辑净插入/净删除的字数（全站口径）。
 * 只信任事务自带的 steps/docs，不回读编辑器全文——供计划浮窗实时增减用。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Transaction 结构按最小假设访问
export const countInsertedCharsFromTransaction = (transaction: any, mode: WordCountMode = 'all'): number => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Step
    const steps: any[] = Array.isArray(transaction?.steps) ? transaction.steps : []
    if (!steps.length) return 0

    let insertedText = ''
    for (const step of steps) {
      const slice = step?.slice
      const content = slice?.content
      if (!content?.size || typeof content.textBetween !== 'function') continue
      insertedText += content.textBetween(0, content.size, '\n', '\n')
    }

    return mode === 'text' ? countTextWords(insertedText) : countWords(insertedText)
  } catch {
    return 0
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Transaction
export const countDeletedCharsFromTransaction = (transaction: any, mode: WordCountMode = 'all'): number => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Step
    const steps: any[] = Array.isArray(transaction?.steps) ? transaction.steps : []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Node
    const docs: any[] = Array.isArray(transaction?.docs) ? transaction.docs : []
    if (!steps.length || !docs.length) return 0

    let deletedText = ''
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const from = step?.from
      const to = step?.to
      if (typeof from !== 'number' || typeof to !== 'number') continue
      if (to <= from) continue

      const docBefore = docs[index]
      if (!docBefore || typeof docBefore.textBetween !== 'function') continue
      deletedText += docBefore.textBetween(from, to, '\n', '\n')
    }

    return mode === 'text' ? countTextWords(deletedText) : countWords(deletedText)
  } catch {
    return 0
  }
}
