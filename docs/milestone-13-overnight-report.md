# Milestone 13B–G — overnight engineering report

Status: **complete, local only — waiting for your review.** Nothing has been committed, pushed,
released or deployed. The Jetson, router, DNS and production data were not touched. Branch:
`milestone-12-public-client` (HEAD `3d46b11`), with the uncommitted Milestone 13A patch underneath.

Items that need real hardware or third-party accounts are marked **NOT VERIFIED**.

## Summary by phase

| Phase | Area | State | Verification |
| --- | --- | --- | --- |
| 1 | Email accounts, open/invite/closed registration, sign-up/verify/reset, startup and onboarding | Done | 33 server tests; Electron end-to-end |
| 2 | Drafts, quick switcher (Ctrl+K), emoji autocomplete, lightbox gallery/copy, mention badges, resizable sidebar, contrast | Done | Unit tests; Electron end-to-end |
| 3 | Custom sounds, per-category/per-event volume, keybind editor with opt-in system-wide mute/deafen | Done | Unit tests; Electron end-to-end |
| 3 | Voice activity / diagnostics review | Reviewed | Code review only — real calls **NOT VERIFIED** |
| 4 | Server administration: icon, description, default notifications, channel layout, voice user limits, member timeouts | Done | 13 server tests; Electron end-to-end |
| 5 | GIF picker (provider adapter + server proxy, GIPHY adapter, offline mock) | Done | 8 server tests; Electron end-to-end with the offline provider; real GIPHY **NOT VERIFIED** (no key) |
| 6 | Large files: chunked, resumable uploads up to 5 GB; files over 500 MB expire 24 h after upload | Done (off by default) | 10 server tests; Electron end-to-end with real 520 MB / 40 MB files; Jetson capacity tests **NOT VERIFIED** |
| 7 | "Daily Word" five-letter word game (daily puzzle by UTC date, practice, stats, spoiler-free sharing) | Done | 13 unit tests; Electron end-to-end |
| 8 | Debugging pass: whole-app sweep, two independent code reviews (server, desktop), 17 defects fixed | Done | 9 new server tests, 9 new desktop tests; every fix re-verified in Electron where possible (details below) |

Test totals at the last full run: desktop **355/355** (40 files), server **225/225**; desktop
typecheck, lint and Prettier clean; server typecheck clean.

## Phase 1 — accounts and first run

**Server** (migration 6 `email_accounts`, additive):

- `REGISTRATION_MODE` = `invite` (default, unchanged behaviour), `open` (anyone with an email
  address they confirm) or `closed`. `MAIL_TRANSPORT` = `none` (default), `smtp` or `file`
  (development only; refused in production). `open` requires a mail transport.
- `POST /api/auth/signup`, `verify-email`, `resend-verification`, `forgot-password`,
  `reset-password`; `GET/POST /api/auth/email`, `/email/verify`, `/email/remove`. Login accepts
  a username or an email address.
- Codes: 8 characters (`XXXX-XXXX`, Crockford base32), stored only as a hash bound to purpose
  and address, valid 30 minutes, dead after 5 wrong attempts. Confirming a sign-up needs the
  code **and** the password. Sign-up, resend and forgot-password always answer 202 (no account
  enumeration); an address that belongs to an account gets an "account exists" email, while an
  unconfirmed sign-up gives way to a newer one (Phase 8). Unconfirmed sign-ups are
  removed after 24 hours.
- Rollback to older server code: run `DELETE FROM users WHERE signup_pending = 1` first.

**Desktop:** new sign-in screen (no server URL on the main screen; Connection settings view),
sign-up → verify → welcome onboarding, forgot/reset password, Email section in Security,
splash screen, offline workspace screen with automatic retry, network errors without host names.

## Phase 2 — messaging and appearance

- Drafts per channel and account (survive restarts, cleared on sign-out).
- Quick switcher (Ctrl+K): servers, channels, conversations, recent visits.
- `:emoji` autocomplete and `:name:` replacement in the composer.
- Lightbox: previous/next, "n of N", Copy image (PNG via canvas, because the CSP blocks
  fetching `blob:` URLs).
