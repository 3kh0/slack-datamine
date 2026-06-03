#!/usr/bin/env bash
# keep watching slack
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] && set -a && . ./.env && set +a

RUNTIME="${RUNTIME:-node}"
CDP_PORT="${CDP_PORT:-9222}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-queue/html}"
WATCH_INTERVAL="${WATCH_INTERVAL:-1}"
SNAPSHOT_TIMEOUT="${SNAPSHOT_TIMEOUT:-30}"
FETCH_CLIENT_HTML="${FETCH_CLIENT_HTML:-1}"
WATCH_LOG_DUPLICATES="${WATCH_LOG_DUPLICATES:-0}"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

json_arg() {
  "$RUNTIME" -e "const m=JSON.parse(process.argv[1]); console.log($1 || '')" "$2"
}

last_hash() {
  "$RUNTIME" -e "try { console.log(require('./build/meta.json').versionHash || '') } catch { console.log('') }"
}

snapshot_once() {
  local ready build hash existed skipped current_hash
  local args=(bin/snapshot-cdp.js --port "$CDP_PORT" --dir "$SNAPSHOT_DIR")
  [ "$FETCH_CLIENT_HTML" != "0" ] && args+=(--fetch-client)

  current_hash="$(last_hash)"
  [ -n "$current_hash" ] && args+=(--skip-hash "$current_hash")

  if command -v timeout >/dev/null 2>&1; then
    if ! ready="$(timeout "$SNAPSHOT_TIMEOUT" "$RUNTIME" "${args[@]}")"; then
      log "CDP snapshot failed"
      return 1
    fi
  elif ! ready="$("$RUNTIME" "${args[@]}")"; then
    log "CDP snapshot failed"
    return 1
  fi

  build="$(json_arg 'm.buildNumber' "$ready")"
  hash="$(json_arg 'm.versionHash' "$ready")"
  existed="$(json_arg 'm.existed' "$ready")"
  skipped="$(json_arg 'm.skipped' "$ready")"

  if [ "$skipped" = "true" ]; then
    return 1
  elif [ "$existed" = "true" ]; then
    [ "$WATCH_LOG_DUPLICATES" != "0" ] && log "snapshot already queued for build $build (${hash:0:12})"
    return 1
  fi

  log "queued snapshot for build $build (${hash:0:12})"
  return 0
}

log "watching CDP on port $CDP_PORT with ${WATCH_INTERVAL}s between captures"
while :; do
  snapshot_once || true
  sleep "$WATCH_INTERVAL"
done
