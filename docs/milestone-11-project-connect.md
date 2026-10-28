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
| Compose | `DEV_AUTH` defaults to false. New `caddy` service, only with `--profile public`, on a fixed address 172.30.0.10 (the only trusted proxy); it refuses to start without a valid `PUBLIC_HOSTNAME` (checked at start-up, not by Compose, so LAN-only mode needs no public settings). LiveKit on host networking with `use_external_ip`, `advertise_internal_ip`, `skip_external_ip_validation`, LAN-only local candidates, all capabilities dropped. `no-new-privileges`, log rotation. Caddy: HTTP/3 off (UDP 443 isn't forwarded); `/api/livekit/webhook*` answers 404 from outside. | `server/docker-compose.yml`, `server/deploy/Caddyfile`, `server/.env.example`, `server/test/deploy.test.ts` |
| Dynamic IP | DuckDNS updater plus LiveKit restart when the public IP changes. The token is read from a root-only file and passed to curl on stdin, never in `ps` output or logs. | `server/deploy/public-ip-watch.sh`, `.gitattributes` |
| Desktop origin | The packaged renderer is served from `app://discord2/` (privileged, secure scheme; path-traversal guard). The `Origin` header rewrite (`origin.ts`) is removed. `isAppUrl()` trusts only `app://discord2` (plus the dev server during development). | `desktop/src/main/appProtocol.ts`, `appUrl.ts`, `index.ts` |
| Desktop endpoints | Server profiles fixed at build time (`RENDERER_VITE_SERVERS`). `https` required for public hosts; `http` only for private addresses. Picker on the sign-in screen. A saved sign-in is only used with its own server. The voice address from the server must match the profile's host and be `wss` when the profile is `https`. CSP generated from the same list; an invalid list fails the build. | `desktop/src/renderer/src/net/endpoints.ts`, `net/config.ts`, `App.tsx`, `components/auth/AuthScreen.tsx`, `hooks/useBackend.ts`, `electron.vite.config.ts`, `.env.example` |
| Installer | Version 1.1.0 (same `appId` and user-data folder, so it should upgrade 1.0.0 in place; not yet verified by installing). Placeholder update feed removed. | `desktop/package.json`, `desktop/electron-builder.yml` |

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
  - the LiveKit webhook path is refused at Caddy (it's signature-checked anyway, but only LiveKit on the Jetson calls it);
  - LiveKit shares the host's network, so its container drops every Linux capability;
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

3. **Certificates:** Caddy requests and renews them automatically (free, Let's Encrypt). They are stored in the `caddy-data` volume. Caddy tries both the HTTP-01 challenge (port 80) and TLS-ALPN-01 (port 443), so a certificate can still be issued if the ISP filters inbound port 80. Forward 80 anyway, for the HTTP→HTTPS redirect.

**Verified on October 28, 2026 (Checkpoint 3 preflight, read-only):**
- The router (TP-Link, BE11000 class, MiniUPnPd 2.2.2) reports its WAN address over both NAT-PMP and UPnP as **the same public IPv4 that internet services see**. There is no carrier-grade NAT and no second router in front, so port forwarding can work.
- Whether the ISP filters inbound ports can only be tested from outside after forwarding.
- There's no global IPv6 on the LAN, so only IPv4 is published (DuckDNS A record).
- **UPnP and NAT-PMP are enabled on the router.** Any device on the LAN can ask it to open inbound ports. Discord 2.0 doesn't use them; consider turning them off in the router unless a game console or similar needs them. Also confirm **DMZ is off**.

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
- **One-time effect of 1.1:** the app moved from `file://` to `app://discord2`, and browser storage belongs to an origin, so every setting stored on the PC (one entry, `d2.settings`) resets to its default once:
  - voice: microphone/speaker choice, input and output volume, per-user and per-stream volumes, push-to-talk key, noise suppression/echo cancellation/gain, input sensitivity;
  - screen-share quality, codec and audio options, stream stats overlay;
  - desktop notifications, message preview, muted channels;
  - sound effects (switch, volume, per-event toggles), recent emoji, font size.

  Account preferences (theme, accent, density, reduced motion and so on) and the saved sign-in are kept (they live on the server and in Windows-protected storage). The sign-in is kept only if the 1.0 app's server address (e.g. `http://192.168.68.65:3001`) is one of the 1.1 build's profiles; otherwise you sign in once more. Defaults are the safe direction (for example, message previews in notifications stay off).

  **No automatic migration, by decision:** only PCs that already ran 1.0 on the LAN are affected (friends joining remotely start fresh anyway), and re-selecting devices takes a minute. Copying the old values would mean loading a `file://` page in a hidden window at start-up, the kind of local-page trust 1.1 just removed. Revisit if more 1.0 users exist than expected.

## Windows installer and distribution

- **Identity is unchanged:** `appId com.discord2.app`, product name "Discord 2.0", install folder `%LOCALAPPDATA%\Programs\desktop`, data folder `%APPDATA%\desktop`. A 1.1.0 installer is therefore *expected* to upgrade 1.0.0 in place and keep the saved sign-in, but no 1.1.0 installer has been installed yet (**not verified**).

**Where each stage stands (on this PC, which has Smart App Control on):**

| Stage | Status | Evidence |
| --- | --- | --- |
| Packaged executable (`electron-builder --dir`) | **Works.** `dist\win-unpacked\Discord2.exe` 1.1.0 builds, and an earlier build of it ran here | build output; local integration |
| Installer generation (`npm run build:win`) | **Blocked here.** `Discord2-1.1.0-setup.exe` is written, but electron-builder runs it during the build and Smart App Control blocks that, so the build fails and the file is incomplete | Code Integrity event 3077 on `dist\Discord2-1.1.0-setup.exe`, parent `node.exe` |
| Installing it | **Not done** (it would replace the installed 1.0.0) | — |
| Distributing a signed installer | **No signing in place** | — |

**Why signing is the real fix.** Smart App Control runs a file only if Microsoft's cloud already knows it as safe, or if it's signed with a certificate from a CA in the Microsoft Trusted Root Program ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)). Self-signed certificates don't count, and there's no per-app exception. Unsigned installers are blocked outright on friends' PCs with it on; elsewhere, SmartScreen warns until the file gains reputation.

- **What must be signed:** every executable file, not only the installer. In the 1.1.0 package, Microsoft signs only `d3dcompiler_47.dll` and `dxil.dll`; unsigned are `Discord2.exe`, `ffmpeg.dll`, `dxcompiler.dll`, `vk_swiftshader.dll` and `vulkan-1.dll`. With a certificate configured, electron-builder signs the executables, installer and uninstaller; the DLLs need `win.signExts: [".dll", "!d3dcompiler_47.dll", "!dxil.dll"]` (electron-builder 26; the exclusions keep Microsoft's own signatures).

**Options** (prices and eligibility as published by Microsoft and the vendors, checked October 2026; [Microsoft's comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)):

| Option | Cost | Requirements and trade-offs |
| --- | --- | --- |
| **SignPath Foundation** | Free | For open-source projects: public repository, their review and approval, signed in CI (GitHub Actions). The publisher shown is "SignPath Foundation". |
| **Microsoft Store, MSIX package** | Free (free individual developer account; Microsoft re-signs the package) | Store certification. The listing name must not infringe trademarks (the name "Discord" is likely a problem; a listing can be hidden from search). MSIX changes the app's identity and data location: users start fresh (sign in again). |
| **Certum Open Source Code Signing** (cloud, SimplySign) | About €49/year | Individuals, open-source and non-commercial use; identity verification; issued to "Open Source Developer, <your name>". |
| **Azure Artifact Signing** (formerly Trusted Signing) | About $9.99/month | Individuals in the USA or Canada only; paid Azure subscription; identity verification; integrates with GitHub Actions. |
| **OV certificate** from a commercial CA | $150–300/year | Worldwide; hardware token or cloud HSM. EV certificates no longer skip SmartScreen (since 2024). |

None removes SmartScreen warnings instantly except the Store; signed files build reputation over time. Whichever is chosen, build installers on **GitHub Actions** (or another PC without Smart App Control), and publish the SHA-256 hash next to each installer.

Not acceptable as a release process: asking friends to turn Smart App Control off (on Windows versions before the April 2026 update, it reportedly can't be turned back on without reinstalling Windows; secondary sources).

## Deployment (Phase 2)

**Not performed. Each stage requires your explicit approval** (checkpoints 1–3). Milestone 10's server is not on the Jetson yet (it runs `milestone-8-identity`, `d2997e0`), so it ships together with Milestone 11. Run everything on the Jetson in `/home/lsaint06/Discord2.0/server`; Docker needs `sudo` there.

**Checkpoint 1 — preparation:** [back up, verify, and rehearse the migration on a copy](#backup-and-rollback). Nothing running changes, apart from about 10 seconds with the backend stopped.

**Checkpoint 2 — deploy on the LAN only** (no Caddy, no router change). New server code and LiveKit's new networking, still reachable only at home:

1. Settings. The backup already holds the old `.env`. Edit `.env` (keep the LiveKit key and secret):
   ```
   DEV_AUTH=false
   BIND_ADDRESS=192.168.68.65
   LIVEKIT_NODE_IP=192.168.68.65
   LIVEKIT_PUBLIC_URL=ws://192.168.68.65:7880
   LIVEKIT_LAN_CIDR=192.168.68.65/32
   # The installed 1.0 apps load from file:// and send Origin "null"; Milestone 11 refuses it in
   # production unless allowed. Remove once every PC runs 1.1:
   ALLOW_NULL_ORIGIN=true
   # Today it holds http://localhost:5173 (a development leftover); production doesn't need it:
   CORS_ORIGINS=
   ```
2. Deploy (the backend is down from the backup until the new one is healthy; LiveKit restarts, so calls in progress drop). Prepared as `d2-cp2-deploy.sh`, which checks every step; the essential commands:
   ```bash
   cd ~/Discord2.0/server
   git fetch /tmp/d2-m11.bundle refs/heads/milestone-11-connect:refs/remotes/bundle/milestone-11-connect   # no GitHub credentials needed
   # fresh consistent backup: online snapshot, `sudo docker compose stop server`, archive the volume, verify (see Backup)
   sudo docker compose down          # with the OLD compose file; NOT "down -v": the volume is kept
   git checkout -b milestone-11-connect 86831b4
   install -m 600 <prepared env.candidate> .env
   sudo docker tag discord2-server:m11-rc discord2-server:dev      # the image verified in Checkpoint 1
   sudo docker compose up -d --no-build --pull never               # no rebuild: runs exactly that image
   sudo docker inspect -f '{{.Image}}' "$(sudo docker compose ps -q server)"   # must equal the m11-rc image ID
   sudo docker compose exec -T server node dist/cli/admin.js verify            # OK, directContainerMembers 0
   sudo docker compose exec -T server node -e "fetch('http://host.docker.internal:7880/').then(r=>r.text()).then(console.log,console.error)"   # OK
   curl -s http://192.168.68.65:3001/api/meta        # apiVersion 4, devAuth false, voice true
   ```
3. With the installed 1.0 apps on the LAN: sign in, servers and channels, messages, attachments, friends, DMs and groups, then join and leave a voice channel (the member list updates within a second: the webhook works), two-way audio, and a screen share.

If anything fails, see the decision points under [rollback](#backup-and-rollback): **R1** (go back to Milestone 8 and keep all data; Milestone 8 opens the migrated database, as rehearsed) is the default. Restoring a backup (**R3**) is only for a damaged database, and only with the backup taken immediately before the deployment, never an older one.

**Checkpoint 3 — public exposure** (only with the backend healthy on the LAN):

1. **DuckDNS updater** (as root; the token goes only into this root-only file):
   ```bash
   sudo install -d -m 700 /etc/discord2 && sudo install -d /var/lib/discord2
   sudo tee /etc/discord2/duckdns.env >/dev/null <<'EOF'
   DUCKDNS_DOMAIN=myhome
   DUCKDNS_TOKEN=<your token>
   COMPOSE_DIR=/home/lsaint06/Discord2.0/server
   EOF
   sudo chmod 600 /etc/discord2/duckdns.env
   sudo /bin/bash /home/lsaint06/Discord2.0/server/deploy/public-ip-watch.sh     # first run records the IP (run with bash: not executable in Git)
   ( sudo crontab -l 2>/dev/null; echo '*/5 * * * * /bin/bash /home/lsaint06/Discord2.0/server/deploy/public-ip-watch.sh >> /var/log/discord2-ip.log 2>&1' ) | sudo crontab -
   nslookup myhome.duckdns.org    # must return your public IP
   ```
2. **Settings:** change in `.env`:
   ```
   PUBLIC_HOSTNAME=myhome.duckdns.org
   LIVEKIT_PUBLIC_URL=wss://myhome.duckdns.org
   LIVEKIT_LAN_URL=ws://192.168.68.65:7880
   LIVEKIT_USE_EXTERNAL_IP=true
   LIVEKIT_NODE_IP=
   ```
3. **Start public mode, then add the router forwards** (80, 443, 7881/tcp, 7882/udp to 192.168.68.65):
   ```bash
   sudo docker compose --profile public up -d
   sudo docker compose logs caddy | grep -iE "certificate|error"    # certificate obtained once 80/443 are forwarded
   sudo docker compose logs livekit | grep -iE "nodeIP|external|error"
   ```
4. **From outside the home network** (e.g. a laptop on a phone hotspot): `curl -s https://myhome.duckdns.org/api/meta` shows `"apiVersion":4` with a valid certificate, `curl -sI http://myhome.duckdns.org/` redirects to https, and ports 22, 3001 and 7880 are **not** reachable.
5. **Desktop:** build 1.1 with `RENDERER_VITE_SERVERS` (see [server profiles](#desktop-server-profiles)) where it isn't blocked (CI), install, then run the [remote two-PC test checklist](#remote-two-pc-test-checklist).
6. When every PC runs 1.1, remove `ALLOW_NULL_ORIGIN=true` and run `sudo docker compose --profile public up -d`.

**Host firewall:** the preflight found none (`ufw` not installed, iptables `INPUT` policy ACCEPT). Today that's acceptable because the router forwards only the four ports above, but nothing on the Jetson itself filters them. LAN-only services such as SSH (22) and rpcbind (111, unused by Discord 2.0) are only safe because they're never forwarded. Adding a host firewall is optional hardening and a separate decision; if you add `ufw`, use the rules in the [checklist](#jetson-production-checklist), including the Docker-subnet rule for 7880.

## Backup and rollback

Facts from the Stage A preflight (October 27, 2026): project `server` in `/home/lsaint06/Discord2.0/server`, volume `server_discord2-data` mounted at `/data` (host path `/var/lib/docker/volumes/server_discord2-data/_data`), database `/data/discord2.db` in **WAL mode** (the `-wal` file holds recent changes not yet in the main file), attachments in `/data/attachments`. `lsaint06` runs Docker through `sudo`.

Before any deployment:

1. **Consistent backup** (about 10 s of downtime). The server is stopped, so `discord2.db`, `-wal` and `-shm` form a consistent set. Never copy the database file alone while the server runs.
   ```bash
   cd ~/Discord2.0/server
   TS=$(date +%Y%m%d-%H%M%S); B=~/discord2-backups; install -d -m 700 "$B"
   git rev-parse HEAD > "$B/commit-$TS.txt"; sudo docker compose images > "$B/images-$TS.txt"
   install -m 600 .env "$B/env-pre-m11-$TS"                 # secrets: stays in this private folder
   sudo docker compose stop server
   sudo tar -C /var/lib/docker/volumes/server_discord2-data/_data -czf "$B/data-pre-m11-$TS.tgz" .
   sudo docker compose start server
   sudo chown "$USER" "$B/data-pre-m11-$TS.tgz" && chmod 600 "$B/data-pre-m11-$TS.tgz"
   sudo docker tag discord2-server:dev discord2-server:m8-rollback   # current image, for a fast rollback
   ```
2. **Verify the backup** (don't skip). Restore it into a scratch folder and open it with the current image, including the `-wal`, with no network:
   ```bash
   V=$(mktemp -d); sudo tar -xzf "$B/data-pre-m11-$TS.tgz" -C "$V"
   sudo docker run --rm --network none --user 0:0 -v "$V":/v -e NODE_ENV=production -e DEV_AUTH=false -e DATABASE_URL=sqlite:/v/discord2.db \
     discord2-server:m8-rollback node dist/cli/admin.js status      # counts must match the live server
   echo "attachment files: backup $(sudo find "$V/attachments" -type f | wc -l), live $(sudo find /var/lib/docker/volumes/server_discord2-data/_data/attachments -type f | wc -l)"
   sudo rm -rf "$V"
   ```
   Keep the backup private. Copy it only to your own devices, for example over SSH (`scp`) to a home PC or a USB drive; never to a cloud service.
3. **Rehearse the migration on a copy** before it touches the live database. Build the new server image from a separate checkout, so the running deployment and its folder stay untouched:
   ```bash
   cd ~/Discord2.0 && git fetch origin && git worktree add ~/d2-m11 origin/milestone-11-connect
   sudo docker build -t discord2-server:m11-rc ~/d2-m11/server
   V=$(mktemp -d); sudo tar -xzf "$B/data-pre-m11-$TS.tgz" -C "$V"
   sudo docker run --rm --network none --user 0:0 -v "$V":/v -e NODE_ENV=production -e DEV_AUTH=false -e DATABASE_URL=sqlite:/v/discord2.db \
     discord2-server:m11-rc node dist/cli/admin.js verify            # must end with "OK", directContainerMembers 0
   # Rollback compatibility: the old server must still open the migrated copy.
   sudo docker run --rm --network none --user 0:0 -v "$V":/v -e NODE_ENV=production -e DEV_AUTH=false -e DATABASE_URL=sqlite:/v/discord2.db \
     discord2-server:m8-rollback node dist/cli/admin.js status
   sudo rm -rf "$V"
   ```

**Rollback** (decision points; nothing here runs automatically, and never `docker compose down -v`):

- **R0, before the new backend starts:** nothing has been migrated. The deploy script puts Milestone 8 back by itself: old branch, old `.env`, `m8-rollback` image.
- **R1, new backend started but something is wrong** (default; keeps every message, account and file, including anything written after the deployment):
  ```bash
  cd ~/Discord2.0/server
  sudo docker compose --profile public down                 # no -v
  git checkout milestone-8-identity
  install -m 600 ~/discord2-backups/cp2-deploy-<time>/env.pre-cp2 .env
  sudo docker tag discord2-server:m8-rollback discord2-server:dev
  sudo docker compose up -d --no-build --pull never
  ```
  The database stays at migration 5. Milestone 8 opens it (rehearsed in Checkpoint 1); friends, DMs and groups created meanwhile are kept but hidden until Milestone 10+ runs again. The `@direct` guard (database triggers) keeps working under Milestone 8.
- **R2, close exposure first** (only after Checkpoint 3): remove the router port forwards before anything else.
- **R3, damaged database only** (integrity check fails): stop, keep a copy of the damaged state, then restore the archive taken **immediately before** the deployment. Never an older backup over newer data: anything written since that archive is lost.
  ```bash
  sudo docker compose down
  sudo tar -C /var/lib/docker/volumes/server_discord2-data/_data -czf ~/discord2-backups/damaged-$(date +%Y%m%d-%H%M%S).tgz .
  sudo find /var/lib/docker/volumes/server_discord2-data/_data -mindepth 1 -delete
  sudo tar -xzf ~/discord2-backups/cp2-deploy-<time>/data.tgz -C /var/lib/docker/volumes/server_discord2-data/_data
  # then R1 (Milestone 8) or start Milestone 11 again, as decided
  ```
- The 1.1 desktop app only accepts its own origin from Milestone 11 servers; Milestone 8 accepts it only if `CORS_ORIGINS` includes `app://discord2`. After R1, use the 1.0 app.

## Jetson production checklist

- [ ] SSH: key-only (`PasswordAuthentication no`), never forwarded.
- [ ] Host firewall, if `ufw` is used (it only governs LiveKit and SSH: Docker-published ports such as 3001, 80 and 443 bypass `ufw`, so `BIND_ADDRESS` is what keeps 3001 on the LAN):
  ```bash
  sudo ufw allow from 192.168.68.0/22 to any port 22,7880 proto tcp
  sudo ufw allow from 172.30.0.0/24 to any port 7880 proto tcp   # backend + Caddy -> LiveKit (required)
  sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp              # media, from anywhere (public mode)
  ```
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
| Automated, server | 132 existing + 8 new in `test/remote.test.ts` (private-host rules, production guards, origin policy incl. a **real WebSocket handshake**, refused-upgrade sockets closed, `X-Forwarded-For` only from the trusted proxy through the real sign-in limiter, LAN/public voice URL per request, short-lived tokens without the secret) + 11 new in `test/deploy.test.ts` (Compose and Caddyfile invariants: no required variables in profile-only services, `TRUST_PROXY` = Caddy's address, capabilities dropped, webhook blocked) | **151 / 151** |
| Automated, desktop | 215 existing + 13 new: server profiles and transport rules, CSP, voice-address check, `app://` trust and path traversal | **228 / 228** |
| Compose (readiness review) | Official Docker Compose CLI v5.6.1 `config` with dummy values (no Docker Engine on this PC: **static validation only**): LAN-only renders `server` + `livekit` without any public variable; `--profile public` adds `caddy`; volume `server_discord2-data`; missing LiveKit credentials still refused. Both rendered LiveKit configs parsed; every option checked against LiveKit v1.13.11 / mediatransportutil source. Caddy's start-up hostname check tested with a POSIX shell. | pass |
| Caddy (readiness review) | The real Caddyfile on Caddy 2.11.7 with local upstream stubs: `caddy validate` and `caddy fmt` clean; webhook blocked for every tested path variant (case, `//`, `..`, `%2F`, trailing slash); `/rtc` and `/rtc/validate` to LiveKit; forged `X-Forwarded-For`, `X-Real-IP` and `Forwarded` replaced by the real peer; HTTP 308 to HTTPS; no `Alt-Svc` (HTTP/3 off); unknown Host gets no upstream | pass |
| Local integration (this PC) | Production-mode backend + Caddy 2.11.7 (TLS, internal test CA, not added to Windows' trust store) + the real Electron app over `app://` and the **packaged** `Discord2.exe` (1.1.0). Checked: HSTS; app origin accepted; `null`/foreign → 403; forged `X-Forwarded-For` replaced by Caddy; `/rtc` routed to the LiveKit upstream; HTTP redirects to HTTPS; sign-in, realtime both ways between an HTTPS/WSS client and a LAN client; microphone permission for `app://`; navigation to `file://` blocked; sign-in survives restart; profile picker and switching; a mismatched voice address refused with a clear message; invalid server list fails the build; package contents free of secrets | pass |
| Not possible here | LiveKit media (Smart App Control blocked `livekit-server.exe`); building the 1.1.0 installer (same reason); Compose on a real Docker Engine (none here); anything on the Jetson, the router or a second network | **not verified** |

## Known limitations

- **Remote voice and screen sharing are unverified** until the Phase 2 two-network test runs. A local LiveKit run was blocked by this PC's application control.
- **No TURN.** A network that blocks both UDP 7882 and TCP 7881 (some corporate or school networks) can chat but not join voice.
- **Dynamic IP:** after an IP change, DNS and LiveKit update within about 5 minutes, and calls drop and reconnect.
- **If the ISP moves the connection to carrier-grade NAT**, or blocks ports 80/443, port forwarding stops working, and this design needs a relay host. The audit found no CGNAT today.
- **Unsigned installer:** blocked by Smart App Control, warned by SmartScreen. See [distribution](#windows-installer-and-distribution).
- The 1.1 update resets local per-PC settings once (see [server profiles](#desktop-server-profiles)).
- Desktop 1.0 apps need `ALLOW_NULL_ORIGIN=true` on the server until updated.
- **No host firewall on the Jetson** (Stage A preflight: `ufw` not installed, iptables `INPUT` policy ACCEPT). The router's port forwards are the only filter. If a firewall is added later, the Docker-subnet rule for port 7880 is required, or voice breaks (see the [checklist](#jetson-production-checklist)).
- **Not yet run on a Docker Engine:** LiveKit with host networking and dropped capabilities, `host.docker.internal` from the backend, and the webhook path. The Jetson has Docker 29.5.2. `host-gateway` resolves to `docker0` (172.17.0.1), which has no link today because no container uses the default bridge; the host still owns that address, so delivery is expected to work. Checkpoint 2 checks it explicitly. If it fails, the fallback is mapping `host.docker.internal` to the project network's own gateway (`172.30.0.1`), which is a one-line Compose change.
- **Home PCs on the public profile** depend on the router looping traffic back to its public address (hairpin NAT) for HTTPS and signaling; media still uses the LAN candidate. If the router doesn't support it, home PCs use the "Home network" profile.

## Operations

- **Certificates:** renewed automatically by Caddy; watch `docker compose logs caddy` for errors. Port 80 must stay forwarded for renewals.
- **Caddyfile permissions:** Caddy runs as root inside its container but with every capability dropped, so it can only read the bind-mounted `deploy/Caddyfile` if the file is world-readable (`644`). Check out or update the repository with a normal umask (`022`). A checkout under `umask 077` creates it as `600`, and Caddy then exits with `open /etc/caddy/Caddyfile: permission denied` (this happened once during Checkpoint 3b).
- **DuckDNS:** the cron script refreshes it every 5 minutes. DuckDNS can expire idle accounts, so log in occasionally.
- **Updates:**
  - server: `git pull`, then `docker compose --profile public up -d --build`;
  - desktop: a new installer with a higher version upgrades in place.
- **Inviting a friend:** an administrator creates a registration code; the friend installs the app and registers with it. No network setup is needed on their side.
