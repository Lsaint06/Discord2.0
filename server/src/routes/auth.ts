/**
 * Real accounts: invite-only registration (and claiming of development identities), password
 * sign-in, sessions/devices, password change and account recovery. Error messages are generic
 * where they could otherwise reveal which usernames exist.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HashBusyError } from '../auth/password.js'
import { normalizePassword, passwordProblem } from '../auth/passwordPolicy.js'
import { hashBusy, requirePassword } from '../auth/reauth.js'
import { CODE_LENGTHS, codeGroups, codeVerifier, newCode, normalizeCode } from '../auth/secrets.js'
import { createSession, requireAuth, toApiSession } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import type { UserRecord } from '../db/repository.js'
import { ApiError, badRequest, notFound, tooManyRequests } from '../lib/errors.js'
import { colorForName, normalizeDisplayName, normalizeEmail, normalizeUsername } from '../lib/validation.js'
import { maskEmail } from '../mail/mailer.js'
import { LIMITS, type ApiAuthResult, type ApiSession } from '../protocol.js'
import { publishServerChanged, toApiMe } from '../realtime.js'
import { disconnectUserFromVoice } from '../voice/enforce.js'

const invalidCredentials = () =>
  new ApiError(401, 'invalid_credentials', 'Incorrect username or password.')
const invalidInvite = () =>
  new ApiError(400, 'invalid_invite', 'This invitation code is invalid, expired or already used.')
const invalidRecovery = () =>
  new ApiError(400, 'invalid_recovery', 'That username and code don’t match, or the code was already used.')
const accountDisabled = () =>
  new ApiError(403, 'account_disabled', 'This account has been disabled. Contact your server administrator.')

// Raw limits are generous (normalization comes after); exact limits are enforced in code.
const passwordField = { type: 'string', maxLength: LIMITS.passwordMaxLength * 4 } as const
const usernameField = { type: 'string', maxLength: 64 } as const
/** Username or email address. */
const loginField = { type: 'string', maxLength: LIMITS.emailMaxLength + 2 } as const
const deviceField = { type: 'string', maxLength: 128 } as const
const codeField = { type: 'string', maxLength: 64 } as const

/**
 * The account a sign-in name refers to: an email address (contains "@") or a username.
 * Anything malformed simply matches nobody.
 */
export async function findUserByLogin(ctx: AppContext, raw: unknown): Promise<UserRecord | undefined> {
  try {
    if (typeof raw === 'string' && raw.includes('@')) return await ctx.repo.findUserByEmail(normalizeEmail(raw))
    return await ctx.repo.findUserByUsername(normalizeUsername(raw))
  } catch {
    return undefined
  }
}

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

/** Account rate-limit key: the attempted username (lower-case, bounded), even if it doesn't exist. */
const accountKey = (raw: unknown): string =>
  typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 64) : ''

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: LIMITS.recoveryCodeCount }, () => newCode(codeGroups('recovery')))
  const hashes = codes.map((c) => codeVerifier('recovery', normalizeCode(c, CODE_LENGTHS.recovery)!))
  return { codes, hashes }
}

export async function hashPassword(ctx: AppContext, password: string): Promise<string> {
  try {
    return await ctx.hasher.hash(password)
  } catch (err) {
    if (err instanceof HashBusyError) throw hashBusy()
    throw err
  }
}

