import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY,
  clampRect,
  overlayLayout,
  overlayTiles,
  overlayVisible,
  parseOverlaySettings,
  positionFromBounds,
  type DisplayInfo
} from './overlay'

const display = (
  id: number,
  x: number,
  width: number,
  height: number,
  primary = false,
  scaleFactor = 1
): DisplayInfo => ({
  id,
  primary,
  scaleFactor,
  bounds: { x, y: 0, width, height },
  workArea: { x, y: 0, width, height: height - 40 }
})
const FHD = display(1, 0, 1920, 1080, true)
const SMALL = display(2, 1920, 1280, 720, false, 1.25)

describe('overlay settings', () => {
  it('is off by default, compact grid, four cameras, top-right', () => {
    expect(DEFAULT_OVERLAY).toMatchObject({
      enabled: false,
      layout: 'grid',
      size: 'medium',
      maxVisible: 4,
      position: { anchor: 'top-right' },
      showSelf: false,
      showWhenAppFocused: false
    })
    expect(parseOverlaySettings(undefined)).toEqual(DEFAULT_OVERLAY)
  })

  it('validates everything it reads back', () => {
    const parsed = parseOverlaySettings({
      enabled: 'yes',
      layout: 'circle',
      size: 'huge',
      maxVisible: 99,
      opacity: 5,
      position: { anchor: 'middle', displayId: 'abc', x: 1e9, y: Number.NaN },
      pinned: 'x'.repeat(200)
    })
    expect(parsed).toMatchObject({
      enabled: false,
      layout: 'grid',
      size: 'medium',
      maxVisible: 4,
      opacity: 40,
      position: { anchor: 'top-right', displayId: null, x: 20000, y: 0 },
      pinned: null
    })
    expect(
      parseOverlaySettings({ enabled: true, layout: 'row', maxVisible: 8, opacity: 70 })
    ).toMatchObject({
      enabled: true,
      layout: 'row',
      maxVisible: 8,
      opacity: 70
    })
  })
})

describe('overlay layout', () => {
  it('four medium tiles in a 2×2 grid at the top-right of a 1080p screen (about 220×124 each)', () => {
    const l = overlayLayout(DEFAULT_OVERLAY, 4, [FHD])!
    expect(l).toMatchObject({ columns: 2, rows: 2, visible: 4, tile: { width: 220, height: 124 } })
    expect(l.bounds.x + l.bounds.width).toBe(1920 - 16)
    expect(l.bounds.y).toBe(16)
    // Compact: well under a fifth of the screen width.
    expect(l.bounds.width).toBeLessThan(1920 * 0.25)
  })

  it('row and stack layouts', () => {
    expect(overlayLayout({ ...DEFAULT_OVERLAY, layout: 'row' }, 3, [FHD])).toMatchObject({
      columns: 3,
      rows: 1
    })
    expect(overlayLayout({ ...DEFAULT_OVERLAY, layout: 'stack' }, 3, [FHD])).toMatchObject({
      columns: 1,
      rows: 3
    })
  })

  it('on a small display, tiles shrink instead of covering the game', () => {
    const big = overlayLayout(
      {
        ...DEFAULT_OVERLAY,
        size: 'large',
        maxVisible: 8,
        position: { ...DEFAULT_OVERLAY.position, displayId: 2 }
      },
      8,
      [FHD, SMALL]
    )!
    expect(big.displayId).toBe(2)
    expect(big.bounds.width).toBeLessThanOrEqual(1280 * 0.4)
    expect(big.bounds.height).toBeLessThanOrEqual(680 * 0.4)
    expect(big.tile.width).toBeGreaterThanOrEqual(112)
    expect(big.tile.width / big.tile.height).toBeCloseTo(16 / 9, 1)
  })

  it('when even the smallest tiles do not fit, fewer cameras are shown', () => {
    const tiny = display(3, 0, 800, 600, true)
    const l = overlayLayout({ ...DEFAULT_OVERLAY, layout: 'stack', maxVisible: 8 }, 8, [tiny])!
    expect(l.visible).toBeLessThan(8)
    expect(l.bounds.height).toBeLessThanOrEqual(560 * 0.6)
  })

  it('never shows more than the limit, and nothing when nobody has a camera on', () => {
    expect(overlayLayout({ ...DEFAULT_OVERLAY, maxVisible: 2 }, 6, [FHD])!.visible).toBe(2)
    expect(overlayLayout(DEFAULT_OVERLAY, 0, [FHD])).toBeNull()
    expect(overlayLayout(DEFAULT_OVERLAY, 4, [])).toBeNull()
  })

  it('an unplugged display falls back to the primary one', () => {
    const l = overlayLayout(
      { ...DEFAULT_OVERLAY, position: { ...DEFAULT_OVERLAY.position, displayId: 99 } },
      2,
      [FHD, SMALL]
    )!
    expect(l.displayId).toBe(1)
  })

  it('a custom position that is now off-screen is clamped back onto the display', () => {
    const l = overlayLayout(
      { ...DEFAULT_OVERLAY, position: { anchor: 'custom', displayId: 2, x: 5000, y: -300 } },
      2,
      [FHD, SMALL]
    )!
    expect(l.bounds.x + l.bounds.width).toBeLessThanOrEqual(1920 + 1280)
    expect(l.bounds.x).toBeGreaterThanOrEqual(1920)
    expect(l.bounds.y).toBe(0)
  })

  it('edit mode adds room for the toolbar', () => {
    const view = overlayLayout(DEFAULT_OVERLAY, 4, [FHD])!
    const edit = overlayLayout(DEFAULT_OVERLAY, 4, [FHD], { edit: true })!
    expect(edit.bounds.height).toBe(view.bounds.height + 34)
  })

  it('dragging remembers the display and the offset inside it', () => {
    const pos = positionFromBounds({ x: 1920 + 100, y: 50, width: 300, height: 200 }, [FHD, SMALL])!
    expect(pos).toEqual({ anchor: 'custom', displayId: 2, x: 100, y: 50 })
    expect(positionFromBounds({ x: -9999, y: -9999, width: 10, height: 10 }, [FHD])).toBeNull()
    expect(clampRect({ x: -50, y: 2000, width: 100, height: 100 }, FHD.workArea)).toEqual({
      x: 0,
      y: 940,
      width: 100,
      height: 100
    })
  })
})

