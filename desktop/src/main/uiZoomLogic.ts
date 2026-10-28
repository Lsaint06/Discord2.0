/**
 * App-wide interface scale (pure; no Electron imports so it can be unit-tested).
 *
 * The scale is applied with Chromium's page zoom (webContents.setZoomFactor), which re-lays
 * out the page at a different CSS-pixel size: text, hit targets, dialogs and media queries all
 * scale together. That is unlike a CSS transform, which only paints larger.
 */

/** Allowed scale factors, smallest to largest. 1 = 100 %. */
export const UI_ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5]
export const UI_ZOOM_DEFAULT = 1

/** Accepts only a listed step (with float tolerance), else the default. */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_ZOOM_DEFAULT
  const match = UI_ZOOM_STEPS.find((step) => Math.abs(step - value) < 0.001)
  return match ?? UI_ZOOM_DEFAULT
}

/** Parses the persisted settings file; anything unexpected yields the default. */
export function parseZoomFile(text: string): number {
  try {
    const data = JSON.parse(text) as { zoomFactor?: unknown } | null
    return normalizeZoom(data?.zoomFactor)
  } catch {
    return UI_ZOOM_DEFAULT
  }
}

/** The next step in `direction`, clamped at either end. Off-list values snap to the nearest. */
export function stepZoom(current: number, direction: 1 | -1): number {
  let index = 0
  let best = Infinity
  UI_ZOOM_STEPS.forEach((step, i) => {
    const distance = Math.abs(step - current)
    if (distance < best) {
      best = distance
      index = i
    }
  })
  const next = Math.min(UI_ZOOM_STEPS.length - 1, Math.max(0, index + direction))
  return UI_ZOOM_STEPS[next]
}

export type ZoomKeyAction = 'in' | 'out' | 'reset'

export interface ZoomKeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
}

/**
 * Ctrl (Cmd on macOS) with = / + / - / 0, including the numeric keypad. Alt combinations are
 * left alone (AltGr on some layouts reports Ctrl+Alt).
 */
export function zoomKeyAction(input: ZoomKeyInput, isMac: boolean): ZoomKeyAction | null {
  if (input.type !== 'keyDown' || input.alt) return null
  if (!(isMac ? input.meta : input.control)) return null
  switch (input.key) {
    case '=':
    case '+':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}
