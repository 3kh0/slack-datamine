#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] && set -a && . ./.env && set +a

CLIENT_URL="${CLIENT_URL:-https://app.slack.com/client}"
RUNTIME="${RUNTIME:-node}"
CDP_PORT="${CDP_PORT:-9222}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-queue/html}"
CDP_READY_TIMEOUT_MS="${CDP_READY_TIMEOUT_MS:-10000}"
FETCH_CLIENT_TIMEOUT_MS="${FETCH_CLIENT_TIMEOUT_MS:-5000}"
HEALTH_DIRECT_TIMEOUT="${HEALTH_DIRECT_TIMEOUT:-35}"
HEALTH_RELOAD_TIMEOUT_MS="${HEALTH_RELOAD_TIMEOUT_MS:-20000}"
HEALTH_QUEUE_STALE_SEC="${HEALTH_QUEUE_STALE_SEC:-180}"
HEALTH_SNAPSHOT_STALE_SEC="${HEALTH_SNAPSHOT_STALE_SEC:-45}"
HEALTH_CLEAR_CACHE="${HEALTH_CLEAR_CACHE:-1}"

failures=()

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

fail() {
  failures+=("$1")
  log "healthcheck: $1"
}

notify() {
  bin/notify.sh "$1" || true
}

json_value() {
  "$RUNTIME" -e "try { const m=JSON.parse(process.argv[1]); console.log($1 || '') } catch { console.log('') }" "$2"
}

head_json() {
  "$RUNTIME" -e "const cp=require('node:child_process'); try { const m=JSON.parse(cp.execFileSync('git', ['show', 'HEAD:build/meta.json'], { encoding: 'utf8' })); console.log($1 || '') } catch { console.log('') }"
}

hash_seen() {
  bin/build-seen.js "$1" >/dev/null 2>&1
}

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

check_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [ -d /run/systemd/system ] || return 0

  systemctl is-active --quiet slack-cdp.service || fail "slack-cdp.service is not active"
  systemctl is-active --quiet slack-datamine-watch.service || fail "slack-datamine-watch.service is not active"
  systemctl is-active --quiet slack-datamine.timer || fail "slack-datamine.timer is not active"
}

check_cdp_http() {
  if ! "$RUNTIME" - "$CDP_PORT" <<'NODE'
const [port] = process.argv.slice(2);
(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
})().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
NODE
  then
    fail "CDP HTTP endpoint is unreachable on port $CDP_PORT"
  fi
}

check_stuck_snapshot() {
  local ps_output
  if ! ps_output="$(ps -eo pid=,etimes=,args= 2>/dev/null)"; then
    return 0
  fi

  while read -r pid etimes args; do
    [ -n "${pid:-}" ] || continue
    case "$args" in
      *"bin/snapshot-cdp.js"*)
        if [ "$etimes" -gt "$HEALTH_SNAPSHOT_STALE_SEC" ]; then
          fail "snapshot process $pid has been running for ${etimes}s"
        fi
        ;;
    esac
  done < <(printf '%s\n' "$ps_output")
}

check_stale_queue() {
  [ -d "$SNAPSHOT_DIR" ] || return 0

  local stale_min
  stale_min=$(( (HEALTH_QUEUE_STALE_SEC + 59) / 60 ))
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    fail "queued snapshot older than ${HEALTH_QUEUE_STALE_SEC}s: $(basename "$file")"
  done < <(find "$SNAPSHOT_DIR" -maxdepth 1 -name '*.html' -mmin +"$stale_min" -print)
}

reload_and_clear_cache() {
  "$RUNTIME" - "$CDP_PORT" "$CLIENT_URL" "$HEALTH_RELOAD_TIMEOUT_MS" <<'NODE'
const { connect } = require('./lib/cdp');
const [port, clientUrl, timeoutMs] = process.argv.slice(2);

(async () => {
  const cdp = await connect({ port });
  try {
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Network.clearBrowserCache').catch(() => {});
    await cdp.send('Page.enable');
    const href = await cdp.evaluate('location.href').catch(() => '');
    if (href.includes('app.slack.com')) await cdp.send('Page.reload', { ignoreCache: true });
    else await cdp.send('Page.navigate', { url: clientUrl });
    const s = await cdp.waitReady(Date.now() + Number(timeoutMs || 20000));
    console.log(JSON.stringify(s));
  } finally {
    cdp.close();
  }
})().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
NODE
}

render_probe() {
  "$RUNTIME" - "$CDP_PORT" <<'NODE'
const { connect } = require('./lib/cdp');
const [port] = process.argv.slice(2);

(async () => {
  const cdp = await connect({ port });
  try {
    const s = await cdp.evaluate(`(() => {
      const el = document.documentElement;
      if (!el) return null;
      const d = el.dataset;
      return {
        href: location.href,
        ready: document.readyState,
        app: d.app || null,
        buildNumber: d.buildNumber || null,
        versionTs: d.versionTs || null,
        versionHash: d.versionHash || null,
      };
    })()`);
    if (!s?.href?.includes('app.slack.com') || s.app !== 'client-v2' || !s.versionHash) {
      throw new Error('rendered Slack page has no usable build metadata');
    }
    console.log(JSON.stringify(s));
  } finally {
    cdp.close();
  }
})().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
NODE
}

