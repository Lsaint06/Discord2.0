import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppMetrics,
  CredentialStorage,
  D2DesktopApi,
  DownloadProgress,
  EncoderFlagsState,
  MicrophoneAccess,
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
    openMicrophoneSettings: () => ipcRenderer.invoke('d2:open-mic-settings') as Promise<boolean>
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
  }
}

// Context isolation is always on (Electron default); the bridge is the only thing exposed.
contextBridge.exposeInMainWorld('d2', d2)
