/**
 * Random secrets (session tokens, invitation/recovery/reset codes) and their verifiers.
 * All secrets come from crypto.randomBytes; only SHA-256 verifiers are stored. Plain SHA-256
 * is appropriate here because every secret has ≥ 80 bits of entropy (unlike passwords).
 */
import { createHash, randomBytes } from 'node:crypto'

/** 256-bit bearer token (base64url, 43 chars). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 128-bit random identifier (hex). Not a secret. */
export function newId(): string {
  return randomBytes(16).toString('hex')
}

// Crockford base32: no I, L, O, U (easy to read aloud and type).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Human-typable code, e.g. "7K3Q-9XTA-M2PD-4WZE-H8RB" (5 groups × 4 chars = 100 bits).
 * 256 is a multiple of 32, so `byte & 31` is uniform.
 */
export function newCode(groups = 5, groupLength = 4): string {
  const bytes = randomBytes(groups * groupLength)
  const chars = [...bytes].map((b) => ALPHABET[b & 31])
  const out: string[] = []
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * groupLength, (g + 1) * groupLength).join(''))
  return out.join('-')
}

/**
 * Canonical form for lookup: upper-case, separators removed, common misreadings fixed
 * (O→0, I/L→1). Returns null if the input can't be a code of the expected length.
 */
export function normalizeCode(input: unknown, length: number): string | null {
  if (typeof input !== 'string' || input.length > length * 3) return null
  const compact = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (compact.length !== length) return null
  for (const ch of compact) if (!ALPHABET.includes(ch)) return null
  return compact
}

/** Verifier stored for a code: SHA-256 of a purpose-prefixed canonical code. */
export function codeVerifier(purpose: 'register' | 'invite' | 'recovery' | 'reset', canonical: string): string {
  return sha256Hex(`${purpose}:${canonical}`)
}

export const CODE_LENGTHS = {
  /** Registration and claim invitations: 100 bits. */
  register: 20,
  /** Server invitations: 80 bits. */
  invite: 16,
  /** Recovery codes: 80 bits. */
  recovery: 16,
  /** Administrator password-reset codes: 100 bits. */
  reset: 20
} as const

export const codeGroups = (purpose: keyof typeof CODE_LENGTHS): number => CODE_LENGTHS[purpose] / 4
