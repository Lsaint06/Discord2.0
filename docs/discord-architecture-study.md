# Discord Desktop (Windows) — Architecture Study

> **Purpose:** learn from the *structure* of a mature Electron chat/voice client so Discord 2.0 (our independent, self-hosted app) is designed well.
>
> **Scope:** read-only inspection of the locally installed client on 2026-10-26. No files in the installation were modified, extracted to disk, or copied into this repository. No proprietary source code or assets are reproduced here; only file names, sizes, package metadata, and identifier *names* (e.g. IPC channel names, exported function names) are cited as evidence.
>
> **Deliberately not done:** reading account tokens / `settings.json` / Local Storage contents, inspecting the cached web-app code, decompiling native binaries, capturing network traffic, or bypassing any authentication or integrity mechanism.

---

## 1. Methodology

| Step | Tooling | Notes |
| --- | --- | --- |
| Directory/size inventory | PowerShell `Get-ChildItem` | `%LOCALAPPDATA%\Discord`; `%APPDATA%\discord` (names only) |
| ASAR listing | `@electron/asar` `listPackage` (from our own `node_modules`) | Archive header read only; nothing written to disk |
| Bundle scanning | In-memory regex for URLs, `DISCORD_*` channel names, Electron API names, `webPreferences` literals | Only identifier names recorded |
| Native module surface | Reading the small `index.js` wrappers next to each `.node` file | Export names / `require` targets only |
| Process model | `Win32_Process` command-line `--type=` flags | Snapshot of the running client |
| Version | `Discord.exe` version resource + embedded user-agent string | |

Claims are tagged **Observed** (directly seen), **Inferred** (reasonable conclusion from observed evidence), or **Unknown**.

---

## 2. Installation layout

**Observed** — host version `1.0.9265`, stable channel, Electron **42.11.15** / Chromium **148.0.7778.280**.

```text
%LOCALAPPDATA%\Discord\
├── Discord.exe              (640 KB)  Squirrel stub launcher → starts newest app-* folder
├── Update.exe               (1.5 MB)  Squirrel.Windows updater
├── installer.db, SquirrelSetup.log, app.ico
├── packages\                          RELEASES, full .nupkg (≈119 MB), SquirrelTemp\
├── app-1.0.9264\                      (empty — previous version awaiting cleanup)
└── app-1.0.9265\                      ACTIVE VERSION
    ├── Discord.exe          (≈220 MB) Electron runtime (renamed electron.exe)
    ├── updater.node, updater_launcher.exe       native updater
    ├── discord_wer.dll                           Windows Error Reporting hook
    ├── ffmpeg.dll, d3dcompiler_47.dll, dxcompiler.dll, dxil.dll,
    │   libEGL.dll, libGLESv2.dll, vulkan-1.dll, vk_swiftshader.dll   standard Chromium runtime libs
    ├── *.pak, icudtl.dat, snapshot_blob.bin, v8_context_snapshot.bin, locales\ (55)
    ├── resources\
    │   ├── app.asar         (3.6 MB)  bootstrap shell (see §3)
    │   ├── build_info.json            {releaseChannel, version, sentryRelease, …}
    │   └── bootstrap\manifest.json    modules required at first run
    └── modules\                       17 independently versioned feature modules (see §4)
```

**Inferred** — Discord ships three independently updated layers:

1. **Host** (Electron runtime + `app.asar`) via Squirrel `.nupkg` packages.
2. **Native modules** (`modules\discord_*-N`) via a separate module updater (`updater.node`). `bootstrap\manifest.json` lists the minimum set (`desktop_core, erlpack, notifications, premap, spellcheck, utils, voice, zstd`); optional modules (overlay, krisp, game utils, cloudsync, …) appear to be fetched on demand.
3. **Web UI** — loaded remotely (see §3). This is the layer that changes most often and needs no installer.

---

## 3. The Electron layer: two small ASARs and a remote UI

