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
const { loadScheduleIndex, scheduledForLine } = require('../../../src/marta/bus/schedule');
const { extractCanceledTrips, summarizeByRoute } = require('../../../src/marta/bus/cancellations');
const { detectCancellationSurges } = require('../../../src/marta/bus/cancellationSurge');

const DRY_RUN = process.argv.includes('--dry-run');
const WINDOW_MS = 60 * 60 * 1000;

async function main({ now = Date.now(), idx = null } = {}) {
  setup();
  const index = idx || loadScheduleIndex();
  const nowDate = new Date(now);

  const statuses = storage.getRecentBusTripStatuses(now - WINDOW_MS);
  const { perRoute } = summarizeByRoute(extractCanceledTrips(statuses));

  // The numerator is distinct trips canceled over the trailing WINDOW_MS, which
  // straddles two clock hours; the index buckets scheduled service per clock
  // hour. Size against the LARGER of the two hours the window spans so a
  // service ramp (e.g. late-evening taper) can't push canceled past scheduled.
  const windowStart = new Date(now - WINDOW_MS);
  const scheduledForRoute = (route) =>
    maxNullable(
      scheduledForLine(index, route, nowDate),
      scheduledForLine(index, route, windowStart),
    );

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

// max of two values where either may be null (no scheduled service that hour);
// null only when both are null.
function maxNullable(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

if (require.main === module) runBin(main);

module.exports = { main };
