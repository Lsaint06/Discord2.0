import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { AccessService } from './access.js'
import { AttachmentStore } from './attachments/store.js'
import { AuditLog } from './audit.js'
import { HashGate, PasswordHasher } from './auth/password.js'
import { authenticateToken, sessionUsable } from './auth/sessions.js'
import { isOriginAllowed, type Config } from './config.js'
import { createLimiters, type AppContext } from './context.js'
import type { Repository } from './db/repository.js'
import { GatewayHub, type GatewayOptions } from './gateway.js'
import { ApiError, tooManyRequests } from './lib/errors.js'
import type { ApiErrorBody } from './protocol.js'
import { join } from 'node:path'
import { ProfileMediaStore } from './profile/media.js'
import { expireCustomStatuses, publishVoiceChanges, toApiMe, visibleVoiceStates } from './realtime.js'
import { registerAdminRoutes } from './routes/admin.js'
import { cleanupAttachments, registerAttachmentRoutes } from './routes/attachments.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerDevAuthRoutes } from './routes/devAuth.js'
import { registerInviteRoutes } from './routes/invites.js'
import { registerMemberRoutes } from './routes/members.js'
import { registerMessageRoutes } from './routes/messages.js'
import { registerReadStateRoutes, registerSearchRoutes } from './routes/readStates.js'
import { registerRelationshipRoutes } from './routes/relationships.js'
import { registerServerRoutes } from './routes/servers.js'
import { cleanupProfileMedia, registerProfileRoutes } from './routes/profile.js'
import { registerUserRoutes } from './routes/users.js'
import { registerVoiceRoutes } from './routes/voice.js'
import { voiceAuthorizer } from './voice/enforce.js'
import { LiveKitBridge } from './voice/livekitBridge.js'
import { VoiceStateStore } from './voice/voiceStates.js'

export interface BuildOptions {
  gateway?: Partial<GatewayOptions>
  logger?: boolean
  /** How often to reconcile voice presence with LiveKit; 0 disables (tests). */
  voiceReconcileIntervalMs?: number
  /** How often to clean up abandoned uploads, orphan files and old sessions; 0 disables (tests). */
  attachmentCleanupIntervalMs?: number
  /** How often to clear expired custom statuses; 0 disables (tests call expireCustomStatuses). */
  statusExpiryIntervalMs?: number
  /** Override the password hasher (tests use cheaper, still OWASP-compliant parameters). */
  hasher?: PasswordHasher
}

function errorBody(code: string, message: string, retryAfterMs?: number): ApiErrorBody {
  return { error: { code, message, ...(retryAfterMs ? { retryAfterMs } : {}) } }
}

const DAY = 24 * 60 * 60_000

