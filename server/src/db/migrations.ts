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
  },
  {
    // Milestone 8 (profiles, presence, preferences). Additive only: new nullable/defaulted
    // columns and new tables, so Milestone 7 code keeps working on a migrated database.
    version: 4,
    name: 'profiles_and_presence',
    sql: `
      ALTER TABLE users ADD COLUMN bio TEXT;
      ALTER TABLE users ADD COLUMN pronouns TEXT;
      ALTER TABLE users ADD COLUMN accent_color TEXT;
      ALTER TABLE users ADD COLUMN avatar_id TEXT;
      ALTER TABLE users ADD COLUMN banner_id TEXT;
      -- The status the user picked (synced across devices); presence itself is computed live.
      ALTER TABLE users ADD COLUMN status_preference TEXT NOT NULL DEFAULT 'online'
        CHECK (status_preference IN ('online', 'idle', 'dnd', 'invisible'));
      ALTER TABLE users ADD COLUMN custom_status_text TEXT;
      ALTER TABLE users ADD COLUMN custom_status_emoji TEXT;
      ALTER TABLE users ADD COLUMN custom_status_expires_at INTEGER;
      CREATE INDEX users_custom_status_expiry_idx ON users(custom_status_expires_at)
        WHERE custom_status_expires_at IS NOT NULL;

      -- Processed (re-encoded, metadata-free) profile pictures and banners. Files live under
      -- <attachments dir>/profile/<id[0..2]>/<id>.webp (+ <id>.small.webp).
      CREATE TABLE profile_media (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('avatar', 'banner')),
        width      INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        size       INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX profile_media_user_idx ON profile_media(user_id);

      -- Synced per-account preferences (theme, accent, density…), validated JSON.
      CREATE TABLE user_preferences (
        user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    // Milestone 10 (friends, blocks, direct and group conversations). Additive only.
    // Conversations reuse the whole message stack (messages, attachments, reactions, pins,
    // read states, search): each one is a row in `channels` under the reserved pseudo-server
    // '@direct', which never has members — access to those channels is decided only by
    // conversation_members (see access.ts). Nothing existing is copied or rewritten.
    version: 5,
    name: 'connections',
    sql: `
      -- Recipients may refuse DMs from people they only share a server with (friends always can).
      ALTER TABLE users ADD COLUMN allow_server_dms INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE friend_requests (
        from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (from_user_id, to_user_id),
        CHECK (from_user_id <> to_user_id)
      );
      CREATE INDEX friend_requests_to_idx ON friend_requests(to_user_id);

      -- One row per friendship, stored with user_a < user_b so a pair can exist only once.
      CREATE TABLE friendships (
        user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_a, user_b),
        CHECK (user_a < user_b)
      );
      CREATE INDEX friendships_b_idx ON friendships(user_b);

      CREATE TABLE user_blocks (
        blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
      );
      CREATE INDEX user_blocks_blocked_idx ON user_blocks(blocked_id);

      -- Reserved container for conversation channels. Never has members or an owner and is
      -- excluded from every server listing.
      INSERT OR IGNORE INTO servers (id, name, color, owner_id, position, created_at)
        VALUES ('@direct', 'Direct Messages', '#000000', NULL, -1, 0);

      -- Security guard, enforced by SQLite itself so it also holds for older server versions
      -- (a code-only rollback): nobody can ever become a member or owner of the container.
      -- Older code that joins "every server" (development sign-in) or claims unowned servers
      -- (create-admin --own-unowned-servers) is silently ignored for it instead of gaining
      -- access to every private conversation.
      DELETE FROM server_members WHERE server_id = '@direct';
      CREATE TRIGGER direct_no_members_insert BEFORE INSERT ON server_members
        WHEN NEW.server_id = '@direct' BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER direct_no_members_update BEFORE UPDATE OF server_id ON server_members
        WHEN NEW.server_id = '@direct' BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER direct_no_owner BEFORE UPDATE OF owner_id ON servers
        WHEN NEW.id = '@direct' AND NEW.owner_id IS NOT NULL BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER direct_no_invites BEFORE INSERT ON server_invites
        WHEN NEW.server_id = '@direct' BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER direct_not_deleted BEFORE DELETE ON servers
        WHEN OLD.id = '@direct' BEGIN SELECT RAISE(ABORT, 'the conversation container cannot be deleted'); END;

      CREATE TABLE conversations (
        channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
        -- 'userA:userB' (sorted) for one-to-one conversations: one canonical DM per pair.
        dm_key     TEXT UNIQUE,
        name       TEXT,
        owner_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
      );

      -- Current members only (leaving or removal deletes the row). history_from is the newest
      -- message id that existed when the member joined: they can see only later messages.
      CREATE TABLE conversation_members (
        channel_id   TEXT NOT NULL REFERENCES conversations(channel_id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at    INTEGER NOT NULL,
        history_from INTEGER NOT NULL DEFAULT 0,
        -- Hidden from this member's list until the next message arrives.
        closed       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE INDEX conversation_members_user_idx ON conversation_members(user_id);

      -- Membership history of group conversations (who added/removed/left, renames).
      CREATE TABLE conversation_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id     TEXT NOT NULL REFERENCES conversations(channel_id) ON DELETE CASCADE,
        at             INTEGER NOT NULL,
        actor_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
        action         TEXT NOT NULL,
        target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        detail         TEXT
      );
      CREATE INDEX conversation_events_channel_idx ON conversation_events(channel_id, id);
    `
  },
  {
    // Milestone 13 (email accounts). Additive only: new nullable/defaulted columns and new
    // tables. Rollback to Milestone 11/12 code: first remove unconfirmed self-registrations
    // (DELETE FROM users WHERE signup_pending = 1), because older code doesn't know that
    // they must not sign in. Everything else is ignored by older code.
    version: 6,
    name: 'email_accounts',
    sql: `
      -- Normalized (lower-case) address. Unique across accounts. Confirmed when
      -- email_verified_at is set; a self-registered account keeps signup_pending = 1 (and
      -- cannot sign in) until its address is confirmed.
      ALTER TABLE users ADD COLUMN email TEXT;
      ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
      ALTER TABLE users ADD COLUMN signup_pending INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX users_email_idx ON users(email) WHERE email IS NOT NULL;

      -- One-time codes sent by email: confirm an address ('verify') or reset a password
      -- ('reset'). Only the SHA-256 verifier is stored. At most one open code per user and
      -- purpose; wrong guesses are counted and a code dies after too many.
      CREATE TABLE email_codes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
        -- The address the code was sent to (for 'verify': the address being confirmed).
        email      TEXT NOT NULL,
        code_hash  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        used_at    INTEGER
      );
      CREATE UNIQUE INDEX email_codes_open_idx ON email_codes(user_id, purpose) WHERE used_at IS NULL;
    `
  },
  {
    // Milestone 13 (server administration). Additive only: new nullable/defaulted columns, two
    // new tables and two triggers, so older code keeps working on a migrated database (it
    // ignores them; the triggers only maintain timeout data it doesn't read).
    // The one data change grants the new Moderate Members bit (1 << 16 = 65536) to configured
    // roles that can already kick (1 << 12 = 4096); older code masks unknown bits out.
    // Rollback to pre-13 code: nothing to undo (timeouts and icons are simply not enforced/shown).
    version: 7,
    name: 'server_admin',
    sql: `
      ALTER TABLE servers ADD COLUMN description TEXT;
      ALTER TABLE servers ADD COLUMN icon_id TEXT;
      ALTER TABLE servers ADD COLUMN default_notifications TEXT NOT NULL DEFAULT 'all'
        CHECK (default_notifications IN ('all', 'mentions'));

      -- Voice channels: most participants at once (0 = no limit).
      ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 0
        CHECK (user_limit BETWEEN 0 AND 99);

      -- Timed out until (epoch ms): read-only in the server until then. NULL = not timed out.
      ALTER TABLE server_members ADD COLUMN timeout_until INTEGER;
      CREATE INDEX server_members_timeout_idx ON server_members(timeout_until)
        WHERE timeout_until IS NOT NULL;

      -- Timeouts outlive membership: leaving (or being kicked or banned) and coming back
      -- doesn't end one. A removed member's running timeout is parked here and a new
      -- membership row for the same person picks it up. Triggers, so every way of joining is
      -- covered. No foreign keys: rows parked while a server or account is deleted simply
      -- expire and are swept with the timeouts.
      CREATE TABLE server_timeout_holds (
        server_id TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        until     INTEGER NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );
      CREATE TRIGGER server_members_park_timeout AFTER DELETE ON server_members
        WHEN OLD.timeout_until IS NOT NULL
          AND OLD.timeout_until > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      BEGIN
        INSERT OR REPLACE INTO server_timeout_holds (server_id, user_id, until)
          VALUES (OLD.server_id, OLD.user_id, OLD.timeout_until);
      END;
      CREATE TRIGGER server_members_restore_timeout AFTER INSERT ON server_members
        WHEN EXISTS (SELECT 1 FROM server_timeout_holds
                     WHERE server_id = NEW.server_id AND user_id = NEW.user_id)
      BEGIN
        UPDATE server_members SET timeout_until = (
            SELECT until FROM server_timeout_holds
            WHERE server_id = NEW.server_id AND user_id = NEW.user_id)
          WHERE server_id = NEW.server_id AND user_id = NEW.user_id AND role != 'owner';
        DELETE FROM server_timeout_holds WHERE server_id = NEW.server_id AND user_id = NEW.user_id;
      END;

      -- Processed (re-encoded WebP) server icons. Files live under
      -- <attachments dir>/server-icons/<id[0..2]>/<id>.webp (+ <id>.small.webp).
      CREATE TABLE server_icons (
        id         TEXT PRIMARY KEY,
        server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        size       INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX server_icons_server_idx ON server_icons(server_id);

      UPDATE server_role_permissions SET permissions = permissions | 65536
        WHERE (permissions & 4096) = 4096;
    `
  },
  {
    // Milestone 13 (large files). Additive only. Large files (over the ephemeral threshold)
    // get expires_at; when it passes, the bytes are deleted and expired_at is set — the
    // message and the attachment row stay ("File expired"). Upload sessions track chunked,
    // resumable uploads in progress (their bytes live in <attachments>/uploads/<id>.part).
    // Rollback to older code: it ignores both; an expired file then answers "file missing".
    version: 8,
    name: 'large_files',
    sql: `
      ALTER TABLE attachments ADD COLUMN expires_at INTEGER;
      ALTER TABLE attachments ADD COLUMN expired_at INTEGER;
      CREATE INDEX attachments_expiry_idx ON attachments(expires_at)
        WHERE expires_at IS NOT NULL AND expired_at IS NULL;

      CREATE TABLE upload_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        filename     TEXT NOT NULL,
        content_type TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('image', 'file')),
        size         INTEGER NOT NULL CHECK (size > 0),
        received     INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= size),
        -- 1 = over the ephemeral threshold (counts against the large-file pool).
        ephemeral    INTEGER NOT NULL DEFAULT 0 CHECK (ephemeral IN (0, 1)),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX upload_sessions_user_idx ON upload_sessions(user_id);
      CREATE INDEX upload_sessions_updated_idx ON upload_sessions(updated_at);
    `
  },
  {
    // Milestone 14 (customization). Additive only: the profile style (validated JSON:
    // gradient, decoration, effect, banner preset) and whether the current picture/banner is
    // animated. Rollback to older code: it ignores all three; animated images stay animated
    // (older code serves the stored file as is) and the style simply isn't shown.
    version: 9,
    name: 'profile_customization',
    sql: `
      ALTER TABLE users ADD COLUMN profile_style TEXT;
      ALTER TABLE users ADD COLUMN avatar_animated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN banner_animated INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    // Milestone 14 (soundboard). Additive only: a server's short clips (16-bit PCM WAV files in
    // <attachments>/soundboard/<id>.wav). Deleting a server deletes its rows; the files are
    // swept. Rollback to older code: it ignores the table (the clips just aren't offered).
    version: 10,
    name: 'soundboard',
    sql: `
      CREATE TABLE soundboard_sounds (
        id          TEXT PRIMARY KEY,
        server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        emoji       TEXT,
        uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
        size        INTEGER NOT NULL CHECK (size > 0),
        sha256      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX soundboard_sounds_server_idx ON soundboard_sounds(server_id, created_at);
    `
  },
  {
    // Milestone 14 (saved messages). Additive only: private bookmarks. A deleted message or
    // account takes its rows with it. Rollback to older code: it ignores the table.
    version: 11,
    name: 'saved_messages',
    sql: `
      CREATE TABLE saved_messages (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        saved_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );
      CREATE INDEX saved_messages_user_idx ON saved_messages(user_id, saved_at);
    `
  },
  {
    // Milestone 14 (personal notes). Additive only: a private note one user keeps about another.
    // Rollback to older code: it ignores the table.
    version: 12,
    name: 'user_notes',
    sql: `
      CREATE TABLE user_notes (
        owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note       TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 256),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, target_id)
      );
    `
  }
]

/** Reserved pseudo-server that owns every conversation channel (see migration 5). */
export const DIRECT_SERVER_ID = '@direct'
