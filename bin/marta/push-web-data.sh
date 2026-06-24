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

# Honor an explicit NODE (the crontab passes the absolute path, since cron's
# PATH usually lacks node); fall back to PATH lookup for manual runs.
NODE="${NODE:-node}"
"$NODE" "$REPO/bin/marta/export-web.js" "$WORK/alerts.json"
"$NODE" "$REPO/bin/marta/export-accessibility.js" "$WORK/accessibility.json"
"$NODE" "$REPO/bin/marta/export-daily.js" "$WORK/alerts.json" "$WORK/daily-counts.json"
"$NODE" "$REPO/bin/export-csv.js" "$WORK/alerts.json" "$WORK/alerts.csv"
# Reconcile standard.site document records from the freshly-exported alerts.json
# BEFORE building the manifest, so every posted incident gets a doc (keyed by its
# event rkey) and the page-side enhanced-card tags stay complete — not just the
# narrow slice the live posting bins can mint. Idempotent: only new/changed
# records hit the network. Non-fatal: a Bluesky hiccup must not block the data
# push; the manifest just lags one tick until the next run heals it.
"$NODE" "$REPO/scripts/backfill-standard-site.js" "$WORK/alerts.json" \
  || echo "marta push-web-data: standard.site sync failed (manifest may lag); continuing"
# standard.site manifest (AT-URIs for the enhanced-link-card tags + well-known);
# sourced from local state, byte-stable when no records changed.
"$NODE" "$REPO/bin/marta/export-standard-site.js" "$WORK/standard-site.json"

changed=0
for f in alerts.json accessibility.json daily-counts.json alerts.csv standard-site.json; do
  if ! cmp -s "$WORK/$f" "$LAST/$f" 2>/dev/null; then
    changed=1
  fi
done
if [ "$changed" -eq 0 ]; then
  echo "marta push-web-data: no change, skipping upload + rebuild"
  exit 0
fi

for f in alerts.json accessibility.json daily-counts.json alerts.csv standard-site.json; do
  rclone copyto "$WORK/$f" "$REMOTE/$f" \
    --s3-no-check-bucket \
    --header-upload "Cache-Control: public, max-age=30"
done

cp "$WORK/alerts.json" "$LAST/alerts.json"
cp "$WORK/accessibility.json" "$LAST/accessibility.json"
cp "$WORK/daily-counts.json" "$LAST/daily-counts.json"
cp "$WORK/alerts.csv" "$LAST/alerts.csv"
cp "$WORK/standard-site.json" "$LAST/standard-site.json"
echo "marta push-web-data: uploaded to $REMOTE"

# Debounce the rebuild dispatch. alerts.json changes almost every tick, so an
# unthrottled dispatch fires a Pages deploy every 1-2 min — faster than Pages
# rolls them out, which wedges the public site on a stale build. The R2 upload
# above already ran (the client reads live data from R2, so the app stays
# current regardless); this only gates how often we rebuild the prerendered OG
# cards / standard.site tags, which don't need minute-level freshness. Fire at
# most once per REBUILD_DEBOUNCE_SECONDS; the workflow's own schedule is the
# longer backstop.
DEBOUNCE="${REBUILD_DEBOUNCE_SECONDS:-900}"
STAMP="$LAST/.last-dispatch"
now_s=$(date +%s)
last_s=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ -z "$GITHUB_DISPATCH_TOKEN" ]; then
  echo "marta push-web-data: GITHUB_DISPATCH_TOKEN unset; relying on scheduled rebuild"
elif [ "$((now_s - last_s))" -lt "$DEBOUNCE" ]; then
  echo "marta push-web-data: last rebuild $((now_s - last_s))s ago (< ${DEBOUNCE}s); debouncing dispatch"
else
  code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$DISPATCH_REPO/dispatches" \
    -d '{"event_type":"data-updated"}') || code="curl-failed"
  echo "marta push-web-data: repository_dispatch -> $DISPATCH_REPO (http $code)"
  [ "$code" = "204" ] && echo "$now_s" > "$STAMP"
fi
