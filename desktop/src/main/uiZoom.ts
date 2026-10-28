import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  UI_ZOOM_DEFAULT,
  UI_ZOOM_STEPS,
  normalizeZoom,
  parseZoomFile,
  stepZoom,
  zoomKeyAction
} from './uiZoomLogic'

/**
 * Persisted interface scale for this device (userData/ui-zoom.json). Shortcuts Ctrl+= / Ctrl+-
 * / Ctrl+0 are handled here so they always update the saved value; they only act while the app
 * window is focused (no global hooks). Ctrl+mouse wheel is routed too if Electron reports it.
 */

function zoomFile(): string {
  return join(app.getPath('userData'), 'ui-zoom.json')
}

let current = UI_ZOOM_DEFAULT

/** Reads the saved scale. Call once 'ready' (userData is final by then). */
export function loadUiZoom(): number {
  try {
    const file = zoomFile()
    current = existsSync(file) ? parseZoomFile(readFileSync(file, 'utf8')) : UI_ZOOM_DEFAULT
  } catch {
    current = UI_ZOOM_DEFAULT
  }
  return current
}

function setZoom(factor: number): number {
  current = normalizeZoom(factor)
  try {
    writeFileSync(zoomFile(), JSON.stringify({ zoomFactor: current }, null, 2))
  } catch {
    // Not fatal: the scale still applies for this run.
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.setZoomFactor(current)
    window.webContents.send('d2:ui-zoom-changed', current)
  }
  return current
}

/** Applies the saved scale to a window and routes its zoom shortcuts through setZoom. */
export function attachUiZoom(contents: WebContents): void {
  const apply = (): void => contents.setZoomFactor(current)
  contents.on('did-finish-load', apply)
  contents.on('before-input-event', (event, input) => {
    const action = zoomKeyAction(input, process.platform === 'darwin')
    if (!action) return
    event.preventDefault()
    setZoom(action === 'reset' ? UI_ZOOM_DEFAULT : stepZoom(current, action === 'in' ? 1 : -1))
  })
  contents.on('zoom-changed', (_event, direction) => {
    setZoom(stepZoom(current, direction === 'in' ? 1 : -1))
  })
}

export function setupUiZoomIpc(isAppUrl: (url: string | undefined) => boolean): void {
  const fromApp = (event: IpcMainInvokeEvent): boolean => isAppUrl(event.senderFrame?.url)

  ipcMain.handle('d2:ui-zoom-get', (event) => {
    if (!fromApp(event)) return null
    return { factor: current, steps: [...UI_ZOOM_STEPS], defaultFactor: UI_ZOOM_DEFAULT }
  })

  ipcMain.handle('d2:ui-zoom-set', (event, value: unknown) => {
    if (!fromApp(event)) return null
    return { factor: setZoom(normalizeZoom(value)) }
  })
}
