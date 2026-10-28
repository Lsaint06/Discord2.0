# Discord 2.0 v1.3.0 RC1 — stabilization report

Status: **release candidate built locally. Waiting for your review.**

Nothing has been committed, pushed, released or deployed. The Jetson, router, DNS and production
data were not touched. The installed v1.2.0 app and its profile were not modified.

Branch: `milestone-12-public-client` (HEAD `3d46b11`). All Milestone 13 work is uncommitted
(85 modified files, 64 new).

This report follows [milestone-13-overnight-report.md](milestone-13-overnight-report.md). That
document still describes each feature in detail; this one covers what changed during
stabilization and where the RC stands.

## Feature status

| Feature | State | Evidence |
| --- | --- | --- |
| Email sign-up / verify / sign-in / password reset | Implemented | Electron end-to-end with the file mail sink. Real SMTP **awaiting external testing** |
| Invite-only registration, onboarding, session restore after restart | Implemented | Electron end-to-end |
| Drafts, Ctrl+K switcher, emoji picker/autocomplete, mention badges | Implemented | Electron end-to-end |
| Message actions (hover toolbar, Shift quick-delete) | Implemented | Electron end-to-end with two accounts; the deletion appears live for the other user |
| UI scale 100/125/150%, density, narrow-window layout | Implemented | Screenshots at each scale (see below) |
| Sounds: per-category/per-event volume, custom WAV import and preview | Implemented | Electron end-to-end |
| Keybind editor (app-focused + opt-in system-wide mute/deafen) | Implemented | Electron end-to-end. System-wide shortcut while another app is focused **awaiting external testing** |
| Voice connection panel, noise suppression/echo/AGC toggles | Implemented | UI and settings verified. Real calls **blocked locally** (Smart App Control blocks the LiveKit binary) |
| Screen-share start/stop sounds | Implemented | Unit tests only. **Awaiting external testing** |
| Server admin (icon, description, layout, user limits, timeouts) | Implemented, **needs server deploy** | Server tests; Electron end-to-end against the new server |
| GIF picker | Implemented, **needs server deploy + GIPHY key** | Electron with the offline mock provider |
| Large files (≤5 GB, chunked, resumable, >500 MB expire after 24 h) | Implemented, **off by default; needs server deploy + Jetson capacity tests** | Electron end-to-end with 520 MB and 40 MB files, including kill-and-resume |
| Daily Word | Implemented | Electron end-to-end |

## Bugs found and fixed during stabilization

| # | Severity | Problem | Fix |
| --- | --- | --- | --- |
| 1 | High | Uploads lived inside the composer. Switching channels during an upload lost it (and could attach the file to the wrong channel). | New app-level `UploadManager` (`chat/uploadManager.ts`, 9 tests). Uploads keep going across channel switches. A sidebar indicator shows progress and navigates back to the channel. Large uploads are remembered so that re-picking the same file after a restart resumes the server session. On a `too_many_uploads` error, orphaned sessions are cancelled and the upload is retried once. |
| 2 | Medium | At 150% scale the chat panel was squeezed to ~290 px: the header title collapsed and file cards broke. | Narrow windows (≤980 CSS px) now show the member list as an overlay, and the header can shrink. |
| 3 | Low | Returning to a channel put the caret before the restored draft. | The caret is placed at the end. |
| 4 | Low | Clicking the GIF/emoji button a second time closed and immediately reopened the picker. | The toggle buttons are excluded from the outside-click check. Moving focus out of the picker closes it, and Escape returns focus to the composer. |
| 5 | Low | The image lightbox had no focus trap. | It now uses the shared dialog hook (trap, Escape, focus restore). |
| 6 | Low (server) | A client cancelling a chunk upload was logged as an unhandled server error. | Now returns 400 `chunk_aborted`. |

**Remaining known limitation:** after an app restart, a large upload can only resume if the user
picks the same file again (same name, size and channel). The app cannot reopen a file by
itself.

## Tests and gates (final run)

