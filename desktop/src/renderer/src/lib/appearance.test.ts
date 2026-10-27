import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeStatusExpiry,
  legacyAppearanceFrom,
  readableOn,
  resolveReducedMotion,
  resolveTheme,
  statusExpiryMs
} from './appearance'
import { clampCrop, coverScale, initialCrop, sourceRect, zoomCrop } from './crop'
import { parseProfileMediaKey, profileMediaKey } from './profileMedia'

describe('appearance', () => {
  it('resolves the theme and reduced motion, following the system when asked', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveReducedMotion('system', true)).toBe(true)
    expect(resolveReducedMotion('off', true)).toBe(false)
    expect(resolveReducedMotion('on', false)).toBe(true)
  })

  it('picks readable text for accent colors', () => {
    expect(readableOn('#6d72f6')).toBe('#ffffff')
    expect(readableOn('#f5f5a0')).toBe('#000000')
    expect(readableOn('not-a-color')).toBe('#ffffff')
  })
})

describe('custom status expiry', () => {
  it('converts the menu choices into relative durations', () => {
    const now = new Date(2026, 9, 26, 23, 30, 0)
    expect(statusExpiryMs('never', now)).toBeNull()
    expect(statusExpiryMs('30m', now)).toBe(30 * 60_000)
    expect(statusExpiryMs('1h', now)).toBe(60 * 60_000)
    expect(statusExpiryMs('4h', now)).toBe(4 * 60 * 60_000)
    expect(statusExpiryMs('today', now)).toBe(30 * 60_000)
    // A minute before midnight still gets the server's one-minute minimum.
    expect(statusExpiryMs('today', new Date(2026, 9, 26, 23, 59, 30))).toBe(60_000)
  })

  it('describes when a status clears', () => {
    const now = new Date(2026, 9, 26, 12, 0, 0).getTime()
    expect(describeStatusExpiry(null, now)).toBeNull()
    expect(describeStatusExpiry(now + 25 * 60_000, now)).toBe('Clears in 25 minutes')
    expect(describeStatusExpiry(now + 60_000, now)).toBe('Clears in 1 minute')
    expect(describeStatusExpiry(now + 3 * 60 * 60_000, now)).toMatch(/^Clears at /)
    expect(describeStatusExpiry(now - 1, now)).toBe('Clearing…')
  })
})

describe('moving pre-Milestone-8 local settings to the account', () => {
  it('ignores defaults and garbage', () => {
    expect(legacyAppearanceFrom(null, '#6d72f6')).toBeNull()
    expect(legacyAppearanceFrom('x', '#6d72f6')).toBeNull()
    expect(
      legacyAppearanceFrom(
        {
          status: 'online',
          customStatus: '  ',
          compactMode: false,
          showTimestamps: true,
          accentColor: '#6D72F6'
        },
        '#6d72f6'
      )
    ).toBeNull()
    expect(
      legacyAppearanceFrom({ accentColor: 'javascript:alert(1)', status: 'away' }, '#6d72f6')
    ).toBeNull()
  })

  it('carries over changed appearance, status and custom status', () => {
    expect(
      legacyAppearanceFrom(
        {
          status: 'dnd',
          customStatus: ' Studying ',
          compactMode: true,
          showTimestamps: false,
          accentColor: '#E0607E'
        },
        '#6d72f6'
      )
    ).toEqual({
      preferences: { accentColor: '#e0607e', density: 'compact', showTimestamps: false },
      status: 'dnd',
      customStatus: 'Studying'
    })
  })
})

describe('session settings storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('sets the old appearance keys aside once and keeps only device settings', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
    store.set(
      'd2.settings',
      JSON.stringify({
        fontSize: 17,
        compactMode: true,
        status: 'idle',
        accentColor: '#3ba776',
        bogus: 1
      })
    )
    const session = await import('../net/session')
    const settings = session.loadSettings()
    expect(settings.fontSize).toBe(17)
    expect(settings).not.toHaveProperty('compactMode')
    expect(settings).not.toHaveProperty('bogus')
    expect(session.readLegacyAppearance()).toEqual({
      status: 'idle',
      compactMode: true,
      accentColor: '#3ba776'
    })

    // Saving drops the old keys; loading again doesn't overwrite what was set aside.
    session.saveSettings(settings)
    session.loadSettings()
    expect(session.readLegacyAppearance()).toEqual({
      status: 'idle',
      compactMode: true,
      accentColor: '#3ba776'
    })
    session.clearLegacyAppearance()
    expect(session.readLegacyAppearance()).toBeNull()
  })
})

describe('image cropping', () => {
  const wide = { width: 2000, height: 1000 }
  const square = { width: 300, height: 300 }

  it('starts centered, covering the frame', () => {
    const crop = initialCrop(wide, square)
    expect(coverScale(wide, square)).toBeCloseTo(0.3)
    expect(crop).toEqual({ zoom: 1, x: -150, y: 0 })
    expect(sourceRect(wide, square, crop)).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000 })
  })

  it('never leaves a gap inside the frame and keeps zoom in range', () => {
    expect(clampCrop(wide, square, { zoom: 1, x: 50, y: 50 })).toEqual({ zoom: 1, x: 0, y: 0 })
    expect(clampCrop(wide, square, { zoom: 1, x: -9999, y: -9999 })).toEqual({
      zoom: 1,
      x: -300,
      y: 0
    })
    expect(clampCrop(wide, square, { zoom: 10, x: 0, y: 0 }).zoom).toBe(4)
    expect(clampCrop(wide, square, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1)
  })

  it('zooms around the center of the frame', () => {
    const zoomed = zoomCrop(wide, square, initialCrop(wide, square), 2)
    const rect = sourceRect(wide, square, zoomed)
    expect(rect.sw).toBeCloseTo(500)
    expect(rect.sx + rect.sw / 2).toBeCloseTo(1000)
    expect(rect.sy + rect.sh / 2).toBeCloseTo(500)
  })

  it('maps banner frames to the right aspect ratio', () => {
    const banner = { width: 500, height: 200 }
    const photo = { width: 1200, height: 1600 }
    const rect = sourceRect(photo, banner, initialCrop(photo, banner))
    expect(rect.sw / rect.sh).toBeCloseTo(2.5)
    expect(rect.sw).toBeCloseTo(1200)
  })
})

describe('profile media cache keys', () => {
  it('round-trips ids and sizes', () => {
    expect(parseProfileMediaKey(profileMediaKey('abc', 'full'))).toEqual({
      id: 'abc',
      size: 'full'
    })
    expect(parseProfileMediaKey(profileMediaKey('abc', 'small'))).toEqual({
      id: 'abc',
      size: 'small'
    })
    expect(parseProfileMediaKey('abc:weird').size).toBe('small')
  })
})