describe('overlay tiles', () => {
  const people = [
    { identity: 'me', isLocal: true, cameraOn: true, speaking: false },
    { identity: 'ana', isLocal: false, cameraOn: true, speaking: false },
    { identity: 'bob', isLocal: false, cameraOn: false, speaking: true },
    { identity: 'cy', isLocal: false, cameraOn: true, speaking: true },
    { identity: 'di', isLocal: false, cameraOn: true, speaking: false }
  ]

  it('shows only cameras that are on (no black tiles), not yourself unless chosen', () => {
    expect(overlayTiles(people, DEFAULT_OVERLAY).map((p) => p.identity)).toEqual([
      'ana',
      'cy',
      'di'
    ])
    expect(
      overlayTiles(people, { ...DEFAULT_OVERLAY, showSelf: true }).map((p) => p.identity)
    ).toEqual(['me', 'ana', 'cy', 'di'])
  })

  it('the pinned person comes first; the order is stable (speaking does not reshuffle)', () => {
    expect(
      overlayTiles(people, { ...DEFAULT_OVERLAY, pinned: 'di' }).map((p) => p.identity)
    ).toEqual(['di', 'ana', 'cy'])
    expect(
      overlayTiles(people, { ...DEFAULT_OVERLAY, maxVisible: 2 }).map((p) => p.identity)
    ).toEqual(['ana', 'cy'])
  })

  it('eight cameras on: the limit applies', () => {
    const eight = Array.from({ length: 9 }, (_, i) => ({
      identity: `u${i}`,
      isLocal: i === 0,
      cameraOn: true,
      speaking: false
    }))
    expect(overlayTiles(eight, { ...DEFAULT_OVERLAY, maxVisible: 8 })).toHaveLength(8)
  })
})

describe('overlay visibility', () => {
  const base = {
    enabled: true,
    hidden: false,
    inVoice: true,
    tiles: 2,
    appFocused: false,
    showWhenAppFocused: false,
    arranging: false
  }
  it('shows over other apps while in voice with cameras on', () => {
    expect(overlayVisible(base)).toBe(true)
  })
  it('hides instantly (hide shortcut), when disabled, out of voice, with no cameras, or over the app itself', () => {
    expect(overlayVisible({ ...base, hidden: true })).toBe(false)
    expect(overlayVisible({ ...base, enabled: false })).toBe(false)
    expect(overlayVisible({ ...base, inVoice: false })).toBe(false)
    expect(overlayVisible({ ...base, tiles: 0 })).toBe(false)
    expect(overlayVisible({ ...base, appFocused: true })).toBe(false)
    expect(overlayVisible({ ...base, appFocused: true, showWhenAppFocused: true })).toBe(true)
  })
  it('arranging always shows it (with sample tiles)', () => {
    expect(
      overlayVisible({ ...base, enabled: false, inVoice: false, tiles: 0, arranging: true })
    ).toBe(true)
  })
})
