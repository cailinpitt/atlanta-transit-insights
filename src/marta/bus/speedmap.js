// MARTA bus speedmap — port of src/bus/speedmap.js.
//
// CTA has no per-vehicle speed, so its speedmap derives mph from `pdist`
// deltas between consecutive observations of the same bus. MARTA's GTFS-rt
// reports `speed` (m/s) directly on ~57% of vehicles, so a speedmap works from a
// SINGLE snapshot: each speed-bearing observation becomes one sample, placed on
// the route by projecting its position onto the trip's shape (shapes.js — the
// `pdist` analog). Detectors over multiple snapshots just pass more
// observations.
//
// The binning/summary/colour logic is carried over from the CTA module
// unchanged in spirit — it's generic over { distFt, mph } samples.
const { projectObservation } = require('./shapes');

const MS_TO_MPH = 2.2369362920544;

// Reject implausible reported speeds (GPS/feed glitches). MARTA buses top out
// well under 60 mph in service.
const MIN_MPH = 0;
const MAX_MPH = 60;

// 4-bucket bus scheme, matching the CTA thresholds (mph lower bounds).
const BUS_THRESHOLDS = { orange: 5, yellow: 10, green: 15 };

function colorForBusSpeed(mph) {
  if (mph == null) return '444'; // no data — dim gray
  if (mph < 5) return 'ff2a2a'; // red
  if (mph < 10) return 'ff8c1a'; // orange
  if (mph < 15) return 'ffd21a'; // yellow
  return '2ad17f'; // green
}

// Turn bus observations into per-shape speed samples. `observations` carry
// { tripId, lat, lon, speed }. Vehicles without a reported speed, off-route
// fixes, and implausible speeds are skipped. Returns
// Map<shapeId, { route, direction, samples: [{ distFt, mph }] }>.
function buildSpeedSamples(observations, { gtfs, shapes } = {}) {
  const byShape = new Map();
  for (const o of observations || []) {
    if (o.speed == null) continue;
    const mph = o.speed * MS_TO_MPH;
    if (mph < MIN_MPH || mph > MAX_MPH) continue;
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
    entry.samples.push({ distFt: proj.distFt, mph });
  }
  return byShape;
}

// Average mph per bin across `numBins` equal segments of a shape. Bins with no
// sample are null (rendered as "no data"). Midpoint bucketing — a sample lands
// in the bin its distFt falls in.
function binSamples(samples, lengthFt, numBins) {
  if (!(lengthFt > 0) || numBins < 1) return [];
  const segLen = lengthFt / numBins;
  const buckets = Array.from({ length: numBins }, () => []);
  for (const s of samples) {
    const idx = Math.min(numBins - 1, Math.max(0, Math.floor(s.distFt / segLen)));
    buckets[idx].push(s.mph);
  }
  return buckets.map((b) => (b.length === 0 ? null : b.reduce((a, v) => a + v, 0) / b.length));
}

// Roll a set of binned speeds into an average + per-bucket counts.
function summarize(bins, thresholds = BUS_THRESHOLDS) {
  const valid = bins.filter((s) => s != null);
  const base = {
    avg: null,
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    bins: bins.length,
    covered: valid.length,
  };
  if (valid.length === 0) return base;
  base.avg = valid.reduce((a, v) => a + v, 0) / valid.length;
  for (const s of valid) {
    if (s < thresholds.orange) base.red++;
    else if (s < thresholds.yellow) base.orange++;
    else if (s < thresholds.green) base.yellow++;
    else base.green++;
  }
  return base;
}

// End-to-end: observations → per-shape speedmap { route, direction, lengthFt,
// bins, summary, sampleCount }. `numBins` defaults to ~one bin per 1/40th of the
// route; callers can override.
function buildRouteSpeedmaps(observations, { gtfs, shapes, numBins = 40 } = {}) {
  const samplesByShape = buildSpeedSamples(observations, { gtfs, shapes });
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

module.exports = {
  MS_TO_MPH,
  BUS_THRESHOLDS,
  colorForBusSpeed,
  buildSpeedSamples,
  binSamples,
  summarize,
  buildRouteSpeedmaps,
};
