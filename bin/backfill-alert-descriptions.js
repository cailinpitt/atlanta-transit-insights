#!/usr/bin/env node
// One-off backfill for alert_posts.short_description.
//
// The short_description column was added in 21aae7a. Alerts that resolved
// before that commit landed have NULL in the column and there's no live
// CTA-side update path that'd ever fill them (recordAlertSeen only runs
// while CTA still considers the alert active). This script fetches
// activeonly=false from CTA and copies ShortDescription / FullDescription
// into any matching alert_post row that still has NULL.
//
// Idempotent — safe to re-run. Skips rows whose short_description is already
// non-NULL (no overwrite). Does not touch any other column.

require('../src/shared/env');

const { fetchAlerts } = require('../src/shared/ctaAlerts');
const { getDb } = require('../src/shared/history');
const { runBin } = require('../src/shared/runBin');

async function main() {
  const db = getDb();
  const missing = db
    .prepare(`
      SELECT alert_id, kind, headline, first_seen_ts
      FROM alert_posts
      WHERE short_description IS NULL
      ORDER BY first_seen_ts DESC
    `)
    .all();

  if (missing.length === 0) {
    console.log('backfill-alert-descriptions: nothing to do (no NULL short_description rows)');
    return;
  }

  console.log(
    `backfill-alert-descriptions: ${missing.length} alert_post rows have NULL short_description; fetching CTA history`,
  );

  const alerts = await fetchAlerts({ activeOnly: false });
  const byId = new Map(alerts.map((a) => [a.id, a]));

  const update = db.prepare(
    'UPDATE alert_posts SET short_description = ? WHERE alert_id = ? AND short_description IS NULL',
  );

  let filled = 0;
  let notInFeed = 0;
  let stillEmpty = 0;

  for (const row of missing) {
    const cta = byId.get(row.alert_id);
    if (!cta) {
      notInFeed += 1;
      continue;
    }
    const body = cta.shortDescription || cta.fullDescription || null;
    if (!body) {
      stillEmpty += 1;
      continue;
    }
    update.run(body, row.alert_id);
    filled += 1;
    console.log(`  filled ${row.alert_id} (${row.kind}): ${body.slice(0, 80)}`);
  }

  console.log(
    `backfill-alert-descriptions: filled=${filled}, not-in-feed=${notInFeed}, cta-also-empty=${stillEmpty}`,
  );
}

runBin(main);
