import type { UserSettings } from '../types'
import { defaultSettings } from '../data/defaults'
import { migrateSoundSettings } from '../sound/soundPolicy'
import { parseKeybinds } from '../lib/keybinds'
import { parseWallpaper, parseWallpaperIntensity } from '../lib/wallpapers'
import { parseOverlaySettings } from '../lib/overlay'
import { parseCameraPreset } from '../media/cameraProfiles'

/**
 * Milestone 14.5 device settings for the camera and the overlay. Unknown keys (for example an
 * old or hand-edited "cameraOn") are ignored: nothing stored can turn the camera on.
 */
export function parseCameraSettings(
  parsed: Record<string, unknown>
): Pick<
  UserSettings,
  | 'cameraDeviceId'
  | 'cameraPreset'
  | 'cameraMirror'
  | 'cameraHideSelf'
  | 'receiveCameras'
  | 'overlay'
> {
  const id = parsed.cameraDeviceId
  return {
    cameraDeviceId: typeof id === 'string' && id.length <= 256 ? id : '',
    cameraPreset: parseCameraPreset(parsed.cameraPreset),
    cameraMirror: typeof parsed.cameraMirror === 'boolean' ? parsed.cameraMirror : true,
    cameraHideSelf: parsed.cameraHideSelf === true,
    receiveCameras: parsed.receiveCameras !== false,
    overlay: parseOverlaySettings(parsed.overlay)
  }
}

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

/** Which server the saved sign-in belongs to (null if none), without using it. */
export async function savedSessionServer(): Promise<string | null> {
  const bridge = window.d2?.credentials
  const session = bridge ? await bridge.load() : memory
  return session?.serverUrl ?? null
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
    // Sound effects (Milestone 9): validated, and carries over the old notificationSounds choice.
    return {
      ...settings,
      ...migrateSoundSettings(parsed),
      keybinds: parseKeybinds(parsed.keybinds),
      serverNotifications: parseServerNotifications(parsed.serverNotifications),
      // Milestone 14 (device settings): anything unexpected falls back to the default.
      themeEffects: parsed.themeEffects === 'reduced' ? 'reduced' : 'full',
      profileEffects: parsed.profileEffects === 'reduced' ? 'reduced' : 'full',
      soundPack:
        typeof parsed.soundPack === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(parsed.soundPack)
          ? parsed.soundPack
          : defaultSettings.soundPack,
      soundboardVolume:
        typeof parsed.soundboardVolume === 'number' && Number.isFinite(parsed.soundboardVolume)
          ? Math.min(100, Math.max(0, Math.round(parsed.soundboardVolume)))
          : defaultSettings.soundboardVolume,
      chatWallpaper: parseWallpaper(parsed.chatWallpaper),
      chatWallpaperIntensity: parseWallpaperIntensity(parsed.chatWallpaperIntensity),
      // Milestone 14.5: validated camera and overlay choices (never a stored "camera on").
      ...parseCameraSettings(parsed)
    }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: UserSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

/** Per-server notification choices: only 'all' / 'mentions' for plausible server ids. */
function parseServerNotifications(raw: unknown): Record<string, 'all' | 'mentions'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, 'all' | 'mentions'> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (id.length <= 64 && (value === 'all' || value === 'mentions')) out[id] = value
  }
  return out
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
