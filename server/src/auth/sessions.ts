/**
 * Server-managed sessions. The client holds a random 256-bit bearer token; the server stores
 * only its SHA-256 and decides validity on every request:
 *   - not revoked (logout, logout-all, password change, account disabled, identity claimed)
 *   - not past its absolute expiry (SESSION_MAX_DAYS) or idle timeout (SESSION_IDLE_DAYS)
 *   - the account isn't disabled
 *   - development sessions only while DEV_AUTH is enabled (turning it off invalidates them;
 *     a failed password login never falls back to development sign-in)
 * Tokens are always generated here (no session fixation) and never appear in URLs or logs.
 */
import type { FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import type { SessionKind, SessionRecord, UserRecord } from '../db/repository.js'
import { unauthorized } from '../lib/errors.js'
import type { ApiSession } from '../protocol.js'
import { newId, newSessionToken, sha256Hex } from './secrets.js'

export interface AuthContext {
  user: UserRecord
  session: SessionRecord
}

/** last_used_at is written at most this often per session (avoids a write per request). */
const TOUCH_INTERVAL_MS = 60_000
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/

type SessionDeps = Pick<AppContext, 'repo' | 'config'>

export function sessionUsable(
  deps: SessionDeps,
  found: AuthContext,
  now: number
): boolean {
  const { session, user } = found
  if (session.revokedAt !== null) return false
  if (session.expiresAt <= now) return false
  if (session.lastUsedAt + deps.config.auth.sessionIdleMs <= now) return false
  if (user.disabledAt) return false
  if (user.bot) return false
  if (session.kind === 'dev' && !deps.config.devAuth) return false
  return true
}

/** Resolves a bearer token to a valid session, or undefined. Never trusts a client-supplied user id. */
export async function authenticateToken(
  deps: SessionDeps,
  token: unknown,
  ip: string | null = null,
  now = Date.now()
): Promise<AuthContext | undefined> {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return undefined
  const found = await deps.repo.findSession(sha256Hex(token))
  if (!found || !sessionUsable(deps, found, now)) return undefined
  if (now - found.session.lastUsedAt > TOUCH_INTERVAL_MS) {
    await deps.repo.touchSession(found.session.id, now, ip)
    found.session = { ...found.session, lastUsedAt: now, lastIp: ip }
  }
  return found
}

const resolved = new WeakMap<FastifyRequest, AuthContext>()
const BEARER = /^Bearer ([A-Za-z0-9_-]{20,128})$/

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  return typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined
}

/** The request's session (401 if missing, expired or revoked). Cached per request. */
export async function requireAuth(deps: SessionDeps, request: FastifyRequest): Promise<AuthContext> {
  const cached = resolved.get(request)
  if (cached) return cached
  const auth = await authenticateToken(deps, bearerToken(request), request.ip)
  if (!auth) throw unauthorized('Your session has expired or was signed out. Please sign in again.')
  resolved.set(request, auth)
  return auth
}

export async function requireUser(deps: SessionDeps, request: FastifyRequest): Promise<UserRecord> {
  return (await requireAuth(deps, request)).user
}

function deviceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64)
  return clean || null
}

/** Creates a fresh session (new random token) and returns the token once. */
export async function createSession(
  deps: SessionDeps,
  user: UserRecord,
  kind: SessionKind,
  request: FastifyRequest | null,
  device?: unknown,
  now = Date.now()
): Promise<{ token: string; session: SessionRecord }> {
  const token = newSessionToken()
  const ip = request?.ip ?? null
  const session: SessionRecord = {
    id: newId(),
    tokenHash: sha256Hex(token),
    userId: user.id,
    kind,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + deps.config.auth.sessionMaxAgeMs,
    revokedAt: null,
    device: deviceLabel(device),
    createdIp: ip,
    lastIp: ip
  }
  await deps.repo.insertSession(session)
  return { token, session }
}

export function toApiSession(session: SessionRecord, currentId?: string): ApiSession {
  return {
    id: session.id,
    kind: session.kind,
    device: session.device,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    ip: session.lastIp,
    current: session.id === currentId
  }
}
