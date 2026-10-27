import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, notFound, tooManyRequests } from '../lib/errors.js'
import { permissions } from '../lib/permissions.js'
import { buildSearchMatch, parseCursor, parseDay } from '../lib/validation.js'
import { LIMITS, type ApiReadState, type ApiSearchResult } from '../protocol.js'
import { readableChannel } from './messages.js'
import { buildApiMessages } from './messageViews.js'

export function registerReadStateRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Read position + unread count for every readable text channel (missing ones start caught up). */
  app.get('/api/read-states', async (request): Promise<ApiReadState[]> => {
    const user = await requireUser(ctx.repo, request)
    const channels = (await ctx.repo.listChannels()).filter((c) =>
      permissions.canReadChannel(user, c)
    )
    return ctx.repo.readStates(
      user.id,
      channels.map((c) => c.id),
      Date.now(),
      LIMITS.unreadCountCap
    )
  })

  /** Moves the read position forward (never backwards) and syncs the user's other sessions. */
  app.put<{ Params: { channelId: string }; Body: { messageId: string } }>(
    '/api/channels/:channelId/read',
    {
      schema: {
        params: { type: 'object', properties: { channelId: { type: 'string', maxLength: 64 } } },
        body: {
          type: 'object',
          required: ['messageId'],
          additionalProperties: false,
          properties: { messageId: { type: 'string', pattern: '^[0-9]{1,19}$' } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx.repo, request)
      const limit = ctx.limiters.readAcksPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const channel = await readableChannel(ctx, user, request.params.channelId)
      const message = await ctx.repo.getMessage(request.body.messageId)
      if (!message || message.channelId !== channel.id) throw notFound('Message not found')
      const lastReadId = await ctx.repo.markRead(user.id, channel.id, message.id, Date.now())
      ctx.hub.sendToUser(user.id, { op: 'read_state_update', d: { channelId: channel.id, lastReadId } })
      return { channelId: channel.id, lastReadId }
    }
  )
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Querystring: {
      q?: string
      channelId?: string
      serverId?: string
      authorId?: string
      since?: string
      until?: string
      before?: string
      limit?: string
    }
  }>(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: LIMITS.searchQueryMaxLength * 2 },
            channelId: { type: 'string', maxLength: 64 },
            serverId: { type: 'string', maxLength: 64 },
            authorId: { type: 'string', maxLength: 64 },
            since: { type: 'string', maxLength: 10 },
            until: { type: 'string', maxLength: 10 },
            before: { type: 'string', maxLength: 20 },
            limit: { type: 'string', pattern: '^[0-9]{1,2}$' }
          }
        }
      }
    },
    async (request): Promise<ApiSearchResult> => {
      const user = await requireUser(ctx.repo, request)
      const rate = ctx.limiters.searchPerUser.take(user.id)
      if (!rate.ok) throw tooManyRequests(rate.retryAfterMs)
      const q = request.query
      const match = buildSearchMatch(q.q)
      const since = parseDay(q.since, 'since')
      const until = parseDay(q.until, 'until', true)
      if (!match && !q.authorId && since === undefined && until === undefined) {
        throw badRequest('Enter something to search for', 'empty_search')
      }
      const before = parseCursor(q.before, 'before')
      const limit = q.limit === undefined ? 25 : Number(q.limit)
      if (limit < 1 || limit > LIMITS.searchPageMax) {
        throw badRequest(`limit must be between 1 and ${LIMITS.searchPageMax}`)
      }

      let channelIds: string[]
      if (q.channelId) {
        channelIds = [(await readableChannel(ctx, user, q.channelId)).id]
      } else {
        channelIds = (await ctx.repo.listChannels())
          .filter((c) => (!q.serverId || c.serverId === q.serverId) && permissions.canReadChannel(user, c))
          .map((c) => c.id)
      }

      // Fetch one extra to know whether there is another page.
      const records = await ctx.repo.searchMessages({
        match,
        channelIds,
        authorId: q.authorId,
        since,
        until,
        before,
        limit: limit + 1
      })
      const page = records.slice(0, limit)
      return {
        messages: await buildApiMessages(ctx.repo, page, user.id),
        nextBefore: records.length > limit ? page[page.length - 1]!.id : null
      }
    }
  )
}
