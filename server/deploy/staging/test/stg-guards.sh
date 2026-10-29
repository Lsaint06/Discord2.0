#!/usr/bin/env bash
# Guard tests for stg.sh with a fake docker (no Docker, no network, no Jetson). Run: bash stg-guards.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
STG=$HERE/../stg.sh
COMPOSE=$(cd "$HERE/.." && pwd -P)/docker-compose.yml
REPO_SERVER=$(cd "$HERE/../../.." && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FAKE_LOG=$TMP/docker.log D2_DOCKER="bash $HERE/fake-docker.sh" D2_STAGING_WORK=$TMP/work D2_PROD_DIR=$TMP/prod D2_STAGING_ENV_FILE=$TMP/env
mkdir -p "$TMP/prod"
printf 'STAGING_LAN_IP=192.168.68.65\nSTAGING_LIVEKIT_API_KEY=APIstgtest\nSTAGING_LIVEKIT_API_SECRET=%s\n' "$(head -c 40 /dev/zero | tr '\0' x)" > "$TMP/env"

passed=0
failed=0
check() {
  local name=$1
  shift
  if "$@"; then passed=$((passed + 1)); echo "ok   $name"; else failed=$((failed + 1)); echo "FAIL $name"; sed 's/^/     | /' "$TMP/out" | tail -n 8; fi
}
run() { : > "$FAKE_LOG"; bash "$STG" "$@" > "$TMP/out" 2>&1; echo $? > "$TMP/code"; }
code() { [[ $(<"$TMP/code") == "$1" ]]; }
failed_run() { [[ $(<"$TMP/code") != 0 ]]; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }
not_logged() { ! grep -qF -- "$1" "$FAKE_LOG"; }
out_has() { grep -qF -- "$1" "$TMP/out"; }
# Every Compose call is pinned to the staging project and file, and never removes volumes.
compose_pinned() {
  ! grep '^compose' "$FAKE_LOG" | grep -vqF -- "compose -p d2staging -f $COMPOSE --env-file $TMP/env" &&
    ! grep -E '^compose' "$FAKE_LOG" | grep -qE -- '(^| )(-v|--volumes)( |$)'
}
never_touches_production_volume() { ! grep -vE '^(volume inspect|ps |inspect )' "$FAKE_LOG" | grep -qF server_discord2-data; }

run baseline
check "baseline records production" code 0
check "baseline file written" test -s "$TMP/work/production-baseline.txt"
run check-production
check "check-production: unchanged" code 0

FAKE_LK_STARTED=2026-10-29T09:00:00Z run check-production
check "check-production: a restarted production container stops the script" failed_run
check "  ...and says so" out_has "PRODUCTION CHANGED"

run up dev
check "up refuses anything but old|new" failed_run
check "  ...without starting anything" not_logged "up -d"
if bash -c "source '$STG'; guard_image discord2-server:dev" > /dev/null 2>&1; then check "guard_image refuses production's :dev tag" false; else check "guard_image refuses production's :dev tag" true; fi

FAKE_STAGING_RUNNING=1 run up new
check "up new" code 0
check "  ...uses the API 6 staging image" logged "IMG=discord2-server:1.4.0-rc1"
check "  ...compose pinned to d2staging, no volume removal" compose_pinned
FAKE_STAGING_RUNNING=1 run up old
check "up old uses production's image under its staging name" logged "IMG=discord2-server:m11-rollback"
check "  ...never the :dev tag" not_logged "IMG=discord2-server:dev"

run teardown <<< "nope"
check "teardown: wrong confirmation refused" failed_run
check "  ...nothing deleted" not_logged "volume rm"
run teardown <<< "d2staging_staging-data"
check "teardown: confirmed" code 0
check "  ...deletes exactly the staging volume" logged "volume rm d2staging_staging-data"
check "  ...compose pinned, no 'down -v'" compose_pinned
check "  ...never touches the production volume" never_touches_production_volume

FAKE_VOLUME_LABELS='server|discord2-data' run teardown <<< "d2staging_staging-data"
check "teardown: volume with production labels refused" failed_run
check "  ...nothing deleted" not_logged "volume rm"
FAKE_VOLUME_USERS=$'d2staging-server-1|d2staging\nserver-server-1|server' run teardown <<< "d2staging_staging-data"
check "teardown: volume used by a production container refused" failed_run
check "  ...nothing deleted" not_logged "volume rm"
FAKE_STAGING_VOLUME=0 run teardown
check "teardown: no staging volume, nothing to delete" code 0
check "  ...no volume rm" not_logged "volume rm"

mkdir -p "$TMP/work"
printf 'fake backup' > "$TMP/work/backup-pre.tgz"
(cd "$TMP/work" && sha256sum backup-pre.tgz > backup-pre.tgz.sha256)
FAKE_VOLUME_LABELS='server|discord2-data' run restore pre <<< "restore-pre"
check "restore: production-labelled volume refused" failed_run
check "  ...volume not emptied" not_logged "find /data -mindepth 1 -delete"
run restore pre <<< "wrong"
check "restore: wrong confirmation refused" failed_run
check "  ...volume not emptied" not_logged "find /data"
run restore pre <<< "restore-pre"
check "restore: confirmed" code 0
check "  ...empties and refills only the staging volume" logged "-v d2staging_staging-data:/data -v"
check "  ...(the emptying step)" logged "find /data -mindepth 1 -delete"
check "  ...keeps the replaced contents first" logged "replaced-"
check "  ...never touches the production volume" never_touches_production_volume
printf 'tampered' > "$TMP/work/backup-pre.tgz"
run restore pre <<< "restore-pre"
check "restore: checksum mismatch refused" failed_run

D2_PROD_DIR=$REPO_SERVER run config
check "refuses to run from production's checkout" failed_run
check "  ...and says why" out_has "production's"

D2_STAGING_ENV_FILE=$TMP/env2 run init-env 8.8.8.8
check "init-env: public address refused" failed_run
D2_STAGING_ENV_FILE=$TMP/env2 run init-env 192.168.68.65
check "init-env: private LAN address" code 0
check "  ...staging-only key" grep -q '^STAGING_LIVEKIT_API_KEY=APIstg' "$TMP/env2"
check "  ...long random secret" bash -c "[[ \$(sed -n 's/^STAGING_LIVEKIT_API_SECRET=//p' '$TMP/env2' | wc -c) -ge 33 ]]"
D2_STAGING_ENV_FILE=$TMP/env2 run init-env 192.168.68.65
check "init-env: never overwrites" failed_run

run snapshot '../../etc'
check "names are validated (no paths)" failed_run

# ---------------------------------------------------------------- preflight parsers
# Pure helpers from stg.sh, called by sourcing it (nothing runs: main only runs when executed).
in_stg() { bash -c 'stg=$1; shift; source "$stg" && "$@"' in_stg "$STG" "$@"; }

compose_ok() { in_stg compose_version_ok "$1"; }
compose_bad() { ! in_stg compose_version_ok "$1"; }
for v in 5.1.4 v5.1.4 'v5.1.4'$'\r' ' 5.1.4 ' 2.20.0 v2.20 2.20.1 2.24.6-desktop.1 2.29.7 2.100.0 3.0.0 08.1.0 10.0.0 2.20.1-rc.1 5.1.4+build.7; do
  check "compose $(printf '%q' "$v") is supported" compose_ok "$v"
done
for v in 2.19.9 2.2.0 v2.2.14 1.29.2 0.9.0 2.20.0-rc.1 '' v 5 5. 5.1.4.2 2.x.0 -5.1.4 'v 5.1.4' 'Docker Compose version v5.1.4' \
  "docker: 'compose' is not a docker command." 1234567.0.0 5.1.4-; do
  check "compose $(printf '%q' "$v") is refused" compose_bad "$v"
done

kind_is() { [[ $(in_stg ipv6_kind "$1") == "$2" ]] || { echo "     | $1 -> $(in_stg ipv6_kind "$1"), expected $2" > "$TMP/out"; false; }; }
while read -r addr want; do
  check "ipv6 $addr is $want" kind_is "$addr" "$want"
done << 'EOF'
fd7c:73c9:de8d:acc1:9190:2071:f383:68fd/64 unique-local
fd7c:73c9:de8d:acc1:c9c8:92de:485b:9544/64 unique-local
fd7c:73c9:de8d:acc1:ab2f:e5fa:1a78:60ef/64 unique-local
fc00::1 unique-local
FDFF:FFFF::1 unique-local
fbff:ffff::1 unclassified
fe80::1%eth0 link-local
fe80::1ff:fe23:4567:890a/64 link-local
febf:ffff::1 link-local
fec0::1 site-local
::1 loopback
0:0:0:0:0:0:0:1 loopback
::1/128 loopback
:: unspecified
ff02::1 multicast
2001:db8::1 global
2a02:1234:5678:9abc::1/64 global
2600:1f18:4a3:6900:8b62:9f1c:2d4e:7a10/128 global
3fff:ffff::1 global
1fff::1 unclassified
4000::1 unclassified
::ffff:192.0.2.1 unclassified
1:2:3:4:5:6:192.0.2.1 unclassified
fd7c:73c9:de8d:acc1:27fe:3f10:e38/64 invalid
1:2:3:4:5:6:7:8:9 invalid
fd00::1::2 invalid
fd00:::1 invalid
:1:2:3:4:5:6:7 invalid
1:2:3:4:5:6:7: invalid
gggg::1 invalid
12345::1 invalid
192.168.68.65 invalid
::ffff:300.1.1.1 invalid
1.2.3.4:: invalid
fd00::1,fd00::2 invalid
EOF
check "ipv6 empty input is invalid" kind_is "" invalid

ULA=$'2: eth0    inet6 fd7c:73c9:de8d:acc1:9190:2071:f383:68fd/64 scope global temporary dynamic \\       valid_lft 604523sec preferred_lft 85744sec\n2: eth0    inet6 fd7c:73c9:de8d:acc1:c9c8:92de:485b:9544/64 scope global temporary deprecated dynamic \\       valid_lft 518123sec preferred_lft 0sec\n2: eth0    inet6 fd7c:73c9:de8d:acc1:ab2f:e5fa:1a78:60ef/64 scope global dynamic mngtmpaddr noprefixroute \\       valid_lft forever preferred_lft forever'
PUBLIC=$'3: wlan0    inet6 2a02:1234:5678:9abc:1c2d:3e4f:5a6b:7c8d/64 scope global dynamic mngtmpaddr \\       valid_lft 86000sec preferred_lft 14000sec'
verdict_has() { printf '%s' "$1" | in_stg ipv6_preflight_verdict > "$TMP/out"; grep -qE -- "$2" "$TMP/out"; }
verdict_lacks() { ! grep -qE -- "$1" "$TMP/out"; }
check "verdict: the Jetson's unique-local addresses pass" verdict_has "$ULA" '^PASS only non-internet-routable IPv6 \(3'
check "verdict: no IPv6 at all passes" verdict_has '' '^PASS no global IPv6'
check "verdict: link-local and loopback only pass" verdict_has $'1: lo inet6 ::1/128 scope host\n2: eth0 inet6 fe80::1/64 scope link' '^PASS only'
check "verdict: a public address still warns" verdict_has "$PUBLIC" '^WARN .*2a02:1234:5678:9abc:1c2d:3e4f:5a6b:7c8d/64 \(global\)'
check "verdict: public mixed with unique-local warns" verdict_has "$ULA"$'\n'"$PUBLIC" '^WARN .*2a02:1234'
check "  ...naming only the public address" verdict_lacks 'fd7c'
check "verdict: an unparseable address warns (never assumed safe)" verdict_has '2: eth0 inet6 fd7c:73c9:de8d:acc1:27fe:3f10:e38/64 scope global' '^WARN .*\(invalid\)'
check "verdict: an unclassified address warns" verdict_has '2: eth0 inet6 4000::1/64 scope global' '^WARN .*\(unclassified\)'
check "verdict: one PUBLIC line without a trailing newline is read" verdict_has "$PUBLIC" '^WARN'

# ---------------------------------------------------------------- preflight end to end
# Host commands are stubbed (no real ip/ss/sudo/sysctl calls); Docker is the fake docker.
STUBS=$TMP/stubs
mkdir -p "$STUBS"
cat > "$STUBS/ip" << 'EOF'
#!/usr/bin/env bash
case "$*" in
  "-6 -o addr show scope global") [[ -n ${FAKE_IP6_FILE:-} ]] && cat "$FAKE_IP6_FILE"; exit 0 ;;
  "-4 -o addr show") echo "2: eth0    inet 192.168.68.65/22 brd 192.168.71.255 scope global eth0" ;;
  "route"|"route show default") echo "default via 192.168.68.1 dev eth0 proto static" ;;
