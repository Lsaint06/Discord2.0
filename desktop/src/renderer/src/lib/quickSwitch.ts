/**
 * Quick switcher (Ctrl+K) ranking. Pure, so ordering is predictable and unit-tested:
 *   1. name starts with the query, 2. a word in the name starts with it, 3. contains it,
 *   4. the letters appear in order ("gnrl" → general).
 * Ties: unread first, then recently visited, then shorter names, then alphabetical.
 * An empty query lists recently visited places, then unread ones.
 */

export type SwitchKind = 'text' | 'voice' | 'dm' | 'group' | 'server'

export interface SwitchItem {
  /** Unique: channel id, conversation id, or "server:<id>". */
  id: string
  kind: SwitchKind
  name: string
  /** Where it lives (server name, "Direct message"…). */
  context: string
  unread?: boolean
  /** The server a channel (or server item) belongs to. */
  serverId?: string
}

export interface RankOptions {
  /** Recently visited item ids, most recent first. */
  recent?: readonly string[]
  limit?: number
}

const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

function matchScore(name: string, query: string): number {
  const n = fold(name)
  if (n.startsWith(query)) return 4
  if (n.split(/[\s\-_.·/]+/).some((w) => w.startsWith(query))) return 3
  if (n.includes(query)) return 2
  let i = 0
  for (const ch of n) if (ch === query[i] && ++i === query.length) return 1
  return 0
}

export function rankSwitchItems(
  items: readonly SwitchItem[],
  rawQuery: string,
  options: RankOptions = {}
): SwitchItem[] {
  const limit = options.limit ?? 20
  const recent = options.recent ?? []
  const recency = new Map(recent.map((id, i) => [id, i]))
  // "#gen", "@ann", "*server" narrow the kind, like the hint in the dialog says.
  let query = fold(rawQuery.trim())
  let only: ((k: SwitchKind) => boolean) | null = null
  if (query.startsWith('#')) only = (k) => k === 'text'
  else if (query.startsWith('!')) only = (k) => k === 'voice'
  else if (query.startsWith('@')) only = (k) => k === 'dm' || k === 'group'
  else if (query.startsWith('*')) only = (k) => k === 'server'
  if (only) query = query.slice(1)

  const pool = only ? items.filter((it) => only!(it.kind)) : items
  if (!query) {
    const seen = new Set<string>()
    const out: SwitchItem[] = []
    const add = (it: SwitchItem | undefined): void => {
      if (!it || seen.has(it.id)) return
      seen.add(it.id)
      out.push(it)
    }
    const byId = new Map(pool.map((it) => [it.id, it]))
    for (const id of recent) add(byId.get(id))
    for (const it of pool) if (it.unread) add(it)
    if (only) for (const it of pool) add(it)
    return out.slice(0, limit)
  }

  return pool
    .map((it) => ({ it, score: matchScore(it.name, query) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(Boolean(b.it.unread)) - Number(Boolean(a.it.unread)) ||
        (recency.get(a.it.id) ?? Infinity) - (recency.get(b.it.id) ?? Infinity) ||
        a.it.name.length - b.it.name.length ||
        a.it.name.localeCompare(b.it.name)
    )
    .slice(0, limit)
    .map((x) => x.it)
}

/** Most-recent-first visit history without duplicates. */
export function pushVisit(recent: readonly string[], id: string, max = 30): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max)
}
