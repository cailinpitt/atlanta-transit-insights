#!/usr/bin/env node
// Build the MARTA heavy-rail station roster from the static GTFS in
// data/marta/gtfs/ (run scripts/marta/fetch-static-gtfs.js first). Writes
// src/marta/rail-stations.json — one entry per heavy-rail station:
//
//   { "name": "BANKHEAD Station", "lines": ["green"] }
//
// The alert station extractor (src/marta/alert/stations.js) resolves the
// station names that appear in MARTA's official rail-alert prose ("between
// Bankhead and Ashby") to these canonical names, line-scoped, so the web
// export can tie an alert to the right station pages.
//
// Naming: station `name` is the raw GTFS parent-station `stop_name` with only
// the trailing "STATION" word title-cased ("BANKHEAD STATION" -> "BANKHEAD
// Station"). slugifyStation() lowercases everything, so the exact casing is
// cosmetic — what matters is that these names slugify identically to the
// website's bundled trainStations.json (the source of truth for /station/:slug
// pages). Streetcar stops are intentionally excluded: the extractor is
// heavy-rail only, and the streetcar carries no station-named alerts.
//
// Idempotent: re-run after a GTFS refresh whenever the rail station set or
// line assignments change.
const Fs = require('node:fs');
const Path = require('node:path');
const readline = require('node:readline');
const { parseCsv } = require('../../src/marta/gtfs');

const GTFS_DIR = Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');
const OUT = Path.join(__dirname, '..', '..', 'src', 'marta', 'rail-stations.json');

// route_type 1 = heavy rail. route_short_name is RED/GOLD/BLUE/GREEN; the rest
// of the system (and the website) keys lines lowercase.
const RAIL_ROUTE_TYPE = '1';

function readCsv(name) {
  return parseCsv(Fs.readFileSync(Path.join(GTFS_DIR, name), 'utf8'));
}

// "BANKHEAD STATION" -> "BANKHEAD Station". Leaves a name without the suffix
// untouched.
function normalizeStationName(name) {
  return String(name || '')
    .trim()
    .replace(/STATION\s*$/i, 'Station');
}

async function main() {
  const railLineByRoute = new Map(); // route_id -> line key (lowercase)
  for (const r of readCsv('routes.txt')) {
    if (String(r.route_type) === RAIL_ROUTE_TYPE && r.route_short_name) {
      railLineByRoute.set(r.route_id, r.route_short_name.toLowerCase());
    }
  }

  const lineByTrip = new Map(); // rail trip_id -> line key
  for (const t of readCsv('trips.txt')) {
    const line = railLineByRoute.get(t.route_id);
    if (line) lineByTrip.set(t.trip_id, line);
  }

  // stop_id -> { parentId, parentName }. Platform stops carry parent_station;
  // a parent station row is its own parent.
  const stopById = new Map();
  for (const s of readCsv('stops.txt')) stopById.set(s.stop_id, s);
  function parentStation(stopId) {
    const s = stopById.get(stopId);
    if (!s) return null;
    const parentId = s.parent_station?.trim() ? s.parent_station : s.stop_id;
    const parent = stopById.get(parentId) || s;
    return { id: parentId, name: (parent.stop_name || s.stop_name || '').trim() };
  }

  // Stream stop_times.txt (~125 MB) and accumulate, per rail trip, the set of
  // lines that call at each parent station.
  const linesByStation = new Map(); // station name -> Set<line>
  const rl = readline.createInterface({
    input: Fs.createReadStream(Path.join(GTFS_DIR, 'stop_times.txt')),
    crlfDelay: Infinity,
  });
  let tripIdx = -1;
  let stopIdx = -1;
  for await (const line of rl) {
    if (tripIdx < 0) {
      const cols = line.split(',');
      tripIdx = cols.indexOf('trip_id');
      stopIdx = cols.indexOf('stop_id');
      continue;
    }
    // stop_times.txt has no quoted commas, so a plain split is safe and fast.
    const cols = line.split(',');
    const railLine = lineByTrip.get(cols[tripIdx]);
    if (!railLine) continue;
    const parent = parentStation(cols[stopIdx]);
    if (!parent?.name) continue;
    const name = normalizeStationName(parent.name);
    if (!linesByStation.has(name)) linesByStation.set(name, new Set());
    linesByStation.get(name).add(railLine);
  }

  const roster = [...linesByStation.entries()]
    .map(([name, lines]) => ({ name, lines: [...lines].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  Fs.writeFileSync(OUT, `${JSON.stringify(roster, null, 2)}\n`);
  console.log(`Wrote ${roster.length} rail stations to ${Path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
