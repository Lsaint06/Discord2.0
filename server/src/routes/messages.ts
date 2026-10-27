import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { RepositoryConflict, type ChannelRecord, type MessageRecord, type UserRecord } from '../db/repository.js'
import { isAttachmentId } from '../attachments/store.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { permissions } from '../lib/permissions.js'
import { normalizeEmoji, normalizeMessageContent, parseCursor } from '../lib/validation.js'
import { LIMITS } from '../protocol.js'
import { buildApiMessages, buildBroadcastMessage } from './messageViews.js'

const channelParams = {
  type: 'object',
  properties: { channelId: { type: 'string', maxLength: 64 } }
} as const

const messageParams = {
  type: 'object',
  properties: {
    channelId: { type: 'string', maxLength: 64 },
    messageId: { type: 'string', pattern: '^[0-9]{1,19}$' }
  }
} as const

const reactionParams = {
  type: 'object',
  properties: {
    ...messageParams.properties,
    emoji: { type: 'string', minLength: 1, maxLength: 64 }
  }
} as const

type ChannelParams = { channelId: string }
type MessageParams = ChannelParams & { messageId: string }

export async function readableChannel(
  ctx: AppContext,
  user: UserRecord,
  channelId: string
): Promise<ChannelRecord> {
  const channel = await ctx.repo.getChannel(channelId)
  if (!channel) throw notFound('Channel not found')
  if (channel.type !== 'text') throw badRequest('Not a text channel', 'not_text_channel')
  if (!permissions.canReadChannel(user, channel)) throw forbidden()
  return channel
}

async function messageInChannel(ctx: AppContext, channelId: string, messageId: string): Promise<MessageRecord> {
  const message = await ctx.repo.getMessage(messageId)
  // A message id from another channel is reported as "not found" (no cross-channel probing).
  if (!message || message.channelId !== channelId) throw notFound('Message not found')
  return message
}

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

