#!/usr/bin/env node
// Read-only health check for the MARTA capture pipeline. Run on the prod server
// (where the observe cron jobs write state/marta.sqlite) to confirm data is
// flowing: per-table row counts, freshness, snapshot cadence, retention, and a
// quick coverage sanity check. Touches nothing — safe to run anytime.
//
//   node scripts/marta/observe-status.js
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });
const { getDb } = require('../../src/marta/storage');

const now = Date.now();
const MIN = 60_000;
const ago = (ts) => (ts == null ? 'never' : `${Math.round((now - ts) / 1000)}s ago`);
const db = getDb();

function tableStat(t) {
  const row = db.prepare(`SELECT COUNT(*) c, MIN(ts) mn, MAX(ts) mx FROM ${t}`).get();
  const snaps10m = db
    .prepare(`SELECT COUNT(DISTINCT ts) c FROM ${t} WHERE ts >= ?`)
    .get(now - 10 * MIN).c;
  const snaps1h = db
    .prepare(`SELECT COUNT(DISTINCT ts) c FROM ${t} WHERE ts >= ?`)
    .get(now - 60 * MIN).c;
  return { rows: row.c, oldest: row.mn, newest: row.mx, snaps10m, snaps1h };
}

const TABLES = ['bus_observations', 'bus_trip_status', 'rail_observations', 'rail_arrivals'];
// How stale is too stale, per feed (positions/rail every ~min, trip-updates ~5m).
const STALE_MS = {
  bus_observations: 3 * MIN,
  rail_observations: 3 * MIN,
  rail_arrivals: 3 * MIN,
  bus_trip_status: 12 * MIN,
};

let warnings = 0;
console.log(`MARTA capture status @ ${new Date(now).toISOString()}\n`);
for (const t of TABLES) {
  const s = tableStat(t);
  const stale = s.newest == null || now - s.newest > STALE_MS[t];
  const retentionDays = s.oldest ? ((now - s.oldest) / (24 * 60 * MIN)).toFixed(1) : '0';
  const flag = stale ? '  ⚠ STALE' : '';
  if (stale) warnings++;
  console.log(
    `${t.padEnd(20)} rows=${String(s.rows).padStart(9)}  newest=${ago(s.newest).padEnd(10)}` +
      `  snaps[10m]=${String(s.snaps10m).padStart(3)} [1h]=${String(s.snaps1h).padStart(3)}` +
      `  span=${retentionDays}d${flag}`,
  );
}

// Coverage in the last 10 min: are we actually seeing the network?
const recent = now - 10 * MIN;
const routes = db
  .prepare('SELECT COUNT(DISTINCT route) c FROM bus_observations WHERE ts >= ?')
  .get(recent).c;
const lines = db
  .prepare('SELECT COUNT(DISTINCT line) c FROM rail_observations WHERE ts >= ?')
  .get(recent).c;
const trains = db
  .prepare('SELECT COUNT(DISTINCT train_id) c FROM rail_observations WHERE ts >= ?')
  .get(recent).c;
console.log(
  `\nlast 10 min coverage: ${routes} bus routes, ${lines} rail lines, ${trains} distinct trains`,
);

console.log(
  warnings === 0
    ? '\n✅ all feeds fresh'
    : `\n⚠ ${warnings} feed(s) stale — check state/logs/ and the crontab`,
);
process.exit(warnings === 0 ? 0 : 1);
