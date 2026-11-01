import sheets from './sheets.json'
import { PET_ANIMATIONS, petAsset } from './catalog'
import type { PetCharacter, PetState } from './types'

interface Frame {
  image?: HTMLCanvasElement
  x: number
  y: number
  width: number
  height: number
}
export interface PetSheet {
  image: HTMLImageElement
  frames: Frame[]
  scale: number
}
const cache = new Map<PetCharacter, Promise<PetSheet>>()

// 列边界是一个 x，或 [行顶 x, 行底 x]。相邻动作的耳尖和尾巴错开时，沿透明空隙斜切。
type ColumnCut = number | number[]

function frameSource(
  atlas: CanvasRenderingContext2D,
  y: number,
  height: number,
  left: ColumnCut,
  right: ColumnCut
) {
  if (typeof left === 'number' && typeof right === 'number')
    return { context: atlas, x: left, y, width: right - left }

  const [topLeft, bottomLeft] = typeof left === 'number' ? [left, left] : left
  const [topRight, bottomRight] = typeof right === 'number' ? [right, right] : right
  const x = Math.min(topLeft, bottomLeft)
  const tile = document.createElement('canvas')
  tile.width = Math.max(topRight, bottomRight) - x
  tile.height = height
  const context = tile.getContext('2d', { willReadFrequently: true })!
  context.beginPath()
  context.moveTo(topLeft - x, 0)
  context.lineTo(topRight - x, 0)
  context.lineTo(bottomRight - x, height)
  context.lineTo(bottomLeft - x, height)
  context.closePath()
  context.clip()
  context.drawImage(atlas.canvas, x, y, tile.width, height, 0, 0, tile.width, height)
  return { context, x: 0, y: 0, width: tile.width }
}

export function loadPetSheet(character: PetCharacter): Promise<PetSheet> {
  const existing = cache.get(character)
  if (existing) return existing
  const pending = new Promise<PetSheet>((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('桌宠素材加载失败，请重新选择形象'))
    image.onload = () => {
      try {
        const source = document.createElement('canvas')
        source.width = image.width
        source.height = image.height
        const context = source.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        const metadata = sheets[character]
        const frames: Frame[] = []
        for (let row = 0; row < 5; row++)
          for (let col = 0; col < 4; col++) {
            const y = metadata.rows[row]
            const height = metadata.rows[row + 1] - y
            const columns = metadata.columns[row]
            const cell = frameSource(context, y, height, columns[col], columns[col + 1])
            const { width } = cell
            const pixels = cell.context.getImageData(cell.x, cell.y, width, height).data
            let left = width,
              top = height,
              right = 0,
              bottom = 0
            for (let py = 0; py < height; py++)
              for (let px = 0; px < width; px++) {
                if (pixels[(py * width + px) * 4 + 3] <= 100) continue
                left = Math.min(left, px)
                top = Math.min(top, py)
                right = Math.max(right, px)
                bottom = Math.max(bottom, py)
              }
            if (left > right || top > bottom) throw new Error('桌宠动作帧无效')
            frames.push({
              image: cell.context === context ? undefined : cell.context.canvas,
              x: cell.x + left,
              y: cell.y + top,
              width: right - left + 1,
              height: bottom - top + 1
            })
          }
        resolve({
          image,
          frames,
          scale: Math.min(
            270 / Math.max(...frames.map(f => f.width)),
            280 / Math.max(...frames.map(f => f.height))
          )
        })
      } catch (error) {
        reject(error)
      }
    }
    image.src = petAsset(character, 'sheet')
  })
  cache.set(character, pending)
  pending.catch(() => cache.delete(character))
  return pending
}

/** 共用比例与底部锚点，不随每张图的包围盒缩放，避免呼吸时忽大忽小。 */
export function drawPet(
  context: CanvasRenderingContext2D,
  sheet: PetSheet,
  character: PetCharacter,
  state: PetState,
  elapsed: number,
  reduced: boolean
) {
  const animation = PET_ANIMATIONS[state]
  let phase = elapsed % animation.times.reduce((a, b) => a + b, 0),
    index = 0
  while (index < animation.times.length - 1 && phase >= animation.times[index]) {
    phase -= animation.times[index]
    index++
  }
  const frame = sheet.frames[animation.row * 4 + (reduced ? 0 : animation.frames[index])]
  const lift = !reduced && state === 'celebrate' ? -Math.max(0, Math.sin(elapsed / 330)) * 10 : 0
  const width = frame.width * sheet.scale,
    height = frame.height * sheet.scale
  context.clearRect(0, 0, 320, 320)
  context.imageSmoothingEnabled = character !== 'robot'
  context.drawImage(
    frame.image ?? sheet.image,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    (320 - width) / 2,
    306 - height + lift,
    width,
    height
  )
  return { x: (320 - width) / 2, y: 306 - height + lift, width, height }
}
