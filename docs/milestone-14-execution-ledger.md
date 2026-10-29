# Milestone 14 — execution ledger

Live checklist for Operation Renaissance (Milestone 14: visual identity, sound identity,
communications polish). Updated as work lands. States: `planned`, `in-progress`,
`implemented` (code done, not fully verified), `tested` (automated tests and/or Electron
evidence recorded), `blocked`.

## Session guardrails (verified at start)

| Check | Result |
| --- | --- |
| Workspace | `C:\Users\LStAm\Documents\Discord2.0\Discord2.0` (Windows, Node v24.22.1) |
| Git | branch `milestone-13`, HEAD `8f13638` (pushed earlier with approval). No commits or pushes during the autonomous work; the approved commit is the last event below. |
| Dirty tree at start | 15 entries: the earlier Milestone 14 server work (migration 9, profile style, animated media) and `lib/themes*.ts` |
| Snapshot | `C:\Users\LStAm\Documents\Discord2.0\snapshots\m14-start-20261028-140225.zip` (325 files: tracked + untracked, ignored files and `.env` excluded), SHA-256 `3B7EC9AA…73F2` |
| Production | Not contacted, not changed. Jetson, router, DNS, Caddy, LiveKit untouched. |
| Installed v1.2.0 / RC1 artifacts | Untouched (`desktop/dist/m12/`, `desktop/dist/v1.3.0-rc1/`). |
| Tools | No ffmpeg/sox on this PC: audio is rendered by a dependency-free Node synthesizer straight to WAV. |
| Browser research | Chrome DevTools MCP connected (developer.chrome.com, Discord support, GitHub, MDN, W3C pages read). |

## Baseline (start of session)

| Suite | Command | Result |
| --- | --- | --- |
| Server | `npm test` (in `server/`) | 241/241 pass (225 Milestone 13 + 16 new customization tests) |
| Server typecheck | `npm run typecheck` | clean |
| Desktop | `npx vitest run` (in `desktop/`) | 384 pass, 8 fail — all 8 in the new, unfinished `lib/themes.test.ts` (accent contrast); the 364 Milestone 13 tests all pass |

## Task board (final)

States: **tested** = verified by automated tests and/or Electron runs with recorded evidence.
**built, not verified** = complete code whose key behavior needs something unavailable here.
**not started**.

