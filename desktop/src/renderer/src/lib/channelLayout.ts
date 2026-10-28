/**
 * Channel layout editing (Server Settings → Channels): channels grouped into categories, in the
 * order the sidebar shows them. Pure functions; the result is saved with PUT …/layout, which
 * also makes positions contiguous per category.
 */
import type { ApiChannel, ChannelType } from '../net/protocol'

export interface LayoutEntry {
  id: string
  name: string
  type: ChannelType
  category: string
}

/**
 * The sidebar order: categories in order of their first channel, channels by position inside
 * each category (the same grouping the sidebar uses).
 */
export function layoutOf(
  channels: Pick<ApiChannel, 'id' | 'name' | 'type' | 'category' | 'position'>[]
): LayoutEntry[] {
  const groups = new Map<string, LayoutEntry[]>()
  for (const c of [...channels].sort((a, b) => a.position - b.position)) {
    const list = groups.get(c.category) ?? []
    list.push({ id: c.id, name: c.name, type: c.type, category: c.category })
    groups.set(c.category, list)
  }
  return [...groups.values()].flat()
}

/** Groups entries by category (first appearance first), keeping their relative order. */
export function normalizeLayout(layout: LayoutEntry[]): LayoutEntry[] {
  const groups = new Map<string, LayoutEntry[]>()
  for (const e of layout) {
    const list = groups.get(e.category) ?? []
    list.push(e)
    groups.set(e.category, list)
  }
  return [...groups.values()].flat()
}

export function categoriesOf(layout: LayoutEntry[]): string[] {
  return [...new Set(layout.map((e) => e.category))]
}

/**
 * Moves a channel one step up or down. At the edge of its category it crosses into the
 * neighbouring category instead (becoming its last / first channel).
 */
export function moveChannel(layout: LayoutEntry[], id: string, step: -1 | 1): LayoutEntry[] {
  const list = normalizeLayout(layout)
  const i = list.findIndex((e) => e.id === id)
  const j = i + step
  if (i < 0 || j < 0 || j >= list.length) return list
  const entry = list[i]!
  const neighbour = list[j]!
  if (neighbour.category !== entry.category) {
    const next = [...list]
    next[i] = { ...entry, category: neighbour.category }
    return normalizeLayout(next)
  }
  const next = [...list]
  next[i] = neighbour
  next[j] = entry
  return next
}

/** Moves a whole category above / below its neighbouring category. */
export function moveCategory(layout: LayoutEntry[], category: string, step: -1 | 1): LayoutEntry[] {
  const order = categoriesOf(normalizeLayout(layout))
  const i = order.indexOf(category)
  const j = i + step
  if (i < 0 || j < 0 || j >= order.length) return normalizeLayout(layout)
  ;[order[i], order[j]] = [order[j]!, order[i]!]
  const list = normalizeLayout(layout)
  return order.flatMap((c) => list.filter((e) => e.category === c))
}

/** Renames a category (renaming onto an existing one merges them, keeping the first's place). */
export function renameCategory(layout: LayoutEntry[], from: string, to: string): LayoutEntry[] {
  const name = to.replace(/\s+/g, ' ').trim()
  if (!name) return normalizeLayout(layout)
  return normalizeLayout(layout.map((e) => (e.category === from ? { ...e, category: name } : e)))
}

/** Puts a channel at the end of another (possibly new) category. */
export function setChannelCategory(
  layout: LayoutEntry[],
  id: string,
  category: string
): LayoutEntry[] {
  const name = category.replace(/\s+/g, ' ').trim()
  const entry = layout.find((e) => e.id === id)
  if (!name || !entry || entry.category === name) return normalizeLayout(layout)
  const rest = normalizeLayout(layout.filter((e) => e.id !== id))
  const moved = { ...entry, category: name }
  const lastOfCategory = rest.map((e) => e.category).lastIndexOf(name)
  if (lastOfCategory < 0) return [...rest, moved]
  return [...rest.slice(0, lastOfCategory + 1), moved, ...rest.slice(lastOfCategory + 1)]
}

export const sameLayout = (a: LayoutEntry[], b: LayoutEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.id === b[i]?.id && e.category === b[i]?.category)
