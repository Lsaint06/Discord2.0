export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface D2DesktopApi {
  platform: string
  media: {
    /** OS-level microphone privacy status (Windows/macOS); 'unknown' elsewhere. */
    getMicrophoneAccess: () => Promise<MicrophoneAccess>
    /** Opens the OS microphone privacy settings page. */
    openMicrophoneSettings: () => Promise<boolean>
  }
  pushToTalk: {
    /** Registers one system-wide shortcut (Electron accelerator). Resolves false if unavailable. */
    register: (accelerator: string) => Promise<boolean>
    unregister: () => Promise<void>
    /** Fires on each press of the registered shortcut. Returns an unsubscribe function. */
    onToggle: (callback: () => void) => () => void
  }
}
