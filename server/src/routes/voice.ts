import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { ApiError, tooManyRequests, unauthorized } from '../lib/errors.js'
import { authorizeVoiceJoin, issueVoiceToken } from '../voice/access.js'

const voiceDisabled = () =>
  new ApiError(503, 'voice_unavailable', 'Voice is not configured on this server.')

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/voice/states', async (request) => {
    await requireUser(ctx.repo, request)
    return ctx.voice.store.snapshot()
  })

  app.post<{ Params: { channelId: string } }>(
    '/api/voice/channels/:channelId/token',
    {
      schema: {
        params: {
          type: 'object',
          properties: { channelId: { type: 'string', maxLength: 64 } }
        }
      }
    },
    async (request) => {
      // The identity is always the authenticated session's user, never a client-supplied id.
      const user = await requireUser(ctx.repo, request)
      const livekit = ctx.config.livekit
      if (!livekit) throw voiceDisabled()

      const limit = ctx.limiters.voiceTokensPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const channel = await authorizeVoiceJoin(ctx.repo, user, request.params.channelId)
      const grant = await issueVoiceToken(livekit, user, channel)
      request.log.info({ user: user.username, room: grant.room }, 'voice token issued')
      return grant
    }
  )

  // LiveKit → backend. Authenticated by LiveKit's signed Authorization header (HMAC over the body).
  app.post('/api/livekit/webhook', async (request, reply) => {
    const bridge = ctx.voice.bridge
    if (!bridge) throw voiceDisabled()
    if (typeof request.body !== 'string') throw new ApiError(415, 'unsupported_media_type', 'Expected a LiveKit webhook')
    try {
      await bridge.handleWebhook(request.body, request.headers.authorization)
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'rejected LiveKit webhook')
      throw unauthorized('Invalid webhook signature')
    }
    reply.code(200)
    return { ok: true }
  })
}
