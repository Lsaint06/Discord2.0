# Milestone 8 — Profiles, presence and personalization ("Project Identity")

Milestone 8 adds real user identity on top of the Milestone 7 accounts:

- profile pictures and banners (cropped in the app, re-encoded on the server);
- display names, bios, pronouns, profile colors and the account creation date;
- profile popouts and a full profile view with mutual servers;
- presence: Online / Idle / Do Not Disturb / Invisible, with automatic idle detection that works across several devices;
- custom statuses with emoji and automatic expiry;
- appearance settings (theme, accent, density, reduced motion) synced between your PCs.

**Nothing has been deployed.** The Jetson still runs Milestone 7 (`be53524`). No new ports, services or public exposure.

## Contents

1. [What changed](#what-changed)
2. [Profiles](#profiles)
3. [Profile images and security](#profile-images-and-security)
4. [Presence and custom status](#presence-and-custom-status)
5. [Preferences: synced and device-only](#preferences-synced-and-device-only)
6. [API and gateway](#api-and-gateway)
7. [Database migration v4](#database-migration-v4)
8. [Docker / Jetson notes](#docker--jetson-notes)
9. [Deployment procedure](#deployment-procedure)
10. [Backup and rollback](#backup-and-rollback)
11. [Tests](#tests)
12. [Two-PC checklist](#two-pc-checklist)
13. [Known limitations](#known-limitations)

## What changed

| Area | Summary |
| --- | --- |
| Backend | Migration v4 (additive), `routes/profile.ts`, `profile/media.ts` (sharp/libvips image pipeline), presence rewrite in `gateway.ts`, custom status expiry timer, `profiles: true` / `apiVersion: 3` in `/api/meta` |
| Dependencies | `sharp` ^0.35 (Apache-2.0). Prebuilt libvips for win32-x64 and linux-arm64; nothing is compiled |
| Desktop | Profile popout, full profile modal, image cropper, status menu, custom status dialog, Settings → Profile / My Account / Appearance, theme engine (dark/light/system), idle detection (Electron `powerMonitor`, sender-checked IPC) |
| Docs | This file, README updates |

## Profiles

| Field | Rules |
| --- | --- |
| Username | Permanent login name. **Never changes**, and can't be changed through the API (unknown fields → `400`). |
| Display name | 1–32 characters; control and bidi-override characters removed; whitespace collapsed. |
| Bio ("About me") | Up to 190 characters and 8 lines; plain text (rendered as text, never HTML or Markdown). |
| Pronouns | Up to 40 characters, optional. |
| Profile color | `#rrggbb` or none; used for the banner when there is no banner image. |
| Avatar color | Background behind your initials when there is no picture (existed before). |
| Member since | The account's `created_at` (existing accounts keep their original date). |

**Who can see a profile:** the same people who can already see you in the member list — people who share a server with you (plus bots and yourself). Anyone else gets `404`. The full profile lists only servers you **both** belong to.

**Who can change a profile:** only its owner, through their own session. The only exception is an instance administrator, who can remove someone's picture or banner (`DELETE /api/admin/accounts/:userId/profile-media/:kind`). That needs a password session, is rate limited, and is written to the security log as `admin.profile_media_removed`.

## Profile images and security

**Pipeline (`server/src/profile/media.ts`):**
1. **Upload.** Multipart, one file, at most 10 MB, streamed to a temp file on the data volume (never fully into memory). The file name and the client's `Content-Type` are ignored.
2. **Type check.** The magic bytes must be PNG, JPEG, WebP or GIF. SVG, PDF, HTML, executables and anything else are rejected (`415`). The decoder's detected format must match the magic bytes.
3. **Bomb check.** Dimensions are read from the header. Images over 40 megapixels are refused before decoding (`413`), and libvips also enforces `limitInputPixels`. Corrupt or truncated data fails (`failOn: 'error'`).
4. **Minimum size.** Avatars at least 64×64; banners at least 300×120.
5. **Re-encode.** EXIF orientation is applied, then the image is cropped to cover and **re-encoded to WebP** at fixed sizes:
   - avatar: 512×512, plus a 128×128 thumbnail;
   - banner: 1500×600, plus a 600×240 thumbnail.

   Animated GIF/WebP are flattened to the first frame.
6. **Metadata.** The output has **no metadata** (EXIF, GPS, XMP, ICC and comments are gone; tested). The original upload is deleted and never served.
7. **Resource limits.** At most 2 images are processed at once, with up to 8 queued (more → `503 busy`). There is a 20 s encoder timeout, and libvips caching is off.
8. **Storage.** Files go to `<data volume>/attachments/profile/<id[0..2]>/<id>.webp` and `<id>.small.webp`. They are written via temp file and atomic rename. Ids are 128-bit random hex, validated before any path is built, so there is no path traversal.
9. **Replacing or removing.** One database transaction points the user at the new image and deletes the old row; then the old files are deleted. An hourly sweep removes any file without a row, after a 1-hour grace period.
10. **Serving.** `GET /api/profile-media/:id?size=full|small` requires a session and that you can see the owner (otherwise `404`). Response headers:
    - `Content-Type: image/webp`;
    - `Content-Security-Policy: default-src 'none'; sandbox`;
    - `X-Content-Type-Options: nosniff`;
    - `Cache-Control: private, immutable`.

    Ids never change content: a new picture gets a new id, so caching is safe.
11. **Desktop.** The cropper also re-encodes on the client, which drops photo metadata before upload. Images are fetched with the session token into an LRU blob cache (48 MB); there are never public image URLs. Missing or failed images fall back to initials or the profile color.

**Rate limits:**
- image uploads and removals: 6, then 1 per 10 s per user;
- profile reads and image downloads: 300, then 20/s per user;
- profile edits: 10, then 1 per 5 s;
- status and preference changes: 20, then 1 per 2 s.

## Presence and custom status

**Status preference** (Online, Idle, Do Not Disturb, Invisible):
- **Storage.** It is stored on the account (`users.status_preference`). It applies to all your devices and survives restarts and reconnects. Before Milestone 8 it lived in each PC's local storage and was lost when the server restarted.
- **Do Not Disturb** also suppresses desktop notifications in the app.

**Effective presence** (what others see) is computed live by the gateway:

| Preference | No device connected | At least one device connected |
| --- | --- | --- |
| Online | Offline | **Idle** if *every* connected device is idle, otherwise **Online** |
| Idle / DND | Offline | Idle / DND |
| Invisible | Offline | **Offline** (custom status hidden too) |

**Automatic idle detection:**
- Each device reports `set_idle` when it has had no input for the chosen time (default 10 minutes; configurable from 5 to 60 minutes in Appearance, 1–120 via the API) or the screen is locked.
- In Electron this comes from `powerMonitor.getSystemIdleState`, so input in any app counts, polled every 15 s. The renderer only receives `active` / `idle` / `locked`, never input events.
- Reconnects carry the idle flag in `identify`, so an away PC never flashes "online".

**Multiple sessions:**
- Presence goes "offline" only when the account's last socket closes.
- Changing your status on one PC updates your other PCs instantly (`me_update`).

**Invisible:**
- You appear offline everywhere: member list, popouts, `/api/users`, and your custom status is hidden.
- Changing your custom status or reconnecting while invisible sends **no** event to anyone.
- You can still read, send, react, join voice and stream. Messages you send obviously reveal that you're around.

**Efficiency:**
- Events go only to people who share a server with you.
- An event is sent only when what they see actually changes. Repeated identical idle reports and invisible-mode changes are dropped.
- No polling between clients and server, apart from the local idle check.

**Custom status:**
- Up to 128 characters plus an optional single emoji.
- Expiry: 30 minutes, 1 hour, 4 hours, today (local midnight), or never. The client sends a *relative* duration of 1 minute to 7 days, so a wrong PC clock doesn't matter.
- Expired statuses stop showing immediately. Every 15 s a server timer clears them from the database and tells everyone affected.
- Clear it manually from the status menu.

## Preferences: synced and device-only

| Synced to your account (`/api/users/me/preferences`) | This PC only (local storage) |
| --- | --- |
| Theme (dark / light / sync with Windows) | Chat font size |
| Accent color | Voice devices, volumes, push-to-talk |
| Message display (cozy / compact) | Screen-share defaults, encoder flags |
| Show timestamps | Notification toggles, muted channels |
| Reduced motion (sync with Windows / on / off) | Recent emoji |
| Idle timeout | |

- **Validation:** preferences are validated server-side (known keys only, enums, color pattern). Stored data that can't be parsed falls back to the defaults.
- **Live sync:** changes appear on your other PCs immediately (`preferences_update`).
- **One-time move:** the first time you sign in with the Milestone 8 app, appearance and status settings you had changed locally are copied to your account — accent, compact mode, timestamps, status and custom status. This happens only if the account has no saved preferences yet; otherwise the server copy wins.

**Light theme:** variable-based, so every screen (chat, voice, settings, modals) follows it; code blocks and links get readable light-theme colors. **Reduced motion** disables animations and transitions app-wide.

## API and gateway

| Method & path | Description |
| --- | --- |
| `PATCH /api/users/me` `{ displayName?, avatarColor?, bio?, pronouns?, accentColor? }` | Edit profile (`null` clears optional fields) |
| `PUT /api/users/me/status` `{ status?, customStatus?: { text?, emoji?, expiresInMs? } \| null }` | Status preference and custom status |
| `POST`/`DELETE /api/users/me/avatar` · `…/banner` | Upload (multipart, one file) / remove |
| `GET /api/profile-media/:id?size=full\|small` | Processed image (authenticated, visibility-checked) |
| `GET /api/users/:userId/profile` | `{ user, mutualServerIds }` |
| `GET`/`PATCH /api/users/me/preferences` | Synced preferences |
| `DELETE /api/admin/accounts/:userId/profile-media/:kind` | Instance admin moderation (audited) |

**Changes to `ApiUser`:** it gains `avatarId`, `bannerId`, `accentColor`, `bio`, `pronouns`, `createdAt` and `customStatus`. `ApiMe` adds `statusPreference` and `ownCustomStatus`.

**Gateway:**
- `identify { token, idle? }`;
- new `set_idle { idle }`;
- `set_status` now persists the preference;
- new server frames `me_update` and `preferences_update` (your own sessions only).

**Compatibility:**
- `/api/meta` reports `apiVersion: 3, profiles: true`.
- The Milestone 8 app refuses to sign in to an older server ("server is older than the app").
- The Milestone 7 app still works against a Milestone 8 server: the extra fields are ignored.

## Database migration v4

`profiles_and_presence` is additive and runs once inside a transaction:
- **New `users` columns** (all nullable or defaulted): `bio`, `pronouns`, `accent_color`, `avatar_id`, `banner_id`, `status_preference` (default `'online'`, with a CHECK constraint), `custom_status_text`, `custom_status_emoji`, `custom_status_expires_at` (partial index).
- **New tables:** `profile_media` (cascade on user delete) and `user_preferences`.
- **Untouched:** no existing column, row, message, attachment, membership, session or server is modified. Tested on a realistic Milestone 7 database:
  - accounts, credentials, sessions, messages, attachments and memberships survive;
  - running the migration twice is a no-op;
  - `PRAGMA integrity_check` and `foreign_key_check` pass;
  - Milestone 7-style inserts still work.

## Docker / Jetson notes

- **No compose change needed.** No new environment variables, ports, services or volumes. Images live in the existing `discord2-data` volume under `attachments/profile/`.
- **sharp ships prebuilt libvips for `linux-arm64` (glibc).** That matches `node:24-bookworm-slim` on the Jetson. The lockfile includes `@img/sharp-linux-arm64` and `@img/sharp-libvips-linux-arm64`. The Dockerfile now loads sharp during the build, so a missing binary fails the build instead of the first upload.
- **Memory:** processing a 40 MP image peaks at roughly 150–250 MB per job, with at most 2 jobs. This is an estimate, not measured on the Jetson; profile images are usually far smaller.
- **Not yet verified on the Jetson:** the ARM64 image build and upload timing. Run the commands below after deploying.

## Deployment procedure

**Not performed; needs your approval.**

1. **Back up** the volume (consistent snapshot; see below).
2. **Build and start:**
   ```bash
   cd ~/Discord2.0 && git fetch origin && git checkout milestone-8-identity && git pull
   cd server && docker compose up -d --build
   docker compose logs server | grep -iE "sharp|migrat|listening|error"
   docker compose exec server node dist/cli/admin.js verify
   docker compose exec server node -e "const s=require('sharp');console.log(s.versions)"
   curl -s http://192.168.68.65:3001/api/meta   # expect "apiVersion":3,"profiles":true
   ```
3. **Update the desktop app on both PCs** to `milestone-8-identity`. Sign in with your existing accounts; nothing to re-register.
4. Run the [two-PC checklist](#two-pc-checklist).

## Backup and rollback

**Backup** (about 10 s downtime; same procedure as Milestone 7):
```bash
cd ~/Discord2.0/server
docker compose stop server
docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/discord2-pre-m8-$(date +%F).tgz -C /data .
docker compose start server
```

**Rollback options:**
- **Code only.** `git checkout milestone-7-gateway && docker compose up -d --build`. Milestone 7 ignores the new columns and tables, so accounts, messages and attachments keep working. Profiles, pictures and synced preferences are simply not shown, and stay in the database for a later re-upgrade. Roll the desktop app back too: the M8 app refuses an M7 server.
- **Full rollback.** Restore the tarball (see [milestone-7-security.md → Backup and rollback](milestone-7-security.md#backup-and-rollback)). Anything written after the backup is lost.

## Tests

Automated, run on the development PC:

| Suite | Result |
| --- | --- |
| Server `npm test` | **107 / 107**: 84 existing plus 23 new in `test/profiles.test.ts` |
| Desktop `npm test` | **136 / 136**: 124 existing plus 12 new in `lib/appearance.test.ts` |
| Server typecheck + build; desktop Prettier, ESLint, typecheck, production build | pass |

`profiles.test.ts` covers:
- **Profile edits:** normalization, length and line limits, forged and unknown fields, permanent username, live updates to peers.
- **Profile visibility:** hidden from non-sharing users, mutual servers.
- **Image uploads:**
  - WebP re-encode at exact sizes with EXIF/XMP removed;
  - banners;
  - GIF input;
  - rejects spoofed extension, PDF, SVG, truncated image, too small, decompression bomb (30 000×30 000 header), over 10 MB, empty, no file, unauthenticated.
- **Image storage and access:**
  - replace and remove delete the old files;
  - path traversal and malformed ids → 404;
  - non-sharing user → 404;
  - admin removal is audited and others can't remove;
  - orphan sweep.
- **Presence:**
  - multi-device idle and online, offline only after the last socket;
  - no duplicate events;
  - idle-on-connect never flashes online;
  - invisible hides presence and custom status, stays usable, syncs to both devices and leaks no events;
  - `set_status` validated and persisted.
- **Custom status:** expiry hidden immediately, sweep clears and announces, no-expiry statuses persist, validation.
- **Preferences:** defaults, partial updates, validation, live sync to the other device, per-account isolation, garbage tolerance.
- **Persistence and migration:** restart persistence (profile, images, status, preferences, presence after reconnect); v4 migration of a Milestone 7 database.

**Live run, on this PC.** Two real Electron windows of the built app against a local backend with `DEV_AUTH=false`, plus a third window as a second session of the same account. **21 / 21 steps passed:**
1. Password sign-in.
2. Edit pronouns, bio and color.
3. Avatar crop and upload.
4. Banner upload, a JPEG with EXIF.
5. Server files verified as metadata-free WebP at the right sizes.
6. The other client sees the avatar live.
7. Popout shows banner, bio, pronouns, member since and role.
8. Full profile with mutual servers; Escape closes.
9. Clicking a message author opens their popout.
10. DND propagates live.
11. Custom status with 1-hour expiry propagates live.
12. Invisible shows as offline without custom status, and messaging still works.
13. Back to online.
14. Light theme applies to one account only.
15. Second session of the same account gets the synced theme, live density change and status sync.
16. Closing one of two sessions keeps the user online.
17. Backend restart: clients reconnect, data persists.
18. App restart keeps the session, theme, density, avatar and status.
19. Clear custom status.
20. Removing the avatar falls back to initials everywhere.
21. Dark-theme screenshot.

**Not tested:**
- the Jetson (ARM64 build, migration of the real database);
- two physical PCs;
- voice and screen sharing with Milestone 8 (no code in those paths changed, but not re-run on hardware);
- the system-wide idle timing (`powerMonitor`) over a real 10-minute idle period. The idle logic is tested with gateway frames.

## Two-PC checklist

Not executed. After backup and deployment:

1. PC 1 signs in as `thereallsaint`, PC 2 as `lsaint06`.
2. PC 1: **Settings → Profile**:
   - upload a picture (crop, Apply) and a banner;
   - set pronouns, an "About me" and a profile color;
   - **Save Changes**.
3. PC 2: the member list and chat show the new picture without refreshing. Click the name to open the popout, then **View Full Profile**, then **Mutual Servers**.
4. PC 1: click your name in the bottom-left, choose **Do Not Disturb**. PC 2 sees a red dot within a second. Back to **Online**.
5. PC 1: **Set a custom status** "Testing 🎮", clear after **30 minutes**. PC 2 sees it under your name. Then **Clear custom status**.
6. PC 1: **Invisible**. PC 2 shows you as offline. Send a message from PC 1: it still arrives. Back to **Online**.
7. Leave PC 1 untouched for 10 minutes (or set "Show me as Idle after" to 5). PC 2 sees **Idle**. Move the mouse and it shows **Online** within about 15 s.
8. **Settings → Appearance** on PC 1: **Light**, accent green, **Compact**. Sign in to the same account on a second Windows profile or PC: same look. PC 2's own look is unchanged.
9. `docker compose restart server`: both PCs reconnect by themselves, pictures, bios, statuses and themes are intact.
10. Regression: send messages and attachments, join **Lounge** on both PCs and talk, Go Live at 1440p60 on one and watch on the other.
11. On the Jetson: `docker stats` during an upload (memory), and `du -sh` of the `attachments/profile` folder in the volume.

## Known limitations

- **Pictures are static.** Animated GIFs become still images.
- **Cropper size limits.** It loads the whole image in the renderer; files up to 40 MB are accepted there.
- **Idle detection.** Polled every 15 s, so becoming idle can lag by up to 15 s. Outside Electron only input in the app window counts.
- **Invisible doesn't hide your activity.** Messages you send, reactions and voice presence still show that you're around (voice channels show you to people who can see that channel).
- **No custom emoji in statuses.** Unicode emoji only.
- **Profile visibility follows server membership.** Old message authors in your servers stay visible after they leave (same rule as Milestone 7's user list).
- **Built app and the gateway (pre-existing, Milestone 7 and earlier).** A packaged or built app loaded from `file://` sends `Origin: file://` on the gateway WebSocket. The server only allows `null`, so it refuses the handshake unless `CORS_ORIGINS=file://` is set. `npm run dev` (what you use) is unaffected. Not changed in this milestone; it should be fixed together with packaging and remote access.
- **Remote access is still not set up.** Images and API traffic use plain HTTP on the LAN, as before.
