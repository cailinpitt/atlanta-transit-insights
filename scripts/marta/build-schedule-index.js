#!/usr/bin/env node
// Build the MARTA scheduled-headway index from the static GTFS in
// data/marta/gtfs/ (run scripts/marta/fetch-static-gtfs.js first). Writes
// data/marta/schedule-index.json — the precomputed median headway / trip
// duration / active-trip count per (shape, dayType, hour) and per
// (route, direction, dayType, hour) that gap/ghost detection reads.
//
// stop_times.txt is ~125 MB, so it's streamed line by line; we keep only each
// trip's first departure and last arrival.
const Fs = require('node:fs');
const Path = require('node:path');
const readline = require('node:readline');
const { loadGtfs } = require('../../src/marta/gtfs');
const {
  parseGtfsTime,
  hourOfSec,
  tripActiveAt,
  tripInServiceDuringHour,
  headwayFromDepartures,
  median,
  dayTypeForCalendarRow,
} = require('../../src/marta/bus/schedule');
const { loadShapes } = require('../../src/marta/bus/shapes');

const GTFS_DIR = Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');
const OUT = Path.join(__dirname, '..', '..', 'data', 'marta', 'schedule-index.json');

// Parse one CSV line into the needed stop_times columns by header index.
function makeStopTimesReader(headerLine) {
  const cols = headerLine.split(',');
  const idx = (name) => cols.indexOf(name);
  return {
    tripId: idx('trip_id'),
    dep: idx('departure_time'),
    arr: idx('arrival_time'),
    seq: idx('stop_sequence'),
  };
}

