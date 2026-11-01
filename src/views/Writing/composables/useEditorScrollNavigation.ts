import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

interface ScrollNavigationOptions {
  scrollElement: Ref<HTMLElement | null>
  contentElement: Ref<HTMLElement | null>
  active: Ref<boolean>
  chapterKey: Ref<string | number | null | undefined>
}

export function editorScrollState(top: number, height: number, viewport: number) {
  const maximum = Math.max(0, height - viewport)
  const position = Math.max(0, Math.min(top, maximum))
  return {
    away: maximum > 8 && position > Math.min(120, viewport * 0.25),
    bottom: maximum > 8 && position > 4 && maximum - position <= 4
  }
}

/** 每帧只读取滚动容器的三个数值；不监听正文 Mutation，不扫描段落或序列化编辑器。 */
export function useEditorScrollNavigation(options: ScrollNavigationOptions) {
  const away = ref(false),
    bottom = ref(false),
    scrolling = ref(false)
  const hovered = ref(false),
    focused = ref(false)
  let frame = 0,
    idleTimer = 0,
    disposed = false
  let cleanup: (() => void) | undefined
  const visible = computed(
    () =>
      options.active.value &&
      (bottom.value || (away.value && (scrolling.value || hovered.value || focused.value)))
  )

  const measure = () => {
    frame = 0
    if (disposed) return
    const element = options.scrollElement.value
    const state =
      element && options.active.value
        ? editorScrollState(element.scrollTop, element.scrollHeight, element.clientHeight)
        : { away: false, bottom: false }
    away.value = state.away
    bottom.value = state.bottom
  }
  const scheduleMeasure = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(measure)
  }
  const onScroll = () => {
    if (!options.active.value) return
    scrolling.value = true
    clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
      scrolling.value = false
    }, 1600)
    scheduleMeasure()
  }
  const reset = () => {
    clearTimeout(idleTimer)
    scrolling.value = false
    hovered.value = false
    focused.value = false
    away.value = false
    bottom.value = false
    scheduleMeasure()
  }

  watch(
    [options.scrollElement, options.contentElement],
    ([element, content]) => {
      cleanup?.()
      reset()
      if (!element) return
      element.addEventListener('scroll', onScroll, { passive: true })
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null
      observer?.observe(element)
      if (content) observer?.observe(content)
      cleanup = () => {
        element.removeEventListener('scroll', onScroll)
        observer?.disconnect()
      }
    },
    { immediate: true, flush: 'post' }
  )
  watch([options.active, options.chapterKey], reset, { flush: 'post' })
  watch(visible, shown => {
    // DOM 移除不保证触发 mouseleave/blur，回顶后不能遗留“悬停”让下次滚动常驻。
    if (!shown) {
      hovered.value = false
      focused.value = false
    }
  })

  function scrollToTop() {
    const element = options.scrollElement.value
    if (!element || !options.active.value) return
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    // 只为这次明确操作开启平滑滚动，打字、查找定位和双向预览同步仍即时执行。
    element.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
  }

  onBeforeUnmount(() => {
    disposed = true
    cleanup?.()
    clearTimeout(idleTimer)
    if (frame) cancelAnimationFrame(frame)
  })
  return { visible, hovered, focused, scrollToTop }
}
