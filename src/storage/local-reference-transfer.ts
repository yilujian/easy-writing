import { LOCAL_USER_ID } from './local-library-utils'
import {
  bookKey,
  mutateDoc,
  nextLocalId,
  ok,
  readDoc,
  type BookReferenceDoc,
} from './local-reference-store'

/**
 * 参考数据的备份迁移：挂在书籍 JSON 备份（LocalExportPayload.reference）里随书导出导入。
 */

/** 书籍 JSON 备份里的参考数据块：与存储 doc 同形状，仅去掉信封字段 */
export type BookReferenceExport = Omit<BookReferenceDoc, 'version' | 'bookId' | 'updatedAt'>

/** 导出整包参考数据；全空时返回 null（备份文件里不带空块） */
export const exportLocalBookReference = async (bookId: string | number): Promise<BookReferenceExport | null> => {
  const { version: _v, bookId: _b, updatedAt: _u, ...data } = await readDoc(bookId)
  const hasAny = Object.values(data).some(list => Array.isArray(list) && list.length)
  return hasAny ? data : null
}

/** 预览提示用的分类计数（只列非空项） */
export const summarizeBookReference = (data: BookReferenceExport): string => {
  const parts: string[] = []
  const push = (label: string, count: number | undefined) => {
    if (count) parts.push(`${label} ${count}`)
  }
  push('大纲', data.outlineNodes?.filter(node => node.nodeType === 1).length)
  push('角色', data.characters?.length)
  push('常用词', data.commonWords?.length)
  push('角色关系', data.characterRelations?.length)
  push('设定', data.worldSettings?.length)
  push('时间线事件', data.timelineEvents?.length)
  push('故事线', data.storylines?.length)
  push('故事节点', data.storylineNodes?.length)
  return parts.join(' / ')
}

/**
 * 把备份里的参考数据写入新书。所有实体分配全新本地 ID 并重写交叉引用——
 * 备份里的旧 ID 不能复用：同一份备份导两次会撞号，按 id 反查所属书就会串书。
 * chapterIdMap：旧章节 id → 新章节 id（章节引用跟着正文导入的新章节走）。
 * 映射不到的引用按语义降级：挂根/清空/丢弃整条，不让悬空 id 进库。
 */
