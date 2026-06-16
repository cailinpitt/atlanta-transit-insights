// Atlanta Streetcar speedmap — the streetcar is heavy rail's slow cousin, so it
// reuses the rail Path-A machinery (speed reconstructed from how far a car moved
// along the loop between snapshots) with two differences:
//
//   1. ONE representative geometry for the whole route, keyed by the streetcar's
//      feed line ("SC"). Unlike a heavy-rail line, NO single GTFS shape traces
//      the whole loop — MARTA models each direction as a separate ~half-loop
//      (Edgewood EB vs Auburn WB), so the longest single shape is only ~1.6 of
//      the ~2.7 mi loop and the return leg never gets drawn. We stitch the two
//      longest (one per direction) into one closed loop. The loop wraps, so a
//      car's distFt jumps from ~lengthFt back to ~0 once per lap; that single
//      bogus delta is rejected by the lower speed cap below.
//   2. Its own, much slower speed buckets — the streetcar runs in mixed downtown
//      traffic and averages a walking-ish pace by design, so the rail bands
//      (15/25/35/45) would paint the entire loop red.
const { buildLineSpeedmaps } = require('../rail/speedmap');
const { haversineFt } = require('../../shared/geo');
const { STREETCAR_LINE } = require('./api');

// GTFS route_id for the Atlanta Streetcar (route_short_name ATLSC, route_type 0).
const STREETCAR_ROUTE_ID = '26982';

// Tighter than rail's 75: the streetcar tops out far lower, and this is what
// rejects the once-per-lap loop wraparound jump.
const STREETCAR_MAX_MPH = 40;

// Slow-mode bands (mph). Starting point — revisit once a few hours of real loop
// speeds are in, since the streetcar's true distribution is narrow and low.
const STREETCAR_THRESHOLDS = { orange: 4, yellow: 8, purple: 12, green: 16 };

function colorForStreetcarSpeed(mph) {
  if (mph == null) return '444';
  if (mph < STREETCAR_THRESHOLDS.orange) return 'ff2a2a'; // red
  if (mph < STREETCAR_THRESHOLDS.yellow) return 'ff8c1a'; // orange
  if (mph < STREETCAR_THRESHOLDS.purple) return 'ffd21a'; // yellow
  if (mph < STREETCAR_THRESHOLDS.green) return 'a855f7'; // purple
  return '2ad17f'; // green
}

// Stitch ordered shapes (longest-first) head-to-tail into one polyline, flipping
// each next shape so its nearer end joins the running tail, then recompute
// cumulative distFt across the seams (the GTFS per-shape shape_dist_traveled
// resets to 0 on each shape, so it can't be reused once stitched).
function stitchShapes(shapeRecords) {
  let chain = shapeRecords[0].points.slice();
  for (let k = 1; k < shapeRecords.length; k++) {
    const next = shapeRecords[k].points.slice();
    const tail = chain[chain.length - 1];
    if (haversineFt(tail, next[next.length - 1]) < haversineFt(tail, next[0])) next.reverse();
    chain = chain.concat(next);
  }
  let cum = 0;
  const points = [{ lat: chain[0].lat, lon: chain[0].lon, distFt: 0 }];
  for (let i = 1; i < chain.length; i++) {
    cum += haversineFt(chain[i - 1], chain[i]);
    points.push({ lat: chain[i].lat, lon: chain[i].lon, distFt: cum });
  }
  return { points, lengthFt: cum };
}

// One geometry keyed by the feed line ("SC"), so projectTrain(geom, obs) lines
// up with streetcar_observations rows (line === "SC"). Stitches the longest
// shape from each direction into the full loop (see header); falls back to a
// single shape if the route only has one direction.
function buildStreetcarGeometry(gtfs, shapes) {
  const idsByDir = new Map();
  for (const t of gtfs.trips) {
    if (String(t.route_id) !== STREETCAR_ROUTE_ID || !t.shape_id) continue;
    const dir = String(t.direction_id ?? '');
    if (!idsByDir.has(dir)) idsByDir.set(dir, new Set());
    idsByDir.get(dir).add(t.shape_id);
  }
  // Longest shape per direction, then take the two longest of those — one per
  // direction — as the two halves of the loop.
  const perDir = [];
  for (const ids of idsByDir.values()) {
    let best = null;
    for (const id of ids) {
      const s = shapes.get(id);
      if (s && (!best || s.lengthFt > best.shape.lengthFt)) best = { shapeId: id, shape: s };
    }
    if (best) perDir.push(best);
  }
  perDir.sort((a, b) => b.shape.lengthFt - a.shape.lengthFt);

  const byLine = new Map();
  if (perDir.length === 0) return byLine;
  const halves = perDir.slice(0, 2);
  const geom =
    halves.length === 1
      ? { points: halves[0].shape.points, lengthFt: halves[0].shape.lengthFt }
      : stitchShapes(halves.map((h) => h.shape));
  byLine.set(STREETCAR_LINE, {
    line: STREETCAR_LINE,
    shapeId: halves.map((h) => h.shapeId).join('+'),
    points: geom.points,
    lengthFt: geom.lengthFt,
  });
  return byLine;
}

// streetcar_observations rows → a single SC loop speedmap, with the streetcar's
// slower cap + buckets. Directions are merged (`mergeDirections`): the streetcar
// is one closed loop on one geometry, so the feed's two directionIds would each
// fill only the arc their vehicles rode, leaving half the loop grey — the union
// covers the whole loop. Result keys "SC/" (no direction).
function buildStreetcarSpeedmaps(observations, { geom, numBins = 30 } = {}) {
  return buildLineSpeedmaps(observations, {
    lineGeom: geom,
    numBins,
    maxMph: STREETCAR_MAX_MPH,
    thresholds: STREETCAR_THRESHOLDS,
    mergeDirections: true,
  });
}

module.exports = {
  STREETCAR_ROUTE_ID,
  STREETCAR_MAX_MPH,
  STREETCAR_THRESHOLDS,
  colorForStreetcarSpeed,
  buildStreetcarGeometry,
  buildStreetcarSpeedmaps,
};
