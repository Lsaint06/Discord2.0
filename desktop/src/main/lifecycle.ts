/**
 * Milestone 14: Windows lifecycle — tray icon, optional close-to-tray, start minimized, launch at
 * login, taskbar attention (overlay dot + frame flash) and bringing the window back for
 * notification clicks. Every IPC call is accepted only from the app's own page and validated.
 *
 * Defaults change nothing about how the app behaved before: closing the window quits, nothing
 * starts with Windows, nothing runs hidden.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type IpcMainInvokeEvent
} from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  DEFAULT_LIFECYCLE,
  parseAttention,
  parseLifecyclePrefs,
  type LifecyclePrefs
} from './lifecycleLogic'

export type { LifecyclePrefs }

const HIDDEN_ARG = '--start-hidden'

let prefs: LifecyclePrefs = { ...DEFAULT_LIFECYCLE }
let quitting = false
let tray: Tray | null = null
let currentBadge = 0

const prefsFile = (): string => join(app.getPath('userData'), 'lifecycle.json')

export function loadLifecyclePrefs(): LifecyclePrefs {
  try {
    prefs = parseLifecyclePrefs(JSON.parse(readFileSync(prefsFile(), 'utf8')))
  } catch {
    prefs = { ...DEFAULT_LIFECYCLE }
  }
  return prefs
}

/** Should this launch start hidden? (Login launches pass --start-hidden.) */
export function startsHidden(): boolean {
  return prefs.startMinimized || process.argv.includes(HIDDEN_ARG)
}

/** Launch at login only makes sense for a real install/portable copy, not `electron .`. */
const loginSupported = (): boolean => app.isPackaged && process.platform === 'win32'

function applyLoginItem(): void {
  if (!loginSupported()) return
  app.setLoginItemSettings({
    openAtLogin: prefs.launchAtLogin,
    args: prefs.launchAtLogin ? [HIDDEN_ARG] : []
  })
}

/** A small red dot (16×16 BGRA) for the taskbar overlay. */
function dotImage(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8)
      const a = Math.max(0, Math.min(1, 7 - d)) // anti-aliased edge
      const o = (y * size + x) * 4
      buf[o] = 0x5c // B
      buf[o + 1] = 0x54 // G
      buf[o + 2] = 0xe5 // R
      buf[o + 3] = Math.round(a * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function show(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function quitFromTray(): void {
  quitting = true
  app.quit()
}

export function setupLifecycle(
  win: BrowserWindow,
  iconPath: string,
  isAppUrl: (url: string | undefined) => boolean
): void {
  const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  app.on('before-quit', () => {
    quitting = true
  })
  win.on('close', (event) => {
    if (prefs.closeToTray && !quitting && tray) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('focus', () => win.flashFrame(false))

  try {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
    tray.setToolTip('Discord 2.0')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Discord 2.0', click: () => show(win) },
        { type: 'separator' },
        { label: 'Quit Discord 2.0', click: () => quitFromTray() }
      ])
    )
    tray.on('click', () => show(win))
  } catch {
    // No tray available: close-to-tray stays off (the window always closes normally).
    tray = null
  }
  win.on('closed', () => {
    tray?.destroy()
    tray = null
  })

  for (const channel of [
    'd2:lifecycle-get',
    'd2:lifecycle-set',
    'd2:attention',
    'd2:window-show'
  ]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('d2:lifecycle-get', (event) => {
    if (!fromApp(event)) return null
    return { ...prefs, loginSupported: loginSupported(), trayAvailable: tray !== null }
  })
  ipcMain.handle('d2:lifecycle-set', (event, patch: unknown) => {
    if (!fromApp(event)) return null
    prefs = parseLifecyclePrefs(patch, prefs)
    try {
      writeFileSync(prefsFile(), JSON.stringify(prefs))
    } catch {
      // Not saved: applies for this session.
    }
    applyLoginItem()
    return { ...prefs, loginSupported: loginSupported(), trayAvailable: tray !== null }
  })
  ipcMain.handle('d2:attention', (event, raw: unknown) => {
    if (!fromApp(event) || win.isDestroyed()) return false
    const attention = parseAttention(raw)
    if (!attention) return false
    if (attention.badge !== currentBadge) {
      currentBadge = attention.badge
      const label =
        attention.badge > 0
          ? `${attention.badge} unread mention${attention.badge === 1 ? '' : 's'}`
          : ''
      if (process.platform === 'win32')
        win.setOverlayIcon(attention.badge > 0 ? dotImage() : null, label)
      else app.setBadgeCount(attention.badge)
      tray?.setToolTip(label ? `Discord 2.0 — ${label}` : 'Discord 2.0')
    }
    if (attention.flash && !win.isFocused()) win.flashFrame(true)
    return true
  })
  ipcMain.handle('d2:window-show', (event) => {
    if (!fromApp(event)) return false
    show(win)
    return true
  })
}