| ID | Feature | Subsystem | State | Evidence |
| --- | --- | --- | --- | --- |
| A1 | Baseline, snapshot, ledger | repo | tested | tables above |
| S1 | Profile style API, migration 9, `appTheme` preference, animated avatar/banner processing | server | tested | `customization.test.ts` (16) |
| V1 | Theme engine + 12 themes | desktop | tested | `themes.test.ts` (33), `shots/t-*.png` |
| V2 | Theme gallery (preview, apply/cancel/reset), synced/local persistence | desktop | tested | gallery runs, `t-mint-after-restart.png` |
| V3 | Profile rendering: 12 decorations, 8 effects, gradients, 8 banner arts, 6 name styles | desktop | tested | `profileStyle.test.ts` (20), `evidence/m14-profile-effect-pixels.json` |
| V4 | Profile Studio editor | desktop | tested | `s-studio-*.png`, compat run (save after upgrade) |
| V5 | Animated avatars/banners in the client and cropper | desktop | tested | `evidence/cropper-0*.json` |
| A2 | Six sound packs rendered to WAV + objective QA | tooling/assets | tested | `packs.test.ts`, `render-sounds.mjs --check` |
| A3 | Sound registry + pack playback with fallback | desktop | tested | `packs.test.ts`, packaged decode (`evidence/pkg-m14.2-smoke.json`) |
| A4 | Sound Studio (packs, Audition, soundboard volume) | desktop | tested | `a-sound-studio.png`, `pkg2-02-sound-studio.png` |
| A5 | New sound events wired (DM, friend accepted, connection lost, reconnect, remote share, PTT, uploads, send failed) | desktop | tested (unit) | `voiceSoundTracker.test.ts`, `sounds.test.ts`; in-call sounds not heard |
| C1 | Tray, close to tray, start minimized, open at sign-in, taskbar attention, single instance | desktop/main | tested | `evidence/m14-lifecycle-wm-close.json`, `lifecycle.test.ts` |
| D1 | Soundboard (server + app) | server/desktop | built, not verified | `soundboard.test.ts` (10); no real call possible |
| D2 | Saved messages (bookmarks) | server/desktop | tested | `personal.test.ts`, `saved.test.ts`, `evidence/saved-notes-*.json` |
| D3 | Personal notes | server/desktop | tested | same as D2 |
| V6 | Chat wallpaper (6 patterns, strength, device-only) | desktop | tested | `wallpapers.test.ts` (14), `evidence/wallpaper-e2e.json` |
| X1 | Compatibility: API 5 server + live in-place upgrade + rollback rehearsal | QA | tested | `evidence/compat-0*.json` |
| X2 | Fix: theme kept and moved to the account after a server upgrade | desktop | tested | `themes.test.ts`, `compat-06…08` |
| X3 | Fix: preferences re-fetched after reconnect | desktop | tested | `compat-06` |
| X4 | Fix: cropper `.avatar` class leak (from Milestone 13) | desktop | tested | `evidence/cropper-03-layout-fixed.json` |
| X5 | Fix: leaving voice updates your icon at once (owner report) | desktop | tested (unit) | `MediaSession.test.ts`, `voiceLogic.test.ts`; no live call possible here |
| F2 | Isolated portable build (final `1.4.0-m14.3`) | build | tested (m14.2 run); m14.3 scanned, launch blocked by Application Control | `evidence/pkg-m14.2-smoke.json`, `pkg-m14.3-asar-scan.json` |
| F3 | Reports and manifests (9 documents) | docs | done | `docs/milestone-14-*.md` |
| N1 | Custom emoji/stickers, voice messages, streamer mode, game activity, voice HUD, onboarding | — | not started | see the final report §8 |

## Order of notable events

1. Baseline, snapshot and ledger; the theme engine finished. The 8 baseline contrast failures in
   the unfinished theme work now pass.
2. Profile rendering, the Studio and animated media. Petal Fall's scattering petals were spotted
   in a screenshot and fixed.
3. The sound renderer and packs; Sound Studio; event wiring. A PowerShell `${…}` interpolation bug
   in two edits was caught by tests and fixed.
4. Windows lifecycle verified with a real `WM_CLOSE`; then the soundboard (server + app).
5. Gates and the first preview (m14.1).
6. The compatibility run found that themes chosen on an older server were lost on upgrade, and that
   preferences weren't re-fetched after a reconnect. Both were fixed and re-verified by restoring the
   backup and upgrading again.
7. The animated cropper E2E found the Milestone 13 cropper layout leak, which was fixed.
8. Saved messages and personal notes, end to end.
9. Preview m14.2 rebuilt, scanned and smoke-tested from the package.
10. Chat wallpaper added; preview rebuilt as m14.3 and scanned. Windows Application Control blocked launching the unsigned m14.3 exe; it was not bypassed.
11. At the owner's request: committed to a new `milestone-14` branch (from `8f13638`) and pushed. Not deployed.
12. Owner report: leaving a call took a moment for your own icon to leave. Fixed, then committed and pushed to `milestone-14` at the owner's request: `leave()` publishes the "left" state before the connection finishes closing, the closing room is detached first, and the app drops your own voice entry without waiting for the server.

## Where to resume

- Real-voice checks (soundboard, PTT cues, in-call sounds) on hardware where LiveKit runs.
- Owner listening pass (checklist in the manual test guide).
- 80%/150% scaling screenshots of the new screens; a screen-reader pass.
- Next features: custom emoji (server library, picker tab, message tokens), voice messages.