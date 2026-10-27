/**
 * Wire protocol shared with the desktop client.
 * Mirror: server/src/protocol.ts — keep the two files identical
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

export interface ApiAttachment {
  /** Opaque server-generated id (also the storage key). */
  id: string
  /** Sanitized original file name (display/download name only; never used as a path). */
  filename: string
  /** Content type chosen by the server from its allowlist (never the client's claim). */
  contentType: string
  /** 'image' = shown inline; 'file' = always downloaded. */
  kind: 'image' | 'file'
  size: number
  /** Display dimensions (EXIF orientation already applied) for images. */
  width?: number
  height?: number
}

export interface ApiReaction {
  emoji: string
  count: number
  /** The requesting user reacted with this emoji. */
  me: boolean
}

/** Compact preview of the message being replied to. */
export interface ApiMessageReference {
  id: string
  /** The original message no longer exists. */
  deleted: boolean
  authorId?: string
  /** First characters of the original content. */
  content?: string
  attachmentCount?: number
}

export interface ApiMessage {
  /** Monotonically increasing decimal string; usable as a pagination cursor. */
  id: string
  channelId: string
  authorId: string
  /** May be empty when the message only has attachments. */
  content: string
  createdAt: number
  /** Echoed back from the sender so it can reconcile its optimistic message. */
  nonce?: string
  /** Epoch ms of the last edit (absent/null if never edited). */
  editedAt?: number | null
  replyTo?: ApiMessageReference | null
  attachments?: ApiAttachment[]
  reactions?: ApiReaction[]
  pinned?: boolean
}

export interface ApiReadState {
  channelId: string
  /** Last message the user has read (null = nothing yet). */
  lastReadId: string | null
  /** Newest message in the channel. */
  lastMessageId: string | null
  /** Messages from others after lastReadId (capped at LIMITS.unreadCountCap). */
  unreadCount: number
}

export interface ApiSearchResult {
  messages: ApiMessage[]
  /** Pass as `before` to fetch the next page; null when there are no more results. */
  nextBefore: string | null
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
  messagesPageDefault: 50,
  attachmentsPerMessage: 5,
  reactionsPerMessage: 20,
  emojiMaxLength: 32,
  pinsPerChannel: 50,
  searchPageMax: 25,
  searchQueryMaxLength: 100,
  replyPreviewLength: 120,
  unreadCountCap: 99,
  filenameMaxLength: 120
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
  /** Content edit. Apply only if editedAt is newer than what the client has. */
  | {
      op: 'message_update'
      d: { id: string; channelId: string; content: string; editedAt: number }
    }
  | { op: 'message_delete'; d: { id: string; channelId: string } }
  /** Authoritative count for one emoji on one message after `userId` added/removed it. */
  | {
      op: 'reaction_update'
      d: {
        channelId: string
        messageId: string
        emoji: string
        count: number
        userId: string
        added: boolean
      }
    }
  | {
      op: 'pin_update'
      d: { channelId: string; messageId: string; pinned: boolean; userId: string; at: number }
    }
  /** Sent only to the user's own sessions (sync read position between their clients). */
  | { op: 'read_state_update'; d: { channelId: string; lastReadId: string } }
  | { op: 'user_update'; d: ApiUser }
  | { op: 'server_create'; d: ApiServer }
  /** channelId null = the user left voice. `streaming` is included when share state changed. */
  | {
      op: 'voice_state_update'
      d: { userId: string; channelId: string | null; streaming?: boolean }
    }

/** Custom WebSocket close codes (4000–4999 are application-defined). */
export const CloseCodes = {
  authFailed: 4001,
  identifyTimeout: 4002,
  invalidFrame: 4003,
  heartbeatTimeout: 4004,
  rateLimited: 4008,
  serverShutdown: 4010
} as const
