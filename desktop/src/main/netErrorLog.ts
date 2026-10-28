/**
 * Remembers the most recent network failure per server origin, so the renderer can explain *why*
 * it couldn't connect (certificate, DNS, offline, refused, timeout). A renderer `fetch()` only
 * sees a generic TypeError; Chromium's error code is only visible here.
 *
 * Purely passive: nothing is retried, allowed or changed. Certificate errors are still rejected
 * by Chromium as before; this module only records the error code. Pure logic, unit-tested; the
 * Electron wiring is in netDiagnostics.ts.
 */

/** "http(s)://host[:port]" for http/https/ws/wss URLs (ws maps to http, wss to https), else null. */
export function originOf(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const proto =
    u.protocol === 'wss:'
      ? 'https:'
      : u.protocol === 'ws:'
        ? 'http:'
        : u.protocol === 'https:' || u.protocol === 'http:'
          ? u.protocol
          : null
  return proto ? `${proto}//${u.host}` : null
}

/**
 * Chromium's "net::ERR_X" → "ERR_X". Cancellations (ERR_ABORTED: the app's own request timeouts
 * and aborted downloads) say nothing about the server and are ignored.
 */
export function netErrorCode(error: string): string | null {
  const m = /^net::(ERR_[A-Z0-9_]+)$/.exec(error.trim())
  if (!m || m[1] === 'ERR_ABORTED') return null
  return m[1]!
}

export class NetErrorLog {
  private readonly entries = new Map<string, { code: string; at: number }>()

  constructor(
    private readonly maxOrigins = 16,
    private readonly ttlMs = 2 * 60_000
  ) {}

  record(url: string, error: string, now = Date.now()): void {
    const origin = originOf(url)
    const code = netErrorCode(error)
    if (!origin || !code) return
    this.entries.delete(origin)
    this.entries.set(origin, { code, at: now })
    while (this.entries.size > this.maxOrigins) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** A request to this origin succeeded: forget its last error. */
  clear(url: string): void {
    const origin = originOf(url)
    if (origin) this.entries.delete(origin)
  }

  /** The last error code for an origin ("https://host"), if recent. */
  lookup(origin: string, now = Date.now()): string | null {
    const key = originOf(origin)
    const entry = key ? this.entries.get(key) : undefined
    return entry && now - entry.at <= this.ttlMs ? entry.code : null
  }
}
