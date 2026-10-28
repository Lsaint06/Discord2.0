import type { FastifyInstance } from 'fastify'
import { requirePassword } from '../auth/reauth.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import {
  CONFIGURABLE_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  canAssignRole,
  canConfigureRole,
  canModerateMember,
  isConfigurableRole
} from '../lib/permissions.js'
import {
  ALL_PERMISSIONS,
  LIMITS,
  Permissions,
  type ApiBan,
  type ApiMember,
  type ApiRolePermissions
} from '../protocol.js'
import { afterAccessChange } from './servers.js'

const idParam = { type: 'string', maxLength: 64 } as const
const serverParams = { type: 'object', properties: { serverId: idParam } } as const
const memberParams = { type: 'object', properties: { serverId: idParam, userId: idParam } } as const

export function registerMemberRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rate = (userId: string): void => {
    const limit = ctx.limiters.moderationPerUser.take(userId)
    if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
  }

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/members',
    { schema: { params: serverParams } },
    async (request): Promise<ApiMember[]> => {
      const user = await requireUser(ctx, request)
      const { server } = await ctx.access.requireServer(user, request.params.serverId)
      const now = Date.now()
      return (await ctx.repo.listMembers(server.id)).map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        timeoutUntil:
          m.role !== 'owner' && typeof m.timeoutUntil === 'number' && m.timeoutUntil > now
            ? m.timeoutUntil
            : null
      }))
    }
  )

  // ---- Change a member's role ----
  app.patch<{ Params: { serverId: string; userId: string }; Body: { role: string } }>(
    '/api/servers/:serverId/members/:userId',
    {
      schema: {
        params: memberParams,
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: { role: { type: 'string', enum: ['admin', 'moderator', 'member'] } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId, Permissions.manageRoles)
      const target = await ctx.repo.getMember(actor.server.id, request.params.userId)
      if (!target) throw notFound('Member not found')
      const next = request.body.role
      if (!isConfigurableRole(next)) throw badRequest('Unknown role')
      if (target.userId === user.id || !canAssignRole(actor, target.role, next)) {
        throw forbidden('You can only change roles of members below you, to roles below yours.', 'role_hierarchy')
      }
      await ctx.repo.setMemberRole(actor.server.id, target.userId, next)
      await ctx.audit.record({
        action: 'server.role_changed',
        actorId: user.id,
        targetUserId: target.userId,
        serverId: actor.server.id,
        request,
        detail: { from: target.role, to: next }
      })
      await afterAccessChange(ctx, actor.server.id)
      return { userId: target.userId, role: next, joinedAt: target.joinedAt }
    }
  )

  // ---- Kick ----
  app.delete<{ Params: { serverId: string; userId: string } }>(
    '/api/servers/:serverId/members/:userId',
    { schema: { params: memberParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId)
      if (request.params.userId === user.id) throw badRequest('Use “Leave server” to leave.', 'use_leave')
      const target = await ctx.repo.getMember(actor.server.id, request.params.userId)
      if (!target) throw notFound('Member not found')
      if (!canModerateMember(actor, target.role, Permissions.kickMembers)) {
        throw forbidden('You can only kick members below your role.', 'role_hierarchy')
      }
      await ctx.repo.removeMember(actor.server.id, target.userId)
      await ctx.audit.record({
        action: 'server.kick',
        actorId: user.id,
        targetUserId: target.userId,
        serverId: actor.server.id,
        request
      })
      ctx.hub.sendToUser(target.userId, {
        op: 'server_remove',
        d: { serverId: actor.server.id, reason: 'kicked' }
      })
      await afterAccessChange(ctx, actor.server.id)
      reply.code(204)
    }
  )

  // ---- Leave ----
  app.post<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/leave',
    { schema: { params: serverParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const access = await ctx.access.requireServer(user, request.params.serverId)
      // Prevents an ownerless server: the owner must transfer ownership first.
      if (access.role === 'owner') {
        throw badRequest('Transfer ownership to someone else before leaving.', 'owner_cannot_leave')
      }
      await ctx.repo.removeMember(access.server.id, user.id)
      await ctx.audit.record({ action: 'server.leave', actorId: user.id, serverId: access.server.id, request })
      ctx.hub.sendToUser(user.id, { op: 'server_remove', d: { serverId: access.server.id, reason: 'left' } })
      await afterAccessChange(ctx, access.server.id)
      reply.code(204)
    }
  )

  // ---- Bans ----
  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/bans',
    { schema: { params: serverParams } },
    async (request): Promise<ApiBan[]> => {
      const user = await requireUser(ctx, request)
      const { server } = await ctx.access.requireServer(user, request.params.serverId, Permissions.banMembers)
      return (await ctx.repo.listBans(server.id)).map((b) => ({
        userId: b.userId,
        reason: b.reason,
        bannedBy: b.bannedBy,
        createdAt: b.createdAt
      }))
    }
  )

  app.put<{ Params: { serverId: string; userId: string }; Body: { reason?: string } }>(
    '/api/servers/:serverId/bans/:userId',
    {
      schema: {
        params: memberParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: LIMITS.banReasonMaxLength * 2 } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId)
      if (request.params.userId === user.id) throw badRequest('You can’t ban yourself.')
      const targetUser = await ctx.repo.getUser(request.params.userId)
      if (!targetUser || targetUser.bot) throw notFound('User not found')
      const target = await ctx.repo.getMember(actor.server.id, targetUser.id)
      // Someone who isn't a member (any more) is treated as a member for the hierarchy check.
      if (!canModerateMember(actor, target?.role ?? 'member', Permissions.banMembers)) {
        throw forbidden('You can only ban members below your role.', 'role_hierarchy')
      }
      const reason = (request.body?.reason ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, LIMITS.banReasonMaxLength) || null
      await ctx.repo.banMember({
        serverId: actor.server.id,
        userId: targetUser.id,
        bannedBy: user.id,
        reason,
        createdAt: Date.now()
      })
      await ctx.audit.record({
        action: 'server.ban',
        actorId: user.id,
        targetUserId: targetUser.id,
        serverId: actor.server.id,
        request,
        detail: { reason }
      })
      ctx.hub.sendToUser(targetUser.id, {
        op: 'server_remove',
        d: { serverId: actor.server.id, reason: 'banned' }
      })
      await afterAccessChange(ctx, actor.server.id)
      return { ok: true }
    }
  )

  app.delete<{ Params: { serverId: string; userId: string } }>(
    '/api/servers/:serverId/bans/:userId',
    { schema: { params: memberParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId, Permissions.banMembers)
      if (!(await ctx.repo.unbanMember(actor.server.id, request.params.userId))) throw notFound('Ban not found')
      await ctx.audit.record({
        action: 'server.unban',
        actorId: user.id,
        targetUserId: request.params.userId,
        serverId: actor.server.id,
        request
      })
      reply.code(204)
    }
  )

  // ---- Role permissions ----
  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/roles',
    { schema: { params: serverParams } },
    async (request): Promise<ApiRolePermissions[]> => {
      const user = await requireUser(ctx, request)
      const { server } = await ctx.access.requireServer(user, request.params.serverId)
      const configured = (await ctx.repo.getRolePermissions([server.id])).get(server.id) ?? {}
      return CONFIGURABLE_ROLES.map((role) => ({
        role,
        permissions: configured[role] ?? DEFAULT_ROLE_PERMISSIONS[role]
      }))
    }
  )

  app.put<{ Params: { serverId: string; role: string }; Body: { permissions: number | null } }>(
    '/api/servers/:serverId/roles/:role',
    {
      schema: {
        params: {
          type: 'object',
          properties: { serverId: idParam, role: { type: 'string', enum: ['admin', 'moderator', 'member'] } }
        },
        body: {
          type: 'object',
          required: ['permissions'],
          additionalProperties: false,
          properties: { permissions: { type: ['integer', 'null'], minimum: 0, maximum: 2 ** 31 - 1 } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate(user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId, Permissions.manageRoles)
      const role = request.params.role
      if (!isConfigurableRole(role)) throw badRequest('Unknown role')
      const requested = request.body.permissions
      if (requested !== null && requested & ~ALL_PERMISSIONS) {
        throw badRequest('Unknown permission bits', 'invalid_permissions')
      }
      const effective = requested ?? DEFAULT_ROLE_PERMISSIONS[role]
      if (!canConfigureRole(actor, role, effective)) {
        throw forbidden('You can only configure roles below yours, within your own permissions.', 'role_hierarchy')
      }
      await ctx.repo.setRolePermissions(actor.server.id, role, requested)
      await ctx.audit.record({
        action: 'server.role_permissions',
        actorId: user.id,
        serverId: actor.server.id,
        request,
        detail: { role, permissions: effective }
      })
      await afterAccessChange(ctx, actor.server.id)
      return { role, permissions: effective }
    }
  )

  // ---- Ownership transfer (owner only, re-enter password) ----
  app.post<{ Params: { serverId: string }; Body: { userId: string; password: string } }>(
    '/api/servers/:serverId/transfer',
    {
      schema: {
        params: serverParams,
        body: {
          type: 'object',
          required: ['userId', 'password'],
          additionalProperties: false,
          properties: {
            userId: idParam,
            password: { type: 'string', maxLength: LIMITS.passwordMaxLength * 4 }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      const access = await ctx.access.requireServer(user, request.params.serverId)
      if (access.role !== 'owner') throw forbidden('Only the owner can transfer ownership.', 'not_owner')
      await requirePassword(ctx, user, request.body.password, request)
      const target = await ctx.repo.getMember(access.server.id, request.body.userId)
      const targetUser = target && (await ctx.repo.getUser(target.userId))
      if (!target || !targetUser || targetUser.bot || targetUser.disabledAt) throw notFound('Member not found')
      if (target.userId === user.id) throw badRequest('You already own this server.')
      if (!(await ctx.repo.transferOwnership(access.server.id, user.id, target.userId))) {
        throw badRequest('Ownership could not be transferred.')
      }
      await ctx.audit.record({
        action: 'server.ownership_transferred',
        actorId: user.id,
        targetUserId: target.userId,
        serverId: access.server.id,
        request
      })
      await afterAccessChange(ctx, access.server.id)
      return { ok: true }
    }
  )
}
