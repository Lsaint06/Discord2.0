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

export interface D2DesktopApi {
  platform: string
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
  }
  pushToTalk: {
    /** Registers one system-wide shortcut (Electron accelerator). Resolves false if unavailable. */
    register: (accelerator: string) => Promise<boolean>
    unregister: () => Promise<void>
    /** Fires on each press of the registered shortcut. Returns an unsubscribe function. */
    onToggle: (callback: () => void) => () => void
  }
}
