import { describe, expect, it } from 'vitest'
import { DEFAULT_LIFECYCLE, parseAttention, parseLifecyclePrefs } from './lifecycleLogic'

describe('Windows lifecycle settings', () => {
  it('defaults change nothing: close quits, nothing starts hidden or at login', () => {
    expect(DEFAULT_LIFECYCLE).toEqual({
      closeToTray: false,
      startMinimized: false,
      launchAtLogin: false
    })
    expect(parseLifecyclePrefs(null)).toEqual(DEFAULT_LIFECYCLE)
    expect(parseLifecyclePrefs('garbage')).toEqual(DEFAULT_LIFECYCLE)
  })

  it('accepts only booleans for known keys; a patch keeps the other values', () => {
    const base = parseLifecyclePrefs({ closeToTray: true })
    expect(base.closeToTray).toBe(true)
    expect(parseLifecyclePrefs({ startMinimized: true }, base)).toEqual({
      closeToTray: true,
      startMinimized: true,
      launchAtLogin: false
    })
    expect(
      parseLifecyclePrefs(
        { launchAtLogin: 'yes', closeToTray: 1, evil: true, __proto__: { x: 1 } },
        base
      )
    ).toEqual(base)
  })

  it('attention: counts are clamped whole numbers, flash only when exactly true', () => {
    expect(parseAttention({ badge: 3, flash: true })).toEqual({ badge: 3, flash: true })
    expect(parseAttention({ badge: -5, flash: 'yes' })).toEqual({ badge: 0, flash: false })
    expect(parseAttention({ badge: 1e9 })).toEqual({ badge: 999, flash: false })
    expect(parseAttention({ badge: 2.7 })).toEqual({ badge: 2, flash: false })
    expect(parseAttention({ badge: 'NaN' })).toBeNull()
    expect(parseAttention(null)).toBeNull()
  })
})
