import { getCharacterNames, isCharacterNameBoundary } from '@/utils/character-aliases'
import { Extension } from '@tiptap/core'
import { Node } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export type EntityHighlightKind = 'character' | 'setting'

export interface EntityHighlightItem {
  id: number | string
  kind: EntityHighlightKind
  name: string
  aliases?: string[]
  /** 仅用于展示过滤，角色正式姓名始终保留。 */
  matchNames?: string[]
  label?: string
  summary?: string
}

export interface EntityHighlightGroup {
  key: string
  name: string
  items: EntityHighlightItem[]
}

interface EntityHighlightState {
  groups: EntityHighlightGroup[]
  matcher: RegExp | null
  deco: DecorationSet
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    entityHighlight: {
      setEntityHighlights: (entities: EntityHighlightItem[]) => ReturnType
      clearEntityHighlights: () => ReturnType
    }
  }
}

const META_KEY = 'ENTITY_HIGHLIGHTS'
const pluginKey = new PluginKey<EntityHighlightState>('entityHighlight')

const normalizeName = (value: string) => String(value || '').trim()

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getPrimaryKind = (group: EntityHighlightGroup) =>
  group.items.some(item => item.kind === 'character') ? 'character' : 'setting'

export const buildEntityHighlightGroups = (entities: EntityHighlightItem[]) => {
  const map = new Map<string, EntityHighlightGroup>()
  entities.forEach(item => {
    for (const name of item.matchNames || getCharacterNames(item)) {
      if (!name.replace(/\s+/g, '')) continue
      const group = map.get(name)
      const identity = { ...item, name: normalizeName(item.name) }
      if (group) {
        if (!group.items.some(candidate => candidate.kind === item.kind && String(candidate.id) === String(item.id))) group.items.push(identity)
      } else {
        map.set(name, { key: name, name, items: [identity] })
      }
    }
  })
  return Array.from(map.values())
    .map(group => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'character' ? -1 : 1
        return String(a.id).localeCompare(String(b.id), 'zh-Hans-CN')
      })
    }))
    .sort((a, b) => {
      if (b.name.length !== a.name.length) return b.name.length - a.name.length
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
}

const buildMatcher = (groups: EntityHighlightGroup[]) => {
  if (!groups.length) return null
  return new RegExp(groups.map(group => escapeRegExp(group.name)).join('|'), 'g')
}

function buildDecorations(doc: Node, groups: EntityHighlightGroup[], matcher: RegExp | null) {
  if (!matcher || !groups.length) return DecorationSet.empty
  const groupMap = new Map(groups.map(group => [group.name, group]))
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    matcher.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = matcher.exec(node.text))) {
      if (!isCharacterNameBoundary(node.text, match[0], match.index)) continue
      const group = groupMap.get(match[0])
      if (!group) continue
      const kind = getPrimaryKind(group)
      decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
        class: `entity-highlight entity-highlight-${kind}`,
        'data-entity-key': group.key,
        'data-entity-kind': kind
      }))
      if (matcher.lastIndex === match.index) matcher.lastIndex += 1
    }
  })

  return DecorationSet.create(doc, decorations)
}

const createState = (doc: Node, entities: EntityHighlightItem[] = []): EntityHighlightState => {
  const groups = buildEntityHighlightGroups(entities)
  const matcher = buildMatcher(groups)
  return {
    groups,
    matcher,
    deco: buildDecorations(doc, groups, matcher)
  }
}

export default Extension.create({
  name: 'entityHighlight',

  addCommands() {
    return {
      setEntityHighlights: (entities: EntityHighlightItem[]) => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(META_KEY, entities)
        return true
      },
      clearEntityHighlights: () => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(META_KEY, [])
        return true
      }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<EntityHighlightState>({
        key: pluginKey,
        state: {
          init(_, state) {
            return createState(state.doc)
          },
          apply(tr, prev, _oldState, newState) {
            const nextEntities = tr.getMeta(META_KEY) as EntityHighlightItem[] | undefined
            if (nextEntities !== undefined) {
              return createState(newState.doc, nextEntities)
            }
            if (tr.docChanged) {
              return {
                ...prev,
                deco: buildDecorations(newState.doc, prev.groups, prev.matcher)
              }
            }
            return prev
          }
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state)?.deco || DecorationSet.empty
          }
        }
      })
    ]
  }
})
