# Messaging 2.0 — architecture, deployment and verification (Milestone 6)

Milestone 6 turns plain text chat into a complete messaging feature set: attachments (upload, paste, drag & drop, inline images, lightbox, downloads), editing and deleting, replies, reactions, full-text search, pinned messages, server-synchronized unread state, desktop notifications, and safe Markdown. Voice and screen sharing are unchanged.

Everything runs on the existing backend container on the Jetson. **No new services, images, ports or volumes**; attachments are stored on the existing `discord2-data` volume next to the database.

## Architecture

```
Desktop (React)                         Backend (Fastify, SQLite)                 Disk (/data volume)
───────────────                         ─────────────────────────                 ───────────────────
Composer ─ upload (XHR, progress) ───▶ POST /api/channels/:id/attachments ───▶ tmp/ ─▶ files/ab/<id>
         ─ send {content, replyToId, ─▶ POST …/messages  (claims pending        discord2.db
            attachmentIds}                attachments atomically)                  (messages, attachments,
Gateway ◀─ message_create / _update / _delete / reaction_update /                 reactions, pins,
           pin_update / read_state_update (own sessions only)                      read_states, messages_fts)
Images  ◀─ GET /api/attachments/:id (Bearer token) → blob: URL (LRU cache, 200 MB)
```

- **Writes go over REST** (status codes, validation, rate limits); **changes arrive over the gateway** so every client converges on the same state. Reactions carry the authoritative count, edits carry `editedAt` (older edits are ignored), and on reconnect the client reloads the latest page and reconciles it (deleted messages disappear, edits and reactions are applied).
- **Attachments are uploaded first, then sent.** An upload creates a *pending* attachment visible only to its uploader. Sending a message claims its pending attachments in the same transaction that inserts the message; an attachment can belong to exactly one message.
- **Files never leave the backend without authentication.** The desktop app downloads attachments with its session token and displays them through `blob:` URLs, so there are no tokens in URLs and no public file links.
- **Rendering is safe by construction.** Messages are parsed into a small AST and rendered as React elements only: no HTML, no `dangerouslySetInnerHTML`, no remote images. Only `http(s)` URLs become links, and they open in the system browser (enforced again in the Electron main process).

