import { getCharacterNames } from '@/utils/character-aliases'
import { computed, ref, watch, type Ref } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { ElMessage } from 'element-plus'
import { useWritingEditorStore } from '@/stores/writing-editor'
import {
  buildEntityHighlightGroups,
  type EntityHighlightGroup,
  type EntityHighlightItem,
  type EntityHighlightKind,
} from '../extends/EntityHighlightExtension'

interface EntityHighlightsOptions {
  editor: Ref<Editor | undefined>
  /** 父级传入的实体清单（角色/设定自动匹配结果） */
  entityHighlights: () => EntityHighlightItem[] | undefined
  bookId: () => string | number | undefined
}

/**
 * 正文实体高亮（角色/设定自动关联）+ 悬浮卡：
 * 按书应用「取消关联」黑名单过滤，悬浮卡贴词条定位、上下自适应，
 * 移出 120ms 延迟收起（给鼠标移入卡片留通道）。
 */
export const useEntityHighlights = (options: EntityHighlightsOptions) => {
  const { editor, entityHighlights, bookId } = options
  const editorStore = useWritingEditorStore()

  const normalizeEntityHighlightKey = (value?: string) =>
    String(value || '').trim()
  const entityHighlightBookKey = computed(() => String(bookId() || 'global'))
  const dismissedEntityHighlightKeys = computed(
    () =>
      editorStore.dismissedEntityHighlightKeysByBook[
        entityHighlightBookKey.value
      ] || [],
  )
  const visibleEntityHighlights = computed(() => {
    if (!editorStore.entityHighlightEnabled) return []
    if (!dismissedEntityHighlightKeys.value.length)
      return entityHighlights() || []
    const dismissedKeys = new Set(dismissedEntityHighlightKeys.value)
    return (entityHighlights() || []).flatMap(item => {
      const names = getCharacterNames(item).filter(name => !dismissedKeys.has(normalizeEntityHighlightKey(name)))
      // 保留角色正式姓名用于展示；忽略的称呼通过分组过滤，不改写角色身份。
      return names.length ? [{ ...item, matchNames: names }] : []
    })
  })
  const entityGroups = computed(() =>
    buildEntityHighlightGroups(visibleEntityHighlights.value),
  )
  const entityGroupMap = computed(
    () => new Map(entityGroups.value.map((group) => [group.key, group])),
  )
  const entityHoverKey = ref('')
  const entityHoverVisible = ref(false)
  const entityHoverPlacement = ref<'top' | 'bottom'>('bottom')
  const entityHoverPosition = ref({ top: 0, left: 0 })
  let entityHoverTimer: number | null = null

  const activeEntityGroup = computed<EntityHighlightGroup | null>(() => {
    if (!entityHoverKey.value) return null
    return entityGroupMap.value.get(entityHoverKey.value) || null
  })

  const activeEntityItems = computed(
    () => activeEntityGroup.value?.items || [],
  )

  const entityHoverStyle = computed(() => ({
    top: `${entityHoverPosition.value.top}px`,
    left: `${entityHoverPosition.value.left}px`,
    transform:
      entityHoverPlacement.value === 'top' ? 'translateY(-100%)' : 'none',
  }))

  const getEntityKindText = (kind: EntityHighlightKind) =>
    kind === 'character' ? '角色' : '设定'

  const clearEntityHoverTimer = () => {
    if (entityHoverTimer) {
      window.clearTimeout(entityHoverTimer)
      entityHoverTimer = null
    }
  }

  const hideEntityHover = () => {
    clearEntityHoverTimer()
    entityHoverVisible.value = false
    entityHoverKey.value = ''
  }

  const keepEntityHover = () => {
    clearEntityHoverTimer()
  }

  const scheduleHideEntityHover = () => {
    clearEntityHoverTimer()
    entityHoverTimer = window.setTimeout(() => {
      hideEntityHover()
    }, 120)
  }

  const applyEntityHighlights = () => {
    if (!editor.value) return
    const entities = visibleEntityHighlights.value
    if (entities.length) {
      editor.value.commands.setEntityHighlights(entities)
    } else {
      editor.value.commands.clearEntityHighlights()
    }
    if (entityHoverKey.value && !entityGroupMap.value.has(entityHoverKey.value)) {
      hideEntityHover()
    }
  }

  const dismissActiveEntityGroup = () => {
    const group = activeEntityGroup.value
    if (!group) return
    // 自动匹配没有独立绑定记录，取消时只隐藏当前作品里的这组关联提示。
    editorStore.dismissEntityHighlight(entityHighlightBookKey.value, group.key)
    applyEntityHighlights()
    hideEntityHover()
    ElMessage.success('已取消本次关联显示')
  }

  const getEntityTarget = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null
    return target?.closest?.('.entity-highlight') as HTMLElement | null
  }

  const showEntityHover = (target: HTMLElement) => {
    const key = target.dataset.entityKey || ''
    if (!key || !entityGroupMap.value.has(key)) {
      hideEntityHover()
      return
    }

    const rect = target.getBoundingClientRect()
    const cardWidth = 320
    const gap = 10
    const viewportPadding = 12
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - cardWidth - viewportPadding,
    )
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - cardWidth / 2, viewportPadding),
      maxLeft,
    )
    const bottomTop = rect.bottom + gap
    const useTop = bottomTop + 180 > window.innerHeight && rect.top > 180

    clearEntityHoverTimer()
    entityHoverKey.value = key
    entityHoverPlacement.value = useTop ? 'top' : 'bottom'
    entityHoverPosition.value = {
      left,
      top: useTop ? rect.top - gap : bottomTop,
    }
    entityHoverVisible.value = true
  }

  const handleEntityMouseOver = (event: MouseEvent) => {
    const target = getEntityTarget(event)
    if (!target) return
    showEntityHover(target)
  }

  const handleEntityMouseOut = (event: MouseEvent) => {
    const target = getEntityTarget(event)
    if (!target) return
    const related = event.relatedTarget as Node | null
    if (related && target.contains(related)) return
    scheduleHideEntityHover()
  }

  watch(
    () => [visibleEntityHighlights.value, bookId()] as const,
    () => {
      applyEntityHighlights()
    },
    { deep: true },
  )

  watch(
    () => bookId(),
    () => {
      hideEntityHover()
      applyEntityHighlights()
    },
  )

  return {
    visibleEntityHighlights,
    entityHoverVisible,
    entityHoverStyle,
    activeEntityGroup,
    activeEntityItems,
    getEntityKindText,
    clearEntityHoverTimer,
    hideEntityHover,
    keepEntityHover,
    scheduleHideEntityHover,
    applyEntityHighlights,
    dismissActiveEntityGroup,
    handleEntityMouseOver,
    handleEntityMouseOut,
  }
}
