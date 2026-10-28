import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ChannelAccess } from '../access.js'
import type { AppContext } from '../context.js'
import { RepositoryConflict, type MessageRecord, type UserRecord } from '../db/repository.js'
import { DIRECT_SERVER_ID } from '../db/migrations.js'
import { isAttachmentId } from '../attachments/store.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { has } from '../lib/permissions.js'
import { normalizeEmoji, normalizeMessageContent, parseCursor } from '../lib/validation.js'
import { LIMITS, Permissions } from '../protocol.js'
import { publishToChannel } from '../realtime.js'
import { afterConversationMessage } from '../conversationEvents.js'
import { buildApiMessages, buildBroadcastMessage, withHiddenReply } from './messageViews.js'

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

/**
 * A text channel the user can view (membership + View Channel), optionally requiring more
 * permission bits. Non-members and hidden channels are "not found"; missing bits are 403.
 */
export async function readableChannel(
  ctx: AppContext,
  user: UserRecord,
  channelId: string,
  bits = 0,
  message?: string
): Promise<ChannelAccess> {
  const access = await ctx.access.requireChannel(user, channelId)
  if (access.channel.type !== 'text') throw badRequest('Not a text channel', 'not_text_channel')
  if (bits && !has(access.channelPermissions, bits)) {
    throw forbidden(message ?? 'You don’t have permission to do that here.', 'missing_permission')
  }
  return access
}

/** True if a message id is above the viewer's history floor (always true in server channels). */
export function afterFloor(messageId: string, historyFrom: string): boolean {
  return BigInt(messageId) > BigInt(historyFrom)
}

async function messageInChannel(
  ctx: AppContext,
  channelId: string,
  messageId: string,
  historyFrom = '0'
): Promise<MessageRecord> {
  const message = await ctx.repo.getMessage(messageId)
  // A message id from another channel — or from before the viewer joined the conversation —
  // is reported as "not found" (no probing).
  if (!message || message.channelId !== channelId || !afterFloor(message.id, historyFrom)) {
    throw notFound('Message not found')
  }
  return message
}

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

