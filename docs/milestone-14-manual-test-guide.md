# Milestone 14 — manual test guide (owner)

This guide is for checking the Milestone 14 preview yourself. Everything here runs on your PC
against a **throwaway local server**. Nothing touches the Jetson, your installed v1.2.0 app or the
RC1 builds.

## 0. Rules that keep your real setup safe

- **Always** start the preview with `D2_PROFILE` set (see below). It then keeps its sign-in and
  settings in `%APPDATA%\desktop-<profile>` instead of `%APPDATA%\desktop`, which belongs to your
  installed app. It also skips the single-instance lock, so it can run next to the installed app.
- The preview is a **portable zip**. Unzip it anywhere; there is no installer to run.
- The preview's server list contains "M14 Test Server (this PC)", plus the usual Internet and
  Home Network entries. Use **M14 Test Server** for these checks. The Jetson still runs API 4, so
  most Milestone 14 sharing features will be marked "not supported on this server" there; that is
  expected.

## 1. Start a throwaway local server (PowerShell)

```powershell
cd C:\Users\LStAm\Documents\Discord2.0\Discord2.0\server
$tmp = "$env:TEMP\d2-m14-owner"; New-Item -ItemType Directory "$tmp\att", "$tmp\mail" -Force | Out-Null
$env:PORT = '3001'; $env:HOST = '127.0.0.1'
$env:DATABASE_URL = "sqlite:$($tmp -replace '\\','/')/owner.db"
$env:ATTACHMENTS_DIR = "$tmp\att"; $env:NODE_ENV = 'development'; $env:DEV_AUTH = 'false'
$env:REGISTRATION_MODE = 'open'; $env:MAIL_TRANSPORT = 'file'; $env:MAIL_SINK_DIR = "$tmp\mail"
$env:GIF_PROVIDER = 'mock'; $env:UPLOAD_MIN_FREE_DISK_MB = '1'
npx tsx src/index.ts
```

- The preview build expects the test server at `http://localhost:3001`; with `HOST=127.0.0.1` it
  answers there.
- Sign-up verification codes are written as files to `%TEMP%\d2-m14-owner\mail` (open the newest
  file and copy the code).
- To start over, stop the server and delete `%TEMP%\d2-m14-owner`.

## 2. Start the preview (one or two clients)

```powershell
Expand-Archive C:\Users\LStAm\Documents\Discord2.0\Discord2.0\desktop\dist\v1.4.0-m14-preview\Discord2-*-win-x64.zip "$env:TEMP\d2-m14-preview" -Force
$env:D2_PROFILE = 'owner-a'; Start-Process "$env:TEMP\d2-m14-preview\Discord2.exe"
```

For a second account, open another PowerShell window and run the same command with
`$env:D2_PROFILE = 'owner-b'`. Create two accounts and a server, then invite the second account.

## 3. Five-minute tour

1. **Themes.** Settings → Appearance → Theme gallery.
   - Click three different themes: one dark (Synthwave), one light (Frosted Glass) and Classic.
     Each previews across the whole app.
   - Apply one, close Settings, then quit and restart. The theme stays.
   - With a second account on the same server, the theme also follows your account to the other
     client after a restart.
2. **Theme Effects.** In the same section, switch Theme Effects to Reduced: the ambient motion
   stops and the panels lose their blur. Switch Windows' "Animation effects" off: the same happens
   automatically.
3. **Profile Studio.** Settings → Profile. Pick a gradient preset, a banner art, a decoration, an
   effect and a name style, then Save Changes.
   - The other account opens your profile from the member list and sees the same thing.
   - The effect plays for about 4.5 s and replays on hover.
4. **Animated picture.** Upload a small animated GIF as the profile picture.
   - The cropper says "the animation is kept".
   - In lists it stays still and moves on hover; in the profile popout it moves.
5. **Sound Studio.** Settings → Sounds.
   - Press Audition on each pack: Signature, Classic, Minimal, Cyber, Cozy and Arcade.
   - Choose one, then have the other account send you a DM and an @mention. The DM and mention
     sounds should differ.
6. **Windows.** Settings → Notifications → Windows.
   - Turn on "Close to tray" and close the window. The app stays in the tray; Open from the tray
     brings it back.
   - Turn it off again: closing now quits.
7. **Soundboard** (needs working voice; see 4). Server owner: upload a short clip from the voice
   panel's soundboard button. Both accounts join the same voice channel and press it.
8. **Saved messages.** Hover a message and press the bookmark, or right-click → Save Message. The
   bookmark button in the chat header opens Saved Messages: Jump takes you there, Remove takes it
   off. The other account sees none of your saved messages.
9. **Personal note.** Open the other account's profile from the member list and type in the "Note —
   only you can see this" field, then click elsewhere to save it. Reopen it: the note is still
   there. Nobody else can see it.
10. **Chat wallpaper.** Settings → Appearance → Chat Wallpaper. Pick a pattern and adjust its
    strength. It sits behind the messages in your theme's colors; None removes it. It applies to
    this PC only.

If Windows says the preview app "was blocked" (Smart App Control / Application Control), that is
Windows refusing an unsigned build. It happened to the final m14.3 build on this PC during testing.
Nothing in this guide works around it. Whether to allow it is your decision in Windows Security.

## 4. What can only be checked with real voice

LiveKit could not run on this PC during development, so these were **not** heard by anyone:

- soundboard clips heard by others in a call;
- push-to-talk cue sounds (off by default; Settings → Sounds → Your controls);
- "connection lost" vs "left" sounds, and the reconnect sound after a network drop;
- your-share vs someone-else's-share sounds.

Run them on the Jetson setup after an approved deployment, or with a local LiveKit you trust.

## 5. Listening checklist (please fill in)

Play each event in Settings → Sounds with every pack, at your normal volume.

| Question | Signature | Classic | Minimal | Cyber | Cozy | Arcade |
| --- | --- | --- | --- | --- | --- | --- |
| Any sound unpleasant, harsh or too loud? | | | | | | |
| Mention and DM easy to tell apart? | | | | | | |
| Join and leave clearly different? | | | | | | |
| Mute and deafen obvious without looking? | | | | | | |
| Would you keep this pack on all day? | | | | | | |

Any sound can be swapped for your own file per event; that already existed and still works.

## 6. Upgrade path (what a future deployment would do)

The compatibility run in `milestone-14-test-matrix.md` replays this locally:

1. An account is created on an old (API 5) server.
2. The new app is used against it.
3. The server is upgraded in place, and the database backup is restored once as a rollback
   rehearsal.

Themes picked before the upgrade move to the account automatically. Nothing else changes.