export async function authResult(
  ctx: AppContext,
  user: UserRecord,
  request: FastifyRequest,
  device: unknown,
  recoveryCodes?: string[]
): Promise<ApiAuthResult> {
  const { token, session } = await createSession(ctx, user, 'password', request, device)
  return {
    token,
    user: await toApiMe(ctx, user),
    session: toApiSession(session, session.id),
    ...(recoveryCodes ? { recoveryCodes } : {})
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Claim codes stay usable when registration is closed (they create no new account).
  const registrationClosed = () =>
    new ApiError(403, 'registration_closed', 'This server isn’t accepting new accounts right now.')

  // ---- Invitation details (before registering) ----
  app.post<{ Body: { code: string } }>(
    '/api/auth/invite-info',
    {
      schema: {
        body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: codeField } }
      }
    },
    async (request) => {
      take(ctx.limiters.registerPerIp, request.ip)
      const canonical = normalizeCode(request.body.code, CODE_LENGTHS.register)
      const invite =
        canonical &&
        (await ctx.repo.findOpenRegistrationInvite(codeVerifier('register', canonical), Date.now()))
      if (!invite) throw invalidInvite()
      if (invite.kind === 'register' && ctx.config.registration.mode === 'closed') throw registrationClosed()
      if (invite.kind === 'claim') {
        const target = invite.claimUserId ? await ctx.repo.getUser(invite.claimUserId) : undefined
        if (!target) throw invalidInvite()
        return { kind: 'claim', username: target.username, displayName: target.displayName }
      }
      const server = invite.serverId ? await ctx.repo.getServer(invite.serverId) : undefined
      return { kind: 'register', serverName: server?.name ?? null }
    }
  )

  // ---- Register (or claim a development identity) with an invitation ----
  app.post<{
    Body: { code: string; username?: string; displayName?: string; password: string; device?: string }
  }>(
    '/api/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'password'],
          additionalProperties: false,
          properties: {
            code: codeField,
            username: usernameField,
            displayName: { type: 'string', maxLength: 64 },
            password: passwordField,
            device: deviceField
          }
        }
      }
    },
    async (request, reply) => {
      take(ctx.limiters.registerPerIp, request.ip)
      const now = Date.now()
      const canonical = normalizeCode(request.body.code, CODE_LENGTHS.register)
      if (!canonical) throw invalidInvite()
      const codeHash = codeVerifier('register', canonical)
      // Validate the invitation before anything else (only invite holders learn about usernames).
      const invite = await ctx.repo.findOpenRegistrationInvite(codeHash, now)
      if (!invite) throw invalidInvite()
      if (invite.kind === 'register' && ctx.config.registration.mode === 'closed') throw registrationClosed()

      let username: string
      let displayName: string | undefined
      if (invite.kind === 'claim') {
        const target = invite.claimUserId ? await ctx.repo.getUser(invite.claimUserId) : undefined
        if (!target) throw invalidInvite()
        // The identity comes from the invitation, never from the request.
        username = target.username
        displayName =
          request.body.displayName === undefined ? undefined : normalizeDisplayName(request.body.displayName)
      } else {
        username = normalizeUsername(request.body.username)
        displayName = normalizeDisplayName(request.body.displayName ?? request.body.username ?? '')
      }
      const problem = passwordProblem(request.body.password, { username, displayName })
      if (problem) throw badRequest(problem, 'weak_password')
      const passwordHash = await hashPassword(ctx, normalizePassword(request.body.password))
      const recovery = newRecoveryCodes()

      const result = await ctx.repo
        .registerWithInvite({
          codeHash,
          now,
          newUser: {
            id: randomUUID(),
            username,
            displayName: displayName ?? username,
            avatarColor: colorForName(username),
            bot: false,
            createdAt: now,
            instanceAdmin: false,
            disabledAt: null
          },
          passwordHash,
          recoveryHashes: recovery.hashes,
          displayName: invite.kind === 'claim' ? displayName : undefined
        })
        .catch(() => ({ ok: false as const, reason: 'invalid_invite' as const }))
      if (!result.ok) {
        if (result.reason === 'username_taken') {
          throw new ApiError(409, 'username_taken', 'That username is taken. Pick another one.')
        }
        if (result.reason === 'already_claimed') {
          throw new ApiError(409, 'already_claimed', 'This account has already been claimed.')
        }
        throw invalidInvite()
      }

      const user = result.user
      if (invite.kind === 'claim') {
        // Anyone still signed in to the development identity is signed out now.
        ctx.hub.closeUser(user.id, 'Account claimed')
        await disconnectUserFromVoice(ctx, user.id, 'account claimed')
      } else if (invite.serverId) {
        await publishServerChanged(ctx, invite.serverId)
      }
      await ctx.audit.record({
        action: invite.kind === 'claim' ? 'auth.claim' : 'auth.register',
        actorId: user.id,
        targetUserId: user.id,
        request,
        detail: { inviteId: invite.id, username: user.username }
      })
      await ctx.hub.publishUser(user)
      reply.code(201)
      return authResult(ctx, user, request, request.body.device, recovery.codes)
    }
  )

  // ---- Sign in (username, or the account's email address) ----
  app.post<{ Body: { username: string; password: string; device?: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: { username: loginField, password: passwordField, device: deviceField }
        }
      }
    },
    async (request) => {
      take(ctx.limiters.loginPerIp, request.ip)
      take(ctx.limiters.loginPerAccount, accountKey(request.body.username))
      const password = normalizePassword(request.body.password)

      const user = await findUserByLogin(ctx, request.body.username)
      const stored = user && !user.bot ? await ctx.repo.getPasswordHash(user.id) : undefined

      let ok = false
      try {
        if (user && stored) ok = await ctx.hasher.verify(stored, password)
        // Same work whether or not the account exists (no username enumeration by timing).
        else await ctx.hasher.verifyDummy(password)
      } catch (err) {
        if (err instanceof HashBusyError) throw hashBusy()
        throw err
      }
      if (!user || !stored || !ok) {
        await ctx.audit.record({
          action: 'auth.login_failed',
          targetUserId: user?.id ?? null,
          request,
          detail: { reason: !user ? 'unknown_user' : !stored ? 'no_password' : 'wrong_password' }
        })
        throw invalidCredentials()
      }
      if (user.disabledAt) throw accountDisabled()
      // Correct password, but the address of a self-registered account isn't confirmed yet:
      // the app continues with the code entry (resend is available there).
      if (user.signupPending) {
        throw new ApiError(
          403,
          'email_unverified',
          `Confirm your email address first: enter the code we sent to ${maskEmail(user.email ?? '')}.`
        )
      }
      if (ctx.hasher.needsRehash(stored)) {
        await ctx.repo.setPasswordHash(user.id, await hashPassword(ctx, password), Date.now())
      }
      const result = await authResult(ctx, user, request, request.body.device)
      await ctx.audit.record({
        action: 'auth.login',
        actorId: user.id,
        request,
        detail: { sessionId: result.session.id }
      })
      return result
    }
  )

  // ---- Sign out ----
  app.post('/api/auth/logout', async (request, reply) => {
    const { user, session } = await requireAuth(ctx, request)
    await ctx.repo.revokeSession(user.id, session.id, Date.now())
    ctx.hub.closeSessions([session.id], 'Signed out')
    await ctx.audit.record({ action: 'auth.logout', actorId: user.id, request, detail: { sessionId: session.id } })
    reply.code(204)
  })

  app.post<{ Body: { keepCurrent?: boolean } }>(
    '/api/auth/logout-all',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { keepCurrent: { type: 'boolean' } }
        }
      }
    },
    async (request) => {
      const { user, session } = await requireAuth(ctx, request)
      take(ctx.limiters.accountPerUser, user.id)
      const keep = request.body?.keepCurrent === true
      const revoked = await ctx.repo.revokeUserSessions(user.id, Date.now(), keep ? { exceptId: session.id } : {})
      ctx.hub.closeSessions(revoked, 'Signed out on all devices')
      if (!keep) await disconnectUserFromVoice(ctx, user.id, 'signed out everywhere')
      await ctx.audit.record({
        action: 'auth.logout_all',
        actorId: user.id,
        request,
        detail: { revoked: revoked.length, keepCurrent: keep }
      })
      return { revoked: revoked.length }
    }
  )

  // ---- Devices / sessions ----
  app.get('/api/auth/sessions', async (request): Promise<ApiSession[]> => {
    const { user, session } = await requireAuth(ctx, request)
    return (await ctx.repo.listSessions(user.id, Date.now()))
      .filter((s) => s.lastUsedAt + ctx.config.auth.sessionIdleMs > Date.now())
      .filter((s) => s.kind === 'password' || ctx.config.devAuth)
      .map((s) => toApiSession(s, session.id))
  })

  app.delete<{ Params: { sessionId: string } }>(
    '/api/auth/sessions/:sessionId',
    {
      schema: {
        params: { type: 'object', properties: { sessionId: { type: 'string', pattern: '^[0-9a-f]{32}$' } } }
      }
    },
    async (request, reply) => {
      const { user } = await requireAuth(ctx, request)
      take(ctx.limiters.accountPerUser, user.id)
      // Scoped to the caller's own sessions: another user's session id is simply "not found".
      if (!(await ctx.repo.revokeSession(user.id, request.params.sessionId, Date.now()))) {
        throw notFound('Session not found')
      }
      ctx.hub.closeSessions([request.params.sessionId], 'Signed out from another device')
      await ctx.audit.record({
        action: 'auth.session_revoked',
        actorId: user.id,
        request,
        detail: { sessionId: request.params.sessionId }
      })
      reply.code(204)
    }
  )

  // ---- Password change (current password required; other sessions are signed out) ----
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: { currentPassword: passwordField, newPassword: passwordField }
        }
      }
    },
    async (request) => {
      const { user, session } = await requireAuth(ctx, request)
      await requirePassword(ctx, user, request.body.currentPassword, request)
      const problem = passwordProblem(request.body.newPassword, {
        username: user.username,
        displayName: user.displayName
      })
      if (problem) throw badRequest(problem, 'weak_password')
      if (normalizePassword(request.body.newPassword) === normalizePassword(request.body.currentPassword)) {
        throw badRequest('Choose a password different from your current one.', 'weak_password')
      }
      await ctx.repo.setPasswordHash(user.id, await hashPassword(ctx, normalizePassword(request.body.newPassword)), Date.now())
      const revoked = await ctx.repo.revokeUserSessions(user.id, Date.now(), { exceptId: session.id })
      ctx.hub.closeSessions(revoked, 'Password changed')
      if (revoked.length > 0) await disconnectUserFromVoice(ctx, user.id, 'password changed')
      await ctx.audit.record({
        action: 'auth.password_changed',
        actorId: user.id,
        request,
        detail: { otherSessionsRevoked: revoked.length }
      })
      return { otherSessionsRevoked: revoked.length }
    }
  )

  // ---- Recovery codes ----
  app.get('/api/auth/recovery-codes', async (request) => {
    const { user } = await requireAuth(ctx, request)
    return { remaining: await ctx.repo.countRecoveryCodes(user.id) }
  })

  app.post<{ Body: { password: string } }>(
    '/api/auth/recovery-codes',
    {
      schema: {
        body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: passwordField } }
      }
    },
    async (request) => {
      const { user } = await requireAuth(ctx, request)
      await requirePassword(ctx, user, request.body.password, request)
      const recovery = newRecoveryCodes()
      await ctx.repo.replaceRecoveryCodes(user.id, recovery.hashes, Date.now())
      await ctx.audit.record({ action: 'auth.recovery_codes_regenerated', actorId: user.id, request })
      return { codes: recovery.codes }
    }
  )

  // ---- Account recovery: a recovery code, or an administrator-issued reset code ----
  app.post<{ Body: { username: string; code: string; newPassword: string; device?: string } }>(
    '/api/auth/recover',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'code', 'newPassword'],
          additionalProperties: false,
          properties: { username: usernameField, code: codeField, newPassword: passwordField, device: deviceField }
        }
      }
    },
    async (request) => {
      take(ctx.limiters.recoverPerIp, request.ip)
      take(ctx.limiters.recoverPerAccount, accountKey(request.body.username))
      // Password rules first (against the typed username), so the error can't reveal whether
      // the account exists.
      const problem = passwordProblem(request.body.newPassword, { username: accountKey(request.body.username) })
      if (problem) throw badRequest(problem, 'weak_password')
      let user: UserRecord | undefined
      try {
        user = await ctx.repo.findUserByUsername(normalizeUsername(request.body.username))
      } catch {
        user = undefined
      }
      if (!user || user.bot || !(await ctx.repo.getPasswordHash(user.id))) throw invalidRecovery()

      const now = Date.now()
      const recovery = normalizeCode(request.body.code, CODE_LENGTHS.recovery)
      const reset = normalizeCode(request.body.code, CODE_LENGTHS.reset)
      let method: 'recovery' | 'reset' | null = null
      if (recovery && (await ctx.repo.useRecoveryCode(user.id, codeVerifier('recovery', recovery), now))) {
        method = 'recovery'
      } else if (reset && (await ctx.repo.usePasswordReset(codeVerifier('reset', reset), user.id, now))) {
        method = 'reset'
      }
      if (!method) {
        await ctx.audit.record({
          action: 'auth.login_failed',
          targetUserId: user.id,
          request,
          detail: { reason: 'bad_recovery_code' }
        })
        throw invalidRecovery()
      }
      // Only after a valid code: a disabled account stays disabled (the code is already spent,
      // which is fine — the administrator can issue a new one after re-enabling).
      if (user.disabledAt) throw accountDisabled()

      await ctx.repo.setPasswordHash(user.id, await hashPassword(ctx, normalizePassword(request.body.newPassword)), now)
      // Someone may have had the old password: every existing session ends.
      const revoked = await ctx.repo.revokeUserSessions(user.id, now)
      ctx.hub.closeSessions(revoked, 'Password reset')
      await disconnectUserFromVoice(ctx, user.id, 'password reset')
      await ctx.audit.record({
        action: method === 'recovery' ? 'auth.recovery_used' : 'auth.reset_used',
        actorId: user.id,
        request,
        detail: { sessionsRevoked: revoked.length }
      })
      const remaining = await ctx.repo.countRecoveryCodes(user.id)
      return { ...(await authResult(ctx, user, request, request.body.device)), recoveryCodesRemaining: remaining }
    }
  )
}
