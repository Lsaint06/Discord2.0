# Screen sharing performance (Milestone 5.1 "Velocity")

This document explains how Discord 2.0 encodes, sends and plays screen shares, what changed in Milestone 5.1, how to read the diagnostics, and how to measure performance on the real two-PC + Jetson setup. Deployment basics are in [screen-sharing-jetson.md](screen-sharing-jetson.md) (unchanged).

## Summary of findings

| # | Finding | Evidence | Status |
| --- | --- | --- | --- |
| 1 | **AV1 was always encoded in software (libaom).** LiveKit forces `L1T3` (3 temporal layers) for VP9/AV1 screen shares, and Chromium cannot hardware-encode AV1 temporal layers. Separately, Chromium's `WebRtcAV1HWEncode` feature is **disabled by default on Windows only** (`media/webrtc/webrtc_features.cc`). | Local probe on RTX 4070 Ti SUPER: `L1T1` + feature → `MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)`, `powerEfficientEncoder: true`; `L1T3` → `libaom` with or without the feature. | Fixed (evidence-based) |
| 2 | **The old "fps" number was ambiguous.** It was Chromium's single `framesPerSecond` from one stats object, sampled every 2 s when the overlay was closed. With `L1T3` the SFU can forward only the 15/30 fps temporal layers to a viewer, and a CPU-starved software encoder adapts frame rate, so a low number could be real *received* fps while the screen still looked fluid. | New diagnostics split capture / encoded / sent / received / decoded / shown fps from counter deltas. | Fixed |
| 3 | The receiver path is fast locally: jitter buffer ≈ 9 ms, decode ≈ 1–2 ms, arrival → display ≈ 22–32 ms. Most local latency is **before the encoder** (screen → Chromium capture → encoder input ≈ 60–75 ms). | Barcode latency test (below). | Measured; capture stage is inside Chromium |
| 4 | `playoutDelayHint = 0` / `jitterBufferTarget = 0` have **no measurable effect** (116 ms vs 117–118 ms). Chromium only uses them to *raise* the minimum jitter buffer. | A/B run, H.264 1440p. | Not shipped (would be a placebo) |
| 5 | The 720p backup simulcast layer has **no consistent latency cost** (±10 ms run-to-run noise). | A/B runs, H.264 and AV1. | Kept on by default; now a setting |
| 6 | On this test PC (144 Hz monitor) Chromium's screen capture delivers ~48 fps regardless of resolution, capture backend features or frame-rate cap. Your sender measured 56–58 fps, so this is machine-dependent. | `MediaStreamTrack.stats`; tried `WebRtcAllowWgcUsingTexture`, `ZeroCopyDesktopCapture`, caps 30/60/72. | Documented; capture fps is now visible in Diagnostics |
| 7 | The 500–1000 ms H.264 delay seen on the real setup was **not reproduced locally** (≈ 118 ms H.264 1440p). The new per-stage diagnostics are designed to locate it on the real PCs. | — | Needs two-PC test |

## What changed

### AV1 / VP9 publishing (`media/screenProfiles.ts` → `videoPublishPlan`, `media/MediaSession.ts`)

- **Default AV1/VP9 layering is now single-layer simulcast**: one `L1T1` stream at the full resolution plus (above 720p) a 720p30 `L1T1` backup layer, i.e. the same shape as H.264. LiveKit's SDK supports this "SVC codec as rid simulcast" path with LiveKit server > 1.13.6 (we run 1.13.11); on older servers the SDK falls back to `L1T3` by itself.
- LiveKit's previous behaviour (`L1T3`) is still available: *Settings → Screen Share → AV1 / VP9 Layering → Temporal SVC*.
- `backupCodec: false` for screen shares. LiveKit otherwise registers a VP8 backup codec; every Discord 2.0 client decodes H.264/VP9/AV1, so a VP8 copy would only cost encoder time if the SFU ever requested it.
- The 720p backup layer can be turned off (*Send a 720p backup layer*).

### Hardware AV1 encoder (`main/encoderFlags.ts`)

