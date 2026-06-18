// Cross-route bus bunching — a pileup at one spot involving 2+ routes (e.g. a
// knot of buses from different routes stacked at one intersection). Port of
// cta-insights src/bus/crossBunching.js. The per-shape detector in bunching.js
// can't see this: each route's shape distFt is a separate coordinate system, so
// it never compares buses on different shapes. Here we cluster purely on
// geography (lat/lon) across ALL routes, then require 2+ routes and congestion.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');

const CROSS_RADIUS_FT = 660; // an intersection + its approaches
const MIN_VEHICLES = 3;
const MIN_ROUTES = 2; // distinct routes, else regular bunching catches it
const MIN_STOPPED = 2; // congestion evidence — real pileup, not buses crossing in motion
const STALE_MS = 3 * 60 * 1000;

// `vehicles` carry { vehicleId, route, lat, lon, tmstmp } (epoch ms).
// `stoppedIds` is a Set of vehicleIds the caller confirmed barely-moving
// (findParkedBusVids) — the congestion gate. Omit it to detect on geometry
// alone (tests / diagnostics). Best-first: most vehicles, tie-break tightest span.
function detectCrossRouteBunches(
  vehicles,
  {
    now = Date.now(),
    stoppedIds = null,
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
      nowMs - v.tmstmp < STALE_MS,
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
  CROSS_RADIUS_FT,
  MIN_VEHICLES,
  MIN_ROUTES,
  MIN_STOPPED,
};
