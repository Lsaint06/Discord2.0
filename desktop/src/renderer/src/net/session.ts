import type { UserSettings } from '../types'
import { defaultSettings } from '../data/defaults'

/**
 * Session storage. The bearer token is kept by the Electron main process, encrypted with the OS
 * (DPAPI on Windows) — never in localStorage. Outside Electron (browser development) it lives
 * in memory only. Settings are not secret and stay in localStorage.
 */
export interface StoredSession {
  token: string
  serverUrl: string
  username: string
}

const LEGACY_SESSION_KEY = 'd2.session'
const SETTINGS_KEY = 'd2.settings'
/** Pre-Milestone-8 appearance/status settings waiting to be copied to the account once. */
const LEGACY_APPEARANCE_KEY = 'd2.legacyAppearance'
const LEGACY_APPEARANCE_FIELDS = [
  'status',
  'customStatus',
  'compactMode',
  'showTimestamps',
  'accentColor'
]
let memory: StoredSession | null = null

export type SessionStorageKind = 'encrypted' | 'memory'

export async function loadSession(serverUrl: string): Promise<StoredSession | null> {
  const bridge = window.d2?.credentials
  let session: StoredSession | null = bridge ? await bridge.load() : memory
  // One-time move of a pre-Milestone-7 (plaintext localStorage) session into protected storage.
  const legacy = localStorage.getItem(LEGACY_SESSION_KEY)
  if (legacy !== null) {
    localStorage.removeItem(LEGACY_SESSION_KEY)
    if (!session) {
      try {
        const parsed = JSON.parse(legacy) as StoredSession
        if (typeof parsed?.token === 'string' && typeof parsed.serverUrl === 'string') {
          session = {
            token: parsed.token,
            serverUrl: parsed.serverUrl,
            username: String(parsed.username ?? '')
          }
          await saveSession(session)
        }
      } catch {
        // Corrupt entry; ignore.
      }
    }
  }
  return session && session.serverUrl === serverUrl ? session : null
}

export async function saveSession(session: StoredSession): Promise<void> {
  const bridge = window.d2?.credentials
  if (bridge) await bridge.save(session)
  else memory = session
}

export async function clearSession(): Promise<void> {
  memory = null
  localStorage.removeItem(LEGACY_SESSION_KEY)
  await window.d2?.credentials.clear()
}

export async function storageInfo(): Promise<{ storage: SessionStorageKind; device: string }> {
  const info = await window.d2?.credentials.info()
  return info ?? { storage: 'memory', device: 'Browser' }
}

export function loadSettings(): UserSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>
    // Settings that moved to the account in Milestone 8: set them aside for a one-time upload.
    const legacy = Object.fromEntries(
      LEGACY_APPEARANCE_FIELDS.filter((k) => k in parsed).map((k) => [k, parsed[k]])
    )
    if (Object.keys(legacy).length > 0 && localStorage.getItem(LEGACY_APPEARANCE_KEY) === null) {
      localStorage.setItem(LEGACY_APPEARANCE_KEY, JSON.stringify(legacy))
    }
    const settings = { ...defaultSettings }
    for (const key of Object.keys(defaultSettings) as (keyof UserSettings)[]) {
      if (key in parsed) (settings as Record<string, unknown>)[key] = parsed[key]
    }
    return settings
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: UserSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

/** The set-aside pre-Milestone-8 appearance settings (raw), if any. */
export function readLegacyAppearance(): unknown {
  try {
    const raw = localStorage.getItem(LEGACY_APPEARANCE_KEY)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearLegacyAppearance(): void {
  localStorage.removeItem(LEGACY_APPEARANCE_KEY)
}
