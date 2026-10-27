# Remote access for Discord 2.0 — options and recommendation

**Status: proposal only.** Nothing described here has been deployed or tested. The Jetson remains LAN-only. No router port forwarding, tunnels, DNS records or public endpoints were created. Each option needs your approval and then a separate external-network test.

## What has to be reachable

Discord 2.0 has two kinds of traffic, and **an HTTPS reverse proxy only carries the first**:

| Traffic | Today (LAN) | Transport |
| --- | --- | --- |
| API + realtime gateway (backend) | `http://192.168.68.65:3001`, `ws://…/gateway` | HTTP/WebSocket over TCP |
| LiveKit signaling | `ws://192.168.68.65:7880` | WebSocket over TCP |
| LiveKit media (voice, 1440p60 streams) | UDP 7882 (one multiplexed port), fallback TCP 7881 | WebRTC (ICE, DTLS-SRTP) — **not HTTP** |

WebRTC media uses ICE: each client must reach an address LiveKit *advertises* as a candidate (`rtc.node_ip`), over UDP (best) or TCP. A plain HTTP tunnel or reverse proxy does not forward this. If neither UDP nor TCP to the SFU works directly, you need a TURN relay. LiveKit's ports reference lists API/WebSocket 7880 (behind TLS), ICE/TCP 7881, ICE/UDP mux 7882, TURN/TLS 5349 (443 without a load balancer) and TURN/UDP 3478 ([LiveKit docs: Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)).

### Bandwidth budget (projection, not measured)

LiveKit forwards media without transcoding. Egress from the Jetson is roughly the sum of every stream × the number of people receiving it:

| Load | Approx. egress |
| --- | --- |
| 10 people talking (Opus ~32–50 kbps each, each hears 9) | ~3–5 Mbps |
| One 1440p60 stream (~12–25 Mbps, codec-dependent) watched by 9 | ~110–225 Mbps |
| Two such streams watched by everyone | ~220–450 Mbps |

The 950 Mbps symmetric connection is enough for this. The unknowns are the Jetson's encryption cost (Option A) or a relay's bandwidth bill (Options B and C), plus each friend's own downstream. Measure before relying on it (see "Test plan").

## Option A — Private mesh VPN (Tailscale, WireGuard-based)

**How it works:** install Tailscale on the Jetson and share only that machine with each friend's Tailscale account ("node sharing"). Friends run the Tailscale client and use the Jetson's Tailscale address (100.x.y.z, or a MagicDNS name) as the server URL. All traffic, including UDP media, flows inside WireGuard. Tailscale makes a direct peer-to-peer connection when NAT allows. Otherwise it falls back to its encrypted DERP relays (slower).

