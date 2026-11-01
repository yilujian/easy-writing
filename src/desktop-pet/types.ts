export type PetCharacter = 'cat' | 'fox' | 'girl' | 'dragon' | 'capybara' | 'robot' | 'mushroom' | 'booksmith'
export type PetState = 'idle' | 'typing' | 'thinking' | 'celebrate' | 'error'
export interface PetPreferences {
  enabled: boolean
  character: PetCharacter
  size: 160 | 200 | 260
  bubbles: boolean
  reducedMotion: boolean
}
export interface PetView {
  state: PetState
  message: string
  target: string
  theme: string
  quiet: boolean
}
export interface PetSnapshot {
  preferences: PetPreferences
  view: PetView
}
export interface PetActivity {
  id: string
  phase: 'running' | 'waiting' | 'done' | 'error' | 'cancelled'
  message: string
  target?: string
}
export const PET_STATE_EVENT = 'ew-desktop-pet-state'
export const PET_ACTIVITY_EVENT = 'ew-desktop-pet-activity'
export const defaultPetPreferences = (): PetPreferences => ({
  enabled: false,
  character: 'cat',
  size: 200,
  bubbles: true,
  reducedMotion: false
})
export const defaultPetView = (): PetView => ({
  state: 'idle',
  message: '',
  target: '',
  theme: 'new',
  quiet: false
})
