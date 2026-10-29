# Milestone 14 — architecture

## 1. Capability negotiation (old servers keep working)

- `GET /api/meta` now reports `apiVersion: 6` and `customization: true`.
- The desktop reads this after each gateway connection (`Workspace.tsx`, `customizationSupported`).
- On an older server (production is API 4):
  - Profile Studio sections show a note and can preview but not save. Nothing is sent that an
    old server would reject.
  - The app theme is saved on this PC only (`localStorage`, per server and account), not in
    synced preferences, because old servers reject unknown preference keys.
  - Animated uploads use the old path: the cropper re-encodes the first frame on the client.
  - The `still` image size is requested only when a user is flagged `avatarAnimated`, which only
    API 6 servers send.
  - The soundboard button is hidden.
- New `ApiUser` fields (`profileStyle`, `avatarAnimated`, `bannerAnimated`) and the new
  preference (`appTheme`) are optional on the wire. Unknown ids are ignored on both ends.

## 2. Full-app themes (`lib/themes.ts`, `assets/themes.css`, `hooks/useAppearance.ts`)

- **Theme definition:** each `AppThemeDef` has:
  - a palette of semantic tokens: surfaces, text roles, link, mention, accent;
  - a light or dark base;
  - an optional backdrop gradient and the panel opacity over it;
  - an ambient art id, plus `animated` and `glass` flags;
  - the brightest ambient tint (used by the contrast tests).
- **Applying a theme:** `themeVariables()` maps the theme to CSS custom properties set once on
  `<html>`: `--bg-*`, `--text-*`, `--text-link`, `--mention-text`, `--scrollbar-thumb`,
  `--app-backdrop`, and tinted `--bg-hover`/`--bg-active`.
  - Panels become translucent `rgba()` over the backdrop.
  - Floating surfaces (menus, popouts) stay opaque.
  - Dialogs and the settings overlay composite over the backdrop, so they are opaque.
- **`data-*` flags on `<html>`:**
  - `data-theme` (dark/light base, which drives the existing light-mode rules);
  - `data-app-theme`;
  - `data-theme-effects` (`full` or `reduced`);
  - `data-glass`.
  - Classic mode removes every theme variable, so the original look is restored exactly.
- **Ambient art:** `.app-ambient` is a fixed layer at `z-index: -1` with three spans, drawn in
  CSS and inline SVG.
  - Motion uses only transform and opacity animations (compositor-friendly).
  - It stops with reduced motion or Theme Effects: Reduced; Reduced also drops the backdrop blur.
- **Contrast tests:** `themes.test.ts` checks every theme:
  - text ≥ 7:1 (normal and strong), muted ≥ 4.5:1 and faint ≥ 3:1 on rail, sidebar and chat
    surfaces, composited over every backdrop stop, with and without the ambient tint;
  - links and mentions ≥ 4.5:1;
  - accent ≥ 3:1 against the chat;
  - button text on the accent ≥ 4.5:1.
- **Persistence:**
  - Synced through preferences (`appTheme`) on API 6 servers. The server validates it against
    the allow-list; unknown values fall back to Classic.
  - A local copy (`d2.appTheme.<server>|<user>`) makes the theme apply instantly at start-up.
  - The gallery's live preview is held in Workspace state (`themePreview`) and never outlives
    Settings.
  - A theme picked while the server could not store it is marked "unsynced" on this device.
    After the server is upgraded, it is moved to the account once, unless another device has
    chosen a theme since (`resolveAppTheme`, `unsyncedThemeAction`). There is no Classic flash,
    and a failed move is retried at the next start (no loop).
  - After any reconnect the app re-fetches preferences (ignoring older copies), so changes made
    elsewhere, or a server upgrade, apply without a restart.

## 3. Profile customization (shared)

