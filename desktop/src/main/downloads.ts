import { app, ipcMain, session, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { basename, join } from 'path'

/**
 * Large-file downloads (Milestone 13): streamed straight to disk by Chromium's download
 * manager (Save dialog, resumable), instead of through renderer memory. Only our own renderer
 * may start one, only for an attachment URL, with only an Authorization header.
 */
const ATTACHMENT_PATH = /^\/api\/attachments\/[a-f0-9]{32}$/
const AUTH_HEADER = /^Bearer [A-Za-z0-9_-]{20,200}$/

/** The approved servers' origins (from the build's server list, see electron.vite.config.ts). */
declare const __D2_SERVER_ORIGINS__: readonly string[]
const SERVER_ORIGINS = new Set<string>(
  typeof __D2_SERVER_ORIGINS__ === 'undefined' ? [] : __D2_SERVER_ORIGINS__
)

export interface DownloadProgress {
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
}

export function setupDownloads(isAppUrl: (url: string | undefined) => boolean): void {
  const owners = new Map<string, WebContents>()
  // Development builds only: automated tests save into this folder instead of a Save dialog.
  const testDir = app.isPackaged ? undefined : process.env['D2_TEST_DOWNLOAD_DIR']

  ipcMain.handle('d2:download-file', (event: IpcMainInvokeEvent, input: unknown): boolean => {
    if (!isAppUrl(event.senderFrame?.url)) return false
    const { url, authorization } = (input ?? {}) as { url?: unknown; authorization?: unknown }
    if (
      typeof url !== 'string' ||
      typeof authorization !== 'string' ||
      !AUTH_HEADER.test(authorization)
    ) {
      return false
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      // Only the approved servers ever receive the session token.
      !SERVER_ORIGINS.has(parsed.origin) ||
      parsed.username ||
      parsed.password ||
      !ATTACHMENT_PATH.test(parsed.pathname) ||
      ![...parsed.searchParams.keys()].every((k) => k === 'download')
    ) {
      return false
    }
    owners.set(parsed.toString(), event.sender)
    event.sender.downloadURL(parsed.toString(), { headers: { Authorization: authorization } })
    return true
  })

  session.defaultSession.on('will-download', (_event, item) => {
    const url = item.getURL()
    const owner = owners.get(url)
    if (!owner) return
    owners.delete(url)
    if (testDir) item.setSavePath(join(testDir, basename(item.getFilename())))
    const send = (state: DownloadProgress['state']): void => {
      if (owner.isDestroyed()) return
      owner.send('d2:download-progress', {
        url,
        state,
        received: item.getReceivedBytes(),
        total: item.getTotalBytes()
      } satisfies DownloadProgress)
    }
    item.on('updated', (_e, state) => send(state === 'interrupted' ? 'interrupted' : 'progressing'))
    item.once('done', (_e, state) => send(state))
  })
}