esac
EOF
printf '#!/usr/bin/env bash\nprintf "              total        used        free      shared  buff/cache   available\\nMem:           7620        2800        1000         100        3800        4500\\nSwap:          3810           0        3810\\n"\n' > "$STUBS/free"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUBS/ss"
printf '#!/usr/bin/env bash\nprintf "Filesystem 1048576-blocks Used Available Capacity Mounted on\\n/dev/nvme0n1p1 469000 120000 330000 27%%%% /\\n"\n' > "$STUBS/df"
printf '#!/usr/bin/env bash\necho 212992\n' > "$STUBS/sysctl"
printf '#!/usr/bin/env bash\n[[ $1 == iptables ]] && echo "-P INPUT ACCEPT"\nexit 0\n' > "$STUBS/sudo"
chmod +x "$STUBS"/*
printf '%s\n' "$ULA" > "$TMP/ip6-ula"
printf '%s\n%s\n' "$ULA" "$PUBLIC" > "$TMP/ip6-mixed"
preflight() { PATH="$STUBS:$PATH" run preflight 192.168.68.65; }
read_only_docker() { ! grep -vE '^(info |compose version|ps |inspect |image inspect|volume inspect|network inspect|network ls)' "$FAKE_LOG"; }

FAKE_COMPOSE_VERSION=5.1.4 FAKE_IP6_FILE=$TMP/ip6-ula preflight
check "preflight: Compose 5.1.4 passes" out_has "PASS  Compose 5.1.4 (>= 2.20.0)"
check "  ...no Compose failure" bash -c "! grep -q 'FAIL  Compose' '$TMP/out'"
check "  ...the Jetson's unique-local IPv6 addresses pass" out_has "PASS  only non-internet-routable IPv6 (3"
check "  ...no IPv6 warning" bash -c "! grep -qE 'WARN .*IPv6' '$TMP/out'"
check "  ...Docker was only queried (read-only)" read_only_docker
check "  ...nothing started or created" not_logged "up -d"
FAKE_COMPOSE_VERSION=2.19.3 preflight
check "preflight: Compose 2.19.3 still fails" out_has "FAIL  Compose 2.20.0 or newer needed (found '2.19.3')"
check "  ...and preflight exits non-zero" failed_run
FAKE_COMPOSE_VERSION= preflight
check "preflight: no Compose output fails" out_has "FAIL  Compose 2.20.0 or newer needed (found 'none')"
FAKE_IP6_FILE=$TMP/ip6-mixed preflight
check "preflight: a public IPv6 address still warns" out_has "WARN  IPv6 address(es) not proven LAN-only: 2a02:1234:5678:9abc:1c2d:3e4f:5a6b:7c8d/64 (global)"

echo
echo "stg.sh guard tests: $passed passed, $failed failed"
((failed == 0))
