/**
 * Milestone 13 server administration: server icon, channel layout (categories and order),
 * member timeouts and the timeout sweeper. Every action is authorized here on the backend
 * (Manage Server, Manage Channels, Moderate Members + role hierarchy) and audit-logged.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { ServerIconRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { canModerateMember } from '../lib/permissions.js'
import { normalizeCategoryName } from '../lib/validation.js'
import { isProfileMediaId, processProfileImage, ProfileImageError, type ProfileImageSize } from '../profile/media.js'
import { LIMITS, Permissions, type ApiMember } from '../protocol.js'
import { publishServerChanged } from '../realtime.js'
import { imageError, receiveImageUpload } from './profile.js'
import { afterAccessChange, serverView } from './servers.js'

const idParam = { type: 'string', maxLength: 64 } as const
const MAX_CHANNELS = 100

export function registerServerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rate = (limiter: keyof AppContext['limiters'], userId: string): void => {
    const limit = ctx.limiters[limiter].take(userId)
    if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
  }

  // ---- Server icon (Manage Server) ----

  app.post<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/icon',
    { schema: { params: { type: 'object', properties: { serverId: idParam } } } },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate('profileMediaPerUser', user.id)
      const { server } = await ctx.access.requireServer(user, request.params.serverId, Permissions.manageServer)
      const received = await receiveImageUpload(ctx, request)
      let image
      try {
        // Same pipeline as profile pictures: magic-byte check, decode, re-encode to WebP.
        image = await processProfileImage('avatar', received.tmpPath, received.head)
      } catch (err) {
        throw err instanceof ProfileImageError ? imageError(err) : err
      } finally {
        await ctx.attachments.discard(received.tmpPath)
      }
      const icon: ServerIconRecord = {
        id: ctx.serverIcons.newId(),
        serverId: server.id,
        createdBy: user.id,
        size: image.full.length,
        sha256: image.sha256,
        createdAt: Date.now()
      }
      await ctx.serverIcons.save(icon.id, image)
      let previousId: string | null
      try {
        ;({ previousId } = await ctx.repo.replaceServerIcon(server.id, icon))
      } catch (err) {
        await ctx.serverIcons.remove(icon.id)
        throw err
      }
      await ctx.serverIcons.remove(previousId)
      await ctx.audit.record({ action: 'server.icon_changed', actorId: user.id, serverId: server.id, request })
      await publishServerChanged(ctx, server.id)
      return serverView(ctx, user.id, server.id)
    }
  )

  app.delete<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/icon',
    { schema: { params: { type: 'object', properties: { serverId: idParam } } } },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate('profileMediaPerUser', user.id)
      const { server } = await ctx.access.requireServer(user, request.params.serverId, Permissions.manageServer)
      const { previousId } = await ctx.repo.replaceServerIcon(server.id, null)
      await ctx.serverIcons.remove(previousId)
      if (previousId) {
        await ctx.audit.record({ action: 'server.icon_removed', actorId: user.id, serverId: server.id, request })
        await publishServerChanged(ctx, server.id)
      }
      return serverView(ctx, user.id, server.id)
    }
  )

  /** Members only (non-members get 404, so icon ids can't be probed). */
  app.get<{ Params: { iconId: string }; Querystring: { size?: ProfileImageSize } }>(
    '/api/server-icons/:iconId',
    {
      schema: {
        params: { type: 'object', properties: { iconId: idParam } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { size: { type: 'string', enum: ['full', 'small'] } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      rate('profileReadsPerUser', user.id)
      const id = request.params.iconId
      if (!isProfileMediaId(id)) throw notFound('Image not found')
      const icon = await ctx.repo.getServerIcon(id)
      if (!icon || !(await ctx.access.server(user, icon.serverId))) throw notFound('Image not found')
      const size = request.query.size ?? 'full'
      let file
      try {
        file = await ctx.serverIcons.open(id, size)
      } catch {
        request.log.error({ icon: id }, 'server icon missing on disk')
        throw notFound('Image file is missing')
      }
      reply
        .header('Content-Type', 'image/webp')
        .header('Content-Length', file.size)
        .header('Content-Disposition', 'inline; filename="icon.webp"')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'same-site')
        // A new icon always gets a new id.
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('ETag', `"${icon.sha256.slice(0, 32)}-${size}"`)
      return reply.send(file.stream)
    }
  )

  // ---- Channel layout: categories and order (Manage Channels) ----

  /**
   * Body: every channel you can see, in the new order, each with its category. Channels you
   * can't see keep their place, so the layout never reveals or moves hidden channels. If the
   * list doesn't match what you can see (someone added or removed a channel meanwhile), 409.
   */
  app.put<{ Params: { serverId: string }; Body: { channels: { id: string; category: string }[] } }>(
    '/api/servers/:serverId/layout',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam } },
        body: {
          type: 'object',
          required: ['channels'],
          additionalProperties: false,
          properties: {
            channels: {
              type: 'array',
              maxItems: MAX_CHANNELS,
              items: {
                type: 'object',
                required: ['id', 'category'],
                additionalProperties: false,
                properties: {
                  id: idParam,
                  category: { type: 'string', maxLength: 80 }
                }
              }
            }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      rate('moderationPerUser', user.id)
      const { server } = await ctx.access.requireServer(user, request.params.serverId, Permissions.manageChannels)
      const visible = (await ctx.access.visibleServers(user)).find((s) => s.server.id === server.id)
      if (!visible) throw notFound('Server not found')
      const seen = new Set<string>()
      for (const c of request.body.channels) {
        if (seen.has(c.id)) throw badRequest('A channel is listed twice', 'duplicate_channel')
        seen.add(c.id)
      }
      const mine = visible.channels.map((c) => c.channel)
      if (seen.size !== mine.length || mine.some((c) => !seen.has(c.id))) {
        throw conflict('The channel list changed. Reload and try again.', 'layout_changed')
      }
      const categories = request.body.channels.map((c) => normalizeCategoryName(c.category))
      if (new Set(categories).size > 50) throw badRequest('Too many categories', 'too_many_categories')
      // Reuse the visible channels' existing position slots in the new order.
      const slots = mine.map((c) => c.position).sort((a, b) => a - b)
      const placements = request.body.channels.map((c, i) => ({
        id: c.id,
        category: categories[i]!,
        position: slots[i]!
      }))
      await ctx.repo.arrangeChannels(server.id, placements)
      await ctx.audit.record({
        action: 'channel.layout',
        actorId: user.id,
        serverId: server.id,
        request,
        detail: { channels: placements.length, categories: new Set(categories).size }
      })
      await publishServerChanged(ctx, server.id)
      return serverView(ctx, user.id, server.id)
    }
  )

  // ---- Member timeout (Moderate Members, strictly lower role) ----

  app.put<{
    Params: { serverId: string; userId: string }
    Body: { minutes: number | null; reason?: string }
  }>(
    '/api/servers/:serverId/members/:userId/timeout',
    {
      schema: {
        params: { type: 'object', properties: { serverId: idParam, userId: idParam } },
        body: {
          type: 'object',
          required: ['minutes'],
          additionalProperties: false,
          properties: {
            minutes: {
              anyOf: [
                { type: 'integer', minimum: 1, maximum: LIMITS.timeoutMaxMinutes },
                { type: 'null' }
              ]
            },
            // Accepted for the audit log only.
            reason: { type: 'string', maxLength: LIMITS.banReasonMaxLength }
          }
        }
      }
    },
    async (request): Promise<ApiMember> => {
      const user = await requireUser(ctx, request)
      rate('moderationPerUser', user.id)
      const actor = await ctx.access.requireServer(user, request.params.serverId)
      if (request.params.userId === user.id) throw badRequest('You can’t time yourself out.', 'self')
      const target = await ctx.repo.getMember(actor.server.id, request.params.userId)
      if (!target) throw notFound('Member not found')
      if (!canModerateMember(actor, target.role, Permissions.moderateMembers)) {
        throw forbidden('You can only time out members below your role.', 'role_hierarchy')
      }
      const minutes = request.body.minutes
      const until = minutes === null ? null : Date.now() + minutes * 60_000
      if (!(await ctx.repo.setMemberTimeout(actor.server.id, target.userId, until))) {
        throw notFound('Member not found')
      }
      const reason = request.body.reason?.trim() || undefined
      await ctx.audit.record({
        action: minutes === null ? 'server.timeout_removed' : 'server.timeout',
        actorId: user.id,
        targetUserId: target.userId,
        serverId: actor.server.id,
        request,
        detail: minutes === null ? undefined : { minutes, until, reason }
      })
      // Refreshes everyone's view (permissions) and removes them from voice right away.
      await afterAccessChange(ctx, actor.server.id)
      return { userId: target.userId, role: target.role, joinedAt: target.joinedAt, timeoutUntil: until }
    }
  )
}

/** Clears timeouts that have ended and tells those servers' members to refresh. */
export async function expireTimeouts(ctx: AppContext, now = Date.now()): Promise<number> {
  const servers = await ctx.repo.clearExpiredTimeouts(now)
  for (const id of servers) await publishServerChanged(ctx, id)
  return servers.length
}

/** Removes server icon files that no longer have a database row (after a grace period). */
export async function cleanupServerIcons(
  ctx: AppContext,
  log: FastifyBaseLogger,
  now = Date.now()
): Promise<number> {
  const referenced = await ctx.repo.listServerIconIds()
  const removed = await ctx.serverIcons.sweep(referenced, 60 * 60_000, now)
  if (removed) log.info({ removed }, 'server icon cleanup')
  return removed
}
