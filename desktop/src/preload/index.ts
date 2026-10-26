import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppMetrics,
  D2DesktopApi,
  EncoderFlagsState,
  MicrophoneAccess,
  ScreenCaptureCapabilities,
  ScreenSelectResult,
  ScreenSourceInfo
} from './types'

// Custom APIs for renderer
const api = {}

/** Narrow, typed bridge for Discord 2.0 features (no raw IPC exposed through this object). */
const d2: D2DesktopApi = {
  platform: process.platform,
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
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('d2', d2)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.d2 = d2
}
