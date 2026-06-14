// Stop helpers for the bunching/gap posters. MARTA's GTFS-rt gives no stop
// context, so we derive it from static stops.txt: the nearest stop to a point
// (for the "near {stop}" post label) and the stops lying along a shape within a
// distance window (for the map's stop signs). Avoids loading stop_times.txt —
// proximity to the shape geometry is enough to place a sign.
const { haversineFt } = require('../../shared/geo');
const { projectToShape, MAX_OFFROUTE_FT } = require('./shapes');

function stopCoords(s) {
  const lat = Number(s.stop_lat);
  const lon = Number(s.stop_lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// Nearest stop (by straight-line distance) to a point. Returns
// { stopName, lat, lon, distFt } or null. Used to name a bunch's location.
function nearestStop(gtfs, lat, lon) {
  let best = null;
  for (const s of gtfs.stops) {
    const c = stopCoords(s);
    if (!c) continue;
    const d = haversineFt({ lat, lon }, c);
    if (!best || d < best.distFt) {
      best = { stopName: s.stop_name || s.stop_id, lat: c.lat, lon: c.lon, distFt: d };
    }
  }
  return best;
}

// Stops projecting onto `shape` within [loFt, hiFt] along-shape distance and
// close enough to the line to be on-route. Returns [{ stopName, distFt, lat,
// lon }] sorted by distFt. Pre-filters by the shape bbox so we don't project
// every stop in the system.
function stopsNearShape(gtfs, shape, loFt, hiFt, { maxOffrouteFt = MAX_OFFROUTE_FT } = {}) {
  if (!shape?.points?.length) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of shape.points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const margin = 0.005; // ~0.3 mi of latitude slack around the route bbox
  const out = [];
  for (const s of gtfs.stops) {
    const c = stopCoords(s);
    if (!c) continue;
    if (c.lat < minLat - margin || c.lat > maxLat + margin) continue;
    if (c.lon < minLon - margin || c.lon > maxLon + margin) continue;
    const proj = projectToShape(shape, c.lat, c.lon);
    if (!proj || proj.offsetFt > maxOffrouteFt) continue;
    if (proj.distFt < loFt || proj.distFt > hiFt) continue;
    out.push({ stopName: s.stop_name || s.stop_id, distFt: proj.distFt, lat: c.lat, lon: c.lon });
  }
  out.sort((a, b) => a.distFt - b.distFt);
  return out;
}

module.exports = { nearestStop, stopsNearShape };
