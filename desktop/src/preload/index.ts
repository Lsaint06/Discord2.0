import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { D2DesktopApi, MicrophoneAccess } from './types'

// Custom APIs for renderer
const api = {}

/** Narrow, typed bridge for Discord 2.0 features (no raw IPC exposed through this object). */
const d2: D2DesktopApi = {
  platform: process.platform,
  media: {
    getMicrophoneAccess: () => ipcRenderer.invoke('d2:mic-access') as Promise<MicrophoneAccess>,
    openMicrophoneSettings: () => ipcRenderer.invoke('d2:open-mic-settings') as Promise<boolean>
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
