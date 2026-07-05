// MARTA bus schedule adherence — how early/late a specific bus is.
//
// MARTA's bus feed reports no delay, so (like CTA) we back it out of geometry:
// project the bus's live (lat, lon) onto its trip's scheduled stop-path and read
// off the interpolated scheduled time at that point, then compare to the wall
// clock. The feed gives the exact GTFS trip_id on every vehicle, so we look the
// curve up directly (data/marta/schedule.sqlite, built by
// scripts/marta/build-schedule-stops.js) — no stst/route disambiguation.
//
// Two guards keep it honest, and notably drop the recycled-trip-id garbage that
// makes the raw arrival-prediction deltas unusable (a morning trip id still
// emitting at night projects to a morning schedule → a >45-min "delay" → omitted):
//   MAX_OFFROUTE_FT   — too far off the trip's path to credibly be on it
//   MAX_PLAUSIBLE_DEV_MIN — absurd lateness is a bad match / service-day wrap
// On either, we return null and the caller simply omits the annotation.
const Path = require('node:path');
const Fs = require('node:fs');
const Database = require('better-sqlite3');

const SCHED_DB_PATH =
  process.env.MARTA_SCHEDULE_DB_PATH ||
  Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'schedule.sqlite');

// Equirectangular ft-per-degree (matches shared/geo's earth radius), good enough
// for the few-hundred-foot projection distances we gate on.
const R_FT = 20902231;
const FT_PER_DEG = (Math.PI / 180) * R_FT;
const MAX_OFFROUTE_FT = 600;
const MAX_PLAUSIBLE_DEV_MIN = 45;

let _schedDb; // undefined = not tried, null = absent, else Database
let _schedStmt = null;
function schedDb() {
  if (_schedDb !== undefined) return _schedDb;
  _schedDb = Fs.existsSync(SCHED_DB_PATH)
    ? new Database(SCHED_DB_PATH, { readonly: true, fileMustExist: true })
    : null;
  return _schedDb;
}

// Test hook: drop the cached handle so a freshly-built DB is picked up.
function _resetSchedDb() {
  if (_schedDb) _schedDb.close();
  _schedDb = undefined;
  _schedStmt = null;
  _tripStopsStmt = null;
}

// Seconds since midnight in Atlanta wall-clock for `now` — the base GTFS
// scheduled times use. The plausibility cap absorbs the after-midnight
// service-day wrap this doesn't model.
function atlantaSecondsOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const g = (k) => +parts.find((p) => p.type === k).value;
  return (g('hour') % 24) * 3600 + g('minute') * 60 + g('second');
}

// Project (lat, lon) onto an ordered stop path and read the scheduled time at the
// closest point. `stops` = [{ lat, lon, schedSec }] in sequence. Returns
// { distFt, schedSec } (distFt = off-path distance, our confidence gate), or null
// for <2 stops. Pure; exported for testing.
function deviationFromStops(
  stops,
  lat,
  lon,
  { ftPerDegLon = FT_PER_DEG * Math.cos((lat * Math.PI) / 180) } = {},
) {
  if (!stops || stops.length < 2) return null;
  const px = lon * ftPerDegLon;
  const py = lat * FT_PER_DEG;
  let best = null;
  for (let i = 0; i < stops.length - 1; i++) {
    const ax = stops[i].lon * ftPerDegLon;
    const ay = stops[i].lat * FT_PER_DEG;
    const bx = stops[i + 1].lon * ftPerDegLon;
    const by = stops[i + 1].lat * FT_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const distFt = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || distFt < best.distFt) {
      const schedSec = stops[i].schedSec + t * (stops[i + 1].schedSec - stops[i].schedSec);
      best = { distFt, schedSec };
    }
  }
  return best;
}

// Ordered scheduled stops for a trip, from schedule.sqlite — [{ lat, lon }] in
// stop_sequence order, or [] when the DB is absent or the trip has no curve. The
// bunching/gap maps use these as a route's REAL stop list (the CTA pattern-stops
// analog), instead of geometric proximity which pulls in other routes' stops.
let _tripStopsStmt = null;
function tripStops(tripId) {
  if (tripId == null) return [];
  const db = schedDb();
  if (!db) return [];
  if (!_tripStopsStmt) {
    _tripStopsStmt = db.prepare('SELECT lat, lon FROM sched_stops WHERE trip_id = ? ORDER BY seq');
  }
  return _tripStopsStmt.all(String(tripId));
}

// How late (+) / early (−) a bus is, in minutes, or null when we can't say
// confidently. `obs` needs { tripId, lat, lon }; `now` is the observation clock.
function scheduleDeviationMin(obs, now = new Date()) {
  if (!obs || obs.tripId == null) return null;
  if (!Number.isFinite(obs.lat) || !Number.isFinite(obs.lon)) return null;
  const db = schedDb();
  if (!db) return null;
  if (!_schedStmt) {
    _schedStmt = db.prepare(
      'SELECT lat, lon, sched_sec AS schedSec FROM sched_stops WHERE trip_id = ? ORDER BY seq',
    );
  }
  const stops = _schedStmt.all(String(obs.tripId));
  const best = deviationFromStops(stops, obs.lat, obs.lon);
  if (!best || best.distFt > MAX_OFFROUTE_FT) return null;
  const dev = (atlantaSecondsOfDay(now) - best.schedSec) / 60;
  if (!Number.isFinite(dev) || Math.abs(dev) > MAX_PLAUSIBLE_DEV_MIN) return null;
  return dev;
}

// Map vehicleId → schedule deviation (minutes), computed from each bus's latest
// observation in the window. Buses we can't place confidently are omitted, so the
// post just shows their bare number. `observations` are storage rows
// ({ ts, vehicleId, tripId, lat, lon }), ts-ascending.
function busDeviationsByVid(observations, now = Date.now()) {
  const latest = new Map();
  for (const o of observations || []) {
    if (o.vehicleId == null) continue;
    latest.set(o.vehicleId, o); // ascending ts → last write is newest
  }
  const out = new Map();
  for (const [vid, o] of latest) {
    const dev = scheduleDeviationMin(o, new Date(o.ts ?? now));
    if (dev != null) out.set(vid, dev);
  }
  return out;
}

module.exports = {
  MAX_OFFROUTE_FT,
  MAX_PLAUSIBLE_DEV_MIN,
  atlantaSecondsOfDay,
  deviationFromStops,
  scheduleDeviationMin,
  busDeviationsByVid,
  tripStops,
  _resetSchedDb,
};
