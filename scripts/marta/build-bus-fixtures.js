#!/usr/bin/env node
// Derive committed test fixtures from the latest raw captures under
// data/marta/. Raw feeds are too large to commit (TripUpdates ~800 KB,
// static GTFS ~20 MB / 125 MB unzipped), so this writes a minimal, consistent
// slice into test/marta/fixtures/:
//
//   bus-vehiclepositions.pb   raw VehiclePositions, verbatim (~14 KB)
//   bus-tripupdates.pb        first N TripUpdate entities, re-encoded
//   gtfs/routes.txt           full (small; covers every route)
//   gtfs/trips.txt            only trips referenced by the two .pb fixtures
//   gtfs/stops.txt            only stops referenced by the TripUpdates fixture
//   gtfs/calendar*.txt        full (tiny)
//
// The mini-GTFS is exactly the rows the realtime→static join test needs, so the
// fixtures stay self-consistent: every fixture tripId resolves to a route.
const Fs = require('node:fs');
const Path = require('node:path');
const GtfsRt = require('gtfs-realtime-bindings');
const { decodeFeed, parseVehiclePosition, parseTripUpdate } = require('../../src/marta/bus/api');
const { parseCsv } = require('../../src/marta/gtfs');

const FeedMessage = GtfsRt.transit_realtime.FeedMessage;
const DATA = Path.join(__dirname, '..', '..', 'data', 'marta');
const CAPTURES = Path.join(DATA, 'captures');
const GTFS_DIR = Path.join(DATA, 'gtfs');
const OUT = Path.join(__dirname, '..', '..', 'test', 'marta', 'fixtures');
const OUT_GTFS = Path.join(OUT, 'gtfs');

// How many TripUpdate entities to keep. Enough to exercise multi-route,
// multi-stop decoding without committing the full ~800 KB feed.
const TU_KEEP = 12;
// How many VehiclePositions to keep. Capped because each kept vehicle pulls its
// trip's full GTFS shape into shapes.txt (~600 pts each); keeping all 180 made a
// ~3 MB fixture. ~16 still spans several routes and a mix of with/without speed.
const VP_KEEP = 16;

function csvStringify(rows) {
  if (rows.length === 0) return '';
  const header = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => esc(r[h])).join(','));
  return `${lines.join('\n')}\n`;
}

function trimFeed(buf, keep) {
  const obj = FeedMessage.toObject(decodeFeed(buf));
  return Buffer.from(
    FeedMessage.encode(
      FeedMessage.fromObject({ header: obj.header, entity: obj.entity.slice(0, keep) }),
    ).finish(),
  );
}

function main() {
  const vpBuf = trimFeed(
    Fs.readFileSync(Path.join(CAPTURES, 'bus-vehiclepositions-latest.pb')),
    VP_KEEP,
  );
  const trimmedBuf = trimFeed(
    Fs.readFileSync(Path.join(CAPTURES, 'bus-tripupdates-latest.pb')),
    TU_KEEP,
  );

  // Collect the keys the mini-GTFS must cover.
  const vehicles = (decodeFeed(vpBuf).entity || []).map(parseVehiclePosition).filter(Boolean);
  const tripUpdates = (decodeFeed(trimmedBuf).entity || []).map(parseTripUpdate).filter(Boolean);
  const tripIds = new Set();
  for (const v of vehicles) if (v.tripId) tripIds.add(v.tripId);
  for (const u of tripUpdates) if (u.tripId) tripIds.add(u.tripId);
  const stopIds = new Set();
  for (const u of tripUpdates) for (const s of u.stopUpdates) if (s.stopId) stopIds.add(s.stopId);

  // Subset trips.txt and stops.txt; copy small files whole.
  const trips = parseCsv(Fs.readFileSync(Path.join(GTFS_DIR, 'trips.txt'), 'utf8'));
  const stops = parseCsv(Fs.readFileSync(Path.join(GTFS_DIR, 'stops.txt'), 'utf8'));
  const tripRows = trips.filter((t) => tripIds.has(t.trip_id));

  // Subset shapes.txt to the shapes the fixture trips run (the pdist substrate).
  const shapeIds = new Set(tripRows.map((t) => t.shape_id).filter(Boolean));
  const shapeRows = parseCsv(Fs.readFileSync(Path.join(GTFS_DIR, 'shapes.txt'), 'utf8')).filter(
    (s) => shapeIds.has(s.shape_id),
  );
  // Pull in parent stations of any referenced platform so station/platform
  // relationships are exercisable from the fixture too.
  const stopIdsPlus = new Set(stopIds);
  for (const s of stops) {
    if (stopIds.has(s.stop_id) && s.parent_station) stopIdsPlus.add(s.parent_station);
  }
  const stopRows = stops.filter((s) => stopIdsPlus.has(s.stop_id));

  Fs.mkdirSync(OUT_GTFS, { recursive: true });
  Fs.writeFileSync(Path.join(OUT, 'bus-vehiclepositions.pb'), vpBuf);
  Fs.writeFileSync(Path.join(OUT, 'bus-tripupdates.pb'), trimmedBuf);
  Fs.writeFileSync(Path.join(OUT_GTFS, 'trips.txt'), csvStringify(tripRows));
  Fs.writeFileSync(Path.join(OUT_GTFS, 'stops.txt'), csvStringify(stopRows));
  Fs.writeFileSync(Path.join(OUT_GTFS, 'shapes.txt'), csvStringify(shapeRows));
  for (const f of ['routes.txt', 'calendar.txt', 'calendar_dates.txt']) {
    Fs.copyFileSync(Path.join(GTFS_DIR, f), Path.join(OUT_GTFS, f));
  }

  console.log(`Fixtures written → ${OUT}`);
  console.log(
    `  bus-vehiclepositions.pb ${vpBuf.length}B (${vehicles.length} vehicles)\n` +
      `  bus-tripupdates.pb ${trimmedBuf.length}B (${tripUpdates.length} trips)\n` +
      `  gtfs/trips.txt ${tripRows.length} rows  gtfs/stops.txt ${stopRows.length} rows`,
  );
}

main();
