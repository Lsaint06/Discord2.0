import {
  CloseCodes,
  type ApiMessage,
  type ApiServer,
  type ApiUser,
  type ApiVoiceState,
  type GatewayClientFrame,
  type GatewayServerFrame,
  type SelectableStatus
} from './protocol'

export type GatewayStatus = 'connecting' | 'connected' | 'reconnecting' | 'auth_failed' | 'closed'

export interface GatewayHandlers {
  onStatus: (status: GatewayStatus, retryInMs?: number) => void
  onReady: (
    data: { user: ApiUser; users: ApiUser[]; voiceStates: ApiVoiceState[] },
    isReconnect: boolean
  ) => void
  onMessage: (message: ApiMessage) => void
  onUserUpdate: (user: ApiUser) => void
  onServerCreate: (server: ApiServer) => void
  onVoiceStateUpdate: (state: { userId: string; channelId: string | null }) => void
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/**
 * Resilient gateway connection:
 * - identifies with the session token in the first frame (never in the URL, so it can't leak into logs)
 * - heartbeats on the server-provided interval; a missed ack means a zombie connection → reconnect
 * - exponential backoff with jitter, reset after a successful READY
 * - reconnects immediately when the OS reports the network is back
 */
export class GatewayClient {
  private socket: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private awaitingAck = false
  private attempt = 0
  private hasBeenReady = false
  private stopped = false
  private desiredStatus: SelectableStatus = 'online'

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: GatewayHandlers
  ) {}

  connect(): void {
    this.stopped = false
    window.addEventListener('online', this.onNetworkOnline)
    this.open()
  }

  disconnect(): void {
    this.stopped = true
    window.removeEventListener('online', this.onNetworkOnline)
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      // Closing mid-handshake logs a browser warning; close as soon as it opens instead.
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.onopen = () => socket.close(1000, 'Client closing')
      } else {
        socket.close(1000, 'Client closing')
      }
    }
    this.handlers.onStatus('closed')
  }

  setStatus(status: SelectableStatus): void {
    this.desiredStatus = status
    this.send({ op: 'set_status', d: { status } })
  }

  private readonly onNetworkOnline = (): void => {
    if (this.stopped || this.socket) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.open()
  }

  private open(): void {
    this.handlers.onStatus(this.hasBeenReady ? 'reconnecting' : 'connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      let frame: GatewayServerFrame
      try {
        frame = JSON.parse(String(event.data)) as GatewayServerFrame
      } catch {
        return
      }
      this.onFrame(frame)
    }

    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      if (this.stopped) return
      if (event.code === CloseCodes.authFailed) {
        this.stopped = true
        this.handlers.onStatus('auth_failed')
        return
      }
      this.scheduleReconnect()
    }
    // onerror is always followed by onclose, which handles reconnection.
    socket.onerror = () => undefined
  }

  private onFrame(frame: GatewayServerFrame): void {
    switch (frame.op) {
      case 'hello':
        this.startHeartbeat(frame.d.heartbeatIntervalMs)
        this.send({ op: 'identify', d: { token: this.token } })
        break
      case 'ready': {
        const isReconnect = this.hasBeenReady
        this.hasBeenReady = true
        this.attempt = 0
        if (this.desiredStatus !== 'online') this.setStatus(this.desiredStatus)
        this.handlers.onStatus('connected')
        this.handlers.onReady(frame.d, isReconnect)
        break
      }
      case 'heartbeat_ack':
        this.awaitingAck = false
        break
      case 'message_create':
        this.handlers.onMessage(frame.d)
        break
      case 'user_update':
        this.handlers.onUserUpdate(frame.d)
        break
      case 'server_create':
        this.handlers.onServerCreate(frame.d)
        break
      case 'voice_state_update':
        this.handlers.onVoiceStateUpdate(frame.d)
        break
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.awaitingAck = false
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingAck) {
        // Zombie connection: force a reconnect.
        this.socket?.close(4000, 'Heartbeat ack missed')
        return
      }
      this.awaitingAck = true
      this.send({ op: 'heartbeat' })
    }, intervalMs)
  }

  private scheduleReconnect(): void {
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    const delay = Math.round(exp * (0.7 + Math.random() * 0.6))
    this.attempt += 1
    this.handlers.onStatus('reconnecting', delay)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private send(frame: GatewayClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.awaitingAck = false
  }
}
