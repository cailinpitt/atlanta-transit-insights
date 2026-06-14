// Rail line geometry — the MARTA rail analog of bus shapes.js (`pdist`).
//
// The rail feed gives a train's lat/lon but no trip_id, so we can't pick a
// per-trip shape the way bus does. Instead we build ONE representative geometry
// per line: the longest GTFS shape among that line's trips. Both directions run
// on ~the same track, so a single shape yields an along-line coordinate (distFt)
// for every train on the line; the feed's DIRECTION field carries which way the
// train is going. Validated against live positions: trains project with a median
// offset of ~17 ft (max ~150 ft) onto their line's longest shape.
const { projectToShape } = require('../bus/shapes');

const RAIL_ROUTE_TYPE = '1';
// Rail can bow away from the canonical shape at Five Points (where all lines
// converge) and on tight curves, so allow more slack than bus's 600 ft.
const MAX_OFFROUTE_FT = 1000;

// Build Map<line, { line, shapeId, points, lengthFt }> keyed by route_short_name
// (RED/GOLD/BLUE/GREEN — the same values the rail feed's LINE field uses).
function buildLineGeometry(gtfs, shapes) {
  const shapeIdsByRoute = new Map();
  for (const t of gtfs.trips) {
    if (!t.shape_id) continue;
    if (!shapeIdsByRoute.has(t.route_id)) shapeIdsByRoute.set(t.route_id, new Set());
    shapeIdsByRoute.get(t.route_id).add(t.shape_id);
  }
  const byLine = new Map();
  for (const r of gtfs.routes) {
    if (String(r.route_type) !== RAIL_ROUTE_TYPE) continue;
    let best = null;
    for (const id of shapeIdsByRoute.get(r.route_id) || []) {
      const s = shapes.get(id);
      if (s && (!best || s.lengthFt > best.shape.lengthFt)) best = { shapeId: id, shape: s };
    }
    if (best) {
      byLine.set(r.route_short_name, {
        line: r.route_short_name,
        shapeId: best.shapeId,
        points: best.shape.points,
        lengthFt: best.shape.lengthFt,
      });
    }
  }
  return byLine;
}

// Project a train observation { line, lat, lon } onto its line geometry. Returns
// { line, distFt, offsetFt, lengthFt } or null (unknown line, no position, or
// too far off-route).
function projectTrain(lineGeom, obs, { maxOffrouteFt = MAX_OFFROUTE_FT } = {}) {
  if (obs == null || !Number.isFinite(obs.lat) || !Number.isFinite(obs.lon)) return null;
  const geom = lineGeom.get(obs.line);
  if (!geom) return null;
  const p = projectToShape(geom, obs.lat, obs.lon);
  if (!p || p.offsetFt > maxOffrouteFt) return null;
  return { line: obs.line, distFt: p.distFt, offsetFt: p.offsetFt, lengthFt: geom.lengthFt };
}

module.exports = { buildLineGeometry, projectTrain, MAX_OFFROUTE_FT, RAIL_ROUTE_TYPE };
