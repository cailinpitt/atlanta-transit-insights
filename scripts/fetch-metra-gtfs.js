// Builds Metra's static schedule index + line/station geometry from the GTFS
// feed, so the bot runtime reads precomputed JSON instead of re-parsing GTFS on
// every invocation. Sibling of scripts/fetch-gtfs.js (CTA), but Metra is a
// timetabled railroad: GTFS-realtime binds each scheduled `trip_id` to live
// predictions, so we DON'T need CTA's statistical "active trips" integral — we
// need the literal timetable. The index is therefore keyed by `trip_id`.
//
// Outputs:
//   data/metra-gtfs/index.json        — trips (route/headsign/direction/service/
//                                        stop_times), stops, calendar, marker
//   src/metra/data/metraLines.json    — per-line polylines (from shapes.txt)
//   src/metra/data/metraStations.json — per-line ordered stations (from stops.txt)
//   data/metra-gtfs/published.txt     — Metra's publication marker (freshness)
//
// Skips the whole rebuild when Metra's published.txt marker is unchanged, unless
// --force is passed. The realtime trip_id (e.g. `BNSF_BN1272_V2_B`) joins
// directly to a key in this index — verified against the live feed 2026-06-09.

require('../src/shared/env');
const axios = require('axios');
const Fs = require('fs-extra');
const Path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const SCHEDULE_URL = 'https://schedules.metrarail.com/gtfs/schedule.zip';
const PUBLISHED_URL = 'https://schedules.metrarail.com/gtfs/published.txt';
const ZIP_PATH = '/tmp/metra-gtfs.zip';

const OUT_DIR = Path.join(__dirname, '..', 'data', 'metra-gtfs');
const INDEX_PATH = Path.join(OUT_DIR, 'index.json');
const MARKER_PATH = Path.join(OUT_DIR, 'published.txt');
const GEO_DIR = Path.join(__dirname, '..', 'src', 'metra', 'data');
const LINES_PATH = Path.join(GEO_DIR, 'metraLines.json');
const STATIONS_PATH = Path.join(GEO_DIR, 'metraStations.json');

// --- GTFS plumbing (mirrors scripts/fetch-gtfs.js; Metra GTFS is space-padded
// in most files, so trimming every field is essential). ---

// RFC 4180-aware — handles quoted fields with embedded commas, then trims the
// space padding Metra adds after each comma.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    rows.push(row);
  }
  return rows;
}

// GTFS times can exceed 24h ("25:15:00" = 1:15am next day). Returns seconds
// since service-day midnight (caller mods by 86400 when wall-clock is needed).
function parseGtfsTime(s) {
  if (!s) return null;
  const [h, m, sec] = s.split(':').map((x) => Number.parseInt(x, 10));
  if (Number.isNaN(h)) return null;
  return h * 3600 + m * 60 + (sec || 0);
}

function readFromZip(filename) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', ZIP_PATH, filename]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    proc.on('error', reject);
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

function streamFromZip(filename, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', ZIP_PATH, filename]);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', onLine);
    rl.on('close', resolve);
    proc.on('error', reject);
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

async function fetchPublishedMarker() {
  try {
    const { data } = await axios.get(PUBLISHED_URL, { timeout: 30000 });
    return String(data).trim();
  } catch (e) {
    console.warn(`Could not fetch published marker: ${e.message}`);
    return null;
  }
}

async function downloadGtfs() {
  console.log(`Downloading Metra GTFS from ${SCHEDULE_URL}...`);
  const resp = await axios.get(SCHEDULE_URL, { responseType: 'arraybuffer', timeout: 120000 });
  Fs.writeFileSync(ZIP_PATH, resp.data);
  console.log(`  ${(resp.data.length / 1024).toFixed(0)} KB`);
}

// --- Index build ---

