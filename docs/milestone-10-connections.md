# Milestone 10 — Friends, blocking and direct messages ("Project Connections")

Milestone 10 adds people-to-people features on top of servers:

- **Friends:** send a request by exact username, accept, decline, cancel, remove.
- **Blocking:** silent, mutual effects, never revealed to the blocked person.
- **Direct messages (DMs):** one conversation per pair, with every Messaging 2.0 feature (attachments, edits, replies, reactions, pins, unread state, search, notifications).
- **Group conversations:** 3–10 people, built from friends, with a history boundary for people added later.
- **Privacy setting:** choose whether people you only share a server with may message you.

**Nothing has been deployed.** The Jetson keeps running its current server. There are no new ports, services or dependencies, and nothing is publicly exposed.

> **Not end-to-end encrypted.** Conversations are protected in transit (TLS when you add it, LAN otherwise) and stored in the server's SQLite database like channel messages. Whoever runs the server can technically read them. The app says so in Settings → Privacy & Safety.

## Contents

1. [What changed](#what-changed)
2. [Rules](#rules)
3. [How conversations are stored](#how-conversations-are-stored)
4. [Privacy and authorization](#privacy-and-authorization)
5. [API and gateway](#api-and-gateway)
6. [Desktop app](#desktop-app)
7. [Database migration v5](#database-migration-v5)
8. [Deployment procedure](#deployment-procedure)
9. [Backup and rollback](#backup-and-rollback)
10. [Tests](#tests) · [Release-gate live verification](#release-gate-live-verification) · [Architecture assessment](#architecture-assessment-the-hidden-container)
11. [Two-PC checklist](#two-pc-checklist)
12. [Known limitations](#known-limitations)

## What changed

| Area | Summary |
| --- | --- |
| Backend | Migration v5 (additive). New `routes/relationships.ts`, `routes/conversations.ts`, `conversationEvents.ts`. `access.ts` authorizes conversations by membership; history boundaries are enforced in messages, pins, reactions, replies, attachments, read states and search. Blocked users' presence is masked. `/api/meta` reports `apiVersion: 4, connections: true` |
| Dependencies | None added |
| Desktop | The logo button is now **Home**: Friends page (Online / All / Pending / Blocked / Add Friend), conversation list, DM and group chat (the existing chat panel), group members panel, create-group and add-friends dialogs, profile actions (Message / Add Friend / Accept / Block), Settings → Privacy & Safety, a new *Friend request* sound |
| Docs | This file, README and server README |

## Rules

### Friends

- Requests go by **exact username** (case-insensitive). A request to a username that doesn't exist, belongs to a bot or a disabled account, or to someone who blocked you gets **the same answer** (`404 friend_request_failed`). Nobody can find out who blocked them, and the endpoint has its own rate limit (10, then 1 per minute) against username probing.
- If both people ask each other, the requests become a friendship, even when they happen at the same moment (one SQLite `BEGIN IMMEDIATE` transaction).
- Repeating a request is harmless (`200`, nothing new). Asking an existing friend → `409 already_friends`. Asking yourself → `400`.
- Removing a friend, cancelling your request and declining theirs are the same call (`DELETE /api/relationships/:userId`).

### Blocking

- You can block anyone you can see, including someone who already blocked you.
- Blocking ends any friendship and deletes pending requests either way.
- Either direction of a block means:
  - no new DM between you, and an existing DM becomes **read-only** for both (history stays);
  - no friend requests;
  - you don't see each other's presence or custom status (both appear offline);
  - you can't add each other to groups.
- The blocked person is never told. Their relationship list simply shows nothing, and every refusal uses the same wording as other refusals.
- Blocking does **not** remove anyone from shared servers or groups. In a shared server or group, messages from people you blocked are still shown (as in most chat apps). Moderation stays a server matter.

### Direct messages

- **Who can start or send a DM:** friends; or people who share a server with you, if you allow DMs from server members (Settings → Privacy & Safety; on by default). Never across a block, and never with bots or disabled accounts.
- The rule is **re-checked on every message**. If you unfriend someone you share no server with, or someone turns off server DMs, the existing DM becomes read-only. It becomes writable again if the situation changes.
- Exactly **one DM per pair**, enforced by a unique key (`dm_key`). Two people opening it at the same moment get the same conversation.
- A new DM appears for the other person only when the first message arrives.
- DMs can't be left, only **closed** (hidden from your list on all your devices). The next message reopens it.

### Groups

- Created from **your friends**: 2–9 of them, so 3–10 people including you. An optional name (up to 100 characters); without one, the members' names are shown.
- **Any member** can add one of *their own* friends (no block between them), up to 10 members. The size check runs inside a transaction, so simultaneous adds can't exceed it.
- **Any member** can rename the group. **Only the owner** can remove people.
- **Leaving** removes you completely. If the owner leaves, ownership passes to the longest-standing member. An empty group is kept in the database but nobody can reach it.
- **History boundary:** someone added later sees only messages sent *after* they joined, never older history. This is enforced on the server (see below). Someone removed and re-added gets a new boundary: they don't see what was said while they were away.
- Membership changes (created, added, removed, left, owner changed, renamed) are recorded. Members see the history of these events from when they joined.
- Nobody moderates other people's messages in a conversation: you can edit and delete your own, react, reply and pin.

## How conversations are stored

A conversation **is a text channel**. Each one is a `channels` row inside a reserved container, `DIRECT_SERVER_ID = '@direct'` (a `servers` row with no members and no owner). The conversation id equals the channel id. As a result, messages, attachments, reactions, pins, read states, full-text search and realtime delivery all reuse the proven Messaging 2.0 code paths.

Around it:

| Table | Purpose |
| --- | --- |
| `conversations` | Kind (`dm`/`group`), `dm_key` (`userA:userB`, sorted, `UNIQUE`; a `CHECK` ensures only DMs have one), name, owner, creator |
| `conversation_members` | Current members only, with `joined_at`, `history_from` (newest message id when they joined) and `closed` |
| `conversation_events` | Membership history (who added/removed/left, renames, owner changes) |
| `friend_requests` | Pending requests (`from`, `to`) |
| `friendships` | One row per pair, stored with `user_a < user_b` (`CHECK`), so a pair exists once |
| `user_blocks` | Who blocked whom |
| `users.allow_server_dms` | The privacy setting (default on) |

**The container stays hidden everywhere:** server lists, the channel list, server counts (so a fresh install still seeds), `getServer` (so invites, ownership commands and server routes can't target it), the integrity report, and development sign-in's "join every server" (which uses the server list).

**Database-level guard (added after the security review).** Hiding the container in application code is not enough, because an older server version (a code-only rollback) knows nothing about it. Migration v5 therefore installs SQLite triggers that hold for **every** code version:

| Trigger | Effect |
| --- | --- |
| `direct_no_members_insert`, `direct_no_members_update` | No row in `server_members` can ever point at the container: inserts are silently dropped (`RAISE(IGNORE)`) so older code that "joins every server" keeps working for real servers |
| `direct_no_owner` | The container's `owner_id` can't be set |
| `direct_no_invites` | No server invite can target it |
| `direct_not_deleted` | It can't be deleted (that would cascade-delete every conversation) |

`verify` (admin CLI) also reports `directContainerMembers` and fails if it is ever non-zero.

## Privacy and authorization

- **Access** (`access.ts`). A channel in the container is authorized **only** by conversation membership, never by any server role. Non-members get `404`, the same as a channel that doesn't exist.
- **Permissions.** Members get *view, send, attach, react, pin*. Nobody gets *manage messages*. A DM where sending isn't allowed gives *view* only.
- **History boundary**, applied on the server for members added later:
  - history pages, including the `around` cursor used by jumps;
  - edits, deletions, reactions and pins of older messages (`404`);
  - replies to older messages (`invalid_reply`);
  - **reply previews**: a reply to an older message shows the parent as unavailable, both in history and in the live `message_create` frame;
  - pinned-messages lists;
  - attachment downloads (`404` for files on older messages);
  - search inside the conversation;
  - read markers (you can't mark an older message read);
  - realtime events about one message (edits, deletions, reactions, pins), which skip members whose boundary is at or after that message.
- **Unread state.** Joining sets your read marker to your boundary, so only later messages count as unread. Read states include your conversations; leaving deletes your marker.
- **Search.** Global and server-wide search cover server channels only. Inside a conversation, search covers that conversation, from your boundary on.
- **Presence and visibility.**
  - You can now see (name, avatar, profile) friends, people with a pending request either way, people you blocked, and members of your conversations, besides people who share a server with you.
  - Presence updates go to shared-server members, friends and conversation partners, **minus blocked pairs**.
  - Lists, the gateway `ready` frame and profiles show blocked pairs as offline with no custom status.
- **Rate limits.** See the server README: friend requests 10 then 1/min; other relationship actions 30 then 1 per 2 s; opening DMs and creating groups 20 then 1 per 2 s; group changes 20 then 1 per 2 s.
- **Logging.** Request logs contain ids and outcomes only, never message text or usernames typed into the friend form.

## API and gateway

The endpoints are listed in [server/README.md → Friends, blocking and conversations](../server/README.md#friends-blocking-and-conversations-milestone-10).

New gateway frames:

- `relationship_update { userId, type | null }`, to your own sessions. The blocked person receives `null`, never `blocked`.
- `conversation_update` (`ApiConversation`, each member gets their own view with their own permissions and newest visible message).
- `conversation_remove { channelId, reason: 'left' | 'removed' | 'closed' }`.

When a message reopens a closed conversation, `conversation_update` is sent **before** the `message_create`, so clients never receive a message for a conversation they don't know.

`ApiMe` gains `allowServerDms`; `ApiProfile` gains `relationship`. The protocol file is mirrored in `desktop/src/renderer/src/net/protocol.ts`.

**Compatibility:** `/api/meta` reports `apiVersion: 4` and `connections: true`. The Milestone 10 app still works against an older server: Home then says the server doesn't support friends and direct messages yet. Older apps ignore the new frames and fields.

## Desktop app

- **Home** (the logo at the top of the server column) shows a red badge with pending requests plus unread conversation messages. If you aren't in any server, Home opens automatically instead of the old "no servers" screen.
- **Friends page:** Online / All / Pending (incoming: accept or decline; outgoing: cancel) / Blocked (unblock) / **Add Friend** (exact username).
- **Conversation list:** newest activity first, unread badges, presence for DMs, member count for groups, a filter, and **×** to close a DM or leave a group.
- **Chat:** the normal chat panel, labelled `@Name` or with the group name. A read-only DM explains itself in the message box. The bell mutes a conversation (same per-PC setting as channels).
- **Members panel:** online/offline members, owner tag, *Rename group*, *Add friends* (dialog), remove (owner, on hover), *Leave group*.
- **Profiles:** the popout and full profile offer **Message**, **Add Friend** / **Accept Request** / **Cancel Request**, and in the full profile **Remove Friend** and **Block** / **Unblock**.
- **Settings → Privacy & Safety:** *Allow direct messages from server members*, the blocked list, and the encryption statement above.
- **Notifications and sounds:** a DM alerts like a mention (mention sound, notification titled with the sender's name). A group message alerts like a channel message ("Name in Group"). A new incoming friend request plays the new **Friend request** sound (Settings → Sounds; silenced by Do Not Disturb) and shows a notification while the app isn't focused. Message text stays hidden unless *Show Message Preview* is on.

## Database migration v5

Applied automatically at start-up, once (recorded in `schema_migrations`). It is purely additive:

- one new column, `users.allow_server_dms INTEGER NOT NULL DEFAULT 1`;
- six new tables with indexes;
- one `INSERT OR IGNORE` of the `@direct` container row.

Nothing is rewritten or deleted. Existing users, servers, channels, messages, attachments, read states, sessions, profiles and preferences are untouched. The tests upgrade a realistic Milestone 9 database and verify this, including SQLite `integrity_check` and `foreign_key_check`.

## Deployment procedure

**Not performed; needs your approval.** The Jetson must not be changed until you say so.

1. **Back up** the volume ([below](#backup-and-rollback)).
2. **Build and start:**
   ```bash
   cd ~/Discord2.0 && git fetch origin && git checkout milestone-10-connections && git pull
   cd server && docker compose up -d --build
   docker compose logs server | grep -iE "migrat|listening|error"
   docker compose exec server node dist/cli/admin.js verify
   curl -s http://192.168.68.65:3001/api/meta   # expect "apiVersion":4 and "connections":true
   ```
3. **Update the desktop app on both PCs.** Sign in with your existing accounts; there's nothing to re-register.
4. Run the [two-PC checklist](#two-pc-checklist).

No configuration changes are needed, and `DEV_AUTH` should stay `false`.

## Backup and rollback

**Backup** (about 10 seconds of downtime; same procedure as before):
```bash
cd ~/Discord2.0/server
docker compose stop server
docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/discord2-pre-m10-$(date +%F).tgz -C /data .
docker compose start server
```

**Rollback options:**

- **Full rollback (recommended): restore the tarball.** Anything written after the backup is lost (see [milestone-7-security.md → Backup and rollback](milestone-7-security.md#backup-and-rollback)).
- **Code-only rollback (safe since the database guard).** Older code doesn't know about the container. Before the guard existed this was a **critical exposure**, reproduced during the release review with the real Milestone 9 server against a Milestone 10 database:
  - with `DEV_AUTH=true`, Milestone 9's development sign-in joined a new user to every server **including the container**, and that user read a private DM;
  - Milestone 9's `create-admin --own-unowned-servers` claimed ownership of the container.

  With the triggers in place, the same test was repeated: the old server and old CLI still run normally, but nobody becomes a member or owner of the container, and every DM route (messages, pins, search, members) returns 404. Conversations simply disappear from an older app until you upgrade again. A code-only rollback is therefore safe; restoring the backup is still the cleanest option.
- Roll the desktop app back together with the server.

## Tests

Automated, run on the development PC:

| Suite | Result |
| --- | --- |
| Server `npm test` | **132 / 132**: 107 existing plus 25 new in `test/connections.test.ts` |
| Desktop `npm test` | **215 / 215**: 203 existing plus 12 new (`chat/conversations.test.ts`, conversation notification text in `chat/unread.test.ts`); the sound palette tests cover the new sound automatically |
| Server typecheck + build; desktop ESLint, typecheck, production build | pass |
| Prettier | all changed files pass; `desktop/README.md` has a formatting warning from Milestone 5.1, untouched |

`connections.test.ts` covers:

- **Container:** hidden from servers, channels and the integrity report; invites can't target it; `/api/meta` advertises the feature.
- **Container security (release gate):**
  - the database refuses membership, ownership, invites and deletion, including the exact statements older server versions use;
  - server owners, admins and instance administrators get no access through messages, pins, overrides (read or write), channel edit/delete, search by channel or by server, member lists, audit log, invites or channel creation;
  - development sign-in (`DEV_AUTH=true`) joins ordinary servers but never the container;
  - newcomers to a group don't learn who only wrote before they joined.
- **Friends:** request by username (case-insensitive), live updates on both sides, incoming/outgoing lists, idempotent repeats, accept, remove, decline, cancel, accepting a non-existent request, self request, one generic error for non-existent, bot and invalid usernames.
- **Simultaneous requests:** both send at once and exactly one friendship results, with no requests left over.
- **Blocking:** ends the friendship; the blocked person sees no relationship and gets the generic error; the blocker gets "unblock first"; presence masked both ways (including `ready` and profiles); unblocking doesn't restore the friendship; can't block yourself or invisible users.
- **DM eligibility:** not visible → 404; shared server with DMs allowed; DMs from server members turned off → refused; friends always allowed; unfriending makes the DM read-only (re-check on send) while history stays; re-enabling makes it writable.
- **Canonical DM:** concurrent opens give the same id and exactly one row.
- **Recipient experience:** an empty DM is hidden; the first message delivers `conversation_update` before `message_create`; the unread count is 1; closing on one device removes it from all devices; the next message reopens it; DMs can't be left.
- **Outsiders:** no access to messages, pins, sending, attachments, reactions, events, search or read states, and no realtime frames. Global search excludes DMs; search inside a DM works for members. Channel management routes refuse conversations. (Voice tokens are not issued for them either, but the test server has voice disabled, so that part rests on code review.)
- **Blocking inside an existing DM:** read-only for both, generic error, history readable, unblocking restores sending.
- **Multiple sessions:** both sessions get messages; read position syncs; logging out one session closes its socket and the other keeps receiving.
- **Groups:**
  - friends only, minimum size, can't include yourself, everyone notified;
  - adding: only the actor's friends; duplicates refused;
  - history boundary checked for history, the `around` cursor, pins, search, attachments, reactions, unpinning, replies, read markers and unread count;
  - realtime: reactions on older messages don't reach the new member; replies to older messages reach them with the parent hidden (history too);
  - nobody can edit or delete others' messages;
  - events since joining;
  - rename by any member; removal owner-only; a removed member loses access and live messages; re-adding gives a new boundary;
  - the owner leaving transfers ownership;
  - the 10-member cap, including two simultaneous adds for the last spot.
- **Persistence and migration:** relationships and conversations survive a restart, with no re-seeding. A realistic Milestone 9 database upgrades with nothing lost, idempotently: servers, channels, read states and bios intact, the new features work, integrity and foreign-key checks pass. A fresh database still seeds.

The live verification below covers the desktop UI against a real server on one PC. Not verified: two physical PCs, the packaged installer with this milestone, and the Jetson; the checklist below covers those.

## Release-gate live verification

Run on the development PC against an isolated temporary SQLite database and attachments folder (never the Jetson's data), with `DEV_AUTH=false` and real password accounts. Alice was created with the admin CLI; Bob, Charlie and Dave through real registration invites. Up to five real Electron windows ran at once (Alice, Bob, Bob's second session, Charlie, Dave), each with its own profile, driven with Playwright.

| Area | Verified live |
| --- | --- |
| Friends | Request by username; Bob's Home badge, Pending entry and **one** friend-request sound arrive live; accept updates both windows (with an "accepted" toast); cancel, decline and remove propagate live; friends survive a backend restart and an app restart (saved session) |
| Sounds | Friend-request sound: plays once when enabled, never on Do Not Disturb, never when switched off in Settings → Sounds |
| Blocking | Existing DM becomes read-only in both windows with a neutral message; history stays; the blocked person sees the blocker offline with no custom status, loses the friendship, and gets the **same** message for a request to the blocker as for a nonexistent username; nothing in their UI mentions blocking. A block also stops a brand-new DM and request. Unblocking (Settings → Privacy & Safety) restores sending and presence live |
| DMs | Opened from Friends; header `@Bob`; live delivery with unread badge and Home badge; reply and jump-to highlight; edit with "(edited)" (the quoted reply preview updates too); reactions; pins ("Pinned in @Alice"); image preview; search limited to the DM; delete; close (synced to the second session) and reopen on the next message; read on one session clears the other; history after backend restart; **no duplicates** after reconnect |
| Groups | Creation dialog (focus trapped, needs 2 friends), live appearance for members, unread badge and notification "Bob in Weekend plans" (text hidden by default), rename by a non-owner, member list, adding via dialog, owner-only removal (UI and API), removed member gets a toast and **no further frames**, leaving, ownership transfer, the 10-member cap (`group_full`, "Add friends" disabled) |
| History privacy | A member added later sees 0 earlier messages and gets nothing for: history (default, `around`, `before`, `after`), pins, search (group and global), reply to an old message, react/unreact, pin/unpin, edit, delete, attachment download, marking an old message read; unread starts at 0; membership events start at their join. Edits, reactions and unpins of the old message produce **no** WebSocket frames for them; a reply to it arrives with the parent hidden ("Original message was deleted") in both the frame and the UI |
| Regression | Server-channel messaging, headers and search scopes unchanged; no renderer errors besides the expected reconnect messages while the server was down |

UI defects found and fixed during the review: the conversation-close and group-member-remove buttons couldn't be clicked with the mouse (the shared pressed style moved them out from under the pointer); long group names drew over the chat-header buttons; the group-name field in the create dialog was narrow and centred; the Home search box didn't fill the sidebar; group members weren't sorted by name; the search author filter in a conversation listed everyone you know instead of the members.

Observed once and not reproduced: one renderer crash of Alice's window during the first backend restart. With heap and crash monitoring, three more restarts showed a stable 11 MB heap, clean reconnects and no errors.

Not testable here: voice and screen sharing (no LiveKit on the temporary server, so voice requests return 503). Their code is unchanged by this milestone. By code review, conversation channels are text channels and voice joins require a voice channel, so they are refused; this was not exercised against a live LiveKit.

## Architecture assessment: the hidden container

Storing conversations as channels of a reserved `@direct` server row lets every Messaging 2.0 feature work unchanged, and the live review confirmed that. Its risk is that anything treating "a row in `servers`" as "a server" could expose conversations. That risk is now contained at three levels:

1. **Authorization:** a channel in the container is authorized only by conversation membership; no server role, override or ownership is consulted, even if a membership row existed.
2. **Application filters:** listings, counts, `getServer`, the integrity report and invites exclude it.
3. **Database guard:** triggers make membership, ownership, invites and deletion impossible for any code version (verified against Milestone 9 code).

Recommendation: acceptable for this project. The cleaner long-term alternative is to make `channels.server_id` nullable (or add a separate `conversation_messages` table), so conversations aren't attached to a server row at all. That needs a table rebuild in SQLite (`channels` is referenced by messages, attachments, pins, reactions, read states and search), a migration that copies data, and changes to every channel query. Consider it only if a PostgreSQL move or a larger schema refactor happens anyway; until then, keep the triggers and the `verify` check.

## Two-PC checklist

Use two Windows PCs (A = `thereallsaint`, B = `lsaint06`) after deployment.

1. **Home:** both PCs show the logo as Home; Friends opens with empty lists.
2. **Request:** A → Add Friend → `lsaint06`. B hears the friend-request sound, sees a badge on Home and the request under Pending. Accept. Both see each other under All/Online.
3. **Message:** A clicks **Message** on B. B sees the conversation appear with the first message, an unread badge and a notification titled with A's name.
4. **Messaging 2.0 in a DM:** attachments (image + file), edit, delete, reply, reaction, pin, search inside the DM, unread marker, Ctrl+F. Each change appears on the other PC.
5. **Close:** B closes the DM (×). A sends again; it reappears on B.
6. **Privacy:** B turns off *Allow direct messages from server members*. A removes B as a friend. A's message box says it can't send; history is still there. Re-add the friend; sending works again. Turn the setting back on.
7. **Block:** B blocks A from A's full profile. A sees B as offline; A's friend request to `lsaint06` fails with the generic message; the DM is read-only on both PCs. Unblock in Settings → Privacy & Safety.
8. **Group** (with a third account if available): create a group from friends, rename it, add someone later, and confirm they see only new messages and that a reply to an old message shows "Original message was deleted" (the app's wording for any parent you can't see). The owner removes someone; they lose the conversation at once. The owner leaves; ownership moves.
9. **Restart:** restart the server container. Both apps reconnect; friends, conversations, unread state and history are intact.
10. **Regression:** server channels, voice, and screen sharing behave as before; notifications and sounds for channels are unchanged.

## Known limitations

- **No end-to-end encryption** (see the top of this file).
- **No voice or video calls in DMs or groups.** Conversations are text channels; voice refuses them.
- **No "message requests" inbox:** DMs from server members arrive directly, or are refused if you turn that off.
- **Blocking doesn't hide a blocked person's messages** in shared servers or groups, and doesn't remove anyone from them.
- **Global and server search don't include conversations;** search from inside a conversation instead.
- **Muting a conversation is per PC** (same as channel mutes); closing a conversation syncs across your devices.
- **Legacy identity merges** (`merge-identity` from Milestone 7) don't move conversation memberships. That only matters for development identities, which can't sign in with `DEV_AUTH=false`.
- **Older desktop apps** (Milestone 9 and earlier) connected to a Milestone 10 server can't show conversations. They still receive DM messages they are entitled to, so they may play a sound or show a notification titled "#unknown". Update every PC together with the server.
- A reply to a message from before you joined says "Original message was deleted", the same wording as a real deletion.
- Not yet verified on two PCs, in the packaged installer, or on the Jetson.
