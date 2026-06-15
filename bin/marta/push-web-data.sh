#!/bin/sh
# Publish MARTA web data to the GitHub Pages data origin.
#
# This is the Atlanta launch path. It exports real MARTA incidents into
# public-data/, commits changed files, and pushes main; the repo's Pages workflow
# publishes those files at https://data.atlantatransitalerts.app/.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO="${ATLANTA_INSIGHTS:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
WORK="$REPO/public-data"

cd "$REPO"
mkdir -p "$WORK"

node "$REPO/bin/marta/export-web.js" "$WORK/alerts.json"
node "$REPO/bin/marta/export-daily.js" "$WORK/alerts.json" "$WORK/daily-counts.json"
node "$REPO/bin/export-csv.js" "$WORK/alerts.json" "$WORK/alerts.csv"

if git diff --quiet -- public-data/alerts.json public-data/daily-counts.json public-data/alerts.csv; then
  echo "marta push-web-data: no data changes"
  exit 0
fi

git add public-data/alerts.json public-data/daily-counts.json public-data/alerts.csv
git commit -m "Publish MARTA web data"
git push origin main
