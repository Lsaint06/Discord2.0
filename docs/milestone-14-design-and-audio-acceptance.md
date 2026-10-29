# Milestone 14 — design and audio acceptance

This maps every acceptance item in Part 1 (§3.6 visual, §4.4–4.6 audio) to what exists and the
evidence for it. Status values: **Met** (verified), **Partial** (built, but some of it not
verified), **Not done**. Evidence paths are in the session folder `files/m14/` unless they are
repository paths. The full detail is in [milestone-14-test-matrix.md](milestone-14-test-matrix.md).

## Visual (§3.6)

| Acceptance item | Status | Evidence / notes |
| --- | --- | --- |
| All (≥10) themes individually applied and checked across major surfaces; ≥5 screenshots | **Met** | 12 themes, each applied through the real gallery; `shots/t-<theme>.png` × 12. Per-theme WCAG contrast tests over every surface, backdrop and ambient tint (`lib/themes.test.ts`, 33 tests). |
| All 12 decorations selectable, aligned, persisted; test at 80% and 150% | **Partial** | Selectable and saved (Ben: Celestial Ring; Cora: Moonlight Orbit, saved after the upgrade run); grid in `shots/s-decorations-grid.png`; the Petal Fall alignment bug was found and fixed. **Not re-checked at 80%/150% scale this session.** |
| All 8 effects animated, visibly different, stop when closed, reduced-motion still variant | **Partial** | Golden Sparks drew 3,868 canvas pixels while playing and 0 after it ended (`evidence/m14-profile-effect-pixels.json`). The tiles in `shots/s-effects-names-grid.png` show they look different. Reduced motion is in code (`ProfileMotionContext`, still frame), but **not observed in Electron this session**. |
| Avatar/banner still and animated behavior verified with real fixtures | **Met** | Server tests with GIF/WebP fixtures (`customization.test.ts`). A real cropper upload gave 4 animated frames plus a still frame (`evidence/cropper-0*.json`). |
| Account A saves a shared look, account B sees it on a disposable local server; old backend degrades gracefully | **Met** | `evidence/m14-cross-account-style.json`, `shots/p-ben-popout-effect.png`. The API 5 server run and in-place upgrade are in `evidence/compat-0*.json`. |
| Profile editor and cards accessible, keyboard-operable, readable, nothing clipped | **Partial** | Studio tiles are radio groups with arrow-key navigation; the gallery supports arrow keys; profile text contrast is tested over any gradient in all themes. A cropper layout leak was fixed (`evidence/cropper-03-layout-fixed.json`). **No screen-reader pass and no full keyboard-only walkthrough was recorded.** |
| Unknown theme/decoration/effect ids and missing assets don't crash | **Met** | Unknown ids are ignored (`profileStyle.test.ts`, `themes.test.ts`). The server normalizes and reads corrupt stored values as none (`customization.test.ts`). A missing sound file falls back to the built-in recipe (`packs.test.ts`). |
| Username treatments (§3.5): gradient, metallic, silver, neon, aurora, holographic; text stays text | **Met** | Six name styles. The name stays real, selectable text (CSS on the text, never an image). |
| Optional local chat wallpaper (§3.5) | **Met** | Six original patterns in the theme's colors, strength slider, this device only; contrast tested at full strength in all 12 themes (`wallpapers.test.ts`); applied and removed in Electron (`evidence/wallpaper-e2e.json`). Bubble styles were not added. |

## Audio (§4.4–4.6)

| Acceptance item | Status | Evidence / notes |
| --- | --- | --- |
| Every declared event maps to real audio or an explicit fallback | **Met** | 24 events × 6 packs = 144 files; each event also has a fallback recipe (`packs.test.ts`). |
| Codec, existence, sizes, durations, licensing, no path bugs in the packaged build | **Met** | Format, hash, loudness, peak, edges and size are checked for all 144 files (`packs.test.ts`); all audio is original and rendered by `scripts/sounds/render-sounds.mjs`. Packaged-build loading is in the final report's packaged smoke test. |
| Unit tests: settings migration, per-event gain, disable, pack switching, rate limiting, duplicate suppression, failure recovery | **Met** | `packs.test.ts`, `sounds.test.ts`, `soundSettings.test.ts`, `soundPolicy` and `SoundService` tests (Milestone 13 + 14). |
| Join/leave/mute/share and DM/mention dispatch exactly once | **Met** (unit level) | `voiceSoundTracker.test.ts` (own vs remote share, connection lost vs left, reconnect once); `soundPolicy.test.ts` (message, mention and DM decisions, deduplication). |
| Two-client local test of sounds and the remote soundboard; owner listening checklist | **Partial** | The server delivers `soundboard_play` only to that voice channel's occupants (`soundboard.test.ts`, simulated voice state). **No audible two-client test, because LiveKit can't run on this PC.** The listening checklist is in the manual test guide. |
| DND/silent mode, old preferences, no announcement storm after reconnect, CPU impact | **Partial** | DND and old-preference migration are unit-tested; the voice tracker's join-burst settling prevents reconnect storms. **CPU impact during a live call was not measured.** |
| Sound Studio (§4.4): packs + audition, per-event toggles/volume, master + soundboard volume, preview without saving, custom sounds survive, burst limiting, never amplify | **Met** | `shots/a-sound-studio.png`. `preview(event, pack)` leaves your choice alone; "custom sound still wins" and the burst gating are tested; soundboard clips are only ever turned down (`wav.test.ts`). |
| Streamer mode; output-device switching for effects | **Not done** | Not changed in Milestone 14. |
| Soundboard (§4.5): server-authorized clips, upload UI, grid with preview, search, permissions, local volume, cooldowns, limits, ownership | **Partial** | Built and tested on the server (`soundboard.test.ts`). The client has upload, grid, search, local preview and volume. **Not done:** favorites, keybinds, entrance sounds. **Must not be described as a working shared soundboard until two people hear a clip in a real call.** |

## Summary

- **Met:** themes, shared profile looks across accounts and server versions, animated pictures,
  safe fallbacks, name styles, sound coverage and file QA, Sound Studio.
- **Partial:** scaling checks, the reduced-motion observation, a full accessibility pass, anything
  that needs real voice (soundboard audibility, cues in calls) and CPU measurement.
- **Not done:** streamer mode, soundboard favorites/keybinds/entrance sounds, chat bubble styles.
