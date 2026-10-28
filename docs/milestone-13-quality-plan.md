# Milestone 13 — Quality, customization and feature expansion

Status: **Milestone 13A patch implemented locally, not committed, not deployed.** 13B and 13C are
planned below and need approval before work starts. Nothing in this milestone has touched the
Jetson, the router, DNS, the production database or upload storage.

> **Update:** the overnight work on 13B–G (accounts, server administration, GIFs, large files,
> the Daily Word game and a debugging pass) is described in
> [milestone-13-overnight-report.md](./milestone-13-overnight-report.md). It is also local and
> uncommitted, and it does need a server update (API 5, migrations 6–8).

- Baseline: branch `milestone-12-public-client` at `3d46b11` (desktop 1.2.0, API version 4).
- Production: the Jetson runs `86831b4`. **None of 13A needs a server change.** The patch is
  desktop-only, and works against the current API 4 server.

---

## 1. Audit: existing vs. missing

| Area              | What exists                                                                                                                                                             | Confirmed defects / gaps                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI scale          | Chat font size slider (12–20 px, `--chat-font-size`), cozy/compact density, reduced-motion preference, light/dark/system theme                                          | 158 hard-coded px font sizes; body text 14 px; panel metadata 12 px. Only chat text could be enlarged. Electron's built-in zoom wasn't persisted.                                                                |
| Sounds            | `SoundService` + `soundPolicy` + synthesized original recipes, loudness-normalized, per-event toggles, master volume, rate spacing, tested                              | No screen-share start/stop events. No per-category volume. No custom sounds.                                                                                                                                     |
| Voice panel       | "Voice Connected" text, colour by LiveKit's coarse quality, tooltip only                                                                                                | No measured telemetry; not interactive.                                                                                                                                                                          |
| Noise suppression | Setting exists and is passed into capture constraints; live changes call `restartTrack`                                                                                 | **Bug:** the first microphone publish used the room's `audioCaptureDefaults` captured when the room was created, so later preference changes weren't applied on (re)publish. See §3.                             |
| Message actions   | Hover toolbar: 3 quick reactions, add reaction, reply, edit (own), "More" menu with delete + confirmation                                                               | No toolbar delete; no quick delete. Duplicate DELETE possible on rapid clicks (delete isn't optimistic). **Toolbar unreachable by keyboard** on grouped messages (it was `display:none` with nothing focusable). |
| Server settings   | Overview, members, invites, bans, roles (16 permission bits, hierarchy), channels with per-role overrides, audit log, ownership transfer; server-side permission checks | No categories editor, server icon/description, invite expiry choices, timeouts, storage policy, notification defaults or voice policies (13B).                                                                   |
| GIFs              | None                                                                                                                                                                    | — (13C).                                                                                                                                                                                                         |
| Attachments       | Streamed to disk on the server; per-file and per-request limits; image previews                                                                                         | Caddy `request_body max_size 64MB`; no HTTP Range support; the client downloads each attachment into memory as a blob. **5 GB is not feasible without the 13C design.**                                          |
| Keybinds          | Push-to-talk key (app-focused or one global accelerator via `globalShortcut`)                                                                                           | No editor, no command registry, no conflict detection (13B).                                                                                                                                                     |

---

## 2. Milestone 13A patch (implemented)

### 2.1 Sounds: screen-share started / stopped

- New events `streamStart` and `streamStop` in the voice category. They are original synthesized
  recipes: a rising C5→G5 glide with a high bell for start, and the mirror image for stop.
- Driven by roster changes (`participants[].sharingScreen`) in `voiceSoundTracker`.
  - Not played for the initial roster, or when someone joins who is already sharing (the join
    sound covers it).
  - Not played for someone who leaves while sharing (the leave sound covers it).
  - Spaced at 600 ms, so fast toggling doesn't stack.
- Existing users get both events enabled automatically through `migrateSoundSettings`. Mute,
  deafen and the existing per-event preferences are respected unchanged.
- Files: `sound/sounds.ts`, `sound/soundPolicy.ts`, `sound/voiceSoundTracker.ts`,
  `sound/useVoiceSounds.ts`. Tests: `voiceSoundTracker.test.ts` (+5).

### 2.2 Noise suppression fix

- `doApplyMic` now publishes with `setMicrophoneEnabled(true, captureOptions())`.
- `setPreferences` also updates `room.options.audioCaptureDefaults`, so any later re-publish (for
  example after reconnecting) uses the current echo cancellation, noise suppression and AGC
  choices.
- File: `media/MediaSession.ts`.

### 2.3 Voice connection widget (measured telemetry only)

- `media/connectionStats.ts` (pure, 9 tests) turns WebRTC `getStats()` from the microphone sender
  and every subscribed remote voice into:
  - round trip;
  - jitter;
  - packet loss up and down;
  - send and receive bitrate;
  - path (UDP / TCP / relayed).
- Every value is measured or `undefined`. Missing counters are never shown as 0, and nothing is
  estimated.
- `hooks/useConnectionStats.ts` samples every 5 s, or every 2 s while the details are open. It only
  runs while connected: one `getStats()` per audio track per interval.
- `UserPanel`:
  - "Voice Connected · 42 ms" is now a button (`aria-expanded`, `aria-controls`), coloured by the
    measured grade;
  - it expands to a `<dl>` with every metric plus LiveKit's own estimate, showing "Unavailable"
    where nothing was measured;
  - the reconnecting, countdown and failed states are unchanged.
- **Telemetry sources available in LiveKit 2.23 / Chromium:**
  - `outbound-rtp`: `bytesSent`, `packetsSent`;
  - `remote-inbound-rtp`: RTCP from the SFU, giving `packetsLost`, `fractionLost`, `jitter`,
    `roundTripTime`;
  - `inbound-rtp`: `bytesReceived`, `packetsLost`, `packetsReceived`, `jitter`;
  - `candidate-pair`: `currentRoundTripTime` of the selected pair;
  - `local-candidate`: `protocol`, `candidateType`;
  - LiveKit `ConnectionQuality`, the server's estimate.

### 2.4 UI scale

- An "App Scale" control under Settings → Appearance → This device only, with steps 80, 90, 100,
  110, 125, 140 and 150 %, plus a Reset button.
- Shortcuts: Ctrl+= / Ctrl+− / Ctrl+0, including the numeric keypad. They act only while the app
  window is focused; there is no global hook.
- **Implementation:** Chromium page zoom (`webContents.setZoomFactor`), set in the main process.
  - The page re-lays out at a different CSS-pixel width, so text, hit targets, dialogs and
    responsive layout all scale together. This is not a CSS transform.
  - It is persisted in `userData/ui-zoom.json` and applied on every load.
  - The IPC accepts only listed steps, and only from the app origin (the existing `isAppUrl`
    check).
- Legibility bumps: status line under your name, and voice channel / server line, from 12 to 13
  px.
- The chat header keeps the channel name visible (the topic now truncates first). This showed up
  at 125 % scale.
- Files: `main/uiZoom.ts`, `main/uiZoomLogic.ts` (5 tests), `main/index.ts`, `preload/index.ts`,
  `preload/types.ts`, `components/profile/AppScaleControl.tsx`, `AppearanceSettings.tsx`,
  `assets/main.css`.
- Remaining UI work (13B): convert the most-used hard-coded px sizes to a small type scale, and
  offer a "larger text" option that is independent of app scale.

### 2.5 Faster message actions

- A Delete button in the hover/focus toolbar, shown only for your own messages or with Manage
  Messages. The server still re-checks every DELETE.
- **Click:** opens the existing confirmation dialog.
- **Shift+click, or Shift+Enter / Shift+Space:** deletes without confirmation.
  - While Shift is held, delete buttons turn red.
  - If text is selected when the button is pressed, it always asks.
  - Shift+mousedown on the toolbar no longer extends the text selection. Without this, rapid
    Shift+clicks made the next quick delete fall back to the dialog (found in testing).
- **One request per message:** a `DeleteGuard` blocks repeats while a delete is in flight, and the
  message dims with its button disabled.
- **Keyboard:** each message is one Tab stop and its toolbar appears; Tab again reaches the
  actions.
  - The toolbar shows for `:focus-visible`, or when focus is inside the message but not on the
    article itself.
  - A mouse click on a message doesn't leave the toolbar stuck open.
- Files: `chat/messageDelete.ts` (4 tests), `components/chat/MessageItem.tsx`,
  `components/ChatPanel.tsx`, `assets/main.css`.

### 2.6 Verification performed

- `npm run lint` passes, Prettier is clean, `npm run typecheck` passes, and `npm test` gives
  **264/264** (241 before this milestone, 23 new). `npm run build` passes with the production
  server list.
- **Runtime test in Electron 44.** Two isolated profiles (alice, bob) ran against a throwaway local
  server (127.0.0.1:3101, temporary database), driven with real CDP mouse and keyboard input.
  - A normal click opened the confirmation, and Escape cancelled it.
  - A triple Shift+click sent exactly one DELETE, with no dialog.
  - An active text selection made Shift+click ask.
  - Keyboard: Tab reached Delete in 7 steps, and Shift+Enter deleted. Enter opened the dialog
    with "Delete" focused, and Enter confirmed.
  - Seven messages Shift-deleted in about 0.5 s were all removed. The second client updated in
    realtime and had no delete buttons on alice's messages.
  - Zoom:
    - IPC set 125 % → `devicePixelRatio` 1.25 and the layout reflowed (1264 → 1011 CSS px).
    - Invalid values were rejected.
    - Ctrl+=, Ctrl+−, Ctrl+0 and numpad + all worked, and the page never saw these keys.
    - The value persisted across a full restart.
- **Not verified here** (no microphone, and no LiveKit on this PC):
  - live voice telemetry;
  - audibility of the screen-share sounds;
  - noise-suppression effect.

  Ctrl+mouse wheel zoom is wired, but synthetic wheel events didn't trigger it, so it is
  undocumented in the UI until it is checked with a real mouse.

---

## 3. Noise suppression findings and test plan

**Does it work?** The constraint path is real. `noiseSuppression`, `echoCancellation` and
`autoGainControl` go into `getUserMedia` through LiveKit's `AudioCaptureOptions`, and Chromium
applies its WebRTC audio processing (APM) to the captured track.

- **The defect (fixed in 13A):** the initial publish ignored the current preferences and used the
  room's start-up defaults.
- **Not yet confirmed:** whether the effect is audible. That needs a microphone and a second
  listener. Nothing here was measured.
- **Echo cancellation risk:** the room plays remote audio through Web Audio (`webAudioMix: true`).
  Whether Chromium's echo canceller uses Web Audio output as its reference signal on Windows is
  **unverified**. If it doesn't, echo would appear on speakers (not headphones).

**Manual test plan** (two PCs, one listener; change one setting at a time):

1. **Suppression:**
   - Steady fan or keyboard noise next to the microphone; toggle Noise Suppression while
     speaking.
   - Expected: background noise drops within about 1 s of the toggle (`restartTrack`) and speech
     stays intact.
2. **Echo cancellation:**
   - Speaker output (not headphones) with the remote person talking.
   - With echo cancellation on, the remote person must not hear themselves.
   - Repeat with it off to confirm the toggle matters.
   - If echo stays with it on, test with `webAudioMix: false` (see below).
3. **AGC:**
   - Speak quietly, then loudly, about 30 cm from the microphone.
   - With it on, the listener hears a level that evens out over a few seconds.
4. **Latency:** clap test with each setting. Any added delay should be imperceptible (Chromium APM
   works in 10 ms frames).
5. **Diagnostics:** Settings → Diagnostics, check that `getSettings()` of the microphone track
   shows the expected constraint values.

**Proposals (13B, after the manual test):**

- Offer Chromium's `voiceIsolation` constraint (Chromium 152 supports it; LiveKit exposes
  `AudioCaptureOptions.voiceIsolation`) as an optional "Enhanced voice isolation" mode, if the
  platform reports support.
