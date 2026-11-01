/**
 * 封面图的两个纯前端步骤：把风格并进画面描述，以及把生成的图裁成封面比例。
 * 生成、确认、采用都在 Agent 的封面任务里（src/agent-pi/cover-tasks.ts）。
 */

/** 封面比例与封面工具的预览一致（225:400） */
const COVER_RATIO = 400 / 225

/** 与封面工具一样把风格并进描述；描述里已写了风格就不重复 */
export const composeCoverPrompt = (prompt: string, style: string) => {
  const base = String(prompt || '').trim()
  const label = String(style || '').trim()
  if (!base) return ''
  return label && !base.includes(label) ? `${base}，${label}风格` : base
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('封面图片读取失败'))
    image.src = url
  })

/** 把生成的图裁成封面比例（居中铺满），输出 PNG；不排书名，纯画面 */
export const composeCoverDataUrl = async (imageUrl: string): Promise<string> => {
  const { getImageObjectSource } = await import('@/utils/image-proxy')
  const source = await getImageObjectSource(imageUrl)
  try {
    const image = await loadImage(source.url)
    const width = image.naturalWidth || 768
    const height = Math.round(width * COVER_RATIO)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('封面合成失败')
    const scale = Math.max(width / (image.naturalWidth || width), height / (image.naturalHeight || height))
    const drawWidth = (image.naturalWidth || width) * scale
    const drawHeight = (image.naturalHeight || height) * scale
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
    return canvas.toDataURL('image/png')
  } finally {
    if (source.revoke && source.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(source.url)
      } catch {
        // 释放失败不影响结果
      }
    }
  }
}
