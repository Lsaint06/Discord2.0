export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface ScreenSourceInfo {
  /** desktopCapturer id, e.g. `screen:0:0` or `window:1234:0`. */
  id: string
  name: string
  kind: 'screen' | 'window'
  /** JPEG data URL, or null if the source couldn't be thumbnailed (e.g. minimized window). */
  thumbnail: string | null
  appIcon: string | null
  /** Physical pixel size for screens (undefined for windows). */
  width?: number
  height?: number
  primary?: boolean
}

export type ScreenSelectResult =
  | { ok: true; name: string; kind: 'screen' | 'window' }
  | { ok: false; error: 'invalid-source' | 'source-gone' }

export interface ScreenCaptureCapabilities {
  platform: string
  /** System (loopback) audio capture is available (Windows). */
  systemAudio: boolean
  /** The OS lets Chromium exclude our own playback from loopback audio (Windows 11). */
  excludeOwnAudio: boolean
}

export interface AppMetrics {
  processes: { type: string; cpuPercent: number; memoryMB: number }[]
  gpuVendor?: string
  /** Chromium GPU feature status, e.g. "enabled" or "disabled_software". */
  videoEncode?: string
  videoDecode?: string
}

export interface EncoderFlags {
  /** Allow Chromium's GPU AV1 encoder for WebRTC (feature WebRtcAV1HWEncode). */
  av1HardwareEncode: boolean
}

export interface EncoderFlagsState {
  /** Stored preference (applies on next launch). */
  saved: EncoderFlags
  /** What this running app was started with. */
  active: EncoderFlags
}

export type CredentialStorage = 'encrypted' | 'memory'

export interface StoredCredentials {
  token: string
  serverUrl: string
  username: string
}

export interface D2DesktopApi {
  platform: string
  credentials: {
    /** The saved session for this profile, if any (decrypted in the main process). */
    load: () => Promise<StoredCredentials | null>
    save: (value: StoredCredentials) => Promise<boolean>
    clear: () => Promise<void>
    /** 'encrypted' = OS-protected file (DPAPI on Windows); 'memory' = not persisted. */
    info: () => Promise<{ storage: CredentialStorage; device: string } | null>
  }
  media: {
    /** OS-level microphone privacy status (Windows/macOS); 'unknown' elsewhere. */
    getMicrophoneAccess: () => Promise<MicrophoneAccess>
    /** Opens the OS microphone privacy settings page. */
    openMicrophoneSettings: () => Promise<boolean>
  }
  screen: {
    getCapabilities: () => Promise<ScreenCaptureCapabilities | null>
    /** Screens and application windows that can be shared (excludes Discord 2.0 itself). */
    getSources: () => Promise<ScreenSourceInfo[]>
    /**
     * Arms one user-chosen source for the next getDisplayMedia() call (one-time, ~15 s).
     * Capture is denied unless a source has been selected this way.
     */
    select: (sourceId: string, options: { audio: boolean }) => Promise<ScreenSelectResult>
    cancel: () => Promise<void>
  }
  diagnostics: {
    getAppMetrics: () => Promise<AppMetrics | null>
    getEncoderFlags: () => Promise<EncoderFlagsState | null>
    setEncoderFlags: (flags: EncoderFlags) => Promise<EncoderFlagsState | null>
    /** Restarts the app (needed for encoder flag changes). */
    relaunch: () => Promise<void>
  }
  pushToTalk: {
    /** Registers one system-wide shortcut (Electron accelerator). Resolves false if unavailable. */
    register: (accelerator: string) => Promise<boolean>
    unregister: () => Promise<void>
    /** Fires on each press of the registered shortcut. Returns an unsubscribe function. */
    onToggle: (callback: () => void) => () => void
  }
  system: {
    /**
     * 'idle' when there was no keyboard/mouse input on the PC for `thresholdSeconds`
     * (60–7200), 'locked' when the screen is locked.
     */
    getIdleState: (thresholdSeconds: number) => Promise<SystemIdleState>
  }
  net: {
    /**
     * Chromium's error code (e.g. "ERR_CERT_DATE_INVALID", "ERR_NAME_NOT_RESOLVED") of the most
     * recent failed request to this origin in the last two minutes, or null. Diagnostic only.
     */
    lastError: (origin: string) => Promise<string | null>
  }
  uiZoom: {
    /** Saved interface scale for this device and the allowed steps; null if refused. */
    get: () => Promise<UiZoomState | null>
    /** Sets and saves the scale (must be one of `steps`; anything else resets to default). */
    set: (factor: number) => Promise<{ factor: number } | null>
    /** Fires when the scale changes (settings or Ctrl+=/-/0). Returns an unsubscribe function. */
    onChange: (callback: (factor: number) => void) => () => void
  }
  shortcuts: {
    /**
     * Replaces the system-wide shortcuts (only mute and deafen may be system-wide). Resolves to
     * whether each could be registered (false: invalid, or another app already uses it).
     */
    setGlobal: (
      list: { id: string; accelerator: string }[]
    ) => Promise<Record<string, boolean> | null>
    /** Fires with the command id when a system-wide shortcut is pressed. */
    onTriggered: (callback: (id: string) => void) => () => void
  }
  downloads: {
    /**
     * Saves an attachment to disk through Chromium's download manager (Save dialog, streamed,
     * resumable). Only attachment URLs with an Authorization header are accepted.
     */
    start: (url: string, authorization: string) => Promise<boolean>
    onProgress: (callback: (progress: DownloadProgress) => void) => () => void
  }
}

export interface DownloadProgress {
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
}

export interface UiZoomState {
  factor: number
  steps: number[]
  defaultFactor: number
}

export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown'
