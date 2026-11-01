import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { readonly, ref } from 'vue'
import {
  defaultPetPreferences,
  defaultPetView,
  PET_STATE_EVENT,
  type PetSnapshot,
  type PetPreferences
} from './types'

const snapshot = ref<PetSnapshot>({ preferences: defaultPetPreferences(), view: defaultPetView() })
export const petSnapshot = readonly(snapshot)
export async function petCommand(action: string, args: unknown = {}): Promise<PetSnapshot> {
  if (!isTauri()) throw new Error('桌宠需要在桌面客户端中使用')
  const value = await invoke<PetSnapshot>('desktop_pet', { action, args })
  if (!['hit_regions', 'publish', 'activate', 'ready'].includes(action)) snapshot.value = value
  return value
}
export async function listenPetState(onChange?: (value: PetSnapshot) => void) {
  return listen<PetSnapshot>(PET_STATE_EVENT, event => {
    snapshot.value = event.payload
    onChange?.(event.payload)
  })
}
export const configurePet = (preferences: PetPreferences) => petCommand('configure', preferences)
