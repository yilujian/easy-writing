import type { PiSession, PiSessionSearchHit } from '@/types/agent-pi'

export interface PiSessionSearchResult {
  session: PiSession
  snippet: string
}

const keyOf = (session: PiSession) => session.localKey || session.file || session.id

/** 标题命中排前面，宿主按内容命中的排后面并带片段；同一对话只出现一次。 */
export function mergeSearchResults(
  query: string,
  sessions: PiSession[],
  hits: PiSessionSearchHit[]
): PiSessionSearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const byTitle = sessions
    .filter(session => session.title.toLowerCase().includes(needle))
    .map(session => ({ session, snippet: '' }))
  const seen = new Set(byTitle.map(item => keyOf(item.session)))
  const byContent = hits.flatMap(hit => {
    const session = sessions.find(s => (hit.file && s.file === hit.file) || s.id === hit.id)
    if (!session || seen.has(keyOf(session))) return []
    seen.add(keyOf(session))
    return [{ session, snippet: hit.snippet }]
  })
  return [...byTitle, ...byContent]
}
