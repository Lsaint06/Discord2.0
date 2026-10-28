/**
 * Wire protocol shared with the desktop client.
 * Mirror: server/src/protocol.ts — keep the two files identical
 * (apart from this comment).
 */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'
export type SelectableStatus = 'online' | 'idle' | 'dnd' | 'invisible'
export type ChannelType = 'text' | 'voice'

/** Short custom status ("In a meeting 📅"). Absent when not set, expired, or the user appears offline. */
export interface ApiCustomStatus {
  text: string | null
  emoji: string | null
  /** Epoch ms when it clears itself; null = until cleared. */
  expiresAt: number | null
}

export interface ApiUser {
  id: string
  /** Permanent login name (lowercase). */
  username: string
  /** Editable name shown in the app. */
  displayName: string
  /** Fallback avatar background (initials) when there is no picture. */
  avatarColor: string
  bot: boolean
  /** Effective presence as others see it (invisible users are 'offline'). */
  status: PresenceStatus
  /** Profile picture id (GET /api/profile-media/:id); null = initials. */
  avatarId: string | null
  /** Profile banner id; null = accentColor (or avatarColor) is used. */
  bannerId: string | null
  /** Profile accent color (#rrggbb). */
  accentColor: string | null
  bio: string | null
  pronouns: string | null
  /** Account creation (epoch ms). */
  createdAt: number
  customStatus: ApiCustomStatus | null
}

/** The signed-in user, with account details only they can see. */
export interface ApiMe extends ApiUser {
  /** Instance administrator (can issue registration invites and manage accounts). */
  instanceAdmin: boolean
  /** Has a password (a real account). False for development identities. */
  hasPassword: boolean
  /** The status you chose (synced across your devices). `status` is what others see. */
  statusPreference: SelectableStatus
  /** Your custom status even while invisible (others don't see it then). */
  ownCustomStatus: ApiCustomStatus | null
  /** Whether people you share a server with (but aren't friends with) may message you directly. */
  allowServerDms: boolean
  /** Milestone 13: your email address (null = none; absent on older servers). Only you see it. */
  email?: string | null
  /** The address is confirmed (password reset by email works). */
  emailVerified?: boolean
}

/** Full profile for the profile modal. */
export interface ApiProfile {
  user: ApiUser
  /** Servers you share with this user (ids of servers you are a member of). */
  mutualServerIds: string[]
  /** Your relationship with this user (null = none). */
  relationship: RelationshipType | null
}

// ---- Friends and conversations (Milestone 10) ----

/**
 * 'blocked' is only ever reported to the person who blocked. Someone who is blocked sees 'none'
 * (no relationship) — the API never tells anyone they were blocked.
 */
export type RelationshipType = 'friend' | 'incoming' | 'outgoing' | 'blocked'

export interface ApiRelationship {
  userId: string
  type: RelationshipType
  /** When the friendship, request or block started (epoch ms). */
  since: number
}

export type ConversationKind = 'dm' | 'group'

/** A one-to-one or group conversation. Its id is also its channel id (messages, pins, reads). */
export interface ApiConversation {
  id: string
  kind: ConversationKind
  /** Group name (null = shown as the members' names). Always null for one-to-one conversations. */
  name: string | null
  /** Group owner (can remove members). Null for one-to-one conversations. */
  ownerId: string | null
  /** Current members, including you. */
  memberIds: string[]
  /** Newest message you can see (null = none yet). */
  lastMessageId: string | null
  createdAt: number
  /** Your permission bits here (Permissions.*); a DM you can't send to has only viewChannel. */
  permissions: number
}

export type ConversationEventAction =
  'created' | 'member_added' | 'member_removed' | 'member_left' | 'owner_changed' | 'renamed'

export interface ApiConversationEvent {
  id: string
  at: number
  actorId: string | null
  action: ConversationEventAction
  targetUserId: string | null
  /** For 'renamed' and 'created': the name. */
  name?: string | null
}

