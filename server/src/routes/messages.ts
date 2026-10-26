import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { MessageRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, notFound, tooManyRequests } from '../lib/errors.js'
import { normalizeMessageContent, parseCursor } from '../lib/validation.js'
import { LIMITS, type ApiMessage } from '../protocol.js'

function toApiMessage(m: MessageRecord, nonce?: string): ApiMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorId,
    content: m.content,
    createdAt: m.createdAt,
    ...(nonce ? { nonce } : {})
  }
}

const channelParams = {
  type: 'object',
  properties: { channelId: { type: 'string', maxLength: 64 } }
} as const

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Params: { channelId: string }
    Querystring: { before?: string; after?: string; limit?: string }
  }>(
    '/api/channels/:channelId/messages',
    {
      schema: {
        params: channelParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            before: { type: 'string', maxLength: 20 },
            after: { type: 'string', maxLength: 20 },
            limit: { type: 'string', pattern: '^[0-9]{1,3}$' }
          }
        }
      }
    },
    async (request) => {
      await requireUser(ctx.repo, request)
      const channel = await ctx.repo.getChannel(request.params.channelId)
      if (!channel) throw notFound('Channel not found')
      if (channel.type !== 'text') throw badRequest('Not a text channel', 'not_text_channel')

      const before = parseCursor(request.query.before, 'before')
      const after = parseCursor(request.query.after, 'after')
      if (before && after) throw badRequest('Use either before or after, not both')
      const limit =
        request.query.limit === undefined ? LIMITS.messagesPageDefault : Number(request.query.limit)
      if (limit < 1 || limit > LIMITS.messagesPageMax) {
        throw badRequest(`limit must be between 1 and ${LIMITS.messagesPageMax}`)
      }

      const messages = await ctx.repo.listMessages(channel.id, { before, after, limit })
      return messages.map((m) => toApiMessage(m))
    }
  )

  app.post<{ Params: { channelId: string }; Body: { content: string; nonce?: string } }>(
    '/api/channels/:channelId/messages',
    {
      schema: {
        params: channelParams,
        body: {
          type: 'object',
          required: ['content'],
          additionalProperties: false,
          properties: {
            // Generous raw limit; the exact limit is enforced after normalization.
            content: { type: 'string', maxLength: LIMITS.messageMaxLength * 2 },
            nonce: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx.repo, request)
      const limit = ctx.limiters.messagesPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const channel = await ctx.repo.getChannel(request.params.channelId)
      if (!channel) throw notFound('Channel not found')
      if (channel.type !== 'text') throw badRequest('Not a text channel', 'not_text_channel')

      const content = normalizeMessageContent(request.body.content)
      const message = await ctx.repo.createMessage({
        channelId: channel.id,
        authorId: user.id,
        content,
        createdAt: Date.now()
      })
      const dto = toApiMessage(message, request.body.nonce)
      ctx.hub.broadcast({ op: 'message_create', d: dto })
      reply.code(201)
      return dto
    }
  )
}