- **Data:** `ApiProfileStyle` = `colors` (0–3 #rrggbb), `angle` (0–359), `decoration`,
  `effect`, `banner` (preset), `nameStyle`. Ids come from allow-lists in `protocol.ts`, which
  both sides share.
- **Server:**
  - Migration 9 (`profile_customization`, additive) adds `users.profile_style` (JSON),
    `users.avatar_animated` and `users.banner_animated`.
  - `normalizeProfileStyle()` validates keys, ids, colors and angles. An empty style is stored
    as NULL. A corrupt stored value reads as none.
  - `PATCH /api/users/me { profileStyle }` saves it. `gateway.toApiUser()` publishes it to
    everyone who can see the user (`user_update`), with no new fan-out paths.
- **Animated pictures and banners** (`profile/media.ts`):
  - GIF/WebP with more than one frame are re-encoded as animated WebP by sharp:
    - frame count (≤ 300) and total pixels (≤ 60 MP) are checked from metadata before decoding;
    - every frame is cropped and resized to 320² (avatar) or 960×384 (banner);
    - full-size output ≤ 8 MB.
  - A still first frame is stored as `<id>.still.webp`. `GET /api/profile-media/:id?size=still`
    falls back to the full image for still pictures.
  - The crop comes from the client as four integer fields. It is validated against the oriented
    image (inside the bounds, ±3% of the target aspect, minimum size).
  - The client cropper detects animation (`lib/animatedImage.ts`) and, on API 6, sends the
    original plus the crop instead of a canvas re-encode.
- **Rendering:**
  - `ProfileCard` draws the gradient, then banner art or the animated banner, then the effect
    layer, then the avatar with its decoration, then text on near-opaque scrims.
  - `Avatar` draws the decoration overlay (no DOM changes at its 15 call sites).
  - In lists, decorations and animated pictures stay on their still frame and play on row hover.
  - `ProfileMotionContext` disables all motion under reduced motion or Profile Effects: Reduced.
- **Effects:** CSS effects remount per play. Canvas scenes run in `requestAnimationFrame` for
  4.5 s, stop when the window is hidden and clean up on unmount.

## 4. Sound system

- **Registry** (`sound/sounds.ts`): 24 events. The 10 new ones are `directMessage`,
  `friendAccepted`, `voiceDrop`, `reconnect`, `streamRemoteStart`, `streamRemoteStop`, `pttOn`,
  `pttOff`, `uploadDone`, `uploadFailed` and `sendFailed`.
  - Each event has a label, a description, a group (`messages`, `voice`, `controls`, `system`)
    and a fallback recipe.
- **Packs** (`sound/packs.ts`): six packs of bundled WAV files, imported by Vite's
  `import.meta.glob` so they are hashed assets inside the app. Nothing is fetched remotely.
- **Playback** (`SoundService`):
  - One AudioContext. Each pack file is decoded once per context.
  - Load or decode failure falls back to the event's recipe, so a sound is never silently lost.
  - An imported custom sound still replaces the pack sound for its event.
  - `preview(event, pack)` auditions another pack without changing the setting.
  - Existing rules are unchanged: master volume, per-category and per-event volume, Do Not
    Disturb, muted channels, own messages, focused conversation, deduplication by message id,
    and burst gating (mentions/DMs queued, chimes coalesced).
- **Event sources:**
  - `voiceSoundTracker` separates leaving (`disconnect`) from losing the connection
    (`voiceDrop`), plays `reconnect` once after an automatic reconnect, and separates your share
    from other people's. The join-burst settling rule is kept.
  - Message notifications pick `directMessage` for one-to-one conversations.
  - The relationships handler plays `friendAccepted`.
  - The upload manager reports `onSettled`: a failure always sounds; success sounds only for
    uploads that took more than 4 s.
  - `markFailed` triggers `sendFailed`.
  - Push-to-talk transitions while connected trigger `pttOn`/`pttOff` (off by default).
- **Settings migration:** each new event inherits the user's previous choice for the event that
  used to cover it, e.g. no mention sound → no DM sound.

## 5. Soundboard (shared, server-authoritative)

- **Storage:**
  - Migration 10 (`soundboard`, additive) adds the `soundboard_sounds` table (cascade on server
    delete).
  - Files are stored as `<attachments>/soundboard/<id>.wav`; ids are random hex and checked by
    regex before any path is built.
- **Upload:**
  - The client converts any clip Chromium can decode into 48 kHz mono 16-bit PCM WAV, at most
    5 s, with fades and loudness capped (never amplified).
  - The server accepts WAV only and parses the header exactly (`soundboard/wav.ts`).
  - Limits: 600 KB, 5 s, 48 sounds per server (checked atomically). Uploads are rate limited.
  - Only people with Manage Server can add; the uploader or a manager can delete. Both actions
    are audit-logged.
- **Play:** `POST /api/soundboard/:id/play`.
  - The player must be a member, currently in a voice channel of that server (server-side voice
    state) and have Speak there.
  - Rate limit: a burst of 3, then one every 2 s.
  - The `soundboard_play` gateway event goes only to the users in that voice channel.
  - Each client fetches the clip (members only; `audio/wav`, `nosniff`, `sandbox` CSP) and plays
    it locally at its own Soundboard Volume, straight to the output device, skipped while
    deafened.
  - This is the same model as a server-relayed trigger: no audio is mixed into anyone's
    microphone track.
- **Not verified:** two people actually hearing a clip in a live LiveKit call. Voice can't run
  on this PC.

## 5b. Saved messages and personal notes (private to you)

- **Capabilities:** `/api/meta` reports `savedMessages: true` and `userNotes: true`. The app shows
  bookmarks and the note field only when the server says so. On older servers neither appears
  and nothing is requested.
- **Saved messages** (migration 11, `saved_messages`; keyed by user and message; cascades when the
  message or the account is deleted):
  - `PUT /api/saved-messages/:id` works only for a message you can read right now: membership,
    View Channel, and the conversation history floor. Anything else is "not found", so ids can't
    be probed. There is a cap of 500 per person, checked atomically. Saving again keeps the
    original time.
  - `GET /api/saved-messages` returns only messages you can still read, newest first, with the
    server id (null for DMs). If you lose access the entry is hidden but kept, and it comes back
    if you regain access.
  - `DELETE` always works, even after losing access.
  - Each change is echoed to your own sessions only (`saved_message_update`).
  - In the app: a bookmark between Reply and Edit in the hover toolbar (the toolbar is
    right-anchored, so Edit, Delete and More keep their positions); "Save Message" / "Remove from
    Saved" in the context menu; a Saved Messages panel in the chat header with Jump and Remove.
- **Personal notes** (migration 12, `user_notes`; keyed by author and target):
  - `GET/PUT /api/users/:id/note` only work for people you can see (the same rule as profiles).
  - There is no endpoint that returns someone else's note, and notes never appear in user or
    profile objects.
  - Notes are at most 256 characters. Control characters are removed (line breaks kept), and a
    blank note deletes the row.
  - Changes are echoed to your own sessions only (`user_note_update`).
  - In the app: a "Note — only you can see this" field in other people's profile popouts. It saves
    when you leave the field, on Ctrl+Enter, and when the popout closes.

## 5c. Chat wallpaper (this device only)

- **Where it lives:** two device settings (`chatWallpaper`, `chatWallpaperIntensity`), validated
  when loaded (`lib/wallpapers.ts`). Nothing is sent to any server, and there are no image files.
- **Drawing:** `.chat-column[data-wallpaper]` uses pure CSS gradient patterns. The ink is
  `color-mix(var(--text-muted) N%, transparent)`, where N is at most 20%, so every theme recolors it.
- **Contrast:** at full strength, normal text stays at or above 4.5:1 and muted text at or above
  3:1 over every theme's composited chat surface (unit test).

## 6. Windows lifecycle (`main/lifecycle.ts`)

- **Tray icon:** Open and Quit. Quit really quits.
- **New settings (all off by default):**
  - close to tray;
  - start minimized;
  - open at sign-in. This uses `setLoginItemSettings` with `--start-hidden` and only works in a
    packaged build.
- **Taskbar attention:** the overlay dot shows unread mentions, unread DMs and pending friend
  requests; the frame flashes on new mentions or DMs while unfocused.
- **Window bridge:** `d2:window-show` restores a minimized or tray-hidden window when a
  notification is clicked.
- **Single instance:** a single-instance lock applies when no `D2_PROFILE` is set. Isolated
  test profiles can still run side by side.
- **IPC safety:** every IPC handler checks that the sender is the app page (`isAppUrl`), and
  `lifecycleLogic.ts` validates every value.

## 7. Threat model notes

| Surface | Control |
| --- | --- |
| Profile style JSON | Schema allows an object only; per-key validation; unknown keys rejected; ids from allow-lists; colors regex; integer angle. Rendered only as CSS custom properties built from validated colors; ids never reach a selector or `url()`. |
| Animated images | Magic-byte sniff; the decoder must agree; frame and pixel limits before decoding; re-encode (no original stored); metadata stripped; 20/60 s timeouts; served with `sandbox` CSP. |
| Crop fields | Integers only, inside the image, ±3% aspect, minimum size; otherwise 400. |
| Soundboard files | WAV PCM only (no decoder on the server); size, duration and count limits; random ids; served as `audio/wav` with `nosniff` and `sandbox`; members only. |
| Soundboard play | Server checks membership, voice presence, Speak permission and a per-user token bucket; the event goes to channel occupants only. |
| IPC (lifecycle) | Origin check per call; booleans and clamped numbers only; no paths or URLs accepted. |
| Themes and ambient art | Inline CSS/SVG from this repository only; no remote resources; CSP unchanged. |
| Saved messages | Read access is re-checked on save and on every listing (membership, View Channel, history floor); unreadable ids answer 404; per-user cap; numeric ids only (schema pattern); changes go to the owner's sessions only. |
| Personal notes | Visible-user check like profiles; no read path for anyone but the author; length and character limits on server and client; rendered as plain textarea text (no markup). |

## 8. Database migrations and rollback

| # | Name | Adds | Rollback to older server code |
| --- | --- | --- | --- |
| 9 | `profile_customization` | `users.profile_style`, `users.avatar_animated`, `users.banner_animated` | Nothing to undo. Older code ignores the columns, keeps serving stored (possibly animated) WebP files, and shows no styles. |
| 10 | `soundboard` | `soundboard_sounds` table and index | Nothing to undo. Older code ignores the table; files in `<attachments>/soundboard` can be deleted. |
| 11 | `saved_messages` | `saved_messages` table and index | Nothing to undo. Older code ignores the table. |
| 12 | `user_notes` | `user_notes` table | Nothing to undo. Older code ignores the table. |

All four migrations are additive and run in transactions. Coverage:

- `largeFiles.test.ts` builds a populated v7 database and upgrades it to the latest version.
- `customization.test.ts`, `soundboard.test.ts` and `personal.test.ts` exercise the new schema.
- The compatibility run (test matrix) upgraded a real API 5 database in place with the app open,
  and restored the pre-upgrade backup as a rollback rehearsal.

Before any future production deployment, the same backup rule as Milestone 13 applies: stop the
server or use `sqlite3 .backup`, and rehearse on a copy first. **Nothing was deployed.**
