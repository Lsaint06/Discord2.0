# Voice on the Jetson Orin Nano (LiveKit, LAN-only)

This guide deploys Discord 2.0's backend **and** a self-hosted [LiveKit](https://docs.livekit.io) SFU on the Jetson (Ubuntu 22.04, ARM64) with Docker Compose. Nothing here touches your router: the deployment is **LAN-only**.

> No changes have been made to the Jetson. Run these steps yourself when you're ready.

## Architecture

```text
 Windows PC (Alice)                       Jetson 192.168.68.65                     Windows PC (Bob)
 ┌────────────────────┐    LAN (no TLS)    ┌──────────────────────────────┐          ┌────────────────────┐
 │ Electron renderer  │── REST/WS :3001 ──▶│ server  (Fastify, SQLite)    │◀── :3001 ─│ Electron renderer  │
 │  mic → Opus encode │                    │   • mints 5-min LiveKit JWTs │          │  Opus decode → 🔊  │
 │  livekit-client    │── signaling :7880 ▶│   • voice presence (webhook) │          │  livekit-client    │
 │                    │══ media UDP 7882 ═▶│ livekit (SFU, forwards only) │═════════▶│                    │
 └────────────────────┘   (TCP 7881 fallback)└──────────────────────────────┘          └────────────────────┘
```

- **Clients** capture, encode (Opus), decode and play audio. **LiveKit** only forwards encrypted (DTLS-SRTP) packets: no transcoding, so CPU use on the Jetson stays low.
- The **backend** holds the LiveKit API secret and issues short-lived, single-room tokens to authenticated users. The secret never reaches Electron.
- LiveKit calls the backend's **webhook** (signed with the API secret) on join/leave. The backend also **reconciles** with LiveKit's API every 30 s.

| Port | Proto | Service | Purpose |
| --- | --- | --- | --- |
| 3001 | TCP | server | REST + chat gateway |
| 7880 | TCP | livekit | Signaling WebSocket (`ws://192.168.68.65:7880`) |
| 7881 | TCP | livekit | ICE over TCP (fallback when UDP is blocked) |
| 7882 | UDP | livekit | All media (single multiplexed UDP port) |

