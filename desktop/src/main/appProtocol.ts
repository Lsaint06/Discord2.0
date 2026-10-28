import { net, protocol } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { APP_HOST, APP_SCHEME, resolveAppFile } from './appUrl'

/**
 * The packaged renderer is served from app://discord2/ instead of file://. That gives the app a
 * real, unforgeable origin of its own (web pages can't create one), which the backend allows
 * explicitly, instead of the "null" origin shared by every file:// page and sandboxed iframe.
 *
 * Must be called before the app is ready.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        // A secure context, so getUserMedia / screen capture keep working.
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true
      }
    }
  ])
}

/** Serves files from the built renderer folder only. Call after the app is ready. */
export function serveAppScheme(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle(APP_SCHEME, (request) => {
    const file = resolveAppFile(root, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`
