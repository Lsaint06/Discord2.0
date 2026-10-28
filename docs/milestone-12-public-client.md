# Milestone 12 — Public desktop client and Windows distribution

Status: **implemented locally, not committed.** No production, router, DNS or CI change was made.

## Audit (what already existed)

| Area | Where | Finding |
| --- | --- | --- |
| Build system | `desktop/electron.vite.config.ts`, `package.json` | electron-vite + electron-builder 26; the CSP `connect-src` is generated from the server list at build time, and an invalid list fails the build |
| Server selection | `src/renderer/src/net/endpoints.ts`, `net/config.ts`, `App.tsx` | Server profiles (`RENDERER_VITE_SERVERS`, max. 5) are fixed at build time; picker on the sign-in screen; https required for internet hosts |
| WebSocket URL | `endpoints.ts` (`gatewayUrl`) | `wss://host/gateway` from `https://`, `ws://` kept for LAN `http://` |
| LiveKit | `hooks/useBackend.ts` (`fetchVoiceToken`) + `checkLivekitUrl` | The server picks the voice URL per request (`wss://landhoev3.duckdns.org` from the internet, `ws://192.168.68.65:7880` on the LAN); the app refuses foreign hosts and downgrades |
| Sessions | `src/main/credentials.ts`, `net/session.ts` | Token encrypted with DPAPI in `session.bin`; a session is only used with the server it came from; `initialEndpoint` reopens the saved session's server |
| Packaging | `electron-builder.yml` | NSIS only; app identity `com.discord2.app`, data `%APPDATA%\desktop` |
| Electron security | `src/main/index.ts`, `appProtocol.ts` | sandbox, context isolation, no Node in the renderer, `app://discord2` origin, navigation locked; no certificate overrides (Chromium rejects invalid certificates) |
| Tests | Vitest, 22 files / 228 tests before this milestone | |

