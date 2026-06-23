// MARTA bus crowding — the occupancy analog of bus/speedmap.js.
//
// MARTA's GTFS-rt VehiclePositions feed reports `occupancyStatus` on ~100% of
// vehicles (stored as the GTFS enum NAME in bus_observations.occupancy). This
// turns that per-vehicle categorical into two views, both reusing the speedmap's
// project→bin→summarize machinery over { distFt, score } samples:
//   • a per-route crowding MAP — each route segment colored by how full buses
//     were there over the window (buildRouteCrowdingMaps),
//   • a per-route ROLLUP stat — the share of observations that were standing-
//     room-or-fuller, for a "most crowded routes" digest (summarizeRouteCrowding).
//
// CAVEAT (EMPTY/absent ambiguity): protobuf decodes an absent enum int as 0, so a
// stored "EMPTY" can mean a genuinely empty bus OR one the feed didn't tag. That
// only blurs the NOT-crowded end — the map/rollup under-report crowding, never
// over-claim it — which is the safe direction for an "err toward silence" feed.
const { projectObservation } = require('./shapes');

// GTFS OccupancyStatus → ordinal crowding score (higher = fuller). The
// out-of-service / no-signal statuses map to null (excluded — they aren't a
// crowding measurement). FULL is treated as the most crowded, above CRUSHED,
// regardless of the enum's numeric ordering.
const OCCUPANCY_SCORE = {
  EMPTY: 0,
  MANY_SEATS_AVAILABLE: 1,
  FEW_SEATS_AVAILABLE: 2,
  STANDING_ROOM_ONLY: 3,
  CRUSHED_STANDING_ROOM_ONLY: 4,
  FULL: 5,
  NOT_ACCEPTING_PASSENGERS: null,
  NO_DATA_AVAILABLE: null,
  NOT_BOARDABLE: null,
};

// Standing-room-or-fuller is the "crowded" bar the rollup counts and the map's
// selection gate keys on (score >= 3).
const CROWDED_SCORE = 3;

// 4-bucket color scheme paralleling the speedmap (score lower bounds). Averaged
// bin scores are continuous, so the buckets read on the half: < 2 green
// (empty/many seats), < 3 yellow (few seats), < 4 orange (standing), >= 4 red
// (crushed/full).
function colorForCrowding(score) {
  if (score == null) return '444'; // no data — dim gray
  if (score < 2) return '2ad17f'; // green
  if (score < 3) return 'ffd21a'; // yellow
  if (score < 4) return 'ff8c1a'; // orange
  return 'ff2a2a'; // red
}

// Rider-facing label for an occupancy score (used in alt text + rollup peak).
function crowdingLabel(score) {
  if (score == null) return 'no data';
  if (score < 1) return 'empty';
  if (score < 2) return 'many seats';
  if (score < 3) return 'few seats';
  if (score < 4) return 'standing room only';
  if (score < 5) return 'crushed';
  return 'full';
}

// Numeric crowding score for one observation, or null when it carries no usable
// occupancy value.
function scoreForObservation(o) {
  if (!o || o.occupancy == null) return null;
  const s = OCCUPANCY_SCORE[String(o.occupancy)];
  return s == null ? null : s;
}

// Turn bus observations into per-shape crowding samples. `observations` carry
// { tripId, lat, lon, occupancy }. Off-route fixes and no-occupancy rows are
// skipped. Returns Map<shapeId, { route, direction, samples: [{ distFt, score }] }>.
function buildCrowdingSamples(observations, { gtfs, shapes } = {}) {
  const byShape = new Map();
  for (const o of observations || []) {
    const score = scoreForObservation(o);
    if (score == null) continue;
    const proj = projectObservation(o, { gtfs, shapes });
    if (!proj) continue;
    let entry = byShape.get(proj.shapeId);
    if (!entry) {
      const trip = gtfs.tripsById.get(o.tripId);
      entry = {
        route: trip ? (gtfs.routesById.get(trip.route_id)?.route_short_name ?? null) : null,
        direction: trip ? trip.direction_id : null,
        samples: [],
      };
      byShape.set(proj.shapeId, entry);
    }
    entry.samples.push({ distFt: proj.distFt, score });
  }
  return byShape;
}

