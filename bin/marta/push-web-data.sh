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
# --shards also emits the bounded recent slice + monthly archive shards +
# all-time per-line files + index + aggregates.json (precomputed YoY), alongside
# the legacy full-history alerts.json (published side by side during the rollout).
"$NODE" "$REPO/bin/marta/export-web.js" "$WORK/alerts.json" --shards "$WORK"
"$NODE" "$REPO/bin/marta/export-accessibility.js" "$WORK/accessibility.json"
"$NODE" "$REPO/bin/marta/export-daily.js" "$WORK/alerts.json" "$WORK/daily-counts.json"
"$NODE" "$REPO/bin/export-csv.js" "$WORK/alerts.json" "$WORK/alerts.csv"

changed=0
for f in alerts.json accessibility.json daily-counts.json alerts.csv; do
  if ! cmp -s "$WORK/$f" "$LAST/$f" 2>/dev/null; then
    changed=1
  fi
done
if [ "$changed" -eq 0 ]; then
  echo "marta push-web-data: no change, skipping upload + rebuild"
  exit 0
fi

# Upload to R2. High-churn files get a short edge-cache TTL; the client also
# revalidates on generated_at / ETag, so 30s bounds worst-case staleness without
# hammering origin. Closed-month archive shards get a long TTL since they
# effectively never change once their month ends.
SHORT_TTL="Cache-Control: public, max-age=30"

# 3a. Short-TTL, high-churn top-level files (legacy full file + recent slice +
#     index + aggregates all change ~every tick; the existing accessibility/
#     daily/csv too).
for f in alerts.json accessibility.json daily-counts.json alerts.csv \
         alerts-recent.json alerts-index.json aggregates.json; do
  rclone copyto "$WORK/$f" "$REMOTE/$f" \
    --s3-no-check-bucket \
    --header-upload "$SHORT_TTL"
done

# 3b. All-time per-line files. Each changes only when its line gets a new
#     incident; rclone copy transfers just the files that actually differ, and
#     the client revalidates by ETag. Short TTL so a new incident shows promptly.
if [ -d "$WORK/incidents/by-line" ]; then
  rclone copy "$WORK/incidents/by-line" "$REMOTE/incidents/by-line" \
    --s3-no-check-bucket \
    --header-upload "$SHORT_TTL"
fi

# 3c. Monthly archive shards. The current Atlanta month still grows each tick →
#     short TTL; every prior month is closed → a 1-day cache (safe even if a late
#     resolution rewrites an old shard, unlike a hard `immutable`; can tighten to
#     immutable once versioned-shard-URL handling lands). rclone copy never
#     deletes, and only re-transfers changed files.
if [ -d "$WORK/alerts" ]; then
  CUR_MONTH=$(TZ=America/New_York date +%Y-%m)
  rclone copy "$WORK/alerts" "$REMOTE/alerts" \
    --exclude "${CUR_MONTH}.json" \
    --s3-no-check-bucket \
    --header-upload "Cache-Control: public, max-age=86400"
  if [ -f "$WORK/alerts/${CUR_MONTH}.json" ]; then
    rclone copyto "$WORK/alerts/${CUR_MONTH}.json" "$REMOTE/alerts/${CUR_MONTH}.json" \
      --s3-no-check-bucket \
      --header-upload "$SHORT_TTL"
  fi
fi

cp "$WORK/alerts.json" "$LAST/alerts.json"
cp "$WORK/accessibility.json" "$LAST/accessibility.json"
cp "$WORK/daily-counts.json" "$LAST/daily-counts.json"
cp "$WORK/alerts.csv" "$LAST/alerts.csv"
echo "marta push-web-data: uploaded to $REMOTE"

# Debounce the rebuild dispatch. alerts.json changes almost every tick, so an
# unthrottled dispatch fires a Pages deploy every 1-2 min — faster than Pages
# rolls them out, which wedges the public site on a stale build. The R2 upload
# above already ran (the client reads live data from R2, so the app stays
# current regardless); this only gates how often we rebuild the prerendered OG
# cards, which don't need minute-level freshness. Fire at
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
  active_run=""
  for status in queued in_progress waiting pending requested; do
    runs_json=$(curl -fsS \
      -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$DISPATCH_REPO/actions/workflows/deploy.yml/runs?status=$status&per_page=1") \
      || runs_json=""
    active_run=$(printf '%s' "$runs_json" | "$NODE" -e '
      let body = "";
      process.stdin.on("data", (chunk) => (body += chunk));
      process.stdin.on("end", () => {
        try {
          const run = JSON.parse(body).workflow_runs?.[0];
          if (run) console.log(`${run.id} ${run.status} ${run.event}`);
        } catch (_) {}
      });
    ')
    if [ -n "$active_run" ]; then
      break
    fi
  done

  if [ -n "$active_run" ]; then
    echo "marta push-web-data: deploy workflow already active ($active_run); skipping dispatch"
    exit 0
  fi

  code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$DISPATCH_REPO/dispatches" \
    -d '{"event_type":"data-updated"}') || code="curl-failed"
  echo "marta push-web-data: repository_dispatch -> $DISPATCH_REPO (http $code)"
  [ "$code" = "204" ] && echo "$now_s" > "$STAMP"
fi
