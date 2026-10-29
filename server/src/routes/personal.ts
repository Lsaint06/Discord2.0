import type { FastifyInstance } from 'fastify'
import type { ChannelAccess } from '../access.js'
import type { AppContext } from '../context.js'
import { DIRECT_SERVER_ID } from '../db/migrations.js'
import type { MessageRecord, UserRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, notFound, tooManyRequests } from '../lib/errors.js'
import {
  SAVED_MESSAGES_LIMIT,
  USER_NOTE_MAX_LENGTH,
  type ApiSavedMessage,
  type ApiUserNote
} from '../protocol.js'
import { afterFloor } from './messages.js'
import { buildApiMessages } from './messageViews.js'

const messageParams = {
  type: 'object',
  properties: { messageId: { type: 'string', pattern: '^[0-9]{1,19}$' } }
} as const
const userParams = {
  type: 'object',
  properties: { userId: { type: 'string', maxLength: 64 } }
} as const

/** Readable right now: same rules as opening the channel (membership, View Channel, history floor). */
function canRead(access: ChannelAccess | null, message: MessageRecord): access is ChannelAccess {
  return (
    access !== null &&
    access.channelPermissions !== 0 &&
    access.channel.type === 'text' &&
    afterFloor(message.id, access.historyFrom)
  )
}

/** Trims, drops control characters (keeps line breaks) and limits the length in characters. */
export function normalizeUserNote(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim()
  return [...cleaned].length <= USER_NOTE_MAX_LENGTH ? cleaned : null
}

/**
 * Milestone 14: private saved messages (bookmarks) and private notes about other people.
 * Both are visible only to their owner; changes are echoed to the owner's other sessions.
 */
export function registerPersonalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const take = (user: UserRecord): void => {
    const result = ctx.limiters.personalPerUser.take(user.id)
    if (!result.ok) throw tooManyRequests(result.retryAfterMs)
  }

  // ---- Saved messages ----

  // Only messages you can still read are returned; the others stay saved (you may regain access)
  // but aren't shown. Deleted messages disappear with their rows.
  app.get('/api/saved-messages', async (request): Promise<ApiSavedMessage[]> => {
    const user = await requireUser(ctx, request)
    const saved = await ctx.repo.listSavedMessages(user.id)
    const records = await ctx.repo.getMessages(saved.map((s) => s.messageId))
    const byChannel = new Map<string, MessageRecord[]>()
    for (const record of records) {
      const list = byChannel.get(record.channelId) ?? []
      list.push(record)
      byChannel.set(record.channelId, list)
    }
    const out = new Map<string, ApiSavedMessage>()
    for (const [channelId, list] of byChannel) {
      const access = await ctx.access.channel(user, channelId)
      const readable = list.filter((m) => canRead(access, m))
      if (!access || readable.length === 0) continue
      const serverId = access.channel.serverId === DIRECT_SERVER_ID ? null : access.channel.serverId
      for (const message of await buildApiMessages(ctx.repo, readable, user.id, undefined, access.historyFrom)) {
        out.set(message.id, { savedAt: 0, serverId, message })
      }
    }
    return saved.flatMap((s) => {
      const item = out.get(s.messageId)
      return item ? [{ ...item, savedAt: s.savedAt }] : []
    })
  })

  app.put<{ Params: { messageId: string } }>(
    '/api/saved-messages/:messageId',
    { schema: { params: messageParams } },
    async (request) => {
      const user = await requireUser(ctx, request)
      take(user)
      const message = await ctx.repo.getMessage(request.params.messageId)
      // Messages you can't read are "not found" (no probing which ids exist).
      if (!message || !canRead(await ctx.access.channel(user, message.channelId), message)) {
        throw notFound('Message not found')
      }
      const saved = await ctx.repo.saveMessage(user.id, message.id, Date.now(), SAVED_MESSAGES_LIMIT)
      if (saved.result === 'limit') {
        throw badRequest(
          `You can save up to ${SAVED_MESSAGES_LIMIT} messages. Remove some first.`,
          'too_many_saved_messages'
        )
      }
      const d = { messageId: message.id, saved: true, savedAt: saved.savedAt }
      ctx.hub.sendToUser(user.id, { op: 'saved_message_update', d })
      return d
    }
  )

  // Removing always works, even for a message you can no longer read.
  app.delete<{ Params: { messageId: string } }>(
    '/api/saved-messages/:messageId',
    { schema: { params: messageParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(user)
      if (await ctx.repo.unsaveMessage(user.id, request.params.messageId)) {
        ctx.hub.sendToUser(user.id, {
          op: 'saved_message_update',
          d: { messageId: request.params.messageId, saved: false, savedAt: null }
        })
      }
      return reply.code(204).send()
    }
  )

  // ---- Personal notes ----

  /** The target must be someone you can see (shared server, friend, conversation, yourself). */
  const visibleTarget = async (user: UserRecord, userId: string): Promise<UserRecord> => {
    const target = await ctx.repo.getUser(userId)
    if (!target || !(await ctx.repo.isUserVisibleTo(user.id, target.id))) throw notFound('User not found')
    return target
  }

  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/note',
    { schema: { params: userParams } },
    async (request): Promise<ApiUserNote> => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profileReadsPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
      const target = await visibleTarget(user, request.params.userId)
      const note = await ctx.repo.getUserNote(user.id, target.id)
      return { userId: target.id, note: note?.note ?? '', updatedAt: note?.updatedAt ?? null }
    }
  )

  app.put<{ Params: { userId: string }; Body: { note?: unknown } }>(
    '/api/users/:userId/note',
    {
      schema: {
        params: userParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['note'],
          properties: { note: { type: 'string', maxLength: USER_NOTE_MAX_LENGTH * 4 } }
        }
      }
    },
    async (request): Promise<ApiUserNote> => {
      const user = await requireUser(ctx, request)
      take(user)
      const target = await visibleTarget(user, request.params.userId)
      const note = normalizeUserNote(request.body.note)
      if (note === null) {
        throw badRequest(`Notes can be up to ${USER_NOTE_MAX_LENGTH} characters.`, 'invalid_note')
      }
      const updatedAt = Date.now()
      await ctx.repo.setUserNote(user.id, target.id, note, updatedAt)
      const d: ApiUserNote = { userId: target.id, note, updatedAt: note ? updatedAt : null }
      ctx.hub.sendToUser(user.id, { op: 'user_note_update', d })
      return d
    }
  )
}
