// MARTA bus ghost detection — port of src/bus/ghosts.js.
//
// A "ghost" is scheduled service that isn't on the street: the count of distinct
// buses actually observed on a route+direction falls materially below the
// GTFS-scheduled active-trip count for the current hour. The threshold/ramp/tail
// gates are carried over from CTA unchanged. The simplification vs CTA: MARTA
// observations carry a GTFS trip_id, so we group by the canonical direction_id
// (0/1) directly instead of resolving CTA Bus Tracker pids to a direction label.
const { median, loadScheduleIndex, activeTripsForRoute, headwayForRoute } = require('./schedule');

const MISSING_PCT_THRESHOLD = 0.25;
const MISSING_ABS_THRESHOLD = 3;
// Mid-hour incidents get less time to accumulate evidence, so a deficit
// concentrated in the trailing slice can fire at a lower absolute bar.
const MISSING_ABS_THRESHOLD_TRAILING = 2;
const TRAILING_DEFICIT_MIN = 2;
const MIN_SNAPSHOTS = 4; // ~6 polls/hour at */10 → 4 tolerates 2 drops
const MIN_OBSERVED = 2; // observed 0/1 is a schedule bug or a gap (covered elsewhere)
const MAX_EXPECTED_ACTIVE = 30; // sanity ceiling — likely a bad GTFS bucket
const RAMP_FILL_RATIO = 0.8; // tail ≥ this × expected → pipeline filling, not ghosting
const RAMP_TAIL_FRACTION = 0.25; // tail = last 25%, min 3 snapshots

// Median distinct-vehicle count over the tail snapshots — during ramp-up the
// full-window median lags, but the tail tracks current service.
function tailMedian(perSnapshot) {
  const pairs = [...perSnapshot.entries()].sort((a, b) => a[0] - b[0]);
  const tailLen = Math.max(3, Math.ceil(pairs.length * RAMP_TAIL_FRACTION));
  return median(pairs.slice(-tailLen).map(([, set]) => set.size));
}

// Pure detector. Injected lookups so it tests without GTFS/index on disk.
//   routes:           route_short_names to check
//   getObservations:  (route) => [{ ts, vehicleId, direction }] in the window
//   expectedActive:   (route, direction) => scheduled active trips this hour, or null
//   expectedHeadway:  (route, direction) => display-only headway min, or null
//   canceledTrips:    (route, direction) => distinct canceled trips in the window
//   onDrop:           optional ({reason, ...}) diagnostic sink
function detectBusGhosts({
  routes,
  getObservations,
  expectedActive,
  expectedHeadway,
  canceledTrips,
  onDrop,
}) {
  const events = [];
  const drop = (reason, info) => onDrop?.({ reason, ...info });

  for (const route of routes) {
    const obs = getObservations(route) || [];
    if (obs.length === 0) {
      drop('no_observations', { route });
      continue;
    }

    const byDir = new Map();
    for (const o of obs) {
      if (o.direction == null) continue;
      const d = String(o.direction);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(o);
    }

    for (const [direction, group] of byDir) {
      const ctx = { route, direction };
      const active = expectedActive(route, direction);
      if (active == null || active <= 0) {
        drop('no_schedule', { ...ctx, expectedActive: active });
        continue;
      }
      // Sparse routes make ghost calls meaningless: one missing bus isn't a
      // story, and two→zero is a gap (covered by the gaps detector).
      if (active < 2) {
        drop('sparse_route', { ...ctx, expectedActive: active });
        continue;
      }
      if (active > MAX_EXPECTED_ACTIVE) {
        drop('expected_cap_exceeded', { ...ctx, expectedActive: active });
        continue;
      }

      const perSnapshot = new Map();
      for (const o of group) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicleId);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) {
        drop('too_few_snapshots', { ...ctx, snapshots: perSnapshot.size, expectedActive: active });
        continue;
      }

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = active - observedActive;
      const detail = {
        ...ctx,
        expectedActive: active,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
      };

      if (missing < MISSING_ABS_THRESHOLD) {
        const tailMed = tailMedian(perSnapshot);
        const trailingDeficit = active - tailMed;
        // Trailing-deficit override: only when the shortfall is CONCENTRATED in
        // the tail (full-window observed exceeds tail), i.e. a mid-hour drop.
        const overrides =
          missing >= MISSING_ABS_THRESHOLD_TRAILING &&
          trailingDeficit >= TRAILING_DEFICIT_MIN &&
          tailMed < observedActive;
        if (!overrides) {
          drop('below_abs_threshold', detail);
          continue;
        }
      }
      if (missing / active < MISSING_PCT_THRESHOLD) {
        drop('below_pct_threshold', detail);
        continue;
      }
      if (observedActive < MIN_OBSERVED) {
        drop('too_few_observed', detail);
        continue;
      }
      // Wildly inconsistent counts usually mean polling blackouts, not ghosts.
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const stddev = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
      if (stddev > observedActive) {
        drop('noisy_polling', { ...detail, stddev });
        continue;
      }
      // Ramp-up gate: a filled tail means the deficit is at the front of the
      // hour, not now. Real outages persist into the tail.
      const tail = tailMedian(perSnapshot);
      if (tail >= RAMP_FILL_RATIO * active) {
        drop('ramp_up_filled', { ...detail, tailMedian: tail });
        continue;
      }

      events.push({
        route,
        direction,
        expectedActive: active,
        observedActive,
        missing,
        canceledTrips: canceledTrips ? canceledTrips(route, direction) : 0,
        snapshots: perSnapshot.size,
        headway: expectedHeadway ? expectedHeadway(route, direction) : null,
      });
    }
  }

  events.sort((a, b) => b.missing - a.missing);
  return events;
}