- Mention badges (red) on channels and server icons, live and after start-up; unread counts
  are neutral grey.
- Resizable channel sidebar; high-contrast option (system / on / off).
- **Server bug fixed:** a channel that was empty when first opened silently marked later
  messages as read (read-state initialisation skipped empty channels). Regression test added.

## Phase 3 — sounds, keybinds, voice review

- **Custom sounds:** import (format, size, length and decode checks), IndexedDB library,
  per-event custom sound with fallback to the built-in one, loudness normalisation,
  per-category and per-event volume.
- **Keybinds** (Settings → Keybinds): an extensible command registry (mute, deafen, leave
  voice, share screen, quick switcher, previous/next channel and server, member list,
  settings). Recording rejects shortcuts reserved by Windows (Win-key, Alt+F4/Tab/Esc/Space,
  Ctrl+Esc, Ctrl+Alt+Del, Ctrl+Shift+Esc, PrintScreen) or by the app (copy/paste/undo, search,
  zoom, reload, developer tools), plain typing keys and conflicts. Per-row reset and "Restore
  defaults". Shortcuts work while the app is focused; **only mute and deafen** can be made
  system-wide, opt-in, through Electron `globalShortcut` (no keyboard hooks), with an
  allow-list in the main process. If another program holds the shortcut, the setting says so.
  - Verified: all default shortcuts, recorder rules, persistence, registration success and the
    "held by another app" case (Ctrl+Alt+M is taken on this PC).
  - **NOT VERIFIED:** pressing a system-wide shortcut while another app is focused (would need
    synthetic OS-level key presses, deliberately not done).
- **Bug fixed:** Alt/Ctrl+↑ in an empty composer opened "edit last message"; arrow keys now
  only do that without modifiers.
- **Voice review:** speaking rings come from LiveKit's active-speaker events; the mic meter and
  reduced motion behave correctly in code. **NOT VERIFIED:** real calls (Smart App Control
  blocks the unsigned local LiveKit binary; no capture of a real microphone was attempted).

## Phase 4 — server administration (API 5)

**Server** (migration 7 `server_admin`, additive):

| Feature | Backend behaviour | Permission |
| --- | --- | --- |
| Description (≤ 300 chars) | Normalised (control/bidi characters removed), shown to members | Manage Server |
| Default notifications (`all` / `mentions`) | Stored and served; clients apply it unless the member chose otherwise | Manage Server |
| Server icon | Decoded and re-encoded by sharp to 512/128 px WebP (same pipeline as avatars); members-only download; old files deleted; orphan sweep | Manage Server |
| Channel layout | `PUT /api/servers/:id/layout` with every channel you can see; hidden channels keep their place; stale lists get 409 | Manage Channels |
| Voice user limit (0–99) | Enforced when the voice token is issued, with a 20 s seat hold against races, and again when someone actually connects (Phase 8); people who can manage channels may still join | Manage Channels |
| Member timeout (1 min – 28 days) | A timed-out member keeps only *View Channel* everywhere in the server: no sending, editing, reacting, uploading, inviting, voice or moderation; removed from voice immediately; survives leaving and rejoining (Phase 8); ends by the clock; sweeper notifies clients | New **Moderate Members** bit (moderators and admins by default; also granted to configured roles that could kick) |

All changes are audit-logged (`server.icon_changed`, `server.icon_removed`, `server.timeout`
with duration and optional reason, `server.timeout_removed`, `channel.layout`). Ownership
transfer clears a timeout. Invite expiry (1 h – 30 days) and use limits already existed;
"never expires" is deliberately not offered.

