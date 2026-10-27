import type {
  ChannelType,
  ConfigurableRole,
  ProfileImageKind,
  SelectableStatus,
  ServerRole
} from '../protocol.js'
import type { Override } from '../lib/permissions.js'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  avatarColor: string
  bot: boolean
  createdAt: number
  /** Instance administrator (registration invites, account management). */
  instanceAdmin?: boolean
  /** Set when an administrator disabled the account (no sign-in, all sessions revoked). */
  disabledAt?: number | null
  // ---- Profile and presence (Milestone 8); optional so older call sites stay valid ----
  bio?: string | null
  pronouns?: string | null
  accentColor?: string | null
  avatarId?: string | null
  bannerId?: string | null
  /** The status the user chose; live presence is computed by the gateway. */
  statusPreference?: SelectableStatus
  customStatusText?: string | null
  customStatusEmoji?: string | null
  customStatusExpiresAt?: number | null
}

export interface ProfilePatch {
  displayName?: string
  avatarColor?: string
  bio?: string | null
  pronouns?: string | null
  accentColor?: string | null
}

export interface CustomStatusRecord {
  text: string | null
  emoji: string | null
  expiresAt: number | null
}

export interface ProfileMediaRecord {
  id: string
  userId: string
  kind: ProfileImageKind
  width: number
  height: number
  /** Bytes of the full-size file. */
  size: number
  sha256: string
  createdAt: number
}

export type SessionKind = 'dev' | 'password'

export interface SessionRecord {
  /** Public identifier (for "active devices"); not a secret. */
  id: string
  /** SHA-256 of the bearer token. The token itself is never stored. */
  tokenHash: string
  userId: string
  kind: SessionKind
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  revokedAt: number | null
  device: string | null
  createdIp: string | null
  lastIp: string | null
}

export interface RegistrationInviteRecord {
  id: string
  codeHash: string
  kind: 'register' | 'claim'
  claimUserId: string | null
  serverId: string | null
  note: string | null
  createdBy: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
  revokedAt: number | null
}

export interface PasswordResetRecord {
  id: string
  codeHash: string
  userId: string
  createdBy: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
}

export interface MemberRecord {
  serverId: string
  userId: string
  role: ServerRole
  joinedAt: number
}

export interface BanRecord {
  serverId: string
  userId: string
  bannedBy: string | null
  reason: string | null
  createdAt: number
}

export interface ServerInviteRecord {
  id: string
  serverId: string
  codeHash: string
  createdBy: string | null
  createdAt: number
  expiresAt: number | null
  maxUses: number | null
  uses: number
  revokedAt: number | null
}

export interface AuditRecord {
  id?: string
  at: number
  action: string
  actorId: string | null
  targetUserId: string | null
  serverId: string | null
  ip: string | null
  detail: Record<string, unknown> | null
}

export interface LegacyIdentityRecord {
  user: UserRecord
  messages: number
  attachments: number
  reactions: number
  lastSeenAt: number | null
  openClaimCode: boolean
}

/** Result of registering with (or claiming through) an invitation. */
export type RegistrationResult =
  | { ok: true; user: UserRecord; invite: RegistrationInviteRecord }
  | { ok: false; reason: 'invalid_invite' | 'username_taken' | 'already_claimed' }

export type InviteAcceptResult =
  | { status: 'joined'; serverId: string }
  | { status: 'already_member'; serverId: string }
  | { status: 'invalid' }
  | { status: 'banned' }

export interface MergeReport {
  from: { id: string; username: string }
  into: { id: string; username: string }
  messages: number
  attachments: number
  reactions: number
  reactionDuplicates: number
  pins: number
  readStates: number
  memberships: number
  ownedServers: number
  sessionsRevoked: number
  dryRun: boolean
}

export interface IntegrityReport {
  users: number
  accounts: number
  legacyIdentities: number
  bots: number
  messages: number
  attachments: number
  reactions: number
  pins: number
  readStates: number
  memberships: number
  serversWithoutOwner: string[]
  orphans: {
    messagesWithoutAuthor: number
    attachmentsWithoutUploader: number
    attachmentsWithoutMessageOrPending: number
    reactionsWithoutUser: number
    membersWithoutUser: number
  }
  foreignKeyViolations: number
  integrityCheck: string
}

export interface ServerRecord {
  id: string
  name: string
  color: string
  ownerId: string | null
  position: number
  createdAt: number
}

export interface ChannelRecord {
  id: string
  serverId: string
  name: string
  type: ChannelType
  topic: string | null
  category: string
  position: number
  createdAt: number
}

export interface MessageRecord {
  id: string
  channelId: string
  authorId: string
  content: string
  createdAt: number
  editedAt: number | null
  replyToId: string | null
}

