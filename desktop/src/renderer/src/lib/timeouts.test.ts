import { describe, expect, it } from 'vitest'
import {
  TIMEOUT_CHOICES,
  isTimedOut,
  timeoutLength,
  timeoutNotice,
  timeoutRemaining
} from './timeouts'

describe('member timeouts', () => {
  const now = 1_000_000_000

  it('knows when a timeout is running', () => {
    expect(isTimedOut(now + 1, now)).toBe(true)
    expect(isTimedOut(now, now)).toBe(false)
    expect(isTimedOut(null, now)).toBe(false)
    expect(isTimedOut(undefined, now)).toBe(false)
  })

  it('formats the remaining time', () => {
    expect(timeoutRemaining(now + 45_000, now)).toBe('45 s')
    expect(timeoutRemaining(now + 4 * 60_000, now)).toBe('4 min')
    expect(timeoutRemaining(now + 3 * 60_000 + 1, now)).toBe('4 min')
    expect(timeoutRemaining(now + 2 * 3_600_000 + 5 * 60_000, now)).toBe('2 h 5 min')
    expect(timeoutRemaining(now + 3_600_000, now)).toBe('1 h')
    expect(timeoutRemaining(now + 3_600_000 + 15_000, now)).toBe('1 h')
    expect(timeoutRemaining(now + 59 * 60_000 + 30_000, now)).toBe('1 h')
    expect(timeoutRemaining(now + 3 * 86_400_000, now)).toBe('3 days')
    expect(timeoutRemaining(now + 86_400_000, now)).toBe('1 day')
    expect(timeoutRemaining(now - 1, now)).toBeNull()
  })

  it('offers choices within the server limit (28 days)', () => {
    expect(TIMEOUT_CHOICES.every((c) => c.minutes >= 1 && c.minutes <= 28 * 24 * 60)).toBe(true)
  })

  it('describes a timeout length for the audit log', () => {
    expect(timeoutLength(60)).toBe('1 hour')
    expect(timeoutLength(7)).toBe('7 minutes')
    expect(timeoutLength(90)).toBe('1.5 hours')
    expect(timeoutLength(3 * 24 * 60)).toBe('3 days')
  })

  it('explains the read-only composer only while timed out', () => {
    expect(timeoutNotice(now + 60_000, now)).toMatch(
      /^You’re timed out in this server until .+\. You can still read\.$/
    )
    expect(timeoutNotice(now - 1, now)).toBeUndefined()
    expect(timeoutNotice(null, now)).toBeUndefined()
  })
})
