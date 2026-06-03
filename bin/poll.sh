#!/usr/bin/env bash
# jank ass pipeline to pull build into and yolo it to main. proceed at your own risk

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] && set -a && . ./.env && set +a

CLIENT_URL="${CLIENT_URL:-https://app.slack.com/client}"
RUNTIME="${RUNTIME:-node}"
POLL_SOURCE="${POLL_SOURCE:-${CDP_PORT:+cdp}}"
POLL_SOURCE="${POLL_SOURCE:-cookie}"
CDP_PORT="${CDP_PORT:-9222}"
RELOAD_CDP="${RELOAD_CDP:-1}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-queue/html}"
QUEUE_ONLY="${QUEUE_ONLY:-0}"
INLINE_FOLLOWUP="${INLINE_FOLLOWUP:-1}"
FOLLOWUP_CHECKS="${FOLLOWUP_CHECKS:-18}"
FOLLOWUP_INTERVAL="${FOLLOWUP_INTERVAL:-10}"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
notify() { bin/notify.sh "$1" || true; }

json() {
  "$RUNTIME" -e "const m=require('./build/meta.json'); console.log($1)"
}

head_json() {
  "$RUNTIME" -e "const cp=require('node:child_process'); try { const m=JSON.parse(cp.execFileSync('git', ['show', 'HEAD:build/meta.json'], { encoding: 'utf8' })); console.log($1 || '') } catch { console.log('') }"
}

json_arg() {
  "$RUNTIME" -e "const m=JSON.parse(process.argv[1]); console.log($1 || '')" "$2"
}

hash_seen() {
  bin/build-seen.js "$1" >/dev/null 2>&1
}

numeric_less() {
  "$RUNTIME" -e "const a=process.argv[1], b=process.argv[2]; console.log(/^\\d+$/.test(a) && /^\\d+$/.test(b) && Number(a) < Number(b) ? '1' : '0')" "$1" "$2"
}

last_hash() {
  "$RUNTIME" -e "try { console.log(require('./build/meta.json').versionHash || '') } catch { console.log('') }"
}

snapshot_cdp_once() {
  local ready build hash html existed skipped current_hash
  local args=(bin/snapshot-cdp.js --port "$CDP_PORT" --dir "$SNAPSHOT_DIR")
  current_hash="$(last_hash)"
  [ -n "$current_hash" ] && args+=(--skip-hash "$current_hash")

  if ! ready="$("$RUNTIME" "${args[@]}")"; then
    log "CDP snapshot failed"
    return 1
  fi

  build="$(json_arg 'm.buildNumber' "$ready")"
  hash="$(json_arg 'm.versionHash' "$ready")"
  html="$(json_arg 'm.htmlFile' "$ready")"
  existed="$(json_arg 'm.existed' "$ready")"
  skipped="$(json_arg 'm.skipped' "$ready")"

  if [ -z "$hash" ]; then
    log "CDP snapshot had no version hash"
    return 1
  fi

  if [ "$skipped" = "true" ] || { [ -n "$current_hash" ] && [ "$hash" = "$current_hash" ]; }; then
    log "no change (build $build, ${hash:0:12})"
    [ -n "$html" ] && rm -f "$html" "$html.json"
    return 1
  elif hash_seen "$hash"; then
    log "already mined (build $build, ${hash:0:12})"
    [ -n "$html" ] && rm -f "$html" "$html.json"
    return 1
  fi

  if [ "$existed" = "true" ]; then
    log "snapshot already queued for build $build (${hash:0:12})"
    return 2
  else
    log "queued snapshot for build $build (${hash:0:12})"
  fi
  return 0
}

snapshot_hash() {
  "$RUNTIME" -e "const fs=require('fs'); try { console.log(JSON.parse(fs.readFileSync(process.argv[1] + '.json', 'utf8')).versionHash || '') } catch { console.log('') }" "$1"
}

commit_build() {
  if ! command -v git >/dev/null || [ ! -d .git ]; then return 1; fi

  PREV_BUILD="$(head_json 'm.buildNumber')"
  BUILD="$(json 'm.buildNumber')"
  TS="$(json 'm.versionTs')"
  HASH="$(json 'm.versionHash')"
  MESSAGE="build ${BUILD} (${HASH:0:12})"
  [ "$(numeric_less "$BUILD" "$PREV_BUILD")" = "1" ] && MESSAGE="rollback to build ${BUILD} (${HASH:0:12})"

  git add build/
  if git diff --cached --quiet; then
    log "no change (build $BUILD, ${HASH:0:12})"
    return 1
  fi

  git commit -q -m "$MESSAGE"
  TAG="$BUILD"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && TAG="${BUILD}-${TS}"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && TAG="${BUILD}-${TS}-$(git rev-parse --short=12 HEAD)"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag -a "$TAG" -m "Slack build ${BUILD} / ${HASH}"
  log "committed + tagged $TAG"
  [ "${GIT_PUSH:-0}" != "0" ] && git push -q && git push -q --tags && log "pushed"
  notify "slack-datamine committed $MESSAGE
tag: $TAG
hash: $HASH"
  return 0
}

