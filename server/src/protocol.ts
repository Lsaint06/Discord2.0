/**
 * Wire protocol shared with the desktop client.
 * Mirror: desktop/src/renderer/src/net/protocol.ts — keep the two files identical
 * (apart from this comment).
 */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'
export type SelectableStatus = 'online' | 'idle' | 'dnd' | 'invisible'
export type ChannelType = 'text' | 'voice'

export interface ApiUser {
  id: string
  username: string
  displayName: string
  avatarColor: string
  bot: boolean
  status: PresenceStatus
}

export interface ApiChannel {
  id: string
  serverId: string
  name: string
  type: ChannelType
  topic: string | null
  category: string
  position: number
}

export interface ApiServer {
  id: string
  name: string
  color: string
  channels: ApiChannel[]
}

export interface ApiMessage {
  /** Monotonically increasing decimal string; usable as a pagination cursor. */
  id: string
  channelId: string
  authorId: string
  content: string
  createdAt: number
  /** Echoed back from the sender so it can reconcile its optimistic message. */
  nonce?: string
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryAfterMs?: number }
}

/** A user currently connected to a voice channel (source of truth: LiveKit webhooks). */
export interface ApiVoiceState {
  userId: string
  channelId: string
  /** Present (true) while the user is screen sharing. */
  streaming?: boolean
}

/** Short-lived credentials for joining one voice channel's LiveKit room. */
export interface ApiVoiceToken {
  /** LiveKit WebSocket URL to connect to. */
  url: string
  /** Signed JWT, valid only for `room`, expiring at `expiresAt` (epoch ms). */
  token: string
  room: string
  identity: string
  expiresAt: number
}

export const LIMITS = {
  messageMaxLength: 2000,
  displayNameMaxLength: 32,
  serverNameMaxLength: 40,
  messagesPageMax: 100,
  messagesPageDefault: 50
} as const

/** Client → server gateway frames. */
export type GatewayClientFrame =
  | { op: 'identify'; d: { token: string } }
  | { op: 'heartbeat' }
  | { op: 'set_status'; d: { status: SelectableStatus } }

/** Server → client gateway frames. */
export type GatewayServerFrame =
  | { op: 'hello'; d: { heartbeatIntervalMs: number } }
  | { op: 'ready'; d: { user: ApiUser; users: ApiUser[]; voiceStates: ApiVoiceState[] } }
  | { op: 'heartbeat_ack' }
  | { op: 'message_create'; d: ApiMessage }
  | { op: 'user_update'; d: ApiUser }
  | { op: 'server_create'; d: ApiServer }
  /** channelId null = the user left voice. `streaming` is included when share state changed. */
  | { op: 'voice_state_update'; d: { userId: string; channelId: string | null; streaming?: boolean } }

/** Custom WebSocket close codes (4000–4999 are application-defined). */
export const CloseCodes = {
  authFailed: 4001,
  identifyTimeout: 4002,
  invalidFrame: 4003,
  heartbeatTimeout: 4004,
  rateLimited: 4008,
  serverShutdown: 4010
} as const