export const importLocalBookReference = async (
  bookId: string | number,
  data: BookReferenceExport,
  chapterIdMap: Map<string, string>,
) => {
  const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : [])

  // 第一遍：全部实体分配新 ID
  const entityId = new Map<string, number>()
  const assign = (items: Array<{ id: number }>) => {
    for (const item of items) entityId.set(String(item.id), nextLocalId())
  }
  assign(list(data.outlineNodes))
  assign(list(data.characterGroups))
  assign(list(data.characters))
  assign(list(data.worldSettingGroups))
  assign(list(data.worldSettings))
  assign(list(data.storylines))
  assign(list(data.timelineEvents))
  assign(list(data.storylineNodes))
  assign(list(data.plotBindings))

  // 第二遍：重写引用
  const newId = (oldId: number) => entityId.get(String(oldId))!
  const mapEntity = (value: string | number | null | undefined): string | null => {
    if (value == null || value === '') return null
    const mapped = entityId.get(String(value))
    return mapped != null ? String(mapped) : null
  }
  const mapEntityIds = (values: string[] | undefined): string[] =>
    list(values).map(item => mapEntity(item)).filter((item): item is string => item != null)
  const mapChapter = (value: string | number | null | undefined): string | null => {
    if (value == null || value === '') return null
    return chapterIdMap.get(String(value)) ?? null
  }
  const mapChapterIds = (values: string[] | undefined): string[] =>
    list(values).map(item => mapChapter(item)).filter((item): item is string => item != null)

  const bookKeyText = bookKey(bookId)
  const rebased = <T extends { id: number }>(item: T): T => ({
    ...item,
    id: newId(item.id),
    bookId: bookKeyText,
    userId: LOCAL_USER_ID,
  })

  return mutateDoc(bookId, doc => {
    doc.commonWords.push(...list(data.commonWords).map(word => ({ ...word, id: nextLocalId() })))
    doc.outlineNodes.push(...list(data.outlineNodes).map(node => ({
      ...rebased(node),
      // 父级映射不到（备份里就悬空）则挂根，条目不丢
      parentId: mapEntity(node.parentId) ?? '0',
    })))
    doc.characterGroups.push(...list(data.characterGroups).map(rebased))
    doc.characters.push(...list(data.characters).map(character => ({
      ...rebased(character),
      groupId: mapEntity(character.groupId),
    })))
    // 角色关系：两端角色都映射到了才保留（同 storylineNodeRelations 的丢弃语义）
    doc.characterRelations.push(...list(data.characterRelations).flatMap(relation => {
      const fromId = entityId.get(String(relation.fromId))
      const toId = entityId.get(String(relation.toId))
      if (fromId == null || toId == null) return []
      return [{ ...relation, id: nextLocalId(), bookId: bookKeyText, fromId, toId }]
    }))
    // 画布位置：键按角色新 id 重写，映射不到的键丢弃
    for (const [oldId, position] of Object.entries(data.characterCanvasPositions || {})) {
      const mapped = entityId.get(String(oldId))
      if (mapped != null && position) doc.characterCanvasPositions[String(mapped)] = { ...position }
    }
    doc.worldSettingGroups.push(...list(data.worldSettingGroups).map(rebased))
    doc.worldSettings.push(...list(data.worldSettings).map(setting => ({
      ...rebased(setting),
      groupId: mapEntity(setting.groupId),
      relatedChapterIds: mapChapterIds(setting.relatedChapterIds),
    })))
    doc.storylines.push(...list(data.storylines).map(storyline => ({
      ...rebased(storyline),
      firstChapterId: mapChapter(storyline.firstChapterId),
      revealChapterId: mapChapter(storyline.revealChapterId),
      keyCharacterIds: mapEntityIds(storyline.keyCharacterIds),
    })))
    doc.timelineEvents.push(...list(data.timelineEvents).map(event => ({
      ...rebased(event),
      storylineId: mapEntity(event.storylineId),
      chapterId: mapChapter(event.chapterId),
      characterIds: mapEntityIds(event.characterIds),
      settingIds: mapEntityIds(event.settingIds),
      relatedEventIds: mapEntityIds(event.relatedEventIds),
    })))
    doc.storylineNodes.push(...list(data.storylineNodes).map(node => ({
      ...rebased(node),
      storylineId: mapEntity(node.storylineId) ?? '',
      chapterIds: mapChapterIds(node.chapterIds),
      characterIds: mapEntityIds(node.characterIds),
      settingIds: mapEntityIds(node.settingIds),
      predecessorNodeIds: mapEntityIds(node.predecessorNodeIds),
      successorNodeIds: mapEntityIds(node.successorNodeIds),
    })))
    // 关系与锚点：宿主映射不到就丢弃整条，不留悬空引用
    doc.storylineNodeRelations.push(...list(data.storylineNodeRelations).flatMap(relation => {
      const fromNodeId = mapEntity(relation.fromNodeId)
      const toNodeId = mapEntity(relation.toNodeId)
      if (fromNodeId == null || toNodeId == null) return []
      return [{ ...relation, id: nextLocalId(), userId: LOCAL_USER_ID, bookId: bookKeyText, fromNodeId, toNodeId }]
    }))
    doc.storylineRelations.push(...list(data.storylineRelations).flatMap(relation => {
      const fromStorylineId = mapEntity(relation.fromStorylineId)
      const toStorylineId = mapEntity(relation.toStorylineId)
      if (fromStorylineId == null || toStorylineId == null) return []
      return [{ ...relation, id: nextLocalId(), userId: LOCAL_USER_ID, bookId: bookKeyText, fromStorylineId, toStorylineId }]
    }))
    doc.plotBindings.push(...list(data.plotBindings)
      .map(binding => ({
        ...rebased(binding),
        storylineNodeId: mapEntity(binding.storylineNodeId),
        timelineEventId: mapEntity(binding.timelineEventId),
        chapterId: mapChapter(binding.chapterId),
      }))
      .filter(binding => binding.storylineNodeId != null || binding.timelineEventId != null))
    return ok(null)
  })
}
