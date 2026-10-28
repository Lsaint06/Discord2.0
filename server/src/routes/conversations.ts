/**
 * Direct (one-to-one) and group conversations (Milestone 10). A conversation is a text channel
 * in the reserved DIRECT_SERVER_ID container, so messages, attachments, reactions, pins, reads
 * and search reuse the channel routes; this file manages who belongs to which conversation.
 *
 * Rules:
 * - A DM can be started with a friend, or with someone you share a server with if they allow
 *   DMs from server members — never across a block. The same rule is re-checked on every send.
 * - There is exactly one DM per pair. It can be closed (hidden) but not left; a new message
 *   reopens it.
 * - Groups: you create them with friends (3–10 people in total). Any member can add their own
 *   friends and rename the group; only the owner removes people. Added members see messages from
 *   the moment they joined, never older history.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ChannelAccess } from '../access.js'
import type { AppContext } from '../context.js'
import { conversationFor, publishConversation, toApiConversation } from '../conversationEvents.js'
import type { UserRecord } from '../db/repository.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors.js'
import { normalizeGroupName } from '../lib/validation.js'
import { LIMITS, type ApiConversation, type ApiConversationEvent, type ConversationEventAction } from '../protocol.js'

const idParam = { type: 'string', minLength: 1, maxLength: 64 } as const
const conversationParams = { type: 'object', properties: { channelId: idParam } } as const
type ConversationParams = { channelId: string }

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

const DM_REFUSED = 'You can’t send direct messages to this person.'

export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** A conversation the user belongs to (404 otherwise — no probing of other conversations). */
  const memberOf = async (user: UserRecord, channelId: string): Promise<ChannelAccess & { conversation: NonNullable<ChannelAccess['conversation']> }> => {
    const access = await ctx.access.channel(user, channelId)
    if (!access || !access.conversation) throw notFound('Conversation not found')
    return access as ChannelAccess & { conversation: NonNullable<ChannelAccess['conversation']> }
  }

  const groupOf = async (user: UserRecord, channelId: string) => {
    const access = await memberOf(user, channelId)
    if (access.conversation.kind !== 'group') {
      throw badRequest('Only group conversations can do that.', 'not_a_group')
    }
    return access
  }

  const view = async (channelId: string, userId: string): Promise<ApiConversation> => {
    const result = await conversationFor(ctx, channelId, userId)
    if (!result) throw notFound('Conversation not found')
    return result
  }

  /** Someone the actor may put in a group: an active, non-bot friend with no block either way. */
  const assertAddable = async (actorId: string, userId: string): Promise<void> => {
    const target = await ctx.repo.getUser(userId)
    if (
      !target ||
      target.bot ||
      target.disabledAt ||
      !(await ctx.repo.areFriends(actorId, userId)) ||
      (await ctx.repo.isBlockedEither(actorId, userId))
    ) {
      throw forbidden('You can only add your friends to a group.', 'not_friends')
    }
  }

  app.get('/api/conversations', async (request): Promise<ApiConversation[]> => {
    const user = await requireUser(ctx, request)
    if (user.bot) return []
    const summaries = await ctx.repo.listConversationsForUser(user.id)
    return Promise.all(summaries.map((s) => toApiConversation(ctx, s, user.id)))
  })

  /** Opens (or creates) the one DM with a user. Reopens it if you had closed it. */
  app.post<{ Body: { userId: string } }>(
    '/api/conversations/dm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: idParam }
        }
      }
    },
    async (request, reply): Promise<ApiConversation> => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.conversationsPerUser, user.id)
      const otherId = request.body.userId
      if (otherId === user.id) throw badRequest('You can’t message yourself.', 'self_dm')
      const other = await ctx.repo.getUser(otherId)
      if (!other || other.bot || !(await ctx.repo.isUserVisibleTo(user.id, otherId))) {
        throw notFound('User not found')
      }

      const existing = await ctx.repo.findDm(user.id, otherId)
      if (existing) {
        // An existing DM can always be reopened to read its history, even when sending isn't allowed.
        await ctx.repo.setConversationClosed(existing.channelId, user.id, false)
        const result = await view(existing.channelId, user.id)
        ctx.hub.sendToUser(user.id, { op: 'conversation_update', d: result })
        return result
      }

      // Blocks and "not allowed" get the same answer: nobody learns they were blocked.
      if ((await ctx.access.dmBlockReason(user.id, otherId)) !== null) throw forbidden(DM_REFUSED, 'dm_not_allowed')
      const { conversation, created } = await ctx.repo.findOrCreateDm(user.id, otherId, Date.now(), randomUUID())
      if (created) {
        // The other person sees the conversation once there is a message in it.
        await ctx.repo.setConversationClosed(conversation.channelId, otherId, true)
        request.log.info({ op: 'dm_create', channel: conversation.channelId }, 'direct conversation created')
        reply.code(201)
      } else {
        await ctx.repo.setConversationClosed(conversation.channelId, user.id, false)
      }
      const result = await view(conversation.channelId, user.id)
      ctx.hub.sendToUser(user.id, { op: 'conversation_update', d: result })
      return result
    }
  )

  app.post<{ Body: { userIds: string[]; name?: string | null } }>(
    '/api/conversations/group',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userIds'],
          additionalProperties: false,
          properties: {
            userIds: {
              type: 'array',
              uniqueItems: true,
              minItems: LIMITS.groupMinMembers - 1,
              maxItems: LIMITS.groupMaxMembers - 1,
              items: idParam
            },
            name: { type: ['string', 'null'], maxLength: LIMITS.groupNameMaxLength * 2 }
          }
        }
      }
    },
    async (request, reply): Promise<ApiConversation> => {
      const user = await requireUser(ctx, request)
      if (user.bot) throw forbidden()
      take(ctx.limiters.conversationsPerUser, user.id)
      const ids = request.body.userIds
      if (ids.includes(user.id)) throw badRequest('Don’t include yourself — you’re added automatically.', 'self_in_group')
      const name = normalizeGroupName(request.body.name)
      for (const id of ids) await assertAddable(user.id, id)
      const conversation = await ctx.repo.createGroup(user.id, ids, name, Date.now(), randomUUID())
      await publishConversation(ctx, conversation.channelId)
      request.log.info({ op: 'group_create', channel: conversation.channelId, members: ids.length + 1 }, 'group created')
      reply.code(201)
      return view(conversation.channelId, user.id)
    }
  )

  app.patch<{ Params: ConversationParams; Body: { name: string | null } }>(
    '/api/conversations/:channelId',
    {
      schema: {
        params: conversationParams,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: ['string', 'null'], maxLength: LIMITS.groupNameMaxLength * 2 } }
        }
      }
    },
    async (request): Promise<ApiConversation> => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.groupChangesPerUser, user.id)
      const { conversation } = await groupOf(user, request.params.channelId)
      const name = normalizeGroupName(request.body.name)
      if (name !== conversation.name) {
        await ctx.repo.renameConversation(conversation.channelId, name, user.id, Date.now())
        await publishConversation(ctx, conversation.channelId)
      }
      return view(conversation.channelId, user.id)
    }
  )

  app.post<{ Params: ConversationParams; Body: { userId: string } }>(
    '/api/conversations/:channelId/members',
    {
      schema: {
        params: conversationParams,
        body: {
          type: 'object',
          required: ['userId'],
          additionalProperties: false,
          properties: { userId: idParam }
        }
      }
    },
    async (request): Promise<ApiConversation> => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.groupChangesPerUser, user.id)
      const { conversation } = await groupOf(user, request.params.channelId)
      const userId = request.body.userId
      await assertAddable(user.id, userId)
      const result = await ctx.repo.addConversationMember(
        conversation.channelId,
        user.id,
        userId,
        Date.now(),
        LIMITS.groupMaxMembers
      )
      if (result === 'full') {
        throw conflict(`Groups can have at most ${LIMITS.groupMaxMembers} members.`, 'group_full')
      }
      if (result === 'exists') throw conflict('They’re already in this group.', 'already_member')
      await publishConversation(ctx, conversation.channelId)
      return view(conversation.channelId, user.id)
    }
  )

  app.delete<{ Params: ConversationParams & { userId: string } }>(
    '/api/conversations/:channelId/members/:userId',
    { schema: { params: { type: 'object', properties: { channelId: idParam, userId: idParam } } } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.groupChangesPerUser, user.id)
      const { conversation } = await groupOf(user, request.params.channelId)
      const target = request.params.userId
      if (target === user.id) throw badRequest('Use “Leave group” to leave.', 'use_leave')
      if (conversation.ownerId !== user.id) {
        throw forbidden('Only the group owner can remove people.', 'not_owner')
      }
      const { removed } = await ctx.repo.removeConversationMember(
        conversation.channelId,
        target,
        user.id,
        'removed',
        Date.now()
      )
      if (!removed) throw notFound('They aren’t in this group.')
      ctx.hub.sendToUser(target, {
        op: 'conversation_remove',
        d: { channelId: conversation.channelId, reason: 'removed' }
      })
      await publishConversation(ctx, conversation.channelId)
      reply.code(204)
    }
  )

  app.post<{ Params: ConversationParams }>(
    '/api/conversations/:channelId/leave',
    { schema: { params: conversationParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.groupChangesPerUser, user.id)
      const { conversation } = await memberOf(user, request.params.channelId)
      if (conversation.kind !== 'group') {
        throw badRequest('You can close a direct message, but not leave it.', 'not_a_group')
      }
      await ctx.repo.removeConversationMember(conversation.channelId, user.id, user.id, 'left', Date.now())
      ctx.hub.sendToUser(user.id, {
        op: 'conversation_remove',
        d: { channelId: conversation.channelId, reason: 'left' }
      })
      await publishConversation(ctx, conversation.channelId)
      reply.code(204)
    }
  )

  /** Hides the conversation from your list (on all your devices) until the next message. */
  app.post<{ Params: ConversationParams }>(
    '/api/conversations/:channelId/close',
    { schema: { params: conversationParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.groupChangesPerUser, user.id)
      const { conversation } = await memberOf(user, request.params.channelId)
      await ctx.repo.setConversationClosed(conversation.channelId, user.id, true)
      ctx.hub.sendToUser(user.id, {
        op: 'conversation_remove',
        d: { channelId: conversation.channelId, reason: 'closed' }
      })
      reply.code(204)
    }
  )

  /** Membership history since you joined (who added, removed or left; renames). */
  app.get<{ Params: ConversationParams }>(
    '/api/conversations/:channelId/events',
    { schema: { params: conversationParams } },
    async (request: FastifyRequest<{ Params: ConversationParams }>): Promise<ApiConversationEvent[]> => {
      const user = await requireUser(ctx, request)
      const { conversation, member } = await memberOf(user, request.params.channelId)
      const events = await ctx.repo.listConversationEvents(conversation.channelId, member?.joinedAt ?? 0, 100)
      return events.map((e) => ({
        id: e.id,
        at: e.at,
        actorId: e.actorId,
        action: e.action as ConversationEventAction,
        targetUserId: e.targetUserId,
        ...(e.detail && 'name' in e.detail ? { name: (e.detail.name as string | null) ?? null } : {})
      }))
    }
  )
}