async function userAndChannel(ctx: AppContext, request: FastifyRequest<{ Params: ChannelParams }>) {
  const user = await requireUser(ctx, request)
  const access = await readableChannel(ctx, user, request.params.channelId)
  return { user, channel: access.channel, perms: access.channelPermissions, floor: access.historyFrom }
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
      const { user, channel, floor } = await userAndChannel(ctx, request)
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
      const records = await ctx.repo.listMessages(channel.id, { before, after, around, limit, minId: floor })
      return buildApiMessages(ctx.repo, records, user.id, undefined, floor)
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
      const user = await requireUser(ctx, request)
      take(ctx.limiters.messagesPerUser, user.id)
      const access = await readableChannel(
        ctx,
        user,
        request.params.channelId,
        Permissions.sendMessages,
        'You can’t send messages in this channel.'
      )
      const { channel, channelPermissions: perms, historyFrom } = access

      const attachmentIds = request.body.attachmentIds ?? []
      if (attachmentIds.length > 0 && !has(perms, Permissions.attachFiles)) {
        throw forbidden('You can’t attach files in this channel.', 'missing_permission')
      }
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
        if (!parent || parent.channelId !== channel.id || !afterFloor(parent.id, historyFrom)) {
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
      if (access.conversation) {
        // Reopens the conversation for anyone who closed it before anyone receives the message.
        await afterConversationMessage(ctx, access.conversation)
        const members = await ctx.repo.listConversationMembers(channel.id)
        const full = new Set<string>()
        const masked = new Set<string>()
        for (const m of members) {
          // Members who joined after the reply's parent must not see its preview.
          if (replyToId && !afterFloor(replyToId, m.historyFrom)) masked.add(m.userId)
          else full.add(m.userId)
        }
        ctx.hub.sendToUsers(full, { op: 'message_create', d: dto })
        ctx.hub.sendToUsers(masked, { op: 'message_create', d: withHiddenReply(dto) })
      } else {
        await publishToChannel(ctx, channel, { op: 'message_create', d: dto })
      }
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
      const { user, channel, floor } = await userAndChannel(ctx, request)
      take(ctx.limiters.editsPerUser, user.id)
      const message = await messageInChannel(ctx, channel.id, request.params.messageId, floor)
      // Only authors edit their own messages (moderators can delete, never rewrite).
      if (message.authorId !== user.id) {
        throw forbidden('You can only edit your own messages', 'not_author')
      }
      // Timed out: no new words in the server, and rewriting old messages would be just that.
      if (channel.serverId !== DIRECT_SERVER_ID && (await ctx.access.server(user, channel.serverId))?.timeoutUntil) {
        throw forbidden('You can’t edit messages while you’re timed out.', 'timed_out')
      }
      const hasAttachments = (await ctx.repo.attachmentsForMessages([message.id])).length > 0
      const content = normalizeMessageContent(request.body.content, { allowEmpty: hasAttachments })
      if (content === message.content) {
        return (await buildApiMessages(ctx.repo, [message], user.id, undefined, floor))[0]
      }

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
      await publishToChannel(ctx, channel, {
        op: 'message_update',
        d: {
          id: updated.id,
          channelId: updated.channelId,
          content: updated.content,
          editedAt: updated.editedAt ?? Date.now()
        }
      }, updated.id)
      request.log.info({ op: 'message_edit', message: updated.id }, 'message edited')
      return (await buildApiMessages(ctx.repo, [updated], user.id, undefined, floor))[0]
    }
  )

  // ---- Delete ----
  app.delete<{ Params: MessageParams }>(
    '/api/channels/:channelId/messages/:messageId',
    { schema: { params: messageParams } },
    async (request, reply) => {
      const { user, channel, perms, floor } = await userAndChannel(ctx, request)
      take(ctx.limiters.editsPerUser, user.id)
      const message = await messageInChannel(ctx, channel.id, request.params.messageId, floor)
      const own = message.authorId === user.id
      if (!own && !has(perms, Permissions.manageMessages)) {
        throw forbidden('You can only delete your own messages', 'not_author')
      }
      // Policy: deleting a message deletes its attachments (rows cascade; files removed after
      // commit — if we crash in between, the orphan sweep removes them later).
      const removed = await ctx.repo.deleteMessage(message.id)
      await Promise.all(removed.map((a) => ctx.attachments.remove(a.id)))
      await publishToChannel(
        ctx,
        channel,
        { op: 'message_delete', d: { id: message.id, channelId: channel.id } },
        message.id
      )
      if (!own) {
        await ctx.audit.record({
          action: 'message.moderator_delete',
          actorId: user.id,
          targetUserId: message.authorId,
          serverId: channel.serverId,
          request,
          detail: { channelId: channel.id, messageId: message.id }
        })
      }
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
    const { user, channel, perms, floor } = await userAndChannel(ctx, request)
    take(ctx.limiters.reactionsPerUser, user.id)
    // Removing your own reaction is always allowed; adding one needs Add Reactions.
    if (add && !has(perms, Permissions.addReactions)) {
      throw forbidden('You can’t add reactions in this channel.', 'missing_permission')
    }
    const emoji = normalizeEmoji(request.params.emoji)
    const message = await messageInChannel(ctx, channel.id, request.params.messageId, floor)
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
    await publishToChannel(ctx, channel, { op: 'reaction_update', d }, message.id)
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
      const { user, channel, floor } = await userAndChannel(ctx, request)
      const pins = (await ctx.repo.listPins(channel.id)).filter((p) => afterFloor(p.messageId, floor))
      const records = await ctx.repo.getMessages(pins.map((p) => p.messageId))
      const order = new Map(pins.map((p, i) => [p.messageId, i]))
      records.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      return buildApiMessages(ctx.repo, records, user.id, undefined, floor)
    }
  )

  const pin = async (request: FastifyRequest<{ Params: MessageParams }>, pinned: boolean) => {
    const { user, channel, perms, floor } = await userAndChannel(ctx, request)
    take(ctx.limiters.pinsPerUser, user.id)
    if (!has(perms, Permissions.pinMessages) && !has(perms, Permissions.manageMessages)) {
      throw forbidden('You can’t pin messages here', 'missing_permission')
    }
    const message = await messageInChannel(ctx, channel.id, request.params.messageId, floor)
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
    await publishToChannel(ctx, channel, { op: 'pin_update', d }, message.id)
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
