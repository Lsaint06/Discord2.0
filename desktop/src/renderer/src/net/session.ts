import type { UserSettings } from '../types'
import { defaultSettings } from '../data/defaults'

/**
 * DEVELOPMENT-ONLY session storage. The token is a dev identity with no password;
 * a production build should keep real credentials in the main process (Electron safeStorage).
 */
export interface StoredSession {
  token: string
  serverUrl: string
  username: string
}

const SESSION_KEY = 'd2.session'
const SETTINGS_KEY = 'd2.settings'

export function loadSession(serverUrl: string): StoredSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as StoredSession | null
    if (parsed && typeof parsed.token === 'string' && parsed.serverUrl === serverUrl) return parsed
  } catch {
    // Corrupt entry; fall through.
  }
  return null
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

export function loadSettings(): UserSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<UserSettings>
    return { ...defaultSettings, ...parsed }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: UserSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}
