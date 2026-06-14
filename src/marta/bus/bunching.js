// MARTA bus bunching detection — port of src/bus/bunching.js.
//
// A "bunch" is two or more buses on the same pattern packed within
// BUNCHING_THRESHOLD_FT of along-route distance. Purely spatial — no schedule
// index needed. The CTA algorithm is generic over vehicles carrying
// { pid, pdist }; here those are the shapes.js analogs { shapeId, distFt }, and
// the geographic sanity check uses the stored lat/lon.
const { haversineFt } = require('../../shared/geo');
const { projectObservation } = require('./shapes');

const BUNCHING_THRESHOLD_FT = 800; // ~2.5 city blocks
const STALE_MS = 3 * 60 * 1000;
const TERMINAL_DIST_FT = 500; // start-terminal layovers, not real bunching
// Straight-line distance is bounded by along-route distance, so geo span far
// exceeding the distFt span means a stale/wrong projection (e.g. a bus that just
// laid over and restarted its run). Slack covers GPS jitter + route curvature.
const GEO_SLACK_FT = 500;

// Clusters ranked best-first by size desc, then tightest max-gap — the caller
// picks the first whose shape isn't on cooldown. `now` and `tmstmp` are epoch ms.
function detectAllBunching(vehicles, now = Date.now()) {
  const fresh = (vehicles || []).filter(
    (v) => v.tmstmp != null && now - v.tmstmp < STALE_MS && Number.isFinite(v.distFt),
  );

  const byShape = new Map();
  for (const v of fresh) {
    if (v.shapeId == null) continue;
    if (!byShape.has(v.shapeId)) byShape.set(v.shapeId, []);
    byShape.get(v.shapeId).push(v);
  }

  const bunches = [];
  for (const [shapeId, group] of byShape) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.distFt - b.distFt);

    let i = 0;
    while (i < sorted.length - 1) {
      if (sorted[i + 1].distFt - sorted[i].distFt > BUNCHING_THRESHOLD_FT) {
        i++;
        continue;
      }
      let j = i + 1;
      let maxGap = sorted[j].distFt - sorted[i].distFt;
      while (
        j + 1 < sorted.length &&
        sorted[j + 1].distFt - sorted[j].distFt <= BUNCHING_THRESHOLD_FT
      ) {
        maxGap = Math.max(maxGap, sorted[j + 1].distFt - sorted[j].distFt);
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      if (cluster[0].distFt < TERMINAL_DIST_FT) {
        i = j + 1;
        continue;
      }
      const distSpan = cluster[cluster.length - 1].distFt - cluster[0].distFt;
      let geoSpan = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const d = haversineFt(cluster[a], cluster[b]);
          if (d > geoSpan) geoSpan = d;
        }
      }
      if (geoSpan > distSpan + GEO_SLACK_FT) {
        i = j + 1;
        continue;
      }
      bunches.push({
        shapeId,
        route: cluster[0].route,
        vehicles: cluster,
        maxGapFt: maxGap,
        spanFt: distSpan,
      });
      i = j + 1;
    }
  }

  // More buses → more severe; tie-break on tighter max gap.
  bunches.sort((a, b) =>
    a.vehicles.length !== b.vehicles.length
      ? b.vehicles.length - a.vehicles.length
      : a.maxGapFt - b.maxGapFt,
  );
  return bunches;
}

function detectBunching(vehicles, now = Date.now()) {
  return detectAllBunching(vehicles, now)[0] || null;
}

// Stable per-bus identity: number a bunch by road position (1 = lead bus,
// furthest along the shape) so each vehicle keeps its number across frames and
// post text. Returns Map<vehicleId, number>.
function assignBusNumbers(vehicles) {
  const ordered = [...vehicles].sort((a, b) => (b.distFt ?? 0) - (a.distFt ?? 0));
  const labels = new Map();
  for (let i = 0; i < ordered.length; i++) labels.set(ordered[i].vehicleId, i + 1);
  return labels;
}

const PARKED_MIN_SNAPSHOTS = 4;
const PARKED_MAX_DRIFT_FT = 250; // ~half a block over the window isn't progressing

// Buses that barely moved across enough recent snapshots — used as a CLUSTER
// gate (suppress a bunch only when it lacks two members that AREN'T parked), so
// an almost-entirely-stopped cluster (terminal queue, layover) doesn't post as
// a bunch. `rows` are observation records with { vehicleId/vehicle_id, distFt }
// already filtered to the window. Buses with too little history are not marked
// parked, so a just-appeared bus is never mistaken for stationary.
function findParkedBusVids(
  rows,
  { minSnapshots = PARKED_MIN_SNAPSHOTS, maxDriftFt = PARKED_MAX_DRIFT_FT } = {},
) {
  const byVid = new Map();
  for (const o of rows) {
    const vid = o.vehicleId ?? o.vehicle_id;
    const d = Number(o.distFt);
    if (!Number.isFinite(d)) continue;
    if (!byVid.has(vid)) byVid.set(vid, []);
    byVid.get(vid).push(d);
  }
  const parked = new Set();
  for (const [vid, dists] of byVid) {
    if (dists.length < minSnapshots) continue;
    if (Math.max(...dists) - Math.min(...dists) <= maxDriftFt) parked.add(vid);
  }
  return parked;
}

// Convenience: project stored bus observations onto their shapes, then detect.
// Bunching needs no schedule index — it's spatial only.
function bunchesFromObservations(observations, { gtfs, shapes, now = Date.now() } = {}) {
  const vehicles = [];
  for (const o of observations || []) {
    const proj = projectObservation(o, { gtfs, shapes });
    if (!proj) continue;
    const trip = gtfs.tripsById.get(o.tripId);
    vehicles.push({
      shapeId: proj.shapeId,
      distFt: proj.distFt,
      route: trip ? (gtfs.routesById.get(trip.route_id)?.route_short_name ?? null) : null,
      vehicleId: o.vehicleId,
      tmstmp: o.ts,
      lat: o.lat,
      lon: o.lon,
    });
  }
  return detectAllBunching(vehicles, now);
}

module.exports = {
  detectAllBunching,
  detectBunching,
  assignBusNumbers,
  findParkedBusVids,
  bunchesFromObservations,
  BUNCHING_THRESHOLD_FT,
  TERMINAL_DIST_FT,
  STALE_MS,
};