All four are published on `BIND_ADDRESS` (the Jetson's LAN IP) only.

## 1. Prerequisites (on the Jetson)

```bash
docker --version && docker compose version   # Docker Engine + Compose v2
uname -m                                       # aarch64
```

The `livekit/livekit-server:v1.13.11` image is published for `linux/arm64`; the backend image builds natively on ARM64 (no native Node addons).

## 2. Configure credentials (untracked `.env`)

```bash
cd ~/Discord2.0/server            # wherever the repo lives on the Jetson
git fetch && git checkout milestone-4-voice   # or main, once merged

# Generate a LiveKit key pair (prints "API Key" and "API Secret"):
docker run --rm livekit/livekit-server:v1.13.11 generate-keys

cp .env.example .env
chmod 600 .env
nano .env
```

Set at least:

```dotenv
BIND_ADDRESS=192.168.68.65
LIVEKIT_NODE_IP=192.168.68.65
LIVEKIT_PUBLIC_URL=ws://192.168.68.65:7880
LIVEKIT_API_KEY=<API Key from generate-keys>
LIVEKIT_API_SECRET=<API Secret from generate-keys>   # letters/digits, ≥ 32 chars
DEV_AUTH=true                                        # development identities (see Security)
```

`LIVEKIT_URL` is set by `docker-compose.yml` (`http://livekit:7880`); leave it empty in `.env`.

## 3. Firewall (only if `ufw` is active)

```bash
sudo ufw status
# Allow your LAN only (adjust the subnet to your network, e.g. 192.168.68.0/22 for TP-Link Deco):
sudo ufw allow from 192.168.68.0/22 to any port 3001,7880,7881 proto tcp
sudo ufw allow from 192.168.68.0/22 to any port 7882 proto udp
```

Do **not** add router port forwards or public tunnels for these ports.

## 4. Deploy

```bash
docker compose pull livekit
docker compose up -d --build
docker compose ps                      # both "running"; livekit "healthy" after ~10 s
curl -s http://192.168.68.65:3001/api/meta   # → {"…","devAuth":true,"voice":true}
curl -s http://192.168.68.65:7880/           # → OK
docker compose logs -f livekit         # look for: starting LiveKit server … nodeIP 192.168.68.65
docker compose logs -f server          # look for: Voice enabled (LiveKit)
```

Update later with `git pull && docker compose up -d --build`. Roll back with `git checkout <previous commit> && docker compose up -d --build`. Data persists in the `discord2-data` volume.

## 5. Point the Windows clients at the Jetson

Create `desktop/.env.development.local` (git-ignored) on each PC:

```dotenv
RENDERER_VITE_SERVER_URL=http://192.168.68.65:3001
```

The client's Content-Security-Policy allows any port on that host, so `ws://192.168.68.65:7880` (LiveKit) is permitted automatically. If LiveKit ever runs on a different host, also set `RENDERER_VITE_LIVEKIT_URL`.

## 6. Monitoring

| What | Command |
| --- | --- |
| Container CPU / memory / network | `docker stats` |
| Jetson CPU, GPU, RAM, temps, power | `sudo tegrastats` (built in) or `jtop` (`sudo pip3 install jetson-stats`) |
| LiveKit room / participant events | `docker compose logs -f livekit` |
| Backend voice tokens & presence | `docker compose logs -f server \| grep -E "voice\|webhook"` |
| Live UDP/TCP sessions | `sudo ss -uanp \| grep 7882` / `sudo ss -tanp \| grep -E "7880\|7881"` |
| Interface throughput | `sudo apt install nload && nload eth0` (or `iftop -i eth0`) |
| Health | `docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q livekit)` |

**Expected load (voice only):** Opus speech ≈ 24–40 kbps per speaker. With 10 people in one room, each client receives up to 9 streams (≈ 0.4 Mbps), and the SFU forwards ≈ 10 × 9 × 40 kbps ≈ 3.6 Mbps total — negligible for the Orin Nano and your LAN. LiveKit uses roughly 50–150 MB RAM and a few % of one core at this scale. Investigate if `docker stats` shows LiveKit using sustained >50% CPU or >500 MB RAM.

## 7. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| UI shows "Voice is not configured on this server" | `LIVEKIT_*` missing in the server container → check `.env`, then `docker compose up -d` |
| "Could not reach the voice server" | Client can't reach `ws://192.168.68.65:7880` → firewall, wrong `LIVEKIT_PUBLIC_URL`, or `BIND_ADDRESS` still `127.0.0.1` |
| Connects, but nobody hears anyone | ICE/UDP blocked or wrong advertised IP → check `LIVEKIT_NODE_IP`, allow UDP 7882; TCP 7881 is the fallback |
| Users don't appear in voice channels | Webhook not reaching backend → `docker compose logs server \| grep webhook`; reconciliation fixes state within 30 s |
| "Microphone access is blocked" | Windows Settings → Privacy & security → Microphone → enable *Microphone access* and *Let desktop apps access your microphone* |

## Security notes

- **Development identities are not authentication.** With `DEV_AUTH=true`, anyone on your LAN can sign in as any username and therefore obtain a voice token. Voice access is exactly as strong as that sign-in. Keep the deployment LAN-only until real accounts replace dev identities.
- Voice tokens: 5-minute lifetime, one room each, identity = the backend user id, publish rights limited to microphone + screen share (+ its audio), no camera, no admin rights.
- Media is encrypted in transit (DTLS-SRTP) but the SFU can technically access it (no end-to-end encryption yet). Signaling is plain `ws://` on the LAN; add TLS (`wss://`) via a reverse proxy before any wider exposure.
- Secrets live only in `server/.env` on the Jetson (mode 600) and inside the containers' environment.

## Screen sharing (1080p60 / 1440p60)

Implemented in Milestone 5. See **[screen-sharing-jetson.md](screen-sharing-jetson.md)** for the architecture, the LiveKit codec setting that enables GPU encoding on Windows, deployment and rollback commands, bandwidth figures and the benchmark procedure. The Jetson still only forwards packets; it never transcodes.
