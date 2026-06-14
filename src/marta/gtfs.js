// MARTA static GTFS loader + the realtime→static join.
//
// MARTA's GTFS-realtime bus feed reports the PUBLIC route number in
// `trip.routeId` (e.g. "20"), NOT the internal GTFS `route_id` (e.g. "26915").
// The stable key shared by both feeds is `trip_id`, so the canonical join is:
//
//   realtime entity ──trip_id──▶ trips.txt ──route_id──▶ routes.txt
//
// We also derive the canonical `direction_id` from trips.txt, because the
// realtime `directionId` field is unreliable on MARTA (observed values include
// 0, 5, 9, 11, 14 — not the GTFS 0/1 it's supposed to be).
//
// This module reads raw GTFS .txt files directly (no precomputed index yet);
// it's the foundation the bus detector port will build its indexes on.
const Fs = require('node:fs');
const Path = require('node:path');

// Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas, and
// "" escaped quotes. GTFS is plain CSV with a header row. Strips a UTF-8 BOM
// and tolerates both \n and \r\n. Returns an array of plain row objects.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      rows.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  // Trailing field/record with no newline at EOF.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip blank trailing lines.
    if (cells.length === 1 && cells[0] === '') continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] ?? '';
    out.push(obj);
  }
  return out;
}

// GTFS route_type → coarse mode label. MARTA uses only three: 3 = bus,
// 1 = heavy rail (Red/Gold/Blue/Green), 0 = streetcar (Atlanta Streetcar).
function routeMode(route) {
  switch (String(route?.route_type)) {
    case '3':
      return 'bus';
    case '1':
      return 'rail';
    case '0':
      return 'streetcar';
    default:
      return 'other';
  }
}

function readTxt(dir, name) {
  return Fs.readFileSync(Path.join(dir, name), 'utf8');
}

// Load a GTFS directory (extracted google_transit.zip) and build the indexes
// the realtime join needs. `files` lets tests point at a subset; defaults to
// the standard filenames.
function loadGtfs(dir) {
  const routes = parseCsv(readTxt(dir, 'routes.txt'));
  const trips = parseCsv(readTxt(dir, 'trips.txt'));
  const stops = parseCsv(readTxt(dir, 'stops.txt'));

  const routesById = new Map();
  const routesByShortName = new Map();
  for (const r of routes) {
    routesById.set(r.route_id, r);
    // route_short_name is what the realtime feed reports. Unique per route on
    // MARTA, but guard against an accidental collision by keeping the first.
    if (r.route_short_name && !routesByShortName.has(r.route_short_name)) {
      routesByShortName.set(r.route_short_name, r);
    }
  }

  const tripsById = new Map();
  for (const t of trips) tripsById.set(t.trip_id, t);

  const stopsById = new Map();
  const childrenByParent = new Map();
  for (const s of stops) {
    stopsById.set(s.stop_id, s);
    if (s.parent_station) {
      if (!childrenByParent.has(s.parent_station)) childrenByParent.set(s.parent_station, []);
      childrenByParent.get(s.parent_station).push(s);
    }
  }

  return {
    routes,
    trips,
    stops,
    routesById,
    routesByShortName,
    tripsById,
    stopsById,
    childrenByParent,

    // Resolve a realtime bus entity to its canonical static route. `tripId` is
    // authoritative; `realtimeRouteId` (the public number) is only a fallback
    // for trips missing from a stale static feed. Returns null when neither
    // resolves. `shortNameMatches` flags realtime/static disagreement so a
    // caller can log feed drift.
    resolveRoute({ tripId, realtimeRouteId } = {}) {
      const trip = tripId != null ? tripsById.get(tripId) : null;
      if (trip) {
        const route = routesById.get(trip.route_id);
        if (route) {
          return {
            route,
            trip,
            via: 'tripId',
            shortNameMatches:
              realtimeRouteId == null || route.route_short_name === String(realtimeRouteId),
          };
        }
      }
      if (realtimeRouteId != null) {
        const route = routesByShortName.get(String(realtimeRouteId));
        if (route) return { route, trip: trip || null, via: 'shortName', shortNameMatches: true };
      }
      return null;
    },

    // Canonical GTFS direction_id ("0"/"1") for a trip, or null. Prefer this
    // over the realtime directionId, which is unreliable on MARTA.
    directionIdForTrip(tripId) {
      const trip = tripsById.get(tripId);
      return trip ? trip.direction_id : null;
    },
  };
}

module.exports = { loadGtfs, parseCsv, routeMode };
