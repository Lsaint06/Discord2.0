# Milestone 9 — Sound and interaction polish ("Project Atmosphere")

Milestone 9 gives Discord 2.0 its own sound identity and makes the existing interface more consistent and accessible:

- an original, synthesized sound palette played by one central sound service;
- a **Sounds** settings section with a master switch, volume, per-sound toggles and preview buttons;
- one shared rule for detecting @mentions (highlighting, notifications and sounds);
- keyboard-safe dialogs: focus moves in, stays in, and returns to where it came from;
- shared motion tokens and a fix for the reduced-motion preference;
- interaction polish for messages, the sidebars, voice and Go Live.

**Desktop only.** No backend, database or Docker changes. Nothing has been deployed.

## Contents

1. [Sound architecture](#sound-architecture)
2. [Sound palette and defaults](#sound-palette-and-defaults)
3. [When sounds play](#when-sounds-play)
4. [Sounds settings and migration](#sounds-settings-and-migration)
5. [Mentions](#mentions)
6. [Dialogs and keyboard access](#dialogs-and-keyboard-access)
7. [Motion, reduced motion and visual polish](#motion-reduced-motion-and-visual-polish)
8. [Files](#files)
9. [Verification](#verification)
10. [Known limitations](#known-limitations)

## Sound architecture

```
Workspace ──play(event)──▶ SoundService ──▶ one AudioContext ──▶ master gain ──▶ output device
   │                          ▲   │                                              (setSinkId)
   │ messageSound() + SeenMessages (soundPolicy)  └─ AudioBuffers rendered once from sounds.ts
   │ useVoiceSounds ─ trackVoiceSounds (voice snapshots → connect/disconnect/join/leave)
   └ SoundProvider ─ preferences, output device, gesture unlock, dispose; context for Settings
```

| Module | Role |
| --- | --- |
| `sound/sounds.ts` | Event list, labels, and a recipe per sound (notes, waveform, partials, glide, envelope, low-pass, echo). A small TypeScript renderer turns a recipe into samples, normalized to the same loudness and peak-limited. |
| `sound/soundPolicy.ts` | Pure rules: toggles, Do Not Disturb, muted channels, own messages, the channel you're viewing, per-message deduplication (`SeenMessages`), burst control (`SoundGate`), and settings migration. |
| `sound/SoundService.ts` | The only playback code. One lazily created `AudioContext`, separate from LiveKit's voice audio, which it never touches. Also handles: cached buffers, master volume on a perceptual curve, at most 6 sounds at once, follows the output device, suspends after 8 s idle, and `dispose()` on sign-out. |
| `sound/SoundProvider.tsx` | Keeps preferences and the output device in sync, unlocks audio on the first click or key press, releases audio when the workspace unmounts, and shares the service with Settings. |
| `sound/useVoiceSounds.ts` + `sound/voiceSoundTracker.ts` | Turns voice snapshots into connect/disconnect and other people's join/leave sounds. |

**No dependency was added.** The sounds are synthesized in code (no audio files) and played with the built-in Web Audio API. Rendering samples in TypeScript instead of an `OfflineAudioContext` makes the output deterministic and unit-testable: tests check loudness, peaks, length, clicks and distinctiveness.

**Reliability:**
- **Blocked audio.** If audio can't start (no user gesture yet, or no device), `play()` returns `unavailable`. The Windows notification then plays its own chime as a fallback, and the next click or key press unlocks audio.
- **Output device.** Sounds follow the voice output device. If that device fails or `setSinkId` isn't supported, they play on the default device, and Settings says so.
- **Creation failure.** If the audio context can't be created, the service doesn't retry on every message.
- **Sign-out.** Stops all sounds, closes the context and frees buffers. The service is reusable after sign-in.

## Sound palette and defaults

All sounds are original, generated from code, 0.11–0.75 s long, and matched to the same loudness (about −18 dBFS RMS, peaks below −5 dBFS before the volume control). The master volume defaults to **60 %**.

| Event | Character | Default |
| --- | --- | --- |
| New message | Gentle two-note chime (bell partials, soft echo) | On |
| Mention | Brighter rising three-note figure | On |
| Someone joins voice | Warm two-note rise | On |
| Someone leaves voice | The same, falling | On |
| You connect | Soft major arpeggio | On |
| You disconnect | Subtle two-note fall | On |
| Mute / Unmute | Short low "tock" / higher "tick" | On |
| Deafen / Undeafen | Two quick deeper notes / two bright notes | On |

**Not added (P2, by decision):** interface click sounds, Go Live start/stop sounds, and a sound for messages you send.

**Previews:** each sound has a **Preview** button in Settings → Sounds.
- Previews play only when clicked; opening Settings plays nothing.
- They ignore the individual toggle, so you can audition a sound before turning it on, but respect the master switch and volume.

## When sounds play

| Situation | Message / mention sound | Voice and control sounds |
| --- | --- | --- |
| Master switch off, or volume 0 | silent | silent |
| Event toggle off | silent (a mention with Mention off falls back to the message chime if that's on) | silent |
| Do Not Disturb | **silent** | still play (your own actions; calls you're in) |
| Muted channel | silent | — |
| Your own message (including the optimistic echo) | silent | — |
| Message in the channel you're viewing while the window is focused | silent (same rule as desktop notifications) | — |
| The same message delivered twice | at most one sound (deduplicated by message id) | — |
| Catch-up after a reconnect | silent (history sync never triggers sounds) | — |
| Several messages at once | one chime per 0.9 s | — |
| Several mentions at once | spaced 0.35 s apart; at most 3 queued, the rest dropped | — |
| You join a busy voice channel | — | one "connect"; the people already there are not "joins" |
| Network reconnect | — | silent (no connect sound, no join burst) |
| Channel switch | — | "connect" for the new channel |
| Leaving, being disconnected, or giving up reconnecting | — | one "disconnect" |
| Mute / deafen buttons, Settings → Voice, Unmute while deafened | — | your action only, never from state sync |

Join and leave detection waits 1.5 s after each (re)connection for the roster to settle. Several people joining at the same moment play one sound.

**Windows notifications vs. sounds:** they're independent. Desktop notifications keep their own on/off switch and the message-preview setting. When an app sound is wanted, the Windows notification is **silent**. It only chimes as a fallback when the app's audio is unavailable. A notification for a mention is now titled "*Name* mentioned you in #channel".

## Sounds settings and migration

- **Settings → Sounds:** master switch, volume (0–100 %, 5 % steps), a toggle and Preview per event in three groups (Messages, Voice, Your controls), and **Reset sound settings**.
- **Settings → Notifications:** the old "Notification Sounds" switch is gone; a link points to Sounds.
- **Storage:** per device, in `localStorage` (`d2.settings`), like voice devices. No server or database change.

New fields:

| Field | Default |
| --- | --- |
| `soundEffects` | true |
| `soundVolume` | 60 |
| `soundEvents` | all on |

**Migration from earlier versions:**
- Turning the old Windows-chime setting **off** (`notificationSounds: false`) turns the new **message and mention** sounds off. Nobody who chose silence gets sounds.
- If the old setting was on (the default), the new sounds start on.
- Saved Milestone 9 sound settings always win over the old setting.
- Invalid values fall back to defaults: volume is clamped to 0–100, unknown events are dropped.
- The old key is dropped the next time settings are saved.

## Mentions

`chat/mentionMatch.ts` holds the one rule, used by the Markdown renderer, message highlighting, notification titles and the mention sound:

- **Where a mention can start:** at the start of the text, after whitespace, or after opening punctuation. `bob@example.com` is not a mention.
- **What matches:** your **username**, your **display name** (including multi-word names like "@The Real Saint") and **@everyone**, case-insensitively.
- **Longest name wins**, so "@Ann Lee" mentions Ann Lee, not a user called "Ann".
- **Word boundary at the end:** "@bobby" and "@bob.smith" are not "@bob"; "@bob." and "@bob," are.
- **Literal matching:** names are compared as plain text, never as patterns, so characters like `.`, `*` and `(` are safe.
- **Code is excluded:** mentions in inline code, code blocks or escaped as `\@` don't count, exactly as they don't render as mentions.

Other people's multi-word display names also render as single mention pills. **This is detection only:** there is still no autocomplete and no structured (id-based) mentions, so renaming yourself changes what matches.

## Dialogs and keyboard access

`hooks/useDialog.ts` (logic in `lib/focusTrap.ts`) is applied to these dialogs:
- Settings;
- Create/Join Server;
- Invite;
- Server Settings and its Ban confirmation;
- Full Profile;
- Custom Status;
- Image Cropper;
- Go Live picker;
- Delete Message confirmation.

What it does:
- **Focus moves in on open.** A `data-autofocus` element is used if there is one, otherwise the first control that isn't the close button.
- **Tab and Shift+Tab stay inside.** Focus that escapes (for example a click on the backdrop) is pulled back.
- **Escape closes only the top dialog**, so it closes the cropper rather than Settings underneath. Pickers inside a dialog (emoji, key binding) handle their own Escape first. Escape is ignored while an upload or save is in progress.
- **Focus returns** to the control that opened the dialog.
- **Background shortcuts are off** while a dialog is open (Ctrl+F search, Escape-to-mark-read).
- **Popouts and menus are not traps.** The profile popout and status menu keep their own focus handling.

Server icons and **Add a Server** show their tooltip on keyboard focus as well as on hover.

## Motion, reduced motion and visual polish

**Tokens** in `main.css`:

| Group | Tokens |
| --- | --- |
| Duration | `--motion-fast` 100 ms, `--motion-base` 150 ms, `--motion-slow` 220 ms |
| Easing | `--ease-out`, `--ease-standard` |
| Shadows | `--shadow-low`, `--shadow-menu`, `--shadow-modal` (softer in the light theme) |
| Radii | `--radius-sm`, `--radius-md`, `--radius-lg` |
| Focus and press | `--focus-ring`, `--press-shift` |

New and edited rules use these tokens; the rest of the stylesheet is unchanged.

**Reduced-motion fix.** The **Allow all animations** preference couldn't override Windows' "reduce motion", because an unconditional `@media (prefers-reduced-motion)` rule always applied. That rule now only applies unless the account preference is "Allow all animations" (`data-reduced-motion="off"`).

| Preference | Windows setting | Result |
| --- | --- | --- |
| Reduce motion | any | Non-essential animation off |
| Sync with computer | reduce | Animation off |
| Sync with computer | normal | Animation on |
| Allow all animations | any | Animation on |

Under reduced motion, jump highlights stay visible as a static highlight instead of vanishing.

**Changes by area:**

| Area | Changes |
| --- | --- |
| Dialogs and menus | Dialogs fade and rise 6 px over 150 ms; Settings and Server Settings over 220 ms, with no scaling. Popouts and menus lost their scale effect. Shadows are consistent. |
| Pressed and disabled states | A 1 px press on buttons, icon buttons, toolbar buttons, reactions, channels, members, settings items, server icons and menu items. Consistent disabled styling. |
| Messages | The hover toolbar fades in and has pressed states. The jump target (reply, search, pin, link) gets an accent bar and a gentle fade. A reaction count lifts briefly when it goes up live; history loads, channel switches and unchanged counts after a reconnect never animate. |
| Sidebars | Eased server icon and indicator transitions, tooltips that fade in, and unread badges that fade in. |
| Voice and Go Live | The speaking ring comes on in 60 ms and fades out over 220 ms, so it doesn't flicker between words. The signal icon pulses while connecting or reconnecting. The Go Live badge shows a neutral pulsing "…" while starting instead of looking live. Screen-share capture, quality and diagnostics are unchanged. |

## Files

**New:**

| Area | Files |
| --- | --- |
| Sound | `sound/sounds.ts`, `soundPolicy.ts`, `SoundService.ts`, `SoundProvider.tsx`, `soundContext.ts`, `useVoiceSounds.ts`, `voiceSoundTracker.ts` |
| Mentions | `chat/mentionMatch.ts`, `chat/mentions.ts` |
| Dialogs | `lib/focusTrap.ts`, `hooks/useDialog.ts` |
| Settings | `components/SoundSettings.tsx` |
| Tests | `sound/sounds.test.ts`, `soundPolicy.test.ts`, `SoundService.test.ts`, `voiceSoundTracker.test.ts`, `soundSettings.test.ts`, `chat/mentions.test.ts`, `lib/focusTrap.test.ts`, `lib/motion.test.ts` |

**Changed:**
- `Workspace.tsx`, `types.ts`, `data/defaults.ts`, `net/session.ts`;
- `chat/markdown.ts`, `chat/unread.ts` (and its test);
- `components/` — `SettingsPanel`, `ChatPanel`, `chat/MessageItem`, `chat/Markdown`, `ServerSidebar`, `UserPanel`, `CreateServerModal`, `ScreenSharePicker`, `manage/InviteModal`, `manage/ServerSettingsModal`, `profile/ProfileModal`, `profile/CustomStatusModal`, `profile/ImageCropper`;
- `assets/main.css`.

All paths are under `desktop/src/renderer/src/`.

## Verification

**Automated**, on the development PC:
- **Desktop:** Prettier, ESLint, typecheck, production build, and `npm test` with 203 tests (136 existing plus 67 new).
- **Server:** unchanged code; its 107 tests were re-run.

**Live run on this PC.** Two Electron windows of the built app against a local backend. Sound playback was instrumented at the Web Audio and `Notification` layer, because the harness can't listen. It checked:
- previews play the right sounds;
- opening Settings plays nothing;
- mention and message sounds, with Windows chimes suppressed and the "mentioned you" title;
- burst coalescing;
- silence for muted channels, DND (while mute/unmute still sound), the master switch, and your own messages;
- control sounds;
- highlighting for `@username` and multi-word `@display name`, with no false positive;
- the reaction lift;
- focus trap, Escape and focus return for Settings, Create Server and Full Profile;
- Ctrl+F blocked under a modal;
- reduced motion in all four combinations;
- light and dark rendering;
- one shared `AudioContext`.

**Not verified:**
- What the sounds sound like on real speakers or headphones (only checked numerically and through instrumentation).
- Voice join/leave/connect sounds against a live LiveKit server; these are covered by unit tests on the snapshot tracker.
- Effect sounds leaking into the microphone on speakers (echo cancellation).
- Two physical PCs, the packaged app, and the Jetson.

**Two-PC checklist (manual):**
1. On both PCs, open **Settings → Sounds** and preview each sound. Adjust the volume and check that the level follows.
2. PC 2 messages a channel PC 1 isn't viewing: PC 1 chimes once. A burst of messages gives one chime. `@username` or `@Display Name` plays the mention sound and highlights the message.
3. Check each kind of silence on PC 1: DND, muting the channel with the bell, and the master switch.
4. Both PCs join **Lounge**: PC 1 hears "connect" and later "joins" for PC 2. Leave: "leaves" and "disconnect". Pull PC 2's network for 10 s: no join burst when it comes back.
5. Mute, unmute, deafen and undeafen on PC 1: each gives feedback, and nothing leaks into PC 2's voice.
6. Go Live: the badge shows "…" while starting, then LIVE. Stream quality and stats are unchanged.
7. Use Tab and Escape through every dialog. Then turn on Windows "Show animations" off and try each Animations setting.

## Known limitations

- **Synthesized sounds.** Simple synthesized timbres were tuned numerically, not by a sound designer. Ask for changes after listening.
- **Each device plays its own sound.** If you're signed in on two PCs, both chime.
- **Speakers and the mic.** On speakers, sound effects may be picked up by your microphone, depending on Windows/Chromium echo cancellation.
- **No mention counters** (P2 was not authorized). Server/channel mention badges need a backend design.
- **No reaction-sound or animation for reactions added while offline** beyond the count change itself.
