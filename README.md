# Discord 2.0

A self-hosted, Discord-inspired chat app for friends: an **Electron + React + TypeScript** desktop client and a **Node.js + Fastify + WebSocket** backend that you run yourself (eventually on an NVIDIA Jetson Orin Nano).

| Folder | What it is |
| --- | --- |
| [`desktop/`](desktop/) | Electron desktop client |
| [`server/`](server/) | Backend API + real-time gateway ([server README](server/README.md)) |
| [`docs/`](docs/) | Design notes |

**Status — Milestone 2:** real-time text messaging between multiple clients, persistent history (SQLite), presence, server creation. Voice is still simulated in the UI.

> ⚠️ Sign-in currently uses **development identities** (no password). Keep the server on your own PC or a trusted LAN. Details: [server/README.md → Development-only capabilities](server/README.md#development-only-capabilities).

## Run it (two terminals)

Requires Node.js 22.13+ (24 recommended). First time only: `npm install` in both `server/` and `desktop/`.

> If PowerShell blocks `npm` ("running scripts is disabled"), use `npm.cmd` instead of `npm`.

**Terminal 1 — backend**

```powershell
cd server
npm run dev
```

Wait for `Server listening at http://127.0.0.1:3001`.

**Terminal 2 — desktop app**

```powershell
cd desktop
npm run dev
```

Pick a username on the sign-in screen (e.g. `alice`) and you're in.

### Pointing the app at another server

The desktop app reads the backend URL from `RENDERER_VITE_SERVER_URL` at build time (default for `npm run dev`: `http://localhost:3001`, set in `desktop/.env.development`). To use a backend elsewhere, create `desktop/.env.development.local` (git-ignored):

```dotenv
RENDERER_VITE_SERVER_URL=http://192.168.1.50:3001
```

…or set it for one run: `$env:RENDERER_VITE_SERVER_URL='http://192.168.1.50:3001'; npm run dev`. For production builds put it in `desktop/.env.production.local`. The value is compiled into the app and also used to build its Content-Security-Policy, so the app can only talk to that one server. It is public — never put secrets in `RENDERER_VITE_*` variables.

If the backend runs on a different PC, start it with `HOST=0.0.0.0` (or the LAN IP) **on a trusted network only** — see [server/README.md](server/README.md#configuration).

## Two-client test procedure

Use `D2_PROFILE` to give each desktop window its own isolated profile (separate storage and sign-in), so two clients can run on one PC.

1. **Terminal 1:** `cd server; npm run dev`
2. **Terminal 2 (Client A):** `cd desktop; $env:D2_PROFILE='alice'; npm run dev` → sign in as **alice**.
3. **Terminal 3 (Client B):** `cd desktop; $env:D2_PROFILE='bob'; npm run dev` → sign in as **bob**. (Its dev server picks the next free port automatically. Window titles end in "— alice" / "— bob".)
4. **Presence:** each window's member list shows both users online.
5. **Real-time delivery:** in Client A, open *The Hangout → #general* and send `hello from A`. It appears in Client B immediately, without refreshing. Reply from B; it appears in A.
6. **Unread markers:** put B in `#memes`, send a message from A in `#general`. B shows an unread dot on `#general`; it clears when opened.
7. **Mentions:** send `@bob hi` from A — the message is highlighted in B.
8. **Reconnect:** stop the backend (Ctrl+C in Terminal 1). Both clients show *"Connection lost. Reconnecting…"*. Send a message from B — it is marked *Not sent* with **Retry**/**Discard**.
9. **Persistence:** restart the backend (`npm run dev`). Both clients reconnect by themselves (no sign-in) and fetch anything they missed. Click **Retry** in B — the message is delivered to A. All earlier messages are still there.
10. **Full restart:** close both windows and start them again — you stay signed in and history is intact.
11. **Limits:** the composer stops at 2000 characters, and sending more than 5 messages in a couple of seconds marks the extras *"Not sent: Slow down — try again in Ns"* (use **Retry**).

Automated equivalent of steps 4–9: `cd server; npm test`.

## Checks

```powershell
cd server;  npm run typecheck; npm test; npm run build
cd desktop; npm run typecheck; npm run lint; npm run build
```
