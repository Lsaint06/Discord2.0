import { describe, expect, it } from 'vitest'
import {
  AVATAR_DECORATIONS,
  BANNER_PRESETS,
  NAME_STYLES,
  PROFILE_EFFECTS,
  type ApiProfileStyle
} from '../net/protocol'
import {
  BANNER_INFO,
  bannerPresetOf,
  cleanStyle,
  decorationOf,
  DECORATION_INFO,
  EFFECT_DURATION_MS,
  EFFECT_INFO,
  effectOf,
  EMPTY_STYLE,
  GRADIENT_PRESETS,
  gradientColors,
  NAME_STYLE_INFO,
  nameStyleOf,
  profileGradientCss,
  sameStyle
} from './profileStyle'
import { APP_THEME_DEFS, blend, contrastRatio } from './themes'
import { isAnimatedGif, isAnimatedWebp } from './animatedImage'

const style = (patch: Partial<ApiProfileStyle>): ApiProfileStyle => ({ ...EMPTY_STYLE, ...patch })

describe('profile customization registry', () => {
  it('has at least 12 decorations, 8 effects, 8 banners and 6 name styles, all described', () => {
    expect(AVATAR_DECORATIONS.length).toBeGreaterThanOrEqual(12)
    expect(PROFILE_EFFECTS.length).toBeGreaterThanOrEqual(8)
    expect(BANNER_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(NAME_STYLES.length).toBeGreaterThanOrEqual(6)
    for (const id of AVATAR_DECORATIONS) expect(DECORATION_INFO[id]?.name).toBeTruthy()
    for (const id of PROFILE_EFFECTS) expect(EFFECT_INFO[id]?.name).toBeTruthy()
    for (const id of BANNER_PRESETS) expect(BANNER_INFO[id]?.name).toBeTruthy()
    for (const id of NAME_STYLES) expect(NAME_STYLE_INFO[id]?.name).toBeTruthy()
    expect(new Set(Object.values(DECORATION_INFO).map((d) => d.name)).size).toBe(
      AVATAR_DECORATIONS.length
    )
  })

  it('unknown or retired ids are ignored, never errors', () => {
    const weird = {
      ...EMPTY_STYLE,
      decoration: 'nitro-exclusive',
      effect: 42,
      banner: '__proto__',
      nameStyle: 'rainbow'
    } as unknown as ApiProfileStyle
    expect(decorationOf(weird)).toBeNull()
    expect(effectOf(weird)).toBeNull()
    expect(bannerPresetOf(weird)).toBeNull()
    expect(nameStyleOf(weird)).toBeNull()
    expect(decorationOf(null)).toBeNull()
    expect(decorationOf(undefined)).toBeNull()
    expect(cleanStyle(weird)).toBeNull()
  })

  it('gradients: only valid colors, 1 = solid, 2–3 = linear-gradient', () => {
    expect(profileGradientCss(null)).toBeNull()
    expect(profileGradientCss(style({ colors: [] }))).toBeNull()
    expect(profileGradientCss(style({ colors: ['#112233'] }))).toBe('#112233')
    expect(profileGradientCss(style({ colors: ['#112233', '#445566'], angle: 90 }))).toBe(
      'linear-gradient(90deg, #112233, #445566)'
    )
    expect(
      gradientColors(
        style({ colors: ['#112233', 'red', 'url(x)', '#aabbcc', '#000000', '#ffffff'] })
      )
    ).toEqual(['#112233', '#aabbcc', '#000000'])
  })

  it('cleanStyle normalizes and empty styles become null', () => {
    expect(cleanStyle(EMPTY_STYLE)).toBeNull()
    expect(
      cleanStyle(style({ colors: ['#AABBCC', '#000000'], angle: 400.6, decoration: 'star-orbit' }))
    ).toEqual({
      colors: ['#aabbcc', '#000000'],
      angle: 359,
      decoration: 'star-orbit',
      effect: null,
      banner: null,
      nameStyle: null
    })
    expect(
      sameStyle(style({ effect: 'holo-scan' }), style({ effect: 'holo-scan', angle: 180 }))
    ).toBe(true)
    expect(sameStyle(null, EMPTY_STYLE)).toBe(true)
    expect(sameStyle(style({ effect: 'holo-scan' }), null)).toBe(false)
  })

  it('presets are valid gradients', () => {
    expect(GRADIENT_PRESETS.length).toBeGreaterThanOrEqual(6)
    for (const preset of GRADIENT_PRESETS) {
      expect(preset.colors.length).toBeGreaterThanOrEqual(2)
      expect(preset.colors.length).toBeLessThanOrEqual(3)
      for (const c of preset.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('effects stay under 5 seconds (no pause control needed, WCAG 2.2.2)', () => {
    expect(EFFECT_DURATION_MS).toBeLessThan(5000)
  })

  // Profile text sits on an 86% scrim of the theme's floating surface: readable on any gradient.
  it.each(APP_THEME_DEFS.map((t) => [t.id, t] as const))(
    '%s: profile text stays readable over the brightest and darkest gradient',
    (_id, theme) => {
      for (const worst of ['#ffffff', '#000000', '#ff00ff', '#ffff00']) {
        const scrim = blend(theme.palette.floating, worst, 0.86)
        expect(contrastRatio(theme.palette.textNormal, scrim)).toBeGreaterThanOrEqual(4.5)
      }
    }
  )
})

// ---- Animated picture detection ----

function gif(frames: number): Uint8Array {
  const bytes: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0))
  bytes.push(1, 0, 1, 0, 0x80, 0, 0) // 1×1, global color table of 2 entries
  bytes.push(0, 0, 0, 255, 255, 255)
  for (let i = 0; i < frames; i++) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0) // graphic control extension
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0) // image descriptor
    bytes.push(2, 2, 0x44, 0x01, 0) // LZW min size, one sub-block, terminator
  }
  bytes.push(0x3b)
  return new Uint8Array(bytes)
}

function webp(flags: number): Uint8Array {
  const out = new Uint8Array(30)
  out.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0
  )
  out.set(
    [...'WEBP'].map((c) => c.charCodeAt(0)),
    8
  )
  out.set(
    [...'VP8X'].map((c) => c.charCodeAt(0)),
    12
  )
  out[20] = flags
  return out
}

describe('animated picture detection', () => {
  it('GIF: one frame is still, two frames are animated', () => {
    expect(isAnimatedGif(gif(1))).toBe(false)
    expect(isAnimatedGif(gif(2))).toBe(true)
    expect(isAnimatedGif(gif(5))).toBe(true)
    expect(isAnimatedGif(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isAnimatedGif(new TextEncoder().encode('GIF89a-not-really-a-gif'))).toBe(false)
  })

  it('WebP: the VP8X animation flag', () => {
    expect(isAnimatedWebp(webp(0x02))).toBe(true)
    expect(isAnimatedWebp(webp(0x10))).toBe(false)
    expect(isAnimatedWebp(new Uint8Array(10))).toBe(false)
  })
})
