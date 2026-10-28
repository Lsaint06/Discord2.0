import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ChannelType } from '../protocol.js'
import { DIRECT_SERVER_ID, sqliteMigrations } from './migrations.js'
import type {
  AddMemberResult,
  AttachmentRecord,
  AuditRecord,
  BanRecord,
  ChannelRecord,
  ConversationEventRecord,
  ConversationKind,
  ConversationMemberRecord,
  ConversationRecord,
  ConversationSummary,
  FriendRequestResult,
  IntegrityReport,
  InviteAcceptResult,
  LegacyIdentityRecord,
  MemberRecord,
  MergeReport,
  MessagePage,
  MessageRecord,
  NewMessage,
  PasswordResetRecord,
  PinRecord,
  ProfileMediaRecord,
  ProfilePatch,
  CustomStatusRecord,
  ReactionSummary,
  ReadStateRecord,
  RegistrationInviteRecord,
  RegistrationResult,
  RelationshipType,
  Repository,
  SearchQuery,
  ServerInviteRecord,
  ServerRecord,
  SessionKind,
  SessionRecord,
  UserRecord
} from './repository.js'
import type { ConfigurableRole, ProfileImageKind, SelectableStatus, ServerRole } from '../protocol.js'
import type { Override } from '../lib/permissions.js'
import { RepositoryConflict } from './repository.js'

type Row = Record<string, unknown>

const str = (v: unknown): string => String(v)
const num = (v: unknown): number => Number(v)

function toUser(r: Row): UserRecord {
  return {
    id: str(r.id),
    username: str(r.username),
    displayName: str(r.display_name),
    avatarColor: str(r.avatar_color),
    bot: num(r.is_bot) === 1,
    createdAt: num(r.created_at),
    instanceAdmin: num(r.instance_admin ?? 0) === 1,
    disabledAt: r.disabled_at == null ? null : num(r.disabled_at),
    allowServerDms: num(r.allow_server_dms ?? 1) === 1,
    bio: nullableStr(r.bio),
    pronouns: nullableStr(r.pronouns),
    accentColor: nullableStr(r.accent_color),
    avatarId: nullableStr(r.avatar_id),
    bannerId: nullableStr(r.banner_id),
    statusPreference: toSelectableStatus(r.status_preference),
    customStatusText: nullableStr(r.custom_status_text),
    customStatusEmoji: nullableStr(r.custom_status_emoji),
    customStatusExpiresAt: nullableNum(r.custom_status_expires_at)
  }
}

const SELECTABLE_STATUSES: readonly SelectableStatus[] = ['online', 'idle', 'dnd', 'invisible']
function toSelectableStatus(v: unknown): SelectableStatus {
  return SELECTABLE_STATUSES.includes(v as SelectableStatus) ? (v as SelectableStatus) : 'online'
}

function toProfileMedia(r: Row): ProfileMediaRecord {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    kind: str(r.kind) === 'banner' ? 'banner' : 'avatar',
    width: num(r.width),
    height: num(r.height),
    size: num(r.size),
    sha256: str(r.sha256),
    createdAt: num(r.created_at)
  }
}

const nullableStr = (v: unknown): string | null => (v == null ? null : str(v))
const nullableNum = (v: unknown): number | null => (v == null ? null : num(v))

function toSession(r: Row): SessionRecord {
  return {
    id: str(r.id),
    tokenHash: str(r.token_hash),
    userId: str(r.user_id),
    kind: str(r.kind) === 'password' ? 'password' : 'dev',
    createdAt: num(r.created_at),
    lastUsedAt: num(r.last_used_at),
    expiresAt: num(r.expires_at),
    revokedAt: nullableNum(r.revoked_at),
    device: nullableStr(r.device),
    createdIp: nullableStr(r.created_ip),
    lastIp: nullableStr(r.last_ip)
  }
}

function toRegistrationInvite(r: Row): RegistrationInviteRecord {
  return {
    id: str(r.id),
    codeHash: str(r.code_hash),
    kind: str(r.kind) === 'claim' ? 'claim' : 'register',
    claimUserId: nullableStr(r.claim_user_id),
    serverId: nullableStr(r.server_id),
    note: nullableStr(r.note),
    createdBy: nullableStr(r.created_by),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    usedAt: nullableNum(r.used_at),
    usedBy: nullableStr(r.used_by),
    revokedAt: nullableNum(r.revoked_at)
  }
}

function toMember(r: Row): MemberRecord {
  return {
    serverId: str(r.server_id),
    userId: str(r.user_id),
    role: str(r.role) as ServerRole,
    joinedAt: num(r.joined_at)
  }
}

function toServerInvite(r: Row): ServerInviteRecord {
  return {
    id: str(r.id),
    serverId: str(r.server_id),
    codeHash: str(r.code_hash),
    createdBy: nullableStr(r.created_by),
    createdAt: num(r.created_at),
    expiresAt: nullableNum(r.expires_at),
    maxUses: nullableNum(r.max_uses),
    uses: num(r.uses),
    revokedAt: nullableNum(r.revoked_at)
  }
}

function toAudit(r: Row): AuditRecord {
  let detail: Record<string, unknown> | null = null
  if (r.detail != null) {
    try {
      detail = JSON.parse(str(r.detail)) as Record<string, unknown>
    } catch {
      detail = null
    }
  }
  return {
    id: str(r.id),
    at: num(r.at),
    action: str(r.action),
    actorId: nullableStr(r.actor_id),
    targetUserId: nullableStr(r.target_user_id),
    serverId: nullableStr(r.server_id),
    ip: nullableStr(r.ip),
    detail
  }
}

function toServer(r: Row): ServerRecord {
  return {
    id: str(r.id),
    name: str(r.name),
    color: str(r.color),
    ownerId: r.owner_id == null ? null : str(r.owner_id),
    position: num(r.position),
    createdAt: num(r.created_at)
  }
}

function toChannel(r: Row): ChannelRecord {
  return {
    id: str(r.id),
    serverId: str(r.server_id),
    name: str(r.name),
    type: str(r.type) as ChannelType,
    topic: r.topic == null ? null : str(r.topic),
    category: str(r.category),
    position: num(r.position),
    createdAt: num(r.created_at)
  }
}

function toMessage(r: Row): MessageRecord {
  return {
    id: str(r.id),
    channelId: str(r.channel_id),
    authorId: str(r.author_id),
    content: str(r.content),
    createdAt: num(r.created_at),
    editedAt: r.edited_at == null ? null : num(r.edited_at),
    replyToId: r.reply_to_id == null ? null : str(r.reply_to_id)
  }
}

function toAttachment(r: Row): AttachmentRecord {
  return {
    id: str(r.id),
    messageId: r.message_id == null ? null : str(r.message_id),
    channelId: str(r.channel_id),
    uploaderId: str(r.uploader_id),
    filename: str(r.filename),
    contentType: str(r.content_type),
    kind: str(r.kind) === 'image' ? 'image' : 'file',
    size: num(r.size),
    width: r.width == null ? null : num(r.width),
    height: r.height == null ? null : num(r.height),
    sha256: str(r.sha256),
    position: num(r.position),
    createdAt: num(r.created_at)
  }
}

/** "?, ?, ?" for an IN (...) list. Values are always bound, never interpolated. */
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
const ID_CHUNK = 500

function dmKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

function toConversation(r: Row): ConversationRecord {
  return {
    channelId: str(r.channel_id),
    kind: str(r.kind) as ConversationKind,
    dmKey: r.dm_key == null ? null : str(r.dm_key),
    name: r.name == null ? null : str(r.name),
    ownerId: r.owner_id == null ? null : str(r.owner_id),
    createdBy: r.created_by == null ? null : str(r.created_by),
    createdAt: num(r.created_at)
  }
}

function toConversationMember(r: Row): ConversationMemberRecord {
  return {
    channelId: str(r.channel_id),
    userId: str(r.user_id),
    joinedAt: num(r.joined_at),
    historyFrom: String(num(r.history_from)),
    closed: num(r.closed) === 1
  }
}

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Who `viewerId` may see (names, avatars, presence subject to blocks): bots, themselves, people
 * sharing a server, authors in their servers, friends, pending requests either way, people they
 * blocked, current members of their conversations, and authors of conversation messages they
 * can see (not people who only wrote before they joined). Returns [SQL condition on `u`, params].
 */
function visibleCondition(viewerId: string): [string, SQLInputValue[]] {
  return [
    `(u.is_bot = 1 OR u.id = ?
      OR EXISTS (SELECT 1 FROM server_members a JOIN server_members b ON a.server_id = b.server_id
                 WHERE a.user_id = ? AND b.user_id = u.id)
      OR EXISTS (SELECT 1 FROM messages m
                 JOIN channels c ON c.id = m.channel_id
                 JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ?
                 WHERE m.author_id = u.id)
      OR EXISTS (SELECT 1 FROM friendships f
                 WHERE (f.user_a = ? AND f.user_b = u.id) OR (f.user_b = ? AND f.user_a = u.id))
      OR EXISTS (SELECT 1 FROM friend_requests r
                 WHERE (r.from_user_id = ? AND r.to_user_id = u.id) OR (r.to_user_id = ? AND r.from_user_id = u.id))
      OR EXISTS (SELECT 1 FROM user_blocks k WHERE k.blocker_id = ? AND k.blocked_id = u.id)
      OR EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.channel_id = a.channel_id
                 WHERE a.user_id = ? AND b.user_id = u.id)
      OR EXISTS (SELECT 1 FROM messages m JOIN conversation_members cm
                   ON cm.channel_id = m.channel_id AND cm.user_id = ?
                 WHERE m.author_id = u.id AND m.id > cm.history_from))`,
    [viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId]
  ]
}

