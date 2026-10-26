import { ElectronAPI } from '@electron-toolkit/preload'
import type { D2DesktopApi } from './types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    /** Undefined when the renderer runs outside Electron (e.g. in a browser during development). */
    d2?: D2DesktopApi
  }
}
