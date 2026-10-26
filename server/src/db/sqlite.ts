import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ChannelType } from '../protocol.js'
import { sqliteMigrations } from './migrations.js'
import type {
  ChannelRecord,
  MessagePage,
  MessageRecord,
  Repository,
  ServerRecord,
  UserRecord
} from './repository.js'

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
    createdAt: num(r.created_at)
  }
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

  async createMessage(message: Omit<MessageRecord, 'id'>) {
    const result = this.run(
      'INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)',
      message.channelId,
      message.authorId,
      message.content,
      message.createdAt
    )
    return { ...message, id: String(result.lastInsertRowid) }
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
