import type { ChannelType } from '../protocol.js'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  avatarColor: string
  bot: boolean
  createdAt: number
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
  updateUser(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'avatarColor'>>
  ): Promise<UserRecord | undefined>

  createSession(tokenHash: string, userId: string, now: number): Promise<void>
  findUserBySessionHash(tokenHash: string, now: number): Promise<UserRecord | undefined>

  countServers(): Promise<number>
  listServers(): Promise<ServerRecord[]>
  listChannels(): Promise<ChannelRecord[]>
  getChannel(id: string): Promise<ChannelRecord | undefined>
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
