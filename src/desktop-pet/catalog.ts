import type { PetCharacter, PetState } from './types'

export const PET_CHARACTERS: Array<{ id: PetCharacter; name: string; style: string }> = [
  { id: 'cat', name: '墨团猫', style: '软萌插画' },
  { id: 'fox', name: '纸尾狐', style: '日系灵狐' },
  { id: 'girl', name: '书灵少女', style: '日系人物' },
  { id: 'dragon', name: '云角小龙', style: '幻想插画' },
  { id: 'capybara', name: '团团水豚', style: '黏土手作' },
  { id: 'robot', name: '像素笔宝', style: '复古像素' },
  { id: 'mushroom', name: '绒绒菇', style: '毛毡手作' },
  { id: 'booksmith', name: '小书匠', style: '黏土手办' }
]
export const petAsset = (id: PetCharacter, kind: 'sheet' | 'original') =>
  `${import.meta.env.BASE_URL}desktop-pets/${id}-${kind}.png`
export const PET_ANIMATIONS: Record<PetState, { row: number; frames: number[]; times: number[] }> = {
  idle: { row: 0, frames: [0, 1, 2, 1, 3], times: [2200, 110, 140, 100, 900] },
  typing: { row: 1, frames: [0, 1, 2, 3], times: [150, 110, 150, 110] },
  thinking: { row: 2, frames: [0, 1, 3, 1], times: [650, 500, 700, 500] },
  celebrate: { row: 3, frames: [0, 1, 2, 3, 1, 0], times: [200, 170, 600, 180, 200, 700] },
  error: { row: 4, frames: [0, 1, 2, 3, 1], times: [700, 650, 700, 650, 700] }
}