- **Desktop:** 364/364 tests (41 files). Prettier, ESLint and typecheck clean.
- **Server:** 225/225 tests. Typecheck clean. `npm run build` OK.
- **Audit:** `npm audit --omit=dev` reports 0 vulnerabilities in both packages.
- **Electron acceptance (isolated profile, local test servers):** passed with no console errors.
  - First launch without the server chooser, registration, email verification (sign-in before
    verifying is refused), onboarding.
  - A second account: live send and receive, quick-delete synchronized.
  - Ctrl+K, drafts, emoji picker, image viewer previous/next, GIF picker, Daily Word.
  - All settings sections, and custom sound import.
  - Password recovery: the old session and old password are rejected afterwards.
  - Session restore after a full restart, and focus traps on every overlay.
- **Upload resume (throttled through DevTools):**
  - Switching channels mid-upload: the file is still delivered to its own channel.
  - Cancelling from the indicator works.
  - Killing the app at 30% and re-picking the file resumed the same server session at byte
    218 103 808. No new upload was started.

## Compatibility

| Client | Server | Result |
| --- | --- | --- |
| 1.3.0 RC1 | API 5 (new server) | All features: verified locally |
| 1.3.0 RC1 | **API 4 (production commit 86831b4)**, run from a separate worktree with a disposable DB | Verified. Username sign-in, "Have an invitation?" sign-up and recovery-code reset all work. API-5 features are hidden: no icon/description/layout/user-limit/timeout editors and no GIF button. A 40 MB file is refused with "Files can be at most 25 MB". Messaging works. The old server logged zero 4xx/5xx responses. |
| 1.2.0 | API 5 | API changes are additive, so this should work. **Not verified** with a real 1.2.0 build. |

**Database upgrade rehearsal:**

- **Setup:** a database created by the production-era server (schema v5, with users, a server,
  memberships, channels and messages) was started with the new server.
- **Result:** migrations 6–8 applied, giving schema v8.
  - Every row count was unchanged.
  - `integrity_check` returned ok, with 0 foreign-key violations.
  - The old account signed in and read its server and messages through the new API, with no
    errors logged.
- **Lesson for the Jetson backup:**
  - A plain file copy of a running database **misses data still in the `-wal` file**. The first
    rehearsal copy was missing a server for exactly this reason.
  - Back up with the server stopped, or with `sqlite3 discord2.db ".backup ..."` / `VACUUM INTO`.

## RC build

Location: `desktop/dist/v1.3.0-rc1/` (the 1.2.0 artifacts in `desktop/dist/m12/` are untouched).

| File | Size | SHA-256 |
| --- | --- | --- |
| `Discord2-1.3.0-rc.1-setup.exe` | 121 079 436 | `E120BA354FB2F3F56A1A927DCA5016E94368A65870D9701B19533791D9F858C4` |
| `Discord2-1.3.0-rc.1-win-x64.zip` (portable) | 153 974 474 | `1078CC2A941367D9E8C79D3A9678502C52755167D2E22F1882684B9C506593C8` |
| `win-unpacked/Discord2.exe` | — | for testing |

- **Version:** 1.3.0-rc.1 (`desktop/package.json`). No git tag was created.
- **Server list:** built with the production list from `.env.production`.
  - Internet `https://landhoev3.duckdns.org` is the default; Home `http://192.168.68.65:3001` is
    the second entry.
  - The CSP `connect-src` and the main process's download allow-list contain only these two
    origins.
- **Package scan:** `app.asar` contains only `out/`, `resources/`, `node_modules/` and
  `package.json`.
  - No source files, `.env`, source maps, databases, logs or tests.
  - A scan found no test passwords, secrets, private keys, LiveKit/SMTP/GIF keys, local test
    addresses or `devAuth: true`.
  - The only test-related string is the name of the `D2_TEST_DOWNLOAD_DIR` override. It does
    nothing unless that variable is set.