- At startup the main process appends Chromium's own feature `WebRtcAV1HWEncode` to `--enable-features`. This is the feature Chromium enables by default on every other platform; on Windows it is off upstream.
- It's **on by default** and can be turned off in *Settings → Screen Share → Hardware AV1 encoding* (stored in `%APPDATA%\<app>\encoder-flags.json`, applied on restart; a *Restart now* button is provided). Turn it off if a GPU driver produces corrupted AV1.
- Only GPUs with an AV1 encoder use it (RTX 40, Radeon RX 7000, Intel Arc). Others keep using libaom. Diagnostics always shows the encoder actually in use.

### Diagnostics (`media/stats.ts`, `media/statsFormat.ts`, `media/playback.ts`, `hooks/useTrackStats.ts`)

- All rates and averages come from **deltas of cumulative counters over the last ~1 s window**. Counter resets (stream restart, layer change), missing fields, a new stat id (new track) and zero elapsed time yield "—" instead of a wrong number.
- One React update per second per panel; sampling stops when the panel or viewer unmounts.
- The viewer header now says what it measures: `2560×1440 · 48 fps shown · AV1`.

### Viewer (`components/StreamViewer.tsx`, `Workspace.tsx`)

- The video is attached only when the underlying track changes. Previously any participant/track event in the room (`streamRevision`) caused a detach and re-attach of the same track.
- Focus view and mini player are now the same component instance, so switching modes no longer remounts the `<video>` element.
- New indicators: connection-quality dot and a "Stalled" badge when no frames arrive.
- Sharer: a "Limited by encoder/CPU (or bandwidth): sending W×H @ N fps" note in the voice panel when Chromium reports a limitation and the stream falls short of the selected preset. Manual presets are never changed silently.

### Presets and modes

- Manual presets: **720p30 (new)**, 1080p30, 1080p60, 1440p60. Capture constraints remain maximum-only (never upscaled).
- Modes (previously "Optimize for"):
  - **Smooth Gaming** (`contentHint: motion`, `degradationPreference: maintain-framerate`): keeps 60 fps, reduces resolution only under real CPU/bandwidth pressure.
  - **Sharp Desktop** (`contentHint: detail`, `maintain-resolution`): keeps text sharp; Chromium's screen-content mode lowers frame rate when the screen is static, so idle desktops don't waste bitrate.
- Bitrate ceilings are unchanged (quality preserved). At the same 14 Mbps ceiling AV1 used ~10.3 Mbps in our tests versus ~13.7 Mbps for H.264.

## Local measurements (one PC, not the Jetson)

Setup: one Windows 11 PC (RTX 4070 Ti SUPER, 2560×1440 @ 144 Hz), local LiveKit 1.13.11 for Windows, backend, two real Electron 44 clients (sender captures the whole screen; viewer watches). A test-pattern window draws `Date.now()` as a 24-bit black/white barcode plus constant motion; the viewer decodes the barcode from each presented frame (`requestVideoFrameCallback`) and compares it with the frame's expected display time. **Latency = pattern drawn on the sender's screen → frame expected on the viewer's screen**, same clock, excluding monitor scan-out. Network is loopback, so this is not a substitute for the two-PC test.