- If echo cancellation proves ineffective with Web Audio playback, switch to element playback
  for remote audio.
- No custom DSP (no RNNoise/WASM) unless both of the above fail.

---

## 4. Plan for 13B and 13C

**13B — server settings, custom sounds, keybinds, typography** (desktop and server; API 4 → 5)

- **Server settings:**
  - channel categories editor (create, rename, reorder, per-category overrides);
  - server icon (stored as an attachment-like file, with size and type validation) and
    description;
  - invite expiry choices (1 h / 1 d / 7 d / never) and max uses;
  - member timeout (new `moderateMembers` bit, with server enforcement on send, react and voice
    join);
  - default notification level;
  - voice policies (user limit, bitrate cap).

  Every setting gets a migration, a server-side check, an audit-log entry and tests. **Needs a
  database migration:** backup and rollback are rehearsed on a copy first, as in Checkpoint 1.

- **Sounds:**
  - per-category volume (UI, voice, messages);
  - custom sound upload and preview, stored locally in IndexedDB (no server storage);
  - accepted formats: ogg/opus, mp3 and wav, at most 1 MB and 5 s;
  - the file is decoded with `decodeAudioData` before saving, so broken files are rejected;
  - the loudness normalization already used for built-in sounds also applies here.
- **Keybinds:**
  - a command registry (mute, deafen, PTT, join/leave voice, screen share, navigation, mark read,
    …) with an editor;
  - conflict detection against app shortcuts and reserved OS keys (Alt+F4, Win+…,
    Ctrl+Alt+Del);
  - per-device storage and "restore defaults".

  System-wide hotkeys are opt-in per action, registered through `globalShortcut` (no low-level
  keyboard hooks), and clearly labelled as global.

