# Milestone 11 — Secure remote access ("Project Connect")

Goal: friends outside the home network can use Discord 2.0 (messages, DMs, voice, screen sharing) without installing a VPN, for free, without weakening security.

**Status:**

- **Phase 0 (audit and architecture):** complete.
- **Phase 1 (local implementation):** complete and tested locally.
- **Phase 2 (production):** not started. It needs your separate approval and some steps only you can do: DuckDNS, router port forwarding, and the Jetson.

Nothing has been deployed. No port has been opened, and the Jetson and router are unchanged.

## Contents

1. [Audit summary](#audit-summary)
2. [Chosen architecture](#chosen-architecture)
3. [What changed](#what-changed)
4. [Security rationale](#security-rationale)
5. [DNS, certificates and router](#dns-certificates-and-router)
6. [LiveKit media transport](#livekit-media-transport)
7. [Desktop server profiles](#desktop-server-profiles)
8. [Windows installer and distribution](#windows-installer-and-distribution)
9. [Deployment (Phase 2)](#deployment-phase-2)
10. [Backup and rollback](#backup-and-rollback)
11. [Jetson production checklist](#jetson-production-checklist)
12. [Remote two-PC test checklist](#remote-two-pc-test-checklist)
13. [Verification performed](#verification-performed)
14. [Known limitations](#known-limitations)
15. [Operations](#operations)

## Audit summary

Observed on 2026-10-27, read-only.

| Area | Finding |
| --- | --- |
| Jetson | Runs the Milestone 8 server (`apiVersion 3`), `DEV_AUTH=false`, voice on. LAN ports 22, 3001, 7880 and 7881 open; 80, 443, 3478 and 5349 closed. No proxy, TLS, TURN or DNS name. |
| Home network | Router 192.168.68.1. The traceroute's second hop is a public address (50.35.80.1), not carrier-grade NAT (100.64/10), so the router most likely has a public, probably dynamic, WAN IP. |
| LiveKit (before) | `use_external_ip: false`, `node_ip` = LAN IP, plain `ws://` signaling, no TURN. Remote clients would get only unreachable LAN candidates, so **remote voice could not work**. |
| Desktop (before) | Loaded from `file://`; backend URL baked in, any `http://` accepted; `origin.ts` rewrote `Origin: file://` to `null`; `isAppUrl()` trusted every `file://` page; placeholder update feed. |
| Backend (before) | Compose defaulted `DEV_AUTH` to **true** if `.env` lacked it; `TRUST_PROXY` was all-or-nothing; `null` origin allowed by default. Refused WebSocket upgrades left sockets open (found during this milestone; see below). |
| Rollback | Milestone 10's `@direct` container is guarded by database triggers. The Jetson's Milestone 8 server code is identical to the Milestone 9 code the rollback test used. |

## Chosen architecture

Option B, public HTTPS/WSS, with free components only. Tailscale was rejected because every friend would need a VPN app (and the free plan is limited to 6 users). A tunnel was rejected because it can't carry LiveKit's UDP media and needs a paid domain.

```
 Friend's PC (anywhere)                         Home network
 ───────────────────────                       ──────────────────────────────────────────────
 Discord 2.0 app                               Router (port forwards)        Jetson 192.168.68.65
   https/wss  myhome.duckdns.org:443  ───────► 443/tcp, 80/tcp ──────────►  Caddy (TLS, Let's Encrypt)
                                                                              ├─ /rtc*  → LiveKit :7880 (signaling)
                                                                              └─ else   → backend :3001 (REST, /gateway)
   voice/screen media (DTLS-SRTP)  ──────────► 7882/udp, 7881/tcp ───────►  LiveKit (host network)

 PC at home: "Home network" profile → http://192.168.68.65:3001 and ws://192.168.68.65:7880 directly
```

- **Never forwarded:** 22 (SSH), 3001 (backend), 7880 (LiveKit API/signaling).
- **Free parts:**
  - DuckDNS for the name;
  - Let's Encrypt for certificates (handled by Caddy);
  - Caddy and LiveKit (open source);
  - a cron script for IP changes.

## What changed

| Area | Change | Files |
| --- | --- | --- |
| Backend config | `DEV_AUTH=true` refused when `NODE_ENV=production` unless `ALLOW_DEV_AUTH_IN_PRODUCTION=true`. `TRUST_PROXY` takes specific IPs/CIDRs (`true` refused in production, `/0` refused). `null` origin off by default in production. The app origin `app://discord2` is allowed. `LIVEKIT_PUBLIC_URL` must be `wss://` for public hosts. New optional `LIVEKIT_LAN_URL` (must be private), chosen for clients that connected via a private address. | `server/src/config.ts`, `server/src/lib/network.ts`, `server/src/routes/voice.ts`, `server/src/voice/access.ts`, `server/src/index.ts` |
| Backend bug fix | A WebSocket upgrade answered with a normal HTTP response (refused origin, rate limit, unknown path) left its socket open forever. On the internet that's a cheap way to exhaust connections. The socket is now closed after the response. | `server/src/app.ts` |
| Compose | `DEV_AUTH` defaults to false. New `caddy` service, only with `--profile public`, on a fixed address 172.30.0.10 (the only trusted proxy). LiveKit on host networking with `use_external_ip`, `advertise_internal_ip`, `skip_external_ip_validation`, LAN-only local candidates. `no-new-privileges`, log rotation. | `server/docker-compose.yml`, `server/deploy/Caddyfile`, `server/.env.example` |
| Dynamic IP | DuckDNS updater plus LiveKit restart when the public IP changes. The token is read from a root-only file and passed to curl on stdin, never in `ps` output or logs. | `server/deploy/public-ip-watch.sh`, `.gitattributes` |
| Desktop origin | The packaged renderer is served from `app://discord2/` (privileged, secure scheme; path-traversal guard). The `Origin` header rewrite (`origin.ts`) is removed. `isAppUrl()` trusts only `app://discord2` (plus the dev server during development). | `desktop/src/main/appProtocol.ts`, `appUrl.ts`, `index.ts` |
| Desktop endpoints | Server profiles fixed at build time (`RENDERER_VITE_SERVERS`). `https` required for public hosts; `http` only for private addresses. Picker on the sign-in screen. A saved sign-in is only used with its own server. The voice address from the server must match the profile's host and be `wss` when the profile is `https`. CSP generated from the same list; an invalid list fails the build. | `desktop/src/renderer/src/net/endpoints.ts`, `net/config.ts`, `App.tsx`, `components/auth/AuthScreen.tsx`, `hooks/useBackend.ts`, `electron.vite.config.ts`, `.env.example` |
| Installer | Version 1.1.0 (upgrades 1.0.0 in place: same `appId`, same user-data folder). Placeholder update feed removed. | `desktop/package.json`, `desktop/electron-builder.yml` |

## Security rationale

- **Authentication is unchanged:**
  - invite-only accounts;
  - Argon2id passwords;
  - bearer tokens (no cookies, so no cross-site request forgery);
  - tokens stored with Windows DPAPI;
  - session expiry and revocation;
  - every DM, group, attachment and server-permission check from Milestones 7–10.
- **Origins aren't authentication.** An `Origin` header only constrains browsers; any program can send any header. What the change guarantees is that no web page and no local HTML file can act as the app in a browser or in the app window. The app's own origin `app://discord2` can't be created by a web page, and `null` (shared by every `file://` page and sandboxed iframe) is refused in production.
- **Client IPs:** `X-Forwarded-For` is believed only from Caddy's fixed internal address, and Caddy overwrites whatever a client sends. Per-IP rate limits therefore apply to real clients, and nobody can rotate fake IPs to bypass them.
- **TLS everywhere public:**
  - HTTPS, WSS and `wss://` LiveKit signaling through Caddy;
  - HSTS on;
  - media is always encrypted by WebRTC (DTLS-SRTP).
  - The desktop app refuses to be built with `http://` for an internet host, and refuses an unencrypted or foreign voice address at runtime.
- **No secrets in the client:**
  - the LiveKit API secret stays in the backend's `.env`;
  - clients get 5-minute room tokens;
  - the packaged app was inspected: 23 files, no `.env`, databases, source or source maps, and no secret strings or the actual secret value.
- **Least exposure:**
  - only 80/443 (Caddy) and 7881/7882 (LiveKit media) are forwarded;
  - the Caddy admin API is container-local;
  - there's no Caddy access log, because LiveKit tokens travel in the `/rtc` query string.

## DNS, certificates and router

1. **DuckDNS** (free): sign in at <https://www.duckdns.org>, create a name (e.g. `myhome` gives `myhome.duckdns.org`), and copy the token. The token is a password: keep it out of Git and chats.
2. **Router** (the router model wasn't confirmed; on a TP-Link Deco this is in the app under *More → Advanced → NAT Forwarding*; names vary):
   - reserve 192.168.68.65 for the Jetson (*Address Reservation*);
   - add forwards to 192.168.68.65:

| External port | Protocol | Purpose |
| --- | --- | --- |
| 80 | TCP | Let's Encrypt certificate challenge + redirect to HTTPS |
| 443 | TCP | HTTPS / WSS (app, gateway, LiveKit signaling) |
| 7881 | TCP | LiveKit media over TCP (fallback when UDP is blocked) |
| 7882 | UDP | LiveKit media (normal path) |

3. **Certificates:** Caddy requests and renews them automatically (free, Let's Encrypt, HTTP-01 on port 80). They are stored in the `caddy-data` volume.

## LiveKit media transport

- LiveKit runs with **host networking**. It offers clients two candidates: its **LAN address** (`advertise_internal_ip`, limited to `LIVEKIT_LAN_CIDR`) for PCs at home, and its **public address** (discovered via STUN at start-up, `use_external_ip`) for friends elsewhere.
- **UDP 7882** is the normal path; **TCP 7881** is the fallback for networks that block UDP.
- **Router loopback:** `skip_external_ip_validation` avoids depending on the router looping traffic back to its own public IP. PCs at home use the "Home network" profile, so they never need it.
- **IP changes:** when the public IP changes, `public-ip-watch.sh` restarts LiveKit (calls in progress drop and reconnect).
- **TURN is not configured.** With a public, port-forwarded host, ICE over UDP and TCP covers almost all home networks. Embedded TURN/TLS would need port 443 shared with Caddy (SNI routing) or another port that strict firewalls also block. Revisit only if a friend's network actually fails both 7882/UDP and 7881/TCP.
- **Bandwidth (estimate, not measured):** every viewer of a 1440p60 screen share receives its own copy from the Jetson, so the home connection's **upload** must carry `streams × viewers`, typically several Mbps per viewer at that quality. Check your plan's upload speed before relying on high-quality sharing with many viewers.

## Desktop server profiles

`desktop/.env.production.local` (git-ignored) holds the approved servers. The first one is the default, and they're compiled into the build:

```
RENDERER_VITE_SERVERS=Discord 2.0|https://myhome.duckdns.org,Home network|http://192.168.68.65:3001
```

- With more than one profile, the sign-in screen shows a **Server** picker; the choice is remembered.
- A saved sign-in belongs to exactly one server and is only sent there. Switching profile means signing in again.
- Nobody can type in another server: a token can't be sent to an unapproved host.
- `https://` is required for internet hosts (the build fails otherwise); `http://` is accepted only for private addresses (192.168.x, 10.x, 172.16–31.x, localhost, `*.local`, 100.64/10).
- The older single `RENDERER_VITE_SERVER_URL` still works (one profile named "Server").
- **One-time effect of 1.1:** the app moved from `file://` to `app://discord2`. Settings stored on the PC reset once:
  - sound and volume settings;
  - muted channels;
  - font size.

  Account preferences (theme, accent and so on) and the saved sign-in are kept.

## Windows installer and distribution

- **Identity is unchanged:** `appId com.discord2.app`, product name "Discord 2.0", install folder `%LOCALAPPDATA%\Programs\desktop`, data folder `%APPDATA%\desktop`. A 1.1.0 installer upgrades 1.0.0 in place and keeps the saved sign-in.
- **Smart App Control (found during this milestone):** this PC has Smart App Control **on**, and it blocked the unsigned 1.1.0 installer while electron-builder was producing it (Windows Code Integrity event 3077), so no 1.1.0 installer was built here.
  - The same will happen on any friend's PC with Smart App Control on: unsigned installers are blocked outright, with no per-app exception.
  - Where it's off, SmartScreen shows "Windows protected your PC" until the file gains reputation.
- **Realistic free options**, best first:
  1. **SignPath Foundation** (free code signing for open-source projects; requires a public repository and their approval; releases are signed as "SignPath Foundation"). This is the only free way to a signed installer.
  2. Build installers on **GitHub Actions** (free for public repos, monthly free minutes for private ones), so this PC's policy doesn't block the build, and publish the SHA-256 hash next to each installer.
  3. Unsigned and private: friends with Smart App Control on would have to turn it off to install. That isn't a reasonable permanent strategy.
- Paid alternatives, for reference only (not recommended given "free"): Azure Trusted Signing (about $10/month), or a classic code-signing certificate.

## Deployment (Phase 2)

**Not performed. Requires your explicit approval.** Order matters: Milestone 10's server is not on the Jetson yet, so it ships together with Milestone 11.

1. **Back up and verify** ([below](#backup-and-rollback)).
2. **DuckDNS updater** on the Jetson (as root):
   ```bash
   sudo install -d -m 700 /etc/discord2 && sudo install -d /var/lib/discord2
   sudo tee /etc/discord2/duckdns.env >/dev/null <<'EOF'
   DUCKDNS_DOMAIN=myhome
   DUCKDNS_TOKEN=<your token>
   COMPOSE_DIR=/home/<you>/Discord2.0/server
   EOF
   sudo chmod 600 /etc/discord2/duckdns.env
   sudo /home/<you>/Discord2.0/server/deploy/public-ip-watch.sh     # first run records the IP
   ( sudo crontab -l 2>/dev/null; echo '*/5 * * * * /home/<you>/Discord2.0/server/deploy/public-ip-watch.sh >> /var/log/discord2-ip.log 2>&1' ) | sudo crontab -
   nslookup myhome.duckdns.org    # must return your public IP
   ```
3. **Server `.env`** on the Jetson (keep the existing LiveKit key and secret):
   ```
   DEV_AUTH=false
   BIND_ADDRESS=192.168.68.65
   PUBLIC_HOSTNAME=myhome.duckdns.org
   LIVEKIT_PUBLIC_URL=wss://myhome.duckdns.org
   LIVEKIT_LAN_URL=ws://192.168.68.65:7880
   LIVEKIT_USE_EXTERNAL_IP=true
   LIVEKIT_NODE_IP=
   LIVEKIT_LAN_CIDR=192.168.68.0/24
   # Only while friends still run the 1.0 app (file://); remove afterwards:
   ALLOW_NULL_ORIGIN=true
   ```
4. **Check the Docker subnet is free:** `docker network inspect $(docker network ls -q) | grep -n 172.30.0` must print nothing (except an existing `server_default` you're about to replace).
5. **Deploy:**
   ```bash
   cd ~/Discord2.0 && git fetch origin && git checkout <approved branch> && git pull
   cd server
   docker compose down          # NOT "down -v": volumes (database, files) are kept. Needed once: the network and LiveKit's networking changed.
   docker compose --profile public up -d --build
   docker compose ps
   docker compose logs server | grep -iE "migrat|listening|proxies|error"
   docker compose logs caddy  | grep -iE "certificate|error"
   docker compose exec server node dist/cli/admin.js verify   # directContainerMembers must be 0
   ```
6. **Router:** add the four port forwards above (only now, after the server is hardened and running).
7. **From outside the home network** (e.g. a phone hotspot on a laptop): `curl -s https://myhome.duckdns.org/api/meta` should show `"apiVersion":4` and a valid certificate. `curl -s http://myhome.duckdns.org/` should redirect to https.
8. **Desktop:** set `RENDERER_VITE_SERVERS` as above and build `npm run build:win` where it isn't blocked (or via CI). Install on both PCs, then run the [remote two-PC test checklist](#remote-two-pc-test-checklist).
9. When everyone runs 1.1, remove `ALLOW_NULL_ORIGIN=true` and run `docker compose up -d` again.

## Backup and rollback

Before any deployment:

1. **Database + attachments + profile images** (one volume, about 10 s of downtime):
   ```bash
   cd ~/Discord2.0/server && docker compose stop server
   docker run --rm -v server_discord2-data:/data -v "$PWD":/backup alpine tar czf /backup/discord2-pre-m11-$(date +%F).tgz -C /data .
   docker compose start server
   ```
2. **Verify the backup** (don't skip):
   ```bash
   tar tzf discord2-pre-m11-*.tgz | head            # discord2.db, attachments/, profile/
   mkdir /tmp/verify && tar xzf discord2-pre-m11-*.tgz -C /tmp/verify discord2.db
   docker run --rm -v /tmp/verify:/v alpine sh -c "apk add -q sqlite && sqlite3 /v/discord2.db 'PRAGMA integrity_check;'"   # ok
   ```
   Copy the tarball off the Jetson (another PC or USB drive).
3. **Record what's running:** `docker compose images` and `git rev-parse HEAD`.

**Rollback:**

1. **Close exposure first:** remove the router port forwards.
2. `docker compose --profile public down` (no `-v`), check out the previous commit, then `docker compose up -d --build`.
   - Milestone 10's migration is additive and its `@direct` guard holds for older servers (verified against Milestone 9 code).
   - The previous compose file expects `LIVEKIT_NODE_IP` and `BIND_ADDRESS` as before.
3. **Full rollback:** restore the tarball into the volume (anything written since is lost).
4. Reinstall the previous desktop app if needed.

## Jetson production checklist

- [ ] SSH: key-only (`PasswordAuthentication no`), never forwarded; consider `ufw` allowing 22, 3001 and 7880 from 192.168.68.0/24 only, and 80, 443, 7881/tcp and 7882/udp from anywhere.
- [ ] `.env` mode 600 and not in Git; `/etc/discord2/duckdns.env` mode 600.
- [ ] `DEV_AUTH=false` (production refuses it anyway); `ALLOW_NULL_ORIGIN` removed after the 1.1 rollout.
- [ ] Containers: `restart: unless-stopped`, health checks, `no-new-privileges`, log rotation (10 MB × 5): all in Compose.
- [ ] Nightly backup of the volume to another device; test a restore monthly.
- [ ] Monitoring:
  - `docker compose ps`;
  - `tegrastats` (CPU/GPU/RAM);
  - `df -h` (uploads stop below `UPLOAD_MIN_FREE_DISK_MB`);
  - `/var/log/discord2-ip.log`;
  - Caddy logs for certificate renewal errors.
- [ ] OS updates (`unattended-upgrades` or a monthly routine); pin image versions (LiveKit and Caddy are pinned).
- [ ] **Incident response:**
  - remove the router forwards (instantly offline to the internet);
  - `admin revoke-sessions <user>` or disable the account;
  - rotate the LiveKit key/secret in `.env`, then `docker compose up -d`;
  - review the security log (Settings → Administration).

## Remote two-PC test checklist

Use PC A at home and PC B on a **different network**, for example tethered to a phone hotspot. Not run yet; this is the Phase 2 acceptance test.

1. PC B: install 1.1, profile "Discord 2.0" (https). Sign in. The certificate is valid; there is no reconnect banner.
2. Messaging, DMs, a group, image attachment, reactions: they arrive on both PCs live.
3. Voice: both join a voice channel. Check:
   - you hear each other;
   - mute/unmute and deafen/undeafen;
   - leave and join.
   - During a screen share, the stream statistics show packet loss and round-trip time. The app doesn't show whether media uses UDP or TCP; check LiveKit's logs on the Jetson (`docker compose logs livekit`) while testing.
4. Screen share from B, viewed on A, and the reverse. Check stream stats and switching the audio output device.
5. Network interruption on B (turn Wi-Fi off for 20 s, then on). Chat and voice must reconnect on their own.
6. TCP fallback: on B, block outbound UDP 7882 (Windows Defender Firewall rule) and rejoin voice. Voice must still connect (over TCP 7881, visible in LiveKit's logs). Remove the rule afterwards.
7. PC A on the "Home network" profile and PC B remote in the same call.
8. Restart the server containers; both apps reconnect without duplicates.

## Verification performed

| Kind | What | Result |
| --- | --- | --- |
| Automated, server | 132 existing + 8 new (`test/remote.test.ts`): private-host rules, production guards, origin policy incl. a **real WebSocket handshake**, refused-upgrade sockets closed, `X-Forwarded-For` only from the trusted proxy (through the real sign-in limiter), LAN/public voice URL per request, short-lived tokens without the secret | **140 / 140** |
| Automated, desktop | 215 existing + 13 new: server profiles and transport rules, CSP, voice-address check, `app://` trust and path traversal | **228 / 228** |
| Local integration (this PC) | Production-mode backend + Caddy 2.11.7 (TLS, internal test CA, not added to Windows' trust store) + the real Electron app over `app://` and the **packaged** `Discord2.exe` (1.1.0). Checked: HSTS; app origin accepted; `null`/foreign → 403; forged `X-Forwarded-For` replaced by Caddy; `/rtc` routed to the LiveKit upstream; HTTP redirects to HTTPS; sign-in, realtime both ways between an HTTPS/WSS client and a LAN client; microphone permission for `app://`; navigation to `file://` blocked; sign-in survives restart; profile picker and switching; a mismatched voice address refused with a clear message; invalid server list fails the build; package contents free of secrets | pass |
| Not possible here | LiveKit media (Smart App Control blocked `livekit-server.exe`); building the 1.1.0 installer (same reason); anything on the Jetson, the router or a second network | **not verified** |

## Known limitations

- **Remote voice and screen sharing are unverified** until the Phase 2 two-network test runs. A local LiveKit run was blocked by this PC's application control.
- **No TURN.** A network that blocks both UDP 7882 and TCP 7881 (some corporate or school networks) can chat but not join voice.
- **Dynamic IP:** after an IP change, DNS and LiveKit update within about 5 minutes, and calls drop and reconnect.
- **If the ISP moves the connection to carrier-grade NAT**, or blocks ports 80/443, port forwarding stops working, and this design needs a relay host. The audit found no CGNAT today.
- **Unsigned installer:** blocked by Smart App Control, warned by SmartScreen. See [distribution](#windows-installer-and-distribution).
- The 1.1 update resets local per-PC settings once (see [server profiles](#desktop-server-profiles)).
- Desktop 1.0 apps need `ALLOW_NULL_ORIGIN=true` on the server until updated.
- The Jetson's host firewall state wasn't audited (no SSH access was used).

## Operations

- **Certificates:** renewed automatically by Caddy; watch `docker compose logs caddy` for errors. Port 80 must stay forwarded for renewals.
- **DuckDNS:** the cron script refreshes it every 5 minutes. DuckDNS can expire idle accounts, so log in occasionally.
- **Updates:**
  - server: `git pull`, then `docker compose --profile public up -d --build`;
  - desktop: a new installer with a higher version upgrades in place.
- **Inviting a friend:** an administrator creates a registration code; the friend installs the app and registers with it. No network setup is needed on their side.
