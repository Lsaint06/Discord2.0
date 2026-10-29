import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import {
  OVERLAY_FRAME_NAME,
  clampToDisplays,
  isOverlayOpenRequest,
  parseOverlayCommand,
  type Rect
} from './overlayLogic'

/**
 * The in-game camera overlay window (Milestone 14.5).
 *
 * The main renderer opens it with window.open('about:blank', 'd2-camera-overlay'): a same-origin
 * child window in the SAME renderer process, so the main window can render the camera tracks it
 * already receives straight into it — no second LiveKit connection, no media over IPC, no second
 * decode. This file only creates and positions the native window:
 *
 * - frameless, transparent, always on top ('screen-saver' level, above borderless games),
 *   not in the taskbar, never focusable and click-through in view mode, so it never takes
 *   input from the game; edit mode (explicit) makes it draggable until you press Done;
 * - it can't navigate or open windows, and the preload bridge isn't exposed in it;
 * - it is destroyed with the main window, when the main page reloads or crashes, and on quit.
 *
 * It never injects into, hooks or captures a game. Exclusive-fullscreen games may draw over it;
 * that is a Windows limitation we don't try to defeat.
 */

let overlay: BrowserWindow | null = null
let mode: 'view' | 'edit' = 'view'

export interface OverlayDisplay {
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  primary: boolean
  label: string
}

function displays(): OverlayDisplay[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary,
    label: d.label || `Display ${i + 1}`
  }))
}

function clamp(bounds: Rect): Rect {
  return clampToDisplays(
    bounds,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea
  )
}

/** Windows may mis-size a window moved between monitors with different scaling; apply twice. */
function place(win: BrowserWindow, bounds: Rect): void {
  win.setBounds(bounds)
  const now = win.getBounds()
  if (now.width !== bounds.width || now.height !== bounds.height) win.setBounds(bounds)
}

function applyMode(win: BrowserWindow, next: 'view' | 'edit'): void {
  mode = next
  if (next === 'edit') {
    win.setIgnoreMouseEvents(false)
    win.setFocusable(true)
  } else {
    // Clicks and keys go straight to whatever is underneath (the game).
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true)
    if (win.isFocused()) win.blur()
  }
}

/** For the main window's setWindowOpenHandler: the overlay's window options, or null. */
export function overlayOpenResponse(
  details: { url: string; frameName: string },
  openerIsApp: boolean
): {
  action: 'allow'
  overrideBrowserWindowOptions: Electron.BrowserWindowConstructorOptions
} | null {
  if (!isOverlayOpenRequest(details, openerIsApp) || overlay) return null
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 470,
      height: 270,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      title: 'Discord 2.0 camera overlay',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        // Keep the cameras moving while a game has focus.
        backgroundThrottling: false
      }
    }
  }
}

export function setupCameraOverlay(
  main: BrowserWindow,
  isAppUrl: (url: string | undefined) => boolean
): void {
  const fromMain = (event: IpcMainInvokeEvent): boolean =>
    !main.isDestroyed() && event.sender === main.webContents && isAppUrl(event.senderFrame?.url)
  const send = (payload: object): void => {
    if (!main.isDestroyed()) main.webContents.send('d2:overlay-event', payload)
  }
  const destroy = (): void => {
    const win = overlay
    overlay = null
    mode = 'view'
    if (win && !win.isDestroyed()) win.destroy()
  }

  main.webContents.on('did-create-window', (win, details) => {
    if (details.frameName !== OVERLAY_FRAME_NAME || overlay) {
      win.destroy()
      return
    }
    overlay = win
    win.setMenu(null)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setSkipTaskbar(true)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    applyMode(win, 'view')
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('moved', () => {
      if (mode === 'edit' && overlay === win) send({ type: 'moved', bounds: win.getBounds() })
    })
    win.on('closed', () => {
      if (overlay === win) {
        overlay = null
        mode = 'view'
        send({ type: 'closed' })
      }
    })
  })

  // The overlay never outlives the page that renders into it.
  main.on('closed', destroy)
  main.webContents.on('render-process-gone', destroy)
  main.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) destroy()
  })

  const onDisplays = (): void => {
    if (overlay && !overlay.isDestroyed()) place(overlay, clamp(overlay.getBounds()))
    send({ type: 'displays' })
  }
  screen.on('display-added', onDisplays)
  screen.on('display-removed', onDisplays)
  screen.on('display-metrics-changed', onDisplays)
  main.on('closed', () => {
    screen.removeListener('display-added', onDisplays)
    screen.removeListener('display-removed', onDisplays)
    screen.removeListener('display-metrics-changed', onDisplays)
  })

  for (const channel of ['d2:overlay-displays', 'd2:overlay-update', 'd2:overlay-close']) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('d2:overlay-displays', (event) => (fromMain(event) ? displays() : null))
  ipcMain.handle('d2:overlay-update', (event, raw: unknown) => {
    if (!fromMain(event)) return null
    const command = parseOverlayCommand(raw)
    const win = overlay
    if (!command || !win || win.isDestroyed()) return null
    const bounds = clamp(command.bounds)
    place(win, bounds)
    applyMode(win, command.mode)
    if (command.visible) {
      if (command.mode === 'edit') win.show()
      else if (!win.isVisible()) win.showInactive()
      // Some games raise themselves; re-assert the level whenever we show.
      win.setAlwaysOnTop(true, 'screen-saver')
    } else if (win.isVisible()) {
      win.hide()
    }
    return { bounds: win.getBounds(), visible: win.isVisible(), mode }
  })
  ipcMain.handle('d2:overlay-close', (event) => {
    if (fromMain(event)) destroy()
  })
}
