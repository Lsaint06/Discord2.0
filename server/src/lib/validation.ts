import { LIMITS } from '../protocol.js'
import { badRequest } from './errors.js'

// C0/C1 control characters except tab (\t) and newline (\n).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
// Bidi overrides can be abused to disguise text direction.
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g

export function normalizeMessageContent(input: unknown, options: { allowEmpty?: boolean } = {}): string {
  if (typeof input !== 'string') throw badRequest('content must be a string', 'invalid_content')
  const content = input
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_OVERRIDES, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (content.length === 0 && !options.allowEmpty) {
    throw badRequest('Message cannot be empty', 'empty_message')
  }
  if (content.length > LIMITS.messageMaxLength) {
    throw badRequest(
      `Message exceeds ${LIMITS.messageMaxLength} characters`,
      'message_too_long'
    )
  }
  return content
}

// A reaction must be made only of emoji code points (pictographs, keycaps, flags, skin tones,
// ZWJ sequences, variation selectors) and contain at least one actual emoji.
const EMOJI_CHARS = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F\u20E3]+$/u
const EMOJI_CORE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u

export function normalizeEmoji(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('emoji must be a string', 'invalid_emoji')
  const emoji = input.normalize('NFC')
  if (
    emoji.length === 0 ||
    emoji.length > LIMITS.emojiMaxLength ||
    !EMOJI_CHARS.test(emoji) ||
    !EMOJI_CORE.test(emoji)
  ) {
    throw badRequest('Reactions must be a single Unicode emoji', 'invalid_emoji')
  }
  return emoji
}

/**
 * Builds a safe FTS5 MATCH expression: the query is split into letter/number words, each word is
 * quoted (so FTS operators in user input have no effect) and used as a prefix match. Returns
 * null when the text contains no searchable words.
 */
export function buildSearchMatch(input: unknown): string | null {
  if (input === undefined || input === '') return null
  if (typeof input !== 'string') throw badRequest('q must be a string', 'invalid_query')
  if (input.length > LIMITS.searchQueryMaxLength) {
    throw badRequest(`Search is limited to ${LIMITS.searchQueryMaxLength} characters`, 'invalid_query')
  }
  const words = input.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []
  const unique = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 8)
  if (unique.length === 0) return null
  return unique.map((w) => `"${w}"*`).join(' ')
}

const DAY_MS = 86_400_000

/** Accepts a YYYY-MM-DD date (UTC) and returns epoch ms, optionally the start of the next day. */
export function parseDay(input: unknown, name: string, endOfDay = false): number | undefined {
  if (input === undefined || input === '') return undefined
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw badRequest(`${name} must be a date like 2026-10-26`, 'invalid_date')
  }
  const ms = Date.parse(`${input}T00:00:00Z`)
  if (Number.isNaN(ms)) throw badRequest(`${name} is not a valid date`, 'invalid_date')
  return endOfDay ? ms + DAY_MS : ms
}

const USERNAME = /^[a-z0-9_.-]{2,32}$/

export function normalizeUsername(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('username must be a string', 'invalid_username')
  const username = input.trim().toLowerCase()
  if (!USERNAME.test(username)) {
    throw badRequest(
      'Username must be 2-32 characters: letters, numbers, ".", "_" or "-"',
      'invalid_username'
    )
  }
  return username
}

export function normalizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('displayName must be a string', 'invalid_name')
  const name = input.replace(CONTROL_CHARS, '').replace(BIDI_OVERRIDES, '').replace(/\s+/g, ' ').trim()
  if (name.length < 1 || name.length > LIMITS.displayNameMaxLength) {
    throw badRequest(
      `Display name must be 1-${LIMITS.displayNameMaxLength} characters`,
      'invalid_name'
    )
  }
  return name
}

export function normalizeServerName(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('name must be a string', 'invalid_name')
  const name = input.replace(CONTROL_CHARS, '').replace(BIDI_OVERRIDES, '').replace(/\s+/g, ' ').trim()
  if (name.length < 1 || name.length > LIMITS.serverNameMaxLength) {
    throw badRequest(`Server name must be 1-${LIMITS.serverNameMaxLength} characters`, 'invalid_name')
  }
  return name
}

const COLOR = /^#[0-9a-fA-F]{6}$/

export function normalizeColor(input: unknown): string {
  if (typeof input !== 'string' || !COLOR.test(input)) {
    throw badRequest('Color must be a hex value like #6d72f6', 'invalid_color')
  }
  return input.toLowerCase()
}

const CURSOR = /^\d{1,19}$/

export function parseCursor(input: unknown, name: string): string | undefined {
  if (input === undefined || input === '') return undefined
  if (typeof input !== 'string' || !CURSOR.test(input)) {
    throw badRequest(`${name} must be a message id`, 'invalid_cursor')
  }
  return input
}

export const AVATAR_PALETTE = [
  '#e0607e',
  '#3ba776',
  '#f0a43a',
  '#4aa3df',
  '#9b6bd6',
  '#56b3a5',
  '#d9734e',
  '#c4579b',
  '#6d72f6'
]

export function colorForName(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!
}
