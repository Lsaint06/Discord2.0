import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_ARGON2, validateArgon2Params, type Argon2Params } from './auth/password.js'
import { isPrivateHost } from './lib/network.js'

/**
 * Origin of the packaged desktop app (its pages are served from this custom scheme). Web pages
 * can't create an app:// origin, so allowing it lets only our own app (and non-browser clients,
 * which send no Origin at all) through the browser-origin check. Authentication is still the
 * session token: an Origin header proves nothing about a non-browser client.
 */
export const APP_ORIGIN = 'app://discord2'

export interface LiveKitConfig {
  apiKey: string
  /** Server-side only. Never sent to clients. */
  apiSecret: string
  /** URL the backend uses for LiveKit's server API (e.g. http://livekit:7880). */
  apiUrl: string
  /** WebSocket URL handed to desktop clients (wss:// for a public host, e.g. wss://name.duckdns.org). */
  publicUrl: string
  /**
   * Optional LAN signaling URL (e.g. ws://192.168.68.65:7880), handed to clients that reached the
   * backend through a private address, so PCs at home don't depend on the router looping back to
   * the public address. null = everyone gets publicUrl.
   */
  lanUrl: string | null
}

export interface AttachmentConfig {
  /** Directory for attachment binaries (inside the persistent data volume). */
  dir: string
  maxImageBytes: number
  maxFileBytes: number
  maxFilesPerMessage: number
  /** Total bytes accepted in one upload request. */
  maxRequestBytes: number
  /** Images larger than this many pixels are rejected (protects clients from decode bombs). */
  maxImagePixels: number
  /** Per-user storage quota (sent + pending). */
  userQuotaBytes: number
  /** Total storage for all attachments. */
  totalQuotaBytes: number
  /** Uploads are refused when the volume has less free space than this. */
  minFreeDiskBytes: number
  /** Max uploaded-but-unsent attachments per user. */
  maxPendingPerUser: number
  /** Unsent uploads older than this are deleted by the cleanup job. */
  pendingTtlMs: number
}

export interface AuthConfig {
  /** A session expires after this long without use. */
  sessionIdleMs: number
  /** A session expires this long after sign-in, however active (then sign in again). */
  sessionMaxAgeMs: number
  argon2: Argon2Params
  /** Concurrent password hashes (each uses argon2.memoryKiB of RAM). */
  hashConcurrency: number
}

export interface Config {
  env: 'development' | 'production' | 'test'
  host: string
  port: number
  databaseUrl: string
  /** Development identities: anyone can log in as any username. Never enable on an untrusted network. */
  devAuth: boolean
  /** Explicit browser origins allowed for CORS and WebSocket upgrades. */
  corsOrigins: string[]
  /** Allow any http://localhost:* / http://127.0.0.1:* origin (Electron dev server). */
  allowLocalhostOrigins: boolean
  /** Allow the "null" origin (Electron windows loaded from file://, i.e. desktop apps before 1.1). */
  allowNullOrigin: boolean
  /** Allow the packaged desktop app's own origin (APP_ORIGIN). */
  allowAppOrigin: boolean
  /**
   * Reverse proxies whose X-Forwarded-For is believed (IP addresses, CIDR ranges, or the keywords
   * loopback / linklocal / uniquelocal). false = use the TCP peer address. Never "everyone".
   */
  trustProxy: false | string[]
  logLevel: string
  /** Voice (LiveKit). null = voice disabled. */
  livekit: LiveKitConfig | null
  attachments: AttachmentConfig
  auth: AuthConfig
}

