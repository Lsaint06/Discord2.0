import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { isOriginAllowed, type Config } from './config.js'
import { createLimiters, type AppContext } from './context.js'
import type { Repository } from './db/repository.js'
import { GatewayHub, type GatewayOptions } from './gateway.js'
import { ApiError, tooManyRequests } from './lib/errors.js'
import type { ApiErrorBody } from './protocol.js'
import { registerDevAuthRoutes } from './routes/devAuth.js'
import { registerMessageRoutes } from './routes/messages.js'
import { registerServerRoutes } from './routes/servers.js'
import { registerUserRoutes } from './routes/users.js'
import { registerVoiceRoutes } from './routes/voice.js'
import { LiveKitBridge } from './voice/livekitBridge.js'
import { VoiceStateStore } from './voice/voiceStates.js'

export interface BuildOptions {
  gateway?: Partial<GatewayOptions>
  logger?: boolean
  /** How often to reconcile voice presence with LiveKit; 0 disables (tests). */
  voiceReconcileIntervalMs?: number
}

function errorBody(code: string, message: string, retryAfterMs?: number): ApiErrorBody {
  return { error: { code, message, ...(retryAfterMs ? { retryAfterMs } : {}) } }
}

export async function buildApp(
  config: Config,
  repo: Repository,
  options: BuildOptions = {}
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
    // Strict JSON types: never silently coerce e.g. a number into a message string.
    ajv: { customOptions: { coerceTypes: false } }
  })

  const voiceStore = new VoiceStateStore()
  const hub = new GatewayHub(repo, app.log, options.gateway, () => voiceStore.snapshot())
  const bridge = config.livekit
    ? new LiveKitBridge(
        config.livekit,
        voiceStore,
        repo,
        (changes) => {
          for (const change of changes) hub.broadcast({ op: 'voice_state_update', d: change })
        },
        app.log
      )
    : null
  const ctx: AppContext = {
    config,
    repo,
    hub,
    voice: { store: voiceStore, bridge },
    limiters: createLimiters()
  }

  // LiveKit posts webhooks as application/webhook+json; keep the raw body for signature checks.
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, body)
  )

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'no-store')

    // Reject browser requests from unknown origins outright (CORS alone only hides responses).
    const origin = request.headers.origin
    if (!isOriginAllowed(config, origin)) {
      return reply.code(403).send(errorBody('origin_not_allowed', 'Origin not allowed'))
    }
    if (request.url.startsWith('/api/')) {
      const limit = ctx.limiters.apiPerIp.take(request.ip)
      if (!limit.ok) throw tooManyRequests(limit.retryAfterMs)
    }
  })

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isOriginAllowed(config, origin)),
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600
  })
  await app.register(websocket, { options: { maxPayload: 4096 } })

  app.setErrorHandler((err: FastifyError | ApiError, request, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterMs) reply.header('Retry-After', Math.ceil(err.retryAfterMs / 1000))
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.retryAfterMs))
    }
    if (err.validation) {
      return reply.code(400).send(errorBody('invalid_request', err.message))
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(errorBody(err.code ?? 'bad_request', err.message))
    }
    request.log.error({ err }, 'unhandled error')
    return reply.code(500).send(errorBody('internal_error', 'Something went wrong'))
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorBody('not_found', 'Route not found'))
  })

  app.get('/health', async () => ({ ok: true, connections: hub.connectionCount }))

  app.get('/api/meta', async () => ({
    name: 'Discord 2.0',
    apiVersion: 1,
    devAuth: config.devAuth,
    voice: config.livekit !== null
  }))

  app.get(
    '/gateway',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const limit = ctx.limiters.gatewayPerIp.take(request.ip)
        if (!limit.ok) {
          return reply.code(429).send(errorBody('rate_limited', 'Too many connections'))
        }
      }
    },
    (socket) => hub.handleConnection(socket)
  )

  registerDevAuthRoutes(app, ctx)
  registerUserRoutes(app, ctx)
  registerServerRoutes(app, ctx)
  registerMessageRoutes(app, ctx)
  registerVoiceRoutes(app, ctx)

  const reconcileMs = options.voiceReconcileIntervalMs ?? 30_000
  if (bridge && reconcileMs > 0) app.addHook('onReady', async () => bridge.start(reconcileMs))

  app.addHook('onClose', async () => {
    bridge?.stop()
    hub.shutdown()
    for (const limiter of Object.values(ctx.limiters)) limiter.dispose()
  })

  return { app, ctx }
}
