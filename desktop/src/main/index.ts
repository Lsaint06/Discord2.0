import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupMediaIntegration } from './media'
import { setupScreenCapture } from './screenCapture'
import { applyEncoderFlags, setupEncoderFlagsIpc } from './encoderFlags'
import { isAppUrl, isWebUrl } from './appUrl'
import { setupCredentialStorage } from './credentials'
import { setupSystemIdle } from './system'
import { setupNetDiagnostics } from './netDiagnostics'
import { APP_INDEX_URL, registerAppScheme, serveAppScheme } from './appProtocol'
import { attachUiZoom, loadUiZoom, setupUiZoomIpc } from './uiZoom'
import { setupGlobalShortcuts } from './shortcuts'
import { setupDownloads } from './downloads'

// Optional isolated profile (separate storage/session), e.g. D2_PROFILE=alice.
// Lets two clients run side by side on one PC for testing.
const profile = process.env['D2_PROFILE']
if (profile) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(profile)) {
    throw new Error('D2_PROFILE may only contain letters, numbers, "_" and "-" (max 32).')
  }
  app.setPath('userData', `${app.getPath('userData')}-${profile}`)
}

// Must run before 'ready' so Chromium's GPU process sees the features.
applyEncoderFlags()
// Must run before 'ready': the packaged renderer is served from app://discord2/.
registerAppScheme()

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1b1c20',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // OS-level sandbox for the renderer and preload; the preload only uses contextBridge and
      // ipcRenderer. Context isolation is on (default) and Node integration is off (default).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep gateway heartbeats running while the window is minimized or hidden.
      backgroundThrottling: false
    }
  })

  if (profile) {
    mainWindow.on('page-title-updated', (event, title) => {
      event.preventDefault()
      mainWindow.setTitle(`${title} — ${profile}`)
    })
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  attachUiZoom(mainWindow.webContents)

  // Links in messages open in the system browser, but only plain web URLs.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isWebUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // The app window never navigates away from the app itself.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      if (isWebUrl(url)) void shell.openExternal(url)
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL(APP_INDEX_URL)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  // Must match electron-builder's appId so Windows notifications show the app's name.
  electronApp.setAppUserModelId('com.discord2.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupMediaIntegration()
  setupScreenCapture()
  setupEncoderFlagsIpc(isAppUrl)
  setupCredentialStorage()
  setupSystemIdle()
  setupNetDiagnostics()
  loadUiZoom()
  setupUiZoomIpc(isAppUrl)
  setupGlobalShortcuts(isAppUrl)
  setupDownloads(isAppUrl)
  serveAppScheme()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
