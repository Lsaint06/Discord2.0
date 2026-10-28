/**
 * Milestone 13: email accounts.
 *   - Self-registration (REGISTRATION_MODE=open): sign up → code by email → confirmed → signed in.
 *   - Password reset by email for accounts with a confirmed address.
 *   - Adding, confirming and removing an address on an existing account.
 *
 * Account enumeration: sign-up, resend and "forgot password" answer the same way (202) whether
 * or not an account uses the address, emails go out in the background (same timing), and the
 * per-address rate limit applies to unknown addresses too. A username that is taken is reported
 * (usernames are public in the app anyway); an address that is taken never is — its owner gets
 * a "you already have an account" email instead.
 *
 * Activating a sign-up needs the emailed code and the account's password, so nobody can claim
 * an account someone else started with their address (or vice versa). An unconfirmed sign-up
 * doesn't own its address: a newer sign-up, or an account confirming the address, replaces it
 * (so nobody can block someone else's address until the 24-hour cleanup).
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HashBusyError } from '../auth/password.js'
import { normalizePassword, passwordProblem } from '../auth/passwordPolicy.js'
import { hashBusy, requirePassword } from '../auth/reauth.js'
import { EMAIL_CODE_LENGTH, emailCodeVerifier, newEmailCode, newId, normalizeCode, sha256Hex } from '../auth/secrets.js'
import { requireAuth } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import type { EmailCodePurpose, EmailCodeRecord, UserRecord } from '../db/repository.js'
import { ApiError, badRequest, conflict, forbidden, tooManyRequests } from '../lib/errors.js'
import { colorForName, normalizeDisplayName, normalizeEmail, normalizeUsername } from '../lib/validation.js'
import { accountExistsEmail, emailChangeEmail, passwordResetEmail, verificationEmail } from '../mail/templates.js'
import { LIMITS, type ApiAccountEmail, type ApiAuthResult, type ApiEmailSent } from '../protocol.js'
import { publishServerChanged } from '../realtime.js'
import { disconnectUserFromVoice } from '../voice/enforce.js'
import { authResult, findUserByLogin, hashPassword } from './auth.js'

/** Minutes an emailed code stays valid. */
export const EMAIL_CODE_TTL_MINUTES = 30
/** Wrong guesses before a code stops working (a new one must be requested). */
export const EMAIL_CODE_MAX_ATTEMPTS = 5
/** Unconfirmed sign-ups are deleted after this long (frees the username and address). */
export const PENDING_SIGNUP_TTL_MS = 24 * 60 * 60_000

const passwordField = { type: 'string', maxLength: LIMITS.passwordMaxLength * 4 } as const
const emailField = { type: 'string', maxLength: LIMITS.emailMaxLength + 2 } as const
const loginField = { type: 'string', maxLength: LIMITS.emailMaxLength + 2 } as const
const codeField = { type: 'string', maxLength: 32 } as const
const deviceField = { type: 'string', maxLength: 128 } as const

const invalidCode = () =>
  new ApiError(
    400,
    'invalid_code',
    'That code is wrong or has expired. Use the newest email from Discord 2.0, or send a new code.'
  )
const accountDisabled = () =>
  new ApiError(403, 'account_disabled', 'This account has been disabled. Contact your server administrator.')

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

/** Limiter key for an address or sign-in name (kept out of memory in plain form). */
const keyOf = (value: unknown): string =>
  sha256Hex(`limit:${typeof value === 'string' ? value.trim().toLowerCase().slice(0, 300) : ''}`)

