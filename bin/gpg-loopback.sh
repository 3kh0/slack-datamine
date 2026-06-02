#!/usr/bin/env bash
set -euo pipefail

PASSFILE="${GPG_PASSPHRASE_FILE:-/root/.config/slack-datamine/gpg-passphrase}"

if [ -f "$PASSFILE" ]; then
  exec gpg --batch --pinentry-mode loopback --passphrase-file "$PASSFILE" "$@"
fi

exec gpg --batch --pinentry-mode loopback "$@"
