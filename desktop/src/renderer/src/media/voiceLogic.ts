import { DisconnectReason } from 'livekit-client'

/**
 * Pure voice/media logic (no DOM, no LiveKit room) so it can be unit tested.
 */

export type VoiceStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

/** Whether an unexpected disconnect should trigger an automatic rejoin with a fresh token. */
export function shouldAutoRejoin(reason: DisconnectReason | undefined): boolean {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.USER_REJECTED:
      return false
    default:
      // Network loss, server shutdown/restart, signal close, timeouts, media failures, unknown.
      return true
  }
}

export function describeDisconnect(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined voice from another window or device.'
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the voice channel.'
    case DisconnectReason.ROOM_DELETED:
      return 'The voice channel was closed.'
    case DisconnectReason.SERVER_SHUTDOWN:
      return 'The voice server restarted.'
    case DisconnectReason.JOIN_FAILURE:
      return 'Could not join the voice channel.'
    default:
      return 'Voice connection lost.'
  }
}

export const REJOIN_MAX_ATTEMPTS = 8

/** Exponential backoff with ±30% jitter, capped at 30 s. `random` is injectable for tests. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.7 + random() * 0.6))
}

export interface MicState {
  muted: boolean
  deafened: boolean
  pushToTalk: boolean
  pushToTalkActive: boolean
}

/** Deafen implies mute; in push-to-talk mode audio only flows while the key is held. */
export function micShouldTransmit(s: MicState): boolean {
  if (s.muted || s.deafened) return false
  return s.pushToTalk ? s.pushToTalkActive : true
}

/** Linear gain for a remote participant from master and per-user percentages (0–200). */
export function playbackVolume(outputPercent: number, userPercent = 100): number {
  const clamp = (v: number): number => Math.min(200, Math.max(0, v))
  return (clamp(outputPercent) / 100) * (clamp(userPercent) / 100)
}

/**
 * The map without `userId`'s entry, if that entry `matches`; otherwise the same object (so React
 * skips the update). Used to take yourself out of the voice state the moment you leave.
 */
export function withoutUser<T>(
  map: Record<string, T>,
  userId: string,
  matches: (value: T) => boolean
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(map, userId) || !matches(map[userId])) return map
  const next = { ...map }
  delete next[userId]
  return next
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight'
])

/** Keys that never produce text, so they can act as push-to-talk even while typing. */
export function isNonTypingKey(code: string): boolean {
  return (
    /^F([1-9]|1\d|2[0-4])$/.test(code) ||
    MODIFIER_CODES.has(code) ||
    ['Pause', 'ScrollLock', 'Insert', 'CapsLock', 'ContextMenu'].includes(code)
  )
}

export function isValidPushToTalkKey(code: string): boolean {
  return code !== 'Escape' && code !== 'Tab' && code !== 'Enter' && code.length > 0
}

const NAMED_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/** Maps a KeyboardEvent.code to an Electron accelerator, or null if it can't be a global shortcut. */
export function codeToAccelerator(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit(\d)$/.exec(code)
  if (m) return m[1]
  m = /^Numpad(\d)$/.exec(code)
  if (m) return `num${m[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code] ?? null
}

/** Human-readable label for a KeyboardEvent.code. */
export function describeKey(code: string): string {
  const accel = codeToAccelerator(code)
  if (accel) return accel.startsWith('num') ? `Numpad ${accel.slice(3)}` : accel
  return code.replace(/(Left|Right)$/, ' $1')
}
