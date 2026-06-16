// Atlanta Streetcar speedmap — the streetcar is heavy rail's slow cousin, so it
// reuses the rail Path-A machinery (speed reconstructed from how far a car moved
// along the loop between snapshots) with two differences:
//
//   1. ONE representative geometry for the whole route, keyed by the streetcar's
//      feed line ("SC"), built from the longest GTFS shape on route 26982. The
//      loop is closed, so a car's distFt wraps from ~lengthFt back to ~0 once per
//      lap; that single bogus delta is rejected by the lower speed cap below.
//   2. Its own, much slower speed buckets — the streetcar runs in mixed downtown
//      traffic and averages a walking-ish pace by design, so the rail bands
//      (15/25/35/45) would paint the entire loop red.
const { buildLineSpeedmaps } = require('../rail/speedmap');
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

// One geometry keyed by the feed line ("SC"), so projectTrain(geom, obs) lines
// up with streetcar_observations rows (line === "SC"). Picks the longest shape
// among the streetcar route's trips, like the rail per-line geometry.
function buildStreetcarGeometry(gtfs, shapes) {
  const shapeIds = new Set();
  for (const t of gtfs.trips) {
    if (String(t.route_id) === STREETCAR_ROUTE_ID && t.shape_id) shapeIds.add(t.shape_id);
  }
  let best = null;
  for (const id of shapeIds) {
    const s = shapes.get(id);
    if (s && (!best || s.lengthFt > best.shape.lengthFt)) best = { shapeId: id, shape: s };
  }
  const byLine = new Map();
  if (best) {
    byLine.set(STREETCAR_LINE, {
      line: STREETCAR_LINE,
      shapeId: best.shapeId,
      points: best.shape.points,
      lengthFt: best.shape.lengthFt,
    });
  }
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
