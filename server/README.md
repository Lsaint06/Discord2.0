# Discord 2.0 — Server

Self-hosted backend for Discord 2.0: **Node.js + TypeScript + Fastify + WebSockets**, storing data in **SQLite** (via Node's built-in `node:sqlite`, no native build step) with a planned path to **PostgreSQL**.

> ⚠️ **Development-stage software.** Sign-in uses password-less *development identities*. Run it on your own PC or a trusted LAN only — never expose it directly to the internet. See [Development-only capabilities](#development-only-capabilities).

## Requirements

- Node.js **22.13+** (24 recommended)

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
| `npm test` | Integration tests (two users, real-time delivery, persistence, validation, rate limits) |

## Configuration

All settings are environment variables. Copy `.env.example` to `.env` (git-ignored); `npm run dev` / `npm start` load it automatically.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Loopback = only this PC can connect. Use a LAN IP / `0.0.0.0` **only on a trusted network**. |
| `PORT` | `3001` | |
| `DATABASE_URL` | `sqlite:./data/discord2.db` | `sqlite:<path>`. `postgres://…` is reserved for the future Postgres repository. |
| `DEV_AUTH` | `true` (dev), `false` (production) | Enables password-less development identities. |
| `CORS_ORIGINS` | *(empty)* | Extra allowed browser origins, comma-separated. |
| `ALLOW_LOCALHOST_ORIGINS` | `true` (dev), `false` (production) | Allows `http://localhost:*` (Electron dev server). |
| `ALLOW_NULL_ORIGIN` | `true` | Allows the `null` origin sent by the packaged Electron app (`file://`). |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy you control. |
| `LOG_LEVEL` | `debug` (dev), `info` (prod) | Pino log level. |

The server holds no secrets today. When real secrets arrive (database passwords, signing keys), they belong in the server's environment only — **never** in the desktop app.

## API (v1)

All `/api/*` routes except `/api/meta` and `/api/dev/login` require `Authorization: Bearer <token>`. Errors use `{ "error": { "code", "message", "retryAfterMs?" } }`.

| Method & path | Description |
| --- | --- |
| `GET /health` | Liveness probe |
| `GET /api/meta` | Server name, API version, whether dev sign-in is enabled |
| `POST /api/dev/login` `{ username }` | **Dev only.** Get-or-create a user and return `{ token, user }` |
| `GET /api/users/me` | Current user |
| `PATCH /api/users/me` `{ displayName?, avatarColor? }` | Update profile (broadcasts `user_update`) |
| `GET /api/users` | All users with presence |
| `GET /api/servers` | Servers with their channels |
| `POST /api/servers` `{ name, color }` | Create a server with `#general` + `Lounge` (broadcasts `server_create`) |
| `GET /api/servers/:serverId/channels` | Channels of one server |
| `GET /api/channels/:channelId/messages?before=&after=&limit=` | Message history, oldest→newest. Cursor = message id; `limit` ≤ 100 (default 50) |
| `POST /api/channels/:channelId/messages` `{ content, nonce? }` | Send a message (broadcasts `message_create`) |

### Real-time gateway (`GET /gateway`, WebSocket)

JSON frames `{ op, d }`. Types live in [`src/protocol.ts`](src/protocol.ts) (mirrored in the desktop app).

1. Server → `hello { heartbeatIntervalMs }`
2. Client → `identify { token }` (token sent in a frame, never in the URL, so it can't leak into logs)
3. Server → `ready { user, users }`
4. Client → `heartbeat` every interval; server → `heartbeat_ack`. No traffic for 60 s ⇒ server closes the socket.
5. Server pushes `message_create`, `user_update` (profile + presence), `server_create`.
6. Client may send `set_status { status: online|idle|dnd|invisible }`.

Close codes: `4001` auth failed (don't reconnect), `4002` identify timeout, `4003` invalid frame, `4004` heartbeat timeout, `4008` rate limited, `4010` server shutdown.

Messages are **sent over REST** (clear status codes, validation, rate limiting) and **delivered over the gateway**. The sender's `nonce` is echoed so its optimistic copy can be reconciled.

## Validation and abuse limits

- Strict JSON schemas (`additionalProperties: false`, no type coercion), 16 KB body limit, 4 KB WebSocket frame limit.
- Message content: trimmed, CR/LF normalized, control and bidi-override characters stripped, 1–2000 characters, text channels only.
- Usernames `[a-z0-9_.-]{2,32}`; display names 1–32; server names 1–40; colors `#rrggbb`.
- Rate limits (in-memory token buckets):

| Scope | Burst | Sustained |
| --- | --- | --- |
| Any `/api` request, per IP | 120 | 20/s |
| Dev sign-in, per IP | 10 | 1 per 10 s |
| Messages, per user | 5 | 1/s |
| Server creation, per user | 3 | 1/min |
| Profile updates, per user | 10 | 1 per 5 s |
| Gateway connections, per IP | 10 | 1 per 2 s |
| Gateway frames, per connection | 20 | 2/s (excess ⇒ close `4008`) |

- Browser requests from origins not on the allow-list are rejected with `403` (REST and WebSocket upgrade).
- All SQL uses bound parameters; no query is built from user input.

## Development-only capabilities

| Capability | Why it is dev-only | Before production |
| --- | --- | --- |
| `POST /api/dev/login` (`DEV_AUTH`) | No password: anyone who can reach the server can act as any user | Replace with real accounts (passwords/passkeys + invites) and set `DEV_AUTH=false` |
| Desktop stores the session token in `localStorage` | Readable by any script running in the renderer | Keep tokens in the main process with Electron `safeStorage` |
| Plain `http://` / `ws://` | Traffic is unencrypted | Terminate TLS (`https://` / `wss://`) at a reverse proxy |
| Sessions never expire | Stolen tokens stay valid | Add expiry, rotation, and a sign-out-everywhere endpoint |
| Every user is a member of every server | No permissions model yet | Membership, roles, and per-channel permissions |
| In-memory rate limits & presence | Reset on restart; single process only | Fine for one Jetson; use Redis if ever scaled out |

Even in development the server never trusts a client-supplied user id: the user is always derived from the session token, whose SHA-256 hash is what's stored.

## Docker (Linux ARM64 / Jetson)

The image is multi-arch and needs no native compilation (`node:sqlite` is built into Node).

```bash
cd server
docker compose up -d --build          # data persists in the discord2-data volume
curl http://127.0.0.1:3001/health
```

By default the port is published on **127.0.0.1 only**. To let other PCs on your trusted LAN connect, set `BIND_ADDRESS` to the host's LAN IP:

```bash
BIND_ADDRESS=192.168.1.50 docker compose up -d
```

Build an ARM64 image from a Windows/x64 machine (requires Docker Buildx + QEMU):

```bash
docker buildx build --platform linux/arm64 -t discord2-server:arm64 --load .
```

> The Dockerfile has not yet been built on this development PC (Docker isn't installed here); verify on the Jetson with the commands above.

Do **not** port-forward this server on your router. For remote friends, prefer a private overlay network (e.g. WireGuard/Tailscale) or a TLS reverse proxy once real authentication exists.

## Migrating to PostgreSQL

Storage is behind the async [`Repository`](src/db/repository.ts) interface; routes never touch SQL directly.

1. Add a `PostgresRepository` implementing `Repository` with the `pg` driver (`$1, $2…` parameters).
2. Port [`migrations.ts`](src/db/migrations.ts) — the header comment lists the type changes (`INTEGER` epoch → `BIGINT`, `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`, `0/1` → `BOOLEAN`).
3. Handle `postgres://` in `createRepository()` and set `DATABASE_URL`.
4. Copy data with a one-off script that reads via `SqliteRepository` and writes via `PostgresRepository`.

Message ids are already exposed as decimal strings, so clients won't notice the switch.
