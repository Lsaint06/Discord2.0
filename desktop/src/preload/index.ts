import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppMetrics,
  CredentialStorage,
  D2DesktopApi,
  DownloadProgress,
  EncoderFlagsState,
  LifecycleState,
  MicrophoneAccess,
  OverlayDisplay,
  OverlayUpdateResult,
  ScreenCaptureCapabilities,
  ScreenSelectResult,
  ScreenSourceInfo,
  StoredCredentials,
  SystemIdleState,
  UiZoomState
} from './types'

/**
 * Narrow, typed bridge for Discord 2.0 features. No raw IPC (send/invoke/on) is exposed to the
 * renderer; every channel below is validated again in the main process.
 */
const d2: D2DesktopApi = {
  platform: process.platform,
  credentials: {
    load: () => ipcRenderer.invoke('d2:credentials-load') as Promise<StoredCredentials | null>,
    save: (value) =>
      ipcRenderer.invoke('d2:credentials-save', {
        token: String(value.token),
        serverUrl: String(value.serverUrl),
        username: String(value.username)
      }) as Promise<boolean>,
    clear: () => ipcRenderer.invoke('d2:credentials-clear') as Promise<void>,
    info: () =>
      ipcRenderer.invoke('d2:credentials-info') as Promise<{
        storage: CredentialStorage
        device: string
      } | null>
  },
  media: {
    getMicrophoneAccess: () => ipcRenderer.invoke('d2:mic-access') as Promise<MicrophoneAccess>,
    openMicrophoneSettings: () => ipcRenderer.invoke('d2:open-mic-settings') as Promise<boolean>,
    getCameraAccess: () => ipcRenderer.invoke('d2:camera-access') as Promise<MicrophoneAccess>,
    openCameraSettings: () => ipcRenderer.invoke('d2:open-camera-settings') as Promise<boolean>
  },
  overlay: {
    getDisplays: () =>
      ipcRenderer.invoke('d2:overlay-displays') as Promise<OverlayDisplay[] | null>,
    update: (command) =>
      ipcRenderer.invoke('d2:overlay-update', {
        visible: command.visible === true,
        mode: command.mode === 'edit' ? 'edit' : 'view',
        bounds: {
          x: Number(command.bounds.x),
          y: Number(command.bounds.y),
          width: Number(command.bounds.width),
          height: Number(command.bounds.height)
        }
      }) as Promise<OverlayUpdateResult | null>,
    close: () => ipcRenderer.invoke('d2:overlay-close') as Promise<void>,
    onEvent: (callback) => {
      const listener = (_event: unknown, payload: unknown): void => {
        const p = payload as { type?: unknown; bounds?: Record<string, unknown> } | null
        if (p?.type === 'moved' && p.bounds) {
          callback({
            type: 'moved',
            bounds: {
              x: Number(p.bounds.x) || 0,
              y: Number(p.bounds.y) || 0,
              width: Number(p.bounds.width) || 0,
              height: Number(p.bounds.height) || 0
            }
          })
        } else if (p?.type === 'displays' || p?.type === 'closed') {
          callback({ type: p.type })
        }
      }
      ipcRenderer.on('d2:overlay-event', listener)
      return () => ipcRenderer.removeListener('d2:overlay-event', listener)
    }
  },
  screen: {
    getCapabilities: () =>
      ipcRenderer.invoke('d2:screen-capabilities') as Promise<ScreenCaptureCapabilities | null>,
    getSources: () => ipcRenderer.invoke('d2:screen-sources') as Promise<ScreenSourceInfo[]>,
    select: (sourceId, options) =>
      ipcRenderer.invoke('d2:screen-select', sourceId, {
        audio: options.audio === true
      }) as Promise<ScreenSelectResult>,
    cancel: () => ipcRenderer.invoke('d2:screen-cancel') as Promise<void>
  },
  diagnostics: {
    getAppMetrics: () => ipcRenderer.invoke('d2:app-metrics') as Promise<AppMetrics | null>,
    getEncoderFlags: () =>
      ipcRenderer.invoke('d2:encoder-flags') as Promise<EncoderFlagsState | null>,
    setEncoderFlags: (flags) =>
      ipcRenderer.invoke('d2:encoder-flags-set', {
        av1HardwareEncode: flags.av1HardwareEncode === true
      }) as Promise<EncoderFlagsState | null>,
    relaunch: () => ipcRenderer.invoke('d2:app-relaunch') as Promise<void>
  },
  pushToTalk: {
    register: (accelerator) =>
      ipcRenderer.invoke('d2:ptt-register', accelerator) as Promise<boolean>,
    unregister: () => ipcRenderer.invoke('d2:ptt-unregister') as Promise<void>,
    onToggle: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('d2:ptt-toggle', listener)
      return () => ipcRenderer.removeListener('d2:ptt-toggle', listener)
    }
  },
  system: {
    getIdleState: (thresholdSeconds) =>
      ipcRenderer.invoke(
        'd2:idle-state',
        Math.round(Number(thresholdSeconds))
      ) as Promise<SystemIdleState>
  },
  net: {
    lastError: (origin) =>
      ipcRenderer.invoke('d2:net-last-error', String(origin)) as Promise<string | null>
  },
  uiZoom: {
    get: () => ipcRenderer.invoke('d2:ui-zoom-get') as Promise<UiZoomState | null>,
    set: (factor) =>
      ipcRenderer.invoke('d2:ui-zoom-set', Number(factor)) as Promise<{ factor: number } | null>,
    onChange: (callback) => {
      const listener = (_event: unknown, factor: unknown): void => {
        if (typeof factor === 'number') callback(factor)
      }
      ipcRenderer.on('d2:ui-zoom-changed', listener)
      return () => ipcRenderer.removeListener('d2:ui-zoom-changed', listener)
    }
  },
  shortcuts: {
    setGlobal: (list) =>
      ipcRenderer.invoke(
        'd2:shortcuts-set',
        list.slice(0, 4).map((s) => ({ id: String(s.id), accelerator: String(s.accelerator) }))
      ) as Promise<Record<string, boolean> | null>,
    onTriggered: (callback) => {
      const listener = (_event: unknown, id: unknown): void => {
        if (typeof id === 'string') callback(id)
      }
      ipcRenderer.on('d2:shortcut', listener)
      return () => ipcRenderer.removeListener('d2:shortcut', listener)
    }
  },
  downloads: {
    start: (url, authorization) =>
      ipcRenderer.invoke('d2:download-file', {
        url: String(url),
        authorization: String(authorization)
      }) as Promise<boolean>,
    onProgress: (callback) => {
      const listener = (_event: unknown, progress: unknown): void => {
        const p = progress as Partial<DownloadProgress> | null
        if (p && typeof p.url === 'string' && typeof p.state === 'string') {
          callback({
            url: p.url,
            state: p.state,
            received: Number(p.received) || 0,
            total: Number(p.total) || 0
          })
        }
      }
      ipcRenderer.on('d2:download-progress', listener)
      return () => ipcRenderer.removeListener('d2:download-progress', listener)
    }
  },
  lifecycle: {
    get: () => ipcRenderer.invoke('d2:lifecycle-get') as Promise<LifecycleState | null>,
    set: (patch) =>
      ipcRenderer.invoke('d2:lifecycle-set', {
        ...(typeof patch.closeToTray === 'boolean' ? { closeToTray: patch.closeToTray } : {}),
        ...(typeof patch.startMinimized === 'boolean'
          ? { startMinimized: patch.startMinimized }
          : {}),
        ...(typeof patch.launchAtLogin === 'boolean' ? { launchAtLogin: patch.launchAtLogin } : {})
      }) as Promise<LifecycleState | null>,
    attention: (badge, flash) =>
      ipcRenderer.invoke('d2:attention', {
        badge: Math.max(0, Math.floor(Number(badge) || 0)),
        flash: flash === true
      }) as Promise<boolean>,
    showWindow: () => ipcRenderer.invoke('d2:window-show') as Promise<boolean>
  }
}

// Context isolation is always on (Electron default); the bridge is the only thing exposed.
// Not in the camera overlay window (about:blank, opened by the app itself): it never needs it.
if (location.href !== 'about:blank') contextBridge.exposeInMainWorld('d2', d2)
