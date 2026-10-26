import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { badRequest, tooManyRequests } from '../lib/errors.js'
import { normalizeColor, normalizeDisplayName } from '../lib/validation.js'

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/users/me', async (request) => {
    const user = await requireUser(ctx.repo, request)
    return ctx.hub.toApiUser(user)
  })

  app.get('/api/users', async (request) => {
    await requireUser(ctx.repo, request)
    const users = await ctx.repo.listUsers()
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
      const user = await requireUser(ctx.repo, request)
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
      const dto = ctx.hub.toApiUser(updated)
      ctx.hub.broadcast({ op: 'user_update', d: dto })
      return dto
    }
  )
}
