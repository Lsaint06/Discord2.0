#!/usr/bin/env bash
# Stand-in for `docker` in the stg.sh guard tests: records every call (with the image Compose would
# use) in $FAKE_LOG and answers the few queries stg.sh makes, from FAKE_* variables. Never runs Docker.
printf '%s IMG=%s\n' "$*" "${STAGING_SERVER_IMAGE:-}" >> "${FAKE_LOG:?}"
case "$1 $2" in
  "ps -aq")
    [[ $* == *"label=com.docker.compose.project=server"* ]] && printf 'prod-livekit-id\nprod-server-id\n'
    exit 0 ;;
  "ps -q")
    [[ $* == *"project=d2staging"* && ${FAKE_STAGING_RUNNING:-0} == 1 ]] && echo stg-server-id
    exit 0 ;;
  "ps -a")
    printf '%s\n' "${FAKE_VOLUME_USERS:-d2staging-server-1|d2staging}"
    exit 0 ;;
  "volume inspect")
    if [[ $* == *d2staging_staging-data* ]]; then
      [[ ${FAKE_STAGING_VOLUME:-1} == 1 ]] || exit 1
      [[ $* == *Labels* ]] && echo "${FAKE_VOLUME_LABELS:-d2staging|staging-data}"
      exit 0
    fi
    [[ $* == *server_discord2-data* ]] && echo "server_discord2-data created=2026-10-27T10:00:00Z mount=/var/lib/docker/volumes/server_discord2-data/_data"
    exit 0 ;;
  "image inspect")
    [[ $* == *"tag discord2-server:dev"* ]] && echo "tag discord2-server:dev sha256:prodimage"
    exit 0 ;;
  "inspect -f")
    if [[ $* == *prod-server-id* ]]; then
      printf '/server-livekit-1 id=prod-livekit-id image=sha256:lk started=%s restarts=0\n' "${FAKE_LK_STARTED:-2026-10-26T22:48:26Z}"
      printf '/server-server-1 id=prod-server-id image=sha256:prodimage started=2026-10-28T07:05:14Z restarts=0\n'
      exit 0
    fi
    echo healthy
    exit 0 ;;
  "network inspect")
    echo d2staging
    exit 0 ;;
  "compose -p")
    [[ $* == *" ps -q server"* ]] && echo stg-server-id
    exit 0 ;;
  *) exit 0 ;;
esac
