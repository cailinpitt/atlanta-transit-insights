// MARTA scheduled-headway index reader — the analog of cta-insights'
// data/gtfs/index.json (built there by scripts/fetch-gtfs.js).
//
// Gap and ghost detection need to know how often a route is SUPPOSED to run.
// scripts/marta/build-schedule-index.js precomputes, from the static GTFS,
// the median scheduled headway / trip duration / active-trip count per
// (shape, dayType, hour) and per (route, direction, dayType, hour). This module
// loads that JSON and answers "what's the expected headway right now?".
//
// Keyed primarily by shape_id (the MARTA `pid` analog) so it lines up with the
// per-shape grouping the detectors use, with a (route, direction) rollup as a
// fallback when a specific shape has no schedule (e.g. a short-turn).
const Path = require('node:path');
const Fs = require('fs-extra');

const INDEX_PATH =
  process.env.MARTA_SCHEDULE_INDEX_PATH ||
  Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'schedule-index.json');
// calendar_dates makes the index date-specific (it represents *today*); warn at
// 2d, fail at 7d so a stale build is visible rather than silently wrong.
const STALE_WARN_MS = 2 * 24 * 60 * 60 * 1000;
const STALE_FATAL_MS = 7 * 24 * 60 * 60 * 1000;

// --- Pure helpers (shared with the builder; unit-tested directly) ---

// GTFS time → seconds since service-day midnight. Tolerates leading spaces
// (" 6:20:00") and >24h values ("25:15:00" = 1:15 AM next day).
function parseGtfsTime(s) {
  const m = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(s || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Service-day hour bucket for a seconds-since-midnight value, wrapped to 0-23 so
// owl trips encoded as 24:xx/25:xx fold onto 0/1.
function hourOfSec(sec) {
  return Math.floor(sec / 3600) % 24;
}

// Median headway (minutes) from a set of trip departure times (seconds) that
// fall in one bucket: sort, take gaps between consecutive departures, median.
// Null with fewer than two departures (a single trip has no headway).
function headwayFromDepartures(depSecs) {
  if (!depSecs || depSecs.length < 2) return null;
  const sorted = [...depSecs].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
  return median(gaps);
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// Map a calendar.txt row to a coarse day-type bucket, or null for the
// "unusual" services (MARTA's holiday specials run on no regular day — every
// flag 0 — and are swapped in via calendar_dates; we skip them so weekday and
// weekend headways never get mashed together).
function dayTypeForCalendarRow(row) {
  const on = (d) => row[d] === '1' || row[d] === 1;
  const weekdayOn = WEEKDAYS.every(on);
  const sat = on('saturday');
  const sun = on('sunday');
  if (weekdayOn && !sat && !sun) return 'weekday';
  if (!WEEKDAYS.some(on)) {
    if (sat && !sun) return 'saturday';
    if (sun && !sat) return 'sunday';
  }
  return null;
}

// Day-type bucket for an instant in MARTA's timezone (America/New_York).
function dayTypeFor(now = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  if (wd === 'Sat') return 'saturday';
  if (wd === 'Sun') return 'sunday';
  return 'weekday';
}

function hourFor(now = new Date()) {
  return (
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      }).format(now),
    ) % 24
  );
}

// Look up a value from a { dayType: { hour: value } } map for `now`. Null when
// there's no entry — meaning "no scheduled service this hour", which callers
// should treat as skip, not interpolate.
function hourlyLookup(byDayType, now = new Date()) {
  if (!byDayType) return null;
  const v = byDayType[dayTypeFor(now)]?.[hourFor(now)];
  return v == null ? null : v;
}

// --- Index loading + lookups ---

let _index = null;

function loadScheduleIndex(pathOrObject) {
  if (pathOrObject && typeof pathOrObject === 'object') return pathOrObject;
  if (_index) return _index;
  const p = pathOrObject || INDEX_PATH;
  if (!Fs.existsSync(p)) {
    throw new Error(
      `MARTA schedule index not found at ${p}. Run: node scripts/marta/build-schedule-index.js`,
    );
  }
  _index = Fs.readJsonSync(p);
  const age = Date.now() - (_index.generatedAt || 0);
  const days = Math.round(age / (24 * 60 * 60 * 1000));
  if (age > STALE_FATAL_MS) {
    throw new Error(`MARTA schedule index is ${days}d old (>7d) — re-run build-schedule-index.js`);
  }
  if (age > STALE_WARN_MS) {
    console.warn(`MARTA schedule index is ${days}d old — re-run build-schedule-index.js`);
  }
  return _index;
}

// Expected headway (min) for a specific shape right now, or null.
function headwayForShape(index, shapeId, now = new Date()) {
  return hourlyLookup(index?.shapes?.[shapeId]?.headways, now);
}

// Direction-level headway rollup (min) — the fallback when a shape has no entry.
function headwayForRoute(index, route, direction, now = new Date()) {
  return hourlyLookup(index?.routes?.[route]?.[String(direction)]?.headways, now);
}

// Expected one-way trip duration (min) for a shape right now, or null.
function tripMinutesForShape(index, shapeId, now = new Date()) {
  return hourlyLookup(index?.shapes?.[shapeId]?.durations, now);
}

// Expected count of trips active during this hour on a route+direction, or null.
function activeTripsForRoute(index, route, direction, now = new Date()) {
  return hourlyLookup(index?.routes?.[route]?.[String(direction)]?.activeByHour, now);
}

// Line-level aggregates across both directions — used by rail, where the feed's
// N/S/E/W direction doesn't line up with GTFS direction_id, but headways are ~
// symmetric. headway = median across the directions; active = sum across them.
function headwayForLine(index, route, now = new Date()) {
  const dirs = index?.routes?.[route];
  if (!dirs) return null;
  const vals = [];
  for (const d of Object.values(dirs)) {
    const v = hourlyLookup(d.headways, now);
    if (v != null) vals.push(v);
  }
  return vals.length ? median(vals) : null;
}

function activeForLine(index, route, now = new Date()) {
  const dirs = index?.routes?.[route];
  if (!dirs) return null;
  let sum = null;
  for (const d of Object.values(dirs)) {
    const v = hourlyLookup(d.activeByHour, now);
    if (v != null) sum = (sum || 0) + v;
  }
  return sum;
}

module.exports = {
  // pure helpers
  parseGtfsTime,
  median,
  hourOfSec,
  headwayFromDepartures,
  dayTypeForCalendarRow,
  dayTypeFor,
  hourFor,
  hourlyLookup,
  // index
  loadScheduleIndex,
  headwayForShape,
  headwayForRoute,
  tripMinutesForShape,
  activeTripsForRoute,
  headwayForLine,
  activeForLine,
  INDEX_PATH,
};
