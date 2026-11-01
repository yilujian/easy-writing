import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { loadImportedFont } from '@/composables/use-imported-fonts'

interface EditorTypographyOptions {
  fontFamily: Ref<string>
  fontBold: Ref<boolean>
  fontSize: Ref<number>
  fontLineHeight: Ref<number>
  contentWidth: Ref<number>
  isParagraphGap: Ref<boolean>
  isFirstLineIndent: Ref<boolean>
  rulerStyle: Ref<'none' | 'solid' | 'dashed'>
  alignMode: Ref<'left' | 'center' | 'justify'>
  fontColor: Ref<string | undefined>
}

/**
 * 编辑器排版度量：用隐藏探针实测行高（字体加载后重测），
 * 产出编辑器区的 CSS 变量与网格线样式。度量 API 一并返回给 WebKit 光标复用。
 */
export const useEditorTypography = (options: EditorTypographyOptions) => {
  const {
    fontFamily,
    fontBold,
    fontSize,
    fontLineHeight,
    contentWidth,
    isParagraphGap,
    isFirstLineIndent,
    rulerStyle,
    alignMode,
    fontColor,
  } = options

  const measuredLineHeightPx = ref<number | null>(null)

  const normalizePixel = (value: number) => {
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    return Math.max(1, Math.round(value * ratio) / ratio)
  }

  const getBaseLineHeightPx = () => {
    const lineH =
      Number(fontLineHeight.value) > 0 ? Number(fontLineHeight.value) : 1.8
    const fontPx = Number(fontSize.value) > 0 ? Number(fontSize.value) : 16
    const value = lineH * fontPx
    return normalizePixel(Number.isFinite(value) && value > 0 ? value : 28)
  }

  const measureEditorLineHeight = () => {
    if (typeof document === 'undefined') return

    const probe = document.createElement('div')
    probe.textContent = '易\n创'
    probe.style.position = 'fixed'
    probe.style.left = '-9999px'
    probe.style.top = '0'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    probe.style.whiteSpace = 'pre'
    probe.style.fontSize = `${fontSize.value}px`
    probe.style.lineHeight = String(
      Number(fontLineHeight.value) > 0 ? fontLineHeight.value : 1.8,
    )
    probe.style.fontWeight = fontBold.value ? '700' : '400'
    probe.style.fontFamily = fontFamily.value
    document.body.appendChild(probe)

    const height = probe.getBoundingClientRect().height / 2
    document.body.removeChild(probe)

    measuredLineHeightPx.value = normalizePixel(
      Number.isFinite(height) && height > 0 ? height : getBaseLineHeightPx(),
    )
  }

  const scheduleLineHeightMeasure = () => {
    void nextTick(() => {
      measureEditorLineHeight()
    })
  }

  // 计算编辑器 CSS 变量样式（参考旧项目实现）
  const editorVars = computed(() => {
    const fontPx = fontSize.value
    const lineHeightPx = measuredLineHeightPx.value || getBaseLineHeightPx()
    const contentPercent = Math.min(Math.max(contentWidth.value, 30), 100)

    // 计算字体颜色：如果用户设置了颜色则使用，否则使用主题默认颜色
    const editorColor = fontColor.value || 'var(--ink-main)'

    return {
      '--editor-font-size': `${fontPx}px`,
      '--editor-color': editorColor,
      '--content-max-width': `${contentPercent}%`,
      '--editor-line-height': `${lineHeightPx}px`,
      '--editor-font-weight': fontBold.value ? '700' : '400',
      '--editor-font-family': fontFamily.value,
      '--title-font-size': `${Math.round(fontPx * 1.5)}px`,
      '--ruler-step': `${lineHeightPx}px`,
      '--ruler-offset': `${Math.max(lineHeightPx / 2, 0)}px`,
      '--paragraph-gap-factor': isParagraphGap.value ? '1' : '0',
      '--editor-text-indent': isFirstLineIndent.value ? '2em' : '0',
      '--editor-text-align': alignMode.value || 'left',
    } as Record<string, string>
  })

  watch(
    [fontFamily, fontBold, fontSize, fontLineHeight],
    () => {
      measuredLineHeightPx.value = null
      scheduleLineHeightMeasure()
    },
    { immediate: true, flush: 'post' },
  )

  watch(fontFamily, (family) => {
    void loadImportedFont(family).then(scheduleLineHeightMeasure).catch((error) => {
      console.warn('加载导入字体失败', error)
      ElMessage.warning('字体加载失败，请重新导入该字体')
    })
  }, { immediate: true })

  // 计算编辑器区域宽度
  const editorAreaStyle = computed(() => ({
    maxWidth: `${contentWidth.value}%`,
  }))

  // 计算网格线样式类
  const rulerClass = computed(() => {
    if (rulerStyle.value === 'none') return 'ruler-none'
    if (rulerStyle.value === 'solid') return 'ruler-solid'
    if (rulerStyle.value === 'dashed') return 'ruler-dashed'
    return ''
  })

  onMounted(() => {
    scheduleLineHeightMeasure()
    void document.fonts?.ready.then(scheduleLineHeightMeasure)
    // 内置字体首次被选中才开始加载，完成后同步重测行高与光标度量。
    document.fonts?.addEventListener('loadingdone', scheduleLineHeightMeasure)
  })

  onBeforeUnmount(() => {
    document.fonts?.removeEventListener('loadingdone', scheduleLineHeightMeasure)
  })

  return {
    measuredLineHeightPx,
    normalizePixel,
    getBaseLineHeightPx,
    scheduleLineHeightMeasure,
    editorVars,
    editorAreaStyle,
    rulerClass,
  }
}
