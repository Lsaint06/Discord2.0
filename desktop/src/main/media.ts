import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent
} from 'electron'
import { takeDisplayCapturePermission } from './screenCapture'
import { isAppUrl } from './appUrl'

/**
 * Narrowly scoped main-process media integration:
 * - grants microphone (audio-only) capture and notifications to our own renderer, denies every other permission
 * - reports the OS microphone privacy state (Windows/macOS)
 * - optional system-wide push-to-talk via a single Electron globalShortcut (no keyboard hooks)
 */

export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/** Accelerators we accept for global push-to-talk: optional modifiers + one key. */
export const ACCELERATOR =
  /^(?:(?:CommandOrControl|Control|Ctrl|Alt|Shift|Super)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|`|-|=|\[|\]|\\|;|'|,|\.|\/|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/

let registeredAccelerator: string | null = null

function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url)
}

function unregisterPushToTalk(): void {
  if (registeredAccelerator) globalShortcut.unregister(registeredAccelerator)
  registeredAccelerator = null
}

export function setupMediaIntegration(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!isAppUrl(details.requestingUrl ?? webContents.getURL())) return callback(false)
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      // Display capture (getDisplayMedia, or legacy chromeMediaSource constraints) arrives with
      // no media types: allow it only for an explicit, armed picker selection from this window.
      if (types.length === 0) return callback(takeDisplayCapturePermission(webContents.id))
      // getUserMedia: microphone only. Camera is never granted.
      return callback(types.every((t) => t === 'audio'))
    }
    // display-capture is still gated by the one-time selection in screenCapture.ts;
    // fullscreen is used by the stream viewer.
    callback(
      permission === 'clipboard-sanitized-write' ||
        permission === 'display-capture' ||
        permission === 'fullscreen' ||
        permission === 'notifications'
    )
  })

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (
      permission !== 'media' &&
      permission !== 'display-capture' &&
      permission !== 'fullscreen' &&
      permission !== 'notifications'
    ) {
      return false
    }
    // Never expose cameras (this also hides them from enumerateDevices).
    if (permission === 'media' && details?.mediaType === 'video') return false
    return isAppUrl(requestingOrigin)
  })

  ipcMain.handle('d2:mic-access', (event): MicrophoneAccess => {
    if (!fromApp(event)) return 'unknown'
    if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unknown'
    return systemPreferences.getMediaAccessStatus('microphone') as MicrophoneAccess
  })

  ipcMain.handle('d2:open-mic-settings', async (event): Promise<boolean> => {
    if (!fromApp(event)) return false
    if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone')
      return true
    }
    if (process.platform === 'darwin') {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      )
      return true
    }
    return false
  })

  ipcMain.handle('d2:ptt-register', (event, accelerator: unknown): boolean => {
    if (!fromApp(event) || typeof accelerator !== 'string' || !ACCELERATOR.test(accelerator)) {
      return false
    }
    unregisterPushToTalk()
    const sender = event.sender
    const ok = globalShortcut.register(accelerator, () => {
      if (!sender.isDestroyed()) sender.send('d2:ptt-toggle')
    })
    if (ok) registeredAccelerator = accelerator
    return ok
  })

  ipcMain.handle('d2:ptt-unregister', (event) => {
    if (fromApp(event)) unregisterPushToTalk()
  })

  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    window.on('closed', unregisterPushToTalk)
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
