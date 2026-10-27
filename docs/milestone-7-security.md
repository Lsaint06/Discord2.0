# Milestone 7 — Accounts, sessions, permissions and security ("Project Gateway")

This milestone replaces development identities with **real accounts** as the foundation for inviting friends from outside the LAN. It adds invite-only registration, Argon2id passwords, server-managed sessions, roles and permissions enforced by the backend, server invitations, moderation, a security event log, protected credential storage in the desktop app, and a safe path to move existing development identities (and their history) to real accounts.

**Nothing has been deployed.** The Jetson still runs Milestone 6. Remote access is only proposed: see [remote-access-options.md](remote-access-options.md).

## Contents

1. [Architecture](#architecture)
2. [Threat model and trust boundaries](#threat-model-and-trust-boundaries)
3. [Authentication flow](#authentication-flow)
4. [Session model](#session-model)
5. [Password handling](#password-handling)
6. [Account recovery](#account-recovery)
7. [Legacy identity migration](#legacy-identity-migration)
8. [Roles and permissions](#roles-and-permissions)
9. [Invitations](#invitations)
10. [LiveKit (voice and screen sharing)](#livekit-voice-and-screen-sharing)
11. [Backend hardening](#backend-hardening)
12. [Desktop app security](#desktop-app-security)
13. [Database migration v3](#database-migration-v3)
14. [Configuration](#configuration)
15. [Jetson ARM64 compatibility](#jetson-arm64-compatibility)
16. [LAN migration procedure](#lan-migration-procedure)
17. [Backup and rollback](#backup-and-rollback)
18. [Security test results](#security-test-results)
19. [Two-PC test checklist](#two-pc-test-checklist)
20. [Known limitations](#known-limitations)

## Architecture

```
Desktop (Electron, sandboxed renderer)          Backend (Fastify, SQLite)                         LiveKit SFU
──────────────────────────────────────          ─────────────────────────                         ───────────
main: safeStorage (DPAPI) ◀─IPC─ renderer       auth/      Argon2id, sessions, secrets, reauth    rooms per voice channel
   session.bin (encrypted token)                access.ts  membership + roles + overrides ──────▶ grants (Connect/Speak/Stream)
renderer: Bearer token in memory ─HTTPS/WS──▶   realtime.ts scoped fan-out (channel viewers)      webhooks ──▶ join check
                                                routes/    auth, admin, servers, members,          RoomService ◀── kick / narrow
                                                           invites, messages, attachments, voice   permissions on change
                                                audit.ts   security event log (audit_events)
                                                cli/admin.ts local bootstrap & migration tools
```

- Every request resolves its session in `auth/sessions.ts` (`requireAuth` / `requireUser`). The user id **always** comes from the session, never from the request.
- Every authorization decision goes through `access.ts`, using the pure rules in `lib/permissions.ts`. This covers REST routes, gateway fan-out, attachment downloads and LiveKit token grants. Hiding UI controls is never the security boundary.
- Realtime events go only to the people who can see them (`realtime.ts`). Before this milestone, every event was broadcast to every connected user.

## Threat model and trust boundaries

| Actor | Can | Must not be able to |
| --- | --- | --- |
| Anyone who can reach the server (LAN today; internet if Option B is ever chosen) | Load `/api/meta`, try to sign in, register **with a valid invitation code**, use recovery with a valid code | Create accounts without an invitation, enumerate usernames, guess codes or passwords at scale, exhaust CPU, memory or disk |
| Signed-in member | Read and write where their role allows; join voice where allowed | See other servers or hidden channels (even by guessing ids), edit others' messages, escalate their role, keep access after being kicked or banned |
| Moderator / admin | Moderate below their own role | Seize ownership, act on equal or higher roles, grant permissions they don't have |
| Server owner | Everything in their server | Affect other servers; lock themselves out (they can't leave without transferring) |
| Instance administrator | Issue registration, claim and reset codes; disable accounts; read the security log | Silently take over servers (only the local CLI can assign ownership, and it is audited) |
| Someone with shell access to the Jetson | Everything (CLI, database) | — this is the root of trust |
| Malware on a friend's PC running as their Windows user | Read their DPAPI-protected token | — out of scope; see limitations |

**Trust boundaries:**
1. Network → backend: authentication, validation, rate limits.
2. Backend → LiveKit: the server signs short-lived JWTs; LiveKit webhooks are verified with HMAC.
3. Renderer → Electron main: a narrow IPC bridge; the renderer is sandboxed.
4. Local shell → database: the administration CLI.

## Authentication flow

1. **Registration** (`POST /api/auth/register`): the invitation code is checked first, so only code holders learn whether a username is taken.
   - A **registration** code creates a new account; if the code names a server, the account joins it.
   - A **claim** code attaches a password to one specific existing development identity, keeping its user id. The client can't choose which identity (see [migration](#legacy-identity-migration)).
   - The server returns a session plus **10 recovery codes**, shown once.
2. **Sign-in** (`POST /api/auth/login`): Argon2id verification. Unknown users and wrong passwords get the same `401 Incorrect username or password.` with equalized timing, because a dummy hash is verified for unknown accounts. Disabled accounts are reported only after a correct password.
3. **Development sign-in** (`POST /api/dev/login`) exists only while `DEV_AUTH=true`, and **never** works for an account that has a password. The client never falls back to it automatically; the user has to pick "Use a development identity" explicitly.
4. **Re-authentication:** sensitive operations need the current password in the request:
   - password change and recovery-code regeneration;
   - ownership transfer;
   - issuing registration, claim and reset codes;
   - disabling accounts.

## Session model

| Property | Implementation |
| --- | --- |
| Token | 256-bit `crypto.randomBytes` (43-char base64url), always generated by the server at sign-in. No client-chosen tokens, so no session fixation. |
| Storage (server) | Only the SHA-256 of the token, plus a public session id for "Devices". |
| Expiry | Idle timeout `SESSION_IDLE_DAYS` (default 30) and absolute lifetime `SESSION_MAX_DAYS` (default 90). After that, sign in again. `last_used_at` is written at most once a minute. |
| Revocation | Sign out (one session), sign out other devices, sign out everywhere, password change (other sessions), password reset (all), account disabled (all), identity claimed (its dev sessions). |
| Live connections | Gateway sockets record their session id. Revocation closes them immediately (close code 4001). Every 5 minutes the server re-validates open sockets and closes them at absolute expiry. |
| Development sessions | Marked `kind='dev'`. All of them stop working the moment `DEV_AUTH` is turned off. |
| Transport | `Authorization: Bearer` header only; gateway identify happens in the first WebSocket frame. Tokens and codes never appear in URLs, so they can't end up in logs. No cookies are used, so there is no CSRF surface. |
| Renewal | Sliding idle window inside a fixed absolute lifetime. Tokens are not rotated mid-session (that would race between concurrent requests and multiple windows); the absolute lifetime bounds exposure. |

## Password handling

- **Algorithm:** Argon2id from Node.js's built-in `crypto.argon2` (OpenSSL 3.5). No native add-on, so the same code runs on Windows x64 and Linux ARM64, and **no custom cryptography** is involved. Only the standard PHC string encoding is written in this repository.
- **Parameters:**
  - Default m = 64 MiB, t = 3, p = 4 (RFC 9106's second recommended option), well above the OWASP minimum of m = 19 MiB, t = 2, p = 1.
  - Configurable through `ARGON2_*`. Values below the OWASP minimum are refused at startup.
  - Hashes are upgraded on the next sign-in when parameters change (`needsRehash`).
- **Salts:** 16 random bytes per hash; 32-byte tag; constant-time comparison (`timingSafeEqual`).
- **Denial of service:**
  - At most `ARGON2_MAX_CONCURRENT` (default 2) hashes run at once, with a queue of 32 behind them; beyond that the server answers `503 busy`.
  - Password length is capped at 256 characters.
  - The request body limit is 16 KB.
  - Stored hashes with absurd parameters are refused.
- **Policy (NIST SP 800-63B style):**
  - At least 12 characters; long passphrases and password managers are welcome.
  - No composition rules and no forced rotation.
  - Rejects common, repetitive and sequential passwords and ones based on the username (from a local blocklist; nothing leaves the Jetson).
  - Unicode is normalized with NFC.
- **Never logged:** request bodies aren't logged. The logger additionally redacts `password`, `token`, `code` and `authorization` fields, and the audit log drops any detail key that looks like a secret.
- **Credential stuffing / guessing:**
  - Per IP: 10 attempts, then one every 10 s.
  - Per attempted username, existing or not: 5 attempts, then one per minute.
  - Registration and recovery have their own per-IP limits; recovery also has a per-account limit.

**Benchmark on the development PC** (Ryzen 9 3950X, Node 24.22, OpenSSL 3.5.9, `npm run bench:argon2`):

| m (KiB) | t | p | median per hash |
| --- | --- | --- | --- |
| 19 456 | 2 | 1 | 25 ms |
| 47 104 | 1 | 1 | 35 ms |
| 65 536 | 3 | 1 | 126 ms |
| **65 536** | **3** | **4** | **52 ms** (default) |

10 simultaneous sign-ins at the default settings took 355 ms in total. **Jetson numbers are not measured yet.** Run `docker compose exec server node dist/cli/bench-argon2.js` after deploying. If the default takes more than about 500 ms there, set `ARGON2_PARALLELISM`/`ARGON2_PASSES`, keeping at least the OWASP minimum. Each concurrent hash uses `ARGON2_MEMORY_KIB` of RAM (2 × 64 MiB by default).

## Account recovery

There is no email on the Jetson, so recovery uses codes, never security questions:

1. **Recovery codes:** 10 single-use codes (80 bits each, stored as SHA-256) shown once at registration and regenerable in Settings → Security (with password).
2. **Administrator reset codes:** an instance administrator issues a 24-hour, single-use code (100 bits) bound to one account, and hands it over in person or by direct message. Earlier reset codes for that account become invalid. A reset code only works for the account it was issued for.

Either way, "Forgot your password?" takes the username, the code and a new password, then **revokes every existing session** of the account and disconnects it from voice. Errors are generic: the password rules are checked before the account lookup, so the response doesn't reveal whether the username exists.

## Legacy identity migration

Existing data belongs to development identities: messages, attachments, reactions, pins, read states, voice history. **Nothing is moved or rewritten by the migration itself.** Each identity keeps its user id; it just has no password yet. A client-supplied username or id is never accepted as proof of ownership.

**Claiming (recommended; keeps the user id):**
1. The administrator lists identities: Settings → Administration, or `admin legacy list`, which shows message, file and reaction counts and when each was last seen.
2. The administrator issues a **claim code** for one identity (`admin legacy claim-code <username>` or the button), re-entering their password. Issuing a new code revokes the previous one, and there is at most one open claim code per identity (a database constraint).
3. The administrator gives the code **privately to the person who used that identity**. That person verifying their identity out of band is the actual security step.
4. They choose "Create an account", enter the code, see "This code claims @name", and set a password. The username comes from the code, not the request.
5. In the same transaction:
   - the password is attached and the code marked used;
   - **all development sessions of that identity are revoked**; their sockets are closed and any voice connection is dropped.
   From then on development sign-in is refused for that username.

**Conflicts:**
- A claimed identity can't be claimed again: the `credentials` primary key, plus a check in the transaction.
- Codes are single use, enforced atomically with `UPDATE … WHERE used_at IS NULL`.
- An ordinary registration code can't take an existing username (`409 username_taken`).

**Merging (fallback, for someone who already registered a new account):** `admin legacy merge <legacyUsername> <accountUsername>` prints a **dry-run report** (counts of messages, attachments, reactions and duplicates, pins, read states, memberships, owned servers, sessions). With `--apply` it moves everything in one transaction:
- authorship and uploads;
- reactions, de-duplicated;
- read state (the furthest position wins);
- memberships (the higher role wins) and ownership.

It then deletes the empty legacy identity. Merging into an identity that has a password is refused.

**Verification:** `admin verify` prints counts, servers without an owner, orphaned rows, `PRAGMA foreign_key_check` and `PRAGMA integrity_check`. It exits with code 1 if anything is wrong.

## Roles and permissions

Four fixed roles per server: **Owner > Administrator > Moderator > Member**. Permission bits (shared in `protocol.ts`), with the defaults each role gets:

| Permission | Member | Moderator | Admin | Owner |
| --- | :-: | :-: | :-: | :-: |
| View channels, send messages, attach files, add reactions | ✓ | ✓ | ✓ | ✓ |
| Connect to voice, speak, stream | ✓ | ✓ | ✓ | ✓ |
| Pin messages, manage messages (delete others'), create invites, kick | | ✓ | ✓ | ✓ |
| Manage channels, manage invites, ban, manage roles, manage server | | | ✓ | ✓ |

**Rules:**
- **Owner:** always has every permission. Ownership changes only by transfer (owner + password) or the local CLI. The owner can't leave without transferring, so there are no ownerless servers.
- **Role configuration:** owners and admins can change a role's permissions per server. Only roles **below** their own, and only with permissions they hold themselves (no escalation). "Reset to defaults" is available.
- **Channel overrides:** allow/deny per role per channel, deny first. They cover view, send, attach, react, pin, manage messages, connect, speak and stream. Without View Channel, a member can do nothing in that channel and doesn't receive its events. Use this for a private staff channel.
- **Role changes, kicks and bans:** only on members **strictly below** you. Never on the owner, and never yourself. Banned users can't rejoin through any invitation.
- **Editing:** only the author can edit their message; nobody rewrites someone else's. Deleting someone else's message needs Manage Messages and is audited (`message.moderator_delete`).
- **Not a member?** Every resource in that server returns **404** (no probing by id). A member without the needed permission gets **403**.
- **Change from Milestone 6:** pinning now needs Pin Messages, so members can't pin by default.

## Invitations

| Kind | Who creates it | Secret | Limits |
| --- | --- | --- | --- |
| Registration | Instance administrator (password re-entry) or CLI | 20 chars, Crockford base32, 100 bits | Single use, 1 h–14 d (default 72 h), revocable; optionally joins a server |
| Claim | Same | 100 bits | Single use; one open code per identity |
| Server invite | Anyone with Create Invites (moderators by default) | 16 chars, 80 bits | Always expires (1 h–30 d), optional max uses (1–100), revocable by its creator or Manage Invites |
| Admin reset | Instance administrator | 100 bits | Single use, 24 h, one account |

- **Shown once:** codes are only shown when created. Only a purpose-separated SHA-256 verifier is stored.
- **POST bodies only:** codes are sent in request bodies (`/api/invites/preview`, `/api/invites/accept`), never in URLs.
- **Atomic usage limit:** the use count is incremented with the limit in the `WHERE` clause inside the same transaction that adds the membership. Five concurrent joins on a 2-use invite produce exactly 2 members (tested).
- **Preview first:** the join dialog shows the server name and member count before joining. It requires sign-in.
- **Leaving and removal:** members can leave. Moderators can kick and admins can ban; the removed user gets `server_remove` and loses voice immediately.

## LiveKit (voice and screen sharing)

- **Token requirements:** `POST /api/voice/channels/:id/token` needs a valid, non-revoked session. The participant identity is always the session's user id; request bodies are rejected.
- **Grant contents:** the grant is narrowed by channel permissions:
  - *Connect* is required;
  - *Speak* allows the microphone;
  - *Stream* allows screen share and screen audio;
  - subscribe is always allowed; data channels never are.
- **Unchanged:** codec, simulcast and encoder settings, and the LiveKit server configuration, are the same as before. Stream quality is unaffected.
- **Revocation**, defence in depth:
  1. Kick, ban, channel deletion or a permission change triggers `enforceVoiceAccess`. It removes participants who lost access, using `RoomService.removeParticipant` with `revokeTokenTs = now`; servers without support ignore that field. It narrows publish rights through `updateParticipant`, **only for people whose voice permissions actually changed**, so other people's streams aren't disturbed.
  2. Every `participant_joined` webhook, and the 30-second reconciliation, re-checks authorization and removes anyone not allowed. This covers someone reconnecting with a still-valid 5-minute token.
  3. Sign out everywhere, password reset, account disabled and identity claimed disconnect the user from voice.
- **Single-session sign-out:** the client leaves voice itself. LiveKit identity is per user, not per device.
- **Voice presence:** visible only in channels the viewer can see. Someone moving into a hidden channel appears to others as having left voice.

## Backend hardening

| Area | Status |
| --- | --- |
| Request validation | JSON schemas everywhere. Unknown fields are **rejected** (a forged `userId` gets `400`; Milestone 6 silently stripped them) and types are never coerced. Body limit 16 KB; WebSocket frames 4 KB. |
| Rate limits | Per-IP: API, gateway, sign-in, registration, recovery. Per-account: sign-in, recovery. Per-user: messages, edits, reactions, pins, uploads, search, read acks, invites, joins, moderation, account and admin actions, voice tokens. |
| SQL | Bound parameters only. Search terms are quoted before FTS5. |
| Origins / CORS | Allow-list for REST and WebSocket upgrades. Bearer tokens only (`credentials: false`), no cookies. |
| Attachments | Unchanged from Milestone 6 (allowlist, magic bytes, quotas, CSP `sandbox`, no tokens in URLs). Downloads now require membership and View Channel. Pending uploads stay visible only to the uploader. |
| Errors and logs | Generic messages for authentication. Logger redaction. Request logs contain method, URL and status, never headers or bodies. A `Referrer-Policy: no-referrer` header was added. |
| Security event log | `audit_events` table plus a log line for sign-in (success and failure), sign-out, sessions, password and recovery events, registration and claims, administration actions, and moderation (kick, ban, roles, channels, overrides, invites, moderator deletes). Instance administrators see it with IPs; server admins see their server's events without IPs. Kept for 365 days. |
| Cleanup | Hourly: expired or revoked sessions and used or expired reset codes older than 30 days are deleted; audit events older than 365 days; abandoned uploads (Milestone 6). |
| Resource exhaustion | The Argon2 concurrency gate. Upload quotas and the free-disk check (Milestone 6). Channel cap of 100 per server. Invite and use limits. |

## Desktop app security

- **Token storage:** the session token is kept by the **main process**, encrypted with Electron `safeStorage` (Windows DPAPI, bound to the Windows user), in `session.bin` in the profile folder. It is **no longer in `localStorage`**; an old Milestone 6 entry is moved on first start and then deleted. If the OS can't encrypt (e.g. Linux without a keyring), the token is held in memory only and the user signs in again after a restart. Settings → Security says which applies.
- **Renderer sandbox:** `sandbox: true`, `contextIsolation`, no Node integration. The generic `@electron-toolkit/preload` bridge was removed (it gave the renderer raw `ipcRenderer.send/invoke/on`), along with the leftover `Versions` component and the unused `ping` IPC. The only bridge left is the typed `window.d2`, and its handlers check the sender's origin.
- **Unchanged from Milestone 6:** the navigation guards (only http/https links open externally) and the CSP (`connect-src` is limited to the configured server; images only from self, data: and blob:).
- **Version checks and sign-in:** the app refuses to sign in against a server without account support and never falls back to development sign-in.
- **UI follows permissions** (the server still enforces everything):
  - the composer is disabled without Send Messages, and uploads without Attach Files;
  - the Pin and moderator Delete menu items appear only for roles that have them;
  - voice join needs Connect and Go Live needs Stream; without Speak the microphone is forced off.

## Database migration v3

`accounts_and_permissions` is forward-only and **additive**:
- **Existing tables:** two columns each on `users` (`instance_admin`, `disabled_at`) and `sessions` (`id`, `kind`, `expires_at`, `revoked_at`, `device`, `created_ip`, `last_ip`).
- **New tables:** `credentials`, `registration_invites`, `recovery_codes`, `password_resets`, `server_members`, `server_bans`, `server_role_permissions`, `channel_overrides`, `server_invites`, `audit_events`.
- **Indexes and constraints:**
  - unique session id;
  - one open claim code per identity;
  - **exactly one owner per server** (partial unique index);
  - `allow & deny = 0`;
  - `uses ≤ max_uses`.
- **Backfill:** every existing non-bot user becomes a **member of every existing server** (the access they have today). Servers that had an `owner_id` keep that owner. Existing development sessions get an id and expire 30 days after the upgrade.
- **Execution:** it runs once inside a transaction (all or nothing) and is recorded in `schema_migrations`; running `migrate` again is a no-op (tested).

**Backward compatibility:**
- A **Milestone 6 server can run on a migrated database.** No existing column changed meaning and the new tables are ignored (tested: M6-style inserts and queries still work).
- What you lose by rolling back: accounts, permissions and invitations are ignored, and development sign-in works for every username again, including ones that were claimed.
- **For a full rollback, restore the pre-upgrade backup.**

## Configuration

`server/.env` (all optional; defaults shown in `.env.example`):

```dotenv
DEV_AUTH=true                # set to false once everyone has claimed or created an account
SESSION_IDLE_DAYS=30
SESSION_MAX_DAYS=90
ARGON2_MEMORY_KIB=65536
ARGON2_PASSES=3
ARGON2_PARALLELISM=4
ARGON2_MAX_CONCURRENT=2
```

`docker-compose.yml` passes these through (empty = default). No new services, ports or volumes. The desktop app needs no new settings.

## Jetson ARM64 compatibility

- **No new native dependencies.** Argon2id comes from Node's built-in OpenSSL; SQLite from `node:sqlite`. The only change to the server's dependencies is the `engines` field, now `node >= 24.7` (needed for `crypto.argon2`). The Docker image `node:24-bookworm-slim` satisfies it, and the backend checks at startup with a clear error.
- **Desktop:** `@electron-toolkit/preload` was **removed**.
- **Memory:** Argon2 uses up to 128 MiB at the default concurrency of 2, on top of the usual footprint.
- **Not yet done on the Jetson:** an ARM64 image build and Argon2 timing. Run the commands in the next section.

## LAN migration procedure

**Not performed; needs your approval.** Run it in this order:

1. **Back up** (see below). Keep the copy off the Jetson.
2. **Deploy:**
   ```bash
   cd ~/Discord2.0 && git fetch origin && git checkout milestone-7-gateway && git pull
   cd server && docker compose up -d --build
   docker compose logs server | grep -iE "migrat|listening|No password accounts|development identities"
   docker compose exec server node dist/cli/admin.js verify
   docker compose exec server node dist/cli/bench-argon2.js
   ```
3. **Make yourself the administrator, keeping your history.** Use your existing development username: it becomes a password account with the same user id. `--own-unowned-servers` makes you owner of the seeded servers, which had no owner.
   ```bash
   docker compose exec server node dist/cli/admin.js create-admin --username <your-dev-username> --own-unowned-servers
   ```
   It prompts for a password (hidden) and prints your recovery codes once.
4. **Update the desktop app** on each PC to `milestone-7-gateway`. Sign in with your password.
5. **Move each friend to a real account.** Settings → Administration → *Development identities to migrate* → **Claim code** (or `admin legacy claim-code <username>`). Give each code privately to the right person. They use *Create an account* → code → password.
6. **Brand-new friends:** use *Create Registration Code* (optionally joining a server).
7. **Check:** `admin legacy list` shows no remaining identities and `admin verify` is OK.
8. **Turn off `DEV_AUTH`** (`DEV_AUTH=false` in `server/.env`, then `docker compose up -d`). All remaining development sessions stop working. Do this **before** any remote access.

During the transition (`DEV_AUTH=true`), unclaimed identities can still be used by anyone on the LAN, exactly as today. Claimed identities and password accounts are protected.

## Backup and rollback

**Consistent backup** of the database and attachments together, with about 10 s of downtime:

```bash
cd ~/Discord2.0/server
docker compose stop server
docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/discord2-pre-m7-$(date +%F).tgz -C /data .
docker compose start server
```

This captures `discord2.db` (including WAL files) and `/data/attachments` in one consistent snapshot. Online database-only snapshot: `VACUUM INTO` (see [messaging-2-jetson.md](messaging-2-jetson.md#backup-and-restore)).

**Rollback options:**
- **Code only.** Check out `milestone-6-messaging` and run `docker compose up -d --build`. The M6 server runs on the migrated database, but **all** users fall back to development sign-in; passwords, permissions and invitations are ignored, not deleted. Messages and files written under M7 remain.
- **Full rollback.** Stop the server and restore the pre-upgrade backup:
  ```bash
  docker compose stop server
  docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine \
    sh -c "rm -rf /data/* && tar xzf /backup/discord2-pre-m7-YYYY-MM-DD.tgz -C /data && chown -R 1000:1000 /data"
  git checkout milestone-6-messaging && docker compose up -d --build
  ```
  Anything written after the backup is lost.
- **Desktop.** M7 desktop apps refuse to sign in to an M6 server ("older than the app"). Roll the desktop back together with the server.

## Security test results

**Automated, on the development PC.**

**Server: `npm test` → 84 / 84 pass.** That is 45 from earlier milestones, adjusted only where M7 intentionally changes behaviour (pinning needs moderator, non-members get 404, the migration list includes v3), plus 39 new in `test/accounts.test.ts`:
- **Hashing and codes:** Argon2id PHC format, unique salts, verification, rehash detection, refusal of weak or absurd parameters, password policy, code alphabet and normalization.
- **Permission model:** defaults, owner, overrides, hierarchy, no escalation.
- **Registration:**
  - an invitation is required, and codes are single use;
  - expired, revoked and duplicate cases;
  - weak passwords are refused;
  - creating invitations needs an admin password session and password re-entry.
- **Sign-in:**
  - identical generic errors for unknown users and wrong passwords;
  - per-account throttling;
  - fresh server-generated tokens (no fixation);
  - expired, idle, revoked and malformed tokens are refused.
- **Sessions:**
  - logout closes the gateway socket and replay fails;
  - device list and single-device revoke (scoped to your own sessions);
  - sign out everywhere;
  - password change revokes other sessions.
- **Recovery and accounts:**
  - recovery codes are single use, revoke all sessions, and don't leak whether an account exists;
  - admin reset codes are single use and bound to their account;
  - disabled accounts are refused.
- **Development mode:** dev sign-in is never possible for password accounts, and dev sessions die when `DEV_AUTH` is off.
- **Limits and validation:** registration rate limit, oversized bodies (413), forged unknown fields (400), and accounts and sessions survive a restart.
- **Authorization:**
  - non-members get 404 for history, posting, members, voice tokens and search;
  - messages are delivered only to people who can see them;
  - cross-user edits are denied;
  - moderator deletes work and are audited;
  - channel overrides hide history, events, attachments and search results;
  - role escalation is impossible (self, owner, equal rank, ungranted bits, unknown bits, "owner" role);
  - the owner can't leave, and ownership transfer needs a password;
  - invites: permission, preview, codes not stored or relisted, **an atomic usage limit under 5 concurrent joins**, revocation and malformed codes;
  - kick and ban remove access immediately, bans block rejoining, unban works;
  - LiveKit grants follow Connect/Speak/Stream and use the authenticated identity, ignoring forged identity fields;
  - unauthorized participants are refused and kicked members are removed from voice;
  - sign out everywhere ends voice;
  - unauthorized WebSocket use is closed;
  - the user list is limited to shared servers.
- **Migration and legacy:**
  - a claim code binds to exactly one identity, keeps its id, messages and reactions, and revokes dev sessions;
  - re-issuing a code revokes the old one, and registration codes can't claim;
  - merge works, dry run first;
  - a **realistic Milestone 6 database** (dev users, bot, messages, a reply with edit, attachment, reaction, pin, read state, legacy session) upgrades with no data loss and keeps the old session working;
  - a repeated migration is a no-op;
  - members keep access, the existing owner is kept, integrity checks are OK, and an M6 server can still write to it.

**Desktop: `npm test` → 124 / 124 pass** (120 earlier + 4 new): permission helpers, every permission bit described exactly once, moving a legacy `localStorage` session into protected storage, and clearing on sign-out. Typecheck, ESLint (React Compiler rules), Prettier and the production build all pass. The server typechecks and builds.

**Live multi-client run on this PC.** Real Electron windows, local backend, fresh database, administrator provisioned with the CLI. **15 / 15 steps passed:**
1. The administrator signs in with a password.
2. Generic error for a wrong password and for an unknown user.
3. Registration and claim codes are issued with password re-entry.
4. A new user registers with an invitation and gets recovery codes; the code can't be reused.
5. Real-time messages flow both ways.
6. A member has no Pin item; the owner has Pin and moderator Delete.
7. A channel hidden from members disappears live.
8. A legacy identity is claimed in the UI, keeps its old message, its dev token is revoked and dev sign-in is refused.
9. `session.bin` exists, is encrypted, and the session survives an app restart.
10. Settings → Devices and Security work.
11. Server Settings: members, roles matrix, channel permissions, and a kick (the kicked user sees "You were removed from The Hangout" and a "Join or create a server" screen).
12. Administration lists accounts and the security log.
13. Sign-out revokes the server session and deletes `session.bin`.
14. Development sign-in is refused for a password account.

**Found and fixed during this work:**
- **Broadcast leak.** Every realtime event (messages, edits, reactions, pins, voice, profiles, server creation) went to all connected users; it is now scoped.
- **Plaintext token in `localStorage`**; it is now encrypted in the main process.
- **Generic IPC bridge exposed to the renderer**, with the sandbox off; both fixed.
- **Sessions never expired**, and revocation didn't close live sockets; both fixed.
- **Unknown request fields were silently stripped**; they are now rejected.
- **`/api/users` listed every user**; it is now limited to people who share a server.
- **Kicked users kept voice**, and grants ignored permissions; both fixed.
- **A message race** (pre-existing). Messages sent between the REST history load and the gateway being ready were missed. The client now resynchronizes on the first ready, not only on reconnects.
- **Username enumeration** through the recovery endpoint, found during development and fixed before tests.
- **No owner on a fresh install:** `create-admin --own-unowned-servers` now seeds a fresh database first, so the administrator owns the starter servers.
- **Accessibility:** the registration username field's accessible name included its hint text.

**Requires a real two-PC test (not done):** everything in the next section, plus anything on the Jetson (ARM64 build, Argon2 timing, migration of the real database), voice and 1440p streaming with accounts, and any remote transport.

## Two-PC test checklist

Not executed. After backing up and deploying to the Jetson:

1. Create the first administrator with the CLI, claiming your own development identity (`create-admin --username <you> --own-unowned-servers`). Sign in on PC 1.
2. Settings → Administration: issue a registration code that joins *The Hangout*. On PC 2, *Create an account* with it and save the recovery codes.
3. Both PCs signed in (accounts, not dev identities). Settings → Devices shows "this device".
4. Send messages both ways; @mention; edit and delete your own.
5. Upload and download an image and a PDF; the lightbox works.
6. Reply, react (PC 2 has no Pin option as a member; PC 1 can pin).
7. PC 1: Server Settings → Channels → *memes* → Members: View *Deny*. PC 2 loses #memes immediately; promote PC 2 to Moderator and it reappears.
8. PC 1: kick PC 2. PC 2 is told, loses the server, and API requests to it fail (404). Re-invite with Invite People, PC 2 joins; ban and unban.
9. Both join *Lounge* and hear each other; channel override Speak: Deny for Members makes PC 2's microphone stop.
10. PC 2 goes live at 1440p60; PC 1 watches. Check fps and quality against Milestone 5.1. Kicking PC 2 ends its stream and voice within seconds.
11. PC 2: Settings → Sign Out. PC 2's gateway closes; Settings → Devices on PC 1 (signed in as PC 2's account elsewhere, if any) no longer lists it.
12. `docker compose restart server`: both PCs reconnect without signing in; accounts and history are intact.
13. Legacy migration: `admin legacy list`, issue a claim code for a friend's identity, claim it on a PC, and confirm their old messages show as theirs and the old dev sign-in is refused.
14. Unauthorized access: `curl http://192.168.68.65:3001/api/channels/hangout-general/messages` (no token) → 401; another server's channel id with PC 2's token → 404.
15. Remote transport: only after separately approving an option in [remote-access-options.md](remote-access-options.md).

## Known limitations

- **Development sign-in during the transition.** While `DEV_AUTH=true`, any unclaimed development identity can be used by anyone who reaches the server. Turn it off before remote access.
- **Plain HTTP on the LAN.** There's no TLS on the LAN, so tokens and passwords cross the local network unencrypted. Acceptable only on your trusted LAN, or inside WireGuard (Option A). Option B needs TLS.
- **Token protection depends on the OS.** DPAPI protects the token at rest against other Windows accounts and copied profiles, not against malware running as the same user. While the app runs, the token lives in renderer memory.
- **No MFA, passkeys or email.** Recovery relies on recovery codes or an administrator.
- **In-memory rate limits.** They reset on restart. Fine for one process.
- **Some bans need checking against LiveKit.** A kicked or banned user who still holds a voice token issued in the last 5 minutes is removed again on join. Whether LiveKit also rejects such tokens up front (`revokeTokenTs`) depends on the LiveKit server version; this is not verified on v1.13.11.
- **Fixed roles.** There are four fixed roles, not custom roles, and members can't have multiple roles.
- **The audit log isn't tamper-proof.** Anyone with shell or database access can alter it.
- **Experimental Node API.** `crypto.argon2` is marked experimental in Node 24. The PHC format makes switching implementations later a drop-in change.
