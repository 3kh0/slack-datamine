#!/usr/bin/env bash
set -euo pipefail

KEY="${GPG_SIGNING_KEY:?set GPG_SIGNING_KEY to your signing key fingerprint}"
PASSFILE="${GPG_PASSPHRASE_FILE:-/root/.config/slack-datamine/gpg-passphrase}"
PRESET="$(find /usr/lib -name gpg-preset-passphrase -type f | head -1)"

[ -n "$PRESET" ] || { echo "gpg-preset-passphrase not found" >&2; exit 1; }
[ -f "$PASSFILE" ] || { echo "GPG passphrase file not found: $PASSFILE" >&2; exit 1; }

PASSPHRASE="$(cat "$PASSFILE")"

gpg --with-keygrip --list-secret-keys "$KEY" \
  | awk '/Keygrip = / { print $3 }' \
  | while read -r grip; do
      "$PRESET" --preset --passphrase "$PASSPHRASE" "$grip"
    done

unset PASSPHRASE
