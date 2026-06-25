#!/usr/bin/env node
// Backfill hourly progress updates for past absence incidents.
//
// Going forward the detector bins (thin-gaps, bus/rail pulse) post an hourly
// "still no service — ~Nh in" reply while an incident is open and record it into
// incident_updates. This one-shot reconstructs the SAME timeline for incidents
// that closed before that feature existed.
//
// For thin-service gaps and pulse blackouts the update text is fully determined
// by data frozen forever in disruption_events — the onset (its ts), the
// resolution (the matching observed-clear), and the firing-time evidence
// (headway / expectedActive / segment). These events are silent by definition,
// so there is never a partial "seen 1 of 6" beat to recover from raw
// observations; the raw 7-day window adds nothing. So this backfills the FULL
// history, not just the last 7 days. Backfilled rows carry post_uri = null (no
// retroactive Bluesky reply) — they're website-timeline entries only.
//
// Idempotent: re-running skips any clock-hour that already has an update.
// `--dry-run` prints what it would write without touching the DB.
require('../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../src/marta/gtfs');
const incidents = require('../../src/marta/shared/incidents');
const {
  thinGapUpdate,
  busPulseUpdate,
  railPulseUpdate,
} = require('../../src/marta/shared/incidentUpdates');
const { lineTitle } = require('../../src/marta/rail/post');
const { setup, runBin } = require('../../src/marta/shared/runBin');

const GTFS_DIR =
  process.env.MARTA_GTFS_DIR || Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');

const HOUR_MS = 60 * 60 * 1000;
const ABSENCE_SOURCES = ['observed-thin', 'observed', 'observed-held'];

function busRouteNames(gtfs) {
  const names = new Map();
  for (const r of gtfs.routes || []) {
    if (String(r.route_type) !== '3') continue;
    const short = String(r.route_short_name || '').trim();
    if (short && r.route_long_name) names.set(short, r.route_long_name);
  }
  return names;
}

function routeTitle(names, route) {
  const long = names.get(String(route));
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

// Every posted absence disruption with its resolution time (the matching
// observed-clear), mirroring export-web.js readDisruptions.
function readAbsenceDisruptions(db) {
  const placeholders = ABSENCE_SOURCES.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT d.id, d.kind, d.line, d.direction, d.source, d.ts, d.evidence,
              (SELECT MIN(c.ts) FROM disruption_events c
                 WHERE c.kind = d.kind AND c.source = 'observed-clear'
                   AND c.line = d.line AND c.ts >= d.ts) AS resolved_ts
       FROM disruption_events d
       WHERE d.source IN (${placeholders}) AND d.posted = 1
       ORDER BY d.ts ASC, d.id ASC`,
    )
    .all(...ABSENCE_SOURCES);
}

// Build the update payload for one hour-offset into an incident, reusing the
// same pure builders the live bins use so backfilled and live text match.
function buildUpdateFor(row, evidence, elapsedMin, { busNames }) {
  if (row.kind === 'rail') {
    return railPulseUpdate({
      lineTitle: lineTitle(row.line),
      fromStation: evidence?.from ?? null,
      toStation: evidence?.to ?? null,
      expectedTrains: evidence?.expectedTrains ?? null,
      synthetic: evidence?.synthetic === true,
      elapsedMin,
    });
  }
  if (row.source === 'observed-thin') {
    return thinGapUpdate({
      routeTitle: routeTitle(busNames, row.line),
      headwayMin: evidence?.headwayMin ?? null,
      elapsedMin,
    });
  }
  return busPulseUpdate({
    routeTitle: routeTitle(busNames, row.line),
    expectedActive: evidence?.expectedActive ?? null,
    elapsedMin,
  });
}

// Pure: expand absence-disruption rows into the full set of would-be hourly
// updates (one per completed hour from onset → resolve/now), before idempotency
// filtering. Exported so tests can assert the walk without a DB or GTFS load.
function planBackfillUpdates(rows, now, busNames) {
  const out = [];
  for (const row of rows) {
    const end = row.resolved_ts ?? now;
    let evidence = null;
    try {
      evidence = row.evidence ? JSON.parse(row.evidence) : null;
    } catch (_e) {
      evidence = null;
    }
    // One update per completed hour, strictly before the resolution — the clear
    // reply already covers the final boundary, so a 3h-exact event gets +1h/+2h.
    for (let h = 1; row.ts + h * HOUR_MS < end; h++) {
      const update = buildUpdateFor(row, evidence, h * 60, { busNames });
      if (!update?.description) continue;
      out.push({
        disruptionId: row.id,
        kind: row.kind,
        line: row.line,
        direction: row.direction ?? null,
        source: row.source,
        ts: row.ts + h * HOUR_MS,
        evidence: update.evidence ?? null,
        description: update.description,
      });
    }
  }
  return out;
}

async function main() {
  setup();
  const dryRun = !!(argv['dry-run'] || process.env.BACKFILL_UPDATES_DRY_RUN);
  const now = Date.now();
  const gtfs = loadGtfs(GTFS_DIR);
  const busNames = busRouteNames(gtfs);
  const db = incidents.getDb();

  const rows = readAbsenceDisruptions(db);
  const planned = planBackfillUpdates(rows, now, busNames);
  const incidentsTouched = new Set();
  let written = 0;
  for (const u of planned) {
    if (incidents.incidentUpdateExistsForHour(u.disruptionId, u.ts)) continue; // idempotent
    if (dryRun) {
      console.log(`[dry-run] #${u.disruptionId} ${u.kind}/${u.line}: ${u.description}`);
    } else {
      incidents.recordIncidentUpdate({ ...u, postUri: null });
    }
    incidentsTouched.add(u.disruptionId);
    written++;
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}backfill-incident-updates: ${written} update(s) across ${incidentsTouched.size} incident(s) (scanned ${rows.length} absence disruptions)`,
  );
}

module.exports = {
  readAbsenceDisruptions,
  buildUpdateFor,
  planBackfillUpdates,
  busRouteNames,
  routeTitle,
};

if (require.main === module) runBin(main);
