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
  }
]
