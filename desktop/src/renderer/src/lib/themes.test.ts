import { describe, expect, it } from 'vitest'
import { APP_THEMES } from '../net/protocol'
import {
  APP_THEME_DEFS,
  appThemeById,
  bestTextOn,
  blend,
  contrastRatio,
  resolveAppTheme,
  surfaceSamples,
  themeVariables,
  THEME_VARIABLE_NAMES,
  unsyncedThemeAction,
  type ThemePalette
} from './themes'

const READING_SURFACES: (keyof ThemePalette)[] = ['primary', 'secondary', 'rail']
const themes = APP_THEME_DEFS.map((t) => [t.id, t] as const)

describe('app themes', () => {
  it('there are at least 10, one per protocol id, with unique names and ambient art', () => {
    expect(APP_THEME_DEFS.length).toBeGreaterThanOrEqual(10)
    expect(APP_THEME_DEFS.map((t) => t.id).sort()).toEqual([...APP_THEMES].sort())
    expect(new Set(APP_THEME_DEFS.map((t) => t.name)).size).toBe(APP_THEME_DEFS.length)
    expect(new Set(APP_THEME_DEFS.map((t) => t.ambient)).size).toBe(APP_THEME_DEFS.length)
    expect(APP_THEME_DEFS.filter((t) => t.base === 'light').length).toBeGreaterThanOrEqual(2)
  })

  it('unknown or removed ids fall back to the classic theme', () => {
    expect(appThemeById('solar')?.name).toBe('Solar Flare')
    for (const bad of [null, undefined, '', 'paid-only', 42, {}, 'constructor', '__proto__']) {
      expect(appThemeById(bad)).toBeNull()
    }
  })

  it('every palette value is a #rrggbb color', () => {
    for (const theme of APP_THEME_DEFS) {
      for (const [key, value] of Object.entries(theme.palette)) {
        expect(value, `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/)
      }
      for (const stop of theme.backdrop?.stops ?? []) expect(stop).toMatch(/^#[0-9a-f]{6}$/)
      for (const swatch of theme.swatch) expect(swatch).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  // WCAG 2.2: 4.5:1 for normal text (AA); message text gets 7:1 (AAA).
  it.each(themes)('%s: text is readable on every surface, over its backdrop too', (_id, theme) => {
    for (const surface of READING_SURFACES) {
      for (const bg of surfaceSamples(theme, surface)) {
        const p = theme.palette
        expect(
          contrastRatio(p.textNormal, bg),
          `normal on ${surface} ${bg}`
        ).toBeGreaterThanOrEqual(7)
        expect(
          contrastRatio(p.textStrong, bg),
          `strong on ${surface} ${bg}`
        ).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(p.textMuted, bg), `muted on ${surface} ${bg}`).toBeGreaterThanOrEqual(
          4.5
        )
        expect(contrastRatio(p.textFaint, bg), `faint on ${surface} ${bg}`).toBeGreaterThanOrEqual(
          3
        )
      }
    }
    for (const opaque of ['floating', 'input'] as const) {
      expect(contrastRatio(theme.palette.textNormal, theme.palette[opaque])).toBeGreaterThanOrEqual(
        7
      )
      expect(contrastRatio(theme.palette.textMuted, theme.palette[opaque])).toBeGreaterThanOrEqual(
        4.5
      )
    }
  })

  it.each(themes)('%s: links, mentions and the accent are readable', (_id, theme) => {
    const p = theme.palette
    for (const bg of surfaceSamples(theme, 'primary')) {
      expect(contrastRatio(p.link, bg), `link on ${bg}`).toBeGreaterThanOrEqual(4.5)
      // Mentions sit on a 25% accent tint.
      const mentionBg = blend(p.accent, bg, 0.25)
      expect(contrastRatio(p.mention, mentionBg), `mention on ${mentionBg}`).toBeGreaterThanOrEqual(
        4.5
      )
      // The accent as a UI color (focus rings, toggles) against the chat.
      expect(contrastRatio(p.accent, bg), `accent on ${bg}`).toBeGreaterThanOrEqual(3)
    }
    // Text on accent buttons.
    expect(contrastRatio(bestTextOn(p.accent), p.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('variables: translucent surfaces over a backdrop, opaque floating surfaces', () => {
    const aurora = themeVariables(appThemeById('aurora')!)
    expect(aurora['--bg-primary']).toMatch(/^rgba\(/)
    expect(aurora['--bg-floating']).toMatch(/^#/)
    expect(aurora['--app-backdrop']).toMatch(/^linear-gradient\(135deg, #/)
    const voidTheme = themeVariables(appThemeById('void')!)
    expect(voidTheme['--bg-primary']).toBe('#000000')
    expect(voidTheme['--app-backdrop']).toBeUndefined()
    for (const theme of APP_THEME_DEFS) {
      for (const name of Object.keys(themeVariables(theme))) {
        expect(THEME_VARIABLE_NAMES as readonly string[]).toContain(name)
      }
    }
  })

  it('blend, contrast and best text color match known values', () => {
    expect(blend('#ffffff', '#000000', 0.5)).toBe('#808080')
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
    expect(bestTextOn('#ffff00')).toBe('#000000')
    expect(bestTextOn('#1e3a8a')).toBe('#ffffff')
  })
})

describe('theme choice across server versions', () => {
  it('older servers (or before the server answers): this device’s choice is shown', () => {
    expect(resolveAppTheme(undefined, 'forest', false)).toBe('forest')
    expect(resolveAppTheme(undefined, null, true)).toBeNull()
    expect(unsyncedThemeAction(undefined, 'forest', true)).toBe('wait')
  })

  it('servers that save themes: the account’s choice wins, including Classic', () => {
    expect(resolveAppTheme('mint', 'forest', false)).toBe('mint')
    expect(resolveAppTheme(null, 'forest', false)).toBeNull()
    expect(unsyncedThemeAction(null, 'forest', false)).toBe('wait')
  })

  it('after a server upgrade, a theme picked before it could be saved is kept and moved to the account', () => {
    // Picked on an older server, account has nothing yet: keep showing it and save it.
    expect(resolveAppTheme(null, 'aurora', true)).toBe('aurora')
    expect(unsyncedThemeAction(null, 'aurora', true)).toBe('push')
    // While saving (optimistic) and afterwards, the account's copy is the same theme.
    expect(resolveAppTheme('aurora', 'aurora', true)).toBe('aurora')
    // Picked Classic on the older server: nothing to move.
    expect(unsyncedThemeAction(null, null, true)).toBe('drop')
  })

  it('a theme chosen on another device after the upgrade wins over the old local one', () => {
    expect(resolveAppTheme('solar', 'aurora', true)).toBe('solar')
    expect(unsyncedThemeAction('solar', 'aurora', true)).toBe('drop')
  })
})