export type ThemePreference = 'dark' | 'light' | 'system'
export type MessageDensity = 'cozy' | 'compact'
export type ReducedMotionPreference = 'system' | 'on' | 'off'

/** Per-account preferences, synchronized between your devices. */
export interface ApiPreferences {
  theme: ThemePreference
  /** UI accent color; null = the default. */
  accentColor: string | null
  density: MessageDensity
  reducedMotion: ReducedMotionPreference
  showTimestamps: boolean
  /** Minutes without keyboard/mouse input before you appear idle (per device). */
  idleTimeoutMinutes: number
  /** Last change (epoch ms); null = never saved (defaults). */
  updatedAt: number | null
}

export const DEFAULT_PREFERENCES: ApiPreferences = {
  theme: 'dark',
  accentColor: null,
  density: 'cozy',
  reducedMotion: 'system',
  showTimestamps: true,
  idleTimeoutMinutes: 10,
  updatedAt: null
}

export type ProfileImageKind = 'avatar' | 'banner'
/** Output geometry of processed profile images (WebP). */
export const PROFILE_IMAGE_SIZES = {
  avatar: { full: { width: 512, height: 512 }, small: { width: 128, height: 128 } },
  banner: { full: { width: 1500, height: 600 }, small: { width: 600, height: 240 } }
} as const

// ---- Roles and permissions (Milestone 7) ----

export type ServerRole = 'owner' | 'admin' | 'moderator' | 'member'
/** Roles whose permissions can be configured (the owner always has every permission). */
export type ConfigurableRole = Exclude<ServerRole, 'owner'>

/** Permission bits. The backend enforces these; the UI only uses them to hide controls. */
export const Permissions = {
  viewChannel: 1 << 0,
  sendMessages: 1 << 1,
  attachFiles: 1 << 2,
  addReactions: 1 << 3,
  /** Delete other people's messages (and pin/unpin). */
  manageMessages: 1 << 4,
  pinMessages: 1 << 5,
  /** Join voice channels. */
  connect: 1 << 6,
  speak: 1 << 7,
  /** Share a screen (Go Live) in voice. */
  stream: 1 << 8,
  manageChannels: 1 << 9,
  createInvites: 1 << 10,
  /** See and revoke everyone's invites. */
  manageInvites: 1 << 11,
  kickMembers: 1 << 12,
  banMembers: 1 << 13,
  /** Change members' roles and role permissions (only below your own role). */
  manageRoles: 1 << 14,
  /** Rename the server, change its color, see its audit log. */
  manageServer: 1 << 15,
  /** Time out members below your role (Milestone 13: no sending, reacting or voice for a while). */
  moderateMembers: 1 << 16
} as const
export type PermissionName = keyof typeof Permissions
export const ALL_PERMISSIONS = Object.values(Permissions).reduce((a, b) => a | b, 0)

export const ROLE_RANK: Record<ServerRole, number> = { owner: 4, admin: 3, moderator: 2, member: 1 }

export interface ApiChannel {
  id: string
  serverId: string
  name: string
  type: ChannelType
  topic: string | null
  category: string
  position: number
  /** Your effective permissions in this channel. */
  permissions?: number
  /** Voice channels: most people at once (0 = no limit). Milestone 13. */
  userLimit?: number
}

export type NotificationLevel = 'all' | 'mentions'

export interface ApiServer {
  id: string
  name: string
  color: string
  /** Only channels you can view. */
  channels: ApiChannel[]
  ownerId?: string | null
  /** Your role in this server. */
  role?: ServerRole
  /** Your server-level permissions. */
  permissions?: number
  /** Milestone 13: short description shown to members (null = none). */
  description?: string | null
  /** Server icon (GET /api/server-icons/:id); null = the colored initials. */
  iconId?: string | null
  /** What members are notified about unless they choose otherwise. */
  defaultNotifications?: NotificationLevel
  /** You are timed out here until this time (epoch ms); null/absent = not timed out. */
  timeoutUntil?: number | null
}