- **Typography:** replace the most-used hard-coded sizes with a 5-step type scale; add an
  independent "larger text" option.

**13C — GIF drawer and large files** (desktop, server and Caddy)

- **GIFs:**
  - a provider adapter interface (`search`, `trending`, `attribution`), with the server proxying
    the provider so the API key stays on the Jetson;
  - per-user rate limit and a content-rating setting;
  - keyboard-accessible grid; static previews under reduced motion.
  - Candidates: KLIPY or GIPHY. Google's public Tenor API stopped issuing keys in January 2026
    and shut down on 30 June 2026 (third-party reports), so it is not an option. Provider terms
    (attribution, rating, caching, rate limits) must be checked at implementation time. No
    scraping.
- **Large files:** see §5.

**Dependencies:**

- 13C large files depend on the 13B migration framework work (a new attachment state column).
- The GIF proxy needs a provider key, which is a new server secret (set on the Jetson only, never
  in the desktop build).

---

## 5. Large files (5 GB): feasibility and requirements

**Confirmed policy:**

- 5 GB maximum per file.
- Files **strictly larger than 500 MB** expire **24 h after upload completion**. Files of 500 MB or
  less keep normal retention.
- When a file expires, only its bytes are deleted. The message stays and shows "File expired".
- Resumable, authenticated transfers, with quotas and cleanup that survives restarts.

