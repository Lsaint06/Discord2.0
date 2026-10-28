# Discord 2.0 — Server

Self-hosted backend for Discord 2.0: **Node.js + TypeScript + Fastify + WebSockets**, storing data in **SQLite** (via Node's built-in `node:sqlite`, no native build step) with a planned path to **PostgreSQL**. Voice runs through a self-hosted **LiveKit** SFU; this server only issues LiveKit access tokens and tracks voice presence.

> ⚠️ **Self-hosted.** LAN-only by default. Milestone 11 adds an optional public mode (`docker compose --profile public`): Caddy with free HTTPS on 443 in front of the backend, LiveKit media on 7881/7882. Never expose port 3001 or 7880 directly. Production refuses `DEV_AUTH=true`. See [docs/milestone-11-project-connect.md](../docs/milestone-11-project-connect.md), [docs/milestone-7-security.md](../docs/milestone-7-security.md) and [Development-only capabilities](#development-only-capabilities).

## Requirements

- Node.js **24.7+** (Argon2id comes from Node's built-in `crypto.argon2`; the server refuses to start on older versions)

## Quick start

```powershell
cd server
npm install
npm run dev          # http://127.0.0.1:3001, auto-restarts on file changes
```

On first start the database is created at `server/data/discord2.db`, migrated, and seeded with the starter servers and channels. Data persists across restarts; delete `server/data/` to start fresh.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run from source with auto-reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Integration tests (messaging, persistence, validation, rate limits, voice, accounts, sessions, permissions, invitations, migration) |
| `npm run admin -- <command>` | Local administration CLI (create the first admin, registration/claim/reset codes, legacy migration, integrity check) — see below |
| `npm run bench:argon2` | Time Argon2id parameter sets on this machine |

### Voice locally on Windows (optional)

Voice is off until the four `LIVEKIT_*` variables are set. To develop voice on one PC:

1. Download `livekit_<version>_windows_amd64.zip` from [LiveKit releases](https://github.com/livekit/livekit/releases) and extract `livekit-server.exe` anywhere (not into the repo).
2. In `server/.env` set `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (letters/digits, ≥ 32 chars), `LIVEKIT_URL=http://127.0.0.1:7880`, and `LIVEKIT_PUBLIC_URL=ws://localhost:7880` (the host must match the desktop server profile's host: the CSP and the app's voice-address check only allow that host).
3. Run LiveKit in its own terminal (it reads the credentials from `.env`; nothing secret goes on the command line):

   ```powershell
   cd server
   powershell -ExecutionPolicy Bypass -File scripts\livekit-dev.ps1 -Binary C:\path\to\livekit-server.exe
   ```

4. Start the backend (`npm run dev`); the log shows `Voice enabled (LiveKit)`.

## Configuration

All settings are environment variables. Copy `.env.example` to `.env` (git-ignored); `npm run dev` / `npm start` load it automatically.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Loopback = only this PC can connect. Use a LAN IP / `0.0.0.0` **only on a trusted network**. |
| `PORT` | `3001` | |
| `DATABASE_URL` | `sqlite:./data/discord2.db` | `sqlite:<path>`. `postgres://…` is reserved for the future Postgres repository. |
| `DEV_AUTH` | `true` (dev), `false` (production, and in Docker Compose) | Enables password-less development identities (never for usernames that have a password). Turning it off invalidates every development session. **Refused in production** unless `ALLOW_DEV_AUTH_IN_PRODUCTION=true` is also set. |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | `30` / `90` | Session idle timeout and absolute lifetime. |
| `ARGON2_MEMORY_KIB` / `ARGON2_PASSES` / `ARGON2_PARALLELISM` | `65536` / `3` / `4` | Password hashing cost. Values below the OWASP minimum (19456 / 2 / 1) are refused. |
| `ARGON2_MAX_CONCURRENT` | `2` | Hashes computed at once (each uses `ARGON2_MEMORY_KIB`); extra sign-ins queue, then get `503`. |
| `CORS_ORIGINS` | *(empty)* | Extra allowed browser origins, comma-separated. The desktop app's own origin `app://discord2` is always allowed (`ALLOW_APP_ORIGIN`). |
| `ALLOW_LOCALHOST_ORIGINS` | `true` (dev), `false` (production) | Allows `http://localhost:*` (Electron dev server). |
| `ALLOW_NULL_ORIGIN` | `true` (dev), `false` (production) | Allows the `null` origin sent by desktop apps older than 1.1 (`file://`). Enable in production only while such apps still connect. |
| `TRUST_PROXY` | `false` | Proxies whose `X-Forwarded-For` is believed: IPs, CIDRs or `loopback`/`linklocal`/`uniquelocal`. `true` is refused in production (`/0` always). Compose sets Caddy's fixed address `172.30.0.10`. |
| `LOG_LEVEL` | `debug` (dev), `info` (prod) | Pino log level. |
| `LIVEKIT_API_KEY` | *(empty)* | Voice: LiveKit API key. All four `LIVEKIT_*` must be set together, or none (voice disabled). |
| `LIVEKIT_API_SECRET` | *(empty)* | Voice: ≥ 32 chars. **Server-side only — never put it in the desktop app.** |
| `LIVEKIT_URL` | *(empty)* | Voice: `http(s)://` URL the backend uses for LiveKit's API (compose sets `http://host.docker.internal:7880`, since LiveKit uses host networking). |
| `LIVEKIT_PUBLIC_URL` | *(empty)* | Voice: URL given to clients. `wss://` is required for a public host (e.g. `wss://myhome.duckdns.org`); `ws://` only for private addresses (e.g. `ws://192.168.68.65:7880`). |

The server holds no secrets today. When real secrets arrive (database passwords, signing keys), they belong in the server's environment only — **never** in the desktop app.

## API (v1)

All `/api/*` routes except `/api/meta` and `/api/dev/login` require `Authorization: Bearer <token>`. Errors use `{ "error": { "code", "message", "retryAfterMs?" } }`.

| Method & path | Description |
| --- | --- |
| `GET /health` | Liveness probe |
| `GET /api/meta` | Server name, API version (`3`), whether dev sign-in is enabled, `accounts: true`, `registration: "invite"`, `profiles: true` |
| `POST /api/dev/login` `{ username }` | **Dev only** (`DEV_AUTH`). Get-or-create a user without a password; refused for accounts that have one |
| `GET /api/users/me` | Current user (including `instanceAdmin`, `hasPassword`) |
| `PATCH /api/users/me` `{ displayName?, avatarColor?, bio?, pronouns?, accentColor? }` | Update profile (sent to people who share a server; see Milestone 8 below) |
| `GET /api/users` | Users who share a server with you, with presence |
| `GET /api/servers` | Servers you are a member of, with the channels you can view, your role and effective permissions |
| `POST /api/servers` `{ name, color }` | Create a server with `#general` + `Lounge`; you become its owner |
| `GET /api/servers/:serverId/channels` | Channels of one server |
| `GET /api/channels/:channelId/messages?before=&after=&around=&limit=` | Message history, oldest→newest. Cursor = message id; `around` returns a window centred on a message (jump to message); `limit` ≤ 100 (default 50) |
| `POST /api/channels/:channelId/messages` `{ content, nonce?, replyToId?, attachmentIds? }` | Send a message (broadcasts `message_create`). `content` may be empty when attachments are included; `replyToId` must be in the same channel |
| `PATCH /api/channels/:channelId/messages/:messageId` `{ content, expectedEditedAt? }` | Edit your own message (`403` otherwise, `409` if it changed meanwhile). Broadcasts `message_update` |
| `DELETE /api/channels/:channelId/messages/:messageId` | Delete your own message and its attachment files. Broadcasts `message_delete` |
| `PUT`/`DELETE /api/channels/:channelId/messages/:messageId/reactions/:emoji` | Add/remove your reaction (idempotent). Broadcasts `reaction_update` with the authoritative count |
| `GET /api/channels/:channelId/pins` · `PUT`/`DELETE …/pins/:messageId` | List / pin / unpin (≤ 50 pins per channel). Broadcasts `pin_update` |
| `POST /api/channels/:channelId/attachments` (multipart) | Upload files before sending; returns pending attachments that only the uploader can see until a message claims them |
| `GET /api/attachments/:attachmentId[?download=1]` | Download (authenticated; images inline, everything else as a download) |
| `DELETE /api/attachments/:attachmentId` | Cancel an unsent upload |
| `GET /api/read-states` · `PUT /api/channels/:channelId/read` `{ messageId }` | Unread state per channel; mark read (moves forward only). Broadcasts `read_state_update` to your own sessions |
| `GET /api/search?q=&channelId=\|serverId=&authorId=&since=&until=&before=&limit=` | Full-text search (SQLite FTS5), newest first, `limit` ≤ 25, paginate with `nextBefore`. Without `channelId` it covers server channels only; pass a conversation's id to search inside it |
| `POST /api/voice/channels/:channelId/token` | Voice: `{ url, token, room, identity, expiresAt }` for one voice channel (see below) |
| `GET /api/voice/states` | Voice: who is in which voice channel `[{ userId, channelId }]` |
| `POST /api/livekit/webhook` | LiveKit → backend only. Verified with LiveKit's signed `Authorization` header |

Every channel and message route requires membership of the channel's server — or, for a conversation, membership of the conversation — (otherwise **404**) and the matching permission (otherwise **403**): View Channel to read, Send Messages / Attach Files / Add Reactions to write, Pin Messages to pin, Manage Messages to delete other people's messages. Request bodies with unknown fields are rejected (`400`).

### Profiles, status and preferences (Milestone 8)

Full design, image security and limits: [docs/milestone-8-identity.md](../docs/milestone-8-identity.md).

| Method & path | Description |
| --- | --- |
| `PUT /api/users/me/status` `{ status?, customStatus?: { text?, emoji?, expiresInMs? } \| null }` | Status preference (synced across your devices) and custom status (1 min–7 days expiry, or none) |
| `POST`/`DELETE /api/users/me/avatar` · `/api/users/me/banner` | Upload one image (multipart, ≤ 10 MB, PNG/JPEG/WebP/GIF by content) / remove. Re-encoded to metadata-free WebP |
| `GET /api/profile-media/:id?size=full\|small` | Processed image; only for people who can see its owner |
| `GET /api/users/:userId/profile` | `{ user, mutualServerIds, relationship }` (404 unless you can see the user; `relationship` is only ever `blocked` for the person who blocked) |
| `GET`/`PATCH /api/users/me/preferences` | Synced appearance preferences (theme, accent, density, reduced motion, timestamps, idle timeout) |
| `DELETE /api/admin/accounts/:userId/profile-media/:kind` | Instance administrators: remove a picture/banner (audited) |

### Friends, blocking and conversations (Milestone 10)

Full design, privacy rules and migration: [docs/milestone-10-connections.md](../docs/milestone-10-connections.md). A conversation's id is also a channel id, so its messages, attachments, reactions, pins, read state and search use the channel routes above (with a per-member history boundary).

| Method & path | Description |
| --- | --- |
| `GET /api/relationships` | Your friends, incoming/outgoing requests and the people you blocked |
| `POST /api/relationships/requests` `{ username }` | Friend request by exact username. Unknown, bot, disabled and blocking accounts all get the same `404 friend_request_failed`. A mutual request becomes a friendship at once |
| `POST /api/relationships/:userId/accept` | Accept a pending request |
| `DELETE /api/relationships/:userId` | Remove a friend, cancel your request or decline theirs |
| `PUT`/`DELETE /api/relationships/:userId/block` | Block (also ends any friendship or request) / unblock. Never revealed to the blocked person |
| `PATCH /api/users/me/privacy` `{ allowServerDms }` | Whether people you share a server with (not friends) may DM you |
| `GET /api/conversations` | Your open conversations (`ApiConversation[]`, newest activity first) |
| `POST /api/conversations/dm` `{ userId }` | Open the one DM with someone (created if needed; reopened if you closed it) |
| `POST /api/conversations/group` `{ userIds, name? }` | New group with 2–9 of your friends (3–10 people in total) |
| `PATCH /api/conversations/:id` `{ name }` | Rename a group (any member) |
| `POST /api/conversations/:id/members` `{ userId }` · `DELETE …/members/:userId` | Add one of your friends (any member) · remove someone (owner only) |
| `POST /api/conversations/:id/leave` · `POST …/close` | Leave a group · hide a conversation until its next message |
| `GET /api/conversations/:id/events` | Membership history since you joined |

### Accounts and sessions (Milestone 7)

Codes and passwords are always sent in request bodies, never in URLs. Full design: [docs/milestone-7-security.md](../docs/milestone-7-security.md).

| Method & path | Description |
| --- | --- |
| `POST /api/auth/invite-info` `{ code }` | What a registration or claim code does (e.g. "claims @name") |
| `POST /api/auth/register` `{ code, username, displayName?, password, device? }` | Create an account with a registration code, or claim a development identity with a claim code. Returns a session and 10 recovery codes (shown once) |
| `POST /api/auth/login` `{ username, password, device? }` | Sign in. Generic `401` for unknown users and wrong passwords |
| `POST /api/auth/logout` | Revoke the current session |
| `POST /api/auth/logout-all` `{ keepCurrent? }` | Revoke all (or all other) sessions |
| `GET /api/auth/sessions` · `DELETE /api/auth/sessions/:sessionId` | List your devices · revoke one |
| `POST /api/auth/password` `{ currentPassword, newPassword }` | Change password; revokes other sessions |
| `GET`/`POST /api/auth/recovery-codes` | Remaining count · regenerate (`{ password }`) |
| `POST /api/auth/recover` `{ username, code, newPassword }` | Reset the password with a recovery code or an administrator reset code; revokes every session |

### Servers, members and invitations (Milestone 7)

| Method & path | Permission |
| --- | --- |
| `GET /api/servers/:serverId` · `GET …/channels` | Member |
| `PATCH /api/servers/:serverId` `{ name?, color? }` | Manage Server |
| `POST /api/servers/:serverId/channels` · `PATCH`/`DELETE /api/channels/:channelId` | Manage Channels |
| `GET /api/channels/:channelId/overrides` · `PUT …/overrides/:role` `{ allow, deny }` | Manage Channels |
| `GET /api/servers/:serverId/members` | Member |
| `PATCH /api/servers/:serverId/members/:userId` `{ role }` | Manage Roles (only below your own role) |
| `DELETE /api/servers/:serverId/members/:userId` | Kick Members (only below your own role) |
| `POST /api/servers/:serverId/leave` | Member (not the owner) |
| `GET …/bans` · `PUT`/`DELETE …/bans/:userId` | Ban Members |
| `GET …/roles` · `PUT …/roles/:role` `{ permissions \| null }` | Manage Roles (roles below yours; only bits you hold; `null` resets) |
| `POST …/transfer` `{ userId, password }` | Owner |
| `GET …/audit` | Manage Server (no IP addresses) |
| `POST`/`GET …/invites` · `DELETE …/invites/:inviteId` | Create Invites · Manage Invites (or the creator) |
| `POST /api/invites/preview` · `POST /api/invites/accept` `{ code }` | Signed in; banned users are refused |

### Instance administration (Milestone 7)

Password sessions of an instance administrator only. Actions that issue codes or disable accounts require `password` in the body.

| Method & path | Description |
| --- | --- |
| `GET /api/admin/accounts` | All accounts |
| `GET`/`POST /api/admin/registration-invites` · `DELETE …/:inviteId` | Registration codes (optionally joining a server) |
| `GET /api/admin/legacy` · `POST /api/admin/legacy/:userId/claim-code` | Development identities without a password · issue a claim code |
| `POST /api/admin/accounts/:userId/reset-code` | One-time 24 h password reset code |
| `POST /api/admin/accounts/:userId/disabled` `{ disabled, password }` | Disable/enable (revokes sessions, disconnects voice) |
| `GET /api/admin/audit` | Security event log, including IP addresses |

### Administration CLI

Run on the server host (it is the root of trust). Passwords are prompted without echo, or read as one line from stdin.

```powershell
npm run admin -- create-admin --username <name> [--display-name <n>] [--own-unowned-servers]
npm run admin -- registration-invite [--server <serverId>] [--hours 72]
npm run admin -- legacy list
npm run admin -- legacy claim-code <username>
npm run admin -- legacy merge <legacyUsername> <accountUsername> [--apply]   # dry run without --apply
npm run admin -- promote <username> · reset-code <username> · revoke-sessions <username>
npm run admin -- set-owner <serverId> <username> · verify · status
```

In Docker: `docker compose exec server node dist/cli/admin.js <command>`.

### Voice tokens

`POST /api/voice/channels/:channelId/token` requires a session and:

- validates the channel exists, is a **voice** channel, and that the user is a member of its server with **Connect** in that channel (non-members and bots get `404`, missing Connect `403`);
- signs a LiveKit JWT with the server-held secret: identity = the session's user id (any client-supplied identity is ignored), room = `voice_<channelId>`, `roomJoin` only (no admin), publish restricted to `microphone` (needs **Speak**) and `screen_share` + `screen_share_audio` (needs **Stream**) (never camera; no data channel), **5-minute TTL** (LiveKit refreshes it for live sessions; reconnects request a new one);
- is rate limited (10 burst, ~1 per 3 s per user); returns `503 voice_unavailable` when LiveKit isn't configured.

Allowed sources live in `VOICE_PUBLISH_SOURCES` in [`src/voice/access.ts`](src/voice/access.ts). Screen-share presence (`streaming`) comes from LiveKit `track_published` / `track_unpublished` webhooks plus the 30 s reconciliation. See [docs/screen-sharing-jetson.md](../docs/screen-sharing-jetson.md).

### Real-time gateway (`GET /gateway`, WebSocket)

JSON frames `{ op, d }`. Types live in [`src/protocol.ts`](src/protocol.ts) (mirrored in the desktop app).

1. Server → `hello { heartbeatIntervalMs }`
2. Client → `identify { token, idle? }` (token sent in a frame, never in the URL, so it can't leak into logs; `idle` = this device is already idle)
3. Server → `ready { user, users, voiceStates }`
4. Client → `heartbeat` every interval; server → `heartbeat_ack`. No traffic for 60 s ⇒ server closes the socket.
5. Server pushes, only to users who can view the channel or server, `message_create`, `message_update`, `message_delete`, `reaction_update`, `pin_update`, `read_state_update` (only to that user's own sessions), `user_update` (profile + presence, to people who share a server; only when what they see changes), `me_update` (your account: status preference, profile — your own sessions), `preferences_update` (synced preferences — your own sessions), `server_create` (to the creator), `server_update` (membership, role or permission change — refetch), `server_remove` (kicked, banned, left or deleted), `voice_state_update { userId, channelId | null, streaming? }` (from LiveKit webhooks, reconciled with LiveKit every 30 s; `streaming: true` while the user is screen sharing), `relationship_update { userId, type | null }` (your own sessions), `conversation_update` (a conversation you belong to was created, changed or reopened — each member gets their own view), `conversation_remove { channelId, reason }` (left, removed, or closed on another of your devices). Message events in a conversation go only to its current members, and events about one message skip members who joined after it.
6. Client may send `set_idle { idle }` (automatic idle detection on this device) and `set_status { status: online|idle|dnd|invisible }` (saved on the account; `PUT /api/users/me/status` is preferred).

Close codes: `4001` auth failed or session revoked/expired (don't reconnect), `4002` identify timeout, `4003` invalid frame, `4004` heartbeat timeout, `4008` rate limited, `4010` server shutdown.

Messages are **sent over REST** (clear status codes, validation, rate limiting) and **delivered over the gateway**. The sender's `nonce` is echoed so its optimistic copy can be reconciled.

## Validation and abuse limits

- Strict JSON schemas (`additionalProperties: false`, no type coercion), 16 KB body limit, 4 KB WebSocket frame limit.
- Message content: trimmed, CR/LF normalized, control and bidi-override characters stripped, 1–2000 characters (0 allowed with attachments), text channels only.
- Attachments: extension allowlist checked against the file's magic bytes, size/pixel limits, per-user and total quotas, minimum free disk space. Details: [docs/messaging-2-jetson.md](../docs/messaging-2-jetson.md).
- Usernames `[a-z0-9_.-]{2,32}`; display names 1–32; server names 1–40; colors `#rrggbb`.
- Rate limits (in-memory token buckets):

| Scope | Burst | Sustained |
| --- | --- | --- |
| Any `/api` request, per IP | 120 | 20/s |
| Sign-in (password or dev), per IP | 10 | 1 per 10 s |
| Sign-in, per attempted username | 5 | 1/min |
| Registration, per IP | 5 | 1/min |
| Recovery, per IP · per account | 5 · 5 | 1/min · 1 per 5 min |
| Account actions (password, sessions, recovery codes), per user | 10 | 1 per 30 s |
| Instance administration, per user | 30 | 1 per 2 s |
| Invite creation · invite preview/accept, per user | 10 · 10 | 1 per 30 s · 1 per 30 s |
| Moderation (roles, kicks, bans, channels, overrides), per user | 30 | 1/s |
| Messages, per user | 5 | 1/s |
| Edits and deletes, per user | 10 | 1/s |
| Reactions, per user | 20 | 4/s |
| Pins, per user | 10 | 1 per 2 s |
| Upload requests, per user | 10 | 1 per 2 s |
| Searches, per user | 10 | 1/s |
| Read acknowledgements, per user | 60 | 10/s |
| Server creation, per user | 3 | 1/min |
| Profile updates, per user | 10 | 1 per 5 s |
| Profile image uploads/removals, per user | 6 | 1 per 10 s |
| Status, custom status and preference changes, per user | 20 | 1 per 2 s |
| Profile lookups and profile image downloads, per user | 300 | 20/s |
| Gateway connections, per IP | 10 | 1 per 2 s |
| Gateway frames, per connection | 20 | 2/s (excess ⇒ close `4008`) |
| Voice tokens, per user | 10 | 1 per 3 s |
| Friend requests, per user | 10 | 1/min |
| Accept / decline / remove / block / unblock / privacy, per user | 30 | 1 per 2 s |
| Opening DMs and creating groups, per user | 20 | 1 per 2 s |
| Group changes (add, remove, rename, leave, close), per user | 20 | 1 per 2 s |

- Browser requests from origins not on the allow-list are rejected with `403` (REST and WebSocket upgrade).
- All SQL uses bound parameters; no query is built from user input.

## Development-only capabilities

| Capability | Status after Milestone 7 | Before remote access / production |
| --- | --- | --- |
| `POST /api/dev/login` (`DEV_AUTH`) | Still on by default so existing identities keep working during migration. Refused for any username with a password; dev sessions are marked and all stop working when `DEV_AUTH=false` | Migrate everyone ([procedure](../docs/milestone-7-security.md#lan-migration-procedure)), then set `DEV_AUTH=false` |
| New dev identities join every server | Development convenience only | Disappears with `DEV_AUTH=false`; real accounts join via invitations |
| Plain `http://` / `ws://` (API and LiveKit signaling) | Unencrypted on the LAN (LiveKit media is still DTLS-SRTP) | Use WireGuard/Tailscale or terminate TLS — see [docs/remote-access-options.md](../docs/remote-access-options.md) |
| In-memory rate limits & presence | Reset on restart; single process only | Fine for one Jetson; use Redis if ever scaled out |

**Fixed in Milestone 7** (previously listed here): tokens in `localStorage` (now encrypted with `safeStorage` in the main process), sessions that never expired (idle + absolute expiry, revocation closes live sockets), every user in every server (membership, roles, channel permissions), voice and attachments open to anyone signed in (permission-checked grants and downloads), and realtime events broadcast to everyone (now scoped to people who can see them).

Even in development the server never trusts a client-supplied user id: the user is always derived from the session token, whose SHA-256 hash is what's stored.
## Docker (Linux ARM64 / Jetson)

`docker-compose.yml` runs the backend **and** the LiveKit SFU (`livekit/livekit-server`, multi-arch). Both images run natively on ARM64 (`node:sqlite` and Argon2id are built into Node; image processing uses `sharp`, whose prebuilt `linux-arm64` libvips binary is installed by `npm ci` — nothing is compiled, and the image build fails early if it's missing). Full Jetson walkthrough — credentials, firewall, monitoring, troubleshooting: [docs/voice-deployment-jetson.md](../docs/voice-deployment-jetson.md).

```bash
cd server
cp .env.example .env && chmod 600 .env   # set LIVEKIT_*, LIVEKIT_NODE_IP, BIND_ADDRESS
docker compose up -d --build              # data persists in the discord2-data volume
docker compose ps                         # livekit becomes "healthy"
curl http://127.0.0.1:3001/health
```

By default the backend is published on **127.0.0.1 only**; set `BIND_ADDRESS` (and `LIVEKIT_NODE_IP`) to the host's LAN IP in `.env` so other PCs on your LAN can connect. Since Milestone 11, LiveKit uses **host networking**: its ports 7880/7881/7882 listen on the host's interfaces. Keep them off the router (only 7881/7882 are forwarded in public mode, never 7880), and see the firewall notes in [docs/milestone-11-project-connect.md](../docs/milestone-11-project-connect.md#jetson-production-checklist).

Build an ARM64 image from a Windows/x64 machine (requires Docker Buildx + QEMU):

```bash
docker buildx build --platform linux/arm64 -t discord2-server:arm64 --load .
```

> The images have not been built on this Windows development PC (Docker isn't installed here). The Milestone 11 compose file was validated by parsing it and rendering the LiveKit configuration for both modes; the Caddyfile was validated with Caddy 2.11.7 and run locally. The new LiveKit configuration has **not** been run (Windows Smart App Control blocked the LiveKit binary on this PC). Verify on the Jetson with the commands above.

**Public mode (Milestone 11):** `docker compose --profile public up -d` adds Caddy (free Let's Encrypt certificates) and switches LiveKit to host networking so it can offer both LAN and public addresses. Forward only 80/tcp, 443/tcp, 7881/tcp and 7882/udp. Never forward 22, 3001 or 7880. Setup, DuckDNS, backup and rollback: [docs/milestone-11-project-connect.md](../docs/milestone-11-project-connect.md).

## Migrating to PostgreSQL

Storage is behind the async [`Repository`](src/db/repository.ts) interface; routes never touch SQL directly.

1. Add a `PostgresRepository` implementing `Repository` with the `pg` driver (`$1, $2…` parameters).
2. Port [`migrations.ts`](src/db/migrations.ts) — the header comment lists the type changes (`INTEGER` epoch → `BIGINT`, `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`, `0/1` → `BOOLEAN`). Search uses an SQLite FTS5 table kept in sync by triggers; on PostgreSQL use a generated `tsvector` column with a GIN index instead (`searchMessages` is the only query that changes).
3. Handle `postgres://` in `createRepository()` and set `DATABASE_URL`.
4. Copy data with a one-off script that reads via `SqliteRepository` and writes via `PostgresRepository`.

Message ids are already exposed as decimal strings, so clients won't notice the switch.
