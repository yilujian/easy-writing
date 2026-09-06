import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { getLocalLibraryStorage, getLocalBookExportPayload, previewLocalBookImport, importLocalBookFromPreview } from '@/storage/local-library'
import { getWritingStorage } from '@/storage'

describe('Local book backup and copy restore', () => {
  it('exports persisted chapter content and restores into a different book without changing the original', async () => {
    const library = getLocalLibraryStorage()
    const book = await library.createLocalBook({ title: '原稿测试' })
    const tree = await library.getLocalBookTree(book.id)
    const volume = tree[0] || await library.createLocalVolume({ bookId: book.id, title: '第一卷', sortNo: 1 })
    const chapter = await library.createLocalChapter({ bookId: book.id, volumeId: volume.id, title: '第一章 风起', sortNo: 1 })
    const content = '测试正文，夜风掠过山岗。'
    await getWritingStorage().saveChapterLocal({ userId: 'guest', bookId: String(book.id), chapterId: chapter.id, title: chapter.title, textContent: content, contentJson: null, localVersion: 1, remoteVersion: 0, baseRemoteVersion: 0, baseTitle: chapter.title, baseTextContent: '', baseContentJson: null, dirty: true, conflict: false, localOnly: true, updatedAt: Date.now() })
    const payload = await getLocalBookExportPayload(book.id)
    expect(payload.chapters.find(c => c.id === chapter.id)?.textContent).toBe(content)
    const file = new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' })
    const preview = await previewLocalBookImport(file)
    const restored = await importLocalBookFromPreview(preview, { title: '恢复副本' })
    expect(restored.bookId).not.toBe(book.id)
    const after = await getLocalBookExportPayload(restored.bookId)
    expect(after.chapters.some(c => c.textContent === content)).toBe(true)
    expect((await getLocalBookExportPayload(book.id)).chapters.find(c => c.id === chapter.id)?.textContent).toBe(content)
  })
})