| Run | Encoder (sender) | Capture / encoded / shown fps | Jitter buffer | Arrival → display | Latency median / p90 |
| --- | --- | --- | --- | --- | --- |
| Baseline (M5) H.264 1440p60 | NVENC H.264 ×2 | 47 / 47 / 47 | 8.7 ms | 29 ms | 117 / 130 ms |
| Baseline (M5) AV1 1440p60 (`L1T3`) | **libaom (software)** | 44 / 44 / 44 | **39 ms** | 62 ms | **166 / 173 ms** |
| A H.264 1080p60 | NVENC H.264 ×2 | 43 / 43 / 43 | 8.8 ms | 29 ms | 124 / 131 ms |
| B H.264 1440p60 | NVENC H.264 ×2 | 47 / 46 / 47 | 8.7 ms | 30 ms | 118 / 130 ms |
| C AV1 1080p60 | **NVENC AV1 ×2** | 42 / 42 / 42 | 10 ms | 32 ms | 118 / 132 ms |
| **D AV1 1440p60** | **NVENC AV1 ×2** | 48 / 48 / 48 | 9.4 ms | 31 ms | **97 / 111 ms** (also 97 in an earlier run) |
| E AV1 1440p60 `L1T3` (option) | libaom | 46 / 46 / 42 | 12 ms | 24 ms | 97 / 152 ms, 6 dropped |
| H.264 1440p, playout hints = 0 | NVENC H.264 ×2 | 47 / 47 / 47 | 8.9 ms | 29 ms | 116 / 124 ms |
| AV1 1440p, hardware AV1 turned off | libaom ×2 | 48 / **41** / — | — | — | (encoder can't keep up) |

All runs: 0% packet loss, 0 freezes, system audio and microphone stayed subscribed and live. Encode time ≈ 10 ms/frame at 1440p and ≈ 7 ms at 1080p on NVENC; send pacer delay 0 ms. Frame rates are capped by this PC's capture (~48 fps), not by encoding.

Not measured locally: real network/Jetson behaviour, a game loading the sender GPU, CPU/GPU utilisation, and AV1/H.264 decoder names on the viewer (Chromium hides `decoderImplementation` unless the page is capturing; with a real microphone open it is reported).

## Reading the diagnostics

*Settings → Diagnostics* (or the chart icon in the stream viewer). "≈" marks estimates; everything else is measured from counters or reported by Chromium.

**Sender (Your stream)**

| Row | Meaning | Look for |
| --- | --- | --- |
| Capture | Frames Chromium's screen capture delivered per second | Below ~55 while a game runs at high fps → capture is the bottleneck (try capping the game's fps) |
| Layer h / q | Per simulcast layer: encoded fps, sent fps, bitrate. "paused" = no viewer needs it (dynacast) | encoded < capture → encoder can't keep up |
| Codec | Codec and scalability mode | AV1 should show `L1T1` |
| Encoder | `encoderImplementation` + Chromium's hardware flag | `MediaFoundation… (NVIDIA … Encoder MFT) (hardware)` is the GPU; `libaom`, `libvpx`, `OpenH264` are software |
| Encode time | ms per frame inside the encoder | > 16 ms at 60 fps = falling behind (GPU busy with the game) |
| Send pacer delay | How long packets wait before leaving the PC | Tens of ms or more → uplink/bandwidth estimate is the bottleneck (a classic source of growing delay) |
| Limited by | Chromium's `qualityLimitationReason` | `cpu` or `bandwidth` explain lower resolution/fps |
| Uplink estimate ≈ | WebRTC's bandwidth estimate | Should be well above the total upload |

**Viewer (Watching)**

| Row | Meaning | Look for |
| --- | --- | --- |
| Frame rate | received → decoded → shown per second | received < sender's encoded → the SFU forwarded a lower layer/temporal layer or packets are lost; decoded < received → decoder behind; shown < decoded → the compositor skipped frames (window hidden/occluded, display at a lower refresh) |
| Jitter buffer | Average wait before decoding (target / minimum) | Large and growing → bursty arrival or loss on the network |
| Decode time | ms per frame | > 10 ms suggests software decoding |
| Arrival → display | From the last packet of a frame to its expected display | Includes jitter buffer, decode and render queue |
| Freezes / Dropped | Counted by WebRTC | Any steady increase is worth investigating |
| Decoder | Decoder implementation + hardware flag | "not reported" means Chromium hid it (only shown while the app is capturing, e.g. microphone open) |

## Recommended gaming settings

- **Codec: AV1** on RTX 40-series senders (both of your PCs), with *Hardware AV1 encoding* on and layering *Single-layer simulcast*. Diagnostics must show `NVIDIA AV1 Encoder MFT (hardware)`; if not, use H.264.
- **Preset: 1440p 60fps** when the sender's monitor is 1440p; otherwise 1080p 60fps (we never upscale).
- **Mode: Smooth Gaming.**
- Cap the game's frame rate (e.g. 120 or 141 on a 144 Hz monitor, or enable NVIDIA Reflex) so the GPU keeps headroom for screen capture and NVENC. Watch *Capture* and *Encode time* in Diagnostics.
- Viewers on wired Ethernet; Wi-Fi viewers may be switched to the 720p layer automatically.

