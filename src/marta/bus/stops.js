// Stop helpers for the bunching/gap posters. MARTA's GTFS-rt gives no stop
// context, so we derive it from static stops.txt: the nearest stop to a point
// (for the "near {stop}" post label) and the stops lying along a shape within a
// distance window (for the map's stop signs). Avoids loading stop_times.txt —
// proximity to the shape geometry is enough to place a sign.
const { haversineFt, bearing } = require('../../shared/geo');
const { projectToShape, MAX_OFFROUTE_FT } = require('./shapes');
const { tripStops } = require('./adherence');

// Local heading of the shape at segment `segIndex`, sampled over a short window
// of surrounding points so the renderer can offset a stop perpendicular to its
// own stretch of route. A single global bearing skews stops on curves to the
// wrong side of (or onto) the line — the cause of stops rendering unevenly.
const BEARING_WINDOW = 2;
function localBearing(points, segIndex) {
  if (!Array.isArray(points) || points.length < 2 || segIndex == null) return null;
  const before = points[Math.max(0, segIndex - BEARING_WINDOW)];
  const after = points[Math.min(points.length - 1, segIndex + 1 + BEARING_WINDOW)];
  return before === after ? null : bearing(before, after);
}

const SMALL_WORDS = new Set(['at', 'and', 'of', 'the']);

function titleCaseStopName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (_m, ch, offset, s) => {
      const word = s.slice(offset).match(/^[a-z]+/)?.[0] || '';
      if (offset > 0 && SMALL_WORDS.has(word)) return ch;
      return ch.toUpperCase();
    })
    .replace(/\bNe\b/g, 'NE')
    .replace(/\bNw\b/g, 'NW')
    .replace(/\bSe\b/g, 'SE')
    .replace(/\bSw\b/g, 'SW')
    .replace(/\bMarta\b/g, 'MARTA')
    .replace(/\bGsu\b/g, 'GSU')
    .replace(/\bGa\b/g, 'GA')
    .replace(/\s+@\s+/g, ' @ ');
}

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
      best = {
        stopName: titleCaseStopName(s.stop_name || s.stop_id),
        lat: c.lat,
        lon: c.lon,
        distFt: d,
      };
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
    out.push({
      stopName: titleCaseStopName(s.stop_name || s.stop_id),
      distFt: proj.distFt,
      lat: c.lat,
      lon: c.lon,
      bearing: localBearing(shape.points, proj.segIndex),
    });
  }
  out.sort((a, b) => a.distFt - b.distFt);
  return out;
}

// A representative bus trip serving `shapeId`, for pulling its scheduled stop
// list. Any trip on the shape has the same stop pattern, so the first match wins.
function tripIdForShape(gtfs, shapeId) {
  if (shapeId == null) return null;
  for (const t of gtfs.tripsById.values()) {
    if (String(t.shape_id) === String(shapeId)) return t.trip_id;
  }
  return null;
}

// The REAL stops for the route running `shapeId`, from that route's scheduled
// stop_times (schedule.sqlite) — not geometric proximity, which sweeps in stops
// from every other route that happens to pass within MAX_OFFROUTE_FT of the line.
// Each scheduled stop is projected onto the shape for its along-route distance +
// local bearing (so the renderer can offset it perpendicular to the line, matching
// stopsNearShape's shape). Returns [{ stopName: null, distFt, lat, lon, bearing }]
// sorted by distFt, or [] when the schedule DB is unavailable (caller falls back).
// Names aren't kept — the map draws stop-sign glyphs, not labels. The CTA
// getPatternStops analog.
function stopsForShape(gtfs, shape, shapeId) {
  if (!shape?.points?.length) return [];
  const tripId = tripIdForShape(gtfs, shapeId);
  if (tripId == null) return [];
  const out = [];
  for (const s of tripStops(tripId)) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const proj = projectToShape(shape, lat, lon);
    if (!proj) continue;
    out.push({
      stopName: null,
      distFt: proj.distFt,
      lat,
      lon,
      bearing: localBearing(shape.points, proj.segIndex),
    });
  }
  out.sort((a, b) => a.distFt - b.distFt);
  return out;
}

module.exports = { nearestStop, stopsNearShape, stopsForShape, titleCaseStopName };
