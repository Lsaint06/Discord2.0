import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { toApiMe } from '../realtime.js'

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/users/me', async (request) => {
    const user = await requireUser(ctx, request)
    return toApiMe(ctx, user)
  })

  /**
   * People you can see: those sharing a server with you, authors in your servers, friends,
   * pending requests, conversation partners and bots. Blocked pairs are shown without presence.
   */
  app.get('/api/users', async (request) => {
    const user = await requireUser(ctx, request)
    const [users, blocked] = await Promise.all([ctx.repo.listVisibleUsers(user.id), ctx.repo.blockedEither(user.id)])
    return users.map((u) => ctx.hub.apiUserFor(u, blocked))
  })
}