| Archive | Entries | Contents | Role |
| --- | --- | --- | --- |
| `resources\app.asar` | 16 | `bundle.js` (≈3 MB), `splashScreenPreload.js`, `splash\` (html/css/fonts/images/videos), `data\quotes_copy.json`, `package.json` | **Bootstrapper**: splash screen, update checks (`updates.discord.com`), crash reporting (Sentry), then hands off to `discord_desktop_core` |
| `modules\discord_desktop_core-1\…\core.asar` | 7 | `bundle.js` (≈440 KB), `mainScreenPreload.js` (≈1.1 MB), `frameViewPreload.js`, `data\cacert.pem`, `data\riotgames.pem`, `package.json` | **Main-process logic** for the app window + the preload bridge |

**Observed**

- Neither archive contains a UI application bundle, chat-UI HTML, or a client state store.
- `core.asar/bundle.js` calls `mainWindow.loadURL(URL_TO_LOAD)` and references `WEBAPP_ENDPOINT`, `WEBAPP_PATH(S)`, `/app`, and `API_ENDPOINT`; hostnames include `discord.com`, `canary.discord.com`, `discordapp.com`.
- The user-data directory (`%APPDATA%\discord`) contains standard Chromium web storage: `Cache`, `Code Cache`, `Service Worker`, `IndexedDB`, `Local Storage`, `Session Storage`, `blob_storage`.

**Inferred (high confidence)** — The chat UI, client-side state management, and REST/Gateway networking are a **web application served by Discord's servers** and cached by Chromium. The desktop client is a *native capability host* that wraps that web app.

**Unknown** — Internals of the web app (framework, store design, gateway client). They are not part of the installation; the cached copy is proprietary code and was intentionally **not** inspected.

### 3.1 Security model of the main window

**Observed** (`webPreferences` literals in `core.asar/bundle.js`):

| Flag | Value | Note |
| --- | --- | --- |
| `contextIsolation` | `true` | |
| `nodeIntegration` | `false` | |
| `sandbox` | `false` | Inferred: preload must load native `.node` addons |
| `spellcheck` | `true` | |
| `backgroundThrottling` | `false` | Keeps voice/timers alive when minimized |

The main preload exposes **exactly one global** via `contextBridge.exposeInMainWorld`: **`DiscordNative`**. The remote web app never gets Node access directly.

Other Electron APIs referenced by the core: `WebContentsView`, `Tray`, `desktopCapturer`, `safeStorage`, `powerMonitor`, `systemPreferences`, `protocol`, `session`, `crashReporter`, `nativeImage`.

### 3.2 IPC surface

**Observed** — ~211 distinct `DISCORD_*` IPC channel names in the core, namespaced by domain prefix:

| Domain | # | Domain | # |
| --- | --- | --- | --- |
| APP | 27 | NOTIFICATION(S) | 10 |
| FRAME | 26 | POWER | 8 |
| WINDOW | 25 | ACTIVITY (capture/stream) | 6 |
| PROCESS | 12 | SPELLCHECK | 6 |
| FILE | 9 | WEBAUTHN | 5 |
| CLIPBOARD | 8 | GPU, NTP, SAFE (storage), SETTINGS, SYSTEM, CRASH, UPDATE, … | 1–4 each |

**Inferred** — A strict, namespaced IPC contract between the remote UI and the native host: the UI requests *capabilities* (clipboard, window control, notifications, power state, capture), never raw Node APIs.

---

## 4. Native modules (`app-1.0.9265\modules`)

Each module is a folder `discord_<name>-<rev>\discord_<name>\` with a tiny `index.js` that `require`s a `.node` addon (plus optional helpers). Sizes are whole-folder totals.

| Module | Size | Native pieces | Purpose (Observed names / Inferred role) |
| --- | --- | --- | --- |
| **discord_voice** | 34.8 MB | `discord_voice.node` (22 MB), `gpu_encoder_helper.exe`, `audio_effects_helper.exe`, `mediapipe.dll`, `selfie_segmentation*.tflite`; JS deps `protobufjs`, `@grpc/*` | **Voice + video + screen-share engine.** Exported names include `createVoiceConnectionWithOptions`, `createOwnStreamConnectionWithOptions`, `createTransport`, `setVideoOutputSink` / `addDirectVideoOutputSink`, `getNextVideoOutputFrame`, `setAudioSubsystem`, `setKrispPath`, `isVaapiEnabled`, `isSpatialAudioEnabled` |
| discord_krisp | 40.4 MB | `discord_krisp.node` + 5 `.kef` ML models (noise cancel, VAD, background-voice cancel) | Third-party on-device ML noise suppression |
| discord_media | 0.7 MB | `discord_media.node` | Media helpers (Inferred: capture/device utilities) |
| discord_erlpack | 0.5 MB | `discord_erlpack.node` | Erlang External Term Format codec — binary gateway payloads |
| discord_zstd | 0.7 MB | `discord_zstd.node` | zstd (de)compression — Inferred: gateway stream compression |
| discord_utils | 4.4 MB | `discord_utils.node`, `DiscordSystemHelper.exe`, `notificationstate.node`; JS `input_capture`, `input_event` | Global input capture (push-to-talk / keybinds), OS state |
| discord_notifications | 0.1 MB | `.node` + `notifications_win` | Native Windows toast notifications |
| discord_spellcheck | 3.1 MB | `cld.node` (Compact Language Detector) | Language detection for spellcheck |
| discord_rpc | 0.1 MB | JS only: `RPCIPC.js`, `RPCWebSocket.js` | Local RPC server — named pipe `discord-ipc*` + localhost WebSocket for games/apps |
| discord_overlay2 / desktop_overlay / hook | ~9 MB | `DiscordHook*.dll`, `DiscordHookHelper*.exe`, overlay SDK DLLs | In-game overlay (hooks into game processes) |
| discord_game_utils / modules / dispatch | ~19 MB | Game SDK DLLs, `discord_aegis_*.dll`, `discord_dispatch.node` | Game detection, Game SDK, game installs |
| discord_cloudsync | 4.2 MB | `discord_cloudsync.node` | Inferred: cloud save sync for games |
| discord_desktop_core | 2 MB | `core.asar` + ~150 tray/badge icons | Main-process app logic (§3) |

### 4.1 Process model (running-client snapshot)

**Observed** — 1 browser (main) process, 1 renderer, 1 GPU process, utility processes for **NetworkService** and **AudioService**, and a crashpad handler. The voice helper executables were not running at snapshot time (no active call); **Inferred** that they are spawned on demand.

---

## 5. How responsibilities are separated

| Concern | Where it lives | Confidence |
| --- | --- | --- |
| **UI rendering** | Remote web app in the renderer, loaded from `discord.com`, cached locally | Inferred — high |
| **Client state management** | Inside the remote web app; persisted in IndexedDB / Local Storage | Inferred — medium; implementation **Unknown** |
| **Realtime networking (Gateway)** | Web app over WebSocket; desktop provides native **erlpack** (ETF) and **zstd** | Inferred — medium |
| **REST networking** | Web app → `API_ENDPOINT`, via Chromium's NetworkService utility process | Inferred — medium |
| **Voice / video / screen share** | **Native engine** `discord_voice.node`, *not* the browser WebRTC stack; decoded frames delivered to the UI through video "sinks"; hardware encode in `gpu_encoder_helper.exe` | Observed (exports) / Inferred; wire protocol **Unknown** |
| **Audio processing** | Native: Krisp models, `audio_effects_helper.exe`; MediaPipe segmentation for camera background effects | Observed |
| **OS integration** | Main process + `DiscordNative` bridge (tray, badges, notifications, clipboard, power, keybinds) | Observed |
| **Updates** | Squirrel (host) + module updater (`updater.node`) + remote web app | Observed |
| **Crash / telemetry** | Sentry (`@sentry/electron`), Crashpad, WER DLL | Observed |

---

## 6. Local vs backend-dependent functionality

| Runs locally | Requires Discord's backend |
| --- | --- |
| Window / tray / badges, notification display, clipboard, global keybinds & push-to-talk capture | Login, authentication, sessions |
| Audio capture/playback, audio/video encode & decode, Krisp noise suppression, background blur | Message history; sending/receiving messages (REST + Gateway) |
| Screen/window capture and hardware encoding | Servers/channels/members/presence/permissions |
| Spellcheck + language detection | Voice/video routing — media goes to Discord's voice servers (Inferred: SFU-style forwarding) |
| Local RPC server for games (`discord-ipc` pipe / localhost WS) | Signaling for calls and streams, stream viewers |
| In-game overlay rendering | CDN media/attachments (`cdn.discordapp.com`) and **the web UI itself** (`/app`) |
| Cached web app + storage (fast start; **Unknown** whether any offline mode exists) | Updates (`updates.discord.com`), telemetry (Sentry ingest) |

**Takeaway:** nearly everything that defines the *product* (UI, data, routing) is server-side; the install is a capability host. Media processing is the major exception and is heavily native.

---

## 7. Lessons for Discord 2.0

Our target: a private, self-hosted Electron + React client with voice chat and **1440p60 streaming**, backed by an **NVIDIA Jetson Orin Nano**.

### 7.1 Adopt

1. **One narrow, typed preload bridge.** Same *pattern* as a single exposed object, with namespaced methods (`window.*`, `notifications.*`, `media.*`, `settings.*`). Today our [preload](../desktop/src/preload/index.ts) exposes `@electron-toolkit/preload`'s generic `electronAPI` (which wraps `ipcRenderer`). Replace it with an explicit allow-list before networking lands. Keep `contextIsolation: true` and `nodeIntegration: false`, and — unlike Discord — turn on `sandbox: true` (our [main process](../desktop/src/main/index.ts) currently sets `sandbox: false`), since we don't need native addons in the preload.
2. **A shared, typed IPC contract** (e.g. `src/shared/ipc.ts`) imported by main, preload, and renderer so channel names can't drift.
3. **Layered, independently versioned pieces.** For a private app the simplest variant: bundle the UI with the app (works offline, no web hosting) and version the **server API** so slightly older clients keep working.
4. **Process isolation for heavy media.** If we ever add native encoding or audio effects, run them in child/utility processes so a crash doesn't take down the UI.
5. **`backgroundThrottling: false`** on the window that owns voice, so audio and timers don't stall when minimized.
6. **Crash reporting and logs from day one** — Electron `crashReporter` to a self-hosted endpoint or local dumps, plus a rotating log in `userData/logs`.
7. **Encoding-agnostic gateway envelopes.** Discord pairs a binary encoding with zstd. Start with JSON over WebSocket using an opcode envelope (e.g. `{ op, type, seq, data }`), and add `permessage-deflate` or zstd later without touching app logic.
8. **Spellcheck via Chromium's built-in spellchecker** (`session.setSpellCheckerLanguages`) — no native module needed.

### 7.2 Do differently (our constraints differ)

1. **Use Chromium's WebRTC first, not a custom native engine.** Discord's native engine exists for global scale, codec control, and features like Krisp and spatial audio. For a friend group, the renderer's `getUserMedia`, `getDisplayMedia`, and `RTCPeerConnection` already provide Opus, echo cancellation, noise suppression, AGC, and GPU video encoding where the driver supports it. Revisit native only if measurements demand it.
2. **Backend = SFU, never a transcoder.** The Jetson Orin Nano has **no hardware video encoder (NVENC)** — unlike Orin NX/AGX — and CPU transcoding 1440p60 on its 6 ARM cores is not viable. Therefore:
   - Encode **on the streamer's PC**.
   - The Jetson runs a **Selective Forwarding Unit** that only relays RTP packets (candidates: LiveKit — single Go binary with arm64 builds — or mediasoup). Forwarding is cheap on CPU; the limit is **network bandwidth**.
   - Budget roughly 8–16 Mbps per 1440p60 stream (codec- and content-dependent). Each viewer receives its own copy from the SFU, so 5 viewers ≈ 40–80 Mbps egress. The Orin Nano's gigabit Ethernet is fine on a LAN; **home upload bandwidth** is the real ceiling for remote friends.
   - Use **simulcast** (or SVC) so viewers on weak links get 720p/1080p layers while others get 1440p60.
   - Start with **H.264** (broadest hardware encode/decode support); evaluate AV1/HEVC per GPU later.
3. **Signaling and chat on the same box:** a lightweight API server (Node or Go) for auth, REST, and a WebSocket gateway, with SQLite or Postgres, alongside the SFU and a **TURN** server (coturn) for NAT traversal.
4. **Self-hosted auth:** invite codes + per-device tokens, stored client-side with Electron `safeStorage` (Discord's core also references `safeStorage`).
5. **Skip** overlays/DLL hooks, game SDKs, cloudsync, and a public local RPC server — high complexity and anti-cheat risk, little value for a private group.

### 7.3 Proposed module boundaries

```text
desktop/src/
  main/        window lifecycle, tray, notifications, updates, crash reporting
  preload/     typed bridge (allow-listed IPC only)
  shared/      IPC + protocol types shared by main/preload/renderer
  renderer/
    ui/        React components (exists today as components/)
    state/     client store (servers, channels, messages, presence)
    net/       REST client + gateway WebSocket client (reconnect, resume, heartbeat)
    media/     WebRTC/SFU client: voice, camera, screen share, device selection
server/        (future, on the Jetson)
  api/         auth, REST, gateway WebSocket, persistence
  sfu/         LiveKit or mediasoup configuration
  turn/        coturn configuration
```

This mirrors the separation of concerns observed in Discord (host ↔ bridge ↔ UI/state/net ↔ media engine ↔ backend services) without copying any implementation.

---

## 8. Open questions and uncertainties

- **Gateway encoding in practice:** erlpack and zstd modules exist, but whether the current web app uses ETF or JSON on desktop was not verified (would require traffic inspection).
- **Voice transport:** the native engine's wire protocol, codecs, and encryption were not examined. Discord publicly describes end-to-end-encrypted audio/video ("DAVE"); this was not verified from the install.
- **`@grpc/*` / `protobufjs` in `discord_voice`:** Inferred to serve communication with helper processes (the wrapper references `./MediaHost`); not verified.
- **Local RPC port:** the named-pipe prefix `discord-ipc` was observed; no WebSocket port literal was found (likely computed at runtime).
- **Offline capability** of the cached web app was not tested.
- **Jetson figures** (no NVENC on Orin Nano, bitrate ranges) are from general knowledge and should be confirmed against NVIDIA's current Orin Nano documentation and real measurements before committing to a design.
- Module versions and contents change frequently; this snapshot reflects host `1.0.9265`.

---

## 9. Legal and ethical notes

- This study records structure and identifier names only. No Discord source code, binaries, ML models, images, or fonts were copied into this repository.
- Discord 2.0 remains an independent implementation. Use these notes for architectural direction only, and keep naming and branding distinct from Discord's trademarks in any public release.
