#!/usr/bin/env node
// Build data/marta/schedule.sqlite — the per-trip scheduled stop curves that
// power BUS schedule adherence (how early/late a specific bus is). One row per
// (bus trip, stop): the stop's lat/lon and its scheduled time in seconds. The
// runtime (src/marta/bus/adherence.js) projects a live bus's position onto its
// trip's curve and reads off the scheduled time there, comparing it to now.
//
// MARTA's realtime feed reports the GTFS trip_id on every vehicle, so we key the
// curve on trip_id directly (no CTA-style route+start_sec disambiguation needed).
// Only bus trips (route_type 3) are written — rail adherence comes straight from
// the feed's signed DELAY field and needs no schedule curve.
//
// stop_times.txt is ~125 MB, so it's streamed line by line and inserted in
// batched transactions; the whole DB never lives in memory. Rebuilt from scratch
// each run (nightly, after fetch-static-gtfs) like schedule-index.json. Gitignored.
const Fs = require('node:fs');
const Path = require('node:path');
const readline = require('node:readline');
const Database = require('better-sqlite3');
const { loadGtfs } = require('../../src/marta/gtfs');
const { parseGtfsTime } = require('../../src/marta/bus/schedule');

const GTFS_DIR =
  process.env.MARTA_GTFS_DIR || Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');
const OUT =
  process.env.MARTA_SCHEDULE_DB_PATH ||
  Path.join(__dirname, '..', '..', 'data', 'marta', 'schedule.sqlite');

function makeReader(headerLine) {
  const cols = headerLine.split(',');
  const idx = (name) => cols.indexOf(name);
  return {
    tripId: idx('trip_id'),
    arr: idx('arrival_time'),
    seq: idx('stop_sequence'),
    stopId: idx('stop_id'),
  };
}

async function main() {
  const gtfs = loadGtfs(GTFS_DIR);
  // Bus trips only, with their stop lat/lon resolvable. route_type 3 = bus.
  const busTripIds = new Set();
  for (const t of gtfs.trips) {
    if (String(gtfs.routesById.get(t.route_id)?.route_type) === '3') busTripIds.add(t.trip_id);
  }
  console.log(`Building schedule.sqlite for ${busTripIds.size} bus trips...`);

  Fs.mkdirSync(Path.dirname(OUT), { recursive: true });
  Fs.rmSync(OUT, { force: true });
  const db = new Database(OUT);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE sched_stops (
      trip_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      sched_sec INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO sched_stops (trip_id, seq, lat, lon, sched_sec) VALUES (?, ?, ?, ?, ?)',
  );

  const header = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: Fs.createReadStream(Path.join(GTFS_DIR, 'stop_times.txt')),
    });
    rl.on('line', (l) => {
      rl.close();
      resolve(l);
    });
    rl.on('error', reject);
  });
  const col = makeReader(header);

  const rl = readline.createInterface({
    input: Fs.createReadStream(Path.join(GTFS_DIR, 'stop_times.txt')),
    crlfDelay: Infinity,
  });
  let firstLine = true;
  let batch = [];
  let rows = 0;
  const flush = db.transaction((items) => {
    for (const r of items) insert.run(r.tripId, r.seq, r.lat, r.lon, r.schedSec);
  });
  for await (const line of rl) {
    if (firstLine) {
      firstLine = false;
      continue;
    }
    if (!line) continue;
    const f = line.split(',');
    const tripId = f[col.tripId];
    if (!tripId || !busTripIds.has(tripId)) continue;
    const seq = Number(f[col.seq]);
    const schedSec = parseGtfsTime(f[col.arr]);
    const stop = gtfs.stopsById.get(f[col.stopId]);
    if (!stop || !Number.isFinite(seq) || schedSec == null) continue;
    const lat = Number.parseFloat(stop.stop_lat);
    const lon = Number.parseFloat(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    batch.push({ tripId, seq, lat, lon, schedSec });
    if (batch.length >= 5000) {
      flush(batch);
      rows += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    flush(batch);
    rows += batch.length;
  }
  db.exec('CREATE INDEX idx_sched_stops_trip ON sched_stops(trip_id)');
  db.close();
  const mb = (Fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${OUT}\n  ${rows} stop rows (${mb} MB)`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
