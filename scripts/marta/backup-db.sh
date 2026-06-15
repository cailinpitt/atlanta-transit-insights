#!/usr/bin/env bash
# Off-box backup of the MARTA history DB to Cloudflare R2.
#
# Uses SQLite's online `.backup` so the snapshot is WAL-safe while cron writers
# are active. The snapshot is integrity-checked, gzipped, uploaded to R2, and a
# small number of local temp copies are retained for fast restores.
#
# Env overrides:
#   MARTA_HISTORY_DB_PATH  SQLite DB to back up
#                          (default: state/marta.sqlite)
#   RCLONE_REMOTE          rclone remote:bucket target
#                          (default: r2atlanta-db:atlanta-transit-insights-db-backups)
#   KEEP_LOCAL             local snapshots to retain (default: 2)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${MARTA_HISTORY_DB_PATH:-$REPO_DIR/state/marta.sqlite}"
WORKDIR="$REPO_DIR/tmp/marta-db-backups"
REMOTE="${RCLONE_REMOTE:-r2atlanta-db:atlanta-transit-insights-db-backups}"
KEEP_LOCAL="${KEEP_LOCAL:-2}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="marta-${STAMP}.sqlite"

if [ ! -f "$DB" ]; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ERROR: DB not found at $DB" >&2
  exit 1
fi

mkdir -p "$WORKDIR"

sqlite3 "$DB" ".backup '${WORKDIR}/${OUT}'"

if ! sqlite3 "${WORKDIR}/${OUT}" 'PRAGMA integrity_check;' | grep -qx 'ok'; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ERROR: integrity_check failed for ${OUT}" >&2
  rm -f "${WORKDIR:?}/${OUT}"
  exit 1
fi

gzip -f "${WORKDIR}/${OUT}"

rclone copy "${WORKDIR}/${OUT}.gz" "${REMOTE}/" --s3-no-check-bucket

ls -1t "${WORKDIR}"/marta-*.sqlite.gz 2>/dev/null \
  | tail -n +"$((KEEP_LOCAL + 1))" \
  | xargs -r rm -f

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backup ok: ${OUT}.gz -> ${REMOTE}"
