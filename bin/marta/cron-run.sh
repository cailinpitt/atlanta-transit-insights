#!/usr/bin/env bash
# Usage: cron-run.sh <job-name> <command> [args...]
# Runs <command> from the repo root under a per-job flock. If the previous run
# of <job-name> is still going (stuck on a DB lock, a slow API, a long
# timelapse), this tick prints a skip line and exits 0 rather than stacking
# another process on top of it. Output and logging stay with the caller's
# redirect, so the skip line lands in the job's own log.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
NAME=$1
shift

mkdir -p state/locks
exec 9>"state/locks/$NAME.lock"
if ! flock -n 9; then
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') skipped: previous $NAME run still in progress"
  exit 0
fi

# 9>&- keeps the lock fd out of the job, so an orphaned grandchild (chromium,
# ffmpeg) can't hold the lock after the job exits.
"$@" 9>&-
