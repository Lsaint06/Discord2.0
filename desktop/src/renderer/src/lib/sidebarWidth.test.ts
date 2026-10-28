import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  sidebarWidthForKey
} from './sidebarWidth'

describe('sidebar width', () => {
  it('clamps stored values and falls back for garbage', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX)
    expect(clampSidebarWidth(250.6)).toBe(251)
    expect(clampSidebarWidth('300')).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT)
  })

  it('moves with the arrow keys (bigger steps with Shift) and jumps with Home/End', () => {
    expect(sidebarWidthForKey(240, 'ArrowRight', false)).toBe(256)
    expect(sidebarWidthForKey(240, 'ArrowLeft', false)).toBe(224)
    expect(sidebarWidthForKey(240, 'ArrowRight', true)).toBe(304)
    expect(sidebarWidthForKey(SIDEBAR_MIN, 'ArrowLeft', false)).toBe(SIDEBAR_MIN)
    expect(sidebarWidthForKey(300, 'Home', false)).toBe(SIDEBAR_MIN)
    expect(sidebarWidthForKey(300, 'End', false)).toBe(SIDEBAR_MAX)
    expect(sidebarWidthForKey(300, 'Enter', false)).toBeNull()
  })
})
