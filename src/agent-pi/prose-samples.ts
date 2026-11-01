import { appSettings } from '@/storage/app-settings'
import { writingCommand } from '@/writing-service/client'
import { getLocalLibraryStorage } from '@/storage/local-library'
import type { AuthorExample, StylePassage } from './prose-prompt'

export interface SampleChoice {
  id: string
  title: string
}
interface Pair extends AuthorExample {
  chapterId: number
  updatedAt: number
}
const key = (bid: string) => 'ew-pi-sample-choice:' + bid
export const currentChoice = (bid: string) => appSettings.getItem(key(bid)) || ''
export const examplePreference = (bookId: string) =>
  writingCommand<{ enabled: boolean }>('prose_example_setting', { bookId })
export async function configureExamples(bookId: string, enabled: boolean) {
  await writingCommand('prose_configure_examples', { bookId, enabled })
  window.dispatchEvent(new CustomEvent('ew-prose-example-setting', { detail: { bookId, enabled } }))
}
export function typedByAuthor(event: InputEvent) {
  return (
    event.isTrusted &&
    ([
      'insertText',
      'insertCompositionText',
      'insertLineBreak',
      'insertParagraph',
      'insertFromComposition'
    ].includes(event.inputType) ||
      event.inputType?.startsWith('deleteContent') ||
      event.inputType?.startsWith('deleteWord'))
  )
}
export async function sampleChoices(bookId: string): Promise<SampleChoice[]> {
  const { listWritingResources } = await import('./writing-resources')
  const [options, resources, book] = await Promise.all([
    writingCommand<SampleChoice[]>('prose_sample_options', { bookId }),
    listWritingResources(),
    getLocalLibraryStorage().getLocalBookDetail(bookId)
  ])
  for (const r of resources) {
    if (
      r.enabled &&
      r.kind === 'style' &&
      r.scope === 'public' &&
      r.status === 'recommended' &&
      r.source.rights !== 'link_only' &&
      r.content &&
      book?.category &&
      r.tags.includes(book.category)
    ) {
      options.push({ id: 'resource/' + r.id, title: '同类范文《' + r.title + '》' })
    }
  }
  return options
}
export async function setSampleChoice(bid: string, choice: string) {
  if (choice !== 'direct' && choice !== '' && !(await sampleChoices(bid)).some(s => s.id === choice))
    throw Error('所选范文已不可用')
  appSettings.setItem(key(bid), choice)
}
/** 用原文的相邻字匹配相近表达。仅用于从已授权的真实改例中排序。 */
function grams(text: string) {
  const chars = Array.from(text.replace(/\s/gu, ''))
  return new Set(chars.slice(1).map((c, i) => chars[i] + c))
}
export function rankPairs(rows: Pair[], text: string, matchingOnly = false): Pair[] {
  const query = grams(text)
  const score = (p: Pair) => {
    const from = grams(p.before),
      after = grams(p.after)
    let overlap = 0,
      changedOverlap = 0,
      removed = 0
    for (const t of from) {
      const edited = !after.has(t)
      if (edited) removed++
      if (query.has(t)) {
        overlap++
        if (edited) changedOverlap++
      }
    }
    // 作者实际删改的表达比共有的人名、物名更有参考价值。
    return (
      (overlap / Math.sqrt(Math.max(1, from.size)) + (2 * changedOverlap) / Math.sqrt(Math.max(1, removed))) /
      Math.sqrt(Math.max(1, query.size))
    )
  }
  const seen = new Set<string>()
  return rows
    .filter(p => {
      const key = p.before + '\u0000' + p.after
      if (seen.has(key) || p.before === text || p.after === text) return false
      seen.add(key)
      return true
    })
    .map(p => ({ p, score: score(p) }))
    .filter(candidate => !matchingOnly || candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.p.updatedAt - a.p.updatedAt || a.p.id.localeCompare(b.p.id))
    .map(x => x.p)
}
export async function bookExamples(
  bookId: string,
  chapterNo: number | undefined,
  query: string,
  matchingOnly = false
) {
  const pairs = await writingCommand<Pair[]>('prose_examples', { bookId })
  if (!pairs.length) return [] as Pair[]
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  const before = new Set(
    tree
      .flatMap(v => v.children)
      .slice(0, chapterNo === undefined ? undefined : Math.max(0, chapterNo - 1))
      .map(c => Number(c.id))
  )
  return rankPairs(
    pairs.filter(p => before.has(p.chapterId)),
    query,
    matchingOnly
  )
}
export const personalPassages = (bookId: string, chapterNo?: number, query = '') =>
  writingCommand<StylePassage[]>('prose_personal_passages', {
    bookId,
    precedingChapters: chapterNo === undefined ? undefined : Math.max(0, chapterNo - 1),
    query
  })
export async function chosenPassages(bid: string): Promise<StylePassage[]> {
  const choice = currentChoice(bid)
  if (!choice || choice === 'direct') return []
  if (!(await sampleChoices(bid)).some(s => s.id === choice))
    throw Error('所选范文已不可用，请在作品写作设置重新选择')
  if (choice.startsWith('book/')) {
    const rows = await bookExamples(choice.slice(5), undefined, '')
    const passages = [
      ...rows.map(p => ({ id: p.id, from: choice, text: p.after })),
      ...(await personalPassages(choice.slice(5)))
    ]
    if (!passages.length) throw Error('所选作品没有可用范文，请重新选择')
    return passages.map(p => ({ ...p, external: true }))
  }
  if (choice.startsWith('resource/')) {
    const { getWritingResourceRecord } = await import('./writing-resources')
    const r = (await getWritingResourceRecord(choice.slice(9)))?.current
    if (!r?.enabled || r.source.rights === 'link_only') throw Error('范文已停用')
    return [{ id: r.id + ':' + r.materialVersion, from: r.title, text: r.content, external: true }]
  }
  const rows = await writingCommand<StylePassage[]>('prose_reference_samples', { bookId: bid, choice })
  if (!rows.length) throw Error('所选参考书没有可读样本，请在作品写作设置重新选择')
  return rows
}
