import { normalizeCharacterAliases } from '@/utils/character-aliases'
import type {
  Character,
  CharacterGroup,
  OutlineNode,
  ResPage,
  WorldSetting,
  WorldSettingGroup,
  WorldSettingTreeFolder,
} from '@/types'
import { getWritingStorage } from './index'
import { getLocalLibraryStorage, LOCAL_USER_ID } from './local-library'
import {
  applyDefined,
  bySortNo,
  findBookIdByEntity,
  idSet,
  mutateDoc,
  nextLocalId,
  ok,
  readDoc,
} from './local-reference-store'

/**
 * 参考面板本地库·书域（大纲/角色/设定）：替代旧服务端
 * /writing/outline、/writing/character*、/writing/world_setting 数据通道。
 *
 * - 函数返回值保留服务端接口的 { data } 信封形状，面板只换 import，调用点不动。
 * - 更新语义镜像 JSON 传输：undefined 字段=不修改，null=清空。
 * - 实体 ID 与本地书库同规约（createLocalEntityId 负数 ID）。
 * 剧情域（时间线/故事线/锚点）见 local-reference-plot.ts。
 */

// ---------------------------------------------------------------------------
// 大纲（扁平存储，parentId 关联；'0' 为根）
// ---------------------------------------------------------------------------

const buildOutlineTree = (nodes: OutlineNode[]): OutlineNode[] => {
  const byId = new Map(nodes.map(node => [String(node.id), { ...node, children: [] as OutlineNode[] }]))
  const roots: OutlineNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId && node.parentId !== '0' ? byId.get(String(node.parentId)) : null
    if (parent && parent.nodeType === 0) {
      parent.children!.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortTree = (list: OutlineNode[]) => {
    list.sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || a.id - b.id)
    list.forEach(node => node.children?.length && sortTree(node.children))
  }
  sortTree(roots)
  return roots
}

export const getLocalOutlineTree = async (params: { bookId: string | number }) => {
  const doc = await readDoc(params.bookId)
  return ok(buildOutlineTree(doc.outlineNodes))
}

export const addLocalOutlineNode = async (payload: Partial<OutlineNode>) => {
  if (payload.bookId === undefined) throw new Error('缺少 bookId')
  return mutateDoc(payload.bookId, doc => {
    const node: OutlineNode = {
      id: nextLocalId(),
      bookId: String(payload.bookId),
      parentId: String(payload.parentId ?? '0'),
      nodeType: payload.nodeType ?? 1,
      title: payload.title ?? '',
      content: payload.content ?? '',
      sortNo: payload.sortNo ?? doc.outlineNodes.length + 1,
    }
    doc.outlineNodes.push(node)
    return ok(node)
  })
}

export const updateLocalOutlineNode = async (payload: Partial<OutlineNode> & { id?: number }) => {
  if (payload.id === undefined) throw new Error('缺少大纲节点 id')
  const bookId = await findBookIdByEntity(payload.id, doc => doc.outlineNodes)
  return mutateDoc(bookId, doc => {
    const node = doc.outlineNodes.find(item => item.id === payload.id)
    if (!node) throw new Error('大纲节点不存在')
    const { id: _id, bookId: _bookId, children: _children, ...fields } = payload
    applyDefined(node, fields)
    return ok(node)
  })
}

export const deleteLocalOutlineNodes = async (payload: { ids: number[] }) => {
  const bookId = await findBookIdByEntity(payload.ids[0], doc => doc.outlineNodes)
  return mutateDoc(bookId, doc => {
    // 级联：删文件夹时其子孙一并删除
    const doomed = idSet(payload.ids)
    let grew = true
    while (grew) {
      grew = false
      for (const node of doc.outlineNodes) {
        if (!doomed.has(String(node.id)) && doomed.has(String(node.parentId))) {
          doomed.add(String(node.id))
          grew = true
        }
      }
    }
    doc.outlineNodes = doc.outlineNodes.filter(node => !doomed.has(String(node.id)))
    return ok(null)
  })
}

// ---------------------------------------------------------------------------
// 角色与分组
// ---------------------------------------------------------------------------

export const listLocalCharacters = async (
  params: { bookId: string | number; page?: number; size?: number; keyWord?: string },
  _opts?: Record<string, unknown>
) => {
  // 本地不分页，一次全量返回（面板取前 500 条的语义在本地不构成截断）
  const doc = await readDoc(params.bookId)
  const list = bySortNo(doc.characters)
  const page: ResPage<Character> = {
    list,
    pagination: { total: list.length, page: 1, size: list.length },
  }
  return ok(page)
}

