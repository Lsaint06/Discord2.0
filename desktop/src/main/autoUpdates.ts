import { app, dialog, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'

export function setupAutoUpdates(): void {
  if (!app.isPackaged || process.platform !== 'win32') return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  let checking = false
  let updateAvailable = false
  let readyVersion: string | null = null

  async function showReady(): Promise<void> {
    if (!readyVersion) return

    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Discord 2.0 Update',
      message: `Discord 2.0 ${readyVersion} is ready.`,
      detail: 'Restarting will close Discord 2.0 and disconnect any active calls.',
      buttons: ['Later', 'Restart to Update'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (result.response === 1) {
      autoUpdater.quitAndInstall(false, true)
    }
  }

  async function check(manual: boolean): Promise<void> {
    if (readyVersion) {
      if (manual) await showReady()
      return
    }

    if (checking) {
      if (manual) {
        await dialog.showMessageBox({
          message: 'Discord 2.0 is already checking for updates.'
        })
      }
      return
    }

    checking = true
    updateAvailable = false

    try {
      await autoUpdater.checkForUpdates()

      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Discord 2.0 Updates',
          message: updateAvailable
            ? 'An update is available and is downloading.'
            : `Discord 2.0 ${app.getVersion()} is up to date.`
        })
      }
    } catch (error) {
      console.error('Discord 2.0 update check failed:', error)

      if (manual) {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Discord 2.0 Updates',
          message: 'Could not check for updates.',
          detail: 'Check your internet connection and try again.'
        })
      }
    } finally {
      checking = false
    }
  }

  autoUpdater.on('update-available', (info) => {
    updateAvailable = true
    console.info('Discord 2.0 update available:', info.version)
  })

  autoUpdater.on('update-not-available', () => {
    updateAvailable = false
    console.info('Discord 2.0 is up to date')
  })

  autoUpdater.on('error', (error) => {
    console.error('Discord 2.0 updater:', error)
  })

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version
    void showReady().catch((error) => {
      console.error('Discord 2.0 update prompt failed:', error)
    })
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
            click: () => {
              void check(true)
            }
          }
        ]
      }
    ])
  )

  setTimeout(() => {
    void check(false)
  }, 10000)
}
