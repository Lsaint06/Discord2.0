/** Channel / conversation sidebar width (this device only). */
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 240
/** Arrow-key step (Shift: bigger steps). */
export const SIDEBAR_STEP = 16

export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value)))
}

/** New width for a splitter key press, or null for keys it doesn't handle. */
export function sidebarWidthForKey(current: number, key: string, shift: boolean): number | null {
  const step = shift ? SIDEBAR_STEP * 4 : SIDEBAR_STEP
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(current - step)
    case 'ArrowRight':
      return clampSidebarWidth(current + step)
    case 'Home':
      return SIDEBAR_MIN
    case 'End':
      return SIDEBAR_MAX
    default:
      return null
  }
}
