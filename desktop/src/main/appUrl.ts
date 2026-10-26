/** True for our own renderer: the packaged file:// page or the dev server origin. */
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.startsWith('file://')) return true
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}
