# Milestone 14.5 — Operation Face to Face (webcams, call view, camera overlay)

- **Date:** October 29, 2026.
- **Branch:** `milestone-14` (local commit; nothing pushed, deployed or published).
- **Preview build:** `v1.4.5-m14.5-preview` (see [Build](#build)).
- **Companion documents:** [compatibility](v1.4.0-compatibility.md),
  [staging plan](v1.4.0-staging-plan.md) (gate G7 gains the camera checks below),
  [release-readiness report](v1.4.0-release-readiness.md).

Discord 2.0 can now send and receive webcams in voice channels:

- a **call view** with everyone's cameras in a responsive grid (focus one person, the rest in a
  strip), plus camera thumbnails under a screen share you're watching;
- an optional **camera overlay**: a small, movable, click-through, always-on-top window with
  the cameras of the people in your call, for playing games while you see your friends.

The camera is **never** on unless you turn it on, in this session, in this call.

## What you see

| Where | What |
| --- | --- |
| Voice panel (bottom left, while connected) | **Camera** button (off / starting / on with a red dot / failed / unavailable with the reason), **video view** button with the number of cameras on, **overlay** on/off button. Camera errors appear under it with Dismiss. |
| Channel list | A camera icon next to everyone in the voice channel whose camera is on. |
| Click the voice channel you're in | Opens the call view. |
| Call view | Header (channel, cameras on, Hide my self-view, Overlay on/off, close). Grid of tiles that keeps 16:9 (letterboxed, never stretched); pages when tiles would be smaller than 240 px wide. Click a tile's pin to focus it; the others go to a strip. Full screen per tile. People without a camera are listed under the grid with their mute/deafen state. "Watch X's stream" chips. Round camera button. Screen readers hear when someone turns a camera on or off. |
| Watching a screen share in focus mode | Camera thumbnails under the stream; clicking one opens the call view. |
| Settings → **Video & Overlay** | Camera: Windows privacy notice and a link to Windows camera settings when blocked; device and quality; private preview (or your live call camera if it's on); mirror, hide self-view, show other people's cameras. Overlay: on/off, layout (grid / row / stack), tile size, how many, corner, display, opacity, names, speaking ring, show yourself, show while Discord 2.0 is in front, pinned person, **Arrange overlay…**, Restore defaults. |
| Settings → Keybinds | **Camera on / off** (only while the app is focused; can never be made system-wide), **Show / hide camera overlay** and **Move camera overlay** (may be system-wide). All unbound by default. |
| Server Settings → roles / channel permissions | The **Stream** permission is now labelled **Video**: "Turn on a camera and share a screen (Go Live) in voice." |

## Camera lifecycle and privacy

- **Off by default, never remembered.** Settings store the device, quality, mirror and receive
  choices only; there is no stored "camera on" (unit-tested: `parseCameraSettings` ignores
  `cameraOn`). Joining a call never starts the camera.
- **Turned off automatically** when you leave, switch channel, get disconnected, the client rejoins,
  the device disappears, the server withdraws permission (`ParticipantPermissionsChanged`), or a
  newer request replaces it. Each has its own reason and message. `stop()` changes state
  synchronously and stops the capture **before** unpublishing, so the light goes off at once.
- **Capture timeout** (12 s): a camera that never answers is released, and a late track is stopped.
- **Fallback:** a missing or unsuitable chosen camera falls back to the default once, with a notice.
- **Preview** in Settings is private ("Preview — not sent"). It is released when you stop it,
  change page or close Settings (verified: tracks end). If your call camera is already on, the
  preview shows that same track instead of opening the camera twice.
- **Errors** are classified (blocked by Windows privacy settings, in use by another app, not found,
  unsupported resolution, timeout) with a plain message and, for privacy blocks, a button to open
  `ms-settings:privacy-webcam`.
- **Permission scope in Electron:** camera capture is allowed only for the main window's main frame
  (`main/overlayLogic.ts: mediaRequestAllowed`). The overlay window, iframes or any other page
  can't get a camera. Screen capture keeps its separate picker.
- No frames are recorded, stored, uploaded outside the LiveKit call, or logged.

## Sending and receiving

| Preset | Capture | Max bitrate | Simulcast layers |
| --- | --- | --- | --- |
| Data saver | 640×360 @ 15 | 400 kbps | 320×180 @ 15 |
| **Balanced** (default) | 1280×720 @ 30 | 1.7 Mbps | 320×180 @ 15, 640×360 @ 30 |
| High quality | 1920×1080 @ 30 | 3 Mbps | 640×360 @ 30, 1280×720 @ 30 |
| Smooth motion (advanced) | 1280×720 @ 60 | 2.5 Mbps | 320×180 @ 15, 640×360 @ 30 |

- Sizes are `ideal`, never forced; the encoder drops layers at or above what the camera really
  delivers and scales the bitrate down for smaller captures (`cameraEncodings`).
- VP8 with simulcast, `degradationPreference: balanced`, `contentHint: motion`. Device switches use
  `replaceTrack` (no republish); quality changes republish.
- **Receiving:** cameras are subscribed only when "Show other people's cameras" is on
  (`subscriptions.ts`). LiveKit adaptive stream picks the layer for each tile's size and pauses
  video that isn't on screen.

## Server side

- `publishSourcesFor`: Speak → microphone; Stream ("Video") → **camera**, screen share and screen
  share audio. `GET /api/meta` gains `camera: true`.
- **No database migration.** The webhook ignores camera tracks for the "streaming" flag.
- Tests: token grant lists, a channel deny of Stream removes camera and screen share, the camera
  doesn't toggle streaming (`server/test/voice.test.ts`, `accounts.test.ts`).

## Overlay architecture

```
Main renderer (React) ──window.open('about:blank','d2-camera-overlay')──▶ child window (same process)
   │  createPortal(tiles, child.document)              │ same MediaStreamTrack objects
   │  bridge.update({visible, mode, bounds}) ─IPC──▶ main/overlay.ts: place, mode, show/hide
   ◀── d2:overlay-event: moved (edit mode) / displays / closed
```

- **One window**, created only while wanted (overlay on and in voice, or while arranging) and
  destroyed when not. It is **not** a second participant: no second LiveKit connection, no media
  over IPC, no second decode. Tiles play the same tracks the app already receives.
- **Window:** frameless, transparent, no shadow, not resizable, skip taskbar, always on top at the
  `screen-saver` level (above borderless games), sandboxed, context-isolated, background
  throttling off. It can't navigate or open windows, and the preload bridge isn't exposed in it
  (`window.d2` is undefined there; verified).
- **View mode** (normal): click-through and never focusable (`setIgnoreMouseEvents(true)`,
  `setFocusable(false)`, shown inactive), so the game keeps the mouse and keyboard.
- **Edit mode** (Arrange overlay…, or the Move keybind): a dashed border and a toolbar (Drag to move,
  smaller, bigger, layout, Done). Click a tile to pin that person first. The position is saved as a
  corner or a custom point relative to the chosen display.
- **Lifetime:** destroyed with the main window, when the main page reloads or crashes, and on quit;
  if it's closed from outside, the app notices and stays hidden until you show it again.
- **IPC** (`d2:overlay-displays`, `d2:overlay-update`, `d2:overlay-close`) accepts only the main
  window's app page; every command is validated and bounds are clamped to the visible displays
  (twice if Windows mis-sizes it while moving between monitors with different scaling).
- **Video while minimized:** each overlay tile registers itself with LiveKit's adaptive stream as a
  picture-in-picture element while shown. LiveKit keeps sending a small layer while the main window
  is minimized or behind the game, and stops when the overlay is hidden. This uses
  `observeElementInfo`, which livekit-client marks `@internal`: **re-check after upgrading
  livekit-client.**
- **Layout:** the overlay never covers more than 40% of the display's width or height; tiles shrink
  (down to 112×63) and then fewer are shown. 16 px from the screen edge.

### Supported and not supported

| Situation | Overlay |
| --- | --- |
| Normal apps, windowed games, **borderless / "fullscreen windowed"** games | Shown on top (designed for this). |
| **Exclusive fullscreen** games | May be drawn over by the game. That's a Windows limitation; Discord 2.0 doesn't inject into, hook or capture games to get around it. Use borderless mode. |
| Games with anti-cheat | Nothing is injected; the overlay is an ordinary topmost window. |
| Several monitors | Choose the display; moved back on screen if a display is removed. |
| Discord 2.0 in front | Hidden by default ("Show while Discord 2.0 is in front" to keep it). |

## Performance

- Measured here (no live video; see the evidence): showing the overlay had **no measurable CPU
  cost** (two alternating 10 s samples, within noise) and added 2–5 MB of working set.
- **Observation (not caused by this milestone):** the app idled at about 30% of one CPU core in the
  GPU process with the Milestone 14 animated theme effects on; with reduced theme effects it was 0%.
  Consider reduced effects as the default for busy PCs.
- Real decode and encode cost with several cameras in a call is **unverified** (needs LiveKit; see
  checklist item S).

## Tests and evidence

| Gate | Result |
| --- | --- |
| Desktop typecheck (web + node), ESLint (whole project) | PASS |
| Desktop unit tests | PASS — 552/552 in 57 files (baseline 465). New: camera presets/errors, `CameraController` (21), `MediaSession` camera (6), subscriptions, overlay/gallery layout, overlay IPC/permission logic, keybinds, settings parsing, component rendering (9). |
| Server typecheck and tests | PASS — 272/272 (baseline 269) |
| Local E2E (dev Electron, Chromium fake camera, isolated profile, local API 6 server) | PASS — 16 checks, below |

Local E2E (evidence in the session folder `files\m145\`, `E2E-EVIDENCE.md` and `shots\`):

- **Settings:** the camera list shows; the preview runs at 1280×720 and is mirrored; switching to
  High restarts it at 1920×1080 and ends the old track. Stop, and closing Settings while
  previewing, both end the capture.
- **Overlay:** Arrange opens the window (transparent, no bridge inside). Toolbar clicks with real
  mouse input go through the React portal (size saved and the window resized, anchored at 16 px).
- **Native window state (Win32):**
  - edit mode: topmost and hit-testable;
  - view mode: `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE`, and a click at its centre
    reaches the window underneath.
- **Lifetime:** closing it from outside, Done, a main-page reload and closing the main window are
  all handled.
- **Bug fixed:** the speaking and pinned rings were painted under the video.

**Not verifiable on this PC** (no webcam, and LiveKit is blocked by Smart App Control):

- publishing and receiving through LiveKit;
- remote tiles and the call view in a live call;
- physical webcams;
- two PCs;
- games;
- moving between monitors with different DPI;
- drag-to-move persistence.

All of these are in the checklist below.

## Two-PC acceptance checklist (A–X)

Run it with the staging plan (gate G7) or after the server update. Use PC A and PC B, each with a
webcam, in the same voice channel.

| # | Check | Expected |
| --- | --- | --- |
| A | Join voice on both | Cameras are off on both; nobody's camera light is on |
| B | A turns the camera on | A's light on; A sees a mirrored self-view; B sees A (not mirrored) within ~2 s; camera icon next to A in the channel list on both |
| C | A turns it off | A's light goes off at once; B's tile disappears; A's icon goes |
| D | Both on; open the call view on both | Two tiles, yours first; speaking ring follows who talks; nothing stretched |
| E | Focus a tile; full screen; back | Focus layout with strip; full screen works; Esc returns |
| F | A switches camera device while on (Settings) | B keeps seeing A without a gap longer than ~1 s; no republish error |
| G | A changes quality while on | B's picture changes accordingly; no error |
| H | A switches voice channel with the camera on | A's camera turns off (notice explains why) |
| I | A leaves voice | Camera off at once; B's tile disappears immediately |
| J | Unplug A's webcam while on | Camera turns off with a clear message; nothing hangs |
| K | Another app holds A's camera; A turns it on | "In use by another app" message; nothing stuck in Starting |
| L | Windows camera privacy off for desktop apps; A turns it on | Privacy message with a button opening Windows camera settings |
| M | Deny the Video permission in the channel for A's role | A's camera button disabled with the reason; a live camera turns off |
| N | B turns off "Show other people's cameras" | B sees avatars, no video (bandwidth drops in Diagnostics) |
| O | Mute/deafen with the camera on | Icons on tiles and in the list update on both PCs |
| P | B shares a screen while A's camera is on; A watches in focus | Stream plays; A's camera strip shows under it; clicking a thumbnail opens the call view |
| Q | Turn the overlay on (B) and start a borderless game | Tiles on top of the game; mouse and keyboard go to the game (click-through) |
| R | Move overlay keybind, drag, Done; restart the app | New position kept; overlay click-through again after Done |
| S | 3–4 cameras for 10 minutes | Task Manager on both PCs: CPU and GPU reasonable; no growing memory; overlay video keeps moving with the app minimized |
| T | Hide/show overlay keybind during the game | Hides and shows instantly; the call continues |
| U | Exclusive-fullscreen game | Note whether the overlay shows (it may not: documented limitation) |
| V | Two monitors with different scaling: put the overlay on the second, then unplug it | Right size on the second monitor; comes back on screen after unplugging |
| W | A 1.2.0 or API 4 setup in the same call | No crash; the 1.2.0 user never sees cameras; on an API 4 server the camera button says the server needs the update |
| X | Leave voice, restart both apps | Cameras off; no camera light; overlay gone until the next call |

## Compatibility

| Desktop / server | Cameras |
| --- | --- |
| 1.4.5 app + upgraded server (camera grant) | Full feature |
| 1.4.5 app + API 4 or 1.4.0 server (no camera grant) | The camera button is disabled: "This server doesn't support cameras yet (it needs the Discord 2.0 v1.4 server update)." Viewing others is impossible because nobody can publish. The overlay can be arranged but stays empty. |
| 1.2.0 / 1.4.0 app + upgraded server | Works as before. These apps never subscribe to camera tracks, so 1.4.5 users' cameras are simply not shown to them, and they can't send cameras. |

The camera grant ships with the server in this branch (`camera: true` in `/api/meta`). A server
that is upgraded to this branch's code grants cameras to everyone who has the Video (Stream)
permission, which by default is the same set of people who can screen share today.

## Build

The preview is built from this commit with its version set at build time (the repository keeps
`1.4.0-rc.1`) and the production server list. It goes into a new folder so nothing is
overwritten:

```powershell
cd desktop
Remove-Item Env:RENDERER_VITE_SERVERS -ErrorAction SilentlyContinue   # use .env.production
npx electron-vite build
npx electron-builder --win zip --publish never `
  --config.directories.output=dist/v1.4.5-m14.5-preview `
  -c.extraMetadata.version=1.4.5-m14.5-preview
```

Run it with its own profile so it doesn't share data with the installed app:

```powershell
$env:D2_PROFILE = 'm145'
& '.\dist\v1.4.5-m14.5-preview\win-unpacked\Discord2.exe'
```

The executable is unsigned; Smart App Control may block it (see the build report in the
readiness document). Don't bypass it: test from source with `npm run dev`, use a PC without Smart
App Control, or wait for code signing.

## Files

- **Server:** `server/src/voice/access.ts`, `server/src/app.ts`, `server/src/protocol.ts`, tests.
- **Media:**
  - `desktop/src/renderer/src/media/cameraProfiles.ts`, `CameraController.ts`,
    `MediaSession.ts`, `subscriptions.ts`;
  - `desktop/src/renderer/src/lib/overlay.ts`, `gallery.ts`.
- **UI:**
  - `desktop/src/renderer/src/components/video/` (`CallStage`, `VideoTile`, `CameraButton`,
    `CameraStrip`, `CameraOverlay`, `overlay.css`, `useAttachedTrack`);
  - `components/VideoSettings.tsx`, `assets/video.css`;
  - changes in `Workspace.tsx`, `UserPanel.tsx`, `ChannelSidebar.tsx`, `SettingsPanel.tsx`,
    `Icons.tsx`.
- **Main and preload:** `desktop/src/main/overlay.ts`, `overlayLogic.ts`, `media.ts`, `index.ts`,
  `shortcuts.ts`; `desktop/src/preload/`.
