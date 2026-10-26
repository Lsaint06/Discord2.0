import { LIMITS } from '../protocol.js'
import { badRequest } from './errors.js'

// C0/C1 control characters except tab (\t) and newline (\n).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
// Bidi overrides can be abused to disguise text direction.
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g

export function normalizeMessageContent(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('content must be a string', 'invalid_content')
  const content = input
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_OVERRIDES, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (content.length === 0) throw badRequest('Message cannot be empty', 'empty_message')
  if (content.length > LIMITS.messageMaxLength) {
    throw badRequest(
      `Message exceeds ${LIMITS.messageMaxLength} characters`,
      'message_too_long'
    )
  }
  return content
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