export interface ApiMember {
  userId: string
  role: ServerRole
  joinedAt: number
  /** Timed out until (epoch ms); null = not timed out. Milestone 13. */
  timeoutUntil?: number | null
}

export interface ApiBan {
  userId: string
  reason: string | null
  bannedBy: string | null
  createdAt: number
}

export interface ApiRolePermissions {
  role: ConfigurableRole
  permissions: number
}

export interface ApiChannelOverride {
  role: ConfigurableRole
  allow: number
  deny: number
}

/** A GIF from the picker (Milestone 13). Media: GET /api/gifs/media/:id?size=preview|still|full */
export interface ApiGif {
  id: string
  title: string
  /** Preview size (picker grid). */
  width: number
  height: number
  /** Message size. */
  fullWidth: number
  fullHeight: number
}

export interface ApiGifPage {
  provider: string
  /** Must be shown with the results (provider terms). */
  attribution: { text: string; url: string }
  items: ApiGif[]
  /** Offset for the next page; null at the end. */
  next: number | null
}

export interface ApiServerInvite {
  id: string
  serverId: string
  createdBy: string | null
  createdAt: number
  expiresAt: number | null
  maxUses: number | null
  uses: number
  revoked: boolean
  /** Only present in the response that created the invite (never stored in plaintext). */
  code?: string
}

export interface ApiInvitePreview {
  serverId: string
  serverName: string
  serverColor: string
  memberCount: number
  expiresAt: number | null
  /** You are already a member. */
  member: boolean
}

export interface ApiSession {
  id: string
  kind: 'password' | 'dev'
  device: string | null
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  ip: string | null
  current: boolean
}

export interface ApiAuthResult {
  token: string
  user: ApiMe
  session: ApiSession
  /** Shown once after registration / regeneration. */
  recoveryCodes?: string[]
  /** Milestone 13: the account was just created (the app shows its short introduction). */
  newAccount?: boolean
}

/** Milestone 13: sign-up, resend and "forgot password" always answer the same way. */
export interface ApiEmailSent {
  status: 'email_sent'
  expiresInMinutes: number
}

export interface ApiAccountEmail {
  email: string | null
  verified: boolean
}

export interface ApiRegistrationInvite {
  id: string
  kind: 'register' | 'claim'
  /** For claim codes: the existing (legacy) account it binds to. */
  claimUserId: string | null
  claimUsername: string | null
  note: string | null
  createdBy: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
  revoked: boolean
  code?: string
}

/** Development identity that has not been claimed by a real account yet. */
export interface ApiLegacyIdentity {
  id: string
  username: string
  displayName: string
  messages: number
  attachments: number
  lastSeenAt: number | null
  openClaimCode: boolean
}

export interface ApiAccount {
  id: string
  username: string
  displayName: string
  instanceAdmin: boolean
  hasPassword: boolean
  disabled: boolean
  bot: boolean
  createdAt: number
}

export interface ApiAuditEvent {
  id: string
  at: number
  action: string
  actorId: string | null
  targetUserId: string | null
  serverId: string | null
  detail: Record<string, unknown> | null
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
  /** Large files (Milestone 13): when the file is deleted (epoch ms). Absent = kept. */
  expiresAt?: number
  /** The file was deleted after its time; the message stays. */
  expired?: boolean
}