## Measuring on the real setup (two PCs + Jetson)

Do every run with the same game scene, both PCs wired, viewer in focus view (not mini), and Diagnostics open on both PCs (or "Copy report" at the end).

| Test | Preset | Codec | Mode |
| --- | --- | --- | --- |
| A | 1080p60 | H.264 | Smooth Gaming |
| B | 1440p60 | H.264 | Smooth Gaming |
| C | 1080p60 | AV1 | Smooth Gaming |
| D | 1440p60 | AV1 | Smooth Gaming |
| (opt) E | 1440p60 | AV1, layering = Temporal SVC | Smooth Gaming |
| (opt) F | D with *Send a 720p backup layer* off | | |

For each run (2 minutes), record:

1. Sender: Capture fps, encoded fps (layer h), Encoder, Encode time, Send pacer delay, Limited by, Total upload.
2. Viewer: received / decoded / shown fps, Decoded size, Jitter buffer, Decode time, Arrival → display, Freezes, Dropped, Packet loss, Round trip.
3. **Glass-to-glass latency:** open a millisecond stopwatch on the sender's screen (any web stopwatch with ms digits, inside the shared screen). Put both monitors in one phone-camera shot (slow-motion or burst photos). For 10 photos, subtract the time visible on the viewer's monitor from the time on the sender's monitor; report median and max. This includes everything, including both displays.
4. CPU/GPU: Task Manager → Performance → GPU (graph "Video Encode" on the sender, "Video Decode" on the viewer) and *Diagnostics → CPU*.
5. Jetson: `docker stats --no-stream`, `sudo tegrastats` for 10 s, `nload eth0`.
6. Voice and stream audio: talk during the run and confirm both directions; confirm game audio is heard.

Where the delay is: if glass-to-glass is high, compare *Encode time + Send pacer delay* (sender), *Round trip / 2* (network + SFU), *Jitter buffer + Decode time + Arrival → display* (viewer). Whatever is left is capture (sender) and display (both monitors).

## Known Electron / Chromium limitations

- Hardware AV1 encoding needs `WebRtcAV1HWEncode` on Windows and only works for single-layer (`L1T1`) encodings.
- VP9 is software-encoded on Windows: `libvpx` for both `L1T1` and `L1T3` in a local probe (RTX 4070 Ti SUPER).
- Desktop capture frame rate depends on the PC (≈48 fps on the 144 Hz test PC; 56–58 on your sender); no supported switch changed it.
- `playoutDelayHint` / `jitterBufferTarget` cannot lower the receiver's delay below Chromium's own estimate. A true zero-playout-delay mode would need the RTP playout-delay extension from the SFU (a LiveKit server setting); this was **not** tested or enabled, by design (no server changes this milestone).
- System audio and video are separate WebRTC tracks and are not lip-synced, so game audio can arrive earlier than video by the video pipeline's extra latency.
- `getVideoPlaybackQuality().droppedVideoFrames` is unreliable for WebRTC video in Chromium and is not shown.

## Deploying

Milestone 5.1 changes **only the desktop app**. The backend, Docker Compose, LiveKit config and Jetson are unchanged; do not redeploy the Jetson for this milestone.

On **each Windows PC**:

```powershell
cd <repo>
git fetch origin
git checkout milestone-5-velocity      # once it has been pushed
git pull
cd desktop
npm install                            # no new dependencies, but harmless
npm run dev                            # or npm run build:win for an installer
```

After the first start, *Settings → Screen Share → Hardware AV1 encoding* shows on; Diagnostics → App & GPU shows "Hardware AV1 encoding: allowed this session".

## Rollback

- Turn off just the hardware AV1 encoder: *Settings → Screen Share → Hardware AV1 encoding* off → *Restart now*.
- Use LiveKit's previous AV1 layering: *AV1 / VP9 Layering → Temporal SVC*.
- Use the previous build entirely (on each Windows PC):

```powershell
git checkout milestone-5-screen-sharing   # commit 6c25e80
cd desktop; npm run dev
```

The Jetson stays on `milestone-5-screen-sharing`, so no server rollback is involved. The `encoder-flags.json` file is ignored by older builds.