Endpoint and gateway reference: [server/README.md → API](../server/README.md#api-v1).

## Data model and migration

The backend applies migrations automatically on start. Migration **v2 `messaging_2`** is forward-only and additive: it adds columns, tables, indexes and triggers and never rewrites or drops existing data.

| Change | Purpose |
| --- | --- |
| `messages.edited_at`, `messages.reply_to_id` (no foreign key, so deleting the original keeps the reply) | Edits, replies |
| `attachments` (`message_id` NULL = pending, `ON DELETE CASCADE`) | File metadata: name, type, kind, size, width/height, SHA-256, order |
| `reactions` (PK message + emoji + user) | One reaction per user and emoji |
| `pins` (PK message) | Pinned messages |
| `read_states` (PK user + channel) | Last read message per user, synced across that user's sessions |
| `messages_fts` (FTS5, `unicode61 remove_diacritics 2`) and triggers | Search index, rebuilt from existing messages during the migration |
| `messages_author_idx` | Search by author |

Deleting a message is a hard delete: its reactions, pin and attachment rows are removed (cascade), its files are deleted from disk, and replies show *Original message was deleted*.

## Attachments

### Storage layout

```
/data/discord2.db                 database (+ -wal / -shm)
/data/attachments/tmp/            uploads in progress (deleted on failure)
/data/attachments/files/ab/abcd…  committed files, named by a random 32-hex id (never the user's filename)
```

`ATTACHMENTS_DIR` defaults to `<database directory>/attachments`, which is `/data/attachments` in Docker. The original filename is only stored (sanitized) in the database and used for `Content-Disposition`.

### Validation

1. Extension allowlist: images `png jpg jpeg gif webp` (shown inline); files `pdf txt log md csv json zip 7z docx xlsx pptx` (always downloaded, never opened by the app).
2. **Magic bytes must match the extension** (a renamed `.exe` is rejected). Text files must be valid UTF-8 without NUL bytes.
3. Image dimensions are read from the header (pure JS, no native image libraries) and capped at 50 megapixels, which protects clients from decompression bombs. JPEG EXIF orientation is honoured for layout.
4. Size limits per file, per request and per message; per-user and total quotas; and a minimum free disk space check before anything is written.
5. Filenames are sanitized for display and download only (no path components, unsafe or control characters, leading/trailing dots; ≤ 120 characters). Files are stored under a random id, so a filename is never used as a path.

The desktop app pre-checks type and size for fast feedback; the server re-validates everything.

### Limits (defaults; configurable in `server/.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `UPLOAD_MAX_IMAGE_MB` | 15 | Max size of one image |
| `UPLOAD_MAX_FILE_MB` | 25 | Max size of one non-image file |
| `UPLOAD_MAX_FILES` | 5 (max 10) | Attachments per message |
| `UPLOAD_MAX_REQUEST_MB` | 50 | Bytes per upload request |
| `UPLOAD_MAX_IMAGE_MEGAPIXELS` | 50 | Max image width × height |
| `UPLOAD_USER_QUOTA_MB` | 1024 | Storage per user (sent + pending) |
| `UPLOAD_TOTAL_QUOTA_MB` | 20480 | Storage for all attachments |
| `UPLOAD_MIN_FREE_DISK_MB` | 2048 | Refuse uploads below this free space (`507`) |
| `ATTACHMENTS_DIR` | `<db dir>/attachments` | Where files are stored |

Fixed limits: 20 pending (unsent) uploads per user; pending uploads expire after 6 hours; 20 different reactions per message; 50 pins per channel; message text up to 2000 characters (may be empty when attachments are included).

### Download headers

`GET /api/attachments/:id` returns `Content-Disposition: inline` for images and `attachment` for everything else (or always with `?download=1`), with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-site`, `Cache-Control: private, max-age=31536000, immutable` and an ETag (SHA-256). Pending attachments return `404` to everyone except their uploader.

### Cleanup

On start and then hourly, the backend:

1. deletes pending uploads older than 6 hours (file and row);
2. sweeps orphaned files that have no database row (for example after a crash between writing and committing), with a 1-hour grace period.

Cancelling an upload in the composer, removing it from the tray or leaving the channel deletes unsent uploads immediately.

## Search, unread state and notifications

- **Search** (Ctrl+F or the search box): SQLite FTS5 with prefix matching. Filters: this channel or the whole server, author, date range. Results are newest first, 25 per page with *Load more*, matched words are highlighted, and clicking a result jumps to the message, loading the history around it if needed. User input is converted to quoted terms, so FTS syntax can't be injected.
- **Unread state** is stored on the server per user and channel, so it is the same on every PC you sign in from. New users start "caught up". A channel is marked read only when the window is focused, you are at the bottom and you are viewing the latest messages; reading older history doesn't mark it read. Your own messages never count as unread. Sidebar badges show counts up to 99+, and an open channel shows a *NEW* divider and a *N new messages · Jump · Mark as read* bar. Esc marks the channel read or jumps back to the present.
- **Desktop notifications** (Settings → Notifications) for messages in channels you aren't looking at. **Message text is hidden by default**: *Show Message Preview* is opt-in so content doesn't appear on a shared screen. Mute a channel with the bell in the channel header (local to that PC). Clicking a notification focuses the app and jumps to the message.

## Using it

| Action | How |
| --- | --- |
| Attach | **+** in the composer, paste an image (Ctrl+V) or drop files on the chat. Each file shows progress, **×** to cancel, **Retry** on failure. Send waits for uploads to finish |
| Open an image | Click it: lightbox with Fit / 100% / zoom (+/−/0) / Download; Esc closes |
| Edit | Hover → ✎, right-click → *Edit Message*, or ↑ in an empty composer. Enter saves, Esc cancels; saving empty text offers deletion |
| Delete | Right-click → *Delete Message* (asks for confirmation) |
| Reply | Hover → ↩ or right-click → *Reply*; the reply shows a clickable preview of the original |
| React | Hover quick reactions, ☺ for the picker (search, recent), click a reaction to toggle yours |
| Pin | Right-click → *Pin Message*; the pin icon in the header lists pins with *Jump* / *Unpin* |
| Link to a message | Right-click → *Copy Message Link* (`discord2://channels/<channel>/<message>`); pasted links jump in-app |
| Markdown | `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `||spoiler||`, `` `code` ``, fenced code blocks with a language (basic highlighting and a Copy button), `> quotes`, `@mentions` |

Permissions in this milestone (development policy): every signed-in user can read every text channel, react and pin; only the author can edit or delete a message. There are no moderator roles yet.

## Security notes

- **Development identities are still the only sign-in.** Anyone on the LAN who can reach the backend can sign in as anyone and read and upload attachments. Keep the backend LAN-only (`BIND_ADDRESS` = the Jetson's LAN IP, no port forwarding).
- **Uploaded files are untrusted.** The server verifies their type, but a valid PDF or ZIP can still contain anything. The app never opens downloads itself; Windows handles them like any browser download.
- **No remote content.** Links aren't previewed, URLs aren't fetched (no SSRF surface on the Jetson), and images are only loaded from our own backend through blob URLs. CSP `img-src` allows `'self' data: blob:` only.
- **Electron hardening.** `window.open` and in-window navigation only hand `http(s)` URLs to the system browser (`file:`, `javascript:` and custom schemes are dropped), and the app window can't navigate away from the app. The renderer is allowed the `notifications` permission; camera access is still never granted.
- **Database:** all queries use bound parameters, and search terms are quoted before reaching FTS5.
- **Quotas and free-space checks** stop one user, or a runaway client, from filling the Jetson's storage.

## Deploying to the Jetson

**Not done yet — requires your approval.** No compose service, port or volume changes are needed. The compose file only gained optional `UPLOAD_*` pass-through variables (empty = defaults).

```bash
cd ~/Discord2.0
git fetch origin
git checkout milestone-6-messaging
git pull
cd server
# optional: back up first (see below)
docker compose up -d --build
docker compose ps                                     # server running, livekit healthy
docker compose logs server | grep -i -E "migrat|listening"
curl -s http://127.0.0.1:3001/health
docker compose exec server ls -la /data /data/attachments
```

The first start runs migration v2, including building the search index from existing messages. That takes well under a second for tens of thousands of messages.

Desktop PCs: check out the same branch, `cd desktop; npm install; npm run dev` (or rebuild the app). Update the backend first. Mixing a Milestone 6 desktop app with a Milestone 5 backend isn't supported (the new features would fail with errors).

## Monitoring storage

```bash
docker system df -v | grep discord2-data                     # volume size
docker compose exec server du -sh /data/attachments /data/discord2.db*
docker compose exec server df -h /data                       # free space (uploads stop below UPLOAD_MIN_FREE_DISK_MB)
docker compose logs server | grep -i -E "attachment|cleanup|insufficient"
docker stats --no-stream                                     # server memory/CPU
```

The backend streams uploads to disk, so upload size doesn't affect its memory use. Thumbnails aren't generated on the Jetson; clients scale images. Expected cost is mostly disk space: at the default quotas, 20 users × 1 GB fits inside the 20 GB total quota.

## Backup and restore

The database runs in WAL mode, so **don't copy `discord2.db` alone while the server is running**; recent writes may still be in `discord2.db-wal`.

**Consistent full backup (recommended; ~10 s downtime):**

```bash
cd ~/Discord2.0/server
docker compose stop server
docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/discord2-backup-$(date +%F).tgz -C /data .
docker compose start server
```

This includes the database, its WAL files and `/data/attachments`.

**Online database-only snapshot** (no downtime; attachments not included):

```bash
docker compose exec server node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/discord2.db').exec(\"VACUUM INTO '/data/discord2-snapshot.db'\")"
```

`VACUUM INTO` fails if the target file already exists; delete or rename old snapshots first. (Verified with Node 24's built-in SQLite on the development PC; not yet run on the Jetson.)

**Restore** (replaces everything in the volume):

```bash
docker compose stop server
docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/discord2-backup-YYYY-MM-DD.tgz -C /data && chown -R 1000:1000 /data"
docker compose start server
```

## Rolling back to Milestone 5

Migrations are forward-only, but v2 is additive, so a Milestone 5 backend can still run on a migrated database:

- Text, history and voice work. Edited messages show their new text but no *(edited)* marker.
- Messages that only have attachments appear with empty text; the files stay on disk but can't be shown or downloaded.
- New tables, the FTS index and its triggers stay in place. The triggers keep the index up to date and are harmless.
- Reactions, pins, read states and replies are ignored.

For a complete rollback, restore the backup taken before the upgrade.

## Tests performed (development PC only)

- **Server:** 45 automated tests (`cd server; npm test`), 20 of them new. They cover uploads (allowed and blocked types, spoofed extensions, size, request and pixel limits, ACL of pending files, download headers, path traversal, cancel), edit/delete ownership and broadcasts, replies to deleted messages, reactions and the emoji limit, pins, search (FTS, filters, pagination, injection), read state sync, the `around` window, persistence across restart, cleanup, and migrating a real v1 database while the old queries keep working.
- **Desktop:** 120 unit tests (`cd desktop; npm test`), 55 of them new, for message state merging, unread/notification/scroll logic, the upload tray, Markdown safety, highlighting, the attachment cache and image layout.
- **Live two-client run on one PC** (local backend with a fresh database, two isolated Electron profiles driven by an automated script). All 18 steps passed: send/receive, upload via the file picker, rejected `.exe`, clipboard paste, drag-and-drop of a text file, lightbox, reactions, edit with ↑, reply and jump, pin, search and jump, delete with the reply showing *deleted*, no edit/delete on other users' messages, unread badge and divider, and persistence after restarting the backend. Separately verified: the notifications permission, and the `window.open`/navigation guards.
- **Not yet verified:** anything on the Jetson or across two physical PCs, voice running at the same time as large uploads, and real Windows notification banners (only the permission was checked).

## Two-PC hardware checklist (Jetson deployed)

1. Back up the volume, deploy (see above) and confirm `docker compose logs server` shows the migration and *Server listening*.
2. Both PCs on `milestone-6-messaging`, pointed at `http://192.168.68.65:3001`; sign in as alice and bob. Earlier history is intact.
3. Alice sends `hello **bold** \`code\`` in #general. Bob sees it instantly with formatting.
4. Alice attaches a 5 MB PNG screenshot with **+**: a progress bar appears, then the send button enables. Bob sees the image inline without layout jump, and the lightbox opens and closes with Esc.
5. Alice presses Win+Shift+S, then Ctrl+V in the composer: the pasted image uploads and sends.
6. Bob drags a PDF and a `.zip` onto the chat: both upload and Alice can **Download** them. They open correctly in Windows.
7. Alice copies `notepad.exe`, renames it `notes.png` and tries to upload it: rejected (*The file’s contents don’t match its .png extension*). A 30 MB file is rejected with the size limit.
8. Bob reacts 👍 and 🎉 to Alice's message: Alice sees both instantly. Alice clicks 👍 (count 2), clicks again (count 1).
9. Alice presses ↑, edits her last message, presses Enter: Bob sees the new text with *(edited)*.
10. Bob replies to Alice's message: Alice sees the reply preview and clicking it jumps to the original.
11. Alice deletes the original: it disappears on both PCs, the reply shows *Original message was deleted*, and its image is gone from `/data/attachments` (check `du -sh`).
12. Bob tries to edit or delete Alice's message: the options aren't offered (the server would also refuse with `403`).
13. Alice pins a message: it appears in Bob's pins list; *Jump* and *Unpin* work.
14. Bob presses Ctrl+F, searches for a word from step 3, filters by author alice, then clicks the result: the chat jumps to it and highlights it.
15. Bob switches to #memes and minimizes the app. Alice sends 3 messages in #general: Bob gets a Windows notification reading *alice in #general — New message* (no text), and #general shows a **3** badge.
16. Bob enables *Show Message Preview* and gets another notification with the text. Bob mutes #general with the bell and gets no more notifications.
17. Bob opens #general: a *NEW* divider marks the first unread message, and the badge clears once he's at the bottom. Bob signs in on another PC (or another profile) and the channel is also read there.
18. Alice and Bob join Lounge voice, then Alice uploads a 20 MB file: voice stays clear (note any glitches), and if Alice is live, the stream keeps its frame rate.
19. Restart the backend (`docker compose restart server`): both clients reconnect, and edits, reactions, pins, attachments and unread counts are unchanged.
20. On the Jetson: `docker compose exec server du -sh /data/attachments`, `df -h /data`, `docker stats --no-stream`. Record the sizes and memory.