export interface MessagePage {
  before?: string
  after?: string
  /** Return messages around this id (inclusive), half before and half after. */
  around?: string
  limit: number
}

export interface NewMessage {
  channelId: string
  authorId: string
  content: string
  createdAt: number
  replyToId: string | null
  /** Pending attachments owned by the author in the same channel, in display order. */
  attachmentIds: string[]
}

export interface AttachmentRecord {
  id: string
  messageId: string | null
  channelId: string
  uploaderId: string
  filename: string
  contentType: string
  kind: 'image' | 'file'
  size: number
  width: number | null
  height: number | null
  sha256: string
  position: number
  createdAt: number
}

export interface ReactionSummary {
  messageId: string
  emoji: string
  count: number
  me: boolean
}

export interface PinRecord {
  messageId: string
  channelId: string
  pinnedBy: string
  pinnedAt: number
}

export interface ReadStateRecord {
  channelId: string
  lastReadId: string | null
  lastMessageId: string | null
  unreadCount: number
}

export interface SearchQuery {
  /** FTS5 MATCH expression built by the server (never raw user input). */
  match: string | null
  channelIds: string[]
  authorId?: string
  /** createdAt bounds (epoch ms). */
  since?: number
  until?: number
  /** Message id cursor (exclusive). */
  before?: string
  limit: number
}

export class RepositoryConflict extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/**
 * Storage abstraction. Every method is async so a PostgreSQL implementation
 * (e.g. using `pg` with $1-style parameters) can be dropped in without touching routes.
 */
export interface Repository {
  readonly kind: 'sqlite' | 'postgres'
  migrate(): Promise<void>
  close(): Promise<void>

  getUser(id: string): Promise<UserRecord | undefined>
  findUserByUsername(username: string): Promise<UserRecord | undefined>
  listUsers(): Promise<UserRecord[]>
  createUser(user: UserRecord): Promise<UserRecord>
  updateUser(id: string, patch: ProfilePatch): Promise<UserRecord | undefined>

  // ---- Profiles, presence, preferences (Milestone 8) ----
  setStatusPreference(userId: string, status: SelectableStatus): Promise<UserRecord | undefined>
  /** null clears the custom status. */
  setCustomStatus(userId: string, status: CustomStatusRecord | null): Promise<UserRecord | undefined>
  /** Clears custom statuses that expired at or before `now`; returns the affected user ids. */
  clearExpiredCustomStatuses(now: number): Promise<string[]>
  /**
   * Atomically points the user's avatar/banner at `media` (or removes it when null), deleting
   * the previous media row. Returns the previous media id (its files can then be removed).
   */
  replaceProfileMedia(
    userId: string,
    kind: ProfileImageKind,
    media: ProfileMediaRecord | null
  ): Promise<{ previousId: string | null; user: UserRecord | undefined }>
  getProfileMedia(id: string): Promise<ProfileMediaRecord | undefined>
  /** Every profile media id that has a row (for the orphan file sweep). */
  listProfileMediaIds(): Promise<Set<string>>
  /** Same rule as listVisibleUsers, for one user. */
  isUserVisibleTo(viewerId: string, userId: string): Promise<boolean>
  /** Servers both users are members of. */
  mutualServerIds(userA: string, userB: string): Promise<string[]>
  /** Stored preferences JSON and its timestamp, or undefined if never saved. */
  getPreferences(userId: string): Promise<{ data: string; updatedAt: number } | undefined>
  savePreferences(userId: string, data: string, now: number): Promise<void>

  // ---- Accounts (Milestone 7) ----
  setInstanceAdmin(userId: string, admin: boolean): Promise<void>
  /** Disables (timestamp) or re-enables (null) an account. Disabling revokes all sessions. */
  setUserDisabled(userId: string, at: number | null): Promise<void>
  getPasswordHash(userId: string): Promise<string | undefined>
  /** Creates or replaces the password verifier. */
  setPasswordHash(userId: string, passwordHash: string, now: number): Promise<void>
  hasPassword(userIds: string[]): Promise<Set<string>>
  /** Users the viewer may see: people sharing a server, authors in their servers, bots, self. */
  listVisibleUsers(viewerId: string): Promise<UserRecord[]>
  /** Everyone who shares at least one server with `userId` (including themself). */
  usersSharingServers(userId: string): Promise<Set<string>>
  listLegacyIdentities(): Promise<LegacyIdentityRecord[]>

