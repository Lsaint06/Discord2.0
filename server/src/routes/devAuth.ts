import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { generateToken, hashToken } from '../lib/auth.js'
import { badRequest, tooManyRequests } from '../lib/errors.js'
import { colorForName, normalizeDisplayName, normalizeUsername } from '../lib/validation.js'

/**
 * DEVELOPMENT-ONLY identities: anyone who can reach the server can log in as any
 * username without a password. Registered only when DEV_AUTH is enabled.
 */
export function registerDevAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.devAuth) return

  app.post<{ Body: { username: string } }>(
    '/api/dev/login',
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
    async (request) => {
      const limit = ctx.limiters.loginPerIp.take(request.ip)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const username = normalizeUsername(request.body.username)
      let user = await ctx.repo.findUserByUsername(username)
      if (!user) {
        try {
          user = await ctx.repo.createUser({
            id: randomUUID(),
            username,
            displayName: normalizeDisplayName(request.body.username),
            avatarColor: colorForName(username),
            bot: false,
            createdAt: Date.now()
          })
          ctx.hub.broadcast({ op: 'user_update', d: ctx.hub.toApiUser(user) })
        } catch {
          // Lost a race with a concurrent login for the same new username.
          user = await ctx.repo.findUserByUsername(username)
        }
      }
      if (!user) throw badRequest('Could not create user')
      if (user.bot) throw badRequest('That username is reserved', 'reserved_username')

      const token = generateToken()
      await ctx.repo.createSession(hashToken(token), user.id, Date.now())
      request.log.info({ user: user.username }, 'dev login')
      return { token, user: ctx.hub.toApiUser(user), devOnly: true }
    }
  )
}
