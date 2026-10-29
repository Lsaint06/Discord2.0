# Milestone 14 — "Operation Renaissance" final report

**Status:** local implementation complete for the items below. Nothing was committed or pushed
during the autonomous session. Afterwards, at the owner's request, it was **committed and pushed to
branch `milestone-14`** (2026-10-28). **Nothing is deployed.** The production Jetson, your installed
v1.2.0 app and the RC1 builds are untouched.

## 1. Executive summary

Discord 2.0 now has the following, all free, with no paywall code:

- **Visuals:** 12 original full-app themes with a live gallery; a Profile Studio with 12
  decorations, 8 effects, 8 banner arts, 6 name styles and gradients; animated profile pictures
  and banners.
- **Audio:** 6 original sound packs (144 rendered files) with a Sound Studio, plus a
  server-authorized soundboard.
- **Windows:** tray icon, close to tray, start minimized and taskbar attention.
- **Daily use:** private saved messages, private notes about people, and an optional chat wallpaper that stays on this device.

All shared features are capability-gated. The new app was run against an older (API 5) server and
through a live in-place server upgrade with no failed requests and no data loss. That run also
found two bugs, which were fixed.

## 2. Safety record

| Boundary | Evidence |
| --- | --- |
| No commits, pushes or stashes during the session | HEAD stayed at `8f13638` on `milestone-13`, 0 new commits, 0 stashes: 53 tracked files modified (+3,254/−606 lines) and 189 untracked files. They were committed afterwards, on the owner's request, to a new `milestone-14` branch created from `8f13638`. |
| No production contact or changes | Every test build was compiled with a local-only server list; its CSP allowed only `127.0.0.1`. The Jetson was never contacted. |
| No deployments or live migrations | Migrations 9–12 ran only on throwaway databases in `%TEMP%`. |
| Installed v1.2.0 untouched | Every run used an isolated `D2_PROFILE` (`%APPDATA%\desktop-<profile>`); `%APPDATA%\desktop` was never used. Your running `Discord2` processes were not touched. |
| RC1 untouched | `desktop/dist/v1.3.0-rc1`: 78 files, 664,058,255 bytes before and after repackaging. |
| Starting snapshot | `C:\Users\LStAm\Documents\Discord2.0\snapshots\m14-start-20261028-140225.zip` (325 files, SHA-256 `3B7EC9AA…73F2`). |
| No Windows security bypass | LiveKit stayed blocked by Smart App Control; voice-dependent checks are listed as not verified. |
| No proprietary assets | All visuals are original CSS/SVG/canvas code and all sounds are rendered by our own script; 0 third-party assets (see the asset manifests). |

## 3. What was built

### Visual identity (Part 1 §3)

| Feature | State |
| --- | --- |
| Theme engine: semantic tokens, translucent panels over a backdrop, opaque dialogs, ambient art, glass blur, reduced effects | Done; per-theme WCAG contrast tests |
| **12 themes:** Obsidian, Cyber, Sakura, Aurora, Void, Solar, Abyss, Amethyst, Glass, Synthwave, Forest, Mint (3 light) | Done; all applied in Electron with screenshots |
| Theme gallery: live preview, Apply/Cancel/Reset, arrow keys; synced to the account on API 6, saved on this PC on older servers | Done |
| **Profile Studio:** gradients (0–3 colors, angle, presets), 8 banner arts, **12 decorations**, **8 effects**, **6 name styles**, live preview | Done; saved, and seen by a second account |
| Animated profile pictures and banners (GIF/WebP kept animated, still frame for lists, crop on the server) | Done; tested through the real cropper |
| Motion rules: effects under 5 s, replay on hover, stop when hidden; reduced motion → still | Done in code (reduced-motion not observed in Electron this session) |

### Sound identity (Part 1 §4)

