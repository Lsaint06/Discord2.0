/**
 * Password rules (NIST SP 800-63B style): long passphrases welcome, no composition rules,
 * no forced rotation, but reject very common and trivially guessable passwords.
 */
import { LIMITS } from '../protocol.js'

// A small offline blocklist of very common passwords that satisfy the minimum length.
// (There is no breached-password API call: the Jetson stays offline-capable.)
const COMMON = new Set(
  [
    '123456789012',
    '1234567890123',
    '12345678901234',
    '123456123456',
    '111111111111',
    '000000000000',
    '123123123123',
    'password1234',
    'password12345',
    'password123456',
    'passwordpassword',
    'password!123',
    'p@ssw0rd1234',
    'qwertyuiop12',
    'qwertyuiop123',
    'qwerty123456',
    'qwertyqwerty',
    '1q2w3e4r5t6y',
    '1qaz2wsx3edc',
    'zaq12wsxcde3',
    'zxcvbnm12345',
    'asdfghjkl123',
    'abcdefghijkl',
    'abcdef123456',
    'abc123abc123',
    'iloveyou1234',
    'letmein12345',
    'welcome12345',
    'welcome123456',
    'changeme1234',
    'administrator',
    'admin1234567',
    'football1234',
    'baseball1234',
    'starwars1234',
    'trustno11234',
    'sunshine1234',
    'princess1234',
    'monkey123456',
    'dragon123456',
    'master123456',
    'superman1234',
    'iloveyouiloveyou',
    'correcthorsebatterystaple',
    'discord12345',
    'discord2.0123',
    'discordpassword'
  ].map((p) => p.toLowerCase())
)

const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/** Unicode NFC so the same passphrase typed on different keyboards hashes the same. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC')
}

/** Returns a user-facing problem, or null if the new password is acceptable. */
export function passwordProblem(
  raw: string,
  context: { username?: string; displayName?: string } = {}
): string | null {
  const password = normalizePassword(raw)
  const length = [...password].length
  if (length < LIMITS.passwordMinLength) {
    return `Use at least ${LIMITS.passwordMinLength} characters. A few random words work well.`
  }
  if (length > LIMITS.passwordMaxLength) {
    return `Use at most ${LIMITS.passwordMaxLength} characters.`
  }
  const lower = password.toLowerCase()
  if (COMMON.has(lower)) return 'That password is too common. Pick something less predictable.'
  if (new Set(lower).size <= 2) return 'That password is too repetitive.'
  if (SEQUENCES.some((s) => s.includes(lower) || lower === s)) {
    return 'That password is a simple sequence.'
  }
  const username = context.username?.toLowerCase()
  if (username && (lower === username || (lower.includes(username) && length < username.length + 6))) {
    return 'Your password can’t be based on your username.'
  }
  const display = context.displayName?.toLowerCase()
  if (display && display.length >= 4 && lower === display) {
    return 'Your password can’t be your display name.'
  }
  return null
}