// Bridge: resolve each stored bus observation's route + canonical direction via
// GTFS, group by route, and detect against the schedule index's activeByHour.
function ghostsFromObservations(
  observations,
  { gtfs, index, routes, tripStatuses, now = Date.now() } = {},
) {
  const idx = loadScheduleIndex(index);
  const nowDate = new Date(now);
  const byRoute = new Map();
  for (const o of observations || []) {
    const trip = gtfs.tripsById.get(o.tripId);
    if (!trip) continue;
    const route = gtfs.routesById.get(trip.route_id)?.route_short_name;
    if (!route) continue;
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push({ ts: o.ts, vehicleId: o.vehicleId, direction: trip.direction_id });
  }

  const canceledByRouteDir = new Map();
  for (const s of tripStatuses || []) {
    if (s.tripRelationship !== 'CANCELED') continue;
    const trip = gtfs.tripsById.get(s.tripId);
    if (!trip) continue;
    const route = gtfs.routesById.get(trip.route_id)?.route_short_name || s.route;
    if (!route) continue;
    const key = `${String(route)}\u0000${trip.direction_id ?? ''}`;
    if (!canceledByRouteDir.has(key)) canceledByRouteDir.set(key, new Set());
    canceledByRouteDir.get(key).add(String(s.tripId));
  }

  return detectBusGhosts({
    routes: routes || [...byRoute.keys()],
    getObservations: (r) => byRoute.get(r) || [],
    expectedActive: (route, direction) => activeTripsForRoute(idx, route, direction, nowDate),
    expectedHeadway: (route, direction) => headwayForRoute(idx, route, direction, nowDate),
    canceledTrips: (route, direction) =>
      canceledByRouteDir.get(`${String(route)}\u0000${direction ?? ''}`)?.size || 0,
  });
}

module.exports = {
  detectBusGhosts,
  ghostsFromObservations,
  MISSING_PCT_THRESHOLD,
  MISSING_ABS_THRESHOLD,
  MIN_SNAPSHOTS,
  MIN_OBSERVED,
  MAX_EXPECTED_ACTIVE,
  RAMP_FILL_RATIO,
  RAMP_TAIL_FRACTION,
};
