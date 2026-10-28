/**
 * Client-side checks for the sign-in / sign-up forms. They mirror the server's rules so people
 * get instant, specific feedback; the server still decides (and its message is shown if it
 * disagrees).
 */
import { LIMITS } from '../net/protocol'

const USERNAME = /^[a-z0-9_.-]+$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function looksLikeEmail(value: string): boolean {
  const v = value.trim()
  return v.length >= 6 && v.length <= LIMITS.emailMaxLength && EMAIL.test(v)
}

/** A problem with a new username, or null. Same rule as the server (case-insensitive). */
export function usernameProblem(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (v.length < LIMITS.usernameMinLength) {
    return `Use at least ${LIMITS.usernameMinLength} characters.`
  }
  if (v.length > LIMITS.usernameMaxLength)
    return `Use at most ${LIMITS.usernameMaxLength} characters.`
  if (!USERNAME.test(v)) return 'Use only letters, numbers, “.”, “_” or “-” (no spaces).'
  return null
}

export interface PasswordChecks {
  longEnough: boolean
  notUsername: boolean
  matches: boolean
}

export function passwordChecks(password: string, confirm: string, username = ''): PasswordChecks {
  const lower = password.toLowerCase()
  const name = username.trim().toLowerCase()
  return {
    longEnough: [...password].length >= LIMITS.passwordMinLength,
    notUsername:
      !name || (lower !== name && !(lower.includes(name) && lower.length < name.length + 6)),
    matches: password.length > 0 && password === confirm
  }
}

export const passwordOk = (c: PasswordChecks): boolean => c.longEnough && c.notUsername && c.matches

/** Emailed codes: 8 letters/digits shown as "XXXX-XXXX". Formats as you type or paste. */
export const EMAIL_CODE_LENGTH = 8

export function formatEmailCode(raw: string): string {
  const compact = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, EMAIL_CODE_LENGTH)
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

export const emailCodeComplete = (value: string): boolean =>
  value.replace(/[^0-9A-Za-z]/g, '').length === EMAIL_CODE_LENGTH

/** Seconds left on a cooldown that ends at `until` (epoch ms), never negative. */
export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000))
}
