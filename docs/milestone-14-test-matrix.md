# Milestone 14 — test matrix

All results below were observed in this session on the owner's Windows PC. They are
**automated** tests, **local Electron** checks (scripted over the Chrome DevTools Protocol against
a disposable local server), or are marked **not verified**.

## Automated suites (final run)

| Suite | Command | Result |
| --- | --- | --- |
| Desktop unit/integration | `npx vitest run` (in `desktop/`) | **457/457** passed, 48 files (baseline at start: 364/364) |
| Desktop typecheck | `npm run typecheck` (node + web) | clean |
| Desktop lint | `npx eslint --cache .` | clean (0 problems) |
| Desktop format | `npx prettier --check src scripts` | clean (the generated `assets/sounds/manifest.json` is listed in `.prettierignore`) |
| Sound files reproducible | `node scripts/sounds/render-sounds.mjs --check` | "All sound files match a fresh render." (144 files) |
| Server | `npm test` (in `server/`) | **261/261** passed (241 at the start of this session, which already included the first Milestone 14 customization tests) |
| Server typecheck | `npm run typecheck` | clean |

Server Prettier was not a gate before this milestone: 76 files already differed, including
untouched ones. Those files were not reformatted.

### New tests

| File | Tests | Covers |
| --- | --- | --- |
| `desktop/src/renderer/src/lib/themes.test.ts` | 33 | 12 themes, one per protocol id; unique names and art; unknown-id fallback; valid colors; theme choice across server versions (kept and moved to the account after a server upgrade; another device's later choice wins); **per-theme WCAG contrast** composited over backdrop stops and the ambient tint (text, muted, faint, links, mentions, accent, button text); variable set |
| `desktop/src/renderer/src/lib/profileStyle.test.ts` | 20 | ≥ 12 decorations, 8 effects, 8 banners, 6 name styles; unknown ids ignored; gradient CSS; cleaning and equality; presets; effect < 5 s; profile text readable over any gradient in all 12 themes; GIF/WebP animation detection |
| `desktop/src/renderer/src/sound/packs.test.ts` | 13 | Six complete packs; no stray files; WAV header and hash for all 144 files; loudness, peak, clipping, DC, edges and silence QA; class ordering; uniqueness; size budget; playback from pack files (decoded once); fallback when a file fails; previewing another pack; custom sound still wins; settings migration of the new events |
| `desktop/src/renderer/src/chat/wav.test.ts` | 6 | WAV encoder; trim, length cap and fades; loud clips turned down (never up); soundboard playback at its own volume straight to the output; decode once; volume 0; failed clip |
| `desktop/src/main/lifecycle.test.ts` | 3 | Lifecycle defaults; validation of patches and attention values |
| `desktop/src/renderer/src/chat/saved.test.ts` | 4 | Saved-message ids: nothing until the server has the feature; save uses the server time; saving again keeps the time; unsave removes only that message |
| `desktop/src/renderer/src/lib/wallpapers.test.ts` | 14 | Six chat wallpapers; stored values validated (unknown id → none, strength clamped); in all 12 themes, normal text ≥ 4.5:1 and muted text ≥ 3:1 over the strongest wallpaper |
| `server/test/customization.test.ts` | 16 | API 6 meta; migration 9 columns; existing accounts; profile style save, normalize, visibility (non-sharing user gets 404); 10 invalid styles plus a non-object; clearing; corrupt stored value; app theme sync, validation, legacy prefs; **animated GIF avatar (3 frames, cropped, 320², still 512)**; animated WebP banner (5:2); still picture; removal clears the flag; >300 frames refused; bad, malformed and partial crops |
| `server/test/soundboard.test.ts` | 10 | WAV validation; list (members only); upload permission and validation (415/400/413); audio served to members only with safe headers; **play requires voice presence in that server; event delivered only to that channel's occupants**; rate limit 3 then 429; another server's voice channel refused; removal permissions and file deletion; atomic per-server cap |
| `server/test/personal.test.ts` | 10 | Meta flags and migrations 11–12; saving only readable messages (404 otherwise, bad ids 400); private, newest-first list; saving twice keeps the time; leaving a server hides but keeps, rejoining restores, deleting the message removes; removing always works; sync to your own sessions only; atomic per-user cap; notes readable only by their author, never in profiles; notes only about visible people; 256-character limit (emoji count as one), control characters removed, blank clears; note sync to your own sessions only |

Updated tests (behavior changed on purpose):

- `voiceSoundTracker.test.ts`: reconnect cue, connection-lost cue, own vs remote share.
- `sounds.test.ts`: recipe distinctness now covers the 13 original events.
- `largeFiles.test.ts`: "latest migration" instead of the literal 8.
- `serverAdmin.test.ts`: API version ≥ 5.

## Local Electron evidence

**Setup.** A disposable server ran from `server/src/index.ts` on `127.0.0.1:3201`, later `:3001`.
- Its database was in `%TEMP%\d2-m14`, with open registration, a file mail sink and mock GIFs.
- It held two accounts, Ava and Ben, created by `files/m14/m14-setup.mjs`.
- The desktop was built with a server list containing only that local server. The generated CSP
  `connect-src` was `'self' http://127.0.0.1:* ws://127.0.0.1:*`, so the test app could not reach
  production.
- Each run used an isolated `D2_PROFILE`.

All paths below are in the session folder `files/m14/`. Screenshots are in `shots/`. **Raw output
recorded as files** is in `evidence/`. Rows without an evidence file were observed during the run,
but their output wasn't saved.

| Check | Result | Evidence |
| --- | --- | --- |
| Sign in, Classic look | OK | `shots/00-classic-signed-in.png` |
| All 12 themes applied through the real gallery (card → preview → Apply → close) | OK for all 12. Scripted with `themes-all.js`, which reads back the applied id, ambient art, chat surface and text color. | `shots/t-<theme>.png` × 12, `t-gallery-preview-aurora.png`, `t-gallery-synthwave-applied.png` |
| Theme persists across a full restart | OK (Mint) | `shots/t-mint-after-restart.png` |
| Theme synced to the account; another account sees your profile style | OK: Ava's synced theme is `synthwave`, and Ben reads Ava's full style (Lagoon gradient, Violet Halo, Aurora Shimmer, Waves, Aurora name) | `evidence/m14-cross-account-style.json` |
| Ava sees Ben's server-saved style: gold name, Celestial Ring, Nebula banner, gradient, Golden Sparks, animated avatar | OK. The decoration and banner were animating in the popout. | `evidence/m14-profile-effect-pixels.json`, `shots/p-ben-popout-effect.png` |
| The profile effect really draws, then stops | OK: **3,868** drawn canvas pixels while playing, **0** after it ends | `evidence/m14-profile-effect-pixels.json`, `shots/p-ben-popout-after-effect.png` |
| Profile Studio: gradient, banner art, decoration, effect and name style; Save | OK: "Profile saved" | `shots/s-studio-editing.png`, `s-studio-saved.png`, `s-decorations-grid.png`, `s-effects-names-grid.png` |
| Decoration drawing bug | Found by looking at the screenshots (Petal Fall's petals scattered) and fixed by scoping the CSS transform origin to the animated parts | `shots/s-decorations-grid.png` (after) |
| **Animated picture through the real cropper** (4-frame 300×240 GIF, keyboard nudge, Apply) | OK: the cropper said "the animation is kept". The server stored an animated WebP: 4 frames at 320×320 full, 4 frames at 128×128 small, and a 1-frame 512×512 still. `avatarAnimated: true`, as seen by another account. No runtime errors. | `evidence/cropper-01-ui.json`, `cropper-02-server-media.json`, `shots/cropper-01-animated-gif.png` |
| Cropper layout bug (from Milestone 13): the global `.avatar` class leaked into the dialog, giving a narrow footer and inherited white text | Fixed; in Frosted Glass the footer is 560 px = the dialog width, the heading is dark and the mask is round | `evidence/cropper-03-layout-fixed.json`, `shots/cropper-03-fixed-light-theme.png` |
| Sound Studio: six packs, Audition, pack choice persists | OK. Audition fetched and played the pack's files (e.g. Minimal, `sounds4.js`); choosing Cyber was saved in settings (`pack-persist.js`). | `shots/a-sound-studio.png` |
| Close to tray with a real Win32 `WM_CLOSE` | With it on: process alive, window hidden; `showWindow()` restored it; the taskbar badge call returned true. With it off: `WM_CLOSE` quits the app. "Open at sign-in" is reported unavailable in an unpackaged dev build, as designed. | `evidence/m14-lifecycle-wm-close.json`, `shots/w-windows-settings.png` |
| **Saved messages and personal notes** (Synthwave theme, Ava) | Toolbar bookmark → saved (aria-pressed). Context menu offers "Save Message". The Saved panel lists both newest first with "#general · Renaissance Lab". Jump closes the panel and flashes the message. Remove updates the list and the bookmark. A note about Ben, labelled "only you can see this", is saved and still there after reopening. The server shows Ava 1 saved message and the note, and Ben 0 saved and no access to Ava's note. No runtime errors. | `evidence/saved-notes-e2e.json`, `saved-notes-server-state.json`, `shots/saved-01…03` |
| Chat wallpaper (Synthwave, Ava) | Appearance shows None plus 6 patterns. Choosing Circuit draws 3 gradient layers behind the messages at 10% ink (the default strength); None removes it (`background-image: none`). No runtime errors. | `evidence/wallpaper-e2e.json`, `shots/wallpaper-01-picker.png`, `wallpaper-02-circuit-synthwave.png` |
| **Packaged** preview build: first launch, sign in as Ben, Ava's style visible | OK | `shots/pkg-01-first-launch.png`, `pkg-02-ben-sees-ava.png` |
| Packaged **1.4.0-m14.2** (before the wallpaper) | Signed in on the local server; Saved Messages and the note field present; Ben sees Ava's style; Audition fetched 30 pack files (all 200) and decoded all 30 at 48 kHz; no errors | `evidence/pkg-m14.2-smoke.json`, `shots/pkg2-01…02` |<NL>| Packaged **1.4.0-m14.3** (final) | Package scan clean (167 entries, 144 sounds, CSP limited to the three configured servers). **Launch blocked by Windows Application Control** (unsigned build; Code Integrity 3077/3033); not bypassed, so this build was not run here. | `evidence/pkg-m14.3-asar-scan.json` |

## Compatibility and upgrade run (older server → Milestone 14 server)

This answers "does the new app work with existing accounts and servers, and survive the server
upgrade?"

**Setup.**
- The committed server (`8f13638`, API 5, migrations 1–8) was extracted with `git archive` into
  `%TEMP%\d2-old-server` and run on `127.0.0.1:3202` with a fresh database.
- `compat-setup.mjs` created two ordinary accounts, Cora and Dex, a shared server, messages, a still
  avatar, a bio and saved preferences (compact density, 25-minute idle).
- The Milestone 14 desktop build allowed only `127.0.0.1`.

| Step | Result | Evidence |
| --- | --- | --- |
| Old server state | API 5, no `customization` flag, migrations 1–8, 3 messages | `evidence/compat-00-setup-old-server.json`, `compat-01-old-server-before.json` |
| New app on the old server | Signed in. Saved preferences were honored (compact). The gallery said themes are saved on this PC only; Forest was applied locally and marked "unsynced". Profile Studio showed its preview-only note. A message was sent (201). **No preference or profile writes were attempted, no request failed and there were no runtime errors.** | `evidence/compat-02-client-on-old-server.json`, `shots/compat-01…03` |
| Backup before the upgrade | `VACUUM INTO` backup: integrity ok, migration 8, 3 users, 6 messages | (command output) |
| First in-place upgrade (new server, same database) | Migrations 9 and 10 applied. Every account field, the avatar, all preferences and messages were kept. | `evidence/compat-04-server-after-upgrade.json` |
| **Bug found:** the running app kept its pre-upgrade preferences after reconnecting, so the theme didn't move to the account until a restart | Fixed: preferences are now re-fetched after every reconnect, ignoring older copies | `evidence/compat-03-client-after-upgrade.json` (before the fix) |
| **Rollback rehearsal:** restore the backup | Restored database: integrity ok, migration 8, no Milestone 14 columns; the old server ran on it again | (command output) |
| Second in-place upgrade with the app left open | The theme moved to the account about 4 s after the reconnect. The theme log shows only `forest` (no flash to Classic). There was one `PATCH {appTheme:"forest"}` → 200. The Studio was unlocked and a decoration saved, which Dex sees. No failed requests, no errors. | `evidence/compat-06-client-after-live-upgrade.json`, `compat-07-server-after-live-upgrade.json`, `shots/compat-04…05` |
| App restart after the upgrade | Forest still applied (now from the account); the "unsynced" mark is gone | `evidence/compat-08-client-restart-after-upgrade.json` |

The production Jetson runs API 4 and was not contacted. API 4 and API 5 look the same to the
Milestone 14 client (neither has `customization`). The Milestone 13 RC1 compatibility run
covered the API 4 differences.
## Not verified (blind spots)

- **Hearing:** nobody has listened to the 144 sounds. Only objective QA was done: loudness,
  peaks, duration, decode. See the audition checklist in the manual test guide.
- **Voice:** real calls, screen sharing, a soundboard clip heard by two people in a live
  LiveKit call, and push-to-talk cues. The LiveKit binary is blocked by Smart App Control on
  this PC (not bypassed). Server delivery to voice occupants is covered by
  `soundboard.test.ts`, using simulated voice state.
- **Windows shell:** a Windows toast click restoring a tray-hidden window, the overlay dot as
  rendered by Explorer, and the tray menu. The IPC paths were exercised; the shell UI was not
  clicked by a person.
- **Launch at login:** only possible in a packaged build. Not toggled, to avoid registering a
  login item on the owner's PC.
- **Performance:** GPU/CPU cost of animated themes over a long session, and 10k-message
  scrolling with decorated avatars. Not measured. Reduced effects and reduced motion are
  available as mitigations.
- **Other platforms and screens:** 80% and 150% scaling with the new screens was not
  screenshotted this session (Milestone 13 verified scaling generally). Only screen-reader
  labels were reviewed, not tested with an actual screen reader.
- **Production:** the Milestone 14 client against the real API 4 Jetson. It was not contacted on
  purpose. An API 5 server, which looks the same to this client, and an in-place upgrade were run
  locally (see the compatibility run).
