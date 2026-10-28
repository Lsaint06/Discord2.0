import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { RawData, WebSocket } from 'ws'
import type { AuthContext } from './auth/sessions.js'
import type { UserRecord } from './db/repository.js'
import { TokenBucketLimiter } from './lib/rateLimit.js'
import {
  CloseCodes,
  type ApiCustomStatus,
  type ApiMe,
  type ApiUser,
  type ApiVoiceState,
  type GatewayServerFrame,
  type PresenceStatus,
  type SelectableStatus
} from './protocol.js'

/** The user's own custom status if set and not expired. */
export function ownCustomStatus(user: UserRecord, now = Date.now()): ApiCustomStatus | null {
  if (!user.customStatusText && !user.customStatusEmoji) return null
  const expiresAt = user.customStatusExpiresAt ?? null
  if (expiresAt !== null && expiresAt <= now) return null
  return { text: user.customStatusText ?? null, emoji: user.customStatusEmoji ?? null, expiresAt }
}

interface Connection {
  id: string
  socket: WebSocket
  userId?: string
  sessionId?: string
  /** Absolute session expiry; the socket is closed when it passes. */
  sessionExpiresAt?: number
  identifying: boolean
  connectedAt: number
  lastSeen: number
  lastTouch: number
  /** This device reported no user input for a while (automatic idle). */
  idle: boolean
}

export interface GatewayOptions {
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  identifyTimeoutMs: number
}

/** What the hub needs from the rest of the app (kept narrow so it is easy to test). */
export interface GatewayDeps {
  authenticate: (token: unknown) => Promise<AuthContext | undefined>
  /** Re-validates a session (revoked? disabled?) for long-lived sockets. */
  sessionStillValid: (sessionId: string, userId: string) => Promise<boolean>
  touchSession: (sessionId: string) => Promise<void>
  me: (user: UserRecord) => Promise<ApiMe>
  visibleUsers: (user: UserRecord) => Promise<UserRecord[]>
  /** Users who share a server with `userId` (recipients of their presence updates). */
  presenceAudience: (userId: string) => Promise<Set<string>>
  /** Voice states the user may see. */
  voiceStates: (user: UserRecord) => Promise<ApiVoiceState[]>
  getUser: (id: string) => Promise<UserRecord | undefined>
  /** Persists the user's chosen status (synced across their devices); returns the updated user. */
  setStatusPreference: (userId: string, status: SelectableStatus) => Promise<UserRecord | undefined>
  /** Users with a block in either direction (shown without presence). Optional for tests. */
  blockedEither?: (userId: string) => Promise<Set<string>>
}

const DEFAULTS: GatewayOptions = {
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 60_000,
  identifyTimeoutMs: 10_000
}

const visibleKey = (u: ApiUser): string => JSON.stringify([u.status, u.customStatus])
const OFFLINE_KEY = JSON.stringify(['offline', null])

const SELECTABLE: ReadonlySet<string> = new Set(['online', 'idle', 'dnd', 'invisible'])
/** Long-lived sockets count as session activity and are re-validated this often. */
const SESSION_CHECK_MS = 5 * 60_000

export class GatewayHub {
  private readonly connections = new Set<Connection>()
  /** What others last saw (presence + custom status) per user, so nothing is re-broadcast needlessly. */
  private readonly lastVisible = new Map<string, string>()
  private readonly frameLimiter = new TokenBucketLimiter(20, 2)
  private readonly sweeper: NodeJS.Timeout
  private readonly options: GatewayOptions

  constructor(
    private readonly deps: GatewayDeps,
    private readonly log: FastifyBaseLogger,
    options: Partial<GatewayOptions> = {}
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.sweeper = setInterval(() => void this.sweep(), 5_000)
    this.sweeper.unref()
  }

  get connectionCount(): number {
    return this.connections.size
  }

  private connectionsOf(userId: string): Connection[] {
    return [...this.connections].filter((c) => c.userId === userId)
  }

  /**
   * Presence as other people see it, combining the saved preference with every connected
   * device: offline without connections or when invisible; dnd/idle as chosen; otherwise idle
   * only when *all* of the user's devices are idle.
   */
  presenceOf(user: UserRecord): PresenceStatus {
    if (user.bot) return 'online'
    const conns = this.connectionsOf(user.id)
    if (conns.length === 0) return 'offline'
    const preference = user.statusPreference ?? 'online'
    if (preference === 'invisible') return 'offline'
    if (preference === 'dnd' || preference === 'idle') return preference
    return conns.every((c) => c.idle) ? 'idle' : 'online'
  }

