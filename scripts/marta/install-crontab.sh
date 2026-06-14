#!/usr/bin/env bash
# Safely install (or update/remove) the MARTA-INSIGHTS cron block.
#
# It is a MARKER MERGE: it replaces only the lines between
# # MARTA-INSIGHTS-START and # MARTA-INSIGHTS-END in your live crontab and
# leaves every other entry untouched. Running it repeatedly leaves exactly one
# MARTA block (never duplicates).
#
#   scripts/marta/install-crontab.sh            install / update
#   scripts/marta/install-crontab.sh --dry-run  print the resulting crontab, don't apply
#   scripts/marta/install-crontab.sh --remove   strip the MARTA block
#
# Absolute repo path and `node` path are filled into the block so cron's minimal
# environment finds them.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BLOCK_FILE="$REPO/cron/marta-crontab.txt"
NODE="$(command -v node || true)"

mode="install"
case "${1:-}" in
  --dry-run) mode="dry-run" ;;
  --remove)  mode="remove" ;;
  "" )       mode="install" ;;
  *) echo "usage: install-crontab.sh [--dry-run|--remove]" >&2; exit 2 ;;
esac

if [[ "$mode" != "remove" && -z "$NODE" ]]; then
  echo "error: 'node' not found on PATH" >&2; exit 1
fi

mkdir -p "$REPO/state/logs"

# Live crontab (empty string if the user has none yet).
current="$(crontab -l 2>/dev/null || true)"

# Drop any existing MARTA block.
stripped="$(printf '%s\n' "$current" | awk '
  /^# MARTA-INSIGHTS-START/ {skip=1}
  /^# MARTA-INSIGHTS-END/   {skip=0; next}
  !skip')"

if [[ "$mode" == "remove" ]]; then
  printf '%s\n' "$stripped" | crontab -
  echo "Removed the MARTA-INSIGHTS cron block."
  exit 0
fi

# Render the marker block from the snippet with real paths substituted.
block="$(awk '/^# MARTA-INSIGHTS-START/,/^# MARTA-INSIGHTS-END/' "$BLOCK_FILE" \
  | sed -e "s#__REPO__#$REPO#g" -e "s#__NODE__#$NODE#g")"

# Append the block to whatever non-MARTA content remains. If the rest is
# whitespace-only (no other cron jobs), just use the block. Cron tolerates the
# odd blank line, so no fragile trailing-newline trimming is needed.
if [[ -n "${stripped//[$' \t\n']/}" ]]; then
  merged="$stripped"$'\n'"$block"
else
  merged="$block"
fi

if [[ "$mode" == "dry-run" ]]; then
  echo "----- resulting crontab (NOT applied) -----"
  printf '%s\n' "$merged"
  exit 0
fi

printf '%s\n' "$merged" | crontab -
echo "Installed the MARTA-INSIGHTS cron block. Active MARTA entries:"
crontab -l | awk '/^# MARTA-INSIGHTS-START/,/^# MARTA-INSIGHTS-END/'