async function buildIndex() {
  // routes.txt — small.
  const routes = {};
  for (const r of parseCsv(await readFromZip('routes.txt'))) {
    if (!r.route_id) continue;
    routes[r.route_id] = {
      long_name: r.route_long_name || r.route_id,
      color: r.route_color || null,
      text_color: r.route_text_color || null,
    };
  }

  // stops.txt — id → { name, lat, lon }.
  const stops = {};
  for (const s of parseCsv(await readFromZip('stops.txt'))) {
    if (!s.stop_id) continue;
    const lat = Number.parseFloat(s.stop_lat);
    const lon = Number.parseFloat(s.stop_lon);
    stops[s.stop_id] = {
      name: s.stop_name || s.stop_id,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
  }

  // calendar.txt + calendar_dates.txt — service-day resolution for "is this trip
  // scheduled today" (inferred-cancellation needs it downstream).
  const calendar = {};
  for (const c of parseCsv(await readFromZip('calendar.txt'))) {
    if (!c.service_id) continue;
    calendar[c.service_id] = {
      days: [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday].map(
        (d) => d === '1',
      ),
      start_date: c.start_date,
      end_date: c.end_date,
    };
  }
  const calendarDates = [];
  for (const c of parseCsv(await readFromZip('calendar_dates.txt'))) {
    if (!c.service_id) continue;
    // exception_type 1 = service added on date, 2 = removed.
    calendarDates.push({
      service_id: c.service_id,
      date: c.date,
      exception_type: Number.parseInt(c.exception_type, 10),
    });
  }

  // trips.txt — trip_id → metadata (stop_times filled in below).
  const trips = {};
  for (const t of parseCsv(await readFromZip('trips.txt'))) {
    if (!t.trip_id) continue;
    trips[t.trip_id] = {
      route_id: t.route_id,
      service_id: t.service_id,
      headsign: t.trip_headsign || null,
      shape_id: t.shape_id || null,
      direction_id: t.direction_id != null && t.direction_id !== '' ? Number(t.direction_id) : null,
      stop_times: [],
    };
  }

  // stop_times.txt — large (~3MB); stream and attach to each trip.
  let header = null;
  let skipped = 0;
  await streamFromZip('stop_times.txt', (line) => {
    const parts = parseCsvLine(line);
    if (!header) {
      header = parts;
      return;
    }
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    const trip = trips[row.trip_id];
    if (!trip) {
      skipped++;
      return;
    }
    trip.stop_times.push({
      stop_id: row.stop_id,
      stop_sequence: Number.parseInt(row.stop_sequence, 10),
      arrival: parseGtfsTime(row.arrival_time),
      departure: parseGtfsTime(row.departure_time),
    });
  });
  if (skipped > 0) console.log(`  ${skipped} stop_times rows had no matching trip (skipped)`);

  // Sort each trip's stops by sequence (GTFS doesn't guarantee file order, and
  // Metra's sequences are sparse — 1, 3, 4, …).
  for (const trip of Object.values(trips)) {
    trip.stop_times.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }

  return { routes, stops, calendar, calendarDates, trips };
}

// --- Geometry build (frontend maps + speedmap projection) ---

async function buildShapes() {
  // shape_id → ordered [[lat, lon], …] by shape_pt_sequence.
  const byShape = new Map();
  let header = null;
  await streamFromZip('shapes.txt', (line) => {
    const parts = parseCsvLine(line);
    if (!header) {
      header = parts;
      return;
    }
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    const lat = Number.parseFloat(row.shape_pt_lat);
    const lon = Number.parseFloat(row.shape_pt_lon);
    const seq = Number.parseInt(row.shape_pt_sequence, 10);
    if (!row.shape_id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!byShape.has(row.shape_id)) byShape.set(row.shape_id, []);
    byShape.get(row.shape_id).push({ seq, lat, lon });
  });
  for (const pts of byShape.values()) pts.sort((a, b) => a.seq - b.seq);
  return byShape;
}

// Per-line polylines: every distinct shape_id used by a line's trips, rendered
// as an ordered coordinate list. A line can ship several shapes (direction +
// branches, e.g. ME's three IB shapes) — keep them all; the speedmap projects
// onto the nearest.
function buildLineGeometry(trips, byShape) {
  const lineShapeIds = new Map();
  for (const trip of Object.values(trips)) {
    if (!trip.route_id || !trip.shape_id) continue;
    if (!lineShapeIds.has(trip.route_id)) lineShapeIds.set(trip.route_id, new Set());
    lineShapeIds.get(trip.route_id).add(trip.shape_id);
  }
  const out = {};
  for (const [route, shapeIds] of lineShapeIds) {
    const polylines = [];
    for (const sid of shapeIds) {
      const pts = byShape.get(sid);
      if (pts && pts.length > 1) polylines.push(pts.map((p) => [p.lat, p.lon]));
    }
    if (polylines.length > 0) out[route] = polylines;
  }
  return out;
}

// Per-line ordered station list, taken from the line's longest trip (the trip
// that visits the most stops — its sequence is the most complete picture of the
// line's stops in order). Mapped through stops.txt for coords.
function buildLineStations(trips, stops) {
  const longestByRoute = new Map();
  for (const trip of Object.values(trips)) {
    if (!trip.route_id) continue;
    const cur = longestByRoute.get(trip.route_id);
    if (!cur || trip.stop_times.length > cur.stop_times.length) {
      longestByRoute.set(trip.route_id, trip);
    }
  }
  const out = {};
  for (const [route, trip] of longestByRoute) {
    out[route] = trip.stop_times
      .map((st) => {
        const s = stops[st.stop_id];
        if (!s) return null;
        return { id: st.stop_id, name: s.name, lat: s.lat, lon: s.lon };
      })
      .filter(Boolean);
  }
  return out;
}

async function main() {
  const force = process.argv.includes('--force');
  const marker = await fetchPublishedMarker();
  const prevMarker = Fs.existsSync(MARKER_PATH)
    ? Fs.readFileSync(MARKER_PATH, 'utf8').trim()
    : null;
  if (!force && marker && prevMarker === marker && Fs.existsSync(INDEX_PATH)) {
    console.log(
      `Metra GTFS unchanged (published ${marker}); skipping rebuild. Use --force to override.`,
    );
    return;
  }

  await downloadGtfs();

  const { routes, stops, calendar, calendarDates, trips } = await buildIndex();
  const byShape = await buildShapes();
  const lineGeometry = buildLineGeometry(trips, byShape);
  const lineStations = buildLineStations(trips, stops);

  Fs.ensureDirSync(OUT_DIR);
  Fs.ensureDirSync(GEO_DIR);

  Fs.writeFileSync(
    INDEX_PATH,
    `${JSON.stringify({ generated_at: Date.now(), published: marker, routes, stops, calendar, calendarDates, trips })}\n`,
  );
  Fs.writeFileSync(LINES_PATH, `${JSON.stringify(lineGeometry)}\n`);
  Fs.writeFileSync(STATIONS_PATH, `${JSON.stringify(lineStations, null, 2)}\n`);
  if (marker) Fs.writeFileSync(MARKER_PATH, `${marker}\n`);

  const tripCount = Object.keys(trips).length;
  const stopCount = Object.keys(stops).length;
  const lineCount = Object.keys(lineGeometry).length;
  console.log(
    `Wrote index (${tripCount} trips, ${stopCount} stops), geometry (${lineCount} lines), stations.`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { parseCsvLine, parseCsv, parseGtfsTime, buildLineGeometry, buildLineStations };
