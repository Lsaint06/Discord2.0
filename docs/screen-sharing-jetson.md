# Screen sharing ("Go Live") — architecture, deployment and verification

Milestone 5 adds real screen sharing to voice channels: an in-app source picker, optional Windows system audio, 1080p30 / 1080p60 / 1440p60 quality presets, a stream viewer (focus, mini player, fullscreen), live stats and a diagnostics page. It reuses the Milestone 4 stack unchanged: Electron clients, the Fastify backend and the self-hosted LiveKit SFU on the Jetson, LAN-only.

## Architecture

```
 Sharer's PC (Electron)                      Jetson (Docker, LAN-only)               Viewer's PC (Electron)
 ┌───────────────────────────────┐           ┌──────────────────────────┐            ┌──────────────────────────┐
 │ picker → main: arm source     │  WebRTC   │ LiveKit SFU              │  WebRTC    │ subscribes ONLY when the │
 │ getDisplayMedia (1 use, 15 s) │──────────▶│ forwards packets,        │───────────▶│ user clicks LIVE/Watch   │
 │ GPU H.264 encode, simulcast:  │ UDP 7882  │ picks a layer per viewer │            │ GPU decode → <video>     │
 │   full res + 720p30 backup    │           │ (no transcoding)         │            │ adaptive layer by size   │
 │ system audio (WASAPI loopback)│           └────────────┬─────────────┘            └──────────────────────────┘
 └───────────────────────────────┘                        │ webhooks (track published/unpublished)
                                                          ▼
                                             backend: voice_state_update { streaming: true } → LIVE badges everywhere
```

- **The Jetson never encodes or decodes video.** All encoding happens on the sharer's PC and all decoding on the viewers' PCs; LiveKit only forwards encrypted RTP. The Orin Nano has no NVENC, and none is needed.
- **Watch-only subscriptions.** Clients connect with `autoSubscribe: false`. Microphones are subscribed unless you're deafened. A screen share and its audio are subscribed only while you're watching that user (`media/subscriptions.ts`), so nobody downloads streams they aren't watching.
- **Simulcast and dynacast.** H.264 streams publish two layers: the full resolution and a 720p30 backup at 1.8 Mbps. The SFU sends each viewer the layer its link and player size need, and pauses layers nobody needs.
- **Presence.** The backend learns about screen shares from LiveKit webhooks (`track_published` / `track_unpublished` with source `SCREEN_SHARE`, reconciled every 30 s) and broadcasts `voice_state_update { streaming }`. That's how LIVE badges also appear for channels you're not in.

### Token permissions

Voice tokens (5-minute TTL, one room) may publish **only** `microphone`, `screen_share` and `screen_share_audio`. Camera publishing is not allowed, and there are no admin, room-create or room-list rights. The data channel is disabled. A forced camera publish was verified to be rejected by the SFU with "insufficient permissions".

### Capture security (Electron main process)

- Sources are listed in the main process (`desktopCapturer`). Discord 2.0's own windows are excluded.
- The renderer *arms* exactly the source the user clicked (`d2:screen-select`). The source ID is validated and must still exist.
- Chromium then asks for a `media` permission with no media types. That permission is granted **once**, and only to the window that armed the selection. The display-media handler then consumes the selection: one use, the same window, and only within 15 seconds. Without a fresh explicit pick, capture is denied. That includes legacy `chromeMediaSource: 'desktop'` requests.
- Cameras are never granted, and are hidden from device enumeration.

Verified on the real app:
- an unarmed `getDisplayMedia` is denied;
- reusing a selection is denied;
- bogus or malformed source IDs are rejected;
- camera `getUserMedia` is denied;
- legacy desktop `getUserMedia` is denied.

## Quality presets

| Preset | Max resolution | FPS | Video ceiling | Notes |
| --- | --- | --- | --- | --- |
| 1080p 30fps | 1920×1080 | 30 | 4.5 Mbps | Documents, slower content |
| **1080p 60fps (default)** | 1920×1080 | 60 | 8 Mbps | Games and motion |
| 1440p 60fps | 2560×1440 | 60 | 14 Mbps | Needs a 1440p+ source and a GPU encoder |

- **No upscaling.** Constraints are maximum-only, so a 1080p monitor shared on the 1440p preset is sent at 1080p, and the picker warns about this. Bitrate ceilings scale with the pixels actually sent.
- **Mode.** "Smooth Gaming" keeps frame rate (`maintain-framerate`); "Sharp Desktop" keeps resolution (`maintain-resolution`, for text and code). A 720p30 preset was added in Milestone 5.1.
- **Changing quality while live** re-applies constraints to the same capture and republishes it. There's no new picker, and viewers re-attach automatically.
- **Codec.** H.264 is the default. Since Milestone 5.1, AV1 is hardware-encoded on GPUs with an AV1 encoder (RTX 40 / RX 7000 / Arc), using single-layer simulcast and Chromium's `WebRtcAV1HWEncode` feature. VP9 stays software (libvpx). See [screen-sharing-performance.md](screen-sharing-performance.md).

### Hardware encoding (important: LiveKit codec config)

On Windows, Chromium (Electron 44) only uses the GPU encoder (Media Foundation → NVENC, AMF or QuickSync) for H.264 profile **`42001f`**. LiveKit's default H.264 profile, `42e01f`, silently falls back to **software OpenH264**. `server/docker-compose.yml` and `server/scripts/livekit-dev.ps1` therefore set `room.enabled_codecs` to LiveKit's default list **plus** an explicit `42001f` H.264 entry. The change is additive: Opus/RED voice and every other codec are unchanged, and the SFU still never transcodes.

Measured on the development PC (NVIDIA GPU, 2560×1440 monitor, Electron 44, local LiveKit 1.13.11):

