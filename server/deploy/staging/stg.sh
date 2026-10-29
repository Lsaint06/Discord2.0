#!/usr/bin/env bash
# Discord 2.0 v1.4.0 STAGING helper (synthetic data only). Runs on the Jetson from the separate
# release checkout (~/d2-v140/server/deploy/staging), side by side with production, which it never
# changes. Every subcommand is a separate, reviewable step; see docs/v1.4.0-staging-plan.md.
#
#   ./stg.sh help
#
# Safety rules built in:
#  - every Compose call is pinned to project "d2staging" and this directory's docker-compose.yml;
#  - refuses to run from production's checkout, and refuses any image except the two staging ones
#    (never production's discord2-server:dev);
#  - destructive steps (restore, teardown) only accept the volume "d2staging_staging-data" when its
#    Compose labels say it belongs to d2staging and no other project's container uses it, and they
#    ask you to type the exact name;
#  - production's containers, image and volume are fingerprinted once (`baseline`) and re-checked
#    after every step that changes something; any difference stops the script.
set -Eeuo pipefail

PROJECT=d2staging
STG_VOLUME=d2staging_staging-data
NETWORK=d2staging_default
SUBNET=172.30.99.0/24
NEW_IMAGE=discord2-server:1.4.0-rc1
OLD_IMAGE=discord2-server:m11-rollback
PROD_TAG=discord2-server:dev
LIVEKIT_IMAGE=livekit/livekit-server:v1.13.11
PROD_PROJECT=server
PROD_VOLUME=server_discord2-data
PORTS_TCP=(3901 7980 7981)
PORTS_UDP=(7982)
BASE=http://server:3001

STG_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SERVER_DIR=$(cd "$STG_DIR/../.." && pwd -P)
COMPOSE_FILE=$STG_DIR/docker-compose.yml
ENV_FILE=${D2_STAGING_ENV_FILE:-$STG_DIR/.env.staging}
WORK=${D2_STAGING_WORK:-$HOME/d2-staging-work}
PROD_DIR=${D2_PROD_DIR:-$HOME/Discord2.0/server}
read -r -a DOCKER_CMD <<< "${D2_DOCKER:-sudo docker}"

die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

dk() { "${DOCKER_CMD[@]}" "$@"; }
# Docker with one extra environment variable (sudo drops the caller's environment).
dk_env() {
  local kv=$1
  shift
  if [[ ${DOCKER_CMD[0]} == sudo ]]; then sudo env "$kv" "${DOCKER_CMD[@]:1}" "$@"; else env "$kv" "${DOCKER_CMD[@]}" "$@"; fi
}

current_image() {
  local which=new
  [[ -f $WORK/current-image ]] && which=$(<"$WORK/current-image")
  case $which in
    old) echo "$OLD_IMAGE" ;;
    new) echo "$NEW_IMAGE" ;;
    *) die "unexpected $WORK/current-image: $which" ;;
  esac
}

compose() {
  [[ -f $ENV_FILE ]] || die "$ENV_FILE is missing: run ./stg.sh init-env <LAN IP> first"
  local img
  img=$(current_image)
  guard_image "$img"
  dk_env "STAGING_SERVER_IMAGE=$img" compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# ---------------------------------------------------------------- guards

guard_image() {
  case $1 in
    "$NEW_IMAGE" | "$OLD_IMAGE") ;;
    *) die "image '$1' is not a staging image (allowed: $NEW_IMAGE, $OLD_IMAGE; never $PROD_TAG)" ;;
  esac
}

