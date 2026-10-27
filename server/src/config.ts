import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_ARGON2, validateArgon2Params, type Argon2Params } from './auth/password.js'

export interface LiveKitConfig {
  apiKey: string
  /** Server-side only. Never sent to clients. */
  apiSecret: string
  /** URL the backend uses for LiveKit's server API (e.g. http://livekit:7880). */
  apiUrl: string
  /** WebSocket URL handed to desktop clients (e.g. ws://192.168.68.65:7880). */
  publicUrl: string
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
  /** Allow the "null" origin sent by Electron windows loaded from file:// (packaged app). */
  allowNullOrigin: boolean
  trustProxy: boolean
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
  return { apiKey: apiKey!, apiSecret: apiSecret!, apiUrl: api.origin, publicUrl: pub.origin }
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

  return {
    env: nodeEnv,
    // Loopback by default so the development server is never reachable from other machines by accident.
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl,
    devAuth: bool(env.DEV_AUTH, !isProd),
    corsOrigins: list(env.CORS_ORIGINS),
    allowLocalhostOrigins: bool(env.ALLOW_LOCALHOST_ORIGINS, !isProd),
    allowNullOrigin: bool(env.ALLOW_NULL_ORIGIN, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
    livekit: parseLiveKit(env),
    attachments: parseAttachments(env, databaseUrl),
    auth: parseAuth(env)
  }
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
  if (config.corsOrigins.includes(origin)) return true
  return config.allowLocalhostOrigins && LOCALHOST_ORIGIN.test(origin)
}
