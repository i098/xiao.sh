#!/usr/bin/env bash
# Copy a .data directory into the Worker's DATA KV namespace, one key per file
# (.data-relative path), then read every key back and compare sha256.
# Usage: scripts/data-to-kv.sh <data-dir>   (needs Cloudflare credentials in the environment)
# ssh-host-key is skipped: SSH does not run on Cloudflare, and the key stays on the old host.
set -euo pipefail
dir=${1:?usage: scripts/data-to-kv.sh <data-dir>}
wrangler=node_modules/.bin/wrangler
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

cd "$dir" && files=$(find . -type f ! -name ssh-host-key | sed 's|^\./||' | sort) && cd - >/dev/null
for key in $files; do
  "$wrangler" kv key put "$key" --path "$dir/$key" --binding DATA --remote >/dev/null
done
for key in $files; do
  "$wrangler" kv key get "$key" --binding DATA --remote >"$tmp"
  want=$(sha256sum <"$dir/$key" | cut -d' ' -f1)
  got=$(sha256sum <"$tmp" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "MISMATCH $key" >&2; exit 1; }
  echo "ok $want $key"
done
