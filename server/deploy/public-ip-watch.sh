#!/usr/bin/env bash
# Discord 2.0 — keep the DuckDNS name pointing at this home connection, and restart LiveKit when
# the public IP changes (LiveKit learns its public address only at start-up).
#
# Free: DuckDNS (https://www.duckdns.org) + this script in root's crontab, e.g. every 5 minutes:
#   */5 * * * * /home/<you>/Discord2.0/server/deploy/public-ip-watch.sh >> /var/log/discord2-ip.log 2>&1
#
# Configuration (root-only, never in Git):  /etc/discord2/duckdns.env  (chmod 600)
#   DUCKDNS_DOMAIN=yourname          # the part before .duckdns.org
#   DUCKDNS_TOKEN=xxxxxxxx-xxxx-...  # from your DuckDNS account page
#   COMPOSE_DIR=/home/<you>/Discord2.0/server
#
# The token is passed to curl on stdin, so it never appears in `ps` output or in logs.
set -euo pipefail

CONFIG=${DISCORD2_DUCKDNS_CONFIG:-/etc/discord2/duckdns.env}
STATE_DIR=${DISCORD2_STATE_DIR:-/var/lib/discord2}
STATE_FILE="$STATE_DIR/public-ip"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if [[ ! -r "$CONFIG" ]]; then
  log "error: cannot read $CONFIG"
  exit 1
fi
if [[ "$(stat -c %a "$CONFIG")" != "600" && "$(stat -c %a "$CONFIG")" != "400" ]]; then
  log "error: $CONFIG must be readable by its owner only (chmod 600)"
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"
: "${DUCKDNS_DOMAIN:?DUCKDNS_DOMAIN missing in $CONFIG}"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN missing in $CONFIG}"
: "${COMPOSE_DIR:?COMPOSE_DIR missing in $CONFIG}"
if [[ ! "$DUCKDNS_DOMAIN" =~ ^[a-z0-9-]{1,63}$ ]]; then
  log "error: DUCKDNS_DOMAIN must be just the name (letters, digits, '-'), without .duckdns.org"
  exit 1
fi

# Empty ip= lets DuckDNS use the address this request comes from; verbose=true returns it.
response=$(
  printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=&verbose=true"\n' \
    "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" |
    curl --silent --show-error --fail --max-time 20 --config -
) || { log "error: DuckDNS update request failed"; exit 1; }

status=$(printf '%s\n' "$response" | sed -n 1p)
ip=$(printf '%s\n' "$response" | sed -n 2p)
if [[ "$status" != "OK" ]]; then
  log "error: DuckDNS refused the update (check domain and token)"
  exit 1
fi
if [[ ! "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  log "error: unexpected address from DuckDNS"
  exit 1
fi

mkdir -p "$STATE_DIR"
previous=$(cat "$STATE_FILE" 2>/dev/null || true)
if [[ "$ip" == "$previous" ]]; then
  exit 0
fi
printf '%s\n' "$ip" > "$STATE_FILE"

if [[ -z "$previous" ]]; then
  log "public IP is $ip (first run, LiveKit not restarted)"
  exit 0
fi
log "public IP changed $previous -> $ip: restarting LiveKit so it advertises the new address"
docker compose --project-directory "$COMPOSE_DIR" restart livekit