async function userAndChannel(ctx: AppContext, request: FastifyRequest<{ Params: ChannelParams }>) {
  const user = await requireUser(ctx.repo, request)
  const channel = await readableChannel(ctx, user, request.params.channelId)
  return { user, channel }
}

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- History ----
  app.get<{
    Params: ChannelParams
    Querystring: { before?: string; after?: string; around?: string; limit?: string }
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
            around: { type: 'string', maxLength: 20 },
            limit: { type: 'string', pattern: '^[0-9]{1,3}$' }
          }
        }
      }
    },
    async (request) => {
      const { user, channel } = await userAndChannel(ctx, request)
      const before = parseCursor(request.query.before, 'before')
      const after = parseCursor(request.query.after, 'after')
      const around = parseCursor(request.query.around, 'around')
      if ([before, after, around].filter(Boolean).length > 1) {
        throw badRequest('Use only one of before, after or around')
      }
      const limit =
        request.query.limit === undefined ? LIMITS.messagesPageDefault : Number(request.query.limit)
      if (limit < 1 || limit > LIMITS.messagesPageMax) {
        throw badRequest(`limit must be between 1 and ${LIMITS.messagesPageMax}`)
      }
      const records = await ctx.repo.listMessages(channel.id, { before, after, around, limit })
      return buildApiMessages(ctx.repo, records, user.id)
    }
  )

  // ---- Send ----
  app.post<{
    Params: ChannelParams
    Body: { content?: string; nonce?: string; replyToId?: string; attachmentIds?: string[] }
  }>(
    '/api/channels/:channelId/messages',
    {
      schema: {
        params: channelParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Generous raw limit; the exact limit is enforced after normalization.
            content: { type: 'string', maxLength: LIMITS.messageMaxLength * 2 },
            nonce: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
            replyToId: { type: 'string', pattern: '^[0-9]{1,19}$' },
            attachmentIds: {
              type: 'array',
              maxItems: 10,
              uniqueItems: true,
              items: { type: 'string', maxLength: 64 }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx.repo, request)
      take(ctx.limiters.messagesPerUser, user.id)
      const channel = await readableChannel(ctx, user, request.params.channelId)
      if (!permissions.canPost(user, channel)) throw forbidden('You can’t post here')

      const attachmentIds = request.body.attachmentIds ?? []
      if (attachmentIds.length > ctx.config.attachments.maxFilesPerMessage) {
        throw badRequest(
          `At most ${ctx.config.attachments.maxFilesPerMessage} attachments per message`,
          'too_many_attachments'
        )
      }
      if (!attachmentIds.every(isAttachmentId)) throw badRequest('Invalid attachment id')
      const content = normalizeMessageContent(request.body.content ?? '', {
        allowEmpty: attachmentIds.length > 0
      })

      let replyToId: string | null = null
      if (request.body.replyToId) {
        const parent = await ctx.repo.getMessage(request.body.replyToId)
        if (!parent || parent.channelId !== channel.id) {
          throw badRequest('The message you replied to no longer exists', 'invalid_reply')
        }
        replyToId = parent.id
      }

      let record: MessageRecord
      try {
        record = await ctx.repo.createMessage({
          channelId: channel.id,
          authorId: user.id,
          content,
          createdAt: Date.now(),
          replyToId,
          attachmentIds
        })
      } catch (err) {
        if (err instanceof RepositoryConflict) {
          throw conflict(
            'An attachment is no longer available. Remove it and try again.',
            'attachment_unavailable'
          )
        }
        throw err
      }

      const dto = await buildBroadcastMessage(ctx.repo, record, request.body.nonce)
      ctx.hub.broadcast({ op: 'message_create', d: dto })
      // Sending a message means you've read the channel up to it.
      const lastReadId = await ctx.repo.markRead(user.id, channel.id, record.id, Date.now())
      ctx.hub.sendToUser(user.id, { op: 'read_state_update', d: { channelId: channel.id, lastReadId } })
      request.log.info(
        { op: 'message_create', message: record.id, attachments: attachmentIds.length },
        'message created'
      )
      reply.code(201)
      return dto
    }
  )

  // ---- Edit ----
  app.patch<{
    Params: MessageParams
    Body: { content: string; expectedEditedAt?: number | null }
  }>(
    '/api/channels/:channelId/messages/:messageId',
    {
      schema: {
        params: messageParams,
        body: {
          type: 'object',
          required: ['content'],
          additionalProperties: false,
          properties: {
            content: { type: 'string', maxLength: LIMITS.messageMaxLength * 2 },
            expectedEditedAt: { type: ['integer', 'null'], minimum: 0 }
          }
        }
      }
    },
    async (request) => {
      const { user, channel } = await userAndChannel(ctx, request)
      take(ctx.limiters.editsPerUser, user.id)
      const message = await messageInChannel(ctx, channel.id, request.params.messageId)
      if (!permissions.canEditMessage(user, message)) {
        throw forbidden('You can only edit your own messages', 'not_author')
      }
      const hasAttachments = (await ctx.repo.attachmentsForMessages([message.id])).length > 0
      const content = normalizeMessageContent(request.body.content, { allowEmpty: hasAttachments })
      if (content === message.content) return (await buildApiMessages(ctx.repo, [message], user.id))[0]

      let updated: MessageRecord | undefined
      try {
        updated = await ctx.repo.editMessage(
          message.id,
          user.id,
          content,
          Math.max(Date.now(), (message.editedAt ?? 0) + 1),
          request.body.expectedEditedAt
        )
      } catch (err) {
        if (err instanceof RepositoryConflict) {
          throw conflict('This message was edited somewhere else. Reload and try again.', 'edit_conflict')
        }
        throw err
      }
      if (!updated) throw notFound('Message not found')
      ctx.hub.broadcast({
        op: 'message_update',
        d: {
          id: updated.id,
          channelId: updated.channelId,
          content: updated.content,
          editedAt: updated.editedAt ?? Date.now()
        }
      })
      request.log.info({ op: 'message_edit', message: updated.id }, 'message edited')
      return (await buildApiMessages(ctx.repo, [updated], user.id))[0]
    }
  )

  // ---- Delete ----
  app.delete<{ Params: MessageParams }>(
    '/api/channels/:channelId/messages/:messageId',
    { schema: { params: messageParams } },
    async (request, reply) => {
      const { user, channel } = await userAndChannel(ctx, request)
      take(ctx.limiters.editsPerUser, user.id)
      const message = await messageInChannel(ctx, channel.id, request.params.messageId)
      if (!permissions.canDeleteMessage(user, message)) {
        throw forbidden('You can only delete your own messages', 'not_author')
      }
      // Policy: deleting a message deletes its attachments (rows cascade; files removed after
      // commit — if we crash in between, the orphan sweep removes them later).
      const removed = await ctx.repo.deleteMessage(message.id)
      await Promise.all(removed.map((a) => ctx.attachments.remove(a.id)))
      ctx.hub.broadcast({ op: 'message_delete', d: { id: message.id, channelId: channel.id } })
      request.log.info(
        { op: 'message_delete', message: message.id, attachments: removed.length },
        'message deleted'
      )
      reply.code(204)
    }
  )

  // ---- Reactions ----
  const react = async (
    request: FastifyRequest<{ Params: MessageParams & { emoji: string } }>,
    add: boolean
  ) => {
    const { user, channel } = await userAndChannel(ctx, request)
    take(ctx.limiters.reactionsPerUser, user.id)
    if (!permissions.canReact(user, channel)) throw forbidden()
    const emoji = normalizeEmoji(request.params.emoji)
    const message = await messageInChannel(ctx, channel.id, request.params.messageId)
    if (add) {
      const ok = await ctx.repo.addReaction(
        message.id,
        emoji,
        user.id,
        Date.now(),
        LIMITS.reactionsPerMessage
      )
      if (!ok) {
        throw badRequest(
          `A message can have at most ${LIMITS.reactionsPerMessage} different reactions`,
          'too_many_reactions'
        )
      }
    } else {
      await ctx.repo.removeReaction(message.id, emoji, user.id)
    }
    const count = await ctx.repo.reactionCount(message.id, emoji)
    const d = { channelId: channel.id, messageId: message.id, emoji, count, userId: user.id, added: add }
    ctx.hub.broadcast({ op: 'reaction_update', d })
    return d
  }

  app.put<{ Params: MessageParams & { emoji: string } }>(
    '/api/channels/:channelId/messages/:messageId/reactions/:emoji',
    { schema: { params: reactionParams } },
    (request) => react(request, true)
  )
  app.delete<{ Params: MessageParams & { emoji: string } }>(
    '/api/channels/:channelId/messages/:messageId/reactions/:emoji',
    { schema: { params: reactionParams } },
    (request) => react(request, false)
  )

  // ---- Pins ----
  app.get<{ Params: ChannelParams }>(
    '/api/channels/:channelId/pins',
    { schema: { params: channelParams } },
    async (request) => {
      const { user, channel } = await userAndChannel(ctx, request)
      const pins = await ctx.repo.listPins(channel.id)
      const records = await ctx.repo.getMessages(pins.map((p) => p.messageId))
      const order = new Map(pins.map((p, i) => [p.messageId, i]))
      records.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      return buildApiMessages(ctx.repo, records, user.id)
    }
  )

  const pin = async (request: FastifyRequest<{ Params: MessageParams }>, pinned: boolean) => {
    const { user, channel } = await userAndChannel(ctx, request)
    take(ctx.limiters.pinsPerUser, user.id)
    if (!permissions.canPin(user, channel)) throw forbidden('You can’t pin messages here')
    const message = await messageInChannel(ctx, channel.id, request.params.messageId)
    const at = Date.now()
    if (pinned) {
      const result = await ctx.repo.pinMessage(
        { messageId: message.id, channelId: channel.id, pinnedBy: user.id, pinnedAt: at },
        LIMITS.pinsPerChannel
      )
      if (result === 'limit') {
        throw badRequest(
          `This channel already has ${LIMITS.pinsPerChannel} pins. Unpin one first.`,
          'too_many_pins'
        )
      }
    } else {
      await ctx.repo.unpinMessage(message.id)
    }
    const d = { channelId: channel.id, messageId: message.id, pinned, userId: user.id, at }
    ctx.hub.broadcast({ op: 'pin_update', d })
    return d
  }

  app.put<{ Params: MessageParams }>(
    '/api/channels/:channelId/pins/:messageId',
    { schema: { params: messageParams } },
    (request) => pin(request, true)
  )
  app.delete<{ Params: MessageParams }>(
    '/api/channels/:channelId/pins/:messageId',
    { schema: { params: messageParams } },
    (request) => pin(request, false)
  )
}