| Configuration | Encoder reported by WebRTC stats |
| --- | --- |
| Default LiveKit codecs (`42e01f`) | `SimulcastEncoderAdapter (OpenH264, OpenH264)`, power-efficient = false |
| With the `42001f` entry | `SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT) ×2)`, power-efficient = true |

The app never assumes hardware encoding. *Settings → Diagnostics* (and the stream stats overlay) shows the encoder name and the `powerEfficientEncoder` flag exactly as Chromium reports them.

## System audio

| OS | System audio | Discord 2.0 voices excluded from the shared audio? |
| --- | --- | --- |
| Windows 11 | Yes (WASAPI loopback) | **Yes.** Verified: the track reports `restrictOwnAudio: true` on the `loopbackWithoutChrome` device |
| Windows 10 | Yes | **No.** Other people's voices can be re-broadcast, so use headphones (the app warns about this) |
| macOS / Linux | No (option disabled) | — |

- Only whole-system audio is available (no per-application audio).
- Audio is shared only if requested; it's reported as "live" only when a live track was actually published. If audio capture fails, the stream continues video-only and says so.
- Stream audio has its own per-viewer volume and is muted when the viewer is deafened.
- Audio settings: stereo, music preset (~128 kbps), no DTX or RED.

## Deploying to the Jetson

Nothing new is installed on the Jetson. The only server-side change is the LiveKit codec list, plus backend code for streaming presence.

> Run these only when you're ready: they restart the backend and LiveKit, briefly disconnecting anyone in voice.

```bash
cd ~/Discord2.0            # your existing checkout
git fetch origin
git checkout milestone-5-screen-sharing
git pull
cd server
docker compose up -d --build
docker compose ps                                   # both running; livekit healthy
docker compose logs livekit | grep "starting LiveKit server"
curl -s http://192.168.68.65:3001/api/meta          # voice: true
```

**Rollback** to the working voice build:

```bash
git checkout milestone-4-voice && docker compose up -d --build
```

No new ports are needed. The existing ones carry everything: 3001/tcp (backend), 7880/tcp (signaling), 7881/tcp (ICE/TCP fallback) and 7882/udp (media). Keep the deployment LAN-only: no port forwarding and no tunnels.

## Bandwidth (projections, not measurements)

The SFU sends each viewer one copy of the layer it needs. Upload from the sharer's PC is the full layer plus the 720p backup, whatever the number of viewers.

| Preset | Sharer upload | SFU egress, 1 viewer | 3 viewers | 5 viewers | 10 viewers |
| --- | --- | --- | --- | --- | --- |
| 1080p30 | ≤ 6.3 Mbps | ≤ 4.5 Mbps | ≤ 13.5 | ≤ 22.5 | ≤ 45 |
| 1080p60 | ≤ 9.8 Mbps | ≤ 8 Mbps | ≤ 24 | ≤ 40 | ≤ 80 |
| 1440p60 | ≤ 15.8 Mbps | ≤ 14 Mbps | ≤ 42 | ≤ 70 | ≤ 140 |

These are encoder ceilings. Real bitrates are usually lower, especially for desktop content. Gigabit Ethernet on the Jetson and on the PCs handles all of this comfortably. Wi-Fi viewers may be dropped to the 720p layer automatically.

### Measured locally (development PC, loopback, not the Jetson)

- **1440p60 preset, real 2560×1440 screen:**
  - the sharer encoded 2560×1440 (target 11.5 Mbps) plus 720p30, both on NVENC, with no quality limitation;
  - the viewer decoded 2560×1440 at 47–49 fps with 0 dropped frames.
  - Desktop capture only produces frames when the screen changes, so a mostly static desktop gives less than 60 fps.
- **1080p60 preset:** 1920×1080 encoded on NVENC at a 6.75 Mbps target after ramp-up.
- **Synthetic animated source (browser test):** the viewer received 1920×1080 at ~44 fps and 7.2 Mbps with 0% loss. It switched to the 720p layer automatically in the small mini player.

## Benchmark procedure (two real PCs and the Jetson)

1. Deploy as above, then point both PCs at `http://192.168.68.65:3001`.
2. Sharer: *Share Screen → 1440p 60fps → Entire screen → Go Live*. Play a 60 fps video or game.
3. Viewer: click **LIVE**, then turn on the stats overlay (chart icon). Record resolution, FPS, bitrate, decoder, dropped frames and loss over 2 minutes.
4. Sharer: *Settings → Diagnostics*. Record the encoder (and its "(hardware)" / "(software)" label), encode time, send pacer delay and "Limited by". See [screen-sharing-performance.md](screen-sharing-performance.md) for the full procedure.
5. On the Jetson: `docker stats` (LiveKit CPU and memory), `sudo tegrastats`, and `nload eth0` (egress).
6. Repeat for 1080p60 and for 2–3 simultaneous viewers.

Investigate if "Quality limited by" shows `cpu` (the GPU encoder isn't in use), loss stays above 1% on wired LAN, or LiveKit uses more than 50% of a core.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "Screen capture was blocked or cancelled" | The picker selection expired (more than 15 s) or the window closed; pick again |
| Black or frozen video from one window | Protected (DRM) content, or a minimized window; share the screen instead |
| Diagnostics show `OpenH264` / "(software)" for H.264 | LiveKit is running without the `42001f` codec entry (redeploy), outdated GPU drivers, or a VP9/AV1 codec was selected |
| Viewers get 720p | Their player is small (mini player), or bandwidth is limited; expand to focus or fullscreen |
| Others hear themselves through the stream | Windows 10 can't exclude our own audio: turn off system audio or use headphones |
| LIVE badge missing outside the channel | Webhook not reaching the backend: `docker compose logs server \| grep webhook` (reconciliation fixes it within 30 s) |