export async function buildApp(
  config: Config,
  repo: Repository,
  options: BuildOptions = {}
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            // Defence in depth: request logs never include headers or bodies, but if a secret
            // ever ends up in a logged object it is masked.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                '*.password',
                '*.currentPassword',
                '*.newPassword',
                '*.token',
                '*.code'
              ],
              censor: '[redacted]'
            }
          },
    bodyLimit: 16 * 1024,
    trustProxy: config.trustProxy,
    // Don't let an in-progress download or upload hold up shutdown/restart.
    forceCloseConnections: true,
    // Strict JSON types: never silently coerce e.g. a number into a message string, and reject
    // (rather than silently strip) unknown fields such as a forged user id.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }
  })

  const voiceStore = new VoiceStateStore()
  const access = new AccessService(repo)
  // ctx is filled in below; the gateway and LiveKit bridge call into it lazily.
  const ctx = {
    config,
    repo,
    access,
    attachments: new AttachmentStore(config.attachments.dir),
    // Same volume as attachments; AttachmentStore only ever touches its files/ and tmp/ folders.
    profileMedia: new ProfileMediaStore(join(config.attachments.dir, 'profile')),
    audit: new AuditLog(repo, app.log),
    hasher:
      options.hasher ??
      new PasswordHasher(config.auth.argon2, new HashGate(config.auth.hashConcurrency, 32)),
    voice: { store: voiceStore, bridge: null },
    limiters: createLimiters()
  } as unknown as AppContext

  ctx.hub = new GatewayHub(
    {
      authenticate: (token) => authenticateToken(ctx, token),
      sessionStillValid: async (sessionId, userId) => {
        const sessions = await repo.listSessions(userId, Date.now())
        const session = sessions.find((s) => s.id === sessionId)
        const user = await repo.getUser(userId)
        return Boolean(session && user && sessionUsable(ctx, { session, user }, Date.now()))
      },
      touchSession: (sessionId) => repo.touchSession(sessionId, Date.now(), null),
      me: (user) => toApiMe(ctx, user),
      visibleUsers: (user) => repo.listVisibleUsers(user.id),
      presenceAudience: (userId) => access.presenceAudienceOf(userId),
      voiceStates: (user) => visibleVoiceStates(ctx, user),
      getUser: (id) => repo.getUser(id),
      setStatusPreference: (userId, status) => repo.setStatusPreference(userId, status),
      blockedEither: (userId) => repo.blockedEither(userId)
    },
    app.log,
    options.gateway
  )
  ctx.voice.bridge = config.livekit
    ? new LiveKitBridge(
        config.livekit,
        voiceStore,
        voiceAuthorizer(ctx),
        (changes) => {
          publishVoiceChanges(ctx, changes).catch((err: unknown) =>
            app.log.error({ err }, 'publishing voice changes failed')
          )
        },
        app.log
      )
    : null
  const hub = ctx.hub
  const bridge = ctx.voice.bridge

  // LiveKit posts webhooks as application/webhook+json; keep the raw body for signature checks.
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, body)
  )

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'no-store')
    reply.header('Referrer-Policy', 'no-referrer')

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

  // A WebSocket upgrade that is answered with a normal HTTP response (refused origin, rate limit,
  // unknown path, error) leaves the raw socket open: Node hands upgrade sockets over entirely and
  // never closes them itself. Close it once the response is written, so refused upgrades can't
  // pile up open connections.
  app.addHook('onResponse', async (request, reply) => {
    if (!request.headers.upgrade || reply.statusCode === 101) return
    const socket = request.raw.socket
    if (!socket || socket.destroyed) return
    socket.end()
    setTimeout(() => socket.destroy(), 1000).unref()
  })

  await app.register(cors, {
    origin: (origin, cb) => cb(null, isOriginAllowed(config, origin)),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Bearer tokens only; no cookies are ever used, so there is no CSRF surface.
    credentials: false,
    maxAge: 600
  })
  await app.register(websocket, { options: { maxPayload: 4096 } })
  // Streaming multipart: files go straight to disk; these are hard parser limits on top of the
  // per-type checks in routes/attachments.ts.
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(config.attachments.maxImageBytes, config.attachments.maxFileBytes),
      files: config.attachments.maxFilesPerMessage,
      fields: 4,
      fieldSize: 1024,
      parts: config.attachments.maxFilesPerMessage + 4,
      headerPairs: 50
    }
  })

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
    apiVersion: 4,
    devAuth: config.devAuth,
    voice: config.livekit !== null,
    // Real accounts; new ones only with an invitation from an administrator.
    accounts: true,
    registration: 'invite',
    // Milestone 8: profiles, profile images, synced status and preferences.
    profiles: true,
    // Milestone 10: friends, blocking, direct and group conversations.
    connections: true
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

  registerAuthRoutes(app, ctx)
  registerDevAuthRoutes(app, ctx)
  registerAdminRoutes(app, ctx)
  registerUserRoutes(app, ctx)
  registerProfileRoutes(app, ctx)
  registerServerRoutes(app, ctx)
  registerMemberRoutes(app, ctx)
  registerInviteRoutes(app, ctx)
  registerMessageRoutes(app, ctx)
  registerAttachmentRoutes(app, ctx)
  registerReadStateRoutes(app, ctx)
  registerSearchRoutes(app, ctx)
  registerVoiceRoutes(app, ctx)
  registerRelationshipRoutes(app, ctx)
  registerConversationRoutes(app, ctx)

  const cleanupMs = options.attachmentCleanupIntervalMs ?? 60 * 60_000
  let cleanupTimer: NodeJS.Timeout | null = null
  if (cleanupMs > 0) {
    app.addHook('onReady', async () => {
      const run = (): void => {
        cleanupAttachments(ctx, app.log)
          .then(() => cleanupProfileMedia(ctx, app.log))
          .catch((err: unknown) => app.log.error({ err }, 'attachment cleanup failed'))
        repo
          .purgeExpired(Date.now(), { sessionsMs: 30 * DAY, auditMs: 365 * DAY })
          .then((removed) => {
            if (Object.values(removed).some((n) => n > 0)) app.log.info({ removed }, 'expired auth data purged')
          })
          .catch((err: unknown) => app.log.error({ err }, 'session cleanup failed'))
      }
      run()
      cleanupTimer = setInterval(run, cleanupMs)
      cleanupTimer.unref()
    })
  }

  // Custom statuses with an expiry (30 min, 1 h, today…) clear themselves and notify people.
  const expiryMs = options.statusExpiryIntervalMs ?? 15_000
  let expiryTimer: NodeJS.Timeout | null = null
  if (expiryMs > 0) {
    app.addHook('onReady', async () => {
      expiryTimer = setInterval(() => {
        expireCustomStatuses(ctx).catch((err: unknown) =>
          app.log.error({ err }, 'custom status expiry failed')
        )
      }, expiryMs)
      expiryTimer.unref()
    })
  }

  const reconcileMs = options.voiceReconcileIntervalMs ?? 30_000
  if (bridge && reconcileMs > 0) app.addHook('onReady', async () => bridge.start(reconcileMs))

  app.addHook('onClose', async () => {
    bridge?.stop()
    if (cleanupTimer) clearInterval(cleanupTimer)
    if (expiryTimer) clearInterval(expiryTimer)
    hub.shutdown()
    for (const limiter of Object.values(ctx.limiters)) limiter.dispose()
  })

  return { app, ctx }
}