// Average crowding score per bin across `numBins` equal segments of a shape.
// Bins with no sample are null (rendered "no data"). Mirrors speedmap.binSamples.
function binSamples(samples, lengthFt, numBins) {
  if (!(lengthFt > 0) || numBins < 1) return [];
  const segLen = lengthFt / numBins;
  const buckets = Array.from({ length: numBins }, () => []);
  for (const s of samples) {
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor(s.distFt / segLen)));
    buckets[idx].push(s.score);
  }
  return buckets.map((b) => (b.length === 0 ? null : b.reduce((a, v) => a + v, 0) / b.length));
}

// Roll a set of binned scores into an average + per-bucket counts + coverage.
function summarize(bins) {
  const valid = bins.filter((s) => s != null);
  const base = {
    avg: null,
    green: 0,
    yellow: 0,
    orange: 0,
    red: 0,
    bins: bins.length,
    covered: valid.length,
  };
  if (valid.length === 0) return base;
  base.avg = valid.reduce((a, v) => a + v, 0) / valid.length;
  for (const s of valid) {
    if (s < 2) base.green++;
    else if (s < 3) base.yellow++;
    else if (s < 4) base.orange++;
    else base.red++;
  }
  return base;
}

// Fraction of a summary's covered bins that are standing-or-fuller (orange+red).
// The map's "how crowded is this route" rank key.
function crowdedBinFraction(summary) {
  if (!summary || summary.covered <= 0) return 0;
  return (summary.orange + summary.red) / summary.covered;
}

// End-to-end map view: observations → per-shape crowding map { route, direction,
// lengthFt, bins, summary, sampleCount }. numBins defaults to ~40 like speedmap.
function buildRouteCrowdingMaps(observations, { gtfs, shapes, numBins = 40 } = {}) {
  const samplesByShape = buildCrowdingSamples(observations, { gtfs, shapes });
  const out = new Map();
  for (const [shapeId, entry] of samplesByShape) {
    const lengthFt = shapes.get(shapeId)?.lengthFt || 0;
    const bins = binSamples(entry.samples, lengthFt, numBins);
    out.set(shapeId, {
      shapeId,
      route: entry.route,
      direction: entry.direction,
      lengthFt,
      bins,
      summary: summarize(bins),
      sampleCount: entry.samples.length,
    });
  }
  return out;
}

// Rollup view: per-route crowding stats with no projection needed — just the
// occupancy counts. Returns [{ route, total, crowded, pctCrowded, peakScore }]
// sorted most-crowded first (pctCrowded, then peak). `total` counts only
// occupancy-bearing observations; routes with none are omitted.
function summarizeRouteCrowding(observations, { gtfs } = {}) {
  const byRoute = new Map();
  for (const o of observations || []) {
    const score = scoreForObservation(o);
    if (score == null) continue;
    const trip = gtfs?.tripsById.get(o.tripId);
    const route = trip ? gtfs.routesById.get(trip.route_id)?.route_short_name : null;
    if (!route) continue;
    let rec = byRoute.get(route);
    if (!rec) {
      rec = { route: String(route), total: 0, crowded: 0, peakScore: 0 };
      byRoute.set(route, rec);
    }
    rec.total++;
    if (score >= CROWDED_SCORE) rec.crowded++;
    if (score > rec.peakScore) rec.peakScore = score;
  }
  const out = [...byRoute.values()].map((r) => ({
    ...r,
    pctCrowded: r.total > 0 ? r.crowded / r.total : 0,
  }));
  out.sort(
    (a, b) => b.pctCrowded - a.pctCrowded || b.peakScore - a.peakScore || a.crowded - b.crowded,
  );
  return out;
}

module.exports = {
  OCCUPANCY_SCORE,
  CROWDED_SCORE,
  colorForCrowding,
  crowdingLabel,
  scoreForObservation,
  buildCrowdingSamples,
  binSamples,
  summarize,
  crowdedBinFraction,
  buildRouteCrowdingMaps,
  summarizeRouteCrowding,
};
