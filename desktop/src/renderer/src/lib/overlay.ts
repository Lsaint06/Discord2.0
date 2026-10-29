/**
 * The in-game camera overlay (Milestone 14.5): settings, validation and the pure layout maths
 * shared by the overlay window and Settings. Everything here is local to this PC.
 *
 * Turning the overlay on never turns your camera on: the overlay only shows other people's
 * cameras (and, if you choose, your own while it's already on).
 */

export type OverlayLayoutKind = 'row' | 'stack' | 'grid'
export type OverlaySize = 'small' | 'medium' | 'large'
export type OverlayAnchor = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'custom'

export interface OverlayPosition {
  anchor: OverlayAnchor
  /** Electron display id the overlay goes on (null = the primary display). */
  displayId: number | null
  /** Custom position: offset of the overlay's top-left corner inside that display's work area (DIPs). */
  x: number
  y: number
}

export interface OverlaySettings {
  enabled: boolean
  layout: OverlayLayoutKind
  size: OverlaySize
  maxVisible: 2 | 4 | 6 | 8
  position: OverlayPosition
  /** Tile opacity, percent (40–100). */
  opacity: number
  showNames: boolean
  showSpeaking: boolean
  /** Your own camera in the overlay (only while it's on; off by default). */
  showSelf: boolean
  /** Edit mode can't move it while locked. */
  locked: boolean
  /** Also show it while the Discord 2.0 window is in front (off: you already see the gallery). */
  showWhenAppFocused: boolean
  /** Someone you always want to see first (user id). */
  pinned: string | null
}

export const DEFAULT_OVERLAY: OverlaySettings = {
  enabled: false,
  layout: 'grid',
  size: 'medium',
  maxVisible: 4,
  position: { anchor: 'top-right', displayId: null, x: 0, y: 0 },
  opacity: 100,
  showNames: true,
  showSpeaking: true,
  showSelf: false,
  locked: false,
  showWhenAppFocused: false,
  pinned: null
}

/** Tile size at 100% scale, 16:9 (DIPs). */
export const TILE_SIZES: Record<OverlaySize, { width: number; height: number }> = {
  small: { width: 160, height: 90 },
  medium: { width: 220, height: 124 },
  large: { width: 300, height: 169 }
}

const MIN_TILE = { width: 112, height: 63 }
export const OVERLAY_GAP = 6
export const OVERLAY_PAD = 6
/** Height of the edit-mode toolbar strip (only while arranging). */
export const OVERLAY_TOOLBAR = 34
const EDGE_MARGIN = 16

const pick = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback
const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export function parseOverlaySettings(raw: unknown): OverlaySettings {
  const r =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const p =
    r.position && typeof r.position === 'object' ? (r.position as Record<string, unknown>) : {}
  const d = DEFAULT_OVERLAY
  const displayId =
    p.displayId === null || typeof p.displayId !== 'number' || !Number.isSafeInteger(p.displayId)
      ? null
      : p.displayId
  return {
    enabled: bool(r.enabled, d.enabled),
    layout: pick(r.layout, ['row', 'stack', 'grid'] as const, d.layout),
    size: pick(r.size, ['small', 'medium', 'large'] as const, d.size),
    maxVisible: pick(r.maxVisible, [2, 4, 6, 8] as const, d.maxVisible),
    position: {
      anchor: pick(
        p.anchor,
        ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'custom'] as const,
        d.position.anchor
      ),
      displayId,
      x: Math.round(Math.min(20000, Math.max(-20000, finite(p.x, 0)))),
      y: Math.round(Math.min(20000, Math.max(-20000, finite(p.y, 0))))
    },
    opacity: Math.round(Math.min(100, Math.max(40, finite(r.opacity, d.opacity)))),
    showNames: bool(r.showNames, d.showNames),
    showSpeaking: bool(r.showSpeaking, d.showSpeaking),
    showSelf: bool(r.showSelf, d.showSelf),
    locked: bool(r.locked, d.locked),
    showWhenAppFocused: bool(r.showWhenAppFocused, d.showWhenAppFocused),
    pinned:
      typeof r.pinned === 'string' && r.pinned.length > 0 && r.pinned.length <= 64 ? r.pinned : null
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  primary: boolean
  label?: string
}

export interface OverlayLayout {
  displayId: number
  /** Overlay window bounds in screen DIPs. */
  bounds: Rect
  tile: { width: number; height: number }
  columns: number
  rows: number
  /** How many tiles fit (may be fewer than requested on a small display). */
  visible: number
}

/** The chosen display, or the primary one if it was unplugged (or none was chosen). */
export function chooseDisplay(
  displays: DisplayInfo[],
  preferred: number | null
): DisplayInfo | null {
  if (displays.length === 0) return null
  return (
    (preferred !== null ? displays.find((d) => d.id === preferred) : undefined) ??
    displays.find((d) => d.primary) ??
    displays[0]!
  )
}

function grid(kind: OverlayLayoutKind, n: number): { columns: number; rows: number } {
  if (kind === 'row') return { columns: n, rows: 1 }
  if (kind === 'stack') return { columns: 1, rows: n }
  const columns = Math.ceil(Math.sqrt(n))
  return { columns, rows: Math.ceil(n / columns) }
}

