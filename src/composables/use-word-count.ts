import { computed } from 'vue'
import { useUiPreferencesStore } from '@/stores/ui-preferences'

export function useWordCount() {
  const preferences = useUiPreferencesStore()
  const mode = computed(() => preferences.wordCountMode)
  const label = computed(() => (mode.value === 'text' ? '不含标点' : '含标点'))
  const value = (item?: { wordCount?: number; textWordCount?: number | null } | null) =>
    mode.value === 'text'
      ? (item?.textWordCount ?? (item?.wordCount === 0 ? 0 : null))
      : (item?.wordCount ?? 0)
  const format = (count: number | null | undefined) => (count == null ? '—' : count.toLocaleString())
  return { mode, label, value, format }
}
