import { describe, expect, it } from 'vitest'
import { APP_THEME_DEFS, blend, contrastRatio, surfaceSamples } from './themes'
import {
  CHAT_WALLPAPERS,
  DEFAULT_WALLPAPER_INTENSITY,
  MAX_WALLPAPER_INK,
  parseWallpaper,
  parseWallpaperIntensity,
  wallpaperInk
} from './wallpapers'

describe('chat wallpapers', () => {
  it('six original patterns with unique ids and names', () => {
    expect(CHAT_WALLPAPERS.length).toBe(6)
    expect(new Set(CHAT_WALLPAPERS.map((w) => w.id)).size).toBe(6)
    expect(new Set(CHAT_WALLPAPERS.map((w) => w.name)).size).toBe(6)
  })

  it('stored values are validated: unknown ids mean none, intensity is clamped', () => {
    expect(parseWallpaper('dots')).toBe('dots')
    for (const bad of ['nope', '', null, undefined, 42, '__proto__'])
      expect(parseWallpaper(bad)).toBeNull()
    expect(parseWallpaperIntensity(undefined)).toBe(DEFAULT_WALLPAPER_INTENSITY)
    expect(parseWallpaperIntensity(Number.NaN)).toBe(DEFAULT_WALLPAPER_INTENSITY)
    expect(parseWallpaperIntensity(500)).toBe(100)
    expect(parseWallpaperIntensity(-3)).toBe(10)
    expect(wallpaperInk(100)).toBe(MAX_WALLPAPER_INK)
    expect(wallpaperInk(10)).toBeCloseTo(0.02, 5)
  })

  // Worst case: the pattern's ink at full intensity, under the message text, in every theme.
  it.each(APP_THEME_DEFS.map((t) => [t.id, t] as const))(
    '%s: text stays readable over the strongest wallpaper',
    (_id, theme) => {
      for (const surface of surfaceSamples(theme, 'primary')) {
        const inked = blend(theme.palette.textMuted, surface, MAX_WALLPAPER_INK)
        expect(contrastRatio(theme.palette.textNormal, inked)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(theme.palette.textMuted, inked)).toBeGreaterThanOrEqual(3)
      }
    }
  )
})
