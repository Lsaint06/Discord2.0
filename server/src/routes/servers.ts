import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { VisibleServer } from '../access.js'
import type { AppContext } from '../context.js'
import type { ChannelRecord, ServerRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { CHANNEL_PERMISSIONS, canConfigureRole, isConfigurableRole } from '../lib/permissions.js'
import {
  normalizeCategoryName,
  normalizeChannelName,
  normalizeColor,
  normalizeServerDescription,
  normalizeServerName,
  normalizeTopic
} from '../lib/validation.js'
import {
  LIMITS,
  Permissions,
  type ApiChannel,
  type ApiChannelOverride,
  type ApiServer
} from '../protocol.js'
import { publishServerChanged } from '../realtime.js'
import { enforceVoiceAccess } from '../voice/enforce.js'

export function toApiChannel(c: ChannelRecord, permissions?: number): ApiChannel {
  return {
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    type: c.type,
    topic: c.topic,
    category: c.category,
    position: c.position,
    ...(permissions === undefined ? {} : { permissions }),
    ...(c.type === 'voice' ? { userLimit: c.userLimit ?? 0 } : {})
  }
}

export function toApiServer(v: VisibleServer): ApiServer {
  return {
    id: v.server.id,
    name: v.server.name,
    color: v.server.color,
    ownerId: v.server.ownerId,
    role: v.role,
    permissions: v.permissions,
    channels: v.channels.map((c) => toApiChannel(c.channel, c.permissions)),
    description: v.server.description ?? null,
    iconId: v.server.iconId ?? null,
    defaultNotifications: v.server.defaultNotifications ?? 'all',
    timeoutUntil: v.timeoutUntil
  }
}

const idParam = { type: 'string', maxLength: 64 } as const

function rate(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

/** Fetches the server as the user sees it now (for responses after a change). */
export async function serverView(ctx: AppContext, userId: string, serverId: string): Promise<ApiServer> {
  const user = await ctx.repo.getUser(userId)
  const v = user ? (await ctx.access.visibleServers(user)).find((s) => s.server.id === serverId) : undefined
  if (!v) throw notFound('Server not found')
  return toApiServer(v)
}

/** Recomputes realtime visibility and live voice permissions after access-relevant changes. */
export async function afterAccessChange(
  ctx: AppContext,
  serverId: string,
  extraUserIds: string[] = []
): Promise<void> {
  await publishServerChanged(ctx, serverId, extraUserIds)
  await enforceVoiceAccess(ctx, { serverId })
}

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Servers you are a member of, with only the channels you can view. */
  app.get('/api/servers', async (request) => {
    const user = await requireUser(ctx, request)
    return (await ctx.access.visibleServers(user)).map(toApiServer)
  })

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId',
    { schema: { params: { type: 'object', properties: { serverId: idParam } } } },
    async (request) => {
      const user = await requireUser(ctx, request)
      return serverView(ctx, user.id, request.params.serverId)
    }
  )

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/channels',
    { schema: { params: { type: 'object', properties: { serverId: idParam } } } },
    async (request) => {
      const user = await requireUser(ctx, request)
      return (await serverView(ctx, user.id, request.params.serverId)).channels
    }
  )

  app.post<{ Body: { name: string; color: string } }>(
    '/api/servers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'color'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 80 },
            color: { type: 'string', maxLength: 7 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate(ctx.limiters.serversPerUser, user.id)

      const now = Date.now()
      const existing = await ctx.repo.countServers()
      const server: ServerRecord = {
        id: randomUUID(),
        name: normalizeServerName(request.body.name),
        color: normalizeColor(request.body.color),
        ownerId: user.id,
        position: existing,
        createdAt: now
      }
      const channels: ChannelRecord[] = [
        {
          id: randomUUID(),
          serverId: server.id,
          name: 'general',
          type: 'text',
          topic: `Welcome to ${server.name}!`,
          category: 'Text Channels',
          position: 0,
          createdAt: now
        },
        {
          id: randomUUID(),
          serverId: server.id,
          name: 'Lounge',
          type: 'voice',
          topic: null,
          category: 'Voice Channels',
          position: 1,
          createdAt: now
        }
      ]
      // The creator becomes the owner (membership created in the same transaction).
      await ctx.repo.createServer(server, channels)
      await ctx.audit.record({ action: 'server.create', actorId: user.id, serverId: server.id, request })
      const dto = await serverView(ctx, user.id, server.id)
      ctx.hub.sendToUser(user.id, { op: 'server_create', d: dto })
      reply.code(201)
      return dto
    }
  )

  app.patch<{
    Params: { serverId: string }
    Body: { name?: string; color?: string; description?: string | null; defaultNotifications?: 'all' | 'mentions' }
  }>(
    '/api/servers/:serverId',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 80 },
            color: { type: 'string', maxLength: 7 },
            description: { type: ['string', 'null'], maxLength: 1000 },
            defaultNotifications: { type: 'string', enum: ['all', 'mentions'] }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate(ctx.limiters.moderationPerUser, user.id)
      const { server } = await ctx.access.requireServer(
        user,
        request.params.serverId,
        Permissions.manageServer
      )
      const body = request.body
      const patch = {
        name: body.name === undefined ? undefined : normalizeServerName(body.name),
        color: body.color === undefined ? undefined : normalizeColor(body.color),
        description: body.description === undefined ? undefined : normalizeServerDescription(body.description),
        defaultNotifications: body.defaultNotifications
      }
      if (Object.values(patch).every((v) => v === undefined)) throw badRequest('Nothing to update')
      await ctx.repo.updateServer(server.id, patch)
      await ctx.audit.record({
        action: 'server.update',
        actorId: user.id,
        serverId: server.id,
        request,
        detail: {
          name: patch.name,
          color: patch.color,
          description: patch.description === undefined ? undefined : patch.description !== null,
          defaultNotifications: patch.defaultNotifications
        }
      })
      await publishServerChanged(ctx, server.id)
      return serverView(ctx, user.id, server.id)
    }
  )

  // ---- Channels (Manage Channels) ----

  app.post<{
    Params: { serverId: string }
    Body: { name: string; type: 'text' | 'voice'; topic?: string | null; category?: string }
  }>(
    '/api/servers/:serverId/channels',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam } },
        body: {
          type: 'object',
          required: ['name', 'type'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 80 },
            type: { type: 'string', enum: ['text', 'voice'] },
            topic: { type: ['string', 'null'], maxLength: 400 },
            category: { type: 'string', maxLength: 40 }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate(ctx.limiters.moderationPerUser, user.id)
      const { server } = await ctx.access.requireServer(
        user,
        request.params.serverId,
        Permissions.manageChannels
      )
      const existing = (await ctx.repo.listChannels()).filter((c) => c.serverId === server.id)
      if (existing.length >= 100) throw badRequest('A server can have at most 100 channels')
      const type = request.body.type
      const category = normalizeCategoryName(
        request.body.category ?? (type === 'text' ? 'Text Channels' : 'Voice Channels')
      )
      const channel: ChannelRecord = {
        id: randomUUID(),
        serverId: server.id,
        name: normalizeChannelName(request.body.name, type),
        type,
        topic: type === 'text' ? normalizeTopic(request.body.topic) : null,
        category,
        position: existing.reduce((max, c) => Math.max(max, c.position), -1) + 1,
        createdAt: Date.now()
      }
      await ctx.repo.createChannel(channel)
      await ctx.audit.record({
        action: 'channel.create',
        actorId: user.id,
        serverId: server.id,
        request,
        detail: { channelId: channel.id, name: channel.name, type }
      })
      await publishServerChanged(ctx, server.id)
      reply.code(201)
      return toApiChannel(channel)
    }
  )

  const channelForManage = async (
    request: FastifyRequest<{ Params: { channelId: string } }>
  ) => {
    const user = await requireUser(ctx, request)
    rate(ctx.limiters.moderationPerUser, user.id)
    const channel = await ctx.repo.getChannel(request.params.channelId)
    if (!channel) throw notFound('Channel not found')
    const access = await ctx.access.requireServer(user, channel.serverId, Permissions.manageChannels)
    return { user, channel, access }
  }

  app.patch<{
    Params: { channelId: string }
    Body: { name?: string; topic?: string | null; userLimit?: number }
  }>(
    '/api/channels/:channelId',
    {
      schema: {
        params: { type: 'object', properties: { channelId: idParam } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 80 },
            topic: { type: ['string', 'null'], maxLength: 400 },
            userLimit: { type: 'integer', minimum: 0, maximum: LIMITS.voiceUserLimitMax }
          }
        }
      }
    },
    async (request) => {
      const { user, channel } = await channelForManage(request)
      if (request.body.userLimit !== undefined && channel.type !== 'voice') {
        throw badRequest('Only voice channels have a user limit', 'not_voice_channel')
      }
      const patch = {
        name: request.body.name === undefined ? undefined : normalizeChannelName(request.body.name, channel.type),
        topic: request.body.topic === undefined ? undefined : normalizeTopic(request.body.topic),
        userLimit: request.body.userLimit
      }
      const updated = await ctx.repo.updateChannel(channel.id, patch)
      if (!updated) throw notFound('Channel not found')
      await ctx.audit.record({
        action: 'channel.update',
        actorId: user.id,
        serverId: channel.serverId,
        request,
        detail: { channelId: channel.id, name: patch.name, userLimit: patch.userLimit }
      })
      await publishServerChanged(ctx, channel.serverId)
      return toApiChannel(updated)
    }
  )

  app.delete<{ Params: { channelId: string } }>(
    '/api/channels/:channelId',
    { schema: { params: { type: 'object', properties: { channelId: idParam } } } },
    async (request, reply) => {
      const { user, channel } = await channelForManage(request)
      const remaining = (await ctx.repo.listChannels()).filter(
        (c) => c.serverId === channel.serverId && c.type === 'text' && c.id !== channel.id
      )
      if (channel.type === 'text' && remaining.length === 0) {
        throw badRequest('A server needs at least one text channel', 'last_text_channel')
      }
      const files = await ctx.repo.deleteChannel(channel.id)
      await Promise.all(files.map((id) => ctx.attachments.remove(id)))
      await ctx.audit.record({
        action: 'channel.delete',
        actorId: user.id,
        serverId: channel.serverId,
        request,
        detail: { channelId: channel.id, name: channel.name, attachments: files.length }
      })
      await afterAccessChange(ctx, channel.serverId)
      reply.code(204)
    }
  )

  // ---- Channel permission overrides ----

  app.get<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/overrides',
    { schema: { params: { type: 'object', properties: { channelId: idParam } } } },
    async (request): Promise<ApiChannelOverride[]> => {
      const { channel } = await channelForManage(request)
      return (await ctx.repo.overridesForChannels([channel.id])).get(channel.id) ?? []
    }
  )

  app.put<{ Params: { channelId: string; role: string }; Body: { allow: number; deny: number } }>(
    '/api/channels/:channelId/overrides/:role',
    {
      schema: {
        params: {
          type: 'object',
          properties: { channelId: idParam, role: { type: 'string', enum: ['admin', 'moderator', 'member'] } }
        },
        body: {
          type: 'object',
          required: ['allow', 'deny'],
          additionalProperties: false,
          properties: {
            allow: { type: 'integer', minimum: 0, maximum: 2 ** 31 - 1 },
            deny: { type: 'integer', minimum: 0, maximum: 2 ** 31 - 1 }
          }
        }
      }
    },
    async (request) => {
      const { user, channel, access } = await channelForManage(request)
      const role = request.params.role
      if (!isConfigurableRole(role)) throw badRequest('Unknown role')
      const { allow, deny } = request.body
      if ((allow | deny) & ~CHANNEL_PERMISSIONS) {
        throw badRequest('Only channel permissions can be overridden', 'invalid_permissions')
      }
      if (allow & deny) throw badRequest('A permission can’t be both allowed and denied')
      // Overrides only for roles below yours, and you can't allow what you don't have.
      if (!canConfigureRole(access, role, allow, Permissions.manageChannels)) {
        throw forbidden('You can only change permissions for roles below yours, within your own permissions.', 'role_hierarchy')
      }
      await ctx.repo.setChannelOverride(channel.id, role, allow, deny)
      await ctx.audit.record({
        action: 'channel.override',
        actorId: user.id,
        serverId: channel.serverId,
        request,
        detail: { channelId: channel.id, role, allow, deny }
      })
      await afterAccessChange(ctx, channel.serverId)
      return { role, allow, deny }
    }
  )

  // ---- Server audit log (Manage Server) ----

  app.get<{ Params: { serverId: string }; Querystring: { before?: string } }>(
    '/api/servers/:serverId/audit',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { before: { type: 'string', pattern: '^[0-9]{1,19}$' } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      const { server } = await ctx.access.requireServer(
        user,
        request.params.serverId,
        Permissions.manageServer
      )
      const events = await ctx.repo.listAuditEvents({
        serverId: server.id,
        before: request.query.before,
        limit: 50
      })
      // IP addresses are for instance administrators only.
      return events.map(({ ip: _ip, ...rest }) => rest)
    }
  )
}
