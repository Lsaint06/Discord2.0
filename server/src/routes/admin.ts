/**
 * Instance administration (registration invitations, legacy identity claim codes, password
 * reset codes, disabling accounts, the instance-wide security log). Requires an instance
 * administrator signed in with a password (never a development session); actions that hand
 * out access additionally require re-entering the password.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requirePassword } from '../auth/reauth.js'
import { CODE_LENGTHS, codeGroups, codeVerifier, newCode, newId, normalizeCode } from '../auth/secrets.js'
import { requireAuth } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import type { RegistrationInviteRecord, UserRecord } from '../db/repository.js'
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import {
  LIMITS,
  type ApiAccount,
  type ApiAuditEvent,
  type ApiLegacyIdentity,
  type ApiRegistrationInvite
} from '../protocol.js'
import { disconnectUserFromVoice } from '../voice/enforce.js'

const HOUR = 60 * 60_000
const idParam = { type: 'string', maxLength: 64 } as const
const passwordField = { type: 'string', maxLength: LIMITS.passwordMaxLength * 4 } as const

export async function requireInstanceAdmin(ctx: AppContext, request: FastifyRequest): Promise<UserRecord> {
  const { user, session } = await requireAuth(ctx, request)
  if (!user.instanceAdmin) throw forbidden('Administrators only.', 'not_admin')
  if (session.kind !== 'password') {
    throw forbidden('Sign in with your password to use administration.', 'password_session_required')
  }
  const limit = ctx.limiters.adminPerUser.take(user.id)
  if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
  return user
}

function toApiRegistrationInvite(
  i: RegistrationInviteRecord,
  usernames: Map<string, string>,
  code?: string
): ApiRegistrationInvite {
  return {
    id: i.id,
    kind: i.kind,
    claimUserId: i.claimUserId,
    claimUsername: i.claimUserId ? (usernames.get(i.claimUserId) ?? null) : null,
    note: i.note,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedAt: i.usedAt,
    usedBy: i.usedBy,
    revoked: i.revokedAt !== null,
    ...(code ? { code } : {})
  }
}

function cleanNote(note: unknown): string | null {
  if (typeof note !== 'string') return null
  return note.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) || null
}

/** Shared by the API and the local CLI. */
export async function issueRegistrationCode(
  ctx: Pick<AppContext, 'repo'>,
  input: {
    kind: 'register' | 'claim'
    claimUserId?: string | null
    serverId?: string | null
    note?: string | null
    createdBy: string | null
    expiresInHours: number
  }
): Promise<{ invite: RegistrationInviteRecord; code: string }> {
  const now = Date.now()
  const code = newCode(codeGroups('register'))
  const invite: RegistrationInviteRecord = {
    id: newId(),
    codeHash: codeVerifier('register', normalizeCode(code, CODE_LENGTHS.register)!),
    kind: input.kind,
    claimUserId: input.kind === 'claim' ? (input.claimUserId ?? null) : null,
    serverId: input.kind === 'register' ? (input.serverId ?? null) : null,
    note: cleanNote(input.note),
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: now + input.expiresInHours * HOUR,
    usedAt: null,
    usedBy: null,
    revokedAt: null
  }
  await ctx.repo.createRegistrationInvite(invite)
  return { invite, code }
}

