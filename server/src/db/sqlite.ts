import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ChannelType } from '../protocol.js'
import { sqliteMigrations } from './migrations.js'
import type {
  AttachmentRecord,
  ChannelRecord,
  MessagePage,
  MessageRecord,
  NewMessage,
  PinRecord,
  ReactionSummary,
  ReadStateRecord,
  Repository,
  SearchQuery,
  ServerRecord,
  UserRecord
} from './repository.js'
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
    createdAt: num(r.created_at)
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

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
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
    this.run(
      'INSERT INTO users (id, username, display_name, avatar_color, is_bot, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      user.id,
      user.username,
      user.displayName,
      user.avatarColor,
      user.bot ? 1 : 0,
      user.createdAt
    )
    return user
  }

  async updateUser(id: string, patch: Partial<Pick<UserRecord, 'displayName' | 'avatarColor'>>) {
    if (patch.displayName !== undefined) {
      this.run('UPDATE users SET display_name = ? WHERE id = ?', patch.displayName, id)
    }
    if (patch.avatarColor !== undefined) {
      this.run('UPDATE users SET avatar_color = ? WHERE id = ?', patch.avatarColor, id)
    }
    return this.getUser(id)
  }

  async createSession(tokenHash: string, userId: string, now: number) {
    this.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)',
      tokenHash,
      userId,
      now,
      now
    )
  }

  async findUserBySessionHash(tokenHash: string, now: number) {
    const r = this.get(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      tokenHash
    )
    if (!r) return undefined
    this.run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', now, tokenHash)
    return toUser(r)
  }

  async countServers() {
    return num(this.get('SELECT COUNT(*) AS n FROM servers')?.n ?? 0)
  }

  async listServers() {
    return this.all('SELECT * FROM servers ORDER BY position, created_at').map(toServer)
  }

  async listChannels() {
    return this.all('SELECT * FROM channels ORDER BY server_id, position').map(toChannel)
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
    if (page.around !== undefined) {
      const half = Math.max(1, Math.floor(page.limit / 2))
      const olderAndSelf = this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id <= ? ORDER BY id DESC LIMIT ?',
        channelId,
        Number(page.around),
        half + 1
      ).reverse()
      const newer = this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
        channelId,
        Number(page.around),
        Math.max(0, page.limit - olderAndSelf.length)
      )
      return [...olderAndSelf, ...newer].map(toMessage)
    }
    if (page.after !== undefined) {
      return this.all(
        'SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
        channelId,
        Number(page.after),
        page.limit
      ).map(toMessage)
    }
    const rows =
      page.before !== undefined
        ? this.all(
            'SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            channelId,
            Number(page.before),
            page.limit
          )
        : this.all(
            'SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?',
            channelId,
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
