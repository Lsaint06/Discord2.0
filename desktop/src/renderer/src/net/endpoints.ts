/**
 * Approved backend endpoints ("server profiles") for the desktop app. Pure module: used by the
 * renderer at runtime and by electron.vite.config.ts at build time (validation and the CSP).
 *
 * Profiles are fixed when the app is built (RENDERER_VITE_SERVERS); users can choose between them
 * but can't type in an arbitrary server, so a sign-in token can never be sent somewhere unapproved.
 *
 * Transport rule: https:// (and wss://) everywhere, except plain http:// for private addresses on
 * your own network (192.168.x.x, 10.x, localhost, *.local, Tailscale 100.64.0.0/10 …).
 */

export interface Endpoint {
  /** Stable id: the origin, e.g. "https://myhome.duckdns.org". */
  id: string
  label: string
  httpUrl: string
  gatewayUrl: string
  /** True for http:// (LAN only). */
  insecure: boolean
}

export type EndpointsResult = { ok: true; endpoints: Endpoint[] } | { ok: false; error: string }

const MAX_ENDPOINTS = 5

/** Same rule as the server (server/src/lib/network.ts). */
export function isPrivateHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!h) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (h.includes(':')) {
    if (h === '::1') return true
    const first = parseInt(h.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.home.arpa')) return true
  return !h.includes('.')
}

/** Validates one backend URL; returns its normalized origin or an error. */
export function checkServerUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      error: `${url.href}: must start with https:// (or http:// on a private network)`
    }
  }
  if (url.username || url.password) {
    return { ok: false, error: `${url.origin}: credentials must not be part of the server address` }
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, error: `${url.href}: give just the server address, without a path` }
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return {
      ok: false,
      error: `${url.origin}: a server on the internet must use https:// (http:// is only allowed for private network addresses)`
    }
  }
  return { ok: true, url }
}

/**
 * Parses RENDERER_VITE_SERVERS ("Label|URL, Label|URL") or, for older configs, a single
 * RENDERER_VITE_SERVER_URL. The first entry is the default.
 */
export function parseEndpoints(
  servers: string | undefined,
  singleUrl?: string | undefined
): EndpointsResult {
  const entries: { label: string; raw: string }[] = []
  if (servers && servers.trim()) {
    for (const part of servers.split(',')) {
      if (!part.trim()) continue
      const bar = part.indexOf('|')
      if (bar < 0)
        return {
          ok: false,
          error: `RENDERER_VITE_SERVERS: "${part.trim()}" must look like Label|https://host`
        }
      entries.push({ label: part.slice(0, bar).trim(), raw: part.slice(bar + 1).trim() })
    }
  } else if (singleUrl && singleUrl.trim()) {
    entries.push({ label: 'Server', raw: singleUrl.trim() })
  }
  if (entries.length === 0) {
    return {
      ok: false,
      error:
        'No server configured. Set RENDERER_VITE_SERVERS (e.g. "Home|http://192.168.68.65:3001") in desktop/.env.development.local or .env.production.local.'
    }
  }
  if (entries.length > MAX_ENDPOINTS)
    return { ok: false, error: `At most ${MAX_ENDPOINTS} servers can be configured` }

  const endpoints: Endpoint[] = []
  for (const { label, raw } of entries) {
    if (!label || label.length > 40)
      return { ok: false, error: 'Each server needs a label of 1-40 characters' }
    const checked = checkServerUrl(raw)
    if (!checked.ok) return { ok: false, error: checked.error }
    const { url } = checked
    if (endpoints.some((e) => e.id === url.origin))
      return { ok: false, error: `${url.origin} is listed twice` }
    endpoints.push({
      id: url.origin,
      label,
      httpUrl: url.origin,
      gatewayUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/gateway`,
      insecure: url.protocol === 'http:'
    })
  }
  return { ok: true, endpoints }
}

/**
 * The LiveKit signaling URL the server handed out must belong to the endpoint we're signed in to
 * (or the separately configured LiveKit host), and be encrypted whenever the endpoint is, or the
 * host is public. Stops a compromised or misconfigured server from steering voice elsewhere.
 */
export function checkLivekitUrl(
  raw: string,
  endpoint: Pick<Endpoint, 'httpUrl'>,
  extraLivekitUrl?: string
): { ok: true } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'The server sent an invalid voice address.' }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, error: 'The server sent an invalid voice address.' }
  }
  const api = new URL(endpoint.httpUrl)
  const allowedHosts = new Set([api.hostname])
  if (extraLivekitUrl) {
    try {
      allowedHosts.add(new URL(extraLivekitUrl).hostname)
    } catch {
      // ignored; reported at build time
    }
  }
  if (!allowedHosts.has(url.hostname)) {
    return { ok: false, error: `Voice server ${url.hostname} isn't approved for this app.` }
  }
  if (url.protocol === 'ws:' && (api.protocol === 'https:' || !isPrivateHost(url.hostname))) {
    return { ok: false, error: 'The voice connection would not be encrypted; refusing to connect.' }
  }
  return { ok: true }
}

/** CSP connect-src entries for the given endpoints (+ optional separate LiveKit host). */
export function connectSources(endpoints: Endpoint[], extraLivekitUrl?: string): string {
  const sources = new Set<string>()
  const add = (url: URL): void => {
    const secure = url.protocol === 'https:' || url.protocol === 'wss:'
    sources.add(`${secure ? 'https' : 'http'}://${url.hostname}:*`)
    sources.add(`${secure ? 'wss' : 'ws'}://${url.hostname}:*`)
  }
  for (const e of endpoints) add(new URL(e.httpUrl))
  if (extraLivekitUrl) {
    try {
      const url = new URL(extraLivekitUrl)
      if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) add(url)
    } catch {
      // ignored
    }
  }
  return [...sources].join(' ')
}