| Feature | State |
| --- | --- |
| Registry of 24 events (10 new: DM, friend accepted, connection lost, reconnected, remote share start/stop, PTT on/off, upload done/failed, send failed) | Done; wired to real event sources |
| **6 original packs × 24 events = 144 WAV files** (9.3 MB), loudness-normalized, reproducible (`--check`) | Done |
| Sound Studio: pack picker, Audition, per-group and soundboard volume; your custom sounds still win | Done |
| Settings migration: new events inherit your old choices | Done; unit-tested |
| **Soundboard:** WAV-only uploads (converted in the app), 48 per server, server checks voice presence and Speak, rate limit, delivered only to that voice channel | Server and app built and tested. **Not heard by two people in a real call.** |

### Communications and Windows (Part 2 §6.1, §6.11)

| Feature | State |
| --- | --- |
| Tray icon (Open/Quit); close to tray, start minimized, open at sign-in (packaged builds only) — all off by default | Done; real `WM_CLOSE` verified |
| Taskbar overlay dot and frame flash for mentions/DMs/friend requests; notification click restores a hidden window | Done (IPC verified; the shell UI wasn't clicked by a person) |
| Single-instance lock (skipped for isolated test profiles) | Done |

### Daily use (Part 2 §6.6, §6.7)

| Feature | State |
| --- | --- |
| **Saved messages:** toolbar bookmark, context menu, Saved panel with Jump/Remove; private; access re-checked on every listing; 500 cap; synced to your devices | Done; server + app + Electron E2E |
| **Personal notes:** private note in profile popouts (256 characters), synced to your devices, readable by nobody else | Done; server + app + Electron E2E |
| **Chat wallpaper** (Part 1 §3.5): 6 original CSS patterns in your theme's colors, strength slider, this device only (nothing uploaded); text contrast tested at full strength in all 12 themes | Done; unit + Electron |

### Compatibility and fixes found by testing

| Item | State |
| --- | --- |
| Capability gating (`customization`, `savedMessages`, `userNotes` flags; API 6) | Done; verified against API 5 |
| **Fix:** a theme chosen on an older server reset to Classic after the server upgrade | Fixed: moved to the account once, no flash (unit + E2E) |
| **Fix:** the app kept stale preferences after reconnecting | Fixed: re-fetched on every reconnect, ignoring older copies |
| **Fix (from Milestone 13):** the image cropper inherited the global `.avatar` styles (narrow footer, white text in light themes) | Fixed and verified in the Glass theme |
| **Fix:** Petal Fall decoration petals scattered (SVG transform origin) | Fixed |
| **Fix (reported by the owner after the commit):** leaving a call took a moment for your own icon to leave the channel | Fixed: the app shows you as gone at once and takes you out of its voice list without waiting for the server; cleanup continues in the background. Unit-tested (the tests fail on the old code); not tried in a live call |

## 4. Numbers

| What | Count |
| --- | --- |
| Themes / decorations / effects / banner arts / name styles | 12 / 12 / 8 / 8 / 6 |
| Sound packs / sound files | 6 / 144 (24 events) |
| Third-party assets | 0 |
| New dependencies | 0 |
| Database migrations (additive) | 4: 9 `profile_customization`, 10 `soundboard`, 11 `saved_messages`, 12 `user_notes` |
| API version | 6, with `customization`, `savedMessages` and `userNotes` flags |
| Desktop tests | **462/462** (49 files); 364 at the start; 98 new |
| Server tests | **261/261**; 241 at the start; 20 new this session |
| Typecheck (desktop node + web, server) / ESLint / Prettier (desktop) | clean / clean / clean |
| Sound reproducibility (`render-sounds.mjs --check`) | all files match |

## 5. Preview build (for you to try)

- `desktop/dist/v1.4.0-m14-preview/Discord2-1.4.0-m14.3-win-x64.zip`
  - 161,179,970 bytes, SHA-256 `A96255C9AD64C35DBC907757EEE893E4CD4CAE3C1C0A61B7BF3AF3ABDA8B5993`
  - portable zip, unsigned, no installer
- **Package scan:** 167 entries; no sources, scripts, `.env`, sourcemaps or configs; all 144 sounds.
- **CSP:** `localhost`, `landhoev3.duckdns.org` and `192.168.68.65` only.
- **Packaged smoke test against the local server** (run on build m14.2, which is identical except for the chat wallpaper added afterwards):
  - signed in;
  - new features present;
  - Ben sees Ava's style;
  - 30 pack files fetched and decoded at 48 kHz;
  - no errors.
- **m14.3 was blocked at launch on this PC** by Windows Application Control (Code Integrity events 3077/3033 at 16:00; the build is unsigned). It was **not bypassed**. Its package scan is identical and clean, and the wallpaper was verified in the development runtime. If Windows blocks it for you too, that is Smart App Control's call on unsigned apps; code signing would avoid it.
- The m14.1 and m14.2 previews it replaced were my own earlier artifacts.
- `desktop/package.json` now says `1.4.0-m14.3` (local only). Revert it if you'd rather keep
  `1.3.0-rc.1` until release.

How to run it safely: [milestone-14-manual-test-guide.md](milestone-14-manual-test-guide.md).

## 6. Evidence

Everything is listed with file paths in [milestone-14-test-matrix.md](milestone-14-test-matrix.md).
The evidence covers:

- raw JSON outputs (`files/m14/evidence/`, 20 files) and screenshots (`files/m14/shots/`);
- the compatibility and upgrade run, including a rollback rehearsal from a `VACUUM INTO` backup.

[milestone-14-design-and-audio-acceptance.md](milestone-14-design-and-audio-acceptance.md) maps
Part 1's acceptance list to these results.

## 7. Not verified (honest gaps)

- **Anything needing real voice** (LiveKit is blocked on this PC):
  - soundboard clips heard by others;
  - push-to-talk cues;
  - connection-lost and reconnect sounds in a real call;
  - the share sounds;
  - CPU use during calls.
- **Hearing:** nobody has listened to the 144 sounds yet. The listening checklist is in the
  manual test guide.
- **Scale and accessibility:** 80% and 150% scale screenshots of the new screens; a screen-reader
  pass; reduced motion observed in Electron.
- **Windows shell:** clicks on a real toast and the tray, as performed by a person; "open at
  sign-in" (left off to avoid registering a login item).
- **Production:** the Jetson itself (API 4). Not contacted on purpose.

## 8. Not built (remaining spec items)

- Custom emoji and stickers.
- Voice messages.
- Streamer mode.
- Soundboard favorites, keybinds and entrance sounds.
- Game activity.
- Mini voice HUD (stretch).
- Server onboarding/rules.
- Per-participant volume and device recovery work. Untouched in this milestone because real voice
  can't be checked here.

## 9. Before any deployment (needs your approval)

1. Review the `milestone-14` branch (committed; not merged anywhere).
2. Back up the Jetson database (stop the server or `sqlite3 .backup`) and rehearse the upgrade on a
   copy. Migrations 9–12 are additive, and older server code ignores them.
3. Deploy the server, then hand out the matching desktop build. The client also works against the
   old server in the meantime: themes are saved locally and move to the account after the upgrade.
4. Check soundboard audio in a real call before announcing it.

## 10. Documents

- [v1.4.0-release-readiness.md](v1.4.0-release-readiness.md) — v1.4.0 release readiness: audit,
  migration and rollback rehearsal, compatibility, release candidate (with
  [deployment plan](v1.4.0-deployment-and-rollback.md) and
  [compatibility](v1.4.0-compatibility.md))
- [milestone-14-execution-ledger.md](milestone-14-execution-ledger.md) — what was done, in order
- [milestone-14-architecture.md](milestone-14-architecture.md) — design, data flow, threat model,
  migrations
- [milestone-14-test-matrix.md](milestone-14-test-matrix.md) — commands, counts, evidence, gaps
- [milestone-14-manual-test-guide.md](milestone-14-manual-test-guide.md) — how to try it safely
- [milestone-14-design-and-audio-acceptance.md](milestone-14-design-and-audio-acceptance.md)
- [milestone-14-visual-and-audio-research.md](milestone-14-visual-and-audio-research.md) — sources
  and licenses
- [milestone-14-visual-asset-manifest.md](milestone-14-visual-asset-manifest.md) and
  [milestone-14-sound-asset-manifest.md](milestone-14-sound-asset-manifest.md)