| Aspect | Assessment |
| --- | --- |
| Hardware / network | Nothing new. No public IP needed, no ports opened on the router. |
| Jetson compatibility | Tailscale ships native Linux ARM64 packages (apt repository for Ubuntu 22.04). Runs on the host next to Docker. |
| Setup complexity | Low: install, log in, share the machine, adjust LiveKit's advertised IP and the Compose port bindings (below). |
| User installation | Each friend installs Tailscale (Windows), creates a free account and accepts a share link once. |
| Latency | Direct WireGuard path: about the same as the internet path between homes. DERP relay fallback: noticeably higher, with limited throughput. |
| Cost | $0. Sharing is available on all plans, including Personal, which is free for up to 6 users with unlimited devices ([Tailscale pricing](https://tailscale.com/pricing)). Friends who accept a shared machine stay on their own tailnet; they are not members of yours ([Tailscale docs: sharing](https://tailscale.com/docs/features/sharing)). |
| Security exposure | Smallest. Nothing listens on the public internet. Shared users see only the Jetson, and shared machines are quarantined, so the Jetson can't open connections into their tailnet. Tailscale access rules (`grants` with `src: autogroup:shared`) can limit them to ports 3001, 7880, 7881 and 7882. |
| Maintenance | Keep Tailscale updated on the Jetson. Revoke a share when someone leaves (in addition to removing them in the app). |
| Voice / screen sharing | Works unchanged over a direct path. 1440p60 over a DERP relay is not expected to hold full quality. |
| CGNAT | Works: both ends only make outbound connections. Behind hard NAT on both sides, traffic goes through DERP. |
| Restrictive networks | Tailscale falls back to HTTPS-based DERP when UDP is blocked, but at reduced performance. |
| Trust dependency | Tailscale Inc. runs the coordination server (it sees device metadata, not traffic). The self-hosted alternative is **Headscale**, which needs its own public HTTPS endpoint and is more work. |

**Required changes when approved (not done):**
1. On the Jetson: install Tailscale, then run `tailscale up`.
2. In `server/.env`:
   - `LIVEKIT_NODE_IP` = the Jetson's Tailscale IP;
   - `LIVEKIT_PUBLIC_URL` = `ws://<tailscale-ip>:7880`;
   - `BIND_ADDRESS` = the Tailscale IP.
   LAN PCs also install Tailscale; they get a direct LAN path. Alternatively, publish the ports on both addresses, but LiveKit advertises one `node_ip`.
3. Set `DEV_AUTH=false` before sharing. A shared friend must not be able to use development sign-in.
4. Rebuild the desktop app with `RENDERER_VITE_SERVER_URL=http://<tailscale-ip>:3001`. Traffic is already encrypted by WireGuard, so plain HTTP inside the tunnel is acceptable.
5. Tailscale policy: allow `autogroup:shared` only TCP 3001, 7880 and 7881, and UDP 7882, on the Jetson. Check the [grants syntax](https://tailscale.com/docs/reference/syntax/grants) when writing it.

## Option B — Public HTTPS deployment

**How it works:** a domain name and DNS record point at your home IP. A reverse proxy (e.g. Caddy) on the Jetson terminates TLS with a Let's Encrypt certificate and serves `https://`/`wss://` for the backend and LiveKit signaling. The router forwards TCP 443, plus UDP 7882 and TCP 7881 for media (or a TURN/TLS port) to the Jetson.

| Aspect | Assessment |
| --- | --- |
| Hardware / network | A publicly routable IPv4 (or working IPv6 for everyone), a domain, router port forwarding and dynamic DNS if your IP changes. |
| Jetson compatibility | Caddy/Traefik and LiveKit's embedded TURN all run on ARM64. |
| Setup complexity | Medium–high: DNS, certificates (HTTP-01 needs port 80 or 443 open; DNS-01 needs a DNS API token), proxy configuration, LiveKit TLS/TURN configuration, and new CSP/`connect-src` values in the desktop build. |
| User installation | Nothing extra: friends just use the app. |
| Latency | Best: direct UDP between friends and the Jetson. |
| Cost | Domain (~$10–15/year). Optionally a static IP from the ISP. |
| Security exposure | **Highest.** The login, registration and recovery endpoints, the WebSocket gateway, the LiveKit API and the TURN server are reachable by anyone on the internet: scanners, credential stuffing, exploit attempts against Node/Fastify/LiveKit/the proxy. Milestone 7's controls (Argon2id, throttling, invite-only registration, generic errors, session revocation) are designed for this, but every unpatched dependency becomes internet-facing. |
| Maintenance | Highest: certificate renewals, prompt security updates (OS, Docker images, LiveKit, proxy, Node), log monitoring. |
| Voice / screen sharing | Full quality with UDP. TURN/TLS on 443 is needed for friends on networks that block UDP. |
| CGNAT | **Blocks this option.** Behind CGNAT (router WAN address in 100.64.0.0/10, or different from what "what is my IP" shows), inbound connections can't reach you. Check this before considering Option B. |
| Restrictive networks | Needs TURN/TLS on 443. It can't share TCP 443 with the HTTPS proxy unless the proxy does SNI/layer-4 routing, or you use a second IP. |

## Option C — Hybrid: public API/signaling, separate media path

**Variants:**
- **C1:** Cloudflare Tunnel (or another HTTP tunnel) for HTTPS/WSS API and signaling, with no inbound ports; media still over port-forwarded UDP or a TURN relay.
- **C2:** API and signaling on a small VPS reverse proxy that connects to the Jetson over WireGuard, plus TURN on the VPS for media.

| Aspect | Assessment |
| --- | --- |
| Feasibility | Possible but fragile. Cloudflare Tunnel does not carry WebRTC media, so you'd still need port forwarding (C1) or a relay (C2). Cloudflare's terms restrict sustained video through its proxy; media must not go through it anyway. LiveKit must advertise candidates that clients can reach, and in C2 the TURN server must reach the Jetson over the WireGuard link. |
| Jetson compatibility | Fine (cloudflared and WireGuard both run on ARM64). |
| Setup complexity | Highest: two or three systems (tunnel/VPS, TURN, Jetson) and split routing to debug. |
| User installation | Nothing extra. |
| Latency | Media via a VPS relay adds a hop. Fine for voice, reduces headroom for 1440p60. |
| Cost | VPS (~$5–10/month); 1440p60 fan-out through a relay is hundreds of Mbps sustained, so check the bandwidth allowance. |
| Security exposure | Lower than B for the API (no inbound ports on the home router in C1/C2), but you now operate a public VPS/TURN service and a tunnel provider sees TLS-terminated API traffic (C1). |
| Maintenance | High: two hosts to patch, more moving parts. |
| CGNAT | C2 works behind CGNAT (outbound WireGuard to the VPS). C1 still needs inbound UDP for media. |
| Restrictive networks | Good with TURN/TLS 443 on the VPS. |

## Recommendation

**Option A — Tailscale with node sharing of the Jetson only**, with `DEV_AUTH=false` and the Tailscale access rule limited to the four Discord 2.0 ports.

**Why:**
- It is the only option with **no public attack surface**, and it works behind CGNAT.
- It carries UDP media natively, so voice and 1440p60 work on direct paths.
- It costs $0, needs no domain, certificates or port forwarding, and is easy to undo (remove the share).

**Trade-offs:**
- Friends install one extra app.
- Quality degrades if a pair of networks forces the DERP relay.
- You depend on Tailscale's coordination service. Headscale is the later self-hosted path.

**When to reconsider:** Option B makes sense later if friends refuse a VPN client and you have a public IPv4 (no CGNAT) and time for patching and monitoring. Milestone 7's authentication is a prerequisite for B; it is not sufficient on its own.

## Test plan for the chosen option (separate approval)

1. CGNAT check (for B/C): compare the router's WAN IP with `curl https://ifconfig.me`.
2. A: from a friend's home, `tailscale ping <jetson>`. The result should say `via <ip>:<port>` (direct), not `via DERP`.
3. Throughput: `iperf3 -s` on the Jetson; `iperf3 -c <tailscale-ip> -R -t 30` from a friend. Watch Jetson CPU with `htop` and `tegrastats`; WireGuard encryption runs on the CPU.
4. App: sign in, message, upload, voice for 10 minutes, then a 1440p60 stream. Record fps, loss and RTT from the stream stats panel, and Jetson CPU, memory and egress (`docker stats`, `nload`).
5. Negative tests: another device on the friend's tailnet can't reach the Jetson; a shared user can't reach Jetson port 22.
6. Revocation: remove the share and confirm the friend loses access immediately; remove them from the app and confirm they lose servers and voice.
