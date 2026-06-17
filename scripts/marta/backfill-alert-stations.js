#!/usr/bin/env node
// Backfill the structured station fields on existing MARTA rail alerts by
// re-running the extractor (src/marta/alert/stations.js) over each alert's
// stored headline + description. Fills affected_from_station,
// affected_to_station, and mentioned_stations — the columns the web export
// surfaces in `scope` so an alert ties to its /station/:slug pages.
//
// Needed once after deploying the station-extraction change: alerts ingested
// before it carry NULL station fields (e.g. the live "Green line ... from
// Bankhead to Ashby" alert). New alerts get the fields at ingest, so this is a
// one-shot catch-up; re-running is a no-op once every row is filled.
//
// Safety / idempotency:
//   - Only rail alerts are touched (the extractor is rail-scoped).
//   - affected_from/to_station: filled only when currently NULL — never
//     overwrites an endpoint a prior run resolved.
//   - mentioned_stations: written only when the fresh list is non-empty and
//     larger than what's stored — never shrinks a populated list.
//
// Defaults to a dry run. Pass --apply to write.
require('../../src/shared/env');
const { getDb, closeDb } = require('../../src/marta/storage');
const { ensureSchema } = require('../../src/marta/alert/store');
const { extractAlertStations } = require('../../src/marta/alert/stations');

const APPLY = process.argv.includes('--apply');

function parseStored(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function main() {
  // Add the station columns if missing (idempotent + additive — safe to run on a
  // dry run too, so the preview SELECT below can reference them). No rows are
  // written unless --apply is passed.
  ensureSchema();
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT alert_id, routes, headline, description,
              affected_from_station, affected_to_station, mentioned_stations
       FROM alert_posts WHERE mode = 'rail'`,
    )
    .all();

  const update = db.prepare(
    `UPDATE alert_posts
     SET affected_from_station = COALESCE(affected_from_station, ?),
         affected_to_station = COALESCE(affected_to_station, ?),
         mentioned_stations = ?
     WHERE alert_id = ?`,
  );

  let changed = 0;
  for (const row of rows) {
    const lines = String(row.routes || '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const fresh = extractAlertStations({
      headline: row.headline,
      description: row.description,
      lines,
    });
    const storedMentions = parseStored(row.mentioned_stations);
    const grow =
      fresh.mentionedStations.length > storedMentions.length
        ? JSON.stringify(fresh.mentionedStations)
        : row.mentioned_stations;
    const nextFrom = row.affected_from_station ?? fresh.affectedFromStation;
    const nextTo = row.affected_to_station ?? fresh.affectedToStation;

    const willChange =
      grow !== row.mentioned_stations ||
      nextFrom !== row.affected_from_station ||
      nextTo !== row.affected_to_station;
    if (!willChange) continue;
    changed += 1;

    console.log(
      `${row.alert_id} [${lines.join(',')}] from=${nextFrom ?? '-'} to=${nextTo ?? '-'} ` +
        `mentioned=${fresh.mentionedStations.join(', ') || '-'}`,
    );
    if (APPLY) update.run(fresh.affectedFromStation, fresh.affectedToStation, grow, row.alert_id);
  }

  console.log(
    `\n${APPLY ? 'Updated' : '(dry run) would update'} ${changed} of ${rows.length} rail alerts.`,
  );
  if (!APPLY && changed > 0) console.log('Re-run with --apply to write.');
  closeDb();
}

main();
