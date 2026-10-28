import { BrowserWindow, app, globalShortcut, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ACCELERATOR } from './media'

/**
 * Optional system-wide shortcuts (Settings → Keybinds → "Works in other apps"). Only a fixed
 * list of commands may be registered, only with a validated accelerator, only by our own
 * renderer, and only through Electron's globalShortcut — never a keyboard hook. Everything is
 * unregistered when the window closes or the app quits.
 */
const ALLOWED = new Set(['toggleMute', 'toggleDeafen'])
const MAX_SHORTCUTS = ALLOWED.size

const registered = new Map<string, string>()

function unregisterAll(): void {
  for (const accelerator of registered.values()) globalShortcut.unregister(accelerator)
  registered.clear()
}

export function setupGlobalShortcuts(isAppUrl: (url: string | undefined) => boolean): void {
  const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  ipcMain.handle('d2:shortcuts-set', (event, list: unknown): Record<string, boolean> | null => {
    if (!fromApp(event) || !Array.isArray(list) || list.length > MAX_SHORTCUTS) return null
    unregisterAll()
    const results: Record<string, boolean> = {}
    const sender = event.sender
    for (const item of list as unknown[]) {
      const { id, accelerator } = (item ?? {}) as { id?: unknown; accelerator?: unknown }
      if (typeof id !== 'string' || !ALLOWED.has(id) || id in results) continue
      if (typeof accelerator !== 'string' || !ACCELERATOR.test(accelerator)) {
        results[id] = false
        continue
      }
      // Already ours (push-to-talk or another command); register() itself fails if another app
      // holds it.
      if (
        globalShortcut.isRegistered(accelerator) ||
        [...registered.values()].includes(accelerator)
      ) {
        results[id] = false
        continue
      }
      const ok = globalShortcut.register(accelerator, () => {
        if (!sender.isDestroyed()) sender.send('d2:shortcut', id)
      })
      if (ok) registered.set(id, accelerator)
      results[id] = ok
    }
    return results
  })

  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    window.on('closed', unregisterAll)
  })
}
