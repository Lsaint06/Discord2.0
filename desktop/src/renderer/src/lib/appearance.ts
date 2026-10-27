/**
 * Pure helpers for appearance, presence and custom status (no DOM access, easy to test).
 */
import type {
  ApiPreferences,
  MessageDensity,
  ReducedMotionPreference,
  SelectableStatus,
  ThemePreference
} from '../net/protocol'
import { LIMITS } from '../net/protocol'

export type ResolvedTheme = 'dark' | 'light'

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean
): ResolvedTheme {
  if (preference === 'system') return systemPrefersLight ? 'light' : 'dark'
  return preference
}

export function resolveReducedMotion(
  preference: ReducedMotionPreference,
  systemPrefersReduced: boolean
): boolean {
  if (preference === 'system') return systemPrefersReduced
  return preference === 'on'
}

export type StatusExpiryOption = 'never' | '30m' | '1h' | '4h' | 'today'

export const STATUS_EXPIRY_LABELS: Record<StatusExpiryOption, string> = {
  never: 'Don’t clear',
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  today: 'Today'
}

/**
 * Milliseconds until the custom status should clear (null = never). "Today" means local
 * midnight; the server needs at least one minute.
 */
export function statusExpiryMs(option: StatusExpiryOption, now: Date): number | null {
  switch (option) {
    case 'never':
      return null
    case '30m':
      return 30 * 60_000
    case '1h':
      return 60 * 60_000
    case '4h':
      return 4 * 60 * 60_000
    case 'today': {
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      return Math.max(60_000, midnight.getTime() - now.getTime())
    }
  }
}

/** "Clears in 25 minutes", "Clears at 11:30 PM", or null for statuses without expiry. */
export function describeStatusExpiry(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null
  const ms = expiresAt - now
  if (ms <= 0) return 'Clearing…'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `Clears in ${minutes} minute${minutes === 1 ? '' : 's'}`
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    expiresAt
  )
  const sameDay = new Date(expiresAt).toDateString() === new Date(now).toDateString()
  return sameDay ? `Clears at ${time}` : `Clears ${new Date(expiresAt).toLocaleDateString()}`
}

/** Settings that existed locally before Milestone 8 and are now synced account preferences. */
export interface LegacyAppearance {
  preferences: Partial<Omit<ApiPreferences, 'updatedAt'>>
  status?: SelectableStatus
  customStatus?: string
}

const STATUSES: readonly SelectableStatus[] = ['online', 'idle', 'dnd', 'invisible']
const COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * Picks the pre-Milestone-8 local appearance/status settings worth carrying over to the
 * account (only values that differ from the defaults). Returns null when there is nothing.
 */
export function legacyAppearanceFrom(raw: unknown, defaultAccent: string): LegacyAppearance | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const preferences: LegacyAppearance['preferences'] = {}
  if (typeof r.accentColor === 'string' && COLOR.test(r.accentColor)) {
    const accent = r.accentColor.toLowerCase()
    if (accent !== defaultAccent.toLowerCase()) preferences.accentColor = accent
  }
  if (r.compactMode === true) preferences.density = 'compact' satisfies MessageDensity
  if (r.showTimestamps === false) preferences.showTimestamps = false
  const out: LegacyAppearance = { preferences }
  if (typeof r.status === 'string' && STATUSES.includes(r.status as SelectableStatus)) {
    if (r.status !== 'online') out.status = r.status as SelectableStatus
  }
  if (typeof r.customStatus === 'string' && r.customStatus.trim()) {
    out.customStatus = r.customStatus.trim().slice(0, LIMITS.customStatusMaxLength)
  }
  const empty =
    Object.keys(preferences).length === 0 &&
    out.status === undefined &&
    out.customStatus === undefined
  return empty ? null : out
}

/** Keeps a hex color readable as text on the current background (used for accent text). */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  if (!COLOR.test(hex)) return '#ffffff'
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return luminance > 0.45 ? '#000000' : '#ffffff'
}