Gaps found: every connection problem showed "Cannot reach the server" plus a developer hint (`npm run dev`); no committed profile list (only a git-ignored local file, so a CI build couldn't reproduce it); no portable/zip build.

## Changes

| Change | Files |
| --- | --- |
| Committed release profiles: **Discord 2.0 — Internet** (`https://landhoev3.duckdns.org`, default) and **Discord 2.0 — Home Network** (`http://192.168.68.65:3001`). Public information only. | `desktop/.env.production` (new), `.env.example` |
| Plain-language connection errors. The main process passively records Chromium's error code for the app's own failed requests (certificate, DNS, offline, refused, timeout); the sign-in screen explains it, and suggests the Internet option when Home Network fails away from home. TLS validation is unchanged: certificate errors are still rejected; the message offers no way around them. | `src/main/netErrorLog.ts`, `netDiagnostics.ts`, `index.ts`, `src/preload/*`, `src/renderer/src/net/networkErrors.ts`, `net/api.ts` (`timeout` code), `components/auth/AuthScreen.tsx` |
| Windows targets: NSIS installer + zip (unpacked app for testing); version 1.2.0 (upgrades 1.0/1.1 in place); previous build output can never be packaged into the app | `electron-builder.yml`, `package.json`, `package-lock.json` |
| GitHub Actions proposal (manual, unsigned, artifacts only) | `.github/workflows/desktop-windows.yml` (new, **not committed, not run**) |

**Existing users:** a saved sign-in keeps its server. A 1.0/1.1 PC signed in on `http://192.168.68.65:3001` reopens on *Home Network* with its session; new installs start on *Internet*. No migration code was needed; this is covered by a test.

## Verification

| Kind | Result |
| --- | --- |
| Desktop lint, typecheck, production build | pass |
| Desktop tests | **241 / 241** (13 new: release profiles, wss/ws, CSP, voice URL per profile, starting profile and saved sessions, error classification and messages, the main-process error log) |
| Dependency audit (`npm audit`) | 0 vulnerabilities |
| Real Electron app, isolated profile, sign-in screen read through DevTools | Internet profile **Online** (through the router's loopback); `expired.badssl.com` → `ERR_CERT_DATE_INVALID` message; `self-signed.badssl.com` → `ERR_CERT_AUTHORITY_INVALID` (both refused); unknown name → DNS message; unreachable home address → "only works on the home network… choose Discord 2.0 — Internet". Screenshots in the session folder (`m12-shots`). |
| Public endpoint from the home PC | HTTPS `/api/meta` (certificate valid), HTTP → 308 to HTTPS, WSS gateway: app origin accepted and bad token closed with 4001, foreign origin 403 |
| Packaged app (1.2.0) | 13 files / 2.3 MB app archive; CSP = the two profiles only (https/wss to the internet host); no secrets, `.env`, source maps or databases |
| **Not done** | Sign-in, messaging, DMs, voice and screen sharing from an actual external network; installing the 1.2.0 installer |

## Windows builds (local, `desktop/dist/m12`, git-ignored)

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `Discord2-1.2.0-setup.exe` (NSIS installer, unsigned) | 115.4 MB | `57711b54eb9480051f680222aaacb5162e006ebf8424c8b958e03b6318c39cfc` |
| `Discord2-1.2.0-win-x64.zip` (unpacked app, unsigned) | 146.8 MB | `14926f7ab14aa1fe138b2ce0498fb1cb1b35b8ec26326f47a28ec5fc52f82c71` |
| `win-unpacked\Discord2.exe` | — | product version 1.2.0.0, `NotSigned` |

**Built is not the same as trusted.** On this PC (Smart App Control **on**) the 1.2.0 installer was *generated* without a block (the 1.1.0 attempt was blocked when the build process *ran* the generated setup). It was **not installed**: it would upgrade the installed 1.0 app, and as an unsigned, unknown file Smart App Control would very likely refuse to run it. On friends' PCs a downloaded unsigned installer or exe is blocked where Smart App Control is on, and warned about by SmartScreen elsewhere.

## Distribution plan

1. **Build:** the proposed workflow (manual, `contents: read`, SHA-pinned actions, `windows-2025`, tests + audit + package checks, artifacts kept 14 days, no release, no secrets). Needs approval to commit and run.
2. **Trust (choose one, needs approval):** SignPath Foundation (free, public repository + review), Certum Open Source (~€49/yr, individual, open-source), Azure Artifact Signing (~$9.99/mo, individuals in US/Canada), an OV certificate ($150–300/yr), or the Microsoft Store (free; MSIX changes identity and data folder). Signing would be added as a separate job/environment with required reviewers; the signing credential never enters the repository or logs.
3. **Until then:** testing only, on PCs where Smart App Control is off, comparing the SHA-256 published next to the file. Don't ask anyone to disable Smart App Control.

## External acceptance checklist (needs a second network)

On a laptop tethered to a phone (not the home Wi-Fi), with the 1.2 build:

1. Default profile is *Discord 2.0 — Internet*; status Online; certificate valid.
2. Sign in, restart the app, still signed in.
3. Server and channel messages both ways with a home PC; edit, react, attachment upload and download.
4. Friend request, DM, group DM, unread badges, notifications.
5. Voice join/leave (member list updates), two-way audio, mute and deafen.
6. Screen share from outside, viewed at home, and the reverse.
7. Wi-Fi off for 20 seconds: chat and voice reconnect without duplicates.
8. Choose *Home Network* while away: the app explains it only works at home.
9. At home at the same time: the installed 1.0 app (LAN) keeps working.

## Known limitations

- The router's loopback took one 8-second timeout on the first HTTPS connection from the home PC, then answered every request in ~30 ms; home PCs can always use *Home Network*.
- The 1.2 installer is unsigned (see above).
- Version 1.2 still resets the per-PC settings once when upgrading from 1.0 (`file://` → `app://`, see Milestone 11).