export const addLocalCharacter = async (payload: Partial<Character>) => {
  if (payload.bookId === undefined) throw new Error('缺少 bookId')
  return mutateDoc(payload.bookId, doc => {
    const character: Character = {
      id: nextLocalId(),
      bookId: String(payload.bookId),
      groupId: payload.groupId ?? null,
      name: payload.name ?? '',
      aliases: normalizeCharacterAliases(payload.name ?? '', payload.aliases),
      role: payload.role ?? 0,
      gender: payload.gender ?? 0,
      age: payload.age ?? '',
      avatar: payload.avatar ?? '',
      tags: payload.tags ?? [],
      appearance: payload.appearance ?? '',
      personality: payload.personality ?? '',
      background: payload.background ?? '',
      ability: payload.ability ?? '',
      relationships: payload.relationships ?? null,
      sortNo: payload.sortNo ?? doc.characters.length + 1,
    }
    doc.characters.push(character)
    return ok(character)
  })
}

export const updateLocalCharacter = async (payload: Partial<Character> & { id?: number }) => {
  if (payload.id === undefined) throw new Error('缺少角色 id')
  const bookId = await findBookIdByEntity(payload.id, doc => doc.characters)
  return mutateDoc(bookId, doc => {
    const character = doc.characters.find(item => item.id === payload.id)
    if (!character) throw new Error('角色不存在')
    const { id: _id, bookId: _bookId, ...fields } = payload
    applyDefined(character, fields)
    character.aliases = normalizeCharacterAliases(character.name, character.aliases)
    return ok(character)
  })
}

export const deleteLocalCharacters = async (payload: { ids: number[] }) => {
  const bookId = await findBookIdByEntity(payload.ids[0], doc => doc.characters)
  return mutateDoc(bookId, doc => {
    const doomed = idSet(payload.ids)
    doc.characters = doc.characters.filter(item => !doomed.has(String(item.id)))
    // 关系画布级联：删角色时把它的连线和画布位置一并清掉，不留悬空引用
    doc.characterRelations = doc.characterRelations.filter(
      item => !doomed.has(String(item.fromId)) && !doomed.has(String(item.toId))
    )
    for (const id of doomed) delete doc.characterCanvasPositions[id]
    return ok(null)
  })
}

export const listLocalCharacterGroups = async (bookId: string | number) => {
  const doc = await readDoc(bookId)
  return ok(bySortNo(doc.characterGroups))
}

export const addLocalCharacterGroup = async (payload: Partial<CharacterGroup>) => {
  if (payload.bookId === undefined) throw new Error('缺少 bookId')
  return mutateDoc(payload.bookId, doc => {
    const group: CharacterGroup = {
      id: nextLocalId(),
      bookId: String(payload.bookId),
      title: payload.title ?? '新建分组',
      sortNo: payload.sortNo ?? doc.characterGroups.length + 1,
    }
    doc.characterGroups.push(group)
    return ok(group)
  })
}

export const updateLocalCharacterGroup = async (payload: Partial<CharacterGroup> & { id?: number }) => {
  if (payload.id === undefined) throw new Error('缺少分组 id')
  const bookId = await findBookIdByEntity(payload.id, doc => doc.characterGroups)
  return mutateDoc(bookId, doc => {
    const group = doc.characterGroups.find(item => item.id === payload.id)
    if (!group) throw new Error('角色分组不存在')
    const { id: _id, bookId: _bookId, ...fields } = payload
    applyDefined(group, fields)
    return ok(group)
  })
}

export const deleteLocalCharacterGroups = async (payload: { ids: number[] }) => {
  const bookId = await findBookIdByEntity(payload.ids[0], doc => doc.characterGroups)
  return mutateDoc(bookId, doc => {
    const doomed = idSet(payload.ids)
    doc.characterGroups = doc.characterGroups.filter(item => !doomed.has(String(item.id)))
    // 组内角色移至未分组
    for (const character of doc.characters) {
      if (character.groupId != null && doomed.has(String(character.groupId))) {
        character.groupId = null
      }
    }
    return ok(null)
  })
}

// ---------------------------------------------------------------------------
// 世界观设定与分组
// ---------------------------------------------------------------------------

export const getLocalWorldSettingTree = async (
  params: { bookId: string | number },
  _opts?: Record<string, unknown>
) => {
  const doc = await readDoc(params.bookId)
  const folders: WorldSettingTreeFolder[] = bySortNo(doc.worldSettingGroups).map(group => ({
    id: group.id,
    title: group.title,
    children: bySortNo(doc.worldSettings.filter(item => String(item.groupId ?? '') === String(group.id))),
  }))
  const groupIds = idSet(doc.worldSettingGroups.map(group => group.id))
  const ungrouped = bySortNo(
    doc.worldSettings.filter(item => item.groupId == null || !groupIds.has(String(item.groupId)))
  )
  if (ungrouped.length) {
    folders.push({ id: 'virtual-ungrouped', title: '未分组', isVirtual: true, children: ungrouped })
  }
  return ok(folders)
}