guard_layout() {
  [[ -f $COMPOSE_FILE ]] || die "missing $COMPOSE_FILE"
  grep -qx 'name: d2staging' "$COMPOSE_FILE" || die "$COMPOSE_FILE is not the d2staging Compose file"
  local stg_top prod_top=''
  stg_top=$(git -C "$STG_DIR" rev-parse --show-toplevel 2>/dev/null || true)
  [[ -n $stg_top ]] || die "$STG_DIR is not inside a Git checkout (use the release checkout ~/d2-v140)"
  if [[ -d $PROD_DIR ]]; then
    prod_top=$(git -C "$PROD_DIR" rev-parse --show-toplevel 2>/dev/null || true)
    local prod_real
    prod_real=$(cd "$PROD_DIR" && pwd -P)
    [[ $STG_DIR/ == "$prod_real"/* ]] && die "this script is inside production's folder $PROD_DIR; use the separate release checkout"
    [[ -n $prod_top && $(cd "$stg_top" && pwd -P) == $(cd "$prod_top" && pwd -P) ]] &&
      die "this checkout ($stg_top) is production's checkout; use the separate release checkout"
    [[ $(realpath -m "$WORK")/ == "$prod_real"/* ]] && die "the work folder $WORK is inside production's folder"
  fi
  case $WORK in /|/root|/home|"$HOME") die "unsafe work folder: $WORK" ;; esac
  return 0
}

ensure_work() {
  guard_layout
  (umask 077 && mkdir -p "$WORK")
  chmod 700 "$WORK"
}

# The staging volume, and only it: right name, d2staging's Compose labels, used by no other project.
guard_staging_volume() {
  [[ $STG_VOLUME == "$PROD_VOLUME" || $STG_VOLUME == *discord2-data* || $STG_VOLUME != d2staging_* ]] &&
    die "refusing volume name $STG_VOLUME"
  local labels
  labels=$(dk volume inspect -f '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' "$STG_VOLUME" 2>/dev/null) ||
    die "volume $STG_VOLUME does not exist"
  [[ $labels == "d2staging|staging-data" ]] || die "volume $STG_VOLUME is labelled '$labels', not 'd2staging|staging-data'"
  local users name proj
  users=$(dk ps -a --filter "volume=$STG_VOLUME" --format '{{.Names}}|{{.Label "com.docker.compose.project"}}')
  while IFS='|' read -r name proj; do
    [[ -z $name ]] && continue
    [[ $proj == "$PROJECT" ]] || die "volume $STG_VOLUME is used by container $name of project '$proj'"
  done <<< "$users"
}

confirm() {
  local want=$1 answer
  printf 'Type %s to continue: ' "$want"
  read -r answer || true
  [[ $answer == "$want" ]] || die "not confirmed; nothing was changed"
}

# ---------------------------------------------------------------- production fingerprint

production_state() {
  local ids
  ids=$(dk ps -aq --filter "label=com.docker.compose.project=$PROD_PROJECT" | sort)
  if [[ -z $ids ]]; then
    echo "containers: none"
  else
    # shellcheck disable=SC2086
    dk inspect -f '{{.Name}} id={{.Id}} image={{.Image}} started={{.State.StartedAt}} restarts={{.RestartCount}}' $ids | sort
  fi
  dk image inspect -f "tag $PROD_TAG {{.Id}}" "$PROD_TAG" 2>/dev/null || echo "tag $PROD_TAG missing"
  dk volume inspect -f '{{.Name}} created={{.CreatedAt}} mount={{.Mountpoint}}' "$PROD_VOLUME" 2>/dev/null || echo "volume $PROD_VOLUME missing"
}

check_production() {
  [[ -f $WORK/production-baseline.txt ]] || die "no production baseline: run ./stg.sh baseline first"
  local now
  now=$(production_state)
  if [[ $now != "$(<"$WORK/production-baseline.txt")" ]]; then
    printf '%s\n' "$now" > "$WORK/production-now.txt"
    diff "$WORK/production-baseline.txt" "$WORK/production-now.txt" >&2 || true
    die "PRODUCTION CHANGED since the baseline (containers, image or volume). Stop and investigate; staging did not touch it by design."
  fi
  info "production unchanged since the baseline"
}

# ---------------------------------------------------------------- helpers

staging_running() { [[ -n $(dk ps -q --filter "label=com.docker.compose.project=$PROJECT") ]]; }

ports_free() {
  local p busy=0
  for p in "${PORTS_TCP[@]}"; do
    if ss -Htln "sport = :$p" | grep -q .; then info "  port $p/tcp is in use"; busy=1; fi
  done
  for p in "${PORTS_UDP[@]}"; do
    if ss -Huln "sport = :$p" | grep -q .; then info "  port $p/udp is in use"; busy=1; fi
  done
  ((busy == 0)) || die "staging ports are in use (by something other than staging)"
}

wait_healthy() {
  local id status i
  id=$(compose ps -q server)
  [[ -n $id ]] || die "staging server container not found"
  for ((i = 0; i < 60; i++)); do
    status=$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
    [[ $status == healthy ]] && { info "staging server healthy"; return 0; }
    [[ $status == unhealthy ]] && break
    sleep 2
  done
  compose logs --tail 60 server >&2 || true
  die "staging server did not become healthy (status: $status)"
}

run_tool() {
  local script=$1
  shift
  dk network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$NETWORK" 2>/dev/null | grep -qx "$PROJECT" ||
    die "staging network $NETWORK not found (start staging first)"
  dk run --rm --network "$NETWORK" --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --label "com.docker.compose.project=$PROJECT-tools" \
    -e D2_STAGING_TOOLS=1 -e D2_SYNTHETIC_PASSWORD_FILE=/work/synthetic-password \
    -v "$STG_DIR/tools:/tools:ro" -v "$WORK:/work" -w /work "$NEW_IMAGE" node "/tools/$script" "$@"
}

valid_name() { [[ $1 =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "use a short lowercase name (a-z, 0-9, -): '$1'"; }

# ---------------------------------------------------------------- subcommands

cmd_preflight() {
  local lan=${1:-}
  local fails=0 warns=0
  pass() { printf '  PASS  %s\n' "$*"; }
  warn() { printf '  WARN  %s\n' "$*"; warns=$((warns + 1)); }
  fail() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
  [[ -z $lan && -f $ENV_FILE ]] && lan=$(sed -n 's/^STAGING_LAN_IP=//p' "$ENV_FILE")
  lan=${lan:-192.168.68.65}
  step "Preflight (read-only: nothing is created, started, stopped or changed)"

  info "-- host"
  [[ $EUID -ne 0 ]] && pass "running as $(id -un), Docker through sudo" || fail "run as your normal user, not root"
  [[ $(uname -m) == aarch64 ]] && pass "architecture aarch64" || warn "architecture $(uname -m) (expected aarch64 on the Jetson)"
  [[ -r /etc/nv_tegra_release ]] && info "  $(head -n1 /etc/nv_tegra_release)"
  local avail total swap
  read -r total avail < <(free -m | awk '/^Mem:/ {print $2, $7}')
  swap=$(free -m | awk '/^Swap:/ {print $2}')
  info "  memory: total ${total} MB, available ${avail} MB, swap ${swap} MB"
  ((avail >= 3000)) && pass "available memory >= 3000 MB (staging is limited to 2 x 1 GB)" ||
    { ((avail >= 2000)) && warn "available memory ${avail} MB (tight; close other work)" || fail "available memory ${avail} MB < 2000 MB"; }
  local cores load1
  cores=$(nproc)
  load1=$(cut -d' ' -f1 /proc/loadavg)
  info "  CPU: $cores cores, load (1 min) $load1"
  awk -v l="$load1" -v c="$cores" 'BEGIN{exit !(l < c*0.6)}' && pass "CPU load below 60%" || warn "CPU busy (load $load1 on $cores cores): pick a quieter time"
  local root_free docker_free home_free
  docker_free=$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
  root_free=$(df -Pm / | awk 'NR==2 {print $4}')
  home_free=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
  info "  free disk: / ${root_free} MB, /var/lib/docker ${docker_free:-?} MB, \$HOME ${home_free} MB"
  ((${docker_free:-$root_free} >= 4096)) && pass "Docker disk has >= 4 GB free (image build + staging data)" || fail "less than 4 GB free for Docker"
  ((home_free >= 1024)) && pass "home has >= 1 GB free (backups, snapshots)" || fail "less than 1 GB free in \$HOME"

  info "-- Docker"
  if dk info --format '  engine {{.ServerVersion}}, storage {{.Driver}}, cgroup {{.CgroupVersion}}, containers running {{.ContainersRunning}}' 2>/dev/null; then
    pass "Docker engine reachable"
  else
    fail "docker info failed"
  fi
  local cv
  cv=$(dk compose version --short 2>/dev/null || true)
  [[ $cv =~ ^v?2\.([0-9]+) ]] && ((BASH_REMATCH[1] >= 20)) && pass "Compose $cv" || fail "Compose v2.20+ needed (found '${cv:-none}')"

  info "-- production (read-only)"
  local ids name health
  ids=$(dk ps -aq --filter "label=com.docker.compose.project=$PROD_PROJECT")
  if [[ -z $ids ]]; then
    fail "no production containers found (project '$PROD_PROJECT')"
  else
    # shellcheck disable=SC2086
    while read -r name state health; do
      info "  $name: $state, health $health"
      [[ $state == running ]] || fail "$name is $state"
      [[ $health == healthy || $health == none ]] || warn "$name health is $health"
    done < <(dk inspect -f '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $ids)
    pass "production containers listed"
    info "  mounts:"
    # shellcheck disable=SC2086
    dk inspect -f '{{.Name}}{{range .Mounts}} | {{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{end}}' $ids | sed 's/^/    /'
  fi
  local prod_img dev_img
  prod_img=$(dk inspect -f '{{.Image}}' "$(dk ps -q --filter "label=com.docker.compose.project=$PROD_PROJECT" --filter label=com.docker.compose.service=server | head -n1)" 2>/dev/null || true)
  dev_img=$(dk image inspect -f '{{.Id}}' "$PROD_TAG" 2>/dev/null || true)
  [[ -n $prod_img && $prod_img == "$dev_img" ]] && pass "production server runs $PROD_TAG (${dev_img:7:12})" || fail "production server image (${prod_img:-?}) is not $PROD_TAG (${dev_img:-missing})"
  dk volume inspect -f '  volume {{.Name}} at {{.Mountpoint}}' "$PROD_VOLUME" 2>/dev/null && pass "production volume present" || fail "production volume $PROD_VOLUME not found"
  dk image inspect "$LIVEKIT_IMAGE" >/dev/null 2>&1 && pass "$LIVEKIT_IMAGE present (staging never pulls)" || fail "$LIVEKIT_IMAGE missing"
  if [[ -d $PROD_DIR ]]; then
    info "  production checkout: $(git -C "$PROD_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git -C "$PROD_DIR" rev-parse --short HEAD 2>/dev/null)"
  fi

  info "-- staging resources must not exist yet / must not collide"
  dk volume inspect "$STG_VOLUME" >/dev/null 2>&1 && warn "staging volume $STG_VOLUME already exists (left from an earlier run?)" || pass "no staging volume yet"
  dk network inspect "$NETWORK" >/dev/null 2>&1 && warn "staging network $NETWORK already exists" || pass "no staging network yet"
  local nets clash=''
  nets=$(dk network ls -q)
  # shellcheck disable=SC2086
  clash=$(dk network inspect -f '{{.Name}}{{range .IPAM.Config}} {{.Subnet}}{{end}}' $nets 2>/dev/null | grep -F '172.30.99.' | grep -v "^$NETWORK " || true)
  [[ -z $clash ]] && pass "no Docker network uses $SUBNET" || fail "Docker network already uses $SUBNET: $clash"
  ip route | grep -qE '172\.30\.99\.|^172\.30\.0\.0/16' && fail "a host route overlaps $SUBNET" || pass "no host route overlaps $SUBNET"
  if staging_running; then
    warn "staging containers are running; port check skipped"
  else
    local p busy=0
    for p in "${PORTS_TCP[@]}"; do ss -Htln "sport = :$p" | grep -q . && { fail "port $p/tcp in use"; busy=1; }; done
    for p in "${PORTS_UDP[@]}"; do ss -Huln "sport = :$p" | grep -q . && { fail "port $p/udp in use"; busy=1; }; done
    ((busy == 0)) && pass "ports 3901, 7980, 7981/tcp and 7982/udp are free"
  fi
  for image in "$NEW_IMAGE" "$OLD_IMAGE"; do
    dk image inspect "$image" >/dev/null 2>&1 && info "  image $image exists" || info "  image $image not built/tagged yet (./stg.sh build)"
  done

  info "-- network reachability for two PCs"
  ip -4 -o addr show | awk '{print $4}' | grep -q "^$lan/" && pass "the Jetson has LAN address $lan" || fail "$lan is not an address of this machine"
  info "  default route: $(ip route show default | head -n1)"
  if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    warn "ufw is active: allow 3901,7980,7981/tcp and 7982/udp from the LAN only (see the plan)"
  else
    pass "no active ufw"
  fi
  info "  iptables INPUT policy: $(sudo iptables -S INPUT 2>/dev/null | head -n1 || echo unknown)"
  if ip -6 -o addr show scope global 2>/dev/null | grep -q .; then
    warn "global IPv6 address present: LiveKit listens on all interfaces; make sure the router does not allow inbound IPv6 to 7980-7982 (staging must stay LAN-only)"
  else
    pass "no global IPv6 address (IPv4 LAN only; the router forwards none of 3901/7980-7982)"
  fi
  info "  UDP buffers: rmem_max $(sysctl -n net.core.rmem_max), wmem_max $(sysctl -n net.core.wmem_max) (LiveKit warns below 5 MB; production runs the same)"
  command -v tegrastats >/dev/null && pass "tegrastats available for CPU measurements" || warn "tegrastats not found"

  info "-- release checkout and staging files"
  info "  release checkout: $(git -C "$STG_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git -C "$STG_DIR" rev-parse --short HEAD 2>/dev/null)"
  [[ -z $(git -C "$STG_DIR" status --porcelain --untracked-files=no 2>/dev/null) ]] && pass "release checkout has no modified files" || warn "release checkout has modified files"
  if (guard_layout) 2>/dev/null; then pass "release checkout is separate from production's"; else fail "release checkout layout check failed (run ./stg.sh config to see why)"; fi
  if [[ -f $ENV_FILE ]]; then
    [[ $(stat -c %a "$ENV_FILE") == 600 ]] && pass ".env.staging is mode 600" || fail ".env.staging must be mode 600"
  else
    info "  .env.staging not created yet (./stg.sh init-env $lan)"
  fi

  printf '\nPreflight: %d FAIL, %d WARN\n' "$fails" "$warns"
  ((fails == 0)) || exit 1
}

cmd_baseline() {
  ensure_work
  [[ -f $WORK/production-baseline.txt ]] && die "baseline exists ($WORK/production-baseline.txt); delete it only if you know production changed on purpose"
  production_state > "$WORK/production-baseline.txt"
  grep -q 'containers: none' "$WORK/production-baseline.txt" && { rm -f "$WORK/production-baseline.txt"; die "no production containers found"; }
  cat "$WORK/production-baseline.txt"
  info "baseline saved to $WORK/production-baseline.txt (read-only snapshot of production)"
}

cmd_init_env() {
  local lan=${1:?usage: ./stg.sh init-env <Jetson LAN IP, e.g. 192.168.68.65>}
  [[ $lan =~ ^(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9.]+$ ]] || die "$lan is not a private IPv4 address"
  ensure_work
  [[ -e $ENV_FILE ]] && die "$ENV_FILE exists already"
  local key secret
  key=APIstg$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  secret=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n')
  (umask 077 && printf 'STAGING_LAN_IP=%s\nSTAGING_LIVEKIT_API_KEY=%s\nSTAGING_LIVEKIT_API_SECRET=%s\n' "$lan" "$key" "$secret" > "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  info "wrote $ENV_FILE (mode 600, new staging-only LiveKit key $key)"
}

cmd_config() {
  guard_layout
  compose config --quiet && info "staging Compose file is valid"
  compose config | grep -E '^  [a-z]+:$|image:|published:|host_ip:|port: 79|tcp_port|udp_port|node_ip|subnet' | sed 's/^/  /'
}

cmd_build() {
  ensure_work
  check_production
  step "Building $NEW_IMAGE from $SERVER_DIR ($(git -C "$SERVER_DIR" rev-parse --short HEAD))"
  dk build --progress=plain -t "$NEW_IMAGE" "$SERVER_DIR" 2>&1 | tee "$WORK/build.log"
  grep -E 'sharp [0-9]' "$WORK/build.log" || die "sharp check missing from the build log"
  info "architecture: $(dk image inspect -f '{{.Architecture}}' "$NEW_IMAGE")"
  local dev_id old_id
  dev_id=$(dk image inspect -f '{{.Id}}' "$PROD_TAG")
  old_id=$(dk image inspect -f '{{.Id}}' "$OLD_IMAGE" 2>/dev/null || true)
  if [[ -z $old_id ]]; then
    # An extra name for production's current image (the image and :dev are unchanged).
    dk tag "$PROD_TAG" "$OLD_IMAGE"
    info "tagged production's current image ${dev_id:7:12} also as $OLD_IMAGE"
  elif [[ $old_id != "$dev_id" ]]; then
    die "$OLD_IMAGE exists but is not production's current image; inspect before continuing"
  fi
  check_production
}

cmd_up() {
  local which=${1:-} img
  case $which in
    old) img=$OLD_IMAGE ;;
    new) img=$NEW_IMAGE ;;
    *) die "usage: ./stg.sh up old|new   (old = $OLD_IMAGE, API 4; new = $NEW_IMAGE, API 6)" ;;
  esac
  guard_image "$img"
  ensure_work
  check_production
  dk image inspect "$img" >/dev/null 2>&1 || die "$img not found (./stg.sh build)"
  dk image inspect "$LIVEKIT_IMAGE" >/dev/null 2>&1 || die "$LIVEKIT_IMAGE not found"
  staging_running || ports_free
  echo "$which" > "$WORK/current-image"
  step "Starting staging with $img"
  compose up -d --no-build --pull never
  wait_healthy
  check_production
}

cmd_create_owner() {
  ensure_work
  [[ $(current_image) == "$OLD_IMAGE" ]] || die "create the owner while staging runs the API 4 image (./stg.sh up old), like production"
  [[ -e $WORK/synthetic-password ]] && die "$WORK/synthetic-password exists already"
  (umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | head -c 24 > "$WORK/synthetic-password" && echo >> "$WORK/synthetic-password")
  compose exec -T server node dist/cli/admin.js create-admin --username owner --own-unowned-servers < "$WORK/synthetic-password"
  info "owner created; every synthetic account uses the password in $WORK/synthetic-password"
}

cmd_seed() {
  ensure_work
  case ${1:-} in
    api4) [[ $(current_image) == "$OLD_IMAGE" ]] || die "phase 1 runs on the API 4 image (./stg.sh up old)"; run_tool seed-api4.mjs "$BASE" /work/state.json ;;
    api6) [[ $(current_image) == "$NEW_IMAGE" ]] || die "phase 2 runs on the API 6 image (./stg.sh up new)"; run_tool seed-api6.mjs "$BASE" /work/state.json ;;
    *) die "usage: ./stg.sh seed api4|api6" ;;
  esac
}

cmd_snapshot() {
  local name=${1:-}
  valid_name "$name"
  ensure_work
  [[ -e $WORK/snap-$name.json ]] && die "snapshot $name exists"
  run_tool snapshot.mjs "$BASE" /work/state.json "/work/snap-$name.json"
}

cmd_compare() {
  local a=${1:-} b=${2:-} mode=${3:-strict}
  valid_name "$a"
  valid_name "$b"
  [[ $mode == strict || $mode == upgrade ]] || die "mode is strict or upgrade"
  ensure_work
  run_tool compare.mjs "/work/snap-$a.json" "/work/snap-$b.json" "$mode" | tee "$WORK/compare-$a-$b.json"
}

cmd_writes() {
  local label=${1:-}
  valid_name "$label"
  ensure_work
  run_tool writes.mjs "$BASE" /work/state.json "$label" | tee "$WORK/writes-$label.json"
}

cmd_bench() {
  ensure_work
  [[ $(current_image) == "$NEW_IMAGE" ]] || die "the benchmark needs the API 6 image"
  run_tool bench-animated.mjs "$BASE" /work/state.json | tee "$WORK/bench-animated.json"
}

cmd_verify() {
  ensure_work
  compose exec -T server node dist/cli/admin.js verify
}

cmd_dbstats() {
  local name=${1:-}
  valid_name "$name"
  ensure_work
  compose exec -T server node - /data/discord2.db < "$STG_DIR/tools/dbstats.cjs" | tee "$WORK/dbstats-$name.json"
}

cmd_backup() {
  local name=${1:-}
  valid_name "$name"
  ensure_work
  guard_staging_volume
  local file=backup-$name.tgz
  [[ -e $WORK/$file ]] && die "$WORK/$file exists"
  step "Consistent backup of the staging volume (staging server stopped briefly, like production's procedure)"
  compose stop server
  dk run --rm --network none --user 0:0 --entrypoint sh -v "$STG_VOLUME:/data:ro" -v "$WORK:/backup" "$NEW_IMAGE" \
    -c "tar -C /data -czf /backup/$file . && chown $(id -u):$(id -g) /backup/$file && chmod 600 /backup/$file"
  compose start server
  wait_healthy
  (cd "$WORK" && sha256sum "$file" > "$file.sha256" && cat "$file.sha256")
  check_production
}

cmd_verify_backup() {
  local name=${1:-}
  valid_name "$name"
  ensure_work
  local file=backup-$name.tgz
  (cd "$WORK" && sha256sum -c "$file.sha256")
  local v
  v=$(mktemp -d /tmp/d2stg-verify.XXXXXX)
  step "Restoring $file into scratch folder $v and checking it with the OLD image (no network)"
  dk run --rm --network none --user 0:0 --entrypoint sh -v "$WORK:/backup:ro" -v "$v:/v" "$NEW_IMAGE" -c "tar -xzf /backup/$file -C /v"
  dk run --rm --network none --user 0:0 -v "$v:/v" -e NODE_ENV=production -e DEV_AUTH=false -e DATABASE_URL=sqlite:/v/discord2.db \
    "$OLD_IMAGE" node dist/cli/admin.js verify | tee "$WORK/verify-backup-$name.txt"
  dk run --rm --network none --user 0:0 -v "$v:/v" -v "$STG_DIR/tools:/tools:ro" "$OLD_IMAGE" node /tools/dbstats.cjs /v/discord2.db |
    tee "$WORK/dbstats-backup-$name.json"
  info "attachment files in backup: $(dk run --rm --network none --user 0:0 --entrypoint sh -v "$v:/v" "$NEW_IMAGE" -c 'find /v/attachments -type f 2>/dev/null | wc -l')"
  dk run --rm --network none --user 0:0 --entrypoint sh -v "$v:/v" "$NEW_IMAGE" -c 'find /v -mindepth 1 -delete'
  rmdir "$v"
}

cmd_restore() {
  local name=${1:-}
  valid_name "$name"
  ensure_work
  guard_staging_volume
  local file=backup-$name.tgz
  (cd "$WORK" && sha256sum -c "$file.sha256")
  step "R3 rehearsal: replace the STAGING volume's contents with $file (production is not involved)"
  confirm "restore-$name"
  compose stop server
  local ts
  ts=$(date +%Y%m%d-%H%M%S)
  dk run --rm --network none --user 0:0 --entrypoint sh -v "$STG_VOLUME:/data:ro" -v "$WORK:/backup" "$NEW_IMAGE" \
    -c "tar -C /data -czf /backup/replaced-$ts.tgz . && chown $(id -u):$(id -g) /backup/replaced-$ts.tgz && chmod 600 /backup/replaced-$ts.tgz"
  guard_staging_volume
  dk run --rm --network none --user 0:0 --entrypoint sh -v "$STG_VOLUME:/data" -v "$WORK:/backup:ro" "$NEW_IMAGE" \
    -c "find /data -mindepth 1 -delete && tar -xzf /backup/$file -C /data"
  info "restored; the previous contents are in $WORK/replaced-$ts.tgz. Start it with ./stg.sh up old (or new)."
  check_production
}

cmd_status() {
  ensure_work
  local lan
  lan=$(sed -n 's/^STAGING_LAN_IP=//p' "$ENV_FILE" 2>/dev/null || true)
  step "staging"
  compose ps || true
  [[ -n $lan ]] && { curl -s -m 5 "http://$lan:3901/api/meta" || echo "staging API not reachable"; echo; }
  step "production (read-only)"
  dk ps --filter "label=com.docker.compose.project=$PROD_PROJECT" --format '  {{.Names}}: {{.Status}}'
  curl -s -m 5 "http://${lan:-192.168.68.65}:3001/api/meta" || echo "production LAN API not reachable"
  echo
  check_production
}

cmd_down() {
  ensure_work
  step "Stopping staging (containers and network removed; the staging volume and $WORK are kept)"
  compose down --remove-orphans
  check_production
}

cmd_teardown() {
  ensure_work
  step "Teardown: staging containers, network and the staging volume $STG_VOLUME"
  compose down --remove-orphans
  if dk volume inspect "$STG_VOLUME" >/dev/null 2>&1; then
    guard_staging_volume
    confirm "$STG_VOLUME"
    dk volume rm "$STG_VOLUME"
  else
    info "staging volume already gone"
  fi
  check_production
  info "kept: images $NEW_IMAGE and $OLD_IMAGE (needed for the deployment), $ENV_FILE and $WORK"
  info "(backups, snapshots and the synthetic state/password). Delete them yourself when done: rm -rf $WORK $ENV_FILE"
}

cmd_logs() { ensure_work; compose logs --tail "${2:-200}" "${1:-server}"; }
cmd_password() { ensure_work; cat "$WORK/synthetic-password"; }

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}"
  cat << 'EOF'

Read-only:   preflight [LAN IP] | config | status | check-production | logs [service] | password
Setup:       baseline | init-env <LAN IP> | build | up old|new | create-owner
Data:        seed api4|api6 | snapshot <name> | compare <a> <b> [strict|upgrade] | writes <label>
             verify | dbstats <name> | bench
Backups:     backup <name> | verify-backup <name> | restore <name>   (restore asks for confirmation)
Shutdown:    down (keeps the staging volume) | teardown (deletes ONLY the staging volume; asks)
EOF
}

main() {
  local cmd=${1:-help}
  shift || true
  case $cmd in
    preflight) cmd_preflight "$@" ;;
    baseline) cmd_baseline ;;
    check-production) ensure_work; check_production ;;
    init-env) cmd_init_env "$@" ;;
    config) cmd_config ;;
    build) cmd_build ;;
    up) cmd_up "$@" ;;
    create-owner) cmd_create_owner ;;
    seed) cmd_seed "$@" ;;
    snapshot) cmd_snapshot "$@" ;;
    compare) cmd_compare "$@" ;;
    writes) cmd_writes "$@" ;;
    bench) cmd_bench ;;
    verify) cmd_verify ;;
    dbstats) cmd_dbstats "$@" ;;
    backup) cmd_backup "$@" ;;
    verify-backup) cmd_verify_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    status) cmd_status ;;
    down) cmd_down ;;
    teardown) cmd_teardown ;;
    logs) cmd_logs "$@" ;;
    password) cmd_password ;;
    help | -h | --help) usage ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
