// Shape-progress primitive — the MARTA replacement for CTA's `pdist`.
//
// CTA Bus Tracker hands you `pdist` (feet travelled along a pattern) and `pid`
// (pattern id) directly. MARTA's GTFS-rt gives only lat/lon + trip_id, so we
// reconstruct the along-route coordinate ourselves: join trip_id → trips.txt →
// shape_id, then project the vehicle's position onto that shape's polyline. The
// mapping the detectors care about is:
//
//   CTA pid   ↔ MARTA shape_id
//   CTA pdist ↔ distance along the shape, in feet
//
// MARTA's shapes.txt populates `shape_dist_traveled` (kilometres), so the
// along-shape coordinate is exact at each vertex; we interpolate between
// vertices and convert to feet to match the CTA detectors' units.
const Fs = require('node:fs');
const Path = require('node:path');
const { parseCsv } = require('../gtfs');

const KM_TO_FT = 3280.839895;
// Equirectangular ft-per-degree (matches src/shared/geo.js EARTH_RADIUS_FT).
const R_FT = 20902231;
const FT_PER_DEG = (Math.PI / 180) * R_FT;

// Beyond this perpendicular distance from its shape, a position isn't credibly
// on the route (GPS junk, wrong-shape join, off-route deadhead) — callers omit
// it rather than place it at a bogus pdist. Matches the CTA off-route gate.
const MAX_OFFROUTE_FT = 600;

// Load shapes.txt → Map<shape_id, { points: [{lat, lon, distFt}], lengthFt }>.
// Points are ordered by shape_pt_sequence and carry cumulative feet from the
// GTFS shape_dist_traveled column.
function loadShapes(dir) {
  const rows = parseCsv(Fs.readFileSync(Path.join(dir, 'shapes.txt'), 'utf8'));
  const byShape = new Map();
  for (const r of rows) {
    const id = r.shape_id;
    if (!byShape.has(id)) byShape.set(id, []);
    byShape.get(id).push({
      lat: Number(r.shape_pt_lat),
      lon: Number(r.shape_pt_lon),
      seq: Number(r.shape_pt_sequence),
      distFt: Number(r.shape_dist_traveled) * KM_TO_FT,
    });
  }
  const out = new Map();
  for (const [id, pts] of byShape) {
    pts.sort((a, b) => a.seq - b.seq);
    out.set(id, {
      points: pts.map((p) => ({ lat: p.lat, lon: p.lon, distFt: p.distFt })),
      lengthFt: pts.length ? pts[pts.length - 1].distFt : 0,
    });
  }
  return out;
}

// Project (lat, lon) onto a shape polyline. Returns { distFt, offsetFt } for the
// closest segment — distFt is the interpolated along-shape coordinate, offsetFt
// the perpendicular distance (the confidence gate). Null if the shape is
// degenerate. Pure; equirectangular projection (good to a few hundred feet).
function projectToShape(shape, lat, lon) {
  const pts = shape?.points;
  if (!pts || pts.length < 2) return null;
  const ftPerDegLon = FT_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const px = lon * ftPerDegLon;
  const py = lat * FT_PER_DEG;
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].lon * ftPerDegLon;
    const ay = pts[i].lat * FT_PER_DEG;
    const bx = pts[i + 1].lon * ftPerDegLon;
    const by = pts[i + 1].lat * FT_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const offsetFt = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || offsetFt < best.offsetFt) {
      const distFt = pts[i].distFt + t * (pts[i + 1].distFt - pts[i].distFt);
      best = { distFt, offsetFt };
    }
  }
  return best;
}

// Resolve the GTFS shape a trip runs, via trips.txt. Returns the shape record or
// null (trip missing, or its shape absent from shapes.txt).
function shapeForTrip(gtfs, shapes, tripId) {
  const trip = gtfs.tripsById.get(tripId);
  if (!trip?.shape_id) return null;
  return shapes.get(trip.shape_id) || null;
}

// Project one bus observation onto its trip's shape. Returns
// { shapeId, distFt, offsetFt } or null when the trip/shape can't be resolved,
// the position is missing, or the fix is too far off-route.
function projectObservation(obs, { gtfs, shapes, maxOffrouteFt = MAX_OFFROUTE_FT } = {}) {
  if (obs == null || !Number.isFinite(obs.lat) || !Number.isFinite(obs.lon)) return null;
  const trip = gtfs.tripsById.get(obs.tripId);
  if (!trip?.shape_id) return null;
  const shape = shapes.get(trip.shape_id);
  if (!shape) return null;
  const proj = projectToShape(shape, obs.lat, obs.lon);
  if (!proj || proj.offsetFt > maxOffrouteFt) return null;
  return { shapeId: trip.shape_id, distFt: proj.distFt, offsetFt: proj.offsetFt };
}

module.exports = {
  loadShapes,
  projectToShape,
  shapeForTrip,
  projectObservation,
  MAX_OFFROUTE_FT,
  KM_TO_FT,
};
