// Cross-route bus bunching — a cluster at one spot involving 2+ routes (e.g. a
// knot of buses from different routes close together at one intersection). Port of
// cta-insights src/bus/crossBunching.js. The per-shape detector in bunching.js
// can't see this: each route's shape distFt is a separate coordinate system, so
// it never compares buses on different shapes. Here we cluster purely on
// geography (lat/lon) across ALL routes, then require 2+ routes and congestion.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');
const { haversineFt } = require('../../shared/geo');

const CROSS_RADIUS_FT = 660; // an intersection + its approaches
const MIN_VEHICLES = 3;
const MIN_ROUTES = 2; // distinct routes, else regular bunching catches it
const MIN_STOPPED = 2; // congestion evidence — real cluster, not buses crossing in motion
const STALE_MS = 3 * 60 * 1000;
// Layover zones — a bus sitting at the start/end of its shape, or at a rail
// station's off-street bus bay, is between trips, not pinned in street traffic.
// Several routes lay over together at the same transit center, which otherwise
// reads as a multi-route "cluster". The bin tags these (parked AND at a terminal
// or a station bay) as layoverIds; we drop them before clustering.
const LAYOVER_TERMINAL_FT = 750; // distance from a shape end to count as "at the terminal"
const STATION_BAY_FT = 600; // distance from a rail-station bay/platform to count as "at the station"

// A position is "at the terminal" when it sits within marginFt of either end of
// its shape (start-of-run or end-of-run layover). Pure; lengthFt is the shape's
// total along-route distance in feet.
function isAtTerminal(distFt, lengthFt, marginFt = LAYOVER_TERMINAL_FT) {
  if (!Number.isFinite(distFt) || !Number.isFinite(lengthFt) || lengthFt <= 0) return false;
  return distFt <= marginFt || distFt >= lengthFt - marginFt;
}

// Every shape's two endpoints (start + end), the geographic terminals of the
// route network. Deduped to a coarse grid so a dense transit center's many
// coincident endpoints collapse to a few points. Used as a route-agnostic
// layover backstop: a parked bus near ANY route's terminal is laying over, even
// when its currently-tagged trip's shape doesn't put it near its own endpoint
// (GTFS-rt often tags a between-trips bus with a trip whose shape runs through
// the layover mid-route). `shapes` is loadShapes()'s Map<shapeId,{points,...}>.
function collectShapeTerminals(shapes) {
  const seen = new Set();
  const out = [];
  for (const shape of shapes?.values?.() || []) {
    const pts = shape?.points;
    if (!pts || pts.length < 2) continue;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lat: p.lat, lon: p.lon });
    }
  }
  return out;
}

// Is (lat, lon) within marginFt of any terminal point? Pure.
function nearAnyTerminal(lat, lon, terminals, marginFt = LAYOVER_TERMINAL_FT) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  for (const t of terminals || []) {
    if (haversineFt({ lat, lon }, t) <= marginFt) return true;
  }
  return false;
}

// `vehicles` carry { vehicleId, route, lat, lon, tmstmp } (epoch ms).
// `stoppedIds` is a Set of vehicleIds the caller confirmed barely-moving
// (findParkedBusVids) — the congestion gate. Omit it to detect on geometry
// alone (tests / diagnostics). `layoverIds` is a Set of vehicleIds the caller
// classified as laying over (parked at a terminal or station bay); they're
// dropped before clustering so a knot of routes resting at a transit center
// doesn't read as a street cluster. Best-first: most vehicles, tie-break tightest span.
function detectCrossRouteBunches(
  vehicles,
  {
    now = Date.now(),
    stoppedIds = null,
    layoverIds = null,
    radiusFt = CROSS_RADIUS_FT,
    minVehicles = MIN_VEHICLES,
    minRoutes = MIN_ROUTES,
    minStopped = MIN_STOPPED,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fresh = (vehicles || []).filter(
    (v) =>
      Number.isFinite(v?.lat) &&
      Number.isFinite(v?.lon) &&
      Number.isFinite(v?.tmstmp) &&
      nowMs - v.tmstmp < STALE_MS &&
      !layoverIds?.has(v.vehicleId),
  );

  const out = [];
  for (const members of clusterByProximity(fresh, { radiusFt })) {
    if (members.length < minVehicles) continue;
    const { spanFt, routes, centroid } = clusterStats(members, { routeKey: (v) => v.route });
    if (routes.size < minRoutes) continue;
    if (stoppedIds) {
      const stopped = members.filter((v) => stoppedIds.has(v.vehicleId)).length;
      if (stopped < minStopped) continue;
    }
    out.push({
      vehicles: members,
      routes: [...routes].sort(),
      routeCount: routes.size,
      spanFt: Math.round(spanFt),
      centroid,
    });
  }
  out.sort((a, b) =>
    a.vehicles.length !== b.vehicles.length
      ? b.vehicles.length - a.vehicles.length
      : a.spanFt - b.spanFt,
  );
  return out;
}

// Group a cluster's vehicles by route, each group sorted by vehicleId, with a
// per-bus disc number (1 = first listed). Returns
// { byRoute: [{ route, vids:[{vehicleId,n}] }], labels: Map<vehicleId,n> } in
// route order (most vehicles first, tie-break route name).
function groupByRoute(cluster) {
  const groups = new Map();
  for (const v of cluster.vehicles) {
    if (!groups.has(v.route)) groups.set(v.route, []);
    groups.get(v.route).push(v);
  }
  const ordered = [...groups.entries()]
    .map(([route, vs]) => ({
      route,
      vehicles: vs.sort((a, b) => String(a.vehicleId).localeCompare(String(b.vehicleId))),
    }))
    .sort((a, b) =>
      a.vehicles.length !== b.vehicles.length
        ? b.vehicles.length - a.vehicles.length
        : String(a.route).localeCompare(String(b.route)),
    );
  const labels = new Map();
  let n = 0;
  const byRoute = ordered.map((g) => ({
    route: g.route,
    vids: g.vehicles.map((v) => {
      n += 1;
      labels.set(v.vehicleId, n);
      return { vehicleId: v.vehicleId, n };
    }),
  }));
  return { byRoute, labels };
}

module.exports = {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
  collectShapeTerminals,
  nearAnyTerminal,
  CROSS_RADIUS_FT,
  MIN_VEHICLES,
  MIN_ROUTES,
  MIN_STOPPED,
  LAYOVER_TERMINAL_FT,
  STATION_BAY_FT,
};