const emailSent = (): ApiEmailSent => ({ status: 'email_sent', expiresInMinutes: EMAIL_CODE_TTL_MINUTES })

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireMail = (): void => {
    if (!ctx.mail.available) {
      throw new ApiError(503, 'email_unavailable', 'Email isn’t set up on this server. Ask the administrator for help.')
    }
  }

  /** Per-address and server-wide email budget. Applies whether or not the address has an account. */
  const allowSend = (email: string): void => {
    take(ctx.limiters.emailsPerAddress, keyOf(email))
    take(ctx.limiters.emailsGlobal, 'all')
  }

  const newCode = (
    userId: string,
    purpose: EmailCodePurpose,
    email: string,
    now: number
  ): { code: string; record: EmailCodeRecord } => {
    const code = newEmailCode()
    return {
      code,
      record: {
        id: newId(),
        userId,
        purpose,
        email,
        codeHash: emailCodeVerifier(purpose, email, normalizeCode(code, EMAIL_CODE_LENGTH)!),
        createdAt: now,
        expiresAt: now + EMAIL_CODE_TTL_MINUTES * 60_000,
        attempts: 0,
        usedAt: null
      }
    }
  }

  /** Same work whether or not the account exists (no enumeration by timing). */
  const passwordMatches = async (user: UserRecord | undefined, password: string): Promise<boolean> => {
    const stored = user && !user.bot ? await ctx.repo.getPasswordHash(user.id) : undefined
    try {
      if (user && stored) return await ctx.hasher.verify(stored, normalizePassword(password))
      await ctx.hasher.verifyDummy(normalizePassword(password))
      return false
    } catch (err) {
      if (err instanceof HashBusyError) throw hashBusy()
      throw err
    }
  }

  const checkCode = async (
    user: UserRecord,
    purpose: EmailCodePurpose,
    email: string,
    raw: string,
    peek = false
  ): Promise<EmailCodeRecord | null> => {
    const canonical = normalizeCode(raw, EMAIL_CODE_LENGTH)
    if (!canonical) return null
    return ctx.repo.consumeEmailCode({
      userId: user.id,
      purpose,
      codeHash: emailCodeVerifier(purpose, email, canonical),
      now: Date.now(),
      maxAttempts: EMAIL_CODE_MAX_ATTEMPTS,
      peek
    })
  }

  // ---- Sign up with an email address (REGISTRATION_MODE=open) ----
  app.post<{ Body: { email: string; username: string; displayName?: string; password: string } }>(
    '/api/auth/signup',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'username', 'password'],
          additionalProperties: false,
          properties: {
            email: emailField,
            username: { type: 'string', maxLength: 64 },
            displayName: { type: 'string', maxLength: 64 },
            password: passwordField
          }
        }
      }
    },
    async (request, reply): Promise<ApiEmailSent> => {
      const mode = ctx.config.registration.mode
      if (mode !== 'open') {
        throw forbidden(
          mode === 'closed'
            ? 'This server isn’t accepting new accounts right now.'
            : 'New accounts on this server need an invitation code.',
          mode === 'closed' ? 'registration_closed' : 'invite_required'
        )
      }
      requireMail()
      take(ctx.limiters.signupPerIp, request.ip)
      const email = normalizeEmail(request.body.email)
      const username = normalizeUsername(request.body.username)
      const displayName = normalizeDisplayName(
        request.body.displayName?.trim() ? request.body.displayName : username
      )
      const problem = passwordProblem(request.body.password, { username, displayName })
      if (problem) throw badRequest(problem, 'weak_password')
      allowSend(email)
      const passwordHash = await hashPassword(ctx, normalizePassword(request.body.password))

      const now = Date.now()
      const id = randomUUID()
      const { code, record } = newCode(id, 'verify', email, now)
      const result = await ctx.repo.registerWithEmail({
        newUser: {
          id,
          username,
          displayName,
          avatarColor: colorForName(username),
          bot: false,
          createdAt: now,
          instanceAdmin: false,
          disabledAt: null
        },
        email,
        passwordHash,
        code: record
      })
      if (!result.ok && result.reason === 'username_taken') {
        throw conflict('That username is taken. Pick another one.', 'username_taken')
      }
      if (result.ok) {
        ctx.mail.enqueue(verificationEmail(email, result.user.username, code, EMAIL_CODE_TTL_MINUTES), 'signup')
      } else {
        ctx.mail.enqueue(accountExistsEmail(email), 'signup_existing')
      }
      await ctx.audit.record({
        action: 'auth.signup',
        targetUserId: result.ok ? result.user.id : null,
        request,
        detail: {
          outcome: result.ok ? (result.user.id === id ? 'created' : 'retried') : 'address_in_use',
          ...(result.ok ? { username: result.user.username } : {})
        }
      })
      reply.code(202)
      return emailSent()
    }
  )

  // ---- Confirm the address of a new account (code + the account's password) ----
  app.post<{ Body: { login: string; password: string; code: string; device?: string } }>(
    '/api/auth/verify-email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['login', 'password', 'code'],
          additionalProperties: false,
          properties: { login: loginField, password: passwordField, code: codeField, device: deviceField }
        }
      }
    },
    async (request): Promise<ApiAuthResult> => {
      take(ctx.limiters.emailCodesPerIp, request.ip)
      take(ctx.limiters.emailCodesPerAddress, keyOf(request.body.login))
      const found = await findUserByLogin(ctx, request.body.login)
      const pending = found?.signupPending && found.email ? found : undefined
      // Password first: someone who doesn't know it can't use up the code's attempts.
      if (!(await passwordMatches(pending, request.body.password)) || !pending) throw invalidCode()
      const used = await checkCode(pending, 'verify', pending.email!, request.body.code)
      if (!used) {
        await ctx.audit.record({
          action: 'auth.login_failed',
          targetUserId: pending.id,
          request,
          detail: { reason: 'bad_email_code' }
        })
        throw invalidCode()
      }
      if (pending.disabledAt) throw accountDisabled()

      const now = Date.now()
      const autoJoin = ctx.config.registration.autoJoinServerId
      if ((await ctx.repo.confirmEmail(pending.id, used.email, now, autoJoin)) !== 'ok') throw invalidCode()
      const user = (await ctx.repo.getUser(pending.id))!
      await ctx.audit.record({
        action: 'auth.email_verified',
        actorId: user.id,
        targetUserId: user.id,
        request,
        detail: { signup: true, username: user.username }
      })
      await ctx.hub.publishUser(user)
      if (autoJoin && (await ctx.repo.getMember(autoJoin, user.id))) {
        await publishServerChanged(ctx, autoJoin)
      }
      return { ...(await authResult(ctx, user, request, request.body.device)), newAccount: true }
    }
  )

  // ---- Send a new confirmation code for a pending sign-up ----
  app.post<{ Body: { login: string; password: string } }>(
    '/api/auth/resend-verification',
    {
      schema: {
        body: {
          type: 'object',
          required: ['login', 'password'],
          additionalProperties: false,
          properties: { login: loginField, password: passwordField }
        }
      }
    },
    async (request, reply): Promise<ApiEmailSent> => {
      requireMail()
      take(ctx.limiters.emailCodesPerIp, request.ip)
      take(ctx.limiters.emailsPerAddress, keyOf(request.body.login))
      const found = await findUserByLogin(ctx, request.body.login)
      const pending = found?.signupPending && found.email ? found : undefined
      if ((await passwordMatches(pending, request.body.password)) && pending && !pending.disabledAt) {
        // The budget of the actual address applies too (sign-in by username or address).
        allowSend(pending.email!)
        const { code, record } = newCode(pending.id, 'verify', pending.email!, Date.now())
        await ctx.repo.putEmailCode(record)
        ctx.mail.enqueue(verificationEmail(pending.email!, pending.username, code, EMAIL_CODE_TTL_MINUTES), 'resend')
      }
      reply.code(202)
      return emailSent()
    }
  )

  // ---- Forgot password: a reset code to the account's confirmed address ----
  app.post<{ Body: { email: string } }>(
    '/api/auth/forgot-password',
    {
      schema: {
        body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: emailField } }
      }
    },
    async (request, reply): Promise<ApiEmailSent> => {
      requireMail()
      take(ctx.limiters.recoverPerIp, request.ip)
      const email = normalizeEmail(request.body.email)
      allowSend(email)
      const user = await ctx.repo.findUserByEmail(email)
      if (user && user.emailVerifiedAt && !user.signupPending && !user.bot && !user.disabledAt) {
        const { code, record } = newCode(user.id, 'reset', email, Date.now())
        await ctx.repo.putEmailCode(record)
        ctx.mail.enqueue(passwordResetEmail(email, user.username, code, EMAIL_CODE_TTL_MINUTES), 'reset')
        await ctx.audit.record({ action: 'auth.password_reset_requested', targetUserId: user.id, request })
      }
      reply.code(202)
      return emailSent()
    }
  )

  // ---- Reset the password with the emailed code (signs out every device) ----
  app.post<{ Body: { email: string; code: string; newPassword: string; device?: string } }>(
    '/api/auth/reset-password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'code', 'newPassword'],
          additionalProperties: false,
          properties: { email: emailField, code: codeField, newPassword: passwordField, device: deviceField }
        }
      }
    },
    async (request): Promise<ApiAuthResult> => {
      take(ctx.limiters.recoverPerIp, request.ip)
      take(ctx.limiters.emailCodesPerAddress, keyOf(request.body.email))
      const email = normalizeEmail(request.body.email)
      // Password rules against the typed address first, so the error can't reveal an account.
      const early = passwordProblem(request.body.newPassword, { username: email.split('@')[0] })
      if (early) throw badRequest(early, 'weak_password')
      const found = await ctx.repo.findUserByEmail(email)
      const user = found && found.emailVerifiedAt && !found.signupPending && !found.bot ? found : undefined
      // Always hashed, account or not, so the answer takes as long either way (and before the
      // code is spent, so a busy server doesn't burn it).
      const passwordHash = await hashPassword(ctx, normalizePassword(request.body.newPassword))
      if (!user) throw invalidCode()
      // Rules that use the account's names only count once the code proves who is asking —
      // and a correct code isn't spent on a password that is then refused.
      const problem = passwordProblem(request.body.newPassword, {
        username: user.username,
        displayName: user.displayName
      })
      const used = await checkCode(user, 'reset', email, request.body.code, problem !== null)
      if (!used) {
        await ctx.audit.record({
          action: 'auth.login_failed',
          targetUserId: user.id,
          request,
          detail: { reason: 'bad_reset_email_code' }
        })
        throw invalidCode()
      }
      if (problem) throw badRequest(problem, 'weak_password')
      if (user.disabledAt) throw accountDisabled()

      const now = Date.now()
      await ctx.repo.setPasswordHash(user.id, passwordHash, now)
      // Someone may have had the old password: every existing session ends.
      const revoked = await ctx.repo.revokeUserSessions(user.id, now)
      ctx.hub.closeSessions(revoked, 'Password reset')
      await disconnectUserFromVoice(ctx, user.id, 'password reset')
      await ctx.audit.record({
        action: 'auth.email_reset_used',
        actorId: user.id,
        request,
        detail: { sessionsRevoked: revoked.length }
      })
      return authResult(ctx, user, request, request.body.device)
    }
  )

  // ---- Your email address (signed in) ----
  app.get('/api/auth/email', async (request): Promise<ApiAccountEmail> => {
    const { user } = await requireAuth(ctx, request)
    return { email: user.email ?? null, verified: Boolean(user.email && user.emailVerifiedAt) }
  })

  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: { email: emailField, password: passwordField }
        }
      }
    },
    async (request, reply): Promise<ApiEmailSent> => {
      requireMail()
      const { user } = await requireAuth(ctx, request)
      const email = normalizeEmail(request.body.email)
      await requirePassword(ctx, user, request.body.password, request)
      if (user.email === email && user.emailVerifiedAt) {
        throw badRequest('That’s already your email address.', 'same_email')
      }
      allowSend(email)
      const other = await ctx.repo.findUserByEmail(email)
      // An unconfirmed sign-up doesn't own the address: confirming it here replaces that.
      if (other && other.id !== user.id && !other.signupPending) {
        ctx.mail.enqueue(accountExistsEmail(email), 'email_change_existing')
      } else {
        const { code, record } = newCode(user.id, 'verify', email, Date.now())
        await ctx.repo.putEmailCode(record)
        ctx.mail.enqueue(emailChangeEmail(email, user.username, code, EMAIL_CODE_TTL_MINUTES), 'email_change')
      }
      await ctx.audit.record({ action: 'auth.email_change_requested', actorId: user.id, request })
      reply.code(202)
      return emailSent()
    }
  )

  app.post<{ Body: { code: string } }>(
    '/api/auth/email/verify',
    {
      schema: {
        body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: codeField } }
      }
    },
    async (request): Promise<ApiAccountEmail> => {
      const { user } = await requireAuth(ctx, request)
      take(ctx.limiters.emailCodesPerAddress, keyOf(`user:${user.id}`))
      const open = await ctx.repo.getOpenEmailCode(user.id, 'verify', Date.now())
      const used = open ? await checkCode(user, 'verify', open.email, request.body.code) : null
      if (!used) throw invalidCode()
      if ((await ctx.repo.confirmEmail(user.id, used.email, Date.now(), null)) !== 'ok') {
        throw conflict('That address now belongs to another account.', 'email_taken')
      }
      const updated = (await ctx.repo.getUser(user.id))!
      await ctx.hub.publishMe(updated)
      await ctx.audit.record({ action: 'auth.email_changed', actorId: user.id, request })
      return { email: updated.email ?? null, verified: true }
    }
  )

  app.post<{ Body: { password: string } }>(
    '/api/auth/email/remove',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: passwordField }
        }
      }
    },
    async (request): Promise<ApiAccountEmail> => {
      const { user } = await requireAuth(ctx, request)
      await requirePassword(ctx, user, request.body.password, request)
      await ctx.repo.removeEmail(user.id)
      const updated = (await ctx.repo.getUser(user.id))!
      await ctx.hub.publishMe(updated)
      await ctx.audit.record({ action: 'auth.email_removed', actorId: user.id, request })
      return { email: null, verified: false }
    }
  )
}