/** A chunked, resumable upload in progress (Milestone 13 large files). */
export interface ApiUploadSession {
  id: string
  channelId: string
  filename: string
  size: number
  /** Bytes stored so far: the next chunk starts here. */
  receivedBytes: number
  /** Send chunks of at most this many bytes. */
  chunkBytes: number
  /** Over the threshold: the file will be deleted this long after the upload completes. */
  expiresAfterMs: number | null
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
  filenameMaxLength: 120,
  passwordMinLength: 12,
  passwordMaxLength: 256,
  usernameMinLength: 2,
  usernameMaxLength: 32,
  emailMaxLength: 254,
  recoveryCodeCount: 10,
  inviteMaxUses: 100,
  inviteMaxAgeDays: 30,
  banReasonMaxLength: 200,
  channelNameMaxLength: 40,
  channelTopicMaxLength: 200,
  bioMaxLength: 190,
  bioMaxLines: 8,
  pronounsMaxLength: 40,
  customStatusMaxLength: 128,
  /** Longest custom status expiry (7 days). */
  customStatusMaxMs: 7 * 24 * 60 * 60_000,
  /** Profile picture / banner upload (before processing). */
  profileImageMaxBytes: 10 * 1024 * 1024,
  profileImageMaxPixels: 40_000_000,
  avatarMinSize: 64,
  bannerMinWidth: 300,
  bannerMinHeight: 120,
  idleTimeoutMinMinutes: 1,
  idleTimeoutMaxMinutes: 120,
  /** Group conversations: total members including the creator. */
  groupMinMembers: 3,
  groupMaxMembers: 10,
  groupNameMaxLength: 100,
  /** Milestone 13 server administration. */
  serverDescriptionMaxLength: 300,
  categoryNameMaxLength: 40,
  voiceUserLimitMax: 99,
  /** Longest member timeout (28 days). */
  timeoutMaxMinutes: 28 * 24 * 60,
  serverIconMinSize: 64
} as const

/** Client → server gateway frames. */
export type GatewayClientFrame =
  /** `idle`: this device has been idle (no input) since before connecting. */
  | { op: 'identify'; d: { token: string; idle?: boolean } }
  | { op: 'heartbeat' }
  /** Saves your status preference for the account (prefer PUT /api/users/me/status). */
  | { op: 'set_status'; d: { status: SelectableStatus } }
  /** This device became idle / active (automatic idle detection). */
  | { op: 'set_idle'; d: { idle: boolean } }

/** Server → client gateway frames. */
export type GatewayServerFrame =
  | { op: 'hello'; d: { heartbeatIntervalMs: number } }
  | { op: 'ready'; d: { user: ApiMe; users: ApiUser[]; voiceStates: ApiVoiceState[] } }
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
  /** Sent only to your own sessions: your account changed (status preference, profile). */
  | { op: 'me_update'; d: ApiMe }
  /** Sent only to your own sessions: synced preferences changed on another device. */
  | { op: 'preferences_update'; d: ApiPreferences }
  | { op: 'server_create'; d: ApiServer }
  /** Your access to a server changed (channels, roles, members, permissions): refetch it. */
  | { op: 'server_update'; d: { serverId: string } }
  /** You are no longer a member (left, kicked or banned). */
  | { op: 'server_remove'; d: { serverId: string; reason: 'left' | 'kicked' | 'banned' } }
  /** channelId null = the user left voice. `streaming` is included when share state changed. */
  | {
      op: 'voice_state_update'
      d: { userId: string; channelId: string | null; streaming?: boolean }
    }
  /** Your relationship with userId changed (type null = none). Sent to your own sessions. */
  | { op: 'relationship_update'; d: { userId: string; type: RelationshipType | null } }
  /** A conversation you belong to was created, changed or reopened. */
  | { op: 'conversation_update'; d: ApiConversation }
  /** You no longer belong to this conversation (left or removed), or closed it on another device. */
  | { op: 'conversation_remove'; d: { channelId: string; reason: 'left' | 'removed' | 'closed' } }

/** Custom WebSocket close codes (4000–4999 are application-defined). */
export const CloseCodes = {
  authFailed: 4001,
  identifyTimeout: 4002,
  invalidFrame: 4003,
  heartbeatTimeout: 4004,
  rateLimited: 4008,
  serverShutdown: 4010
} as const
