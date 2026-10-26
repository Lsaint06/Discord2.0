import { isIP } from 'node:net'

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

  return {
    env: nodeEnv,
    // Loopback by default so the development server is never reachable from other machines by accident.
    host: env.HOST ?? '127.0.0.1',
    port,
    databaseUrl: env.DATABASE_URL ?? 'sqlite:./data/discord2.db',
    devAuth: bool(env.DEV_AUTH, !isProd),
    corsOrigins: list(env.CORS_ORIGINS),
    allowLocalhostOrigins: bool(env.ALLOW_LOCALHOST_ORIGINS, !isProd),
    allowNullOrigin: bool(env.ALLOW_NULL_ORIGIN, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')
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
