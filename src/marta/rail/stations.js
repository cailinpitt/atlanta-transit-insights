// Rail stations along a line — the rail analog of src/marta/bus/stops.js. The
// rail feed gives no station context, so we project the static rail-stations.json
// roster onto a line's representative geometry to get an along-line distance for
// each station. Used to name a gap's flanking stations ("between X and Y") and
// the midpoint station the timelapse frames the next train closing on, matching
// the bus gap posts and cta-insights src/train.
const { projectToShape } = require('../bus/shapes');
const { MAX_OFFROUTE_FT } = require('./lines');
const RAIL_STATIONS = require('../rail-stations.json');

// rail-stations.json names are SCREAMING with a " Station" suffix ("LENOX
// Station"); present them rider-facing in post text and map labels ("Lenox").
// Consolidated here so the gap, disruption, and map renderers share one copy.
function displayStationName(name) {
  return String(name || '')
    .replace(/\s+station\s*$/i, '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

// Stations on `lineKey` projected onto its line geometry, sorted by distFt.
// Returns [{ name, lat, lon, distFt }]. `lineGeom` is a buildLineGeometry entry
// ({ points, lengthFt }); `lineKey` is the SCREAMING line name (RED/GOLD/...),
// matched case-insensitively against each station's lowercase `lines`.
function stationsOnLine(lineGeom, lineKey, { maxOffrouteFt = MAX_OFFROUTE_FT } = {}) {
  if (!lineGeom?.points?.length) return [];
  const wanted = String(lineKey).toLowerCase();
  const out = [];
  for (const s of RAIL_STATIONS) {
    if (!(s.lines || []).some((l) => String(l).toLowerCase() === wanted)) continue;
    const proj = projectToShape(lineGeom, s.lat, s.lon);
    if (!proj || proj.offsetFt > maxOffrouteFt) continue;
    out.push({ name: s.name, lat: s.lat, lon: s.lon, distFt: proj.distFt });
  }
  out.sort((a, b) => a.distFt - b.distFt);
  return out;
}

// Flank + midpoint stations for a gap, given stations sorted by distFt.
//   flankBefore: nearest station behind the trailing train (lower distFt)
//   flankAfter:  nearest station ahead of the leading train (higher distFt)
//   midStation:  station nearest the gap center — the back half the next train
//                must still cross, which the timelapse frames it closing on
// Each is { name, lat, lon, distFt } or null. The midpoint falls back to the
// nearest station overall when none sits strictly inside a short gap.
function gapStationContext(stations, gap) {
  const lo = Math.min(gap.trailing.distFt, gap.leading.distFt);
  const hi = Math.max(gap.trailing.distFt, gap.leading.distFt);
  let flankBefore = null;
  let flankAfter = null;
  for (const s of stations) {
    if (s.distFt < lo) {
      if (!flankBefore || s.distFt > flankBefore.distFt) flankBefore = s;
    } else if (s.distFt > hi) {
      if (!flankAfter || s.distFt < flankAfter.distFt) flankAfter = s;
    }
  }
  const mid = (lo + hi) / 2;
  const closestTo = (pool) =>
    pool.length === 0
      ? null
      : pool.reduce((best, s) =>
          Math.abs(s.distFt - mid) < Math.abs(best.distFt - mid) ? s : best,
        );
  const inside = stations.filter((s) => s.distFt >= lo && s.distFt <= hi);
  const midStation = closestTo(inside) || closestTo(stations);
  return { flankBefore, flankAfter, midStation };
}

module.exports = { displayStationName, stationsOnLine, gapStationContext };