/** Keeps a rectangle fully inside an area (it is shrunk first if it's larger). */
export function clampRect(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height))
  }
}

/**
 * Where the overlay goes and how big its tiles are. It never takes more than ~40% of the
 * display's width or height (60% along the row/stack direction): tiles shrink first (down to a
 * minimum), then fewer cameras are shown, rather than covering the game.
 */
export function overlayLayout(
  settings: Pick<OverlaySettings, 'layout' | 'size' | 'maxVisible' | 'position'>,
  tileCount: number,
  displays: DisplayInfo[],
  options: { edit?: boolean } = {}
): OverlayLayout | null {
  const display = chooseDisplay(displays, settings.position.displayId)
  const wanted = Math.min(tileCount, settings.maxVisible)
  if (!display || wanted <= 0) return null
  const work = display.workArea
  const base = TILE_SIZES[settings.size]
  const toolbar = options.edit ? OVERLAY_TOOLBAR : 0
  const maxW = work.width * (settings.layout === 'row' ? 0.6 : 0.4)
  const maxH = work.height * (settings.layout === 'stack' ? 0.6 : 0.4)

  for (let n = wanted; n >= 1; n--) {
    const { columns, rows } = grid(settings.layout, n)
    const availW = maxW - 2 * OVERLAY_PAD - (columns - 1) * OVERLAY_GAP
    const availH = maxH - 2 * OVERLAY_PAD - (rows - 1) * OVERLAY_GAP - toolbar
    const scale = Math.min(1, availW / (columns * base.width), availH / (rows * base.height))
    const tile = { width: Math.floor(base.width * scale), height: Math.floor(base.height * scale) }
    if (tile.width < MIN_TILE.width || tile.height < MIN_TILE.height) continue
    const width = columns * tile.width + (columns - 1) * OVERLAY_GAP + 2 * OVERLAY_PAD
    const height = rows * tile.height + (rows - 1) * OVERLAY_GAP + 2 * OVERLAY_PAD + toolbar
    const { anchor, x, y } = settings.position
    let origin: { x: number; y: number }
    switch (anchor) {
      case 'top-left':
        origin = { x: work.x + EDGE_MARGIN, y: work.y + EDGE_MARGIN }
        break
      case 'bottom-left':
        origin = { x: work.x + EDGE_MARGIN, y: work.y + work.height - height - EDGE_MARGIN }
        break
      case 'bottom-right':
        origin = {
          x: work.x + work.width - width - EDGE_MARGIN,
          y: work.y + work.height - height - EDGE_MARGIN
        }
        break
      case 'custom':
        origin = { x: work.x + x, y: work.y + y }
        break
      default:
        origin = { x: work.x + work.width - width - EDGE_MARGIN, y: work.y + EDGE_MARGIN }
    }
    const bounds = clampRect({ ...origin, width, height }, work)
    return { displayId: display.id, bounds, tile, columns, rows, visible: n }
  }
  return null
}

/**
 * Converts where the user dragged the overlay to a stored position: the display that holds most
 * of it, and the offset inside that display's work area (survives resolution and DPI changes,
 * and is clamped back on screen if the display shrinks).
 */
export function positionFromBounds(bounds: Rect, displays: DisplayInfo[]): OverlayPosition | null {
  let best: DisplayInfo | null = null
  let bestArea = 0
  for (const d of displays) {
    const w =
      Math.min(bounds.x + bounds.width, d.workArea.x + d.workArea.width) -
      Math.max(bounds.x, d.workArea.x)
    const h =
      Math.min(bounds.y + bounds.height, d.workArea.y + d.workArea.height) -
      Math.max(bounds.y, d.workArea.y)
    const area = Math.max(0, w) * Math.max(0, h)
    if (area > bestArea) {
      best = d
      bestArea = area
    }
  }
  if (!best) return null
  const clamped = clampRect(bounds, best.workArea)
  return {
    anchor: 'custom',
    displayId: best.id,
    x: clamped.x - best.workArea.x,
    y: clamped.y - best.workArea.y
  }
}

export interface OverlayTileInput {
  identity: string
  isLocal: boolean
  cameraOn: boolean
  speaking: boolean
}

/**
 * Who appears in the overlay, in a stable order: only people whose camera is on (never empty
 * black tiles), the pinned person first, yourself only if chosen, then the call's own order.
 */
export function overlayTiles<T extends OverlayTileInput>(
  participants: T[],
  settings: Pick<OverlaySettings, 'showSelf' | 'pinned' | 'maxVisible'>
): T[] {
  const withCamera = participants.filter((p) => p.cameraOn && (settings.showSelf || !p.isLocal))
  const pinned = withCamera.filter((p) => p.identity === settings.pinned)
  const rest = withCamera.filter((p) => p.identity !== settings.pinned)
  return [...pinned, ...rest].slice(0, settings.maxVisible)
}

/** Whether the overlay window should be visible right now. */
export function overlayVisible(input: {
  enabled: boolean
  hidden: boolean
  inVoice: boolean
  tiles: number
  appFocused: boolean
  showWhenAppFocused: boolean
  arranging: boolean
}): boolean {
  if (input.arranging) return true
  if (!input.enabled || input.hidden || !input.inVoice || input.tiles === 0) return false
  return input.showWhenAppFocused || !input.appFocused
}
