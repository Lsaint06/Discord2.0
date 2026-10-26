import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { RawData, WebSocket } from 'ws'
import type { Repository, UserRecord } from './db/repository.js'
import { userFromToken } from './lib/auth.js'
import { TokenBucketLimiter } from './lib/rateLimit.js'
import {
  CloseCodes,
  type ApiUser,
  type GatewayServerFrame,
  type PresenceStatus,
  type SelectableStatus
} from './protocol.js'

interface Connection {
  id: string
  socket: WebSocket
  userId?: string
  identifying: boolean
  connectedAt: number
  lastSeen: number
}

export interface GatewayOptions {
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  identifyTimeoutMs: number
}

const DEFAULTS: GatewayOptions = {
  heartbeatIntervalMs: 20_000,
  heartbeatTimeoutMs: 60_000,
  identifyTimeoutMs: 10_000
}

const SELECTABLE: ReadonlySet<string> = new Set(['online', 'idle', 'dnd', 'invisible'])

export class GatewayHub {
  private readonly connections = new Set<Connection>()
  private readonly statuses = new Map<string, SelectableStatus>()
  private readonly frameLimiter = new TokenBucketLimiter(20, 2)
  private readonly sweeper: NodeJS.Timeout
  private readonly options: GatewayOptions

  constructor(
    private readonly repo: Repository,
    private readonly log: FastifyBaseLogger,
    options: Partial<GatewayOptions> = {}
  ) {
    this.options = { ...DEFAULTS, ...options }
    this.sweeper = setInterval(() => this.sweep(), 5_000)
    this.sweeper.unref()
  }

  get connectionCount(): number {
    return this.connections.size
  }

  presenceOf(user: UserRecord): PresenceStatus {
    if (user.bot) return 'online'
    const connected = [...this.connections].some((c) => c.userId === user.id)
    if (!connected) return 'offline'
    const status = this.statuses.get(user.id) ?? 'online'
    return status === 'invisible' ? 'offline' : status
  }

  toApiUser(user: UserRecord): ApiUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      bot: user.bot,
      status: this.presenceOf(user)
    }
  }

  handleConnection(socket: WebSocket): void {
    const now = Date.now()
    const conn: Connection = {
      id: randomUUID(),
      socket,
      identifying: false,
      connectedAt: now,
      lastSeen: now
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

  broadcast(frame: GatewayServerFrame): void {
    const payload = JSON.stringify(frame)
    for (const conn of this.connections) {
      if (conn.userId && conn.socket.readyState === conn.socket.OPEN) conn.socket.send(payload)
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
        const user = await userFromToken(this.repo, d?.token)
        if (!user) return this.close(conn, CloseCodes.authFailed, 'Authentication failed')
        if (conn.socket.readyState !== conn.socket.OPEN) return

        const wasOnline = this.presenceOf(user) !== 'offline'
        conn.userId = user.id
        conn.identifying = false
        const users = (await this.repo.listUsers()).map((u) => this.toApiUser(u))
        this.send(conn, { op: 'ready', d: { user: this.toApiUser(user), users } })
        if (!wasOnline) this.broadcast({ op: 'user_update', d: this.toApiUser(user) })
        this.log.info({ conn: conn.id, user: user.username }, 'gateway identified')
        return
      }

      case 'set_status': {
        if (!conn.userId) return this.close(conn, CloseCodes.authFailed, 'Not identified')
        const status = d?.status
        if (typeof status !== 'string' || !SELECTABLE.has(status)) {
          return this.close(conn, CloseCodes.invalidFrame, 'Invalid status')
        }
        this.statuses.set(conn.userId, status as SelectableStatus)
        const user = await this.repo.getUser(conn.userId)
        if (user) this.broadcast({ op: 'user_update', d: this.toApiUser(user) })
        return
      }

      default:
        return this.close(conn, CloseCodes.invalidFrame, `Unknown op: ${op.slice(0, 32)}`)
    }
  }

  private async onClose(conn: Connection): Promise<void> {
    this.connections.delete(conn)
    if (!conn.userId) return
    const stillConnected = [...this.connections].some((c) => c.userId === conn.userId)
    if (stillConnected) return
    this.statuses.delete(conn.userId)
    const user = await this.repo.getUser(conn.userId).catch(() => undefined)
    if (user) this.broadcast({ op: 'user_update', d: this.toApiUser(user) })
  }

  private sweep(now = Date.now()): void {
    for (const conn of this.connections) {
      if (!conn.userId && now - conn.connectedAt > this.options.identifyTimeoutMs) {
        this.close(conn, CloseCodes.identifyTimeout, 'Identify timeout')
      } else if (now - conn.lastSeen > this.options.heartbeatTimeoutMs) {
        this.close(conn, CloseCodes.heartbeatTimeout, 'Heartbeat timeout')
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
