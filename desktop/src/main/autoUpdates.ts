import { app, dialog, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'

export function setupAutoUpdates(): void {
  if (!app.isPackaged || process.platform !== 'win32') return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  let readyVersion: string | null = null

  async function check(manual: boolean): Promise<void> {
    if (readyVersion) {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Discord 2.0 Update',
        message: `Version ${readyVersion} is ready to install.`,
        buttons: ['Later', 'Restart to Update'],
        defaultId: 1,
        cancelId: 0
      })
      if (result.response === 1) autoUpdater.quitAndInstall(false, true)
      return
    }

    try {
      const result = await autoUpdater.checkForUpdates()
      if (manual && !result?.updateInfo) {
        await dialog.showMessageBox({
          message: 'No update information is available.'
        })
      }
    } catch (error) {
      console.error('Update check failed:', error)
      if (manual) {
        await dialog.showMessageBox({
          type: 'warning',
          message: 'Could not check for updates. Try again later.'
        })
      }
    }
  }

  autoUpdater.on('update-not-available', () => {
    console.info('Discord 2.0 is up to date')
  })

  autoUpdater.on('error', (error) => {
    console.error('Discord 2.0 updater:', error)
  })

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version
    void check(false).catch((error) => console.error('Update prompt:', error))
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Check for Updates',
            click: () => { void check(true) }
          }
        ]
      }
    ])
  )

  // Initial check after startup. Never close a voice call without confirmation.
  setTimeout(() => {
    void check(false)
  }, 10000)
}