# Discord 2.0

A self-hosted, Discord-inspired chat app for friends: an **Electron + React + TypeScript** desktop client, a **Node.js + Fastify + WebSocket** backend, and a self-hosted **LiveKit** SFU for voice — all running on your own hardware (an NVIDIA Jetson Orin Nano).

| Folder | What it is |
| --- | --- |
| [`desktop/`](desktop/) | Electron desktop client |
| [`server/`](server/) | Backend API + real-time gateway + Docker Compose (backend + LiveKit) ([server README](server/README.md)) |
| [`docs/`](docs/) | Design notes, the [Jetson voice deployment guide](docs/voice-deployment-jetson.md), the [screen sharing guide](docs/screen-sharing-jetson.md), [screen sharing performance](docs/screen-sharing-performance.md) and [Messaging 2.0](docs/messaging-2-jetson.md) |

**Status — Milestone 6 (Messaging 2.0):**
- **Messages:** attachments (upload, paste, drag & drop, inline images with a lightbox, file downloads), edit and delete, replies, reactions with an emoji picker, pinned messages, and safe Markdown with code highlighting.
- **Finding things:** full-text search with filters, unread counts synced across your PCs with a *NEW* divider, and desktop notifications (message text hidden by default).
- **Unchanged:** screen sharing (Milestone 5), voice (Milestone 4), and presence (Milestone 2).

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
6. **Unread markers:** put B in `#memes`, send two messages from A in `#general`. B shows a **2** badge on `#general`; opening it shows a *NEW* divider and the badge clears.
7. **Mentions:** send `@bob hi` from A — the message is highlighted in B.
8. **Reconnect:** stop the backend (Ctrl+C in Terminal 1). Both clients show *"Connection lost. Reconnecting…"*. Send a message from B — it is marked *Not sent* with **Retry**/**Discard**.
9. **Persistence:** restart the backend (`npm run dev`). Both clients reconnect by themselves (no sign-in) and fetch anything they missed. Click **Retry** in B — the message is delivered to A. All earlier messages are still there.
10. **Full restart:** close both windows and start them again — you stay signed in and history is intact.
11. **Limits:** the composer stops at 2000 characters, and sending more than 5 messages in a couple of seconds marks the extras *"Not sent: Slow down — try again in Ns"* (use **Retry**).

Automated equivalent of steps 4–9: `cd server; npm test`.

## Messaging 2.0 (attachments, edits, replies, reactions, search, pins)

With the two clients from the procedure above:

- **Attach:** click **+**, paste a screenshot (Ctrl+V) or drop files on the chat. Images show inline; click one for the lightbox. Files (PDF, TXT, ZIP, Office…) show a **Download** card. Limits: 5 files per message, images ≤ 15 MB, other files ≤ 25 MB; executables and other types are rejected.
- **Edit / delete:** hover a message for its toolbar or right-click it. ↑ in an empty composer edits your last message. Only the author can edit or delete.
- **Reply / react / pin:** from the hover toolbar or the right-click menu. Pins are listed under the pin icon in the channel header.
- **Search:** Ctrl+F → words, optional author and dates, *This channel* or *Whole server*. Click a result to jump to it.
- **Notifications:** Settings → Notifications (message preview is off by default). Mute a channel with the bell in its header.

Architecture, limits, storage, backup/restore, rollback and the full two-PC checklist: [docs/messaging-2-jetson.md](docs/messaging-2-jetson.md).

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

Extras: Settings → Voice & Audio for input/output device, input/output volume, input sensitivity (live meter, manual noise gate), a local mic test ("Let's Check"), echo cancellation / noise suppression / auto gain, and push-to-talk (default key `` ` ``; hold while the app is focused). Click a user in your voice channel to set their volume (0–200%).

## Screen sharing (Go Live)

Requires the Milestone 5 server (see [docs/screen-sharing-jetson.md](docs/screen-sharing-jetson.md); it adds a LiveKit codec setting that enables GPU encoding on Windows).

- **Share:** join a voice channel → **Share Screen** in the voice panel → pick a screen or application window, quality (default 1080p 60fps), *Mode* (Smooth Gaming / Sharp Desktop), codec and *Share system audio* → **Go Live**. While live, the panel shows a LIVE badge, a quality switch, a preview button and **Stop Streaming**.
- **Watch:** click the red **LIVE** badge next to a user in the channel list (works from another channel too, it joins you there). Click a text channel to keep watching in a mini player; use the viewer's buttons for fullscreen, actual size, stats and stream volume.
- **Diagnostics:** Settings → Diagnostics shows each stage separately: capture, encoded and sent fps on the sharer; received, decoded and shown fps on the viewer. It also shows the encoder/decoder actually in use (and whether Chromium reports it as hardware), encode time, send pacer delay, jitter buffer, arrival → display time, freezes, loss, RTT, CPU, memory and GPU status. How to read it and the gaming benchmark procedure: [docs/screen-sharing-performance.md](docs/screen-sharing-performance.md).
- **Best gaming settings (RTX 40-series):** AV1 · 1440p 60fps · Smooth Gaming, with *Hardware AV1 encoding* on (Settings → Screen Share).

### Hardware test checklist (two Windows PCs, Jetson deployed)

1. Both PCs on `milestone-5-screen-sharing`, pointed at `http://192.168.68.65:3001`; both join *Lounge* and hear each other (voice unchanged).
2. Alice: **Share Screen** → the picker lists screens (with resolution) and windows with thumbnails; Discord 2.0 itself isn't listed.
3. Alice picks her screen, 1080p 60fps, system audio on → **Go Live**. Her panel shows LIVE + the source name.
4. Bob sees a red **LIVE** badge next to Alice (no video is downloaded yet).
5. Bob clicks LIVE → Alice's screen appears in focus view; header shows resolution · fps · H264.
6. Bob opens stats (chart icon): ~1920×1080, close to 60 fps on moving content, 0% loss on wired LAN.
7. Alice: Settings → Diagnostics → *Hardware encoder: Yes*, encoder shows the GPU (e.g. NVIDIA … Encoder MFT).
8. Alice plays a video with sound: Bob hears it; Bob's stream volume slider (bottom of the viewer) changes only the stream, not Alice's voice.
9. Alice and Bob talk while streaming: voices still work. On Windows 11 Bob does **not** hear his own voice echoed back through Alice's stream.
10. Bob deafens: stream audio and voices stop, the video continues. Undeafen → both resume.
11. Bob clicks *#general*: the stream continues in the mini player (bottom-right); expand returns to focus view.
12. Bob: fullscreen, then Esc; then the "actual size" toggle.
13. Alice switches quality to 1440p 60fps (on a 1440p monitor): Bob's header shows 2560×1440 within a few seconds, without a new picker. On a 1080p monitor the picker warns it will stay at native size.
14. Alice shares a single window, then closes that window: her stream stops with a notice; Bob sees *Stream ended*.
15. Alice clicks **Stop Streaming**: Windows' capture indicator disappears; Bob sees *Stream ended*.
16. Alice goes live again, then switches to *Chill Zone*: the stream stops automatically; voice moves with her.
17. Bob (in Lounge) clicks Alice's LIVE badge under *Chill Zone* after she goes live there: Bob is moved to Chill Zone and watches.
18. Unplug Alice's network for ~2 minutes while live: Bob sees *Stream ended*; Alice's panel shows reconnecting, then a notice that the stream stopped; after reconnecting she's back in voice and can Go Live again.
19. Alice clicks the hang-up button while live: the stream stops, mic and screen capture are released.
20. On the Jetson during the stream: `docker stats` (LiveKit low CPU), `nload eth0` (≈ bitrate × viewers). Record results.

## Checks

```powershell
cd server;  npm run typecheck; npm test; npm run build
cd desktop; npm run typecheck; npm run lint; npm test; npm run build
```