- **Packaged launch** (isolated profile, not signed in): opens straight to "Welcome back!"
  against the Internet server and shows "Connected". Only the public `/api/meta` was contacted.
- **Signing:** the installer and exe are **unsigned** (`Get-AuthenticodeSignature`:
  `NotSigned`).
  - Smart App Control / SmartScreen will block or warn, exactly as with 1.2.0.
  - The build is technically complete, but Windows will not trust it until it is code-signed
    (options are in the Milestone 12 docs).
- **Do not run the RC installer on a PC with 1.2.0** unless you intend to upgrade: it uses the
  same app ID and installs over 1.2.0. For side-by-side testing, use the portable zip with a
  separate profile:

  ```powershell
  $env:D2_PROFILE = 'rc1'
  .\Discord2.exe
  ```

## What needs a production server deployment

The RC client works with today's API 4 production server, but these features stay hidden until
the server is updated:

- email sign-up and email password reset;
- server icon, description, layout and voice user limits;
- member timeouts;
- GIFs;
- large files and the 24-hour expiry.

Prerequisites, in order (none done):

1. Back up `discord2.db` consistently (see above), then rehearse on a copy on the Jetson.
2. Deploy the server. Migrations 6–8 are additive; the rollback steps are in the overnight
   report. Everything new stays off by default.
3. SMTP provider and `SMTP_PASSWORD` in the Jetson's `.env` → choose `REGISTRATION_MODE`.
4. GIPHY key and terms decision → `GIF_PROVIDER=giphy`.
5. Jetson capacity, disk-throughput and restart tests → `UPLOAD_LARGE_FILES=true`.
6. Code signing for a trusted installer.

## Screenshots

These are in the session folder `files/rc1/`, not the repository:

- First run: `01-first-launch`, `02-create-account`, `03-email-verification`, `04-onboarding`.
- Main app and settings: `05-main-chat`, `06-settings-appearance`, `06b-sounds`,
  `07-voice-diagnostics`, `08-gif-picker`, `09-large-upload-elsewhere`, `10-daily-word`,
  `11-connection-settings`.
- Against the production-era server: `12a-after-switch`, `13-prod-signed-in`, `14-prod-chat`.
- `15-password-recovery`, `16-rc1-packaged-first-launch`.
- Scaling: `scale-{100,125,150}-{main,settings}`, `scale-150-members-overlay`.

## Not verified

- Real voice calls, screen sharing and the connection panel numbers (needs LiveKit; blocked
  locally).
- Real SMTP, real GIPHY, a 5 GB transfer through Caddy, and Jetson capacity.
- A system-wide shortcut pressed while another app has focus.
- A 1.2.0 client against the new server.

## Your test checklist

- [ ] Unzip the portable build, run it with `D2_PROFILE=rc1`, and sign in to the Internet
      server with your real account (production is API 4: expect the reduced feature set
      above).
- [ ] Message, DM and react with a friend. Try Shift quick-delete and the hover toolbar.
- [ ] Join voice with a friend: connection panel numbers, mute/deafen, screen share with
      start/stop sounds.
- [ ] Try 125% and 150% scale on your monitor; narrow the window until the member list becomes
      an overlay.
- [ ] Start an upload, switch channels, and watch the indicator in the sidebar.
- [ ] Decide on commit and branch strategy, then the server deployment steps above.

## Final state

- No commits, pushes, tags, releases or deployments. HEAD is `3d46b11`.
- **Cleaned up:**
  - the local test servers (ports 3101–3103) and the test Electron instances;
  - the production-compatibility worktree (`git worktree list` shows only the main checkout);
  - temporary databases and attachments (`%TEMP%\d2-rc1`);
  - test profiles `desktop-rc1test` and `desktop-rc1pkg`;
  - the 560 MB of test videos.
- **Left in place:** empty, git-ignored folders under `server/data/attachments` and the older
  test profiles from earlier milestones (`desktop-alice`, `desktop-bob`, `desktop-cp2test`).
  Your own `%APPDATA%\desktop` profile was not touched.
