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

/**
 * Narrowly scoped main-process media integration:
 * - grants microphone (audio-only) capture to our own renderer, denies every other permission
 * - reports the OS microphone privacy state (Windows/macOS)
 * - optional system-wide push-to-talk via a single Electron globalShortcut (no keyboard hooks)
 */

export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/** Accelerators we accept for global push-to-talk: optional modifiers + one key. */
const ACCELERATOR =
  /^(?:(?:CommandOrControl|Control|Ctrl|Alt|Shift|Super)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|`|-|=|\[|\]|\\|;|'|,|\.|\/|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/

let registeredAccelerator: string | null = null

function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.startsWith('file://')) return true
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

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
      // Microphone only for now. Screen sharing will add an explicit video/display policy.
      return callback(types.length > 0 && types.every((t) => t === 'audio'))
    }
    callback(permission === 'clipboard-sanitized-write')
  })

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (permission !== 'media') return false
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
