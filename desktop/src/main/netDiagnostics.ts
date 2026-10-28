import { ipcMain, session, type WebContents } from 'electron'
import { isAppUrl } from './appUrl'
import { NetErrorLog } from './netErrorLog'

const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }

/**
 * Records Chromium's error code for failed requests made by the app's own page, and lets that
 * page ask for the last error of a server origin (see netErrorLog.ts). Passive only: TLS
 * validation, CSP and request handling are unchanged.
 */
export function setupNetDiagnostics(): void {
  const log = new NetErrorLog()
  const fromApp = (wc: WebContents | undefined | null): boolean =>
    !!wc && !wc.isDestroyed() && isAppUrl(wc.getURL())

  session.defaultSession.webRequest.onErrorOccurred(FILTER, (details) => {
    if (fromApp(details.webContents)) log.record(details.url, details.error)
  })
  session.defaultSession.webRequest.onCompleted(FILTER, (details) => {
    if (fromApp(details.webContents)) log.clear(details.url)
  })

  ipcMain.handle('d2:net-last-error', (event, origin: unknown): string | null => {
    if (!isAppUrl(event.senderFrame?.url)) return null
    if (typeof origin !== 'string' || origin.length > 300) return null
    return log.lookup(origin)
  })
}
