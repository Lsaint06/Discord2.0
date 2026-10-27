import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { createSession, toApiSession } from '../auth/sessions.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, tooManyRequests } from '../lib/errors.js'
import { colorForName, normalizeDisplayName, normalizeUsername } from '../lib/validation.js'
import { publishServerChanged, toApiMe } from '../realtime.js'

/**
 * DEVELOPMENT-ONLY identities: anyone who can reach the server can sign in as any username
 * that has no password, without a password. Registered only when DEV_AUTH is enabled, and its
 * sessions stop working as soon as DEV_AUTH is turned off.
 *
 * Accounts with a password (real accounts, claimed identities) can never be used here, so a
 * development sign-in can't impersonate anyone who has moved to a real account.
 */
export function registerDevAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.config.devAuth) return

  app.post<{ Body: { username: string; device?: string } }>(
    '/api/dev/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', maxLength: 64 },
            device: { type: 'string', maxLength: 128 }
          }
        }
      }
    },
    async (request) => {
      const limit = ctx.limiters.loginPerIp.take(request.ip)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const username = normalizeUsername(request.body.username)
      let user = await ctx.repo.findUserByUsername(username)
      let created = false
      if (!user) {
        try {
          const now = Date.now()
          user = await ctx.repo.createUser({
            id: randomUUID(),
            username,
            displayName: normalizeDisplayName(request.body.username),
            avatarColor: colorForName(username),
            bot: false,
            createdAt: now,
            instanceAdmin: false,
            disabledAt: null
          })
          created = true
          // Development convenience: a new development identity joins every server.
          for (const server of await ctx.repo.listServers()) {
            await ctx.repo.addMember({ serverId: server.id, userId: user.id, role: 'member', joinedAt: now })
          }
        } catch {
          // Lost a race with a concurrent login for the same new username.
          user = await ctx.repo.findUserByUsername(username)
        }
      }
      if (!user) throw badRequest('Could not create user')
      if (user.bot) throw badRequest('That username is reserved', 'reserved_username')
      if ((await ctx.repo.hasPassword([user.id])).has(user.id)) {
        throw forbidden('This account has a password. Sign in with your password instead.', 'password_account')
      }
      if (user.disabledAt) throw forbidden('This account has been disabled.', 'account_disabled')

      const { token, session } = await createSession(ctx, user, 'dev', request, request.body.device)
      await ctx.audit.record({ action: 'auth.dev_login', actorId: user.id, request })
      if (created) {
        for (const server of await ctx.repo.listServers()) await publishServerChanged(ctx, server.id)
        await ctx.hub.publishUser(user)
      }
      return {
        token,
        user: await toApiMe(ctx, user),
        session: toApiSession(session, session.id),
        devOnly: true
      }
    }
  )
}
