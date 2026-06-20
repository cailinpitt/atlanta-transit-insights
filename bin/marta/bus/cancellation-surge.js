#!/usr/bin/env node
// MARTA bus cancellation-surge detector → roundup meta_signals (signal-only).
//
// Reads the last 60 min of structured GTFS-rt TripUpdates CANCELED flags (the
// same source as the ghost detector and the hourly digest), sizes each route's
// cancellations against its scheduled service via the schedule index, and
// records a `cancellation` meta_signal for any route whose surge clears the
// hybrid gate (src/marta/bus/cancellationSurge.js).
//
// It does NOT post: the hourly digest (bin/marta/bus/cancellations.js) is the
// public cancellation record, and the roundup (bin/marta/incident-roundup.js)
// owns the incident — a moderate surge compounds with gaps/ghosts there, and a
// severe one stands up its own roundup incident via the cancellation override.
// So every signal is recorded posted:false. Lifecycle is handled by meta_signal
// rolloff + the roundup's clear-tick resolution; nothing to reconcile here.
require('../../../src/shared/env');

const { setup, runBin } = require('../../../src/marta/shared/runBin');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const {
  loadScheduleIndex,
  inServiceForLineAtHour,
  parseGtfsTime,
  hourOfSec,
  hourFor,
} = require('../../../src/marta/bus/schedule');
const { extractCanceledTrips, summarizeByRoute } = require('../../../src/marta/bus/cancellations');
const { detectCancellationSurges } = require('../../../src/marta/bus/cancellationSurge');

const DRY_RUN = process.argv.includes('--dry-run');
const WINDOW_MS = 60 * 60 * 1000;

// The scheduled departure clock hour (0-23) of a canceled trip, from its GTFS
// start_time. Falls back to the current clock hour when the feed omits one (rare
// for CANCELED TripUpdates) — cancellations are near-real-time, so "now" is the
// right bucket. Owl times (24:xx/25:xx) fold to 0/1 via hourOfSec.
function departureHour(startTime, now) {
  const sec = parseGtfsTime(startTime);
  return sec == null ? hourFor(now) : hourOfSec(sec);
}

async function main({ now = Date.now(), idx = null } = {}) {
  setup();
  const index = idx || loadScheduleIndex();
  const nowDate = new Date(now);

  const statuses = storage.getRecentBusTripStatuses(now - WINDOW_MS);
  const canceled = extractCanceledTrips(statuses);
  const { perRoute } = summarizeByRoute(canceled);

  // Bucket each route's canceled trips by their scheduled departure hour. The
  // numerator (distinct trips canceled over the trailing hour) straddles two
  // clock hours, while the index is per-clock-hour — so we size against the SUM
  // of in-service trips over exactly the hours the cancellations fall in. Since
  // a trip departing in hour H is in service during H, per-hour canceled never
  // exceeds per-hour scheduled, so the share can't go impossible ("7 of 6").
  const hoursByRoute = new Map(); // route -> Set<hour>
  for (const t of canceled) {
    if (t.route == null) continue;
    const route = String(t.route);
    if (!hoursByRoute.has(route)) hoursByRoute.set(route, new Set());
    hoursByRoute.get(route).add(departureHour(t.startTime, nowDate));
  }
  const scheduledForRoute = (route) => {
    const hours = hoursByRoute.get(String(route));
    if (!hours) return null;
    let sum = null;
    for (const h of hours) {
      const v = inServiceForLineAtHour(index, route, h, nowDate);
      if (v != null) sum = (sum || 0) + v;
    }
    return sum;
  };

  const events = detectCancellationSurges({ perRoute, scheduledForRoute });

  if (events.length === 0) {
    console.log('No bus cancellation surges meet the threshold, staying silent');
    return;
  }

  for (const e of events) {
    console.log(
      `  Route ${e.route}: ${e.canceled} canceled of ${e.scheduled} scheduled (${Math.round(e.fraction * 100)}% of service lost)`,
    );
    if (DRY_RUN) continue;
    incidents.recordMetaSignal(
      {
        kind: 'bus',
        line: e.route,
        direction: null,
        source: 'cancellation',
        severity: e.severity,
        detail: { canceled: e.canceled, scheduled: e.scheduled, fraction: e.fraction },
        posted: false,
      },
      now,
    );
  }
}

if (require.main === module) runBin(main);

module.exports = { main };