/** All queries use bound parameters (`?`); no SQL is ever built from user input. */
export class SqliteRepository implements Repository {
  readonly kind = 'sqlite' as const
  private readonly db: DatabaseSync

  constructor(filename: string) {
    if (filename !== ':memory:') {
      const full = resolve(filename)
      mkdirSync(dirname(full), { recursive: true })
      filename = full
    }
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params)
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async migrate(): Promise<void> {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
    )
    const applied = new Set(
      this.all('SELECT version FROM schema_migrations').map((r) => num(r.version))
    )
    for (const m of sqliteMigrations) {
      if (applied.has(m.version)) continue
      this.transaction(() => {
        this.db.exec(m.sql)
        this.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          m.version,
          m.name,
          Date.now()
        )
      })
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }

  async getUser(id: string) {
    const r = this.get('SELECT * FROM users WHERE id = ?', id)
    return r && toUser(r)
  }

  async findUserByUsername(username: string) {
    const r = this.get('SELECT * FROM users WHERE username = ?', username)
    return r && toUser(r)
  }

  async listUsers() {
    return this.all('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').map(toUser)
  }

  async createUser(user: UserRecord) {
    this.insertUser(user)
    return user
  }

  private insertUser(user: UserRecord): void {
    this.run(
      'INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at, instance_admin, disabled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      user.id,
      user.username,
      user.displayName,
      user.avatarColor,
      user.bot ? 1 : 0,
      user.createdAt,
      user.instanceAdmin ? 1 : 0,
      user.disabledAt ?? null
    )
  }

  async updateUser(id: string, patch: ProfilePatch) {
    const columns: [string, SQLInputValue][] = []
    if (patch.displayName !== undefined) columns.push(['display_name', patch.displayName])
    if (patch.avatarColor !== undefined) columns.push(['avatar_color', patch.avatarColor])
    if (patch.bio !== undefined) columns.push(['bio', patch.bio])
    if (patch.pronouns !== undefined) columns.push(['pronouns', patch.pronouns])
    if (patch.accentColor !== undefined) columns.push(['accent_color', patch.accentColor])
    if (columns.length > 0) {
      // Column names come from the fixed list above, never from input; values are bound.
      this.run(
        `UPDATE users SET ${columns.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...columns.map(([, v]) => v),
        id
      )
    }
    return this.getUser(id)
  }

  // ---- Profiles, presence, preferences (Milestone 8) ----

  async setStatusPreference(userId: string, status: SelectableStatus) {
    this.run('UPDATE users SET status_preference = ? WHERE id = ?', status, userId)
    return this.getUser(userId)
  }

  async setCustomStatus(userId: string, status: CustomStatusRecord | null) {
    this.run(
      'UPDATE users SET custom_status_text = ?, custom_status_emoji = ?, custom_status_expires_at = ? WHERE id = ?',
      status?.text ?? null,
      status?.emoji ?? null,
      status?.expiresAt ?? null,
      userId
    )
    return this.getUser(userId)
  }

  async clearExpiredCustomStatuses(now: number) {
    const ids = this.all(
      'SELECT id FROM users WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?',
      now
    ).map((r) => str(r.id))
    if (ids.length > 0) {
      this.run(
        `UPDATE users SET custom_status_text = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL
         WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?`,
        now
      )
    }
    return ids
  }

  async replaceProfileMedia(userId: string, kind: ProfileImageKind, media: ProfileMediaRecord | null) {
    const column = kind === 'avatar' ? 'avatar_id' : 'banner_id'
    let previousId: string | null = null
    this.transaction(() => {
      const row = this.get(`SELECT ${column} AS current FROM users WHERE id = ?`, userId)
      if (!row) throw new RepositoryConflict('user_not_found')
      previousId = nullableStr(row.current)
      if (media) {
        this.run(
          'INSERT INTO profile_media (id, user_id, kind, width, height, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          media.id,
          userId,
          kind,
          media.width,
          media.height,
          media.size,
          media.sha256,
          media.createdAt
        )
      }
      this.run(`UPDATE users SET ${column} = ? WHERE id = ?`, media?.id ?? null, userId)
      if (previousId) this.run('DELETE FROM profile_media WHERE id = ?', previousId)
    })
    return { previousId, user: await this.getUser(userId) }
  }

  async getProfileMedia(id: string) {
    const r = this.get('SELECT * FROM profile_media WHERE id = ?', id)
    return r && toProfileMedia(r)
  }

  async listProfileMediaIds() {
    return new Set(this.all('SELECT id FROM profile_media').map((r) => str(r.id)))
  }

  async isUserVisibleTo(viewerId: string, userId: string) {
    const [condition, params] = visibleCondition(viewerId)
    const r = this.get(`SELECT 1 AS ok FROM users u WHERE u.id = ? AND (${condition})`, userId, ...params)
    return Boolean(r)
  }

  async mutualServerIds(userA: string, userB: string) {
    return this.all(
      `SELECT a.server_id FROM server_members a
       JOIN server_members b ON b.server_id = a.server_id AND b.user_id = ?
       JOIN servers s ON s.id = a.server_id
       WHERE a.user_id = ?
       ORDER BY s.position, s.created_at`,
      userB,
      userA
    ).map((r) => str(r.server_id))
  }

  async getPreferences(userId: string) {
    const r = this.get('SELECT data, updated_at FROM user_preferences WHERE user_id = ?', userId)
    return r ? { data: str(r.data), updatedAt: num(r.updated_at) } : undefined
  }

  async savePreferences(userId: string, data: string, now: number) {
    this.run(
      `INSERT INTO user_preferences (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      userId,
      data,
      now
    )
  }

  // ---- Friends and blocks (Milestone 10) ----

  async listRelationships(userId: string) {
    const rows = this.all(
      `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id, 'friend' AS type, created_at
         FROM friendships WHERE user_a = ? OR user_b = ?
       UNION ALL SELECT from_user_id, 'incoming', created_at FROM friend_requests WHERE to_user_id = ?
       UNION ALL SELECT to_user_id, 'outgoing', created_at FROM friend_requests WHERE from_user_id = ?
       UNION ALL SELECT blocked_id, 'blocked', created_at FROM user_blocks WHERE blocker_id = ?
       ORDER BY 3 DESC`,
      userId,
      userId,
      userId,
      userId,
      userId,
      userId
    )
    return rows.map((r) => ({
      userId: str(r.id),
      type: str(r.type) as RelationshipType,
      since: num(r.created_at)
    }))
  }

  async areFriends(a: string, b: string) {
    const [x, y] = a < b ? [a, b] : [b, a]
    return Boolean(this.get('SELECT 1 AS ok FROM friendships WHERE user_a = ? AND user_b = ?', x, y))
  }

  async blockedEither(userId: string) {
    const rows = this.all(
      `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = ?
       UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = ?`,
      userId,
      userId
    )
    return new Set(rows.map((r) => str(r.id)))
  }

  async isBlockedEither(a: string, b: string) {
    return Boolean(
      this.get(
        `SELECT 1 AS ok FROM user_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        a,
        b,
        b,
        a
      )
    )
  }

  private friendshipExists(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a]
    return Boolean(this.get('SELECT 1 AS ok FROM friendships WHERE user_a = ? AND user_b = ?', x, y))
  }

  private insertFriendship(a: string, b: string, now: number): void {
    const [x, y] = a < b ? [a, b] : [b, a]
    this.run('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)', x, y, now)
    this.run(
      `DELETE FROM friend_requests
       WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
      a,
      b,
      b,
      a
    )
  }

  async sendFriendRequest(fromId: string, toId: string, now: number) {
    let result: FriendRequestResult = 'requested'
    // BEGIN IMMEDIATE serialises concurrent requests: two people asking each other at the same
    // moment produce exactly one friendship.
    this.transaction(() => {
      const blocked = this.get(
        `SELECT 1 AS ok FROM user_blocks
         WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        fromId,
        toId,
        toId,
        fromId
      )
      if (blocked) {
        result = 'blocked'
        return
      }
      if (this.friendshipExists(fromId, toId)) {
        result = 'already_friends'
        return
      }
      const reverse = this.get(
        'SELECT 1 AS ok FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?',
        toId,
        fromId
      )
      if (reverse) {
        this.insertFriendship(fromId, toId, now)
        result = 'accepted'
        return
      }
      const r = this.run(
        'INSERT OR IGNORE INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)',
        fromId,
        toId,
        now
      )
      result = Number(r.changes) === 0 ? 'already_requested' : 'requested'
    })
    return result
  }

  async acceptFriendRequest(userId: string, fromId: string, now: number) {
    let ok = false
    this.transaction(() => {
      const pending = this.get(
        'SELECT 1 AS ok FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?',
        fromId,
        userId
      )
      if (!pending) return
      this.insertFriendship(userId, fromId, now)
      ok = true
    })
    return ok
  }

  async removeRelationship(userId: string, otherId: string) {
    let existed: 'friend' | 'outgoing' | 'incoming' | null = null
    this.transaction(() => {
      const [x, y] = userId < otherId ? [userId, otherId] : [otherId, userId]
      if (Number(this.run('DELETE FROM friendships WHERE user_a = ? AND user_b = ?', x, y).changes) > 0) {
        existed = 'friend'
      }
      if (
        Number(
          this.run('DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?', userId, otherId).changes
        ) > 0
      ) {
        existed ??= 'outgoing'
      }
      if (
        Number(
          this.run('DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?', otherId, userId).changes
        ) > 0
      ) {
        existed ??= 'incoming'
      }
    })
    return existed
  }

  async blockUser(blockerId: string, blockedId: string, now: number) {
    this.transaction(() => {
      this.run(
        'INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
        blockerId,
        blockedId,
        now
      )
      const [x, y] = blockerId < blockedId ? [blockerId, blockedId] : [blockedId, blockerId]
      this.run('DELETE FROM friendships WHERE user_a = ? AND user_b = ?', x, y)
      this.run(
        `DELETE FROM friend_requests
         WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
        blockerId,
        blockedId,
        blockedId,
        blockerId
      )
    })
  }

  async unblockUser(blockerId: string, blockedId: string) {
    const r = this.run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId)
    return Number(r.changes) > 0
  }

  async setAllowServerDms(userId: string, allow: boolean) {
    this.run('UPDATE users SET allow_server_dms = ? WHERE id = ?', allow ? 1 : 0, userId)
  }

  async getAllowServerDms(userId: string) {
    const r = this.get('SELECT allow_server_dms FROM users WHERE id = ?', userId)
    return num(r?.allow_server_dms ?? 1) === 1
  }

  async shareServer(a: string, b: string) {
    return Boolean(
      this.get(
        `SELECT 1 AS ok FROM server_members x JOIN server_members y ON x.server_id = y.server_id
         WHERE x.user_id = ? AND y.user_id = ?`,
        a,
        b
      )
    )
  }

  // ---- Conversations (Milestone 10) ----

  async getConversation(channelId: string) {
    const r = this.get('SELECT * FROM conversations WHERE channel_id = ?', channelId)
    return r ? toConversation(r) : undefined
  }

  async getConversationMember(channelId: string, userId: string) {
    const r = this.get('SELECT * FROM conversation_members WHERE channel_id = ? AND user_id = ?', channelId, userId)
    return r ? toConversationMember(r) : undefined
  }

  async listConversationMembers(channelId: string) {
    return this.all(
      'SELECT * FROM conversation_members WHERE channel_id = ? ORDER BY joined_at, user_id',
      channelId
    ).map(toConversationMember)
  }

  async listConversationsForUser(userId: string, includeClosed = false) {
    const rows = this.all(
      `SELECT c.*, m.joined_at AS m_joined_at, m.history_from AS m_history_from, m.closed AS m_closed,
         (SELECT MAX(id) FROM messages x WHERE x.channel_id = c.channel_id AND x.id > m.history_from) AS last_id,
         (SELECT group_concat(user_id) FROM
            (SELECT user_id FROM conversation_members o WHERE o.channel_id = c.channel_id
             ORDER BY o.joined_at, o.user_id)) AS member_ids
       FROM conversations c JOIN conversation_members m ON m.channel_id = c.channel_id AND m.user_id = ?
       WHERE ? = 1 OR m.closed = 0
       ORDER BY COALESCE(last_id, 0) DESC, c.created_at DESC`,
      userId,
      includeClosed ? 1 : 0
    )
    return rows.map(
      (r): ConversationSummary => ({
        conversation: toConversation(r),
        member: {
          channelId: str(r.channel_id),
          userId,
          joinedAt: num(r.m_joined_at),
          historyFrom: String(num(r.m_history_from)),
          closed: num(r.m_closed) === 1
        },
        memberIds: r.member_ids == null ? [] : str(r.member_ids).split(','),
        lastMessageId: r.last_id == null ? null : String(num(r.last_id))
      })
    )
  }

  async conversationChannelIds(userId: string) {
    return this.all('SELECT channel_id FROM conversation_members WHERE user_id = ?', userId).map((r) =>
      str(r.channel_id)
    )
  }

  private maxMessageId(): number {
    return num(this.get('SELECT COALESCE(MAX(id), 0) AS n FROM messages')?.n ?? 0)
  }

  private insertConversationChannel(channelId: string, kind: ConversationKind, now: number): void {
    this.run(
      'INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      channelId,
      DIRECT_SERVER_ID,
      kind === 'dm' ? 'direct-message' : 'group',
      'text',
      null,
      kind === 'dm' ? 'Direct Messages' : 'Group Messages',
      0,
      now
    )
  }

  /** Adds a member whose history starts at `floor`, with a matching read marker (so later messages count as unread). */
  private insertMember(channelId: string, userId: string, now: number, floor: number): void {
    this.run(
      `INSERT INTO conversation_members (channel_id, user_id, joined_at, history_from, closed) VALUES (?, ?, ?, ?, 0)`,
      channelId,
      userId,
      now,
      floor
    )
    this.run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id),
         updated_at = excluded.updated_at`,
      userId,
      channelId,
      floor,
      now
    )
  }

  private logConversationEvent(
    channelId: string,
    at: number,
    actorId: string | null,
    action: string,
    targetUserId: string | null,
    detail: Record<string, unknown> | null
  ): void {
    this.run(
      `INSERT INTO conversation_events (channel_id, at, actor_id, action, target_user_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      channelId,
      at,
      actorId,
      action,
      targetUserId,
      detail ? JSON.stringify(detail) : null
    )
  }

  async findDm(a: string, b: string) {
    const r = this.get('SELECT * FROM conversations WHERE dm_key = ?', dmKey(a, b))
    return r ? toConversation(r) : undefined
  }

  async findOrCreateDm(openerId: string, otherId: string, now: number, newChannelId: string) {
    let created = false
    const key = dmKey(openerId, otherId)
    // Serialised: two people opening the DM at the same moment get the same conversation.
    this.transaction(() => {
      if (this.get('SELECT 1 AS ok FROM conversations WHERE dm_key = ?', key)) return
      this.insertConversationChannel(newChannelId, 'dm', now)
      this.run(
        `INSERT INTO conversations (channel_id, kind, dm_key, name, owner_id, created_by, created_at)
         VALUES (?, 'dm', ?, NULL, NULL, ?, ?)`,
        newChannelId,
        key,
        openerId,
        now
      )
      // Both participants see the whole DM history (floor 0); nothing exists yet anyway.
      this.insertMember(newChannelId, openerId, now, 0)
      this.insertMember(newChannelId, otherId, now, 0)
      created = true
    })
    const r = this.get('SELECT * FROM conversations WHERE dm_key = ?', key)
    if (!r) throw new Error('DM creation failed')
    return { conversation: toConversation(r), created }
  }

  async createGroup(creatorId: string, memberIds: string[], name: string | null, now: number, newChannelId: string) {
    this.transaction(() => {
      this.insertConversationChannel(newChannelId, 'group', now)
      this.run(
        `INSERT INTO conversations (channel_id, kind, dm_key, name, owner_id, created_by, created_at)
         VALUES (?, 'group', NULL, ?, ?, ?, ?)`,
        newChannelId,
        name,
        creatorId,
        creatorId,
        now
      )
      this.insertMember(newChannelId, creatorId, now, 0)
      for (const id of memberIds) {
        if (id !== creatorId) this.insertMember(newChannelId, id, now, 0)
      }
      this.logConversationEvent(newChannelId, now, creatorId, 'created', null, name ? { name } : null)
    })
    const r = this.get('SELECT * FROM conversations WHERE channel_id = ?', newChannelId)
    if (!r) throw new Error('Group creation failed')
    return toConversation(r)
  }

  async addConversationMember(channelId: string, actorId: string, userId: string, now: number, maxMembers: number) {
    let result: AddMemberResult = 'added'
    this.transaction(() => {
      if (this.get('SELECT 1 AS ok FROM conversation_members WHERE channel_id = ? AND user_id = ?', channelId, userId)) {
        result = 'exists'
        return
      }
      const n = num(this.get('SELECT COUNT(*) AS n FROM conversation_members WHERE channel_id = ?', channelId)?.n ?? 0)
      if (n >= maxMembers) {
        result = 'full'
        return
      }
      // New (or returning) members never see messages sent before they joined.
      this.insertMember(channelId, userId, now, this.maxMessageId())
      this.logConversationEvent(channelId, now, actorId, 'member_added', userId, null)
    })
    return result
  }

  async removeConversationMember(
    channelId: string,
    userId: string,
    actorId: string,
    action: 'left' | 'removed',
    now: number
  ) {
    let removed = false
    let ownerId: string | null = null
    this.transaction(() => {
      const r = this.run('DELETE FROM conversation_members WHERE channel_id = ? AND user_id = ?', channelId, userId)
      removed = Number(r.changes) > 0
      const conv = this.get('SELECT owner_id FROM conversations WHERE channel_id = ?', channelId)
      ownerId = conv?.owner_id == null ? null : str(conv.owner_id)
      if (!removed) return
      // A former member's read marker would otherwise survive a later re-add with a lower floor.
      this.run('DELETE FROM read_states WHERE user_id = ? AND channel_id = ?', userId, channelId)
      this.logConversationEvent(channelId, now, actorId, action === 'left' ? 'member_left' : 'member_removed', userId, null)
      if (ownerId === userId) {
        const next = this.get(
          'SELECT user_id FROM conversation_members WHERE channel_id = ? ORDER BY joined_at, user_id LIMIT 1',
          channelId
        )
        ownerId = next ? str(next.user_id) : null
        this.run('UPDATE conversations SET owner_id = ? WHERE channel_id = ?', ownerId, channelId)
        if (ownerId) this.logConversationEvent(channelId, now, null, 'owner_changed', ownerId, null)
      }
    })
    return { removed, ownerId }
  }

  async renameConversation(channelId: string, name: string | null, actorId: string, now: number) {
    this.transaction(() => {
      this.run('UPDATE conversations SET name = ? WHERE channel_id = ?', name, channelId)
      this.logConversationEvent(channelId, now, actorId, 'renamed', null, { name })
    })
  }

  async setConversationClosed(channelId: string, userId: string, closed: boolean) {
    this.run(
      'UPDATE conversation_members SET closed = ? WHERE channel_id = ? AND user_id = ?',
      closed ? 1 : 0,
      channelId,
      userId
    )
  }

  async reopenConversation(channelId: string) {
    const rows = this.all(
      'UPDATE conversation_members SET closed = 0 WHERE channel_id = ? AND closed = 1 RETURNING user_id',
      channelId
    )
    return rows.map((r) => str(r.user_id))
  }

  async listConversationEvents(channelId: string, afterAt: number, limit: number) {
    return this.all(
      'SELECT * FROM conversation_events WHERE channel_id = ? AND at >= ? ORDER BY id DESC LIMIT ?',
      channelId,
      afterAt,
      limit
    )
      .reverse()
      .map(
        (r): ConversationEventRecord => ({
          id: String(num(r.id)),
          channelId: str(r.channel_id),
          at: num(r.at),
          actorId: r.actor_id == null ? null : str(r.actor_id),
          action: str(r.action),
          targetUserId: r.target_user_id == null ? null : str(r.target_user_id),
          detail: r.detail == null ? null : (JSON.parse(str(r.detail)) as Record<string, unknown>)
        })
      )
  }

  // ---- Accounts ----
  async setInstanceAdmin(userId: string, admin: boolean) {
    this.run('UPDATE users SET instance_admin = ? WHERE id = ?', admin ? 1 : 0, userId)
  }

  async setUserDisabled(userId: string, at: number | null) {
    this.transaction(() => {
      this.run('UPDATE users SET disabled_at = ? WHERE id = ?', at, userId)
      if (at !== null) {
        this.run(
          'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
          at,
          userId
        )
      }
    })
  }

  async getPasswordHash(userId: string) {
    const r = this.get('SELECT password_hash FROM credentials WHERE user_id = ?', userId)
    return r ? str(r.password_hash) : undefined
  }

  async setPasswordHash(userId: string, passwordHash: string, now: number) {
    this.run(
      `INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      userId,
      passwordHash,
      now,
      now
    )
  }

  async hasPassword(userIds: string[]) {
    const out = new Set<string>()
    for (const part of chunks([...new Set(userIds)])) {
      for (const r of this.all(
        `SELECT user_id FROM credentials WHERE user_id IN (${placeholders(part.length)})`,
        ...part
      )) {
        out.add(str(r.user_id))
      }
    }
    return out
  }

  async listVisibleUsers(viewerId: string) {
    const [condition, params] = visibleCondition(viewerId)
    return this.all(
      `SELECT u.* FROM users u WHERE ${condition} ORDER BY u.display_name COLLATE NOCASE`,
      ...params
    ).map(toUser)
  }

  async presenceAudience(userId: string) {
    // Shared servers, friends and current conversation partners — never blocked pairs.
    const rows = this.all(
      `SELECT b.user_id AS id FROM server_members a JOIN server_members b ON a.server_id = b.server_id
         WHERE a.user_id = ?
       UNION SELECT user_b FROM friendships WHERE user_a = ?
       UNION SELECT user_a FROM friendships WHERE user_b = ?
       UNION SELECT b.user_id FROM conversation_members a
         JOIN conversation_members b ON b.channel_id = a.channel_id WHERE a.user_id = ?`,
      userId,
      userId,
      userId,
      userId
    )
    const blocked = await this.blockedEither(userId)
    const out = new Set(rows.map((r) => str(r.id)).filter((id) => !blocked.has(id)))
    out.add(userId)
    return out
  }

  async usersSharingServers(userId: string) {
    const rows = this.all(
      `SELECT DISTINCT b.user_id FROM server_members a JOIN server_members b ON a.server_id = b.server_id
       WHERE a.user_id = ?`,
      userId
    )
    const out = new Set(rows.map((r) => str(r.user_id)))
    out.add(userId)
    return out
  }

  async listLegacyIdentities(): Promise<LegacyIdentityRecord[]> {
    const rows = this.all(
      `SELECT u.*,
         (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) AS n_messages,
         (SELECT COUNT(*) FROM attachments a WHERE a.uploader_id = u.id) AS n_attachments,
         (SELECT COUNT(*) FROM reactions r WHERE r.user_id = u.id) AS n_reactions,
         (SELECT MAX(last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
         EXISTS (SELECT 1 FROM registration_invites ri WHERE ri.claim_user_id = u.id
                 AND ri.used_at IS NULL AND ri.revoked_at IS NULL) AS open_claim
       FROM users u
       WHERE u.is_bot = 0 AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.user_id = u.id)
       ORDER BY u.username`
    )
    return rows.map((r) => ({
      user: toUser(r),
      messages: num(r.n_messages),
      attachments: num(r.n_attachments),
      reactions: num(r.n_reactions),
      lastSeenAt: nullableNum(r.last_seen),
      openClaimCode: num(r.open_claim) === 1
    }))
  }

  async registerWithInvite(input: {
    codeHash: string
    now: number
    newUser: UserRecord
    passwordHash: string
    recoveryHashes: string[]
    displayName?: string
  }): Promise<RegistrationResult> {
    let result: RegistrationResult = { ok: false, reason: 'invalid_invite' }
    this.transaction(() => {
      const row = this.get(
        `SELECT * FROM registration_invites
         WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        input.codeHash,
        input.now
      )
      if (!row) return
      const invite = toRegistrationInvite(row)

      let user: UserRecord
      if (invite.kind === 'claim') {
        const target = this.get('SELECT * FROM users WHERE id = ?', invite.claimUserId)
        if (!target || num(target.is_bot) === 1) return
        if (this.get('SELECT 1 AS x FROM credentials WHERE user_id = ?', invite.claimUserId)) {
          result = { ok: false, reason: 'already_claimed' }
          return
        }
        user = toUser(target)
        if (input.displayName) {
          this.run('UPDATE users SET display_name = ? WHERE id = ?', input.displayName, user.id)
          user = { ...user, displayName: input.displayName }
        }
        // Whoever was using this development identity is signed out now.
        this.run(
          "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind = 'dev' AND revoked_at IS NULL",
          input.now,
          user.id
        )
      } else {
        if (this.get('SELECT 1 AS x FROM users WHERE username = ?', input.newUser.username)) {
          result = { ok: false, reason: 'username_taken' }
          return
        }
        user = input.newUser
        this.insertUser(user)
        if (
          invite.serverId &&
          invite.serverId !== DIRECT_SERVER_ID &&
          this.get('SELECT 1 AS x FROM servers WHERE id = ?', invite.serverId)
        ) {
          this.run(
            "INSERT OR IGNORE INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
            invite.serverId,
            user.id,
            input.now
          )
        }
      }

      this.run(
        'INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
        user.id,
        input.passwordHash,
        input.now,
        input.now
      )
      for (const hash of input.recoveryHashes) {
        this.run(
          'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
          user.id,
          hash,
          input.now
        )
      }
      // Single use, enforced atomically (a concurrent redemption sees changes = 0).
      const used = this.run(
        'UPDATE registration_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL',
        input.now,
        user.id,
        invite.id
      )
      if (Number(used.changes) !== 1) throw new RepositoryConflict('invite_race')
      result = { ok: true, user, invite: { ...invite, usedAt: input.now, usedBy: user.id } }
    })
    return result
  }

  async provisionAccount(user: UserRecord, passwordHash: string, now: number) {
    let out = user
    this.transaction(() => {
      const existing = this.get('SELECT * FROM users WHERE username = ?', user.username)
      if (existing) {
        out = toUser(existing)
        if (out.bot) throw new RepositoryConflict('bot_account')
      } else {
        this.insertUser(user)
      }
      this.run(
        `INSERT INTO credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
        out.id,
        passwordHash,
        now,
        now
      )
      this.run('UPDATE users SET instance_admin = 1, disabled_at = NULL WHERE id = ?', out.id)
      // Development sessions of this identity can no longer be trusted.
      this.run(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind = 'dev' AND revoked_at IS NULL",
        now,
        out.id
      )
    })
    return { ...out, instanceAdmin: true, disabledAt: null }
  }

  // ---- Sessions ----

  async insertSession(s: SessionRecord) {
    this.run(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, id, kind, expires_at, revoked_at, device, created_ip, last_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.tokenHash,
      s.userId,
      s.createdAt,
      s.lastUsedAt,
      s.id,
      s.kind,
      s.expiresAt,
      s.revokedAt,
      s.device,
      s.createdIp,
      s.lastIp
    )
  }

  async findSession(tokenHash: string) {
    const r = this.get(
      `SELECT s.id AS s_id, s.token_hash, s.user_id, s.kind, s.created_at AS s_created_at,
              s.last_used_at, s.expires_at, s.revoked_at, s.device, s.created_ip, s.last_ip, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      tokenHash
    )
    if (!r) return undefined
    return {
      session: toSession({ ...r, id: r.s_id, created_at: r.s_created_at }),
      user: toUser(r)
    }
  }

  async touchSession(id: string, now: number, ip: string | null) {
    this.run('UPDATE sessions SET last_used_at = ?, last_ip = ? WHERE id = ?', now, ip, id)
  }

  async listSessions(userId: string, now: number) {
    return this.all(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_used_at DESC`,
      userId,
      now
    ).map(toSession)
  }

  async revokeSession(userId: string, sessionId: string, now: number) {
    const r = this.run(
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      now,
      sessionId,
      userId
    )
    return Number(r.changes) === 1
  }

  async revokeUserSessions(
    userId: string,
    now: number,
    options: { exceptId?: string; kind?: SessionKind } = {}
  ) {
    const where = ['user_id = ?', 'revoked_at IS NULL']
    const params: SQLInputValue[] = [userId]
    if (options.exceptId) {
      where.push('id != ?')
      params.push(options.exceptId)
    }
    if (options.kind) {
      where.push('kind = ?')
      params.push(options.kind)
    }
    let ids: string[] = []
    this.transaction(() => {
      ids = this.all(`SELECT id FROM sessions WHERE ${where.join(' AND ')}`, ...params).map((r) =>
        str(r.id)
      )
      this.run(`UPDATE sessions SET revoked_at = ? WHERE ${where.join(' AND ')}`, now, ...params)
    })
    return ids
  }

  // ---- Recovery and resets ----

  async replaceRecoveryCodes(userId: string, hashes: string[], now: number) {
    this.transaction(() => {
      this.run('DELETE FROM recovery_codes WHERE user_id = ?', userId)
      for (const hash of hashes) {
        this.run(
          'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
          userId,
          hash,
          now
        )
      }
    })
  }

  async useRecoveryCode(userId: string, hash: string, now: number) {
    const r = this.run(
      'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      now,
      userId,
      hash
    )
    return Number(r.changes) === 1
  }

  async countRecoveryCodes(userId: string) {
    return num(
      this.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId)
        ?.n ?? 0
    )
  }

  async createPasswordReset(reset: PasswordResetRecord) {
    this.transaction(() => {
      this.run(
        'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
        reset.createdAt,
        reset.userId
      )
      this.run(
        'INSERT INTO password_resets (id, code_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        reset.id,
        reset.codeHash,
        reset.userId,
        reset.createdBy,
        reset.createdAt,
        reset.expiresAt
      )
    })
  }

  async usePasswordReset(codeHash: string, userId: string, now: number) {
    const r = this.run(
      'UPDATE password_resets SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?',
      now,
      codeHash,
      userId,
      now
    )
    return Number(r.changes) === 1
  }

  // ---- Registration invitations ----

  async createRegistrationInvite(i: RegistrationInviteRecord) {
    this.transaction(() => {
      if (i.kind === 'claim') {
        this.run(
          "UPDATE registration_invites SET revoked_at = ? WHERE claim_user_id = ? AND kind = 'claim' AND used_at IS NULL AND revoked_at IS NULL",
          i.createdAt,
          i.claimUserId
        )
      }
      this.run(
        `INSERT INTO registration_invites (id, code_hash, kind, claim_user_id, server_id, note, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        i.id,
        i.codeHash,
        i.kind,
        i.claimUserId,
        i.serverId,
        i.note,
        i.createdBy,
        i.createdAt,
        i.expiresAt
      )
    })
  }

  async findOpenRegistrationInvite(codeHash: string, now: number) {
    const r = this.get(
      `SELECT * FROM registration_invites
       WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      codeHash,
      now
    )
    return r && toRegistrationInvite(r)
  }

  async listRegistrationInvites() {
    return this.all('SELECT * FROM registration_invites ORDER BY created_at DESC LIMIT 200').map(
      toRegistrationInvite
    )
  }

  async revokeRegistrationInvite(id: string, now: number) {
    const r = this.run(
      'UPDATE registration_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
      now,
      id
    )
    return Number(r.changes) === 1
  }

  // ---- Servers and membership ----

  async getServer(id: string) {
    // The conversation container is not a server (see DIRECT_SERVER_ID).
    if (id === DIRECT_SERVER_ID) return undefined
    const r = this.get('SELECT * FROM servers WHERE id = ?', id)
    return r && toServer(r)
  }

  async updateServer(id: string, patch: Partial<Pick<ServerRecord, 'name' | 'color'>>) {
    if (patch.name !== undefined) this.run('UPDATE servers SET name = ? WHERE id = ?', patch.name, id)
    if (patch.color !== undefined) this.run('UPDATE servers SET color = ? WHERE id = ?', patch.color, id)
    return this.getServer(id)
  }

  async getMember(serverId: string, userId: string) {
    const r = this.get(
      'SELECT * FROM server_members WHERE server_id = ? AND user_id = ?',
      serverId,
      userId
    )
    return r && toMember(r)
  }

  async listMembers(serverId: string) {
    return this.all(
      'SELECT * FROM server_members WHERE server_id = ? ORDER BY joined_at',
      serverId
    ).map(toMember)
  }

  async membershipsForUser(userId: string) {
    return this.all('SELECT * FROM server_members WHERE user_id = ?', userId).map(toMember)
  }

  async addMember(m: MemberRecord): Promise<'added' | 'exists' | 'banned'> {
    let result: 'added' | 'exists' | 'banned' = 'added'
    this.transaction(() => {
      if (this.get('SELECT 1 AS x FROM server_bans WHERE server_id = ? AND user_id = ?', m.serverId, m.userId)) {
        result = 'banned'
        return
      }
      const r = this.run(
        'INSERT OR IGNORE INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        m.serverId,
        m.userId,
        m.role,
        m.joinedAt
      )
      if (Number(r.changes) === 0) result = 'exists'
    })
    return result
  }

  async removeMember(serverId: string, userId: string) {
    // The owner row is never removed this way (ownership must be transferred first).
    const r = this.run(
      "DELETE FROM server_members WHERE server_id = ? AND user_id = ? AND role != 'owner'",
      serverId,
      userId
    )
    return Number(r.changes) === 1
  }

  async setMemberRole(serverId: string, userId: string, role: Exclude<ServerRole, 'owner'>) {
    const r = this.run(
      "UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ? AND role != 'owner'",
      role,
      serverId,
      userId
    )
    return Number(r.changes) === 1
  }

  async transferOwnership(serverId: string, fromUserId: string, toUserId: string) {
    let ok = false
    this.transaction(() => {
      const from = this.get(
        "SELECT 1 AS x FROM server_members WHERE server_id = ? AND user_id = ? AND role = 'owner'",
        serverId,
        fromUserId
      )
      const to = this.get(
        'SELECT 1 AS x FROM server_members WHERE server_id = ? AND user_id = ?',
        serverId,
        toUserId
      )
      if (!from || !to || fromUserId === toUserId) return
      this.run(
        "UPDATE server_members SET role = 'admin' WHERE server_id = ? AND user_id = ?",
        serverId,
        fromUserId
      )
      this.run(
        "UPDATE server_members SET role = 'owner' WHERE server_id = ? AND user_id = ?",
        serverId,
        toUserId
      )
      this.run('UPDATE servers SET owner_id = ? WHERE id = ?', toUserId, serverId)
      ok = true
    })
    return ok
  }

  async setOwner(serverId: string, userId: string, now: number) {
    this.transaction(() => {
      this.run("UPDATE server_members SET role = 'admin' WHERE server_id = ? AND role = 'owner'", serverId)
      this.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', serverId, userId)
      this.run(
        `INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
         ON CONFLICT (server_id, user_id) DO UPDATE SET role = 'owner'`,
        serverId,
        userId,
        now
      )
      this.run('UPDATE servers SET owner_id = ? WHERE id = ?', userId, serverId)
    })
  }

  async banMember(ban: BanRecord) {
    this.transaction(() => {
      this.run(
        "DELETE FROM server_members WHERE server_id = ? AND user_id = ? AND role != 'owner'",
        ban.serverId,
        ban.userId
      )
      this.run(
        `INSERT INTO server_bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (server_id, user_id) DO UPDATE SET banned_by = excluded.banned_by, reason = excluded.reason`,
        ban.serverId,
        ban.userId,
        ban.bannedBy,
        ban.reason,
        ban.createdAt
      )
    })
  }

  async unbanMember(serverId: string, userId: string) {
    const r = this.run('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?', serverId, userId)
    return Number(r.changes) === 1
  }

  async listBans(serverId: string) {
    return this.all('SELECT * FROM server_bans WHERE server_id = ? ORDER BY created_at DESC', serverId).map(
      (r) => ({
        serverId: str(r.server_id),
        userId: str(r.user_id),
        bannedBy: nullableStr(r.banned_by),
        reason: nullableStr(r.reason),
        createdAt: num(r.created_at)
      })
    )
  }

  async getRolePermissions(serverIds: string[]) {
    const out = new Map<string, Partial<Record<ConfigurableRole, number>>>()
    for (const part of chunks([...new Set(serverIds)])) {
      for (const r of this.all(
        `SELECT * FROM server_role_permissions WHERE server_id IN (${placeholders(part.length)})`,
        ...part
      )) {
        const entry = out.get(str(r.server_id)) ?? {}
        entry[str(r.role) as ConfigurableRole] = num(r.permissions)
        out.set(str(r.server_id), entry)
      }
    }
    return out
  }

  async setRolePermissions(serverId: string, role: ConfigurableRole, permissions: number | null) {
    if (permissions === null) {
      this.run('DELETE FROM server_role_permissions WHERE server_id = ? AND role = ?', serverId, role)
      return
    }
    this.run(
      `INSERT INTO server_role_permissions (server_id, role, permissions) VALUES (?, ?, ?)
       ON CONFLICT (server_id, role) DO UPDATE SET permissions = excluded.permissions`,
      serverId,
      role,
      permissions
    )
  }

  async overridesForChannels(channelIds: string[]) {
    const out = new Map<string, Override[]>()
    for (const part of chunks([...new Set(channelIds)])) {
      for (const r of this.all(
        `SELECT * FROM channel_overrides WHERE channel_id IN (${placeholders(part.length)})`,
        ...part
      )) {
        const list = out.get(str(r.channel_id)) ?? []
        list.push({ role: str(r.role) as ConfigurableRole, allow: num(r.allow), deny: num(r.deny) })
        out.set(str(r.channel_id), list)
      }
    }
    return out
  }

  async setChannelOverride(channelId: string, role: ConfigurableRole, allow: number, deny: number) {
    if (allow === 0 && deny === 0) {
      this.run('DELETE FROM channel_overrides WHERE channel_id = ? AND role = ?', channelId, role)
      return
    }
    this.run(
      `INSERT INTO channel_overrides (channel_id, role, allow, deny) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id, role) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
      channelId,
      role,
      allow,
      deny
    )
  }

  async createChannel(c: ChannelRecord) {
    this.run(
      'INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      c.id,
      c.serverId,
      c.name,
      c.type,
      c.topic,
      c.category,
      c.position,
      c.createdAt
    )
  }

  async updateChannel(id: string, patch: Partial<Pick<ChannelRecord, 'name' | 'topic'>>) {
    if (patch.name !== undefined) this.run('UPDATE channels SET name = ? WHERE id = ?', patch.name, id)
    if (patch.topic !== undefined) this.run('UPDATE channels SET topic = ? WHERE id = ?', patch.topic, id)
    return this.getChannel(id)
  }

  async deleteChannel(id: string) {
    let attachmentIds: string[] = []
    this.transaction(() => {
      attachmentIds = this.all('SELECT id FROM attachments WHERE channel_id = ?', id).map((r) => str(r.id))
      // Messages reference users without ON DELETE; channel deletion cascades messages,
      // attachments, reactions, pins, read states and overrides.
      this.run('DELETE FROM channels WHERE id = ?', id)
    })
    return attachmentIds
  }

  // ---- Server invitations ----

  async createServerInvite(i: ServerInviteRecord) {
    this.run(
      `INSERT INTO server_invites (id, server_id, code_hash, created_by, created_at, expires_at, max_uses, uses, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      i.id,
      i.serverId,
      i.codeHash,
      i.createdBy,
      i.createdAt,
      i.expiresAt,
      i.maxUses
    )
  }

  async listServerInvites(serverId: string) {
    return this.all(
      'SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at DESC LIMIT 200',
      serverId
    ).map(toServerInvite)
  }

  async getServerInvite(id: string) {
    const r = this.get('SELECT * FROM server_invites WHERE id = ?', id)
    return r && toServerInvite(r)
  }

  private static readonly USABLE_INVITE =
    'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)'

  async findUsableServerInvite(codeHash: string, now: number) {
    const r = this.get(
      `SELECT * FROM server_invites WHERE code_hash = ? AND ${SqliteRepository.USABLE_INVITE}`,
      codeHash,
      now
    )
    return r && toServerInvite(r)
  }

  async revokeServerInvite(id: string, now: number) {
    const r = this.run(
      'UPDATE server_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      now,
      id
    )
    return Number(r.changes) === 1
  }

  async acceptServerInvite(codeHash: string, userId: string, now: number): Promise<InviteAcceptResult> {
    let result: InviteAcceptResult = { status: 'invalid' }
    this.transaction(() => {
      const r = this.get(
        `SELECT * FROM server_invites WHERE code_hash = ? AND ${SqliteRepository.USABLE_INVITE}`,
        codeHash,
        now
      )
      if (!r) return
      const invite = toServerInvite(r)
      if (this.get('SELECT 1 AS x FROM server_bans WHERE server_id = ? AND user_id = ?', invite.serverId, userId)) {
        result = { status: 'banned' }
        return
      }
      if (this.get('SELECT 1 AS x FROM server_members WHERE server_id = ? AND user_id = ?', invite.serverId, userId)) {
        result = { status: 'already_member', serverId: invite.serverId }
        return
      }
      // Count the use with the limit in the WHERE clause, so concurrent joins can't exceed it.
      const used = this.run(
        `UPDATE server_invites SET uses = uses + 1 WHERE id = ? AND ${SqliteRepository.USABLE_INVITE}`,
        invite.id,
        now
      )
      if (Number(used.changes) !== 1) return
      this.run(
        "INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
        invite.serverId,
        userId,
        now
      )
      result = { status: 'joined', serverId: invite.serverId }
    })
    return result
  }

  // ---- Audit ----

  async addAuditEvent(e: AuditRecord) {
    this.run(
      'INSERT INTO audit_events (at, action, actor_id, target_user_id, server_id, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.at,
      e.action,
      e.actorId,
      e.targetUserId,
      e.serverId,
      e.ip,
      e.detail ? JSON.stringify(e.detail) : null
    )
  }

  async listAuditEvents(query: { serverId?: string; before?: string; limit: number }) {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (query.serverId) {
      where.push('server_id = ?')
      params.push(query.serverId)
    }
    if (query.before) {
      where.push('id < ?')
      params.push(Number(query.before))
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.all(
      `SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT ?`,
      ...params,
      query.limit
    ).map(toAudit)
  }

  // ---- Maintenance and legacy identities ----

  async purgeExpired(now: number, retention: { sessionsMs: number; auditMs: number }) {
    const out: Record<string, number> = {}
    this.transaction(() => {
      const cutoff = now - retention.sessionsMs
      out.sessions = Number(
        this.run(
          'DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?',
          cutoff,
          cutoff
        ).changes
      )
      out.passwordResets = Number(
        this.run(
          'DELETE FROM password_resets WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?',
          cutoff,
          cutoff
        ).changes
      )
      out.auditEvents = Number(
        this.run('DELETE FROM audit_events WHERE at < ?', now - retention.auditMs).changes
      )
    })
    return out
  }

  async mergeUsers(fromUserId: string, intoUserId: string, dryRun: boolean): Promise<MergeReport> {
    const from = await this.getUser(fromUserId)
    const into = await this.getUser(intoUserId)
    if (!from || !into) throw new RepositoryConflict('unknown_user')
    if (from.id === into.id) throw new RepositoryConflict('same_user')
    if (from.bot || into.bot) throw new RepositoryConflict('bot_account')
    if (this.get('SELECT 1 AS x FROM credentials WHERE user_id = ?', from.id)) {
      // Only unclaimed development identities can be merged away.
      throw new RepositoryConflict('source_has_password')
    }
    const count = (sql: string, ...p: SQLInputValue[]): number => num(this.get(sql, ...p)?.n ?? 0)
    const report: MergeReport = {
      from: { id: from.id, username: from.username },
      into: { id: into.id, username: into.username },
      messages: count('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?', from.id),
      attachments: count('SELECT COUNT(*) AS n FROM attachments WHERE uploader_id = ?', from.id),
      reactions: count('SELECT COUNT(*) AS n FROM reactions WHERE user_id = ?', from.id),
      reactionDuplicates: count(
        `SELECT COUNT(*) AS n FROM reactions a JOIN reactions b
           ON a.message_id = b.message_id AND a.emoji = b.emoji AND b.user_id = ?
         WHERE a.user_id = ?`,
        into.id,
        from.id
      ),
      pins: count('SELECT COUNT(*) AS n FROM pins WHERE pinned_by = ?', from.id),
      readStates: count('SELECT COUNT(*) AS n FROM read_states WHERE user_id = ?', from.id),
      memberships: count('SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?', from.id),
      ownedServers: count(
        "SELECT COUNT(*) AS n FROM server_members WHERE user_id = ? AND role = 'owner'",
        from.id
      ),
      sessionsRevoked: count(
        'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
        from.id
      ),
      dryRun
    }
    if (dryRun) return report

    const RANK = "CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END"
    this.transaction(() => {
      this.run('UPDATE messages SET author_id = ? WHERE author_id = ?', into.id, from.id)
      this.run('UPDATE attachments SET uploader_id = ? WHERE uploader_id = ?', into.id, from.id)
      this.run(
        'INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at) SELECT message_id, emoji, ?, created_at FROM reactions WHERE user_id = ?',
        into.id,
        from.id
      )
      this.run('DELETE FROM reactions WHERE user_id = ?', from.id)
      this.run('UPDATE pins SET pinned_by = ? WHERE pinned_by = ?', into.id, from.id)
      this.run(
        `INSERT INTO read_states (user_id, channel_id, last_read_id, updated_at)
           SELECT ?, channel_id, last_read_id, updated_at FROM read_states WHERE user_id = ?
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
        into.id,
        from.id
      )
      this.run('DELETE FROM read_states WHERE user_id = ?', from.id)
      // Memberships: keep the higher role. Ownership moves to the account.
      for (const m of this.all('SELECT * FROM server_members WHERE user_id = ?', from.id).map(toMember)) {
        const existing = this.get(
          `SELECT ${RANK} AS rank, role FROM server_members WHERE server_id = ? AND user_id = ?`,
          m.serverId,
          into.id
        )
        this.run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', m.serverId, from.id)
        const rank = { owner: 4, admin: 3, moderator: 2, member: 1 }[m.role]
        if (!existing) {
          this.run(
            'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            m.serverId,
            into.id,
            m.role,
            m.joinedAt
          )
        } else if (rank > num(existing.rank)) {
          this.run(
            'UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?',
            m.role,
            m.serverId,
            into.id
          )
        }
      }
      this.run('UPDATE servers SET owner_id = ? WHERE owner_id = ?', into.id, from.id)
      this.run(
        'UPDATE server_invites SET created_by = ? WHERE created_by = ?',
        into.id,
        from.id
      )
      this.run('UPDATE server_bans SET banned_by = ? WHERE banned_by = ?', into.id, from.id)
      // The identity itself goes away; sessions, claim codes and remaining rows cascade.
      this.run('DELETE FROM users WHERE id = ?', from.id)
    })
    return report
  }

  async integrityReport(): Promise<IntegrityReport> {
    const n = (sql: string, ...params: SQLInputValue[]): number => num(this.get(sql, ...params)?.n ?? 0)
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      accounts: n('SELECT COUNT(*) AS n FROM credentials'),
      legacyIdentities: n(
        'SELECT COUNT(*) AS n FROM users u WHERE u.is_bot = 0 AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.user_id = u.id)'
      ),
      bots: n('SELECT COUNT(*) AS n FROM users WHERE is_bot = 1'),
      messages: n('SELECT COUNT(*) AS n FROM messages'),
      attachments: n('SELECT COUNT(*) AS n FROM attachments'),
      reactions: n('SELECT COUNT(*) AS n FROM reactions'),
      pins: n('SELECT COUNT(*) AS n FROM pins'),
      readStates: n('SELECT COUNT(*) AS n FROM read_states'),
      memberships: n('SELECT COUNT(*) AS n FROM server_members'),
      serversWithoutOwner: this.all(
        "SELECT id FROM servers s WHERE s.id <> '@direct' AND NOT EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = s.id AND m.role = 'owner')"
      ).map((r) => str(r.id)),
      directContainerMembers: n('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?', DIRECT_SERVER_ID),
      orphans: {
        messagesWithoutAuthor: n(
          'SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.author_id)'
        ),
        attachmentsWithoutUploader: n(
          'SELECT COUNT(*) AS n FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.uploader_id)'
        ),
        attachmentsWithoutMessageOrPending: n(
          'SELECT COUNT(*) AS n FROM attachments a WHERE a.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id)'
        ),
        reactionsWithoutUser: n(
          'SELECT COUNT(*) AS n FROM reactions r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)'
        ),
        membersWithoutUser: n(
          'SELECT COUNT(*) AS n FROM server_members m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)'
        )
      },
      foreignKeyViolations: this.all('PRAGMA foreign_key_check').length,
      integrityCheck: str(this.get('PRAGMA integrity_check')?.integrity_check ?? 'unknown')
    }
  }

  async countServers() {
    return num(this.get('SELECT COUNT(*) AS n FROM servers WHERE id <> ?', DIRECT_SERVER_ID)?.n ?? 0)
  }

  async listServers() {
    return this.all('SELECT * FROM servers WHERE id <> ? ORDER BY position, created_at', DIRECT_SERVER_ID).map(
      toServer
    )
  }

  async listChannels() {
    // Server channels only; conversation channels are reached through conversation_members.
    return this.all('SELECT * FROM channels WHERE server_id <> ? ORDER BY server_id, position', DIRECT_SERVER_ID).map(
      toChannel
    )
  }

  async getChannel(id: string) {
    const r = this.get('SELECT * FROM channels WHERE id = ?', id)
    return r && toChannel(r)
  }

  async createServer(server: ServerRecord, channels: ChannelRecord[]) {
    this.transaction(() => {
      this.run(
        'INSERT INTO servers (id, name, color, owner_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        server.id,
        server.name,
        server.color,
        server.ownerId,
        server.position,
        server.createdAt
      )
      if (server.ownerId) {
        this.run(
          "INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
          server.id,
          server.ownerId,
          server.createdAt
        )
      }
      for (const c of channels) {
        this.run(
          'INSERT INTO channels (id, server_id, name, type, topic, category, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          c.id,
          c.serverId,
          c.name,
          c.type,
          c.topic,
          c.category,
          c.position,
          c.createdAt
        )
      }
    })
  }

  async listMessages(channelId: string, page: MessagePage) {
    // History floor for conversation members who joined later (0 = everything).
    const floor = Number(page.minId ?? 0)
    if (page.around !== undefined) {
      const half = Math.max(1, Math.floor(page.limit / 2))
      const olderAndSelf = this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id <= ? AND id > ? ORDER BY id DESC LIMIT ?',
        channelId,
        Number(page.around),
        floor,
        half + 1
      ).reverse()
      const newer = this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id > ? AND id > ? ORDER BY id ASC LIMIT ?',
        channelId,
        Number(page.around),
        floor,
        Math.max(0, page.limit - olderAndSelf.length)
      )
      return [...olderAndSelf, ...newer].map(toMessage)
    }
    if (page.after !== undefined) {
      return this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id > ? AND id > ? ORDER BY id ASC LIMIT ?',
        channelId,
        Number(page.after),
        floor,
        page.limit
      ).map(toMessage)
    }
    const rows =
      page.before !== undefined
        ? this.all(
            'SELECT * FROM messages WHERE channel_id = ? AND id < ? AND id > ? ORDER BY id DESC LIMIT ?',
            channelId,
            Number(page.before),
            floor,
            page.limit
          )
        : this.all(
            'SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
            channelId,
            floor,
            page.limit
          )
    return rows.reverse().map(toMessage)
  }

  async getMessage(id: string) {
    const r = this.get('SELECT * FROM messages WHERE id = ?', Number(id))
    return r && toMessage(r)
  }

  async getMessages(ids: string[]) {
    const out: MessageRecord[] = []
    for (const part of chunks([...new Set(ids)])) {
      out.push(
        ...this.all(
          `SELECT * FROM messages WHERE id IN (${placeholders(part.length)})`,
          ...part.map(Number)
        ).map(toMessage)
      )
    }
    return out
  }

  async createMessage(message: NewMessage) {
    let id = ''
    this.transaction(() => {
      const result = this.run(
        'INSERT INTO messages (channel_id, author_id, content, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?)',
        message.channelId,
        message.authorId,
        message.content,
        message.createdAt,
        message.replyToId === null ? null : Number(message.replyToId)
      )
      id = String(result.lastInsertRowid)
      message.attachmentIds.forEach((attachmentId, position) => {
        // Only the uploader's own, still-pending attachment in this channel can be claimed.
        const claimed = this.run(
          'UPDATE attachments SET message_id = ?, position = ? WHERE id = ? AND uploader_id = ? AND channel_id = ? AND message_id IS NULL',
          Number(id),
          position,
          attachmentId,
          message.authorId,
          message.channelId
        )
        if (Number(claimed.changes) !== 1) throw new RepositoryConflict('attachment_unavailable')
      })
    })
    return {
      id,
      channelId: message.channelId,
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      editedAt: null,
      replyToId: message.replyToId
    }
  }

  async editMessage(
    id: string,
    authorId: string,
    content: string,
    editedAt: number,
    expectedEditedAt?: number | null
  ) {
    // Single atomic UPDATE: ownership and (optionally) "nobody edited since" in the WHERE clause.
    const result =
      expectedEditedAt === undefined
        ? this.run(
            'UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND author_id = ?',
            content,
            editedAt,
            Number(id),
            authorId
          )
        : this.run(
            'UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND author_id = ? AND edited_at IS ?',
            content,
            editedAt,
            Number(id),
            authorId,
            expectedEditedAt
          )
    if (Number(result.changes) === 0) {
      const current = await this.getMessage(id)
      if (current && current.authorId === authorId && expectedEditedAt !== undefined) {
        throw new RepositoryConflict('stale')
      }
      return undefined
    }
    return this.getMessage(id)
  }

  async deleteMessage(id: string) {
    let removed: AttachmentRecord[] = []
    this.transaction(() => {
      removed = this.all('SELECT * FROM attachments WHERE message_id = ?', Number(id)).map(
        toAttachment
      )
      this.run('DELETE FROM messages WHERE id = ?', Number(id))
    })
    return removed
  }

  // ---- Attachments ----

  async createAttachment(a: AttachmentRecord) {
    this.run(
      `INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, content_type, kind, size, width, height, sha256, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.messageId === null ? null : Number(a.messageId),
      a.channelId,
      a.uploaderId,
      a.filename,
      a.contentType,
      a.kind,
      a.size,
      a.width,
      a.height,
      a.sha256,
      a.position,
      a.createdAt
    )
  }

  async getAttachment(id: string) {
    const r = this.get('SELECT * FROM attachments WHERE id = ?', id)
    return r && toAttachment(r)
  }

  async attachmentsForMessages(messageIds: string[]) {
    const out: AttachmentRecord[] = []
    for (const part of chunks([...new Set(messageIds)])) {
      out.push(
        ...this.all(
          `SELECT * FROM attachments WHERE message_id IN (${placeholders(part.length)}) ORDER BY message_id, position`,
          ...part.map(Number)
        ).map(toAttachment)
      )
    }
    return out
  }

  async deletePendingAttachment(id: string, uploaderId: string) {
    const r = this.get(
      'SELECT * FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL',
      id,
      uploaderId
    )
    if (!r) return undefined
    this.run('DELETE FROM attachments WHERE id = ? AND message_id IS NULL', id)
    return toAttachment(r)
  }

  async listStalePendingAttachments(olderThan: number) {
    return this.all(
      'SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 1000',
      olderThan
    ).map(toAttachment)
  }

  async deleteAttachmentRows(ids: string[]) {
    for (const part of chunks(ids)) {
      this.run(`DELETE FROM attachments WHERE id IN (${placeholders(part.length)})`, ...part)
    }
  }

  async listAttachmentIds() {
    return new Set(this.all('SELECT id FROM attachments').map((r) => str(r.id)))
  }

  async attachmentUsage(uploaderId: string) {
    const user = this.get(
      'SELECT COALESCE(SUM(size), 0) AS bytes, SUM(message_id IS NULL) AS pending FROM attachments WHERE uploader_id = ?',
      uploaderId
    )
    const total = this.get('SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments')
    return {
      user: num(user?.bytes ?? 0),
      total: num(total?.bytes ?? 0),
      pendingCount: num(user?.pending ?? 0)
    }
  }

  // ---- Reactions ----

  async addReaction(messageId: string, emoji: string, userId: string, at: number, maxDistinct: number) {
    let ok = true
    this.transaction(() => {
      const exists = this.get(
        'SELECT 1 AS x FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1',
        Number(messageId),
        emoji
      )
      if (!exists) {
        const distinct = num(
          this.get(
            'SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?',
            Number(messageId)
          )?.n ?? 0
        )
        if (distinct >= maxDistinct) {
          ok = false
          return
        }
      }
      // Primary key (message, emoji, user) makes duplicates impossible.
      this.run(
        'INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?)',
        Number(messageId),
        emoji,
        userId,
        at
      )
    })
    return ok
  }

  async removeReaction(messageId: string, emoji: string, userId: string) {
    this.run(
      'DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?',
      Number(messageId),
      emoji,
      userId
    )
  }

  async reactionCount(messageId: string, emoji: string) {
    return num(
      this.get(
        'SELECT COUNT(*) AS n FROM reactions WHERE message_id = ? AND emoji = ?',
        Number(messageId),
        emoji
      )?.n ?? 0
    )
  }

  async reactionsForMessages(messageIds: string[], viewerId: string) {
    const out: ReactionSummary[] = []
    for (const part of chunks([...new Set(messageIds)])) {
      const rows = this.all(
        `SELECT message_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS me, MIN(created_at) AS first
         FROM reactions WHERE message_id IN (${placeholders(part.length)})
         GROUP BY message_id, emoji ORDER BY message_id, first`,
        viewerId,
        ...part.map(Number)
      )
      for (const r of rows) {
        out.push({ messageId: str(r.message_id), emoji: str(r.emoji), count: num(r.n), me: num(r.me) === 1 })
      }
    }
    return out
  }

  // ---- Pins ----

  async pinMessage(pin: PinRecord, max: number) {
    let result: 'ok' | 'limit' = 'ok'
    this.transaction(() => {
      if (this.get('SELECT 1 AS x FROM pins WHERE message_id = ?', Number(pin.messageId))) return
      const count = num(
        this.get('SELECT COUNT(*) AS n FROM pins WHERE channel_id = ?', pin.channelId)?.n ?? 0
      )
      if (count >= max) {
        result = 'limit'
        return
      }
      this.run(
        'INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)',
        Number(pin.messageId),
        pin.channelId,
        pin.pinnedBy,
        pin.pinnedAt
      )
    })
    return result
  }

  async unpinMessage(messageId: string) {
    return Number(this.run('DELETE FROM pins WHERE message_id = ?', Number(messageId)).changes) > 0
  }

  async listPins(channelId: string) {
    return this.all(
      'SELECT * FROM pins WHERE channel_id = ? ORDER BY pinned_at DESC',
      channelId
    ).map((r) => ({
      messageId: str(r.message_id),
      channelId: str(r.channel_id),
      pinnedBy: str(r.pinned_by),
      pinnedAt: num(r.pinned_at)
    }))
  }

  async pinnedAmong(messageIds: string[]) {
    const out = new Set<string>()
    for (const part of chunks([...new Set(messageIds)])) {
      for (const r of this.all(
        `SELECT message_id FROM pins WHERE message_id IN (${placeholders(part.length)})`,
        ...part.map(Number)
      )) {
        out.add(str(r.message_id))
      }
    }
    return out
  }

  // ---- Read state ----

  async markRead(userId: string, channelId: string, messageId: string, at: number) {
    this.run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET
         last_read_id = MAX(last_read_id, excluded.last_read_id),
         updated_at = excluded.updated_at`,
      userId,
      channelId,
      Number(messageId),
      at
    )
    const r = this.get(
      'SELECT last_read_id FROM read_states WHERE user_id = ? AND channel_id = ?',
      userId,
      channelId
    )
    return str(r?.last_read_id ?? messageId)
  }

  async readStates(userId: string, channelIds: string[], at: number, cap: number) {
    const out: ReadStateRecord[] = []
    for (const channelId of channelIds) {
      const last = this.get(
        'SELECT MAX(id) AS id FROM messages WHERE channel_id = ?',
        channelId
      )?.id
      const lastMessageId = last == null ? null : str(last)
      let state = this.get(
        'SELECT last_read_id FROM read_states WHERE user_id = ? AND channel_id = ?',
        userId,
        channelId
      )
      if (!state && lastMessageId !== null) {
        // First time this user sees the channel: start "caught up" rather than flooding them
        // with every historic message as unread.
        this.run(
          'INSERT OR IGNORE INTO read_states (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)',
          userId,
          channelId,
          Number(lastMessageId),
          at
        )
        state = { last_read_id: lastMessageId }
      }
      const lastReadId = state ? str(state.last_read_id) : null
      const unread =
        lastReadId === null
          ? 0
          : num(
              this.get(
                `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages
                   WHERE channel_id = ? AND id > ? AND author_id != ? LIMIT ?)`,
                channelId,
                Number(lastReadId),
                userId,
                cap
              )?.n ?? 0
            )
      out.push({ channelId, lastReadId, lastMessageId, unreadCount: unread })
    }
    return out
  }

  // ---- Search ----

  async searchMessages(q: SearchQuery) {
    if (q.channelIds.length === 0) return []
    const where: string[] = [`m.channel_id IN (${placeholders(q.channelIds.length)})`]
    const params: SQLInputValue[] = [...q.channelIds]
    if (q.authorId) {
      where.push('m.author_id = ?')
      params.push(q.authorId)
    }
    if (q.since !== undefined) {
      where.push('m.created_at >= ?')
      params.push(q.since)
    }
    if (q.until !== undefined) {
      where.push('m.created_at < ?')
      params.push(q.until)
    }
    if (q.before !== undefined) {
      where.push('m.id < ?')
      params.push(Number(q.before))
    }
    if (q.minId !== undefined) {
      where.push('m.id > ?')
      params.push(Number(q.minId))
    }
    const sql = q.match
      ? `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`
      : `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`
    const args = q.match ? [q.match, ...params, q.limit] : [...params, q.limit]
    return this.all(sql, ...args).map(toMessage)
  }
}

export function createRepository(databaseUrl: string): Repository {
  if (databaseUrl.startsWith('sqlite:')) {
    return new SqliteRepository(databaseUrl.slice('sqlite:'.length))
  }
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    throw new Error(
      'PostgreSQL support is planned but not implemented yet. See server/README.md ("Migrating to PostgreSQL").'
    )
  }
  throw new Error('Unsupported DATABASE_URL. Use "sqlite:<path>" (e.g. sqlite:./data/discord2.db).')
}