const DAY = 24 * 60 * 60_000

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = positiveNumber(env, name, fallback)
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number`)
  return value
}

function parseAuth(env: NodeJS.ProcessEnv): AuthConfig {
  const argon2: Argon2Params = {
    memoryKiB: integer(env, 'ARGON2_MEMORY_KIB', DEFAULT_ARGON2.memoryKiB),
    passes: integer(env, 'ARGON2_PASSES', DEFAULT_ARGON2.passes),
    parallelism: integer(env, 'ARGON2_PARALLELISM', DEFAULT_ARGON2.parallelism)
  }
  validateArgon2Params(argon2)
  const idleDays = positiveNumber(env, 'SESSION_IDLE_DAYS', 30)
  const maxDays = positiveNumber(env, 'SESSION_MAX_DAYS', 90)
  if (idleDays > maxDays) throw new Error('SESSION_IDLE_DAYS must not exceed SESSION_MAX_DAYS')
  if (maxDays > 365) throw new Error('SESSION_MAX_DAYS must be at most 365')
  return {
    sessionIdleMs: idleDays * DAY,
    sessionMaxAgeMs: maxDays * DAY,
    argon2,
    hashConcurrency: Math.min(8, integer(env, 'ARGON2_MAX_CONCURRENT', 2))
  }
}

const MB = 1024 * 1024

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

/** Defaults to "<directory of the SQLite file>/attachments" so both share the same volume. */
function defaultAttachmentsDir(databaseUrl: string): string {
  if (databaseUrl.startsWith('sqlite:')) {
    const file = databaseUrl.slice('sqlite:'.length)
    if (file && file !== ':memory:') return join(dirname(resolve(file)), 'attachments')
  }
  return resolve('./data/attachments')
}

function parseAttachments(env: NodeJS.ProcessEnv, databaseUrl: string): AttachmentConfig {
  return {
    dir: resolve(env.ATTACHMENTS_DIR || defaultAttachmentsDir(databaseUrl)),
    maxImageBytes: positiveNumber(env, 'UPLOAD_MAX_IMAGE_MB', 15) * MB,
    maxFileBytes: positiveNumber(env, 'UPLOAD_MAX_FILE_MB', 25) * MB,
    maxFilesPerMessage: Math.min(10, Math.floor(positiveNumber(env, 'UPLOAD_MAX_FILES', 5))),
    maxRequestBytes: positiveNumber(env, 'UPLOAD_MAX_REQUEST_MB', 50) * MB,
    maxImagePixels: positiveNumber(env, 'UPLOAD_MAX_IMAGE_MEGAPIXELS', 50) * 1_000_000,
    userQuotaBytes: positiveNumber(env, 'UPLOAD_USER_QUOTA_MB', 1024) * MB,
    totalQuotaBytes: positiveNumber(env, 'UPLOAD_TOTAL_QUOTA_MB', 20 * 1024) * MB,
    minFreeDiskBytes: positiveNumber(env, 'UPLOAD_MIN_FREE_DISK_MB', 2048) * MB,
    maxPendingPerUser: 20,
    pendingTtlMs: 6 * 60 * 60_000
  }
}

function parseLiveKit(env: NodeJS.ProcessEnv): LiveKitConfig | null {
  const apiKey = env.LIVEKIT_API_KEY?.trim()
  const apiSecret = env.LIVEKIT_API_SECRET?.trim()
  const apiUrl = env.LIVEKIT_URL?.trim()
  const publicUrl = env.LIVEKIT_PUBLIC_URL?.trim()
  const provided = [apiKey, apiSecret, apiUrl, publicUrl].filter(Boolean).length
  if (provided === 0) return null
  if (provided !== 4) {
    throw new Error(
      'Voice config is incomplete: set all of LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL and LIVEKIT_PUBLIC_URL (or none).'
    )
  }
  if (apiSecret!.length < 32) {
    throw new Error('LIVEKIT_API_SECRET must be at least 32 characters.')
  }
  const api = new URL(apiUrl!)
  if (api.protocol !== 'http:' && api.protocol !== 'https:') {
    throw new Error('LIVEKIT_URL must be an http(s):// URL (server-to-server API).')
  }
  const pub = new URL(publicUrl!)
  if (pub.protocol !== 'ws:' && pub.protocol !== 'wss:') {
    throw new Error('LIVEKIT_PUBLIC_URL must be a ws(s):// URL reachable by desktop clients.')
  }
  // Signaling carries the join token; on the internet it must be encrypted.
  if (pub.protocol === 'ws:' && !isPrivateHost(pub.hostname)) {
    throw new Error('LIVEKIT_PUBLIC_URL must use wss:// for a public host (ws:// is only for a private network).')
  }
  let lanUrl: string | null = null
  const lanRaw = env.LIVEKIT_LAN_URL?.trim()
  if (lanRaw) {
    const lan = new URL(lanRaw)
    if ((lan.protocol !== 'ws:' && lan.protocol !== 'wss:') || !isPrivateHost(lan.hostname)) {
      throw new Error('LIVEKIT_LAN_URL must be a ws(s):// URL on a private address (e.g. ws://192.168.68.65:7880).')
    }
    lanUrl = lan.origin
  }
  return { apiKey: apiKey!, apiSecret: apiSecret!, apiUrl: api.origin, publicUrl: pub.origin, lanUrl }
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal'])

function parseTrustProxy(raw: string | undefined, isProd: boolean): false | string[] {
  const value = raw?.trim() ?? ''
  if (value === '' || ['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    // "Trust everyone" lets any client choose its own IP (and dodge per-IP rate limits).
    if (isProd) {
      throw new Error('TRUST_PROXY=true is not allowed in production: list the reverse proxy address instead (e.g. TRUST_PROXY=172.30.0.10).')
    }
    return ['loopback']
  }
  const entries = list(value)
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/')
    const family = isIP(address ?? '')
    const validCidr =
      bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (family === 6 ? 128 : 32))
    if (!PROXY_KEYWORDS.has(entry) && (family === 0 || !validCidr || extra !== undefined)) {
      throw new Error(`TRUST_PROXY: "${entry}" is not an IP address, CIDR range or loopback/linklocal/uniquelocal.`)
    }
    if (bits !== undefined && Number(bits) === 0) {
      throw new Error('TRUST_PROXY must not cover every address (/0).')
    }
  }
  return entries
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const isProd = nodeEnv === 'production'

  const port = Number(env.PORT ?? 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`)
  }
  const databaseUrl = env.DATABASE_URL ?? 'sqlite:./data/discord2.db'
  const devAuth = bool(env.DEV_AUTH, !isProd)
  // Password-less development identities must never be reachable on a production deployment by
  // accident (e.g. a missing line in .env). Requires an explicit, separate override.
  if (isProd && devAuth && !bool(env.ALLOW_DEV_AUTH_IN_PRODUCTION, false)) {
    throw new Error(
      'DEV_AUTH=true is refused in production. Set DEV_AUTH=false (or, only on a private test network, also set ALLOW_DEV_AUTH_IN_PRODUCTION=true).'
    )
  }

  return {
    env: nodeEnv,
    // Loopback by default so the development server is never reachable from other machines by accident.
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl,
    devAuth,
    corsOrigins: list(env.CORS_ORIGINS),
    allowLocalhostOrigins: bool(env.ALLOW_LOCALHOST_ORIGINS, !isProd),
    // Off in production: the "null" origin is also what any sandboxed iframe or local HTML file
    // sends. Turn on only while desktop apps older than 1.1 (file://) still need to connect.
    allowNullOrigin: bool(env.ALLOW_NULL_ORIGIN, !isProd),
    allowAppOrigin: bool(env.ALLOW_APP_ORIGIN, true),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProd),
    logLevel: env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
    livekit: parseLiveKit(env),
    attachments: parseAttachments(env, databaseUrl),
    auth: parseAuth(env)
  }
}

/** The LiveKit signaling URL for a client that reached the backend at `hostname`. */
export function livekitUrlFor(livekit: LiveKitConfig, hostname: string | null): string {
  return livekit.lanUrl && hostname && isPrivateHost(hostname) ? livekit.lanUrl : livekit.publicUrl
}

export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  if (isIP(host) === 4) return host.startsWith('127.')
  return host === '::1'
}

const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

/** Shared origin policy for CORS and WebSocket upgrades. Missing Origin = non-browser client. */
export function isOriginAllowed(config: Config, origin: string | undefined): boolean {
  if (!origin) return true
  if (origin === 'null') return config.allowNullOrigin
  if (origin === APP_ORIGIN) return config.allowAppOrigin
  if (config.corsOrigins.includes(origin)) return true
  return config.allowLocalhostOrigins && LOCALHOST_ORIGIN.test(origin)
}
