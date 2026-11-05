#!/usr/bin/env bash
# Off-box backup of the MARTA history DB to Cloudflare R2.
#
# Uses SQLite's `VACUUM INTO` so the snapshot is WAL-safe while cron writers
# are active. The position tables are dropped from the snapshot (positions are
# archived separately by bin/marta/export-positions.js, see docs/POSITIONS.md),
# then it is integrity-checked, gzipped, uploaded to R2, and a small number of
# local temp copies are retained for fast restores.
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

exec 9>"${WORKDIR}/.backup.lock"
if ! flock -n 9; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ERROR: previous backup still running, skipping" >&2
  exit 1
fi

# Don't leave a multi-GB uncompressed snapshot behind if a step fails.
trap 'rm -f "${WORKDIR:?}/${OUT}" "${WORKDIR:?}/${OUT}-journal"' ERR

# VACUUM INTO reads in a single transaction, so under WAL it never blocks
# writers; `.backup` restarts on every concurrent write and can never finish.
timeout 2h sqlite3 "$DB" "VACUUM INTO '${WORKDIR}/${OUT}'"

# Drop vehicle positions from the snapshot only. The live DB is untouched, and
# storage.js recreates the empty tables on a restored copy.
sqlite3 "${WORKDIR}/${OUT}" \
  'DROP TABLE IF EXISTS bus_observations; DROP TABLE IF EXISTS rail_observations; DROP TABLE IF EXISTS streetcar_observations; VACUUM;'

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
