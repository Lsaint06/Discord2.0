import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { requireUser } from '../lib/auth.js'
import { livekitUrlFor } from '../config.js'
import { ApiError, tooManyRequests, unauthorized } from '../lib/errors.js'
import { hostnameOf } from '../lib/network.js'
import { visibleVoiceStates } from '../realtime.js'
import { authorizeVoiceJoin, issueVoiceToken } from '../voice/access.js'
import { rememberVoiceGrant } from '../voice/enforce.js'
import { claimVoiceSeat } from '../voice/seats.js'

const voiceDisabled = () =>
  new ApiError(503, 'voice_unavailable', 'Voice is not configured on this server.')

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/voice/states', async (request) => {
    const user = await requireUser(ctx, request)
    return visibleVoiceStates(ctx, user)
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
      // The identity is always the authenticated session's user, never a client-supplied id;
      // a revoked or expired session can't get here.
      const user = await requireUser(ctx, request)
      const livekit = ctx.config.livekit
      if (!livekit) throw voiceDisabled()

      const limit = ctx.limiters.voiceTokensPerUser.take(user.id)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)

      const { channel, permissions } = await authorizeVoiceJoin(ctx.access, user, request.params.channelId)
      // User limit (Milestone 13): refuses the token when the channel is full.
      claimVoiceSeat(ctx, channel, user.id, permissions)
      // Clients that reached us on a private address (LAN) get the LAN signaling URL; everyone
      // else (through the TLS proxy) gets the public wss:// URL. The Host header only picks
      // between two configured URLs, so a forged one can't point anyone elsewhere.
      const url = livekitUrlFor(livekit, hostnameOf(request.headers.host))
      const grant = await issueVoiceToken(livekit, user, channel, permissions, Date.now(), url)
      rememberVoiceGrant(ctx, user.id, channel.id, permissions)
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
