import { isAbsolute, relative, resolve } from 'path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'discord2'

/**
 * True only for our own renderer: app://discord2/… (packaged) or the electron-vite dev server
 * origin. Other local pages (file://, another app:// host) are never trusted: they must not reach
 * the credential store, media permissions or other privileged IPC.
 */
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devUrl) return false
  try {
    return parsed.origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

/**
 * Maps app://discord2/<path> to a file inside `root`, or null if the URL is for another host or
 * would escape the folder (../, encoded separators, absolute paths, NUL bytes).
 */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (path.includes('\0')) return null
  if (path === '' || path === '/') path = '/index.html'
  const base = resolve(root)
  const file = resolve(base, `.${path}`)
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}

/** Only http(s) links may be handed to the system browser. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
