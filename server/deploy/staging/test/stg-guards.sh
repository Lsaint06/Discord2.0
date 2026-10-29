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

echo
echo "stg.sh guard tests: $passed passed, $failed failed"
((failed == 0))
