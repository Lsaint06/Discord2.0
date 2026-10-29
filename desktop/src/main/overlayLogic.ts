/**
 * Pure decisions for camera permission and the camera overlay window (no Electron imports, so
 * they are unit tested). See media.ts and overlay.ts for where they're applied.
 */

/**
 * getUserMedia from our renderer: the microphone, and (Milestone 14.5) the camera — but the
 * camera only for the main app window's own top-level page. Any other window or frame (the
 * overlay window, an iframe, a stray page) never gets a camera.
 */
export function mediaRequestAllowed(input: {
  appUrl: boolean
  mediaTypes: string[]
  isMainFrame: boolean
  isMainWindow: boolean
}): boolean {
  if (!input.appUrl || input.mediaTypes.length === 0) return false
  if (!input.mediaTypes.every((t) => t === 'audio' || t === 'video')) return false
  if (input.mediaTypes.includes('video')) return input.isMainFrame && input.isMainWindow
  return true
}

/** Permission checks (also what enumerateDevices uses to show camera names). */
export function mediaCheckAllowed(input: {
  appUrl: boolean
  mediaType?: string
  isMainWindow: boolean
}): boolean {
  if (!input.appUrl) return false
  if (input.mediaType === 'video') return input.isMainWindow
  return true
}

export const OVERLAY_FRAME_NAME = 'd2-camera-overlay'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayCommand {
  visible: boolean
  mode: 'view' | 'edit'
  bounds: Rect
}

const LIMIT = 32_000
const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : null

/** Validates an overlay update from the renderer; null if anything is off. */
export function parseOverlayCommand(raw: unknown): OverlayCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.visible !== 'boolean') return null
  if (r.mode !== 'view' && r.mode !== 'edit') return null
  const b = r.bounds && typeof r.bounds === 'object' ? (r.bounds as Record<string, unknown>) : null
  if (!b) return null
  const x = intIn(b.x, -LIMIT, LIMIT)
  const y = intIn(b.y, -LIMIT, LIMIT)
  const width = intIn(b.width, 80, 4000)
  const height = intIn(b.height, 60, 4000)
  if (x === null || y === null || width === null || height === null) return null
  return { visible: r.visible, mode: r.mode, bounds: { x, y, width, height } }
}

/** Whether the overlay window may be created for this window.open() request. */
export function isOverlayOpenRequest(
  details: { url: string; frameName: string },
  openerIsApp: boolean
): boolean {
  return openerIsApp && details.url === 'about:blank' && details.frameName === OVERLAY_FRAME_NAME
}

/**
 * Keeps the overlay on a real screen: on the display that holds its centre (or the primary one
 * if it's off every display), shrunk to fit and moved fully inside that display's work area.
 */
export function clampToDisplays(bounds: Rect, workAreas: Rect[], primary: Rect): Rect {
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const area =
    workAreas.find((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) ??
    primary
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height))
  }
}
