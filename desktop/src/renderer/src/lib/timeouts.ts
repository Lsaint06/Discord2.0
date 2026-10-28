/** Member timeouts (Milestone 13): the choices offered and how the remaining time is shown. */
import { formatTime, formatTimestamp } from './format'

export const TIMEOUT_CHOICES: readonly { label: string; minutes: number }[] = [
  { label: '60 seconds', minutes: 1 },
  { label: '5 minutes', minutes: 5 },
  { label: '10 minutes', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '1 week', minutes: 7 * 24 * 60 }
]

export const isTimedOut = (until: number | null | undefined, now = Date.now()): boolean =>
  typeof until === 'number' && until > now

/** "1 hour", "10 minutes", "3 days" — a timeout's length for the audit log. */
export function timeoutLength(minutes: number): string {
  const choice = TIMEOUT_CHOICES.find((c) => c.minutes === minutes)
  if (choice) return choice.label
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  if (minutes < 24 * 60 || minutes % (24 * 60) !== 0) {
    const hours = Math.round(minutes / 6) / 10
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = minutes / (24 * 60)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** "45 s", "4 min", "2 h 5 min", "3 days" — or null when not (or no longer) timed out. */
export function timeoutRemaining(
  until: number | null | undefined,
  now = Date.now()
): string | null {
  if (!isTimedOut(until, now)) return null
  const seconds = Math.ceil((until! - now) / 1000)
  if (seconds < 60) return `${seconds} s`
  // Short timeouts round up (never "0 min"); longer ones to the nearest minute, so a fresh
  // 1-hour timeout seen with a slightly old clock still reads "1 h".
  const minutes = seconds < 3600 ? Math.ceil(seconds / 60) : Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `${hours} h ${rest} min` : `${hours} h`
  }
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** The composer's explanation while you're timed out in a server (undefined when you aren't). */
export function timeoutNotice(
  until: number | null | undefined,
  now = Date.now()
): string | undefined {
  if (!isTimedOut(until, now)) return undefined
  const end = until! - now > 20 * 3_600_000 ? formatTimestamp(until!) : formatTime(until!)
  return `You’re timed out in this server until ${end}. You can still read.`
}