**Desktop:** server icons in the server rail; Overview (icon, description, default
notifications); Channels (order and categories editor with move/rename/new category and
save/undo, category when creating, voice user limit); Members (Timeout dialog, "timed out ·
N left" tag, Remove Timeout); audit labels; timed-out composer explains why it is read-only;
description and `n/limit` in the channel sidebar; Settings → Notifications per-server level.

**Rollback:** older server code ignores the new columns and table. Timeouts, icons and limits
are then simply not enforced or shown.

**NOT VERIFIED:** the user limit with a real LiveKit join (the local test server has no
LiveKit); it is covered by server tests.

## Phase 5 — GIF picker

**Design:** the server is the only party that talks to the GIF provider. It holds the API key
(`GIF_API_KEY`, never sent to apps), proxies search/trending (`/api/gifs/search`,
`/api/gifs/trending`) and streams the media itself (`/api/gifs/media/:id`). The app's CSP
stays strict and members' IP addresses aren't shared with the provider. A GIF message is a
plain link to the provider's page, so older apps and search still show something; this app
shows the GIF when the whole message is one such link and the server's provider knows it.

- **Off by default** (`GIF_PROVIDER=none`). `giphy` needs a key; `mock` (offline test GIFs) is
  refused in production.
- **Abuse and budget controls:** per-user limits, results cached for 10 minutes, media cached
  (64 MB in memory, 8 MB per GIF), identical requests de-duplicated, and a server-wide provider
  budget (default 90 requests per hour, because GIPHY beta keys allow about 100), of which each
  person may use a third. Memory is bounded for slow or stalled readers too (Phase 8, item 6).
- **Safety:** ids are validated; media is only fetched from the provider's own HTTPS hosts
  (GIPHY: `media*.giphy.com`, `i.giphy.com`), without redirects, only `image/gif` or
  `image/webp`, size-capped. Content rating defaults to PG-13 (`GIF_RATING`).
- **Picker:** debounced search with trending when empty, 3-column grid with arrow-key
  navigation (Enter sends, Esc closes), "Load more", the provider's attribution. Under reduced
  motion the grid and messages show still frames; hovering, focusing or pressing "GIF ▶" plays.
- **Before enabling GIPHY in production (needs your decision):** create a GIPHY developer
  account and key; read the API terms — the documentation says search and trending calls "must
  be made from the client side" but also documents `country_code` for requests proxied through
  your service, so confirm that a server proxy is acceptable (or apply for a production key).
  Tenor is not an option (Google shut its public API down in 2026); KLIPY is a possible
  alternative behind the same adapter interface (not implemented).
- **NOT VERIFIED:** real GIPHY traffic (no key). The adapter is tested against recorded-shape
  responses with a fake network.

## Phase 6 — large files (up to 5 GB)

**Policy as agreed:** at most 5 GB per file (a hard ceiling in the configuration). Files
**strictly larger** than 500 MB are deleted 24 hours after their upload completes; a file of
exactly 500 MB keeps normal retention. "MB" is 1024 × 1024 bytes everywhere in Discord 2.0, so
the threshold is 524,288,000 bytes. When a file expires only its bytes are deleted — the message
and the attachment row stay, and the app shows "File expired".

**Off by default** (`UPLOAD_LARGE_FILES=false`). Nothing changes for production until you turn
it on, which should wait for the capacity tests below.

**Server** (migration 8 `large_files`, additive):

- `POST /api/channels/:id/uploads {filename, size}` opens a session after checking permission
  (Send Messages + Attach Files), the file-type allow-list, the size, quotas, the number of
  uploads in progress and free disk space (counting the bytes still to arrive for every open
  upload). `PUT /api/uploads/:id?offset=N` takes one chunk (≤ 16 MB, raw bytes); the chunk is
  written at that offset and **flushed to disk before** the progress is recorded, so a crash or
  restart never loses or doubles data. `GET /api/uploads/:id` tells a client where to resume.
  `POST …/complete` checks the contents against the extension, hashes the file, moves it into
  place and records the attachment in one transaction; asking again returns the same attachment,
  and an attempt interrupted after the move is completed by the next one (Phase 8). `DELETE`
  cancels.
- Only the uploader can see or touch an upload (others get 404). Paths are server-generated
  ids; client file names never reach the disk.
- Quotas: large files (over the threshold) use their own pool — 20 GB of active large files
  per person, 200 GB in total, refused below 100 GB free space, 2 uploads at a time per person.
  Files at or under the threshold count against the normal 1 GB per-person quota.
- Lifecycle: a sweep at start-up and every 5 minutes deletes abandoned uploads (no progress for
  24 h), stray partial files, and the bytes of expired large files (bytes first, then the mark;
  safe to repeat after a crash). Downloads are refused (410) as soon as the time is up, even
  before the sweep runs.
- Downloads support byte ranges (`Range: bytes=…` → 206), so they can resume.
- Each attachment owns its bytes (no deduplication), so expiring or deleting one file never
  affects another message.
- New allowed types (download-only, never played inline): `.rar`, `.mp4`, `.mov`, `.mkv`,
  `.webm`, each checked by its file signature.
- **Caddy:** no change needed — chunks are 16 MB (under the 64 MB `request_body` limit) and
  downloads are streamed.

**Desktop:** files bigger than a normal upload go through the chunked uploader automatically,
which resumes after network errors or a lost answer by asking the server where the upload
stands (and cancelling deletes it on the server). The composer warns before uploading a file
that will expire; file cards show "Deleted in 23 h" and an "expired" state. Files over 50 MB
are saved through Chromium's download manager (Save dialog, streamed to disk, resumable) instead
of renderer memory. The main process accepts such a download only from our own window, only for
an attachment URL on one of the build's approved servers, and only with the session header —
found and fixed during testing: the first version did not restrict the origin.

**Verified end-to-end** (local server, real files): a 520 MB and a 40 MB video uploaded,
sent, shown with the expiry label; the 520 MB file downloaded to disk with progress and an
identical SHA-256; after making the file due and restarting the server, the start-up sweep
deleted the bytes and the message showed "File expired".

**Before enabling on the Jetson (approval needed):**

1. Back up the database; deploy; migrations 7 and 8 run on start.
2. On a copy first: upload 5 GB over the LAN and over the internet (through Caddy); restart the
   backend mid-upload and resume; fill a test volume to check the free-space refusal; check an
   expiry.
3. Measure the Jetson's write speed and memory during a 5 GB upload.
4. Set `UPLOAD_LARGE_FILES=true`. Rollback: set it back to false — already promised expiries
   still run.

**NOT VERIFIED:** a real 5 GB transfer, Jetson throughput, internet upload through Caddy, and a
human using the Save dialog (automated tests saved to a folder instead).

## Phase 7 — "Daily Word" game

An original five-letter word game under **Home → Daily Word** (desktop only, no server changes,
no network traffic). It borrows the well-known genre mechanics (six guesses, green/yellow
feedback) but none of anyone's code, word lists, artwork or branding.

- **Daily puzzle:** everyone gets the same word for the same UTC date (puzzle #1 = 1 Jan 2026),
  drawn from 536 hand-picked, family-friendly answers in a fixed shuffled order, so a word
  doesn't repeat until all have been used. A new word arrives at midnight UTC.
- **Practice mode:** unlimited random words (never today's); doesn't affect stats.
- **Guesses:** any real five-letter word. Besides our curated lists, guesses are checked against
  the **ENABLE** word list (8,636 five-letter words; by Alan Beale and M. Cooper, placed in the
  public domain; source file and SHA-256 recorded in `games/dictionary.ts`). ENABLE is used for
  *guesses only* — answers stay curated. Found during testing: the first version accepted only
  965 words and rejected ordinary words such as "mound", "chomp" and "fjord".
- **Stats per account on this device** (`localStorage`, keyed by user id; the game is re-mounted
  per account so stats never cross users): played, win %, current/best streak, guess
  distribution. The board survives restarts.
- **Sharing:** "Copy result" copies only coloured squares and the score
  (e.g. `Daily Word #301 2/6`) — no letters, so pasting it in chat spoils nothing.
- **Accessibility:** typing works anywhere on the page (except in other fields or dialogs) and
  there's an on-screen keyboard; every guess is announced to screen readers ("R in the word,
  wrong spot…"); an optional high-contrast palette (orange/blue); animations respect
  reduced motion.

**Verified end-to-end** (Electron): too-short and unknown words rejected with a shake; a win in
two guesses using both the physical and on-screen keyboards; stats, distribution and persisted
state correct after a reload; the copied text contains no letters; practice accepts the
previously rejected words, a lost practice game reveals the word, and stats don't change; typing
in the conversation search box never reaches the board; Friends and opening a conversation
close the game.

## Phase 8 — debugging pass

**How:**

- **Sweep of every view in Electron**, with console errors and warnings, unhandled rejections
  and CSP violations captured from page load: Home and all Friends tabs, Daily Word, every server
  and channel, the member list, server menus and every Server Settings tab, the emoji and GIF
  pickers, the quick switcher and all User Settings sections. Result: **none**.
- **Milestone 13A regression checks:**
  - Shift quick-delete: four rapid deletes, nothing left behind.
  - A normal click still asks for confirmation.
  - There is no Delete button on other people's messages.
  - Drafts survive switching servers.
  - A live timeout disables and then re-enables the composer.
- **Two independent read-only code reviews** of all uncommitted changes:
  - server: 3 medium, 6 low;
  - desktop: 3 medium, 4 low.
- **My own review** of the large-file path.

Each finding was confirmed in the code or reproduced before it was fixed.

| # | Severity | Problem | Fix | Proof |
| --- | --- | --- | --- | --- |
| 1 | High (found by me) | Finishing a large upload used the general 10-second timeout, but the server re-reads and hashes the whole file. A 5 GB upload on the Jetson would show "failed" while the server finished it, and Retry would send all 5 GB again. | Finishing can now be repeated safely: the attachment id comes from the upload id, so a repeat returns the same attachment. It also completes an attempt that stopped between moving the file and recording it, and refuses a second finish or a cancel while one is still hashing. The app allows at least a minute (assuming 20 MB/s) and repeats finishing after a timeout or lost answer. | Server test; desktop tests |
| 2 | Medium | An error answer without a JSON body (e.g. Caddy's 502 while the backend restarts) left uploads hanging forever. | The error reader never throws. | Unit test |
| 3 | Medium | A network or server outage of more than about a second ended a large upload: the status check after a failure wasn't retried. | Every step uses one retry policy, about 2 minutes of trying; cancelling ends a wait at once. | Unit tests; **Electron: server stopped for ~10 s during a 520 MB upload; the upload carried on from byte 117,440,512 by itself and finished** |
| 4 | Medium | A failed large upload stayed open on the server for 24 h, counting against the 2-at-a-time limit, and Retry started from zero. | Retry continues the same server upload; Remove (or leaving the channel) cancels it. | Unit test; **Electron: server down for 2½ min, both uploads failed; Remove cancelled its upload on the server, and Retry continued the same upload to completion without starting a new one** |
| 5 | Medium | A timed-out member could leave (or be kicked) and rejoin to clear the timeout. | A running timeout is parked when a membership ends and restored on rejoin. This is done with database triggers in migration 7, so every way of joining is covered. Parked timeouts that run out are swept. | Server test (leave, kick, lift) |
| 6 | Medium | GIF proxy: memory could pile up behind slow readers, one person could spend the whole server's provider budget, and unknown ids cost a provider call every time. | Server-wide caps: 6 downloads at once, 12 open responses per person, 96 MB in flight. A response that stops moving for 20 s is dropped (the connection's timeout is restored afterwards). Each person gets a third of the budget, and misses are remembered for 10 minutes. | Server tests; picker and sending re-checked in Electron |
| 7 | Medium | Password reset revealed whether an address had an account: only real accounts were hashed (timing), and the weak-password check used the account's name. | The password is always hashed. Account-specific password rules apply only after the code is proven right, and a correct code isn't used up by a refused password. | Server test |
| 8 | Low | The voice user limit was checked only when a token was issued (tokens last 5 minutes; seats are held for 20 s). | Checked again when LiveKit reports the join; latecomers over the limit are removed, managers are exempt. Someone already in the room keeps their seat — a bug the new test found, also fixed when tokens are issued. | Server test with signed webhooks |
| 9 | Low | Timed-out members could edit old messages, and the new text was shown to everyone live. | The server refuses (`timed_out`). The hover toolbar now follows permissions like the right-click menu: no Edit, Reply or reactions when they aren't allowed. | Server test; Electron |
| 10 | Low | Chunked uploads of normal-sized files running in parallel could overshoot quotas. | Uploads in progress reserve their space. | Server test |
| 11 | Low | An unconfirmed sign-up could block someone else's address for 24 h. | A newer sign-up, or an account confirming the address, replaces the unconfirmed one. Only the inbox owner can confirm either. | Server tests |
| 12 | Low | Docker ignored `SMTP_PASSWORD_FILE` / `GIF_API_KEY_FILE`, and an SMTP login without a password failed silently on every email. | Compose passes the variables through; `.env.example` says `.env` is the secret store under Docker; start-up refuses an SMTP user without a password. | Config tests; compose file parsed |
| 13 | Low | GIFs and large files stayed off for the whole session if the server's feature list failed to load at start. | Loaded again after every (re)connection, which also picks up features an administrator switches on later. | Electron: app started while the server was down |
| 14 | Low | "New category…" did nothing (Electron has no `window.prompt`). | Inline name field: Enter saves, Esc cancels. | Electron: category created and saved |
| 15 | Low | A leading space, or Shift+Enter, in an empty message box was undone. | Whitespace is kept while typing and never saved. | Unit test; Electron |
| 16 | Low | Resetting one keybind could give two commands the same shortcut. | The reset takes the shortcut back; the other command is left without one, with a notice. | Unit test; Electron |
| 17 | Low (found by me) | User Settings → "Reset to Defaults" wiped keybinds, sounds, notification and device settings in one click (the sweep itself triggered it). | Asks first, saying what is kept. | Electron: Cancel keeps settings, OK resets |

Also fixed in this phase: the emoji button and the typing hints are hidden when sending isn't
allowed.

**Left as is:**

- Deleting your own messages is still allowed during a timeout.
- **Known limitation:** switching channels still cancels an upload in progress. For multi-gigabyte
  files, uploads should keep running in the background — a proposed follow-up, not done tonight.

## Database migrations and rollback

All three migrations are **additive**: new nullable or defaulted columns and new tables, run
automatically (each in a transaction) when the new server starts. The migration runner skips
versions it already has and doesn't refuse unknown ones, so **older server code still starts on
a migrated database**. Every new `NOT NULL` column has a default, so older code can keep
inserting rows.

| # | Name | Adds | Rollback to older server code |
| --- | --- | --- | --- |
| 6 | `email_accounts` | `users.email`, `email_verified_at`, `signup_pending`; `email_codes` table | First run `DELETE FROM users WHERE signup_pending = 1` (older code doesn't know unconfirmed sign-ups must not sign in) |
| 7 | `server_admin` | `servers.description`, `icon_id`, `default_notifications`; `channels.user_limit`; `server_members.timeout_until`; `server_icons` table; `server_timeout_holds` table and two triggers (a timeout survives leaving and rejoining); grants Moderate Members to roles that can kick | Nothing to undo; timeouts, icons and limits are simply not enforced/shown (the triggers keep maintaining a column older code ignores) |
| 8 | `large_files` | `attachments.expires_at`, `expired_at`; `upload_sessions` table | Delete `<attachments>/uploads/*.part` (older code won't sweep unfinished uploads); expired files then answer "file missing" |

**Deployment rule:** back up `discord2.db` (with the server stopped, or with `sqlite3 .backup`)
before the first start of the new server, and rehearse on a copy of the production database
first. Restoring that backup is the complete rollback.

Compatibility: of the tests written for Milestones 7–12, only one assertion changed (the API
version check, from `== 4` to `>= 4`); the API changes are additive, so 1.2.0 desktop clients
should keep working against the new server. **NOT VERIFIED** with an actual 1.2.0 build.

## Approvals needed before anything reaches production

Nothing below has been done.

1. **Commit and branch.** Milestone 13A and everything in this report are uncommitted on
   `milestone-12-public-client`. Suggested: a new `milestone-13` branch with one commit per
   phase, then a pull request.
2. **Server deployment on the Jetson:** back up the database, rehearse on a copy, then deploy.
   New features stay off until configured: registration stays `invite`, mail `none`, GIFs
   `none`, large files off.
3. **Email sign-up:** pick an SMTP provider, put its password in the Jetson's `.env`
   (`SMTP_PASSWORD`, next to the LiveKit secret; keep the file chmod 600), send a test message,
   then choose `REGISTRATION_MODE`.
4. **GIFs:** create a GIPHY key and decide on the terms question in Phase 5; then
   `GIF_PROVIDER=giphy` with `GIF_API_KEY` in the same `.env`.
5. **Large files:** run the Jetson capacity and restart tests in Phase 6 first; then
   `UPLOAD_LARGE_FILES=true`.
6. **Desktop release:** version bump and a build through the existing Windows workflow; the
   installer is still unsigned (see Milestone 12 for the signing options).

## Manual test checklist (for you, with real hardware and people)

- [ ] Sign up with a real email address (once SMTP is set up); confirm, sign in by email,
      reset the password.
- [ ] Two people in a voice channel: speaking rings, mute/deafen (buttons and shortcuts),
      connection panel numbers, a channel user limit of 2 refusing a third person.
- [ ] Screen share with the start/stop sounds on both ends.
- [ ] Settings → Keybinds: make mute system-wide, press it while a game has focus.
- [ ] Time someone out for 1 minute; check they can read but not type, edit, react or join
      voice; that leaving and rejoining the server doesn't end it; and that it ends by itself.
- [ ] Upload a 1 GB file over the internet (after enabling large files on a test copy), pull
      the network cable halfway, plug it back in within two minutes, and check the upload
      carries on by itself; repeat with a longer outage and press Retry. Download it on another
      PC with the Save dialog.
- [ ] On the Jetson, time the "finishing" step of a 5 GB upload (the server hashes the whole
      file; the app waits up to ~4 minutes for 5 GB).
- [ ] Search and send a GIF (after a GIPHY key is configured); turn on reduced motion and check
      GIFs stop moving.
- [ ] Play today's Daily Word on two PCs and compare the shared results.

## NOT VERIFIED (summary)

- Real voice calls and screen sharing (LiveKit binary blocked by Smart App Control locally),
  including the user limit being enforced when someone connects to a real LiveKit server
  (covered by server tests with signed webhooks).
- A system-wide shortcut pressed while another app is focused.
- Real email delivery over SMTP (tested with the file transport).
- Real GIPHY traffic (no key) and the GIPHY terms question.
- A 5 GB transfer, Jetson disk throughput and hashing time, uploads through Caddy over the
  internet.
- A human using the Save dialog for large downloads.
- An actual 1.2.0 desktop client against the new server.
- Docker Compose itself (not installed on this PC): the compose file was only parsed and
  checked, not run.

## Final state (end of the night)

- **Tests:** desktop 355/355 (40 files), server 225/225. Desktop typecheck, ESLint and Prettier
  clean; server typecheck clean. `npm audit --omit=dev`: 0 vulnerabilities in both.
- **Production build** (without the test server list): the CSP allows only
  `landhoev3.duckdns.org` and `192.168.68.65`; the main process accepts downloads only from
  `https://landhoev3.duckdns.org` and `http://192.168.68.65:3001`. A scan of `desktop/out` found
  no test passwords, keys, tokens or test addresses.
- **Dependencies:** the only addition is `nodemailer` (and its types) for SMTP, in `server/`.
  The desktop dependencies are unchanged.
- **Git:** no commits, pushes or stashes; HEAD is still `3d46b11` on
  `milestone-12-public-client`. 82 modified and 65 new files, all uncommitted.
- **Cleaned up:** the local test server, the Electron test instance, its profile
  (`%APPDATA%\desktop-m13p1`), the test database and attachments (`%TEMP%\d2-m13-p1`), the
  560 MB of test videos and two empty folders tests created under `server/data/attachments`.
  Older test profiles from earlier sessions (`%APPDATA%\desktop-alice`, `desktop-bob`,
  `desktop-cp2test`) were left alone; delete them if you no longer need them.
- **Screenshots and test scripts** are in the session folder, not in the repository.
