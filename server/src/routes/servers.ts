import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { ChannelRecord, ServerRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { notFound, tooManyRequests } from '../lib/errors.js'
import { normalizeColor, normalizeServerName } from '../lib/validation.js'
import type { ApiChannel, ApiServer } from '../protocol.js'

export function toApiChannel(c: ChannelRecord): ApiChannel {
  return {
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    type: c.type,
    topic: c.topic,
    category: c.category,
    position: c.position
  }
}

function toApiServer(s: ServerRecord, channels: ChannelRecord[]): ApiServer {
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    channels: channels.filter((c) => c.serverId === s.id).map(toApiChannel)
  }
}

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/servers', async (request) => {
    await requireUser(ctx.repo, request)
    const [servers, channels] = await Promise.all([ctx.repo.listServers(), ctx.repo.listChannels()])
    return servers.map((s) => toApiServer(s, channels))
  })

  app.get<{ Params: { serverId: string } }>(
    '/api/servers/:serverId/channels',
    {
      schema: {
        params: {
          type: 'object',
          properties: { serverId: { type: 'string', maxLength: 64 } }
        }
      }
    },
    async (request) => {
      await requireUser(ctx.repo, request)
      const channels = (await ctx.repo.listChannels()).filter(
        (c) => c.serverId === request.params.serverId
      )
      if (channels.length === 0) throw notFound('Server not found')
      return channels.map(toApiChannel)
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
      const user = await requireUser(ctx.repo, request)
      const limit = ctx.limiters.serversPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const now = Date.now()
      const existing = await ctx.repo.listServers()
      const server: ServerRecord = {
        id: randomUUID(),
        name: normalizeServerName(request.body.name),
        color: normalizeColor(request.body.color),
        ownerId: user.id,
        position: existing.length,
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
      await ctx.repo.createServer(server, channels)
      const dto = toApiServer(server, channels)
      ctx.hub.broadcast({ op: 'server_create', d: dto })
      reply.code(201)
      return dto
    }
  )
}