  /** The custom status others may see (none while it is expired or the user appears offline). */
  customStatusOf(user: UserRecord, now = Date.now()): ApiCustomStatus | null {
    if (this.presenceOf(user) === 'offline') return null
    return ownCustomStatus(user, now)
  }

  toApiUser(user: UserRecord): ApiUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      bot: user.bot,
      status: this.presenceOf(user),
      avatarId: user.avatarId ?? null,
      bannerId: user.bannerId ?? null,
      accentColor: user.accentColor ?? null,
      bio: user.bio ?? null,
      pronouns: user.pronouns ?? null,
      createdAt: user.createdAt,
      customStatus: this.customStatusOf(user)
    }
  }

  /** How someone with a block between you and them appears: no presence, no custom status. */
  maskedApiUser(user: UserRecord): ApiUser {
    return { ...this.toApiUser(user), status: 'offline', customStatus: null }
  }

  /** The user as seen by someone whose blocked set is `blocked`: masked if there is a block. */
  apiUserFor(user: UserRecord, blocked: ReadonlySet<string>): ApiUser {
    return blocked.has(user.id) ? this.maskedApiUser(user) : this.toApiUser(user)
  }

  isOnline(userId: string): boolean {
    return this.connectionsOf(userId).length > 0
  }

  handleConnection(socket: WebSocket): void {
    const now = Date.now()
    const conn: Connection = {
      id: randomUUID(),
      socket,
      identifying: false,
      connectedAt: now,
      lastSeen: now,
      lastTouch: now,
      idle: false
    }
    this.connections.add(conn)
    this.send(conn, { op: 'hello', d: { heartbeatIntervalMs: this.options.heartbeatIntervalMs } })

    socket.on('message', (data: RawData, isBinary: boolean) => {
      this.onFrame(conn, data, isBinary).catch((err: unknown) => {
        this.log.error({ err, conn: conn.id }, 'gateway frame handler failed')
        this.close(conn, 1011, 'Internal error')
      })
    })
    socket.on('close', () => {
      void this.onClose(conn)
    })
    socket.on('error', (err) => this.log.warn({ err, conn: conn.id }, 'gateway socket error'))
  }

  /** Delivers a frame to every identified session of the given users. */
  sendToUsers(userIds: Iterable<string>, frame: GatewayServerFrame): void {
    const targets = userIds instanceof Set ? userIds : new Set(userIds)
    if (targets.size === 0) return
    const payload = JSON.stringify(frame)
    for (const conn of this.connections) {
      if (conn.userId && targets.has(conn.userId) && conn.socket.readyState === conn.socket.OPEN) {
        conn.socket.send(payload)
      }
    }
  }

  sendToUser(userId: string, frame: GatewayServerFrame): void {
    this.sendToUsers([userId], frame)
  }

  /** Presence/profile change: only people who share a server with the user hear about it. */
  async publishUser(user: UserRecord): Promise<void> {
    const audience = await this.deps.presenceAudience(user.id)
    const apiUser = this.toApiUser(user)
    this.lastVisible.set(user.id, visibleKey(apiUser))
    this.sendToUsers(audience, { op: 'user_update', d: apiUser })
  }

  /**
   * Publishes only when what others can see (presence, custom status) actually changed:
   * connect, idle, close, status or custom status changes. Unknown counts as offline, so an
   * invisible user connecting or editing their status produces no event at all.
   */
  async publishPresenceIfChanged(user: UserRecord): Promise<void> {
    const key = visibleKey(this.toApiUser(user))
    if ((this.lastVisible.get(user.id) ?? OFFLINE_KEY) === key) return
    await this.publishUser(user)
  }

  /** Sends the user's own account view (status preference, profile) to all their sessions. */
  async publishMe(user: UserRecord): Promise<void> {
    this.sendToUser(user.id, { op: 'me_update', d: await this.deps.me(user) })
  }

  /** Closes the sockets of revoked sessions (they must sign in again). */
  closeSessions(sessionIds: Iterable<string>, reason = 'Session ended'): void {
    const ids = new Set(sessionIds)
    for (const conn of this.connections) {
      if (conn.sessionId && ids.has(conn.sessionId)) this.close(conn, CloseCodes.authFailed, reason)
    }
  }

  closeUser(userId: string, reason = 'Session ended'): void {
    for (const conn of this.connections) {
      if (conn.userId === userId) this.close(conn, CloseCodes.authFailed, reason)
    }
  }

  shutdown(): void {
    clearInterval(this.sweeper)
    this.frameLimiter.dispose()
    for (const conn of this.connections) this.close(conn, CloseCodes.serverShutdown, 'Server shutting down')
  }

  private async onFrame(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    conn.lastSeen = Date.now()

    if (!this.frameLimiter.take(conn.id).ok) {
      return this.close(conn, CloseCodes.rateLimited, 'Rate limited')
    }
    if (isBinary) return this.close(conn, CloseCodes.invalidFrame, 'Binary frames not supported')

    let frame: unknown
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return this.close(conn, CloseCodes.invalidFrame, 'Invalid JSON')
    }
    if (typeof frame !== 'object' || frame === null || typeof (frame as { op?: unknown }).op !== 'string') {
      return this.close(conn, CloseCodes.invalidFrame, 'Invalid frame')
    }
    const { op, d } = frame as { op: string; d?: Record<string, unknown> }

    switch (op) {
      case 'heartbeat':
        return this.send(conn, { op: 'heartbeat_ack' })

      case 'identify': {
        if (conn.userId || conn.identifying) return
        conn.identifying = true
        const auth = await this.deps.authenticate(d?.token)
        if (!auth) return this.close(conn, CloseCodes.authFailed, 'Authentication failed')
        if (conn.socket.readyState !== conn.socket.OPEN) return
        const { user, session } = auth

        conn.userId = user.id
        conn.sessionId = session.id
        conn.sessionExpiresAt = session.expiresAt
        conn.idle = d?.idle === true
        conn.identifying = false
        const [me, users, voiceStates, blocked] = await Promise.all([
          this.deps.me(user),
          this.deps.visibleUsers(user),
          this.deps.voiceStates(user),
          this.deps.blockedEither ? this.deps.blockedEither(user.id) : Promise.resolve(new Set<string>())
        ])
        this.send(conn, {
          op: 'ready',
          d: { user: me, users: users.map((u) => this.apiUserFor(u, blocked)), voiceStates }
        })
        await this.publishPresenceIfChanged(user)
        this.log.info({ conn: conn.id, user: user.username, session: session.id }, 'gateway identified')
        return
      }

      case 'set_status': {
        if (!conn.userId) return this.close(conn, CloseCodes.authFailed, 'Not identified')
        const status = d?.status
        if (typeof status !== 'string' || !SELECTABLE.has(status)) {
          return this.close(conn, CloseCodes.invalidFrame, 'Invalid status')
        }
        const user = await this.deps.setStatusPreference(conn.userId, status as SelectableStatus)
        if (user) {
          await this.publishPresenceIfChanged(user)
          await this.publishMe(user)
        }
        return
      }

      case 'set_idle': {
        if (!conn.userId) return this.close(conn, CloseCodes.authFailed, 'Not identified')
        if (typeof d?.idle !== 'boolean') return this.close(conn, CloseCodes.invalidFrame, 'Invalid idle')
        if (conn.idle === d.idle) return
        conn.idle = d.idle
        const user = await this.deps.getUser(conn.userId)
        if (user) await this.publishPresenceIfChanged(user)
        return
      }

      default:
        return this.close(conn, CloseCodes.invalidFrame, `Unknown op: ${op.slice(0, 32)}`)
    }
  }

  private async onClose(conn: Connection): Promise<void> {
    this.connections.delete(conn)
    if (!conn.userId) return
    const user = await this.deps.getUser(conn.userId).catch(() => undefined)
    if (user) await this.publishPresenceIfChanged(user).catch(() => undefined)
    if (!this.isOnline(conn.userId)) this.lastVisible.delete(conn.userId)
  }

  private async sweep(now = Date.now()): Promise<void> {
    for (const conn of this.connections) {
      if (!conn.userId && now - conn.connectedAt > this.options.identifyTimeoutMs) {
        this.close(conn, CloseCodes.identifyTimeout, 'Identify timeout')
      } else if (now - conn.lastSeen > this.options.heartbeatTimeoutMs) {
        this.close(conn, CloseCodes.heartbeatTimeout, 'Heartbeat timeout')
      } else if (conn.sessionExpiresAt !== undefined && conn.sessionExpiresAt <= now) {
        this.close(conn, CloseCodes.authFailed, 'Session expired')
      } else if (conn.sessionId && conn.userId && now - conn.lastTouch > SESSION_CHECK_MS) {
        conn.lastTouch = now
        const sessionId = conn.sessionId
        const valid = await this.deps.sessionStillValid(sessionId, conn.userId).catch(() => true)
        if (!valid) this.close(conn, CloseCodes.authFailed, 'Session ended')
        else await this.deps.touchSession(sessionId).catch(() => undefined)
      }
    }
  }

  private send(conn: Connection, frame: GatewayServerFrame): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(frame))
  }

  private close(conn: Connection, code: number, reason: string): void {
    if (conn.socket.readyState === conn.socket.OPEN || conn.socket.readyState === conn.socket.CONNECTING) {
      conn.socket.close(code, reason)
    }
  }
}
