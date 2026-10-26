# desktop

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

Requires the backend from [`../server`](../server/README.md) to be running.

### Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `RENDERER_VITE_SERVER_URL` | `.env.development` (committed default), `.env.*.local` (git-ignored), or shell | Backend base URL, e.g. `http://192.168.68.65:3001`. Compiled into the renderer and used to generate the CSP `connect-src` (any port on that host, so LiveKit on `:7880` is allowed). **Public — never put secrets here.** See [`.env.example`](.env.example). |
| `RENDERER_VITE_LIVEKIT_URL` | same | Only if LiveKit runs on a **different host** than the backend; adds that host to the CSP. The actual LiveKit URL always comes from the backend with each voice token. |
| `D2_PROFILE` | shell, at launch | Optional isolated profile name (e.g. `alice`) so several clients can run on one PC. |

Development-only: the dev-identity session token is stored in renderer `localStorage`. Production should move credentials to the main process (Electron `safeStorage`).

### Voice architecture

- [`media/MediaSession.ts`](src/renderer/src/media/MediaSession.ts) — the single owner of the LiveKit `Room`: join/leave/switch, mute, deafen (unsubscribes remote audio), active speakers, device switching, input gain, automatic rejoin with backoff, and full teardown (stops every captured track, closes audio contexts, removes audio elements). Exposed to React through `useSyncExternalStore` ([`hooks/useVoice.ts`](src/renderer/src/hooks/useVoice.ts)).
- [`media/voiceLogic.ts`](src/renderer/src/media/voiceLogic.ts) — pure reconnect / mic-gating / push-to-talk key logic, unit tested with `npm test` (vitest).
- [`hooks/usePushToTalk.ts`](src/renderer/src/hooks/usePushToTalk.ts) — hold-to-talk while the window is focused (typing keys are ignored in text fields). Optional **experimental system-wide toggle** via one Electron `globalShortcut`, registered only while in voice with push-to-talk enabled. True system-wide *hold* would need a low-level keyboard hook (native addon), which we deliberately avoid.
- [`main/media.ts`](src/main/media.ts) — grants audio-only `media` permission to our own renderer and denies all other permissions; reports Windows microphone privacy status; opens the privacy settings page; owns the global push-to-talk shortcut. Exposed to the renderer as the typed `window.d2` bridge ([`preload/index.ts`](src/preload/index.ts)).
- Screen sharing (later): the room already uses dynacast/adaptive streaming; adding `ScreenShare` tracks needs a backend grant change and a display-capture permission policy in `main/media.ts`.

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