**Capacity:**

- The Jetson NVMe is 915 GB, with 854 GB free (single disk, shared with the OS, Docker and the
  database).
- Proposed limits:
  - an ephemeral pool cap of 200 GB for files over 500 MB;
  - refuse new large uploads below a 100 GB free-space floor;
  - per-user limits of 2 concurrent uploads and 20 GB of active large files.
- Worst case with 8 users: 8 × 20 GB = 160 GB, within the pool cap.

**Design:**

- Upload sessions:
  - `POST /api/uploads` (name, size, type, sha256 optional) reserves quota and returns an id;
  - `PUT /api/uploads/:id/chunks/:n` sends 16 MB chunks, under Caddy's 64 MB `max_size`, so
    Caddy needs no change;
  - each chunk is written with `pwrite` to `<data>/uploads/tmp/<id>`, its offset verified, and
    progress recorded in SQLite;
  - `HEAD` resumes after a restart or network loss;
  - `POST …/complete` does an fsync, then an atomic rename into attachments, all in one
    transaction.
- Downloads: HTTP `Range` support on the server. The desktop app saves large files through the
  main process as a stream to disk, instead of the current in-memory blob.
- Lifecycle:
  - `attachments.state`: `uploading` → `ready` → `expired` (with `expires_at` and `deleted_at`);
  - a sweeper on start-up and every 10 min deletes expired bytes, then marks the row `expired`;
  - abandoned upload sessions are removed after 24 h of inactivity;
  - deleting is idempotent: a missing file is not an error, which makes restarts safe.
- Security:
  - session tokens on every chunk; the upload id is bound to the user;
  - server-generated paths only (no client file names on disk);
  - downloads check channel read permission, as attachments do today;
  - the existing per-route rate limiter applies.
- Each attachment row owns its bytes (no deduplication), so deleting or expiring one never
  affects another message. If deduplication is ever added, it needs reference counting first.

**Before enabling 5 GB in production:**

1. Tests on a copy: restart mid-upload and resume; partial upload left for 24 h and cleaned up;
   disk-full refusal; expiry exactly at 24 h; cancelling; the 500 MB boundary (exactly
   500 MiB/MB, then +1 byte).
2. Measure Jetson write throughput and Caddy timeouts with a real 5 GB transfer over the
   internet.
3. Back up the database, then migrate. The limit is enabled by an environment flag, with a
   documented rollback (flag off; the sweeper keeps running).

---

## 6. Remaining risks and open items

- **Unverified on real hardware:**
  - voice telemetry values;
  - screen-share sound audibility;
  - noise suppression, echo cancellation and AGC effects;
  - Ctrl+mouse wheel zoom.
- **Visual review:** UI scale steps above 125 % at the minimum window size (940×560) can make the
  layout tight (the member list and topic truncate). This needs a visual review.
- **Unsigned build:** the desktop build stays unsigned (see Milestone 12). A 1.3.0 build will meet
  the same Smart App Control behaviour until signing is arranged.
- **13B migrations:** need the backup and rollback rehearsal before any production deployment.

## 7. Approval checkpoint

Approval is needed for each of these:

1. Commit the 13A patch to `milestone-12-public-client`, or to a new `milestone-13` branch.
2. Build and distribute a 1.3.0 desktop build. No server change is required.
3. Start 13B, including a database migration plan.
4. Start 13C (GIF provider choice, and a new server secret).
