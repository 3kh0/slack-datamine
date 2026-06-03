#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] && set -a && . ./.env && set +a

RUNTIME="${RUNTIME:-node}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_TIMEOUT_MS="${ALERT_TIMEOUT_MS:-5000}"

[ -n "$ALERT_WEBHOOK_URL" ] || exit 0

message="${*:-}"
if [ -z "$message" ]; then
  message="$(cat)"
fi
[ -n "$message" ] || exit 0

if ! "$RUNTIME" - "$ALERT_WEBHOOK_URL" "$ALERT_TIMEOUT_MS" "$message" <<'NODE'
const [url, timeoutMs, message] = process.argv.slice(2);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 5000);
timer.unref?.();

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
  signal: controller.signal,
}).then(async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
}).catch((e) => {
  console.error(`alert failed: ${e.message || e}`);
  process.exit(1);
});
NODE
then
  exit 0
fi
