import { createHash, randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Repository, UserRecord } from '../db/repository.js'
import { unauthorized } from './errors.js'

/** Opaque bearer token; only its SHA-256 hash is stored server-side. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/

/** Resolves the user from a token. The user id is always derived server-side, never taken from the client. */
export async function userFromToken(
  repo: Repository,
  token: unknown
): Promise<UserRecord | undefined> {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return undefined
  return repo.findUserBySessionHash(hashToken(token), Date.now())
}

export async function requireUser(repo: Repository, request: FastifyRequest): Promise<UserRecord> {
  const header = request.headers.authorization
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null
  const user = await userFromToken(repo, match?.[1])
  if (!user) throw unauthorized()
  return user
}