  /**
   * Atomically redeems a registration or claim invitation: verifies it is open, creates the
   * account (or attaches a password to the claimed identity), stores recovery code verifiers,
   * marks the invitation used and (for claims) revokes the identity's development sessions.
   */
  registerWithInvite(input: {
    codeHash: string
    now: number
    newUser: UserRecord
    passwordHash: string
    recoveryHashes: string[]
    displayName?: string
  }): Promise<RegistrationResult>
  /** Instance bootstrap (local CLI only): create an account, or set a password on an identity. */
  provisionAccount(user: UserRecord, passwordHash: string, now: number): Promise<UserRecord>

  // Sessions
  insertSession(session: SessionRecord): Promise<void>
  /** The session and its user for a token hash (no validity checks; see auth/sessions.ts). */
  findSession(tokenHash: string): Promise<{ session: SessionRecord; user: UserRecord } | undefined>
  touchSession(id: string, now: number, ip: string | null): Promise<void>
  listSessions(userId: string, now: number): Promise<SessionRecord[]>
  /** Revokes one of the user's sessions; returns whether it existed and was active. */
  revokeSession(userId: string, sessionId: string, now: number): Promise<boolean>
  /** Revokes all of a user's active sessions (optionally keeping one, or only 'dev' ones). */
  revokeUserSessions(
    userId: string,
    now: number,
    options?: { exceptId?: string; kind?: SessionKind }
  ): Promise<string[]>

  // Recovery codes and administrator resets
  replaceRecoveryCodes(userId: string, hashes: string[], now: number): Promise<void>
  /** Marks one unused code as used; false if it doesn't exist or was used. */
  useRecoveryCode(userId: string, hash: string, now: number): Promise<boolean>
  countRecoveryCodes(userId: string): Promise<number>
  /** Creates a reset code (invalidating earlier open ones for that user). */
  createPasswordReset(reset: PasswordResetRecord): Promise<void>
  /** Consumes an open reset code issued for this user; false if invalid, used or expired. */
  usePasswordReset(codeHash: string, userId: string, now: number): Promise<boolean>

  // Registration invitations
  /** For claims, revokes any earlier open claim code for the same identity. */
  createRegistrationInvite(invite: RegistrationInviteRecord): Promise<void>
  findOpenRegistrationInvite(codeHash: string, now: number): Promise<RegistrationInviteRecord | undefined>
  listRegistrationInvites(): Promise<RegistrationInviteRecord[]>
  revokeRegistrationInvite(id: string, now: number): Promise<boolean>

  // Servers and membership
  getServer(id: string): Promise<ServerRecord | undefined>
  updateServer(id: string, patch: Partial<Pick<ServerRecord, 'name' | 'color'>>): Promise<ServerRecord | undefined>
  getMember(serverId: string, userId: string): Promise<MemberRecord | undefined>
  listMembers(serverId: string): Promise<MemberRecord[]>
  membershipsForUser(userId: string): Promise<MemberRecord[]>
  /** Adds a member unless banned or already present. */
  addMember(member: MemberRecord): Promise<'added' | 'exists' | 'banned'>
  removeMember(serverId: string, userId: string): Promise<boolean>
  setMemberRole(serverId: string, userId: string, role: Exclude<ServerRole, 'owner'>): Promise<boolean>
  /** Atomically makes `toUserId` the owner and demotes the previous owner to admin. */
  transferOwnership(serverId: string, fromUserId: string, toUserId: string): Promise<boolean>
  /** Local CLI only: makes a user the owner (joining if needed); the previous owner becomes admin. */
  setOwner(serverId: string, userId: string, now: number): Promise<void>
  /** Removes the membership and records a ban (one transaction). */
  banMember(ban: BanRecord): Promise<void>
  unbanMember(serverId: string, userId: string): Promise<boolean>
  listBans(serverId: string): Promise<BanRecord[]>
  getRolePermissions(serverIds: string[]): Promise<Map<string, Partial<Record<ConfigurableRole, number>>>>
  /** `null` resets the role to its built-in default. */
  setRolePermissions(serverId: string, role: ConfigurableRole, permissions: number | null): Promise<void>
  overridesForChannels(channelIds: string[]): Promise<Map<string, Override[]>>
  /** allow = deny = 0 removes the override. */
  setChannelOverride(channelId: string, role: ConfigurableRole, allow: number, deny: number): Promise<void>
  createChannel(channel: ChannelRecord): Promise<void>
  updateChannel(id: string, patch: Partial<Pick<ChannelRecord, 'name' | 'topic'>>): Promise<ChannelRecord | undefined>
  /** Deletes a channel and everything in it; returns the attachment ids to remove from disk. */
  deleteChannel(id: string): Promise<string[]>

