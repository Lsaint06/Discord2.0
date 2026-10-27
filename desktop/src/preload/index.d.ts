import type { D2DesktopApi } from './types'

declare global {
  interface Window {
    /** Undefined when the renderer runs outside Electron (e.g. in a browser during development). */
    d2?: D2DesktopApi
  }
}
