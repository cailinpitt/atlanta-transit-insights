// MARTA bus gap detection — port of src/bus/gaps.js.
//
// A "gap" is an oversized stretch of route with no bus, measured against the
// GTFS-scheduled headway. The algorithm is unchanged from CTA — it's generic
// over vehicles carrying { shapeId, distFt } (the MARTA `pid`/`pdist` analogs
// from shapes.js) — but the inputs are wired to MARTA sources: along-route
// position comes from projecting GTFS-rt positions onto the trip's shape, and
// the expected headway comes from the scheduled-headway index (schedule.js).
const { terminalZoneFt } = require('../../shared/geo');
const { projectObservation } = require('./shapes');
const { loadScheduleIndex, headwayForShape, headwayForRoute } = require('./schedule');
const { stopsNearShape } = require('./stops');

const STALE_MS = 3 * 60 * 1000;
// ~10 mph effective once stops/signals are factored in. Only used as a ratio
// against the scheduled headway, never as an absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 880;
const RATIO_THRESHOLD = 2.5;
// Floor so low-frequency routes (30-min headway) don't fire on every minor drift.
const ABSOLUTE_MIN_MIN = 15;

// Detect gaps from a set of enriched vehicles. Pure; all schedule/geometry
// access is injected so it unit-tests without GTFS or an index on disk.
//
//   vehicles:   [{ shapeId, distFt, route, vehicleId, tmstmp(ms), lat, lon }]
//   headwayFor: (shapeId) => expected headway minutes, or null to skip the shape
//   lengthFor:  (shapeId) => shape length in feet
//   stopsFor:   (shapeId) => [{ stopName, distFt, lat, lon }] for flank naming (optional)
function detectBusGaps(vehicles, { headwayFor, lengthFor, stopsFor, now = Date.now() } = {}) {
  const fresh = (vehicles || []).filter(
    (v) => v.tmstmp != null && now - v.tmstmp < STALE_MS && Number.isFinite(v.distFt),
  );

  const byShape = new Map();
  for (const v of fresh) {
    if (v.shapeId == null) continue;
    if (!byShape.has(v.shapeId)) byShape.set(v.shapeId, []);
    byShape.get(v.shapeId).push(v);
  }

  const gaps = [];
  for (const [shapeId, group] of byShape) {
    if (group.length < 2) continue;
    const expectedMin = headwayFor(shapeId);
    if (expectedMin == null || expectedMin <= 0) continue;
    const lengthFt = lengthFor(shapeId) || 0;
    if (!lengthFt) continue;
    const zoneFt = terminalZoneFt(lengthFt);
    const stops = (stopsFor?.(shapeId) || []).filter((s) => s.distFt != null);

    const sorted = [...group].sort((a, b) => a.distFt - b.distFt);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]; // trailing (lower distFt)
      const b = sorted[i + 1]; // leading (higher distFt)

      // Buses still inside a terminal zone aren't in service territory; their
      // spacing against the next bus is misleading.
      if (a.distFt < zoneFt) continue;
      if (lengthFt - b.distFt < zoneFt) continue;

      const gapFt = b.distFt - a.distFt;
      const gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      const ratio = gapMin / expectedMin;
      if (ratio < RATIO_THRESHOLD) continue;

      // The stop just outside each bus, so a post can name the empty stretch as
      // a range ("between A and B") rather than one point.
      let flankBefore = null;
      let flankAfter = null;
      for (const s of stops) {
        if (s.distFt < a.distFt) {
          if (!flankBefore || s.distFt > flankBefore.distFt) flankBefore = s;
        } else if (s.distFt > b.distFt) {
          if (!flankAfter || s.distFt < flankAfter.distFt) flankAfter = s;
        }
      }

      gaps.push({
        shapeId,
        route: a.route ?? b.route ?? null,
        leading: b,
        trailing: a,
        flankBefore,
        flankAfter,
        gapFt,
        gapMin,
        expectedMin,
        ratio,
      });
    }
  }

  gaps.sort((a, b) => b.ratio - a.ratio);
  return gaps;
}

// Convenience: project stored bus observations onto their shapes, wire the
// schedule index, and detect. `observations` are storage rows
// ({ tripId, route, vehicleId, lat, lon, ts }). The schedule index falls back to
// the route-direction rollup when a specific shape isn't indexed.
function gapsFromObservations(observations, { gtfs, shapes, index, now = Date.now() } = {}) {
  const idx = loadScheduleIndex(index);
  const nowDate = new Date(now);
  const vehicles = [];
  for (const o of observations || []) {
    const proj = projectObservation(o, { gtfs, shapes });
    if (!proj) continue;
    const trip = gtfs.tripsById.get(o.tripId);
    const route = trip ? (gtfs.routesById.get(trip.route_id)?.route_short_name ?? null) : null;
    vehicles.push({
      shapeId: proj.shapeId,
      distFt: proj.distFt,
      route,
      direction: trip ? trip.direction_id : null,
      vehicleId: o.vehicleId,
      tmstmp: o.ts,
      lat: o.lat,
      lon: o.lon,
    });
  }
  // Build per-shape route/direction so the headway fallback can resolve.
  const shapeRouteDir = new Map();
  for (const v of vehicles) {
    if (!shapeRouteDir.has(v.shapeId)) {
      shapeRouteDir.set(v.shapeId, { route: v.route, direction: v.direction });
    }
  }
  return detectBusGaps(vehicles, {
    now,
    headwayFor: (shapeId) => {
      const direct = headwayForShape(idx, shapeId, nowDate);
      if (direct != null) return direct;
      const rd = shapeRouteDir.get(shapeId);
      return rd ? headwayForRoute(idx, rd.route, rd.direction, nowDate) : null;
    },
    lengthFor: (shapeId) => shapes.get(shapeId)?.lengthFt || 0,
    stopsFor: (shapeId) => stopsNearShape(gtfs, shapes.get(shapeId), 0, Infinity),
  });
}

module.exports = {
  detectBusGaps,
  gapsFromObservations,
  STALE_MS,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
  TYPICAL_SPEED_FT_PER_MIN,
};
