/**
 * Video gallery layout (Milestone 14.5): pure maths for the in-app call view, so the component
 * itself stays simple and the edge cases are unit tested.
 */

export interface GalleryGrid {
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
}

/**
 * The grid that makes `count` 16:9 tiles as large as possible inside width × height.
 * One camera gets one big tile, two sit side by side (or stacked in a tall window), three or four
 * form a 2×2 grid, and so on.
 */
export function galleryGrid(
  count: number,
  width: number,
  height: number,
  gap = 8,
  aspect = 16 / 9
): GalleryGrid {
  if (count <= 0 || width <= 0 || height <= 0)
    return { columns: 1, rows: 1, tileWidth: 0, tileHeight: 0 }
  let best: GalleryGrid = { columns: 1, rows: count, tileWidth: 0, tileHeight: 0 }
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const maxW = (width - (columns - 1) * gap) / columns
    const maxH = (height - (rows - 1) * gap) / rows
    if (maxW <= 0 || maxH <= 0) continue
    const tileWidth = Math.floor(Math.min(maxW, maxH * aspect))
    const tileHeight = Math.floor(tileWidth / aspect)
    if (tileWidth > best.tileWidth) best = { columns, rows, tileWidth, tileHeight }
  }
  return best
}

/** Tiles per page: as many as stay at least `minTileWidth` wide (at least 1, at most 16). */
export function galleryPageSize(
  width: number,
  height: number,
  minTileWidth = 240,
  gap = 8
): number {
  let size = 1
  for (let n = 1; n <= 16; n++) {
    if (galleryGrid(n, width, height, gap).tileWidth >= minTileWidth) size = n
    else break
  }
  return size
}

export interface GalleryParticipant {
  identity: string
  isLocal: boolean
  cameraOn: boolean
}

/**
 * Order of video tiles: the call's own (join) order, which never reshuffles when someone speaks,
 * with your own self-view first unless you hid it. Only cameras that are on get a video tile.
 */
export function galleryOrder<T extends GalleryParticipant>(
  participants: T[],
  options: { hideSelf: boolean }
): T[] {
  const withCamera = participants.filter((p) => p.cameraOn && !(options.hideSelf && p.isLocal))
  return [...withCamera.filter((p) => p.isLocal), ...withCamera.filter((p) => !p.isLocal)]
}

/** The page that contains `identity` (e.g. the focused person), or the clamped current page. */
export function pageFor(
  order: { identity: string }[],
  pageSize: number,
  page: number,
  identity?: string | null
): number {
  const pages = Math.max(1, Math.ceil(order.length / Math.max(1, pageSize)))
  if (identity) {
    const index = order.findIndex((p) => p.identity === identity)
    if (index >= 0) return Math.floor(index / pageSize)
  }
  return Math.min(Math.max(0, page), pages - 1)
}