export async function issueResetCode(
  ctx: Pick<AppContext, 'repo'>,
  userId: string,
  createdBy: string | null,
  expiresInHours = 24
): Promise<string> {
  const now = Date.now()
  const code = newCode(codeGroups('reset'))
  await ctx.repo.createPasswordReset({
    id: newId(),
    codeHash: codeVerifier('reset', normalizeCode(code, CODE_LENGTHS.reset)!),
    userId,
    createdBy,
    createdAt: now,
    expiresAt: now + expiresInHours * HOUR,
    usedAt: null
  })
  return code
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/accounts', async (request): Promise<ApiAccount[]> => {
    await requireInstanceAdmin(ctx, request)
    const users = await ctx.repo.listUsers()
    const withPassword = await ctx.repo.hasPassword(users.map((u) => u.id))
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      instanceAdmin: Boolean(u.instanceAdmin),
      hasPassword: withPassword.has(u.id),
      disabled: Boolean(u.disabledAt),
      bot: u.bot,
      createdAt: u.createdAt
    }))
  })

  // ---- Registration invitations ----
  app.get('/api/admin/registration-invites', async (request) => {
    await requireInstanceAdmin(ctx, request)
    const invites = await ctx.repo.listRegistrationInvites()
    const users = new Map((await ctx.repo.listUsers()).map((u) => [u.id, u.username]))
    return invites.map((i) => toApiRegistrationInvite(i, users))
  })

  app.post<{ Body: { expiresInHours?: number; note?: string; serverId?: string | null; password: string } }>(
    '/api/admin/registration-invites',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: {
            expiresInHours: { type: 'integer', minimum: 1, maximum: 24 * 14 },
            note: { type: 'string', maxLength: 200 },
            serverId: { type: ['string', 'null'], maxLength: 64 },
            password: passwordField
          }
        }
      }
    },
    async (request, reply) => {
      const admin = await requireInstanceAdmin(ctx, request)
      await requirePassword(ctx, admin, request.body.password, request)
      const serverId = request.body.serverId ?? null
      if (serverId && !(await ctx.repo.getServer(serverId))) throw notFound('Server not found')
      const { invite, code } = await issueRegistrationCode(ctx, {
        kind: 'register',
        serverId,
        note: request.body.note,
        createdBy: admin.id,
        expiresInHours: request.body.expiresInHours ?? 72
      })
      await ctx.audit.record({
        action: 'admin.registration_invite_created',
        actorId: admin.id,
        request,
        detail: { inviteId: invite.id, serverId, expiresAt: invite.expiresAt }
      })
      reply.code(201)
      return toApiRegistrationInvite(invite, new Map(), code)
    }
  )

  app.delete<{ Params: { inviteId: string } }>(
    '/api/admin/registration-invites/:inviteId',
    { schema: { params: { type: 'object', properties: { inviteId: idParam } } } },
    async (request, reply) => {
      const admin = await requireInstanceAdmin(ctx, request)
      if (!(await ctx.repo.revokeRegistrationInvite(request.params.inviteId, Date.now()))) {
        throw notFound('Invitation not found or already used')
      }
      await ctx.audit.record({
        action: 'admin.registration_invite_revoked',
        actorId: admin.id,
        request,
        detail: { inviteId: request.params.inviteId }
      })
      reply.code(204)
    }
  )

  // ---- Legacy development identities ----
  app.get('/api/admin/legacy', async (request): Promise<ApiLegacyIdentity[]> => {
    await requireInstanceAdmin(ctx, request)
    return (await ctx.repo.listLegacyIdentities()).map((l) => ({
      id: l.user.id,
      username: l.user.username,
      displayName: l.user.displayName,
      messages: l.messages,
      attachments: l.attachments,
      lastSeenAt: l.lastSeenAt,
      openClaimCode: l.openClaimCode
    }))
  })

  /**
   * Claim code for one existing development identity. Give it privately to the person who used
   * that identity; redeeming it sets their password and keeps their user id, messages, files,
   * reactions and read state. Nobody can claim an identity without such a code.
   */
  app.post<{ Params: { userId: string }; Body: { expiresInHours?: number; password: string } }>(
    '/api/admin/legacy/:userId/claim-code',
    {
      schema: {
        params: { type: 'object', properties: { userId: idParam } },
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: {
            expiresInHours: { type: 'integer', minimum: 1, maximum: 24 * 14 },
            password: passwordField
          }
        }
      }
    },
    async (request, reply) => {
      const admin = await requireInstanceAdmin(ctx, request)
      await requirePassword(ctx, admin, request.body.password, request)
      const target = await ctx.repo.getUser(request.params.userId)
      if (!target || target.bot) throw notFound('Identity not found')
      if ((await ctx.repo.hasPassword([target.id])).has(target.id)) {
        throw badRequest('This identity has already been claimed.', 'already_claimed')
      }
      const { invite, code } = await issueRegistrationCode(ctx, {
        kind: 'claim',
        claimUserId: target.id,
        createdBy: admin.id,
        expiresInHours: request.body.expiresInHours ?? 72
      })
      await ctx.audit.record({
        action: 'admin.claim_code_created',
        actorId: admin.id,
        targetUserId: target.id,
        request,
        detail: { inviteId: invite.id, expiresAt: invite.expiresAt }
      })
      reply.code(201)
      return toApiRegistrationInvite(invite, new Map([[target.id, target.username]]), code)
    }
  )

  // ---- Account administration ----
  app.post<{ Params: { userId: string }; Body: { password: string } }>(
    '/api/admin/accounts/:userId/reset-code',
    {
      schema: {
        params: { type: 'object', properties: { userId: idParam } },
        body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: passwordField } }
      }
    },
    async (request) => {
      const admin = await requireInstanceAdmin(ctx, request)
      await requirePassword(ctx, admin, request.body.password, request)
      const target = await ctx.repo.getUser(request.params.userId)
      if (!target || target.bot) throw notFound('Account not found')
      if (!(await ctx.repo.hasPassword([target.id])).has(target.id)) {
        throw badRequest('This identity has no password yet. Issue a claim code instead.', 'not_claimed')
      }
      const code = await issueResetCode(ctx, target.id, admin.id)
      await ctx.audit.record({ action: 'admin.reset_code_created', actorId: admin.id, targetUserId: target.id, request })
      return { code, expiresInHours: 24 }
    }
  )

  app.post<{ Params: { userId: string }; Body: { disabled: boolean; password: string } }>(
    '/api/admin/accounts/:userId/disabled',
    {
      schema: {
        params: { type: 'object', properties: { userId: idParam } },
        body: {
          type: 'object',
          required: ['disabled', 'password'],
          additionalProperties: false,
          properties: { disabled: { type: 'boolean' }, password: passwordField }
        }
      }
    },
    async (request) => {
      const admin = await requireInstanceAdmin(ctx, request)
      await requirePassword(ctx, admin, request.body.password, request)
      const target = await ctx.repo.getUser(request.params.userId)
      if (!target || target.bot) throw notFound('Account not found')
      if (target.id === admin.id) throw badRequest('You can’t disable your own account.')
      const disabled = request.body.disabled
      await ctx.repo.setUserDisabled(target.id, disabled ? Date.now() : null)
      if (disabled) {
        ctx.hub.closeUser(target.id, 'Account disabled')
        await disconnectUserFromVoice(ctx, target.id, 'account disabled')
      }
      await ctx.audit.record({
        action: disabled ? 'admin.account_disabled' : 'admin.account_enabled',
        actorId: admin.id,
        targetUserId: target.id,
        request
      })
      return { disabled }
    }
  )

  app.get<{ Querystring: { before?: string } }>(
    '/api/admin/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { before: { type: 'string', pattern: '^[0-9]{1,19}$' } }
        }
      }
    },
    async (request): Promise<(ApiAuditEvent & { ip: string | null })[]> => {
      await requireInstanceAdmin(ctx, request)
      const events = await ctx.repo.listAuditEvents({ before: request.query.before, limit: 100 })
      return events.map((e) => ({
        id: e.id ?? '',
        at: e.at,
        action: e.action,
        actorId: e.actorId,
        targetUserId: e.targetUserId,
        serverId: e.serverId,
        ip: e.ip,
        detail: e.detail
      }))
    }
  )
}