poll_cdp() {
  local saw_new=1 status

  if queued_snapshots | grep -q .; then
    process_snapshot_queue
    return
  fi

  [ "$QUEUE_ONLY" != "0" ] && return 1

  if [ "$RELOAD_CDP" != "0" ]; then
    log "checking CDP on port $CDP_PORT"
    if snapshot_cdp_once; then
      saw_new=0
    else
      status=$?
      [ "$status" -eq 2 ] && saw_new=0
    fi

    if [ "$saw_new" -eq 0 ] && [ "$INLINE_FOLLOWUP" != "0" ] && [ "$FOLLOWUP_CHECKS" -gt 0 ]; then
      local remaining="$FOLLOWUP_CHECKS"
      while [ "$remaining" -gt 0 ]; do
        log "snapshot follow-up in ${FOLLOWUP_INTERVAL}s (${remaining} remaining)"
        sleep "$FOLLOWUP_INTERVAL"
        if snapshot_cdp_once; then
          remaining="$FOLLOWUP_CHECKS"
          log "new snapshot found during follow-up; extending window"
        else
          remaining=$((remaining - 1))
        fi
      done
    fi
  fi

  process_snapshot_queue
}

queued_snapshots() {
  [ -d "$SNAPSHOT_DIR" ] || return 0
  "$RUNTIME" -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = process.argv[1];
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.html'))
      .map((name) => {
        const file = path.join(dir, name);
        let capturedAt = '';
        try { capturedAt = JSON.parse(fs.readFileSync(file + '.json', 'utf8')).capturedAt || ''; } catch {}
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
        const order = Date.parse(capturedAt);
        return { file, name, order: Number.isFinite(order) ? order : mtimeMs };
      })
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    for (const entry of entries) console.log(entry.file);
  " "$SNAPSHOT_DIR"
}

process_snapshot_queue() {
  local committed=1 html hash

  while IFS= read -r html; do
    [ -n "$html" ] || continue
    hash="$(snapshot_hash "$html")"

    if [ -n "$hash" ] && hash_seen "$hash"; then
      log "skipping already mined queued snapshot $(basename "$html") (${hash:0:12})"
      rm -f "$html" "$html.json"
      continue
    fi

    log "mining queued snapshot $(basename "$html")"
    "$RUNTIME" datamine.js --html "$html"
    if commit_build; then committed=0; fi
    rm -f "$html" "$html.json"
  done < <(queued_snapshots)

  return "$committed"
}

poll_cdp_direct() {
  log "mining via CDP on port $CDP_PORT"
  "$RUNTIME" datamine.js --port "$CDP_PORT"
  commit_build
}

poll_cookie() {
  : "${SLACK_D_COOKIE:?set SLACK_D_COOKIE in .env or use POLL_SOURCE=cdp}"

  TMP="$(mktemp -t slack-client.XXXXXX)"; trap 'rm -f "$TMP"' EXIT
  if ! HTTP_CODE="$(curl -sS -L --compressed -A "Mozilla/5.0" -H "Cookie: d=${SLACK_D_COOKIE}" -w "%{http_code}" "$CLIENT_URL" -o "$TMP")"; then
    log "failed to fetch Slack client HTML from $CLIENT_URL"
    exit 1
  fi

  val() { grep -oE "data-$1=\"[^\"]+\"" "$TMP" | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true; }
  HASH="$(val version-hash)"; BUILD="$(val build-number)"
  if [ -z "$HASH" ]; then
    log "no manifest in HTML (HTTP $HTTP_CODE) — refresh SLACK_D_COOKIE or use POLL_SOURCE=cdp"
    exit 1
  fi

  LAST="$(grep -oE '"versionHash": "[0-9a-f]+"' build/meta.json 2>/dev/null | sed -E 's/.*"([0-9a-f]+)".*/\1/' || true)"
  if [ "$HASH" = "$LAST" ]; then log "no change (build $BUILD, ${HASH:0:12})"; return 1; fi

  log "new build $BUILD (${HASH:0:12}) — mining with $RUNTIME"
  "$RUNTIME" datamine.js --html "$TMP"
  commit_build
}

case "$POLL_SOURCE" in
  cdp)
    if [ "$RELOAD_CDP" = "0" ]; then
      if poll_cdp_direct; then :; fi
    elif poll_cdp; then
      :
    fi
    ;;
  cookie)
    if poll_cookie; then :; fi
    ;;
  *) log "unknown POLL_SOURCE=$POLL_SOURCE (expected cdp or cookie)"; exit 1 ;;
esac

log "done"
