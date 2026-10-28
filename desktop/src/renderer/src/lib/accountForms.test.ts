import { describe, expect, it } from 'vitest'
import {
  emailCodeComplete,
  formatEmailCode,
  looksLikeEmail,
  passwordChecks,
  passwordOk,
  secondsLeft,
  usernameProblem
} from './accountForms'

describe('account form checks', () => {
  it('recognizes plausible email addresses', () => {
    expect(looksLikeEmail('alice@example.com')).toBe(true)
    expect(looksLikeEmail('  Alice+chat@Mail.Example.co.uk ')).toBe(true)
    for (const bad of [
      '',
      'alice',
      'alice@',
      '@example.com',
      'alice@example',
      'a b@example.com',
      'alice@example.c'
    ]) {
      expect(looksLikeEmail(bad)).toBe(false)
    }
  })

  it('mirrors the server username rule', () => {
    expect(usernameProblem('alice_m13')).toBeNull()
    expect(usernameProblem('Alice.Smith')).toBeNull() // stored lower-case
    expect(usernameProblem('a')).toMatch(/at least 2/)
    expect(usernameProblem('x'.repeat(33))).toMatch(/at most 32/)
    expect(usernameProblem('bad name')).toMatch(/no spaces/)
    expect(usernameProblem('émile')).toMatch(/only letters/)
  })

  it('checks password length, username reuse and confirmation', () => {
    expect(
      passwordOk(passwordChecks('violet-anchor-sunrise', 'violet-anchor-sunrise', 'alice'))
    ).toBe(true)
    expect(passwordChecks('short', 'short').longEnough).toBe(false)
    expect(passwordChecks('alice_m13alice', 'x', 'alice_m13').notUsername).toBe(false)
    expect(passwordChecks('alice_m13', 'alice_m13', 'alice_m13').notUsername).toBe(false)
    expect(passwordChecks('long-enough-password', 'long-enough-passwor').matches).toBe(false)
    expect(passwordChecks('', '').matches).toBe(false)
    // Unicode characters count as one each (like the server).
    expect(passwordChecks('🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒', '').longEnough).toBe(true)
  })

  it('formats emailed codes as they are typed or pasted', () => {
    expect(formatEmailCode('7k3q')).toBe('7K3Q')
    expect(formatEmailCode('7k3q9')).toBe('7K3Q-9')
    expect(formatEmailCode(' 7K3Q-9XTA ')).toBe('7K3Q-9XTA')
    expect(formatEmailCode('7k3q 9xta extra')).toBe('7K3Q-9XTA')
    expect(emailCodeComplete('7K3Q-9XTA')).toBe(true)
    expect(emailCodeComplete('7K3Q-9XT')).toBe(false)
  })

  it('counts down cooldowns', () => {
    expect(secondsLeft(10_000, 0)).toBe(10)
    expect(secondsLeft(10_000, 9_001)).toBe(1)
    expect(secondsLeft(10_000, 20_000)).toBe(0)
  })
})
