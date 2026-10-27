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
  }
]