async function streamFirstLastStops(col) {
  // tripId -> { firstSeq, firstDep, lastSeq, lastArr }
  const perTrip = new Map();
  const rl = readline.createInterface({
    input: Fs.createReadStream(Path.join(GTFS_DIR, 'stop_times.txt')),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    if (!line) continue;
    const f = line.split(',');
    const tripId = f[col.tripId];
    const seq = Number(f[col.seq]);
    if (!tripId || !Number.isFinite(seq)) continue;
    let rec = perTrip.get(tripId);
    if (!rec) {
      rec = { firstSeq: Infinity, firstDep: null, lastSeq: -Infinity, lastArr: null };
      perTrip.set(tripId, rec);
    }
    if (seq < rec.firstSeq) {
      rec.firstSeq = seq;
      rec.firstDep = parseGtfsTime(f[col.dep]);
    }
    if (seq > rec.lastSeq) {
      rec.lastSeq = seq;
      rec.lastArr = parseGtfsTime(f[col.arr]);
    }
  }
  return perTrip;
}

// Set out[dayType][hour] = value, creating the inner object as needed.
function setHour(out, dayType, hour, value) {
  if (!out[dayType]) out[dayType] = {};
  out[dayType][Number(hour)] = value;
}

// Fold per-bucket departure lists into { dayType: { hour: value } } maps.
function buildHeadways(depBuckets) {
  const out = {}; // dayType -> hour -> headwayMin
  for (const [key, deps] of depBuckets) {
    const [dayType, hourStr] = key.split('|');
    const hw = headwayFromDepartures(deps);
    if (hw == null) continue;
    setHour(out, dayType, hourStr, Math.round(hw * 10) / 10);
  }
  return out;
}

function buildMedians(buckets) {
  const out = {};
  for (const [key, vals] of buckets) {
    const [dayType, hourStr] = key.split('|');
    const m = median(vals);
    if (m == null) continue;
    setHour(out, dayType, hourStr, Math.round(m * 10) / 10);
  }
  return out;
}

async function main() {
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);

  // service_id -> dayType ('weekday'|'saturday'|'sunday'), skipping holiday specials.
  const dayTypeByService = new Map();
  const calendar = require('../../src/marta/gtfs').parseCsv(
    Fs.readFileSync(Path.join(GTFS_DIR, 'calendar.txt'), 'utf8'),
  );
  for (const row of calendar) {
    const dt = dayTypeForCalendarRow(row);
    if (dt) dayTypeByService.set(row.service_id, dt);
  }

  // trip_id -> { route, direction, shapeId, dayType }
  const tripMeta = new Map();
  for (const t of gtfs.trips) {
    const dayType = dayTypeByService.get(t.service_id);
    if (!dayType) continue;
    const route = gtfs.routesById.get(t.route_id)?.route_short_name;
    if (!route) continue;
    tripMeta.set(t.trip_id, { route, direction: t.direction_id, shapeId: t.shape_id, dayType });
  }

  console.log(`Streaming stop_times.txt for ${tripMeta.size} scheduled trips...`);
  const stHeader = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: Fs.createReadStream(Path.join(GTFS_DIR, 'stop_times.txt')),
    });
    rl.on('line', (l) => {
      rl.close();
      resolve(l);
    });
    rl.on('error', reject);
  });
  const firstLast = await streamFirstLastStops(makeStopTimesReader(stHeader));

  // Bucket departures/durations per SHAPE (headway is measured WITHIN a pattern:
  // mashing a direction's shapes together yields ~0-min gaps whenever a through
  // trip and a branch leave a terminal at the same time). active-by-hour is a
  // trip COUNT, so it's safe to bucket per route+direction.
  const shapeDeps = new Map(); // shapeId|dayType|hour -> [depSec]
  const shapeDur = new Map(); // shapeId|dayType|hour -> [durMin]
  const routeActive = new Map(); // route|dir|dayType|hour -> snapshot count (@:30)
  const routeInService = new Map(); // route|dir|dayType|hour -> flow count (overlap)
  const shapeMeta = new Map(); // shapeId -> { route, direction }

  for (const [tripId, meta] of tripMeta) {
    const fl = firstLast.get(tripId);
    if (!fl || fl.firstDep == null) continue;
    if (!shapeMeta.has(meta.shapeId)) {
      shapeMeta.set(meta.shapeId, { route: meta.route, direction: meta.direction });
    }
    const sKey = `${meta.dayType}|${hourOfSec(fl.firstDep)}`;
    push(shapeDeps, `${meta.shapeId}|${sKey}`, fl.firstDep);
    if (fl.lastArr != null && fl.lastArr > fl.firstDep) {
      push(shapeDur, `${meta.shapeId}|${sKey}`, (fl.lastArr - fl.firstDep) / 60);
    }
    if (fl.lastArr != null) {
      // active-by-hour = trips in progress at :30 past each hour — a SNAPSHOT of
      // simultaneous service (the right unit to compare against observed
      // vehicles-per-snapshot in ghost detection; counting every trip that
      // merely touches an hour overcounts ~2x and false-fires).
      //
      // in-service-by-hour = every distinct trip whose span touches the hour — a
      // FLOW count. This is the denominator for cancellation-surge sizing, whose
      // numerator is distinct trips canceled over a rolling hour; the snapshot
      // count there undercounts and yields >100% ("7 of 3").
      for (let h = 0; h < 24; h++) {
        const k = `${meta.route}|${meta.direction}|${meta.dayType}|${h}`;
        if (tripActiveAt(fl.firstDep, fl.lastArr, h * 3600 + 1800)) {
          routeActive.set(k, (routeActive.get(k) || 0) + 1);
        }
        if (tripInServiceDuringHour(fl.firstDep, fl.lastArr, h)) {
          routeInService.set(k, (routeInService.get(k) || 0) + 1);
        }
      }
    }
  }

  // Assemble per-shape headways/durations.
  const shapesOut = {};
  const shapeHeadways = groupByPrefix(shapeDeps);
  const shapeDurations = groupByPrefix(shapeDur);
  for (const shapeId of new Set([...shapeHeadways.keys(), ...shapeDurations.keys()])) {
    const m = shapeMeta.get(shapeId);
    shapesOut[shapeId] = {
      route: m?.route ?? null,
      direction: m?.direction ?? null,
      lengthFt: shapes.get(shapeId)?.lengthFt ?? null,
      headways: buildHeadways(shapeHeadways.get(shapeId) || new Map()),
      durations: buildMedians(shapeDurations.get(shapeId) || new Map()),
    };
  }

  // Route-direction rollup: the FALLBACK when a live shape isn't in the index.
  // Use the median of the shapes' per-pattern headways for that route+dir (a
  // typical pattern headway — conservative, never the bogus ~0 a raw re-mash
  // gives). activeByHour stays as the true trip count.
  const routesOut = {};
  for (const s of Object.values(shapesOut)) {
    if (s.route == null) continue;
    const dir = String(s.direction);
    if (!routesOut[s.route]) routesOut[s.route] = {};
    if (!routesOut[s.route][dir]) routesOut[s.route][dir] = { _hw: {}, activeByHour: {} };
    const hw = routesOut[s.route][dir]._hw;
    for (const [dayType, byHour] of Object.entries(s.headways)) {
      if (!hw[dayType]) hw[dayType] = {};
      for (const [hour, val] of Object.entries(byHour)) {
        if (!hw[dayType][hour]) hw[dayType][hour] = [];
        hw[dayType][hour].push(val);
      }
    }
  }
  for (const [route, byDir] of Object.entries(routesOut)) {
    for (const [dir, agg] of Object.entries(byDir)) {
      const headways = {};
      for (const [dayType, byHour] of Object.entries(agg._hw)) {
        for (const [hour, list] of Object.entries(byHour)) {
          setHour(headways, dayType, hour, Math.round(median(list) * 10) / 10);
        }
      }
      byDir[dir] = {
        headways,
        activeByHour: activeByHourFor(routeActive, route, dir),
        inServiceByHour: activeByHourFor(routeInService, route, dir),
      };
    }
  }

  const index = {
    generatedAt: Date.now(),
    gtfsCalendarStart: calendar[0]?.start_date ?? null,
    shapes: shapesOut,
    routes: routesOut,
  };
  Fs.writeFileSync(OUT, JSON.stringify(index));
  console.log(
    `Wrote ${OUT}\n  shapes=${Object.keys(shapesOut).length} routes=${Object.keys(routesOut).length}`,
  );
}

function push(map, key, val) {
  let a = map.get(key);
  if (!a) {
    a = [];
    map.set(key, a);
  }
  a.push(val);
}

// shapeId|dayType|hour -> [vals]   ⇒   Map<shapeId, Map<dayType|hour, [vals]>>
function groupByPrefix(buckets) {
  const out = new Map();
  for (const [key, vals] of buckets) {
    const i = key.indexOf('|');
    const shapeId = key.slice(0, i);
    const rest = key.slice(i + 1);
    if (!out.has(shapeId)) out.set(shapeId, new Map());
    out.get(shapeId).set(rest, vals);
  }
  return out;
}

function activeByHourFor(routeActive, route, dir) {
  const out = {};
  const prefix = `${route}|${dir}|`;
  for (const [key, count] of routeActive) {
    if (!key.startsWith(prefix)) continue;
    const [, , dayType, hour] = key.split('|');
    setHour(out, dayType, hour, count);
  }
  return out;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
