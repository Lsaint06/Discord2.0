import type { FastifyInstance } from 'fastify'
import { CODE_LENGTHS, codeGroups, codeVerifier, newCode, newId, normalizeCode } from '../auth/secrets.js'
import type { AppContext } from '../context.js'
import type { ServerInviteRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { ApiError, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { has } from '../lib/permissions.js'
import { LIMITS, Permissions, type ApiInvitePreview, type ApiServerInvite } from '../protocol.js'
import { publishServerChanged } from '../realtime.js'
import { toApiServer } from './servers.js'

const HOUR = 60 * 60_000
const idParam = { type: 'string', maxLength: 64 } as const
const invalidInvite = () => new ApiError(404, 'invalid_invite', 'This invite is invalid or has expired.')

function toApiInvite(i: ServerInviteRecord, code?: string): ApiServerInvite {
  return {
    id: i.id,
    serverId: i.serverId,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    maxUses: i.maxUses,
    uses: i.uses,
    revoked: i.revokedAt !== null,
    ...(code ? { code } : {})
  }
}

const codeBody = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', maxLength: 64 } }
} as const

export function registerInviteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { serverId: string }; Body: { expiresInHours?: number; maxUses?: number | null } }>(
    '/api/servers/:serverId/invites',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            expiresInHours: { type: 'integer', minimum: 1, maximum: LIMITS.inviteMaxAgeDays * 24 },
            maxUses: { type: ['integer', 'null'], minimum: 1, maximum: LIMITS.inviteMaxUses }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.invitesPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const { server } = await ctx.access.requireServer(
        user,
        request.params.serverId,
        Permissions.createInvites,
        'You can’t create invites for this server.'
      )
      const now = Date.now()
      const code = newCode(codeGroups('invite'))
      const invite: ServerInviteRecord = {
        id: newId(),
        serverId: server.id,
        codeHash: codeVerifier('invite', normalizeCode(code, CODE_LENGTHS.invite)!),
        createdBy: user.id,
        createdAt: now,
        // Every invite expires (default 24 h, at most 30 days).
        expiresAt: now + (request.body?.expiresInHours ?? 24) * HOUR,
        maxUses: request.body?.maxUses ?? null,
        uses: 0,
        revokedAt: null
      }
      await ctx.repo.createServerInvite(invite)
      await ctx.audit.record({
        action: 'server.invite_created',
        actorId: user.id,
        serverId: server.id,
        request,
        detail: { inviteId: invite.id, expiresAt: invite.expiresAt, maxUses: invite.maxUses }
      })
      reply.code(201)
      // The code is returned once; only its verifier is stored.
      return toApiInvite(invite, code)
    }
  )

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/invites',
    { schema: { params: { type: 'object', properties: { serverId: idParam } } } },
    async (request) => {
      const user = await requireUser(ctx, request)
      const access = await ctx.access.requireServer(user, request.params.serverId)
      const manage = has(access.permissions, Permissions.manageInvites)
      if (!manage && !has(access.permissions, Permissions.createInvites)) {
        throw forbidden('You can’t view invites for this server.', 'missing_permission')
      }
      const invites = await ctx.repo.listServerInvites(access.server.id)
      return invites.filter((i) => manage || i.createdBy === user.id).map((i) => toApiInvite(i))
    }
  )

  app.delete<{ Params: { serverId: string; inviteId: string } }>(
    '/api/servers/:serverId/invites/:inviteId',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam, inviteId: idParam } }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      const access = await ctx.access.requireServer(user, request.params.serverId)
      const invite = await ctx.repo.getServerInvite(request.params.inviteId)
      if (!invite || invite.serverId !== access.server.id) throw notFound('Invite not found')
      const own = invite.createdBy === user.id && has(access.permissions, Permissions.createInvites)
      if (!own && !has(access.permissions, Permissions.manageInvites)) {
        throw forbidden('You can only revoke your own invites.', 'missing_permission')
      }
      await ctx.repo.revokeServerInvite(invite.id, Date.now())
      await ctx.audit.record({
        action: 'server.invite_revoked',
        actorId: user.id,
        serverId: access.server.id,
        request,
        detail: { inviteId: invite.id }
      })
      reply.code(204)
    }
  )

  /** What an invite leads to, before joining. Requires sign-in (no anonymous enumeration). */
  app.post<{ Body: { code: string } }>(
    '/api/invites/preview',
    { schema: { body: codeBody } },
    async (request): Promise<ApiInvitePreview> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.joinPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const canonical = normalizeCode(request.body.code, CODE_LENGTHS.invite)
      if (!canonical) throw invalidInvite()
      const invite = await ctx.repo.findUsableServerInvite(codeVerifier('invite', canonical), Date.now())
      const server = invite && (await ctx.repo.getServer(invite.serverId))
      if (!invite || !server) throw invalidInvite()
      const members = await ctx.repo.listMembers(server.id)
      return {
        serverId: server.id,
        serverName: server.name,
        serverColor: server.color,
        memberCount: members.length,
        expiresAt: invite.expiresAt,
        member: members.some((m) => m.userId === user.id)
      }
    }
  )

  app.post<{ Body: { code: string } }>(
    '/api/invites/accept',
    { schema: { body: codeBody } },
    async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.joinPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const canonical = normalizeCode(request.body.code, CODE_LENGTHS.invite)
      if (!canonical) throw invalidInvite()
      const result = await ctx.repo.acceptServerInvite(
        codeVerifier('invite', canonical),
        user.id,
        Date.now()
      )
      if (result.status === 'invalid') throw invalidInvite()
      if (result.status === 'banned') throw forbidden('You can’t join this server.', 'banned')
      const { serverId, status } = result
      if (status === 'joined') {
        await ctx.audit.record({ action: 'server.join', actorId: user.id, serverId, request })
        await publishServerChanged(ctx, serverId)
      }
      const view = (await ctx.access.visibleServers(user)).find((s) => s.server.id === serverId)
      if (!view) throw invalidInvite()
      const dto = toApiServer(view)
      if (status === 'joined') ctx.hub.sendToUser(user.id, { op: 'server_create', d: dto })
      return dto
    }
  )
}
