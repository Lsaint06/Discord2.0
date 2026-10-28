import { session } from 'electron'

/**
 * The packaged app loads its pages from file://. Chromium sends `Origin: null` for that page's
 * HTTP requests but `Origin: file://` on WebSocket handshakes, which the backend's origin
 * allow-list rejects. Normalize our own requests to the same `null` origin the server already
 * accepts (ALLOW_NULL_ORIGIN), so the realtime gateway and voice signaling work in installed
 * builds. Only the Origin header of requests made by this app is touched.
 */
export function normalizeFileOrigin(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'origin')
    if (key && headers[key] === 'file://') headers[key] = 'null'
    callback({ requestHeaders: headers })
  })
}
