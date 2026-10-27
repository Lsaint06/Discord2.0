/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped;
 * add a new one instead.
 *
 * PostgreSQL equivalents (for the future `postgres` repository):
 *   INTEGER (epoch ms)                 -> BIGINT
 *   INTEGER PRIMARY KEY AUTOINCREMENT  -> BIGINT GENERATED ALWAYS AS IDENTITY
 *   INTEGER 0/1 booleans               -> BOOLEAN
 * Everything else (TEXT, CHECK, REFERENCES ... ON DELETE, indexes) is portable as written.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const sqliteMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id           TEXT PRIMARY KEY,
        username     TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        is_bot       INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);

      CREATE TABLE servers (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL,
        owner_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE channels (
        id         TEXT PRIMARY KEY,
        server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('text', 'voice')),
        topic      TEXT,
        category   TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX channels_server_idx ON channels(server_id, position);

      CREATE TABLE messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        author_id  TEXT NOT NULL REFERENCES users(id),
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX messages_channel_idx ON messages(channel_id, id);
    `
  },
  {
    // Milestone 6 (Messaging 2.0). Additive only: every existing table/column is unchanged, so
    // a Milestone 5 server can still read a migrated database (see docs/messaging-2-jetson.md).
    version: 2,
    name: 'messaging_2',
    sql: `
      ALTER TABLE messages ADD COLUMN edited_at INTEGER;
      -- Deliberately not a foreign key: messages are hard-deleted, and a reply whose parent
      -- no longer exists is shown as "original message was deleted". Ids are AUTOINCREMENT,
      -- so a deleted id is never reused. Same-channel parents are enforced by the server.
      ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
      CREATE INDEX messages_author_idx ON messages(author_id, id);

      CREATE TABLE attachments (
        id           TEXT PRIMARY KEY,
        -- NULL while uploaded but not yet sent (pending); cascades when the message is deleted.
        message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        uploader_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('image', 'file')),
        size         INTEGER NOT NULL CHECK (size >= 0),
        width        INTEGER,
        height       INTEGER,
        sha256       TEXT NOT NULL,
        position     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX attachments_message_idx ON attachments(message_id, position);
      CREATE INDEX attachments_uploader_idx ON attachments(uploader_id, created_at);

      CREATE TABLE reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id)
      );

      CREATE TABLE pins (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        pinned_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pinned_at  INTEGER NOT NULL
      );
      CREATE INDEX pins_channel_idx ON pins(channel_id, pinned_at);

      CREATE TABLE read_states (
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_id INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );

      -- Full-text search over message content (external-content FTS5, kept in sync by triggers).
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content = 'messages', content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `
  },
  {
    // Milestone 7 (accounts, sessions, memberships, roles, invitations, audit). Additive only:
    // existing tables keep every column, so a Milestone 6 server can still run on a migrated
    // database (it ignores the new tables; see docs/milestone-7-security.md → Rollback).
    version: 3,
    name: 'accounts_and_permissions',
    sql: `
      ALTER TABLE users ADD COLUMN instance_admin INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN disabled_at INTEGER;

      -- One Argon2id verifier (PHC string) per real account. Development identities have none.
      CREATE TABLE credentials (
        user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      -- Sessions: still keyed by the SHA-256 of the bearer token (the token itself is never stored).
      ALTER TABLE sessions ADD COLUMN id TEXT;
      ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'dev' CHECK (kind IN ('dev', 'password'));
      ALTER TABLE sessions ADD COLUMN expires_at INTEGER;
      ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;
      ALTER TABLE sessions ADD COLUMN device TEXT;
      ALTER TABLE sessions ADD COLUMN created_ip TEXT;
      ALTER TABLE sessions ADD COLUMN last_ip TEXT;
      -- Existing (development) sessions get a public id and expire 30 days after the upgrade.
      UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
      UPDATE sessions SET expires_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 2592000000
        WHERE expires_at IS NULL;
      CREATE UNIQUE INDEX sessions_id_idx ON sessions(id);

      -- Instance-level invitations: 'register' creates a new account; 'claim' lets the holder
      -- set a password on one specific existing development identity (keeps its user id).
      CREATE TABLE registration_invites (
        id            TEXT PRIMARY KEY,
        code_hash     TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL CHECK (kind IN ('register', 'claim')),
        claim_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        -- Optional: a new account also joins this server as a member.
        server_id     TEXT REFERENCES servers(id) ON DELETE SET NULL,
        note          TEXT,
        created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        used_at       INTEGER,
        used_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
        revoked_at    INTEGER,
        CHECK ((kind = 'claim') = (claim_user_id IS NOT NULL))
      );
      -- At most one open claim code per identity.
      CREATE UNIQUE INDEX registration_invites_open_claim ON registration_invites(claim_user_id)
        WHERE kind = 'claim' AND used_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE recovery_codes (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at    INTEGER,
        PRIMARY KEY (user_id, code_hash)
      );

      -- Administrator-issued one-time password reset codes.
      CREATE TABLE password_resets (
        id         TEXT PRIMARY KEY,
        code_hash  TEXT NOT NULL UNIQUE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      );
      CREATE INDEX password_resets_user_idx ON password_resets(user_id);

      CREATE TABLE server_members (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );
      CREATE INDEX server_members_user_idx ON server_members(user_id);
      -- Exactly one owner per server is enforced here (plus transfer logic in the server).
      CREATE UNIQUE INDEX server_members_one_owner ON server_members(server_id) WHERE role = 'owner';

      CREATE TABLE server_bans (
        server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason     TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );

      -- Per-server permission sets for the configurable roles (missing row = built-in default).
      CREATE TABLE server_role_permissions (
        server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'member')),
        permissions INTEGER NOT NULL,
        PRIMARY KEY (server_id, role)
      );

      -- Per-channel allow/deny bits for a role (e.g. a moderators-only channel).
      CREATE TABLE channel_overrides (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('admin', 'moderator', 'member')),
        allow      INTEGER NOT NULL DEFAULT 0,
        deny       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, role),
        CHECK ((allow & deny) = 0)
      );

      CREATE TABLE server_invites (
        id         TEXT PRIMARY KEY,
        server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL UNIQUE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_uses   INTEGER,
        uses       INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        CHECK (max_uses IS NULL OR (max_uses >= 1 AND uses <= max_uses))
      );
      CREATE INDEX server_invites_server_idx ON server_invites(server_id, created_at);

      -- Security event log (authentication, administration, moderation). Never contains secrets.
      CREATE TABLE audit_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        at             INTEGER NOT NULL,
        action         TEXT NOT NULL,
        actor_id       TEXT,
        target_user_id TEXT,
        server_id      TEXT,
        ip             TEXT,
        detail         TEXT
      );
      CREATE INDEX audit_events_at_idx ON audit_events(at);
      CREATE INDEX audit_events_server_idx ON audit_events(server_id, at);

      -- Preserve today's access: every existing person is a member of every existing server
      -- (owners keep ownership). New servers and members only ever come through the API.
      INSERT OR IGNORE INTO server_members (server_id, user_id, role, joined_at)
        SELECT s.id, u.id,
               CASE WHEN s.owner_id = u.id THEN 'owner' ELSE 'member' END,
               CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM servers s CROSS JOIN users u
        WHERE u.is_bot = 0;
    `
  }
]
