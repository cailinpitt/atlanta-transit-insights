// MARTA bus cancellation-surge detection (pure helpers).
//
// A "surge" is a single route shedding a materially large SHARE of its
// scheduled service to MARTA-announced trip cancellations within the rolling
// window. This is distinct from the hourly cancellation DIGEST
// (bin/marta/bus/cancellations.js), which reports every cancellation agency-wide
// as one fire-and-forget post: the digest is the complete record, this detector
// turns a CONCENTRATED burst on one route into a degraded-service signal the
// roundup can act on (and, when severe enough, stand up as its own incident).
// It's the website-incident analog of the rail single-departure cancellation —
// but rate-shaped over a window instead of a point-in-time annulment.
//
// Source consistency: it counts the SAME structured GTFS-rt TripUpdates CANCELED
// flag the ghost detector subtracts and the digest tallies, so the three views
// can't diverge. The denominator is the schedule index's scheduled active-trip
// count for the hour (src/marta/bus/schedule.js#activeForLine), mirroring how
// the ghost detector judges observed vs scheduled actives.

// Hybrid gate, mirroring the ghost detector's abs+pct shape:
//   - absolute floor: a percentage alone over-weights tiny samples (1 of 2
//     trips canceled is not a story), so require a real count first.
//   - fraction: a high-frequency trunk route and a coverage route are then
//     judged on the same "share of service lost" scale, not a raw count — so a
//     gutted low-frequency route isn't missed and a busy route isn't punished.
const CANCEL_ABS_FLOOR = 4;
const CANCEL_FRAC_THRESHOLD = 0.25;

// Pure detector. `perRoute` is summarizeByRoute's output ([{route, count}]);
// `scheduledForRoute(route)` returns the schedule index's active-trips-this-hour
// count (or null). Injected so it tests without an index on disk. `onDrop` is an
// optional diagnostic sink mirroring the ghost detector.
function detectCancellationSurges({ perRoute, scheduledForRoute, onDrop } = {}) {
  const events = [];
  const drop = (reason, info) => onDrop?.({ reason, ...info });

  for (const { route, count } of perRoute || []) {
    const canceled = Number(count) || 0;
    // The '?' bucket (canceled trips with no resolved route) can't be sized.
    if (route === '?') {
      drop('no_route', { route, canceled });
      continue;
    }
    if (canceled < CANCEL_ABS_FLOOR) {
      drop('below_abs_floor', { route, canceled });
      continue;
    }
    const scheduled = scheduledForRoute(route);
    if (scheduled == null || scheduled <= 0) {
      drop('no_schedule', { route, canceled, scheduled });
      continue;
    }
    const fraction = canceled / scheduled;
    if (fraction < CANCEL_FRAC_THRESHOLD) {
      drop('below_frac_threshold', { route, canceled, scheduled, fraction });
      continue;
    }
    events.push({
      route: String(route),
      canceled,
      scheduled,
      fraction,
      // Severity scales with share lost (clamped) so a moderate surge stays a
      // weak signal that COMPOUNDS with gaps/ghosts in the roundup, while a near-
      // total surge approaches 1. The standalone-incident bar is a separate
      // override gate in bin/marta/incident-roundup.js, not this number.
      severity: Math.min(1, fraction),
    });
  }

  events.sort((a, b) => b.fraction - a.fraction);
  return events;
}

module.exports = {
  detectCancellationSurges,
  CANCEL_ABS_FLOOR,
  CANCEL_FRAC_THRESHOLD,
};
