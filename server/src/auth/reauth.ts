import type { FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import type { UserRecord } from '../db/repository.js'
import { ApiError, forbidden, tooManyRequests } from '../lib/errors.js'
import { HashBusyError } from './password.js'
import { normalizePassword } from './passwordPolicy.js'

export const hashBusy = () =>
  new ApiError(503, 'busy', 'The server is busy. Try again in a moment.', 2000)

/**
 * Re-authentication for sensitive operations (password change, recovery codes, ownership
 * transfer, administrator actions): the current password must be supplied with the request.
 */
export async function requirePassword(
  ctx: AppContext,
  user: UserRecord,
  password: unknown,
  request: FastifyRequest
): Promise<void> {
  const limit = ctx.limiters.accountPerUser.take(user.id)
  if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
  const stored = await ctx.repo.getPasswordHash(user.id)
  if (!stored) {
    throw forbidden('This needs a password-protected account. Claim your account first.', 'password_required')
  }
  let ok = false
  try {
    ok = typeof password === 'string' && (await ctx.hasher.verify(stored, normalizePassword(password)))
  } catch (err) {
    if (err instanceof HashBusyError) throw hashBusy()
    throw err
  }
  if (!ok) {
    await ctx.audit.record({ action: 'auth.login_failed', actorId: user.id, request, detail: { reason: 'reauth' } })
    throw new ApiError(403, 'wrong_password', 'Your current password is incorrect.')
  }
}