direct_probe() {
  local tmp err out
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/slack-health.XXXXXX")"
  err="$tmp/stderr"
  if out="$(run_with_timeout "$HEALTH_DIRECT_TIMEOUT" "$RUNTIME" bin/snapshot-cdp.js \
    --port "$CDP_PORT" \
    --dir "$tmp" \
    --fetch-client \
    --timeout-ms "$CDP_READY_TIMEOUT_MS" \
    --fetch-timeout-ms "$FETCH_CLIENT_TIMEOUT_MS" 2>"$err")"; then
    rm -rf "$tmp"
    printf '%s\n' "$out"
    return 0
  fi

  printf 'direct client probe failed: %s\n' "$(tr '\n' ' ' <"$err")" >&2
  rm -rf "$tmp"
  return 1
}

queue_direct_snapshot() {
  local head_hash="$1" err out build hash existed skipped
  local args=(bin/snapshot-cdp.js --port "$CDP_PORT" --dir "$SNAPSHOT_DIR" --fetch-client --timeout-ms "$CDP_READY_TIMEOUT_MS" --fetch-timeout-ms "$FETCH_CLIENT_TIMEOUT_MS")
  [ -n "$head_hash" ] && args+=(--skip-hash "$head_hash")

  err="$(mktemp "${TMPDIR:-/tmp}/slack-health-queue.XXXXXX")"
  if out="$(run_with_timeout "$HEALTH_DIRECT_TIMEOUT" "$RUNTIME" "${args[@]}" 2>"$err")"; then
    rm -f "$err"
    build="$(json_value 'm.buildNumber' "$out")"
    hash="$(json_value 'm.versionHash' "$out")"
    existed="$(json_value 'm.existed' "$out")"
    skipped="$(json_value 'm.skipped' "$out")"

    if [ "$skipped" = "true" ]; then
      return 0
    elif [ "$existed" = "true" ]; then
      log "snapshot already queued for build $build (${hash:0:12})"
    else
      log "queued direct snapshot for build $build (${hash:0:12})"
      notify "slack-datamine queued build $build (${hash:0:12})"
    fi
    return 0
  fi

  fail "direct client had a newer build but queueing failed: $(tr '\n' ' ' <"$err")"
  rm -f "$err"
  return 1
}

check_systemd
check_cdp_http
check_stuck_snapshot
check_stale_queue

if [ "$HEALTH_CLEAR_CACHE" != "0" ]; then
  if refreshed="$(reload_and_clear_cache 2>&1)"; then
    log "cache guard reloaded build $(json_value 'm.buildNumber' "$refreshed") ($(json_value 'm.versionHash' "$refreshed" | cut -c1-12))"
  else
    fail "cache guard reload failed: $refreshed"
  fi
fi

direct=""
if direct="$(direct_probe 2>&1)"; then
  direct_build="$(json_value 'm.buildNumber' "$direct")"
  direct_hash="$(json_value 'm.versionHash' "$direct")"
else
  fail "$direct"
  direct_build=""
  direct_hash=""
fi

rendered=""
if rendered="$(render_probe 2>&1)"; then
  rendered_build="$(json_value 'm.buildNumber' "$rendered")"
  rendered_hash="$(json_value 'm.versionHash' "$rendered")"
else
  fail "rendered page probe failed: $rendered"
  rendered_build=""
  rendered_hash=""
fi

if [ -n "$direct_hash" ] && [ -n "$rendered_hash" ] && [ "$direct_hash" != "$rendered_hash" ]; then
  fail "rendered build $rendered_build (${rendered_hash:0:12}) differs from direct client build $direct_build (${direct_hash:0:12}) after cache guard"
fi

head_build="$(head_json 'm.buildNumber')"
head_hash="$(head_json 'm.versionHash')"
if [ -n "$direct_hash" ] && { [ -z "$head_hash" ] || [ "$direct_hash" != "$head_hash" ]; }; then
  log "direct client is ahead of HEAD: $direct_build (${direct_hash:0:12}) vs $head_build (${head_hash:0:12})"
  if hash_seen "$direct_hash"; then
    log "direct client build already mined in git history; not queueing"
  else
    queue_direct_snapshot "$head_hash" || true
  fi
fi

if [ "${#failures[@]}" -gt 0 ]; then
  message="slack-datamine healthcheck failed"
  for failure in "${failures[@]}"; do
    message="${message}
- ${failure}"
  done
  notify "$message"
  exit 1
fi

log "healthy: HEAD $head_build (${head_hash:0:12}), direct $direct_build (${direct_hash:0:12}), rendered $rendered_build (${rendered_hash:0:12})"