  // Server invitations
  createServerInvite(invite: ServerInviteRecord): Promise<void>
  listServerInvites(serverId: string): Promise<ServerInviteRecord[]>
  getServerInvite(id: string): Promise<ServerInviteRecord | undefined>
  findUsableServerInvite(codeHash: string, now: number): Promise<ServerInviteRecord | undefined>
  revokeServerInvite(id: string, now: number): Promise<boolean>
  /** Atomic: checks it is usable, counts the use and adds the membership (one transaction). */
  acceptServerInvite(codeHash: string, userId: string, now: number): Promise<InviteAcceptResult>

  // Audit log
  addAuditEvent(event: AuditRecord): Promise<void>
  listAuditEvents(query: { serverId?: string; before?: string; limit: number }): Promise<AuditRecord[]>

  // Maintenance and legacy identity migration
  /** Deletes expired/revoked sessions, used/expired codes and old audit events. */
  purgeExpired(now: number, retention: { sessionsMs: number; auditMs: number }): Promise<Record<string, number>>
  /** Moves everything owned by one identity to another account (dry run = report only). */
  mergeUsers(fromUserId: string, intoUserId: string, dryRun: boolean): Promise<MergeReport>
  integrityReport(): Promise<IntegrityReport>

  countServers(): Promise<number>
  listServers(): Promise<ServerRecord[]>
  listChannels(): Promise<ChannelRecord[]>
  getChannel(id: string): Promise<ChannelRecord | undefined>
  /** Creates the server, its channels and (if ownerId is set) the owner's membership. */
  createServer(server: ServerRecord, channels: ChannelRecord[]): Promise<void>

  listMessages(channelId: string, page: MessagePage): Promise<MessageRecord[]>
  getMessage(id: string): Promise<MessageRecord | undefined>
  getMessages(ids: string[]): Promise<MessageRecord[]>
  /**
   * Inserts the message and claims its pending attachments in one transaction. Throws
   * RepositoryConflict('attachment_unavailable') if any attachment can't be claimed.
   */
  createMessage(message: NewMessage): Promise<MessageRecord>
  /**
   * Author-only content edit. With `expectedEditedAt` (the edit the client saw: editedAt or
   * null) the update only applies if nobody edited in between, else RepositoryConflict('stale').
   */
  editMessage(
    id: string,
    authorId: string,
    content: string,
    editedAt: number,
    expectedEditedAt?: number | null
  ): Promise<MessageRecord | undefined>
  /** Deletes the message (reactions, pins, attachment rows cascade); returns its attachments. */
  deleteMessage(id: string): Promise<AttachmentRecord[]>

  // Attachments
  createAttachment(attachment: AttachmentRecord): Promise<void>
  getAttachment(id: string): Promise<AttachmentRecord | undefined>
  attachmentsForMessages(messageIds: string[]): Promise<AttachmentRecord[]>
  /** Deletes a pending (unsent) attachment owned by `uploaderId`. */
  deletePendingAttachment(id: string, uploaderId: string): Promise<AttachmentRecord | undefined>
  /** Pending attachments created before `olderThan` (abandoned uploads). */
  listStalePendingAttachments(olderThan: number): Promise<AttachmentRecord[]>
  deleteAttachmentRows(ids: string[]): Promise<void>
  /** Every attachment id that has a database row (pending or sent). */
  listAttachmentIds(): Promise<Set<string>>
  /** Bytes stored by one user, and in total. */
  attachmentUsage(uploaderId: string): Promise<{ user: number; total: number; pendingCount: number }>

  // Reactions
  /** Returns false if the per-message distinct-emoji limit would be exceeded. */
  addReaction(messageId: string, emoji: string, userId: string, at: number, maxDistinct: number): Promise<boolean>
  removeReaction(messageId: string, emoji: string, userId: string): Promise<void>
  reactionCount(messageId: string, emoji: string): Promise<number>
  reactionsForMessages(messageIds: string[], viewerId: string): Promise<ReactionSummary[]>

  // Pins
  /** Returns 'limit' when the channel already has `max` pins. Idempotent. */
  pinMessage(pin: PinRecord, max: number): Promise<'ok' | 'limit'>
  unpinMessage(messageId: string): Promise<boolean>
  listPins(channelId: string): Promise<PinRecord[]>
  pinnedAmong(messageIds: string[]): Promise<Set<string>>

  // Read state
  /** Moves the read position forward only; returns the effective last read id. */
  markRead(userId: string, channelId: string, messageId: string, at: number): Promise<string>
  /** Read states for the given text channels; initializes missing ones at the newest message. */
  readStates(userId: string, channelIds: string[], at: number, cap: number): Promise<ReadStateRecord[]>

  // Search
  searchMessages(query: SearchQuery): Promise<MessageRecord[]>
}
