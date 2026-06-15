#!/bin/sh
# Publish MARTA web data to the R2 data origin and trigger a site rebuild.
#
# High-churn public data files live in R2, served at
# https://data.atlantatransitalerts.app. This script never commits generated
# alerts.json/csv data to git.
#
# Env:
#   ATLANTA_INSIGHTS       repo path (default: parent of this script's dir)
#   RCLONE_REMOTE          rclone remote:bucket
#                          (default: r2atlanta:atlanta-transit-alerts-data)
#   DISPATCH_REPO          owner/repo to rebuild
#                          (default: cailinpitt/atlanta-transit-alerts)
#   GITHUB_DISPATCH_TOKEN  PAT allowed to POST repository_dispatch.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO="${ATLANTA_INSIGHTS:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REMOTE="${RCLONE_REMOTE:-r2atlanta:atlanta-transit-alerts-data}"
DISPATCH_REPO="${DISPATCH_REPO:-cailinpitt/atlanta-transit-alerts}"

if [ -z "${GITHUB_DISPATCH_TOKEN:-}" ] && [ -f "$REPO/.env" ]; then
  GITHUB_DISPATCH_TOKEN=$(grep -E '^[[:space:]]*GITHUB_DISPATCH_TOKEN=' "$REPO/.env" | head -1 | sed 's/^[^=]*=//')
fi

WORK="$REPO/tmp/web-data"
LAST="$WORK/.last"

cd "$REPO"
mkdir -p "$WORK" "$LAST"

node "$REPO/bin/marta/export-web.js" "$WORK/alerts.json"
node "$REPO/bin/marta/export-daily.js" "$WORK/alerts.json" "$WORK/daily-counts.json"
node "$REPO/bin/export-csv.js" "$WORK/alerts.json" "$WORK/alerts.csv"

changed=0
for f in alerts.json daily-counts.json alerts.csv; do
  if ! cmp -s "$WORK/$f" "$LAST/$f" 2>/dev/null; then
    changed=1
  fi
done
if [ "$changed" -eq 0 ]; then
  echo "marta push-web-data: no change, skipping upload + rebuild"
  exit 0
fi

for f in alerts.json daily-counts.json alerts.csv; do
  rclone copyto "$WORK/$f" "$REMOTE/$f" \
    --s3-no-check-bucket \
    --header-upload "Cache-Control: public, max-age=30"
done

cp "$WORK/alerts.json" "$LAST/alerts.json"
cp "$WORK/daily-counts.json" "$LAST/daily-counts.json"
cp "$WORK/alerts.csv" "$LAST/alerts.csv"
echo "marta push-web-data: uploaded to $REMOTE"

if [ -n "$GITHUB_DISPATCH_TOKEN" ]; then
  code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$DISPATCH_REPO/dispatches" \
    -d '{"event_type":"data-updated"}') || code="curl-failed"
  echo "marta push-web-data: repository_dispatch -> $DISPATCH_REPO (http $code)"
else
  echo "marta push-web-data: GITHUB_DISPATCH_TOKEN unset; relying on scheduled rebuild"
fi
