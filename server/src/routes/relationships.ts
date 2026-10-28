/**
 * Friends, friend requests, blocking and DM privacy (Milestone 10).
 *
 * Privacy rules: a friend request to a username that doesn't exist, belongs to a bot or a
 * disabled account, or to someone who blocked you gets the same response — nobody can learn who
 * blocked them. Blocking is silent: the blocked person only sees "no relationship".
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { publishDmBetween, publishRelationship } from '../conversationEvents.js'
import { requireUser } from '../lib/auth.js'
import { ApiError, badRequest, conflict, notFound, tooManyRequests } from '../lib/errors.js'
import { normalizeUsername } from '../lib/validation.js'
import type { ApiRelationship } from '../protocol.js'
import { toApiMe } from '../realtime.js'

const userParams = {
  type: 'object',
  properties: { userId: { type: 'string', minLength: 1, maxLength: 64 } }
} as const

type UserParams = { userId: string }

function take(limit: { take: (key: string) => { ok: boolean; retryAfterMs: number } }, key: string): void {
  const result = limit.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterMs)
}

/** One response for "no such person", bots, disabled accounts and people who blocked you. */
const requestFailed = (): ApiError =>
  new ApiError(
    404,
    'friend_request_failed',
    'That didn’t work. Double-check the username — it’s case-insensitive but must match exactly.'
  )

export function registerRelationshipRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Who sees whom: both people's views of each other (presence is hidden across a block). */
  const publishUserViews = async (a: string, b: string): Promise<void> => {
    const [ua, ub, blocked, aSeesB, bSeesA] = await Promise.all([
      ctx.repo.getUser(a),
      ctx.repo.getUser(b),
      ctx.repo.isBlockedEither(a, b),
      ctx.repo.isUserVisibleTo(a, b),
      ctx.repo.isUserVisibleTo(b, a)
    ])
    if (!ua || !ub) return
    const view = (u: typeof ua) => (blocked ? ctx.hub.maskedApiUser(u) : ctx.hub.toApiUser(u))
    // Never introduce someone to a person who otherwise couldn't see them.
    if (aSeesB) ctx.hub.sendToUser(a, { op: 'user_update', d: view(ub) })
    if (bSeesA) ctx.hub.sendToUser(b, { op: 'user_update', d: view(ua) })
  }

  const afterChange = async (a: string, b: string): Promise<void> => {
    await publishRelationship(ctx, a, b)
    await publishUserViews(a, b)
    // Whether the pair may send direct messages may have changed.
    await publishDmBetween(ctx, a, b)
  }

  app.get('/api/relationships', async (request): Promise<ApiRelationship[]> => {
    const user = await requireUser(ctx, request)
    return ctx.repo.listRelationships(user.id)
  })

  /** Sends a friend request by exact username. A mutual request becomes a friendship at once. */
  app.post<{ Body: { username: string } }>(
    '/api/relationships/requests',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username'],
          additionalProperties: false,
          properties: { username: { type: 'string', maxLength: 64 } }
        }
      }
    },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.friendRequestsPerUser, user.id)
      let username: string
      try {
        username = normalizeUsername(request.body.username)
      } catch {
        throw requestFailed()
      }
      if (username === user.username) throw badRequest('You can’t add yourself as a friend.', 'self_request')
      const target = await ctx.repo.findUserByUsername(username)
      if (!target || target.bot || target.disabledAt || target.signupPending) throw requestFailed()
      const iBlocked = (await ctx.repo.listRelationships(user.id)).some(
        (r) => r.userId === target.id && r.type === 'blocked'
      )
      if (iBlocked) throw conflict('You blocked this person. Unblock them first.', 'you_blocked')

      const result = await ctx.repo.sendFriendRequest(user.id, target.id, Date.now())
      if (result === 'blocked') throw requestFailed()
      if (result === 'already_friends') throw conflict('You’re already friends.', 'already_friends')
      if (result !== 'already_requested') await afterChange(user.id, target.id)
      request.log.info({ op: 'friend_request', result }, 'friend request')
      reply.code(result === 'requested' ? 201 : 200)
      return { userId: target.id, type: result === 'accepted' ? 'friend' : 'outgoing' }
    }
  )

  app.post<{ Params: UserParams }>(
    '/api/relationships/:userId/accept',
    { schema: { params: userParams } },
    async (request) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.relationshipsPerUser, user.id)
      const otherId = request.params.userId
      const ok = await ctx.repo.acceptFriendRequest(user.id, otherId, Date.now())
      if (!ok) {
        if (await ctx.repo.areFriends(user.id, otherId)) return { userId: otherId, type: 'friend' }
        throw notFound('Friend request not found')
      }
      await afterChange(user.id, otherId)
      return { userId: otherId, type: 'friend' }
    }
  )

  /** Removes a friend, cancels your request or declines theirs. */
  app.delete<{ Params: UserParams }>(
    '/api/relationships/:userId',
    { schema: { params: userParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.relationshipsPerUser, user.id)
      const otherId = request.params.userId
      const existed = await ctx.repo.removeRelationship(user.id, otherId)
      if (!existed) throw notFound('Nothing to remove')
      await afterChange(user.id, otherId)
      reply.code(204)
    }
  )

  app.put<{ Params: UserParams }>(
    '/api/relationships/:userId/block',
    { schema: { params: userParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.relationshipsPerUser, user.id)
      const otherId = request.params.userId
      if (otherId === user.id) throw badRequest('You can’t block yourself.', 'self_block')
      const target = await ctx.repo.getUser(otherId)
      // You may block anyone you can see (including people who already blocked you).
      if (!target || target.bot || !(await ctx.repo.isUserVisibleTo(user.id, otherId))) {
        throw notFound('User not found')
      }
      await ctx.repo.blockUser(user.id, otherId, Date.now())
      await afterChange(user.id, otherId)
      reply.code(204)
    }
  )

  app.delete<{ Params: UserParams }>(
    '/api/relationships/:userId/block',
    { schema: { params: userParams } },
    async (request, reply) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.relationshipsPerUser, user.id)
      const otherId = request.params.userId
      if (!(await ctx.repo.unblockUser(user.id, otherId))) throw notFound('This person isn’t blocked')
      await afterChange(user.id, otherId)
      reply.code(204)
    }
  )

  /** Whether people who share a server with you (but aren't friends) may start a DM with you. */
  app.patch<{ Body: { allowServerDms: boolean } }>(
    '/api/users/me/privacy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['allowServerDms'],
          additionalProperties: false,
          properties: { allowServerDms: { type: 'boolean' } }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      take(ctx.limiters.relationshipsPerUser, user.id)
      await ctx.repo.setAllowServerDms(user.id, request.body.allowServerDms)
      const updated = (await ctx.repo.getUser(user.id)) ?? user
      await ctx.hub.publishMe(updated)
      // Existing DMs with non-friends may have become read-only (or writable again) for the others.
      for (const summary of await ctx.repo.listConversationsForUser(user.id, true)) {
        if (summary.conversation.kind !== 'dm') continue
        const other = summary.memberIds.find((id) => id !== user.id)
        if (other) await publishDmBetween(ctx, user.id, other)
      }
      return toApiMe(ctx, updated)
    }
  )
}
