import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, tooManyRequests } from '../lib/errors.js'
import { normalizeColor, normalizeDisplayName } from '../lib/validation.js'
import { toApiMe } from '../realtime.js'

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/users/me', async (request) => {
    const user = await requireUser(ctx, request)
    return toApiMe(ctx, user)
  })

  /** People you can see: those sharing a server with you, authors in your servers, bots. */
  app.get('/api/users', async (request) => {
    const user = await requireUser(ctx, request)
    const users = await ctx.repo.listVisibleUsers(user.id)
    return users.map((u) => ctx.hub.toApiUser(u))
  })

  app.patch<{ Body: { displayName?: string; avatarColor?: string } }>(
    '/api/users/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            displayName: { type: 'string', maxLength: 64 },
            avatarColor: { type: 'string', maxLength: 7 }
          }
        }
      }
    },
    async (request) => {
      const user = await requireUser(ctx, request)
      const limit = ctx.limiters.profilePerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const { displayName, avatarColor } = request.body
      if (displayName === undefined && avatarColor === undefined) {
        throw badRequest('Nothing to update')
      }
      const updated = await ctx.repo.updateUser(user.id, {
        displayName: displayName === undefined ? undefined : normalizeDisplayName(displayName),
        avatarColor: avatarColor === undefined ? undefined : normalizeColor(avatarColor)
      })
      if (!updated) throw badRequest('User no longer exists')
      await ctx.hub.publishUser(updated)
      return toApiMe(ctx, updated)
    }
  )
}
