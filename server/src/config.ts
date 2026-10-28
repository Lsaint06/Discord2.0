import { readFileSync } from 'node:fs'
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
  /** Chunked, resumable uploads of large files (Milestone 13). null = off (the default). */
  large: LargeFileConfig | null
}

export interface LargeFileConfig {
  /** Largest file (5 GB by default). */
  maxFileBytes: number
  /** Files strictly larger than this expire after `ephemeralMs` (500 MB by default). */
  ephemeralThresholdBytes: number
  /** Lifetime of large files, counted from upload completion (24 h by default). */
  ephemeralMs: number
  /** Active (unexpired) large files plus open sessions, per user. */
  userQuotaBytes: number
  /** All active large files plus open sessions. */
  poolBytes: number
  /** New large uploads are refused when free space would fall below this. */
  minFreeBytes: number
  /** Simultaneous upload sessions per user. */
  concurrentPerUser: number
  /** Sessions without progress for this long are abandoned and deleted. */
  abandonAfterMs: number
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

/**
 * Who may create accounts:
 *   invite: only with a registration invitation from an administrator (default; unchanged).
 *   open:   anyone may sign up with an email address they confirm (invitations still work).
 *   closed: no new accounts (claiming existing development identities still works).
 */
export type RegistrationMode = 'invite' | 'open' | 'closed'

export interface RegistrationConfig {
  mode: RegistrationMode
  /** Optional server every self-registered account joins after confirming its email. */
  autoJoinServerId: string | null
}

export type MailConfig =
  | { transport: 'none' }
  | { transport: 'file'; dir: string }
  | {
      transport: 'smtp'
      host: string
      port: number
      /** Implicit TLS (port 465). Otherwise STARTTLS is required. */
      secure: boolean
      user: string | null
      /** Server-side only; read from SMTP_PASSWORD or SMTP_PASSWORD_FILE. */
      password: string | null
      from: string
      /** Allow a relay without TLS (local test relays only). */
      allowInsecure: boolean
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
  registration: RegistrationConfig
  mail: MailConfig
  /** GIF picker (Milestone 13). provider 'none' = feature off. */
  gifs: GifConfig
}

export type GifProviderName = 'none' | 'giphy' | 'mock'
export type GifRating = 'g' | 'pg' | 'pg-13' | 'r'

export interface GifConfig {
  provider: GifProviderName
  /** Provider API key (server side only; never sent to clients). */
  apiKey: string | null
  /** Highest content rating returned. */
  rating: GifRating
  /** Two-letter country of the users (providers ask for it when requests are proxied). */
  country: string | null
  /** Language hint for search (ISO 639-1). */
  locale: string
}

function parseGifs(env: NodeJS.ProcessEnv, isProd: boolean): GifConfig {
  const provider = (env.GIF_PROVIDER ?? 'none').trim().toLowerCase() || 'none'
  if (!['none', 'giphy', 'mock'].includes(provider)) {
    throw new Error('GIF_PROVIDER must be none, giphy or mock')
  }
  if (provider === 'mock' && isProd) throw new Error('GIF_PROVIDER=mock is for development and tests only')
  let apiKey = env.GIF_API_KEY?.trim() || null
  const keyFile = env.GIF_API_KEY_FILE?.trim()
  if (keyFile) {
    if (apiKey) throw new Error('Set GIF_API_KEY or GIF_API_KEY_FILE, not both')
    apiKey = readFileSync(keyFile, 'utf8').trim() || null
  }
  if (provider === 'giphy' && !apiKey) {
    throw new Error('GIF_PROVIDER=giphy needs GIF_API_KEY (or GIF_API_KEY_FILE)')
  }
  if (apiKey && !/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) throw new Error('GIF_API_KEY has an unexpected format')
  const rating = (env.GIF_RATING ?? 'pg-13').trim().toLowerCase()
  if (!['g', 'pg', 'pg-13', 'r'].includes(rating)) throw new Error('GIF_RATING must be g, pg, pg-13 or r')
  const country = env.GIF_COUNTRY?.trim().toUpperCase() || null
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('GIF_COUNTRY must be a two-letter country code')
  const locale = env.GIF_LOCALE?.trim().toLowerCase() || 'en'
  if (!/^[a-z]{2}$/.test(locale)) throw new Error('GIF_LOCALE must be a two-letter language code')
  return {
    provider: provider as GifProviderName,
    apiKey: provider === 'giphy' ? apiKey : null,
    rating: rating as GifRating,
    country,
    locale
  }
}

const DAY = 24 * 60 * 60_000

function parseMail(env: NodeJS.ProcessEnv, isProd: boolean, databaseUrl: string): MailConfig {
  const transport = (env.MAIL_TRANSPORT ?? 'none').trim().toLowerCase() || 'none'
  if (transport === 'none') return { transport: 'none' }
  if (transport === 'file') {
    // A file sink "delivers" nothing: in production people would never receive their codes.
    if (isProd) throw new Error('MAIL_TRANSPORT=file is a development mail sink and is refused in production. Use smtp.')
    const dir = env.MAIL_SINK_DIR?.trim()
    return {
      transport: 'file',
      dir: resolve(dir || join(dirname(defaultAttachmentsDir(databaseUrl)), 'mail-sink'))
    }
  }
  if (transport !== 'smtp') throw new Error('MAIL_TRANSPORT must be none, smtp or file')

  const host = env.SMTP_HOST?.trim()
  if (!host) throw new Error('MAIL_TRANSPORT=smtp needs SMTP_HOST')
  const secure = bool(env.SMTP_SECURE, env.SMTP_PORT?.trim() === '465')
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : secure ? 465 : 587
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SMTP_PORT: ${env.SMTP_PORT}`)
  const from = env.MAIL_FROM?.trim()
  if (!from || !/@[^@\s>]+\.[^@\s>]+>?$/.test(from)) {
    throw new Error('MAIL_FROM must be a sender address, e.g. "Discord 2.0 <no-reply@example.com>"')
  }
  let password = env.SMTP_PASSWORD || null
  const passwordFile = env.SMTP_PASSWORD_FILE?.trim()
  if (passwordFile) {
    if (password) throw new Error('Set SMTP_PASSWORD or SMTP_PASSWORD_FILE, not both')
    password = readFileSync(passwordFile, 'utf8').trim()
  }
  const user = env.SMTP_USER?.trim() || null
  // Otherwise every login to the relay fails and nobody ever receives a code.
  if (user && !password) throw new Error('SMTP_USER is set but there is no SMTP_PASSWORD (or SMTP_PASSWORD_FILE)')
  const allowInsecure = bool(env.SMTP_ALLOW_INSECURE, false)
  if (allowInsecure && isProd && !isPrivateHost(host) && !isLoopbackHost(host)) {
    throw new Error('SMTP_ALLOW_INSECURE is only allowed for a relay on a private network.')
  }
  return {
    transport: 'smtp',
    host,
    port,
    secure,
    user,
    password,
    from,
    allowInsecure
  }
}

function parseRegistration(env: NodeJS.ProcessEnv, mail: MailConfig): RegistrationConfig {
  const mode = (env.REGISTRATION_MODE ?? 'invite').trim().toLowerCase() || 'invite'
  if (mode !== 'invite' && mode !== 'open' && mode !== 'closed') {
    throw new Error('REGISTRATION_MODE must be invite, open or closed')
  }
  // Self-registration is only safe when the email address can actually be confirmed.
  if (mode === 'open' && mail.transport === 'none') {
    throw new Error('REGISTRATION_MODE=open needs email delivery: set MAIL_TRANSPORT=smtp (see .env.example).')
  }
  const autoJoin = env.REGISTRATION_AUTO_JOIN_SERVER?.trim() || null
  if (autoJoin && (autoJoin.length > 64 || autoJoin === '@direct')) {
    throw new Error('REGISTRATION_AUTO_JOIN_SERVER must be a server id')
  }
  return { mode: mode as RegistrationMode, autoJoinServerId: autoJoin }
}

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
    pendingTtlMs: 6 * 60 * 60_000,
    large: bool(env.UPLOAD_LARGE_FILES, false) ? parseLargeFiles(env) : null
  }
}

/** The agreed ceiling for one file (5 GB). */
const LARGE_FILE_CEILING_MB = 5 * 1024

function parseLargeFiles(env: NodeJS.ProcessEnv): LargeFileConfig {
  const bytes = (name: string, fallbackMb: number): number => Math.floor(positiveNumber(env, name, fallbackMb) * MB)
  const maxMb = positiveNumber(env, 'UPLOAD_MAX_LARGE_FILE_MB', LARGE_FILE_CEILING_MB)
  if (maxMb > LARGE_FILE_CEILING_MB) throw new Error(`UPLOAD_MAX_LARGE_FILE_MB can be at most ${LARGE_FILE_CEILING_MB} (5 GB)`)
  return {
    maxFileBytes: Math.floor(maxMb * MB),
    ephemeralThresholdBytes: bytes('UPLOAD_EPHEMERAL_THRESHOLD_MB', 500),
    ephemeralMs: Math.floor(positiveNumber(env, 'UPLOAD_EPHEMERAL_HOURS', 24) * 60 * 60_000),
    userQuotaBytes: bytes('UPLOAD_LARGE_USER_QUOTA_MB', 20 * 1024),
    poolBytes: bytes('UPLOAD_LARGE_POOL_MB', 200 * 1024),
    minFreeBytes: bytes('UPLOAD_LARGE_MIN_FREE_MB', 100 * 1024),
    concurrentPerUser: Math.max(1, Math.floor(positiveNumber(env, 'UPLOAD_LARGE_CONCURRENT', 2))),
    abandonAfterMs: 24 * 60 * 60_000
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

  const mail = parseMail(env, isProd, databaseUrl)

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
    auth: parseAuth(env),
    registration: parseRegistration(env, mail),
    mail,
    gifs: parseGifs(env, isProd)
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