export const addLocalWorldSetting = async (payload: Partial<WorldSetting>) => {
  if (payload.bookId === undefined) throw new Error('缺少 bookId')
  return mutateDoc(payload.bookId, doc => {
    const setting: WorldSetting = {
      id: nextLocalId(),
      bookId: String(payload.bookId),
      groupId: payload.groupId ?? null,
      name: payload.name ?? '',
      type: payload.type ?? 5,
      detail: payload.detail ?? '',
      imageUrl: payload.imageUrl ?? '',
      relatedChapterIds: payload.relatedChapterIds ?? [],
      sortNo: payload.sortNo ?? doc.worldSettings.length + 1,
    }
    doc.worldSettings.push(setting)
    return ok(setting)
  })
}

export const updateLocalWorldSetting = async (payload: Partial<WorldSetting> & { id?: number }) => {
  if (payload.id === undefined) throw new Error('缺少设定 id')
  const bookId = await findBookIdByEntity(payload.id, doc => doc.worldSettings)
  return mutateDoc(bookId, doc => {
    const setting = doc.worldSettings.find(item => item.id === payload.id)
    if (!setting) throw new Error('设定不存在')
    const { id: _id, bookId: _bookId, ...fields } = payload
    applyDefined(setting, fields)
    return ok(setting)
  })
}

export const deleteLocalWorldSettings = async (payload: { ids: number[] }) => {
  const bookId = await findBookIdByEntity(payload.ids[0], doc => doc.worldSettings)
  return mutateDoc(bookId, doc => {
    const doomed = idSet(payload.ids)
    doc.worldSettings = doc.worldSettings.filter(item => !doomed.has(String(item.id)))
    return ok(null)
  })
}

export const addLocalWorldSettingGroup = async (payload: Partial<WorldSettingGroup>) => {
  if (payload.bookId === undefined) throw new Error('缺少 bookId')
  return mutateDoc(payload.bookId, doc => {
    const group: WorldSettingGroup = {
      id: nextLocalId(),
      bookId: String(payload.bookId),
      title: payload.title ?? '新建分组',
      sortNo: payload.sortNo ?? doc.worldSettingGroups.length + 1,
    }
    doc.worldSettingGroups.push(group)
    return ok(group)
  })
}

export const updateLocalWorldSettingGroup = async (payload: Partial<WorldSettingGroup> & { id?: number }) => {
  if (payload.id === undefined) throw new Error('缺少分组 id')
  const bookId = await findBookIdByEntity(payload.id, doc => doc.worldSettingGroups)
  return mutateDoc(bookId, doc => {
    const group = doc.worldSettingGroups.find(item => item.id === payload.id)
    if (!group) throw new Error('设定分组不存在')
    const { id: _id, bookId: _bookId, ...fields } = payload
    applyDefined(group, fields)
    return ok(group)
  })
}

export const deleteLocalWorldSettingGroups = async (payload: { ids: number[] }) => {
  const bookId = await findBookIdByEntity(payload.ids[0], doc => doc.worldSettingGroups)
  return mutateDoc(bookId, doc => {
    const doomed = idSet(payload.ids)
    doc.worldSettingGroups = doc.worldSettingGroups.filter(item => !doomed.has(String(item.id)))
    // 组内设定移至未分组
    for (const setting of doc.worldSettings) {
      if (setting.groupId != null && doomed.has(String(setting.groupId))) {
        setting.groupId = null
      }
    }
    return ok(null)
  })
}

// ---------------------------------------------------------------------------
// 本地书目录桥接（面板里替代 getBookTreeApi / updateChapterApi）
// ---------------------------------------------------------------------------

export const getLocalBookTreeData = async (params: { bookId: string | number }) => {
  const volumes = await getLocalLibraryStorage().getLocalBookTree(params.bookId)
  return ok(volumes)
}

export const updateLocalChapterSummary = async (payload: { id: number; summary?: string }) => {
  await getLocalLibraryStorage().updateLocalChapter({ id: payload.id, summary: payload.summary })
  return ok(null)
}

/** 读章节正文（替代 getChapterDetailApi；比原接口多要一个 bookId 定位本地存储） */
export const getLocalChapterDetailData = async (params: { bookId: string | number; id: number | string }) => {
  const draft = await getWritingStorage().getChapterByIdentity(
    LOCAL_USER_ID,
    String(params.bookId),
    Number(params.id)
  )
  return ok({ id: Number(params.id), textContent: draft?.textContent || '' })
}
