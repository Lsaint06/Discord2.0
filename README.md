# Discord 2.0

A self-hosted, Discord-inspired chat app for friends: an **Electron + React + TypeScript** desktop client, a **Node.js + Fastify + WebSocket** backend, and a self-hosted **LiveKit** SFU for voice — all running on your own hardware (an NVIDIA Jetson Orin Nano).

| Folder | What it is |
| --- | --- |
| [`desktop/`](desktop/) | Electron desktop client |
| [`server/`](server/) | Backend API + real-time gateway + Docker Compose (backend + LiveKit) ([server README](server/README.md)) |
| [`docs/`](docs/) | Design notes and the [Jetson voice deployment guide](docs/voice-deployment-jetson.md) |

**Status — Milestone 4:** real voice channels (WebRTC via self-hosted LiveKit): join/leave/switch, mute, deafen, push-to-talk, active-speaker indicators, device selection, per-user volume, automatic reconnection. Text messaging, persistent history, and presence from Milestone 2 are unchanged.

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

## Two-client text test procedure

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

## Voice with the Jetson

Deploy the backend + LiveKit on the Jetson first: **[docs/voice-deployment-jetson.md](docs/voice-deployment-jetson.md)**.

### Windows launch (each PC)

```powershell
cd desktop
npm install                                  # first time only
Set-Content .env.development.local 'RENDERER_VITE_SERVER_URL=http://192.168.68.65:3001'
npm run dev
```

Two clients on **one** PC (separate profiles; use headphones to avoid echo):

```powershell
# Terminal 1
cd desktop; $env:D2_PROFILE='alice'; npm run dev
# Terminal 2
cd desktop; $env:D2_PROFILE='bob'; npm run dev
```

Windows doesn't show a permission prompt for desktop apps; it uses a global switch. If voice says *"Microphone access is blocked"*, open **Settings → Privacy & security → Microphone** and enable *Microphone access* and *Let desktop apps access your microphone* (the app's Settings → Voice & Audio has a shortcut).

### Two-client voice test procedure

Ideally use two Windows PCs (Alice, Bob) with headsets, both pointed at `http://192.168.68.65:3001`.

1. **Alice joins:** click *The Hangout → Lounge*. The user panel shows *Connecting…* then *Voice Connected — Lounge / The Hangout*; Alice appears under Lounge in **both** clients' sidebars.
2. **Bob joins** Lounge. Both names are listed under Lounge on both clients.
3. **Both hear each other:** speak in turn; the speaker's avatar gets a green ring on both screens.
4. **Alice mutes** (mic button): Bob hears nothing from Alice; a slashed mic appears next to Alice on both clients.
5. **Bob deafens** (headphones button): Bob hears nothing (Alice unmuted, talking); Bob shows slashed mic + headphones. Undeafen → audio resumes.
6. **Alice switches** to *Chill Zone*: she moves in both sidebars; Alice and Bob no longer hear each other. Alice switches back to Lounge → audio resumes.
7. **Unexpected disconnect:** unplug Bob's network (or kill Bob's app in Task Manager). Bob's panel shows *Reconnecting… (Ns)*; when killed, Bob should disappear from Alice's sidebar within roughly 20–30 s (LiveKit's departure timeout, plus the backend's 30 s reconciliation as a backstop).
8. **Recovery:** reconnect Bob's network → Bob rejoins Lounge automatically and audio resumes. (Server-side variant: `docker compose restart livekit` on the Jetson → both clients rejoin by themselves.)
9. **Leaving stops the mic:** click the hang-up button. The Windows microphone indicator in the taskbar disappears within a second and the user is removed from Lounge on both clients.

Extras: Settings → Voice & Audio for input/output device, input/output volume, echo cancellation / noise suppression / auto gain, and push-to-talk (default key `` ` ``; hold while the app is focused). Click a user in your voice channel to set their volume (0–200%).

## Checks

```powershell
cd server;  npm run typecheck; npm test; npm run build
cd desktop; npm run typecheck; npm run lint; npm test; npm run build
```
